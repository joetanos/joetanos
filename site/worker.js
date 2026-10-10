/* Share links: /p/<slug>
   Link previews (WhatsApp, Instagram, iMessage…) never see the part of a URL
   after "#", so they always showed the home page. For /p/<slug> this worker
   serves index.html with that print's title, description and photo in the
   preview tags; the page then switches itself to #/print/<slug> as usual.
   /img?u=<photo link>&w=<width> serves a smaller, cached copy of a photo (see sized() in index.html).
   /t saves visit statistics sent by the page to the D1 database (see analytics/);
   a summary of them is emailed every evening (dailyReport).
   /subscribe signs a visitor up to the newsletter and gives them a promo code; /promo checks a code.
   Every other request is served from the static files untouched. */

import { EmailMessage } from "cloudflare:email";
import { xlsx } from "./xlsx.js";

// Keep in sync with CATALOG_URL in index.html
const CATALOG_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSqN9mnutNqWcd_N8J0_7H0kcn_sGsiIbF-ZNJnkYYgNFAPoR1wfc968rXAjQIBnmo4NiD3XAN7WZsh/pub?output=csv";

export default {
  // Daily visit report by email at 22:00 Beirut time. The crons (wrangler.jsonc) run at 19:00 and
  // 20:00 UTC; only the one that is 22:00 in Beirut sends, so it follows summer and winter time.
  async scheduled(event, env, ctx) {
    if (beirutHour(event.scheduledTime) !== REPORT_HOUR) return;
    ctx.waitUntil(dailyReport(env, event.scheduledTime));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/img") return resized(request, url, env, ctx);
    if (url.pathname === "/t") return track(request, url, env, ctx);
    if (url.pathname === "/report-now") return reportNow(request, env);
    if (url.pathname === "/subscribe") return subscribe(request, url, env, ctx);
    if (url.pathname === "/promo") return promo(url, env);
    const m = url.pathname.match(/^\/p\/([^/]+)\/?$/);
    if (!m) return env.ASSETS.fetch(request);

    const slug = decodeURIComponent(m[1]);
    const print = await findPrint(slug, url, env);
    const page = await env.ASSETS.fetch(new Request(new URL("/", url), request));
    if (!print) return Response.redirect(new URL("/#/shop", url), 302);

    const title = print.title + " – Just Framed";
    const desc = print.description || [print.place, print.year].filter(Boolean).join(", ");
    const image = print.image ? new URL(print.image, url).href : "";
    const set = content => ({ element(el) { el.setAttribute("content", content) } });

    const res = new HTMLRewriter()
      .on("head", { element(el) {
        // Run before anything else loads: relative links resolve from the site root,
        // and the address bar shows the normal print page.
        // jfShared tells the visit statistics that this visit came from a shared link.
        el.prepend(`<base href="/"><script>history.replaceState(null,"","/#/print/${encodeURIComponent(slug)}");window.jfShared=1</script>`, { html: true });
      }})
      .on("title", { element(el) { el.setInnerContent(title) } })
      .on('meta[property="og:url"]', set(url.href))
      .on('meta[property="og:type"]', set("product"))
      .on('meta[property="og:title"]', set(title))
      .on('meta[property="og:description"]', set(desc))
      .on('meta[name="description"]', set(desc))
      .on('meta[property="og:image"]', set(image))
      .on('meta[property="og:image:alt"]', set(print.title))
      // The brand card's size doesn't apply to the print's photo
      .on('meta[property="og:image:width"], meta[property="og:image:height"]', { element(el) { el.remove() } })
      .transform(page);
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "public, max-age=300");
    return out;
  }
};

// Hosts /img may resize photos from (besides this site). Keep in sync with IMG_HOSTS in index.html
const IMG_HOSTS = ["photos.justframed-lb.com", "pub-072a6b055ac5436297717deddd7c9512.r2.dev"];
const IMG_WIDTHS = [200, 400, 800, 1200, 1600, 2000];

