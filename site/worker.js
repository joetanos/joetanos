/* Share links: /p/<slug>
   Link previews (WhatsApp, Instagram, iMessage…) never see the part of a URL
   after "#", so they always showed the home page. For /p/<slug> this worker
   serves index.html with that print's title, description and photo in the
   preview tags; the page then switches itself to #/print/<slug> as usual.
   /img?u=<photo link>&w=<width> serves a smaller, cached copy of a photo (see sized() in index.html).
   /t saves visit statistics sent by the page to the D1 database (see analytics/);
   a summary of them is emailed every evening (dailyReport).
   Every other request is served from the static files untouched. */

import { EmailMessage } from "cloudflare:email";

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
async function reportNow(request, env) {
  if (!env.REPORT_KEY || request.method !== "POST" || request.headers.get("Authorization") !== `Bearer ${env.REPORT_KEY}`)
    return new Response("Not found", { status: 404 });
  try { await dailyReport(env, Date.now(), true) } catch (e) { return new Response("Not sent: " + e.message + "
", { status: 500 }) }
  return new Response("Report sent
");
}

async function dailyReport(env, now, test) {
  const end = test ? now : now - (now % 3600000), start = end - DAY;
  const { results: ev } = await env.DB.prepare("SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts").bind(end - 8 * DAY, end).all();
  const titles = {};
  try { for (const r of await catalog(env, SITE)) titles[r.slug] = r.title.replace(/\.$/, "") } catch (e) {}
  const name = slug => titles[slug] || String(slug || "?").replace(/-/g, " ");

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
    <div style="font-size:11px;color:${muted}">7-day average ${avg(p)}</div></div></td>`;

  const html = `<!doctype html><html><body style="margin:0;background:#f5f2ed;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<div style="max-width:640px;margin:0 auto;padding:24px 16px;background:#fff">
<h1 style="font-size:22px;margin:0;color:${ink}">Just Framed: daily report</h1>
<p style="color:${muted};margin:4px 0 16px">${esc(dateText)} · last 24 hours, until ${timeOf(end)}</p>
<table cellpadding="0" cellspacing="0" style="width:100%;margin:0 -6px"><tr>
${tile("Visitors", today.visitors, prev.visitors)}${tile("Visits", today.visits, prev.visits)}${tile("Page views", today.views, prev.views)}${tile("WhatsApp orders", today.orders, prev.orders)}${tile("Shares", today.shares, prev.shares)}
</tr></table>
${h2("WhatsApp orders")}${table(["Time", "Print · size · finish · qty · price", "From"], orders.map(o => [timeOf(o.ts), `${name(o.item)} · ${(o.detail || "").replace(/ \| /g, " · ")}`, [o.city, country(o.country)].filter(Boolean).join(", ")]))}
${h2("Most viewed prints")}${table(["Print", "Views", "Visitors", "Orders"], prints)}
${h2("Where visitors came from")}${bars(visitsBy(e => e.ref || "Direct (typed or bookmarked)"))}
${h2("Countries")}${bars(visitsBy(e => country(e.country)))}
${h2("Devices")}${bars(visitsBy(e => e.device))}
${h2("Sizes and finishes picked")}${bars(count(day.filter(e => e.type === "choose").map(e => e.detail)))}
<p style="color:${muted};font-size:12px;margin-top:28px">Counts only visitors who accepted the cookie banner. Every event of the day is attached as a CSV file for Excel. For a full report with charts and navigation paths, run <code>node analytics/report.mjs</code>.</p>
</div></body></html>`;

  const text = `Just Framed daily report, ${dateText} (last 24 hours, until ${timeOf(end)})\n\nVisitors: ${today.visitors}\nVisits: ${today.visits}\nPage views: ${today.views}\nWhatsApp orders: ${today.orders}\nShares: ${today.shares}\n\n`
    + (orders.length ? "WhatsApp orders:\n" + orders.map(o => `${timeOf(o.ts)}  ${name(o.item)}  ${o.detail || ""}`).join("\n") + "\n\n" : "")
    + (prints.length ? "Most viewed prints:\n" + prints.map(p => `${p[1]}  ${p[0]}`).join("\n") : "No print pages viewed today.");

  const cols = ["time", "visitor", "visit", "type", "page", "item", "target", "detail", "seconds", "came_from", "country", "city", "device", "browser", "os", "language"];
  const cell = v => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = "﻿" + [cols, ...day.map(e => [new Date(e.ts).toLocaleString("en-GB", { timeZone: TZ }), e.vid, e.sid, e.type, e.page,
    e.page === "print" ? name(e.item) : e.item, e.target, e.detail, e.dur == null ? "" : Math.round(e.dur / 1000), e.ref, e.country, e.city, e.device, e.browser, e.os, e.lang])]
    .map(r => r.map(cell).join(",")).join("\r\n");

  const stamp = new Date(end - 1).toLocaleDateString("en-CA", { timeZone: TZ });
  const subject = `${test ? "[Test] " : ""}Just Framed: ${today.visitors} visitor${today.visitors === 1 ? "" : "s"}, ${today.orders} WhatsApp order${today.orders === 1 ? "" : "s"} (${stamp})`;
  const raw = mime({ from: `Just Framed report <${REPORT_FROM}>`, to: REPORT_TO, subject, text, html,
    attachment: { name: `events-${stamp}.csv`, type: "text/csv", body: csv } });
  await env.MAILER.send(new EmailMessage(REPORT_FROM, REPORT_TO, raw));
}

function mime({ from, to, subject, text, html, attachment }) {
  const b64 = s => { const bytes = new TextEncoder().encode(s); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin).replace(/.{76}/g, "$&\r\n") };
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
    `--${mixed}`, `Content-Type: ${attachment.type}; charset=utf-8; name="${attachment.name}"`, `Content-Disposition: attachment; filename="${attachment.name}"`,
    "Content-Transfer-Encoding: base64", "", b64(attachment.body),
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