async function resized(request, url, env, ctx) {
  let src;
  try { src = new URL(url.searchParams.get("u") || "", url) } catch (e) { return new Response("Bad image link", { status: 400 }) }
  const local = src.origin === url.origin;
  if (!local && !IMG_HOSTS.includes(src.hostname)) return new Response("Image host not allowed", { status: 403 });
  // Round up to a fixed width so each photo only ever has a few cached sizes
  const asked = parseInt(url.searchParams.get("w")) || 800;
  const width = IMG_WIDTHS.find(w => w >= asked) || IMG_WIDTHS[IMG_WIDTHS.length - 1];
  const accept = request.headers.get("Accept") || "";
  const format = accept.includes("image/avif") ? "image/avif" : accept.includes("image/webp") ? "image/webp" : "image/jpeg";

  const cache = caches.default;
  const key = new Request(`${url.origin}/img?u=${encodeURIComponent(src.href)}&w=${width}&f=${format}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const original = local ? await env.ASSETS.fetch(new Request(src, request)) : await fetch(src, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!original.ok) return new Response("Image not found", { status: original.status });
  const type = original.headers.get("Content-Type") || "image/jpeg";
  let out;
  try {
    const img = await env.IMAGES.input(original.clone().body).transform({ width, fit: "scale-down" }).output({ format, quality: 82 });
    out = new Response(img.response().body, { headers: { "Content-Type": format } });
  } catch (e) {
    // Resizing unavailable: send the photo as it is, so the page still works
    return new Response(original.body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600" } });
  }
  // A day, so a photo replaced under the same file name shows up by the next day
  out.headers.set("Cache-Control", "public, max-age=86400");
  out.headers.set("Vary", "Accept");
  ctx.waitUntil(cache.put(key, out.clone()));
  return out;
}

/* Visit statistics: the page sends {v: visitor id, s: visit id, r: referrer, e: [events]}
   (see "Visit statistics" in index.html). Country, city, device and browser are added here;
   the IP address is not stored. */
const EVENT_TYPES = ["view", "leave", "click", "choose"];
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pingdom/i;

async function track(request, url, env, ctx) {
  const done = new Response(null, { status: 204 });
  if (request.method !== "POST" || !env.DB) return done;
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response(null, { status: 403 });
  const ua = request.headers.get("User-Agent") || "";
  if (BOTS.test(ua)) return done;
  let body;
  try { body = JSON.parse((await request.text()).slice(0, 20000)) } catch (e) { return new Response(null, { status: 400 }) }
  const events = (Array.isArray(body.e) ? body.e : []).filter(e => e && EVENT_TYPES.includes(e.t)).slice(0, 40);
  if (!events.length) return done;

  const s = (v, n = 200) => v == null || v === "" ? null : String(v).slice(0, n);
  const cf = request.cf || {};
  const who = [s(body.r), s(cf.country, 8), s(cf.city, 80), ...uaInfo(ua), s(request.headers.get("Accept-Language")?.split(/[,;]/)[0], 20)];
  const now = Date.now();
  const insert = env.DB.prepare(`INSERT INTO events (ts, vid, sid, type, path, page, item, target, detail, dur, ref, country, city, device, browser, os, lang)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = events.map(e => insert.bind(
    Math.min(now, Math.max(now - 86400000, Number(e.ts) || now)), s(body.v, 40), s(body.s, 40), e.t,
    s(e.p), s(e.pg, 40), s(e.i, 100), s(e.x, 100), s(e.d, 300),
    Number.isFinite(Number(e.dur)) && e.dur != null ? Math.min(Math.max(0, Math.round(e.dur)), 3600000) : null,
    ...who));
  ctx.waitUntil(env.DB.batch(rows).catch(err => console.error("Visit statistics not saved", err)));
  return done;
}

function uaInfo(ua) {
  const device = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|Android|iPhone/i.test(ua) ? "Mobile" : "Desktop";
  const browser = /Instagram/.test(ua) ? "Instagram app" : /FBAN|FBAV/.test(ua) ? "Facebook app" : /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox|FxiOS/.test(ua) ? "Firefox"
    : /Chrome|CriOS/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Other";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Other";
  return [device, browser, os];
}

/* ---------- Newsletter ----------
   The pop-up in index.html sends {c: email or phone number, hp: hidden field bots fill in}.
   Each subscriber gets a personal code for PROMO.percent off a first order from $PROMO.min,
   kept in the subscribers table (analytics/schema.sql). The code is emailed to email sign-ups
   when Cloudflare Email Sending is on for the domain (binding EMAIL); otherwise, and for phone
   numbers, the page shows it. The studio gets an email for every sign-up, with a WhatsApp link
   that sends the code to phone sign-ups in one tap. */
const PROMO = { percent: 10, min: 50, prefix: "JF10-" }; // keep percent and min in sync with PROMO in index.html
const NEWS_FROM = "newsletter@justframed-lb.com";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function subscribe(request, url, env, ctx) {
  if (request.method !== "POST" || !env.DB) return json({ error: "Sign-up isn't available right now." }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Not allowed" }, 403);
  let body;
  try { body = JSON.parse((await request.text()).slice(0, 2000)) } catch (e) { return json({ error: "Bad request" }, 400) }
  if (body.hp) return json({ ok: true });
  const contact = cleanContact(body.c);
  if (!contact) return json({ error: "Please enter a valid email address or phone number." }, 400);

  let sub = await env.DB.prepare("SELECT * FROM subscribers WHERE contact = ?").bind(contact.value).first();
  const again = !!sub;
  if (!sub) {
    // A guard against a script signing up thousands of addresses
    const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE ts > ?").bind(Date.now() - DAY).first();
    if (n >= 500) return json({ error: "Too many sign-ups today. Please try again tomorrow." }, 429);
    const cf = request.cf || {};
    for (let i = 0; i < 3 && !sub; i++) {
      sub = { ts: Date.now(), contact: contact.value, kind: contact.kind, code: newCode(), emailed: 0,
        country: cf.country || null, city: cf.city || null, lang: request.headers.get("Accept-Language")?.split(/[,;]/)[0].slice(0, 20) || null };
      try {
        await env.DB.prepare("INSERT INTO subscribers (ts, contact, kind, code, emailed, country, city, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(sub.ts, sub.contact, sub.kind, sub.code, 0, sub.country, sub.city, sub.lang).run();
      } catch (e) {
        // Same code drawn twice (retry), or the same person signing up twice at once
        sub = await env.DB.prepare("SELECT * FROM subscribers WHERE contact = ?").bind(contact.value).first();
      }
    }
    if (!sub) return json({ error: "Sign-up didn't go through. Please try again." }, 500);
  }
  const emailed = sub.kind === "email" && await sendCode(env, sub.contact, sub.code);
  if (emailed) ctx.waitUntil(env.DB.prepare("UPDATE subscribers SET emailed = 1 WHERE contact = ?").bind(sub.contact).run());
  if (!again) ctx.waitUntil(notifyStudio(env, sub, emailed).catch(e => console.error("Sign-up email to the studio not sent", e)));
  // When the code went by email it isn't shown, so only the owner of the address gets it
  return json({ ok: true, kind: sub.kind, again, emailed, code: emailed ? null : sub.code, ...PROMO });
}

async function promo(url, env) {
  const code = (url.searchParams.get("code") || "").trim().toUpperCase().slice(0, 20);
  const row = code && env.DB ? await env.DB.prepare("SELECT code FROM subscribers WHERE code = ?").bind(code).first() : null;
  return json(row ? { ok: true, code: row.code, percent: PROMO.percent, min: PROMO.min } : { ok: false });
}

// An email address (lowercased) or a phone number as +<country><number>; numbers without a
// country code are taken as Lebanese (03 123 456, 71 123 456)
function cleanContact(v) {
  const s = String(v || "").trim().slice(0, 120);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return { kind: "email", value: s.toLowerCase() };
  let d = s.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(d)) return null;
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (!d.startsWith("+")) { d = d.replace(/^0/, ""); d = d.length <= 8 ? "+961" + d : "+" + d }
  return d.length >= 9 && d.length <= 16 ? { kind: "phone", value: d } : null;
}

function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
  return PROMO.prefix + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => abc[b % abc.length]).join("");
}

const promoText = code => `Your code ${code} takes ${PROMO.percent}% off your first order of $${PROMO.min} or more. Enter it on any print page, or mention it when you order on WhatsApp.`;

async function sendCode(env, to, code) {
  if (!env.EMAIL) return false;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f2ed;font-family:Georgia,'Times New Roman',serif;color:#1c1b18">
<div style="max-width:520px;margin:0 auto;padding:36px 24px;background:#fff">
<p style="font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#807a70;margin:0 0 12px">Just Framed newsletter</p>
<h1 style="font-size:28px;font-weight:normal;margin:0 0 14px">Thank you for subscribing</h1>
<p style="font-size:16px;line-height:1.6;color:#57534b;margin:0 0 22px">Here is your code for ${PROMO.percent}% off your first order of $${PROMO.min} or more:</p>
<p style="font-family:Helvetica,Arial,sans-serif;font-size:24px;letter-spacing:4px;text-align:center;border:1px dashed #ddd7cd;padding:16px;margin:0 0 22px">${code}</p>
<p style="font-size:16px;line-height:1.6;color:#57534b;margin:0 0 26px">Enter it on any print page, or mention it when you order on WhatsApp. You'll also hear from us first about new prints, discounts and packages.</p>
<a href="${SITE}/#/shop" style="display:inline-block;background:#1c1b18;color:#f5f2ed;font-family:Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;padding:13px 20px;text-decoration:none">Browse the prints</a>
<p style="font-size:13px;color:#807a70;margin:30px 0 0">To unsubscribe, just reply to this email.</p>
</div></body></html>`;
  try {
    await env.EMAIL.send({ to, from: { email: NEWS_FROM, name: "Just Framed" }, replyTo: REPORT_TO,
      subject: `Your ${PROMO.percent}% off code: ${code}`, html, text: `Thank you for subscribing to the Just Framed newsletter.\n\n${promoText(code)}\n\n${SITE}/#/shop\n\nTo unsubscribe, just reply to this email.` });
    return true;
  } catch (e) {
    console.error("Promo code email not sent", e.code || "", e.message);
    return false;
  }
}

async function notifyStudio(env, sub, emailed) {
  const where = [sub.city, sub.country].filter(Boolean).join(", ");
  const msg = `Hello from Just Framed! Thank you for subscribing to our newsletter. ${promoText(sub.code)}`;
  const link = sub.kind === "phone" ? `https://wa.me/${sub.contact.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}` : "";
  const how = sub.kind === "phone" ? "The code was shown on the website. Send it on WhatsApp too:" : emailed ? "The code was emailed to them." : "The code was shown on the website (Email Sending isn't on, so it wasn't emailed).";
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1c1b18">
<h2 style="font-size:18px;margin:0 0 12px">New newsletter subscriber</h2>
<p style="margin:0 0 6px"><b>${esc(sub.contact)}</b>${where ? ` · ${esc(where)}` : ""}</p>
<p style="margin:0 0 16px">Promo code: <b>${sub.code}</b> (${PROMO.percent}% off a first order from $${PROMO.min})</p>
<p style="margin:0 0 10px">${how}</p>
${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#1f9d55;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Send the code on WhatsApp</a></p>` : ""}
</body></html>`;
  const text = `New newsletter subscriber: ${sub.contact}${where ? ` (${where})` : ""}\nPromo code: ${sub.code}\n${how}${link ? "\n" + link : ""}`;
  const raw = mime({ from: `Just Framed website <${REPORT_FROM}>`, to: REPORT_TO, subject: `New subscriber: ${sub.contact}`, text, html });
  await env.MAILER.send(new EmailMessage(REPORT_FROM, REPORT_TO, raw));
}

/* ---------- Daily report email ----------
   Covers the 24 hours up to 22:00, compared with the average of the 7 days before. The address
   must be verified in Cloudflare Email Routing; it's set in wrangler.jsonc (send_email). */
const TZ = "Asia/Beirut", REPORT_HOUR = 22;
const REPORT_TO = "justframed-lb@outlook.com", REPORT_FROM = "report@justframed-lb.com";
const SITE = "https://justframed-lb.com";
const DAY = 86400000;

function beirutHour(ts) {
  return Number(new Date(ts).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }));
}

// Sends the daily report right away, for testing. Works only while the REPORT_KEY secret is set
// (npx wrangler secret put REPORT_KEY) and the request carries it as "Authorization: Bearer <key>".
// ?days=7 covers the last 7 days instead of 24 hours.
async function reportNow(request, env) {
  if (!env.REPORT_KEY || request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${env.REPORT_KEY}`)
    return new Response("Not found", { status: 404 });
  const days = Math.min(30, Math.max(1, parseInt(new URL(request.url).searchParams.get("days")) || 1));
  try { await dailyReport(env, Date.now(), true, days) } catch (e) { return new Response("Not sent: " + e.message + "\n", { status: 500 }) }
  return new Response("Report sent\n");
}

async function dailyReport(env, now, test, days = 1) {
  const end = test ? now : now - (now % 3600000), start = end - days * DAY;
  const { results: ev } = await env.DB.prepare("SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts").bind(start - 7 * days * DAY, end).all();
  // Visitors of the period who had come before it (at any time)
  const { results: back } = await env.DB.prepare("SELECT DISTINCT vid FROM events WHERE ts < ? AND vid IN (SELECT vid FROM events WHERE ts >= ? AND ts < ?)")
    .bind(start, start, end).all();
  let shop = [];
  try { shop = await catalog(env, SITE) } catch (e) {}
  const titles = {};
  for (const r of shop) titles[r.slug] = r.title.replace(/\.$/, "");
  const name = slug => titles[slug] || String(slug || "?").replace(/-/g, " ");

  // Newsletter subscribers, and WhatsApp orders that carried a promo code (the code is in the order detail)
  const { results: subs } = await env.DB.prepare("SELECT * FROM subscribers ORDER BY ts DESC").all().catch(() => ({ results: [] }));
  const { results: coded } = await env.DB.prepare("SELECT detail FROM events WHERE target = 'WhatsApp order' AND detail LIKE ?").bind(`%${PROMO.prefix}%`).all();
  const newSubs = subs.filter(s => s.ts >= start && s.ts < end);
  const signups = [newSubs.length, subs.filter(s => s.ts >= start - 7 * days * DAY && s.ts < start).length];
  const day = ev.filter(e => e.ts >= start), before = ev.filter(e => e.ts < start);
  const stats = list => {
    const visits = new Set(list.filter(e => e.type === "view").map(e => e.sid));
    return {
      visitors: new Set(list.filter(e => e.type === "view").map(e => e.vid)).size, visits: visits.size,
      views: list.filter(e => e.type === "view").length,
      orders: list.filter(e => e.target === "WhatsApp order").length, shares: list.filter(e => e.target === "Share print").length,
    };
  };
  const today = stats(day), prev = stats(before);
  const count = list => { const o = {}; for (const k of list) if (k) o[k] = (o[k] || 0) + 1; return Object.entries(o).sort((a, b) => b[1] - a[1]) };
  const firstOfVisit = {}; for (const e of day) firstOfVisit[e.sid] ||= e;
  const visitsBy = f => count(Object.values(firstOfVisit).map(f));
  const views = day.filter(e => e.type === "view");
  const prints = count(views.filter(e => e.page === "print").map(e => e.item)).slice(0, 10).map(([slug, n]) => [name(slug), n,
    new Set(views.filter(e => e.item === slug).map(e => e.vid)).size, day.filter(e => e.item === slug && e.target === "WhatsApp order").length]);
  const orders = day.filter(e => e.target === "WhatsApp order");
  const timeOf = ts => new Date(ts).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const dateText = new Date(end - 1).toLocaleDateString("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const avg = n => Math.round(n / 7 * 10) / 10;
  const period = days === 1 ? "last 24 hours" : `last ${days} days`, avgLabel = days === 1 ? "7-day average" : `average per ${days} days before`;
  const country = c => { try { return c ? new Intl.DisplayNames(["en"], { type: "region" }).of(c) : "Unknown" } catch (e) { return c } };

  // Email-safe HTML: tables and inline styles only
  const ink = "#1c1b18", muted = "#807a70", line = "#e5e0d7", bar = "#2a78d6";
  const h2 = t => `<h2 style="font-size:16px;margin:28px 0 8px;color:${ink}">${esc(t)}</h2>`;
  const none = `<p style="color:${muted};margin:0">Nothing today.</p>`;
  const table = (head, rows) => rows.length ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">
    <tr>${head.map((h, i) => `<th style="text-align:${i && rows.every(r => typeof r[i] === "number") ? "right" : "left"};color:${muted};font-weight:normal;font-size:12px;padding:6px 8px;border-bottom:1px solid ${line}">${esc(h)}</th>`).join("")}</tr>
    ${rows.map(r => `<tr>${r.map((v, i) => `<td style="text-align:${typeof v === "number" ? "right" : "left"};padding:7px 8px;border-bottom:1px solid ${line};color:${ink}">${esc(v)}</td>`).join("")}</tr>`).join("")}</table>` : none;
  const bars = rows => { if (!rows.length) return none; const max = rows[0][1];
    return `<table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px">${rows.slice(0, 6).map(([k, n]) => `<tr>
      <td style="padding:4px 8px 4px 0;color:${ink};width:45%">${esc(k)}</td>
      <td style="padding:4px 0"><div style="background:${bar};height:10px;border-radius:0 4px 4px 0;width:${Math.max(2, Math.round(n / max * 100))}%"></div></td>
      <td style="padding:4px 0 4px 8px;text-align:right;color:${ink};width:40px">${n}</td></tr>`).join("")}</table>` };
  const tile = (label, n, p) => `<td style="padding:6px;width:20%"><div style="border:1px solid ${line};border-radius:8px;padding:12px">
    <div style="font-size:12px;color:${muted}">${label}</div><div style="font-size:26px;font-weight:bold;color:${ink}">${n}</div>
    <div style="font-size:11px;color:${muted}">${avgLabel} ${avg(p)}</div></div></td>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f5f2ed;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px 16px;background:#fff">
<h1 style="font-size:22px;margin:0;color:${ink}">Just Framed: daily report</h1>
<p style="color:${muted};margin:4px 0 16px">${esc(dateText)} · ${period}, until ${timeOf(end)}</p>
<table cellpadding="0" cellspacing="0" style="width:100%;margin:0 -6px"><tr>
${tile("Visitors", today.visitors, prev.visitors)}${tile("Visits", today.visits, prev.visits)}${tile("Page views", today.views, prev.views)}${tile("WhatsApp orders", today.orders, prev.orders)}${tile("Shares", today.shares, prev.shares)}
</tr></table>
${h2("New newsletter subscribers")}${table(["Time", "Email or phone", "Promo code", "From"], newSubs.map(s => [timeOf(s.ts), s.contact, s.code, [s.city, country(s.country)].filter(Boolean).join(", ")]))}
${h2("WhatsApp orders")}${table(["Time", "Print · size · finish · qty · price", "From"], orders.map(o => [timeOf(o.ts), `${name(o.item)} · ${(o.detail || "").replace(/ \| /g, " · ")}`, [o.city, country(o.country)].filter(Boolean).join(", ")]))}
${h2("Most viewed prints")}${table(["Print", "Views", "Visitors", "Orders"], prints)}
${h2("Where visitors came from")}${bars(visitsBy(e => e.ref || "Direct (typed or bookmarked)"))}
${h2("Countries")}${bars(visitsBy(e => country(e.country)))}
${h2("Devices")}${bars(visitsBy(e => e.device))}
${h2("Sizes and finishes picked")}${bars(count(day.filter(e => e.type === "choose").map(e => e.detail)))}
<p style="color:${muted};font-size:12px;margin-top:28px">Counts only visitors who accepted the cookie banner. The attached Excel file has a Statistics sheet (audience, pages, every print and collection opened or not, clicks, with charts) and an Events sheet with every event. For a full report with charts and navigation paths, run <code>node analytics/report.mjs</code>.</p>
</div></body></html>`;

  const text = `Just Framed daily report, ${dateText} (${period}, until ${timeOf(end)})\n\nVisitors: ${today.visitors}\nVisits: ${today.visits}\nPage views: ${today.views}\nWhatsApp orders: ${today.orders}\nShares: ${today.shares}\n\n`
    + (newSubs.length ? "New newsletter subscribers:\n" + newSubs.map(s => `${timeOf(s.ts)}  ${s.contact}  ${s.code}`).join("\n") + "\n\n" : "")
    + (orders.length ? "WhatsApp orders:\n" + orders.map(o => `${timeOf(o.ts)}  ${name(o.item)}  ${o.detail || ""}`).join("\n") + "\n\n" : "")
    + (prints.length ? "Most viewed prints:\n" + prints.map(p => `${p[1]}  ${p[0]}`).join("\n") : "No print pages viewed today.");

  const book = await xlsx({ sheets: [
    statisticsSheet({ day, before, back, shop, name, country, signups, heading: `${dateText} · ${period}, until ${timeOf(end)}`, avgLabel }),
    subscribersSheet(subs, coded, country),
    eventsSheet(day, name),
  ] });

  const stamp = new Date(end - 1).toLocaleDateString("en-CA", { timeZone: TZ });
  const subject = `${test ? "[Test] " : ""}Just Framed: ${today.visitors} visitor${today.visitors === 1 ? "" : "s"}, ${today.orders} WhatsApp order${today.orders === 1 ? "" : "s"} (${stamp})`;
  const raw = mime({ from: `Just Framed report <${REPORT_FROM}>`, to: REPORT_TO, subject, text, html,
    attachment: { name: `report-${stamp}.xlsx`, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: book } });
  await env.MAILER.send(new EmailMessage(REPORT_FROM, REPORT_TO, raw));
}

/* The report's Excel file. Statistics: totals, who visits (audience), and every page, print,
   collection and button with whether anyone opened or used it, each with a chart.
   Prints come from the sheet, so new rows show up here on their own. */
// Keep in sync with COLLECTIONS in index.html
const COLLECTIONS = { new: "New releases", architecture: "Architecture", urban: "Urban", landscape: "Landscape", details: "Details", monochrome: "Black and white" };
// The pages in route() in index.html
const PAGES = { home: "Home", shop: "Shop (all prints)", collections: "Collections", collection: "A collection", print: "A print", about: "About",
  contact: "Contact", cart: "Cart", "poster-box": "Poster box" };
// What the click statistics in index.html record
const CLICKS = ["WhatsApp order", "Cart order", "WhatsApp", "Instagram", "Facebook", "Email", "Send message form", "Share print", "Zoom photo",
  "Photo thumbnail", "Next/previous photo", "Zoom finish photo", "Sort", "Slideshow", "Print card", "Collection card", "Menu", "Previous/next print", "Footer", "Button", "Link", "Newsletter sign-up", "Newsletter closed"];
const ORDER_CLICKS = ["WhatsApp order", "Cart order"], CONTACT_CLICKS = ["WhatsApp", "Instagram", "Facebook", "Email", "Send message form"];

function statisticsSheet({ day, before, back, shop, name, country, signups, heading, avgLabel }) {
  const C = (v, s) => ({ v, s }), val = c => c && typeof c === "object" ? c.v : c;
  const yes = b => C(b ? "Yes" : "No", b ? "yes" : "no");
  const time = ms => C(ms / DAY, "time"), pct = (a, b) => C(b ? a / b : 0, "pct");
  const uniq = (list, f) => new Set(list.map(f).filter(Boolean)).size;
  const avgDur = list => { const d = list.filter(e => e.type === "leave" && e.dur != null); return d.length ? d.reduce((a, e) => a + e.dur, 0) / d.length : 0 };
  const language = l => { try { return l ? new Intl.DisplayNames(["en"], { type: "language" }).of(l) : "Unknown" } catch (e) { return l } };
  const returning = new Set(back.map(r => r.vid));

  const rows = [], charts = [];
  let y = 0;
  const put = cells => { rows[y++] = cells };
  put([C("Just Framed: statistics", "title")]);
  put([C(heading, "muted")]);
  put([C("Counts only visitors who accepted the cookie banner. Every single event is in the Events sheet.", "muted")]);
  y++;

  /* A titled table; with chart, a bar chart of one column beside it (only the rows above zero,
     which come first since tables are sorted, unless keep is set) */
  const section = (title, head, data, { note, chart, keep } = {}) => {
    const top = y;
    put([C(title, "section")]);
    if (note) put([C(note, "muted")]);
    // Headers line up with their column: numbers to the right, Yes/No in the middle
    const align = c => typeof val(c) === "number" ? "headRight" : ["yes", "no"].includes(c?.s) ? "headCenter" : "head";
    put(head.map((h, i) => C(h, i && data.length ? align(data[0][i]) : "head")));
    const first = y;
    if (!data.length) put([C("Nothing in this period.", "muted")]);
    for (const r of data) put(r.map(c => c == null || typeof c === "object" ? c : C(c, typeof c === "number" ? "int" : "cell")));
    let bottom = y;
    if (chart && data.some(r => val(r[chart.col]) > 0)) {
      const n = keep ? data.length : data.filter(r => val(r[chart.col]) > 0).length;
      const h = chart.kind === "column" ? 15 : Math.max(9, Math.ceil(n * 1.3) + 4);
      charts.push({ kind: chart.kind || "bar", title: chart.title, row: top, col: 9, toRow: top + h, toCol: 17,
        cats: [first, first + n - 1, 0], vals: [first, first + n - 1, chart.col], labels: chart.kind !== "column" });
      bottom = Math.max(bottom, top + h);
    }
    y = bottom + 2;
  };
  const group = title => { put([C(title, "title")]); y++ };
  const byViews = (a, b) => val(b[2]) - val(a[2]);

  // Totals, against the average of the periods before
  const measure = list => {
    const views = list.filter(e => e.type === "view"), sids = new Set(views.map(e => e.sid));
    const clicks = targets => list.filter(e => e.type === "click" && targets.includes(e.target));
    const ordered = new Set(clicks(ORDER_CLICKS).map(e => e.sid));
    const perVisit = {}; for (const e of list) if (e.type === "leave" && e.dur != null) perVisit[e.sid] = (perVisit[e.sid] || 0) + e.dur;
    const t = Object.values(perVisit);
    const visitors = new Set(views.map(e => e.vid));
    return { visitors: visitors.size, fresh: [...visitors].filter(v => !returning.has(v)).length, visits: sids.size, views: views.length,
      perVisit: sids.size ? views.length / sids.size : 0, visitTime: t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0,
      printViews: views.filter(e => e.page === "print").length, printsSeen: uniq(views.filter(e => e.page === "print"), e => e.item),
      picks: list.filter(e => e.type === "choose").length, orders: clicks(["WhatsApp order"]).length, cart: clicks(["Cart order"]).length,
      shares: clicks(["Share print"]).length, contact: clicks(CONTACT_CLICKS).length,
      orderRate: sids.size ? [...sids].filter(s => ordered.has(s)).length / sids.size : 0 };
  };
  const now = measure(day), prev = measure(before);
  // [label, measure, kind]: counts are compared with the average per period, rates with the whole time before
  const overview = [["Visitors (different people)", "visitors"], ["   New visitors", "fresh", "only"], ["   Returning visitors", "returning", "only"],
    ["Visits", "visits"], ["Page views", "views"], ["Pages per visit", "perVisit", "dec"], ["Average time per visit (min:sec)", "visitTime", "time"],
    ["Print pages viewed", "printViews"], [`Different prints opened (of ${shop.length} in the shop)`, "printsSeen"], ["Sizes and finishes picked", "picks"],
    ["WhatsApp orders", "orders"], ["Cart orders", "cart"], ["Shares", "shares"], ["Contact clicks (WhatsApp, Instagram, Facebook, email, form)", "contact"],
    ["Visits that ended in an order", "orderRate", "pct"], ["Newsletter sign-ups", "signups"]];
  now.returning = now.visitors - now.fresh;
  [now.signups, prev.signups] = signups;
  section("Overview", ["", "This period", avgLabel.replace(/^./, c => c.toUpperCase()), "Change"], overview.map(([label, k, kind]) => {
    const style = { dec: "dec", time: "time", pct: "pct" }[kind] || "int";
    const a = now[k], b = kind === "only" ? null : kind ? prev[k] : prev[k] / 7;
    const shown = v => v == null ? C("", "cell") : C(kind === "time" ? v / DAY : v, style === "int" && v % 1 ? "dec" : style);
    return [C(label, "cell"), shown(a), shown(b), b ? C(a / b - 1, "change") : C("", "cell")];
  }));

  // Who visits: grouped by visit, from the first thing recorded in each visit
  group("Who is visiting");
  const first = {}; for (const e of day) first[e.sid] ||= e;
  const visits = Object.values(first);
  const audience = (title, f, { all, keep, kind, by = title.replace(/^./, c => c.toLowerCase()) } = {}) => {
    const g = new Map((all || []).map(k => [k, []]));
    for (const e of visits) { const k = f(e) || "Unknown"; if (!g.has(k)) g.set(k, []); g.get(k).push(e) }
    const data = [...g].map(([k, list]) => [k, list.length, uniq(list, e => e.vid), pct(list.length, visits.length)]);
    if (!keep) data.sort((a, b) => b[1] - a[1]);
    section(title, [title.split(" (")[0], "Visits", "Visitors", "Share of visits"], data, { chart: { title: `Visits by ${by}`, col: 1, kind }, keep });
  };
  audience("Country", e => e.country && country(e.country));
  audience("City", e => e.city && `${e.city}, ${country(e.country)}`);
  audience("Came from", e => e.ref || "Direct (typed or bookmarked)", { by: "where they came from" });
  audience("New or returning", e => returning.has(e.vid) ? "Returning" : "New", { all: ["New", "Returning"], by: "new or returning visitors" });
  audience("Device", e => e.device, { all: ["Mobile", "Desktop", "Tablet"] });
  audience("Phone or computer system", e => e.os);
  audience("Browser or app", e => e.browser);
  audience("Language", e => e.lang && language(e.lang));
  audience("Time of day (Beirut)", e => String(beirutHour(e.ts)).padStart(2, "0") + ":00",
    { all: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0") + ":00"), keep: true, kind: "column" });

  // What they opened: every page, print, collection and button, opened/used or not
  group("What they opened");
  const views = day.filter(e => e.type === "view");
  const opened = (list, f) => { const v = views.filter(f), l = day.filter(e => e.type === "leave" && f(e)); return [yes(v.length), v.length, uniq(v, e => e.vid), time(avgDur(l))] };
  const kinds = [...new Set([...Object.keys(PAGES), ...views.map(e => e.page).filter(Boolean)])];
  section("Pages", ["Page", "Opened", "Views", "Visitors", "Average time"],
    kinds.map(k => [PAGES[k] || k, ...opened(views, e => e.page === k)]).sort(byViews), { chart: { title: "Views per page", col: 2 } });

  const seen = new Set(shop.map(p => p.slug));
  const slugs = [...shop.map(p => p.slug), ...new Set(views.filter(e => e.page === "print" && e.item && !seen.has(e.item)).map(e => e.item))];
  const printRows = slugs.map(s => [name(s) + (seen.has(s) ? "" : " (not in the sheet now)"), ...opened(views, e => e.page === "print" && e.item === s),
    day.filter(e => e.type === "choose" && e.item === s).length, day.filter(e => e.target === "Share print" && e.item === s).length,
    day.filter(e => e.target === "WhatsApp order" && e.item === s).length]).sort(byViews);
  section("Prints", ["Print", "Opened", "Views", "Visitors", "Average time", "Size/finish picks", "Shares", "WhatsApp orders"], printRows,
    { note: `${printRows.filter(r => r[2] > 0).length} of ${printRows.length} prints were opened.`, chart: { title: "Views per print", col: 2 } });

  const cols = [...new Set([...Object.keys(COLLECTIONS), ...views.filter(e => e.page === "collection" && e.item).map(e => e.item)])];
  section("Collections", ["Collection", "Opened", "Views", "Visitors", "Average time"],
    cols.map(c => [COLLECTIONS[c] || c, ...opened(views, e => e.page === "collection" && e.item === c)]).sort(byViews), { chart: { title: "Views per collection", col: 2 } });

  const clicks = day.filter(e => e.type === "click");
  const targets = [...new Set([...CLICKS, ...clicks.map(e => e.target).filter(Boolean)])];
  section("Buttons and links", ["Button or link", "Used", "Clicks", "Visitors"], targets.map(t => {
    const list = clicks.filter(e => e.target === t);
    return [t, yes(list.length), list.length, uniq(list, e => e.vid)];
  }).sort(byViews), { chart: { title: "Clicks", col: 2 } });

  const picked = (title, kind, label) => {
    const g = {}; for (const e of day) if (e.type === "choose" && e.target === kind) (g[e.detail || "?"] ||= []).push(e);
    section(title, [label, "Picks", "Visitors"], Object.entries(g).map(([k, l]) => [k, l.length, uniq(l, e => e.vid)])
      .sort((a, b) => b[1] - a[1]), { chart: { title, col: 1 } });
  };
  picked("Sizes picked", "size", "Size");
  picked("Finishes picked", "finish", "Finish");

  // How far visits went toward an order
  const sidsWith = f => new Set(day.filter(f).map(e => e.sid)).size;
  const steps = [["Visited the site", visits.length], ["Opened a print", sidsWith(e => e.type === "view" && e.page === "print")],
    ["Picked a size or finish", sidsWith(e => e.type === "choose")], ["Clicked to order (WhatsApp or cart)", sidsWith(e => ORDER_CLICKS.includes(e.target))]];
  section("From visit to order", ["Step", "Visits", "Share of visits"], steps.map(([k, n]) => [k, n, pct(n, visits.length)]),
    { chart: { title: "Visits reaching each step", col: 1 }, keep: true });

  const orders = day.filter(e => e.target === "WhatsApp order");
  section("WhatsApp orders", ["Print · size · finish · qty · price", "Time (Beirut)", "From"], orders.map(o => [
    C([name(o.item), ...(o.detail ? o.detail.split(" | ") : [])].join(" · "), "wrap"), C(excelTime(o.ts), "date"), [o.city, country(o.country)].filter(Boolean).join(", ")]));

  return { name: "Statistics", rows, charts, grid: false, cols: [44, 19, 16, 14, 14, 18, 14, 16, 3] };
}

// Everyone on the newsletter, newest first
function subscribersSheet(subs, coded, country) {
  const head = ["Signed up (Beirut)", "Email or phone", "Type", "Promo code", "Code emailed", "WhatsApp orders with the code", "Country", "City", "Language"];
  const used = code => coded.filter(e => (e.detail || "").includes(code)).length;
  return { name: "Subscribers", freeze: 1, filter: subs.length > 0, cols: [19, 32, 8, 14, 13, 16, 16, 16, 10],
    rows: [head.map(h => ({ v: h, s: "head" })), ...subs.map(s => [{ v: excelTime(s.ts), s: "date" }, s.contact, s.kind, s.code,
      s.kind === "email" ? (s.emailed ? "Yes" : "No") : "", used(s.code), s.country ? country(s.country) : "", s.city, s.lang])] };
}

function eventsSheet(day, name) {
  const head = ["Time (Beirut)", "Visitor", "Visit", "Type", "Page", "Item", "Clicked or picked", "Detail", "Seconds", "Came from", "Country", "City", "Device", "Browser", "System", "Language"];
  return { name: "Events", freeze: 1, filter: true, cols: [19, 14, 14, 8, 11, 30, 20, 34, 9, 22, 9, 16, 10, 16, 10, 10],
    rows: [head.map(h => ({ v: h, s: "head" })), ...day.map(e => [{ v: excelTime(e.ts), s: "date" }, e.vid, e.sid, e.type, e.page,
      e.page === "print" ? name(e.item) : e.item, e.target, e.detail, e.dur == null ? null : Math.round(e.dur / 1000), e.ref, e.country, e.city, e.device, e.browser, e.os, e.lang])] };
}

// Excel's date number for a time, as the clock showed it in Beirut
function excelTime(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / DAY + 25569;
}

function mime({ from, to, subject, text, html, attachment }) {
  const b64 = s => { const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s; let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/.{76}/g, "$&\r\n") };
  const id = () => crypto.randomUUID().replace(/-/g, "");
  const mixed = "mixed" + id(), alt = "alt" + id();
  return [
    `From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject).replace(/\r\n/g, "")}?=`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`, `Message-ID: <${id()}@justframed-lb.com>`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`, "",
    `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(text),
    `--${alt}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html),
    `--${alt}--`, "",
    ...(attachment ? [`--${mixed}`, `Content-Type: ${attachment.type}; name="${attachment.name}"`, `Content-Disposition: attachment; filename="${attachment.name}"`,
      "Content-Transfer-Encoding: base64", "", b64(attachment.body)] : []),
    `--${mixed}--`, "",
  ].join("\r\n");
}

async function findPrint(slug, url, env) {
  const row = (await catalog(env, url)).find(r => r.slug === slug);
  if (!row) return null;
  const images = (row.images || row.image || row.photos || "").split(/\||\n|\s+(?=https?:)/).map(x => x.trim()).filter(Boolean);
  return { title: row.title, place: row.place || row.location, year: row.year, description: row.description || row.desc, image: images[0] };
}

// The visible prints from the sheet (or the backup prints.csv), each with its slug
async function catalog(env, url) {
  let text = "";
  try {
    const r = await fetch(CATALOG_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) text = await r.text();
  } catch (e) {}
  if (!/slug|title/i.test(text.slice(0, 500))) {
    text = await (await env.ASSETS.fetch(new URL("/prints.csv", url))).text();
  }
  const t = parseCSV(text);
  const head = t[0].map(h => h.trim().toLowerCase());
  const seen = new Set(), out = [];
  for (const r of t.slice(1)) {
    const row = Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()]));
    if (!row.title || /^(no|hide|hidden|false|0)$/i.test(row.show || row.visible || "")) continue;
    // Same slug rules as the page, including -2, -3 for duplicates
    const base = row.slug || slugify(row.title);
    let s = base, k = 2;
    while (seen.has(s)) s = base + "-" + k++;
    seen.add(s);
    out.push({ ...row, slug: s });
  }
  return out;
}

function parseCSV(s) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = "" }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = "" }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  return rows.filter(r => r.some(x => x.trim()));
}

// Same as slugify in index.html
const ACCENTS = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
const slugify = t => String(t).toLowerCase().normalize("NFD").replace(ACCENTS,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,60);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
