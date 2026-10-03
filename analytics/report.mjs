/* Visit report for justframed-lb.com
   Reads the visit statistics saved by site/worker.js (/t) from the D1 database and writes
   analytics/reports/report-<date>.html (+ .pdf when Chrome or Edge is installed) and
   events-<date>.csv (every event, opens in Excel).

   Run from the project folder (needs Node 18+ and `npx wrangler login` once):
     node analytics/report.mjs              last 30 days
     node analytics/report.mjs --days 7     last 7 days
     node analytics/report.mjs --all        everything recorded
     node analytics/report.mjs --local      the local test database (wrangler dev) instead */

import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB = "justframed-analytics";
const TZ = "Asia/Beirut";
const args = process.argv.slice(2);
const local = args.includes("--local");
const days = args.includes("--all") ? null : Number(args[args.indexOf("--days") + 1]) || 30;
const since = days ? Date.now() - days * 86400000 : 0;

/* ---------- Data ---------- */
function d1(sql) {
  // Plain double-quoted argument: the SQL below never contains " or %
  const out = execSync(`npx -y wrangler@latest d1 execute ${DB} ${local ? "--local" : "--remote"} --json --command "${sql}"`,
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}
console.log(`Reading visit statistics (${days ? `last ${days} days` : "everything"}, ${local ? "local" : "live"} database)…`);
const events = [];
for (let last = 0; ;) {
  const page = d1(`SELECT * FROM events WHERE ts >= ${since} AND id > ${last} ORDER BY id LIMIT 5000`);
  events.push(...page);
  if (page.length < 5000) break;
  last = page[page.length - 1].id;
}
events.sort((a, b) => a.ts - b.ts);
console.log(`${events.length} events.`);

// Print titles from the sheet (same slug rules as the site)
const titles = {};
try {
  const url = readFileSync(join(ROOT, "site/worker.js"), "utf8").match(/CATALOG_URL = "([^"]+)"/)[1];
  const rows = parseCSV(await (await fetch(url)).text());
  const head = rows[0].map(h => h.trim().toLowerCase()), seen = new Set();
  for (const r of rows.slice(1)) {
    const row = Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()]));
    if (!row.title) continue;
    const base = row.slug || slugify(row.title); let s = base, k = 2;
    while (seen.has(s)) s = base + "-" + k++;
    seen.add(s); titles[s] = row.title.replace(/\.$/, "");
  }
} catch (e) { console.warn("Couldn't read print titles from the sheet; showing slugs instead.") }

/* ---------- Numbers ---------- */
const title = slug => titles[slug] || pretty(slug || "?");
const pretty = s => String(s).replace(/-/g, " ").replace(/^./, c => c.toUpperCase());
const PAGE_NAMES = { home: "Home", shop: "All prints", collections: "Collections", about: "About", contact: "Contact", cart: "Cart" };
const pageLabel = e => e.page === "print" ? `Print: ${title(e.item)}` : e.page === "collection" || (e.page === "shop" && e.item)
  ? `Collection: ${pretty(e.item)}` : PAGE_NAMES[e.page] || pretty(e.page || "other");
const views = events.filter(e => e.type === "view");
const clicks = events.filter(e => e.type === "click");
const orders = clicks.filter(e => e.target === "WhatsApp order");

const sessions = new Map();
for (const e of events) {
  const k = e.sid || e.vid || "?";
  if (!sessions.has(k)) sessions.set(k, { vid: e.vid, start: e.ts, end: e.ts, views: [], time: 0, ref: e.ref, country: e.country, city: e.city, device: e.device, browser: e.browser, os: e.os, lang: e.lang, orders: 0 });
  const s = sessions.get(k);
  s.end = e.ts;
  if (e.type === "view") s.views.push(e);
  if (e.type === "leave" && e.dur) s.time += e.dur;
  if (e.target === "WhatsApp order") s.orders++;
}
const S = [...sessions.values()].filter(s => s.views.length);
const visitors = new Set(S.map(s => s.vid));
const perVisitor = count(S.map(s => s.vid));
const returning = Object.values(perVisitor).filter(n => n > 1).length;

const kpis = [
  ["Visitors", fmt(visitors.size), `${fmt(returning)} came back more than once`],
  ["Visits", fmt(S.length), `${pct(S.filter(s => s.views.length === 1).length, S.length)} saw only one page`],
  ["Page views", fmt(views.length), `${(views.length / (S.length || 1)).toFixed(1)} pages per visit`],
  ["Time per visit", dur(avg(S.map(s => s.time))), "average, while the page was on screen"],
  ["WhatsApp orders", fmt(orders.length), `${pct(S.filter(s => s.orders).length, S.length)} of visits sent one`],
  ["Shares", fmt(clicks.filter(e => e.target === "Share print").length), "“Share this print” taps"],
];

// Days (Beirut time)
const dayKey = ts => new Date(ts).toLocaleDateString("en-CA", { timeZone: TZ });
const dayList = [];
for (let t = days ? since : (events[0]?.ts ?? Date.now()); dayKey(t) <= dayKey(Date.now()); t += 86400000) dayList.push(dayKey(t));
const daily = [...new Set(dayList)].map(d => {
  const ss = S.filter(s => dayKey(s.start) === d);
  return { d, visits: ss.length, visitors: new Set(ss.map(s => s.vid)).size, views: views.filter(v => dayKey(v.ts) === d).length, orders: orders.filter(o => dayKey(o.ts) === d).length };
});

// Prints
const leaveTime = {};
for (const e of events) if (e.type === "leave" && e.page === "print" && e.dur) (leaveTime[e.item] ||= []).push(e.dur);
const prints = Object.entries(group(views.filter(v => v.page === "print"), v => v.item)).map(([slug, vs]) => {
  const of = (t) => clicks.filter(c => c.item === slug && c.target === t).length;
  const sessViewed = new Set(vs.map(v => v.sid)), ordered = new Set(orders.filter(o => o.item === slug).map(o => o.sid));
  const chosen = x => top(events.filter(e => e.type === "choose" && e.item === slug && e.target === x).map(e => e.detail));
  return {
    slug, name: title(slug), views: vs.length, visitors: new Set(vs.map(v => v.vid)).size,
    time: avg(leaveTime[slug] || []), opened: of("Print card") + of("Slideshow"), fromSlideshow: of("Slideshow"),
    zooms: of("Zoom photo") + of("Photo thumbnail") + of("Next/previous photo"), shares: of("Share print"), orders: of("WhatsApp order"),
    rate: pct([...ordered].filter(s => sessViewed.has(s)).length, sessViewed.size), size: chosen("size"), finish: chosen("finish"),
  };
}).sort((a, b) => b.views - a.views);

// Navigation
const entries = count(S.map(s => pageLabel(s.views[0])));
const exits = count(S.map(s => pageLabel(s.views.at(-1))));
const steps = count(S.flatMap(s => s.views.slice(1).map((v, i) => `${pageLabel(s.views[i])} → ${pageLabel(v)}`)));
const paths = count(S.filter(s => s.views.length > 1).map(s => s.views.slice(0, 4).map(pageLabel).join(" → ") + (s.views.length > 4 ? " → …" : "")));

const hours = Array.from({ length: 24 }, (_, h) => ({ d: String(h).padStart(2, "0") + "h", views: 0 }));
for (const v of views) hours[+new Date(v.ts).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" })].views++;
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const weekdays = WD.map(d => ({ d, views: 0 }));
for (const v of views) weekdays[WD.indexOf(new Date(v.ts).toLocaleDateString("en-GB", { timeZone: TZ, weekday: "short" }))].views++;

/* ---------- Report ---------- */
const period = events.length ? `${longDate(days ? since : events[0].ts)} – ${longDate(Date.now())}` : "No visits recorded yet";
const stamp = dayKey(Date.now());
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Visit report ${stamp}</title><style>
:root{--surface:#fcfcfb;--page:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--bar:#2a78d6;--ring:rgba(11,11,11,.1)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--surface:#1a1a19;--page:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--bar:#3987e5;--ring:rgba(255,255,255,.1)}}
:root[data-theme="dark"]{--surface:#1a1a19;--page:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--bar:#3987e5;--ring:rgba(255,255,255,.1)}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:0 0 4px}.sub{color:var(--ink2);margin:0 0 24px}.note{color:var(--muted);font-size:12.5px;margin:0 0 14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:18px 20px;margin-bottom:16px;min-width:0}
.kpi .l{color:var(--ink2);font-size:12.5px}.kpi .v{font-size:28px;font-weight:600;margin:2px 0}.kpi .s{color:var(--muted);font-size:12px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.two .card{margin-bottom:0}.two{margin-bottom:16px}
.bars{display:grid;grid-template-columns:minmax(0,auto) 1fr auto;gap:6px 12px;align-items:center}
.bars .k{color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:330px}
.bars .t{height:10px;background:var(--grid);border-radius:0 4px 4px 0}.bars .t i{display:block;height:100%;background:var(--bar);border-radius:0 4px 4px 0;min-width:2px}
.bars .n{font-variant-numeric:tabular-nums;text-align:right}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--grid);white-space:nowrap}th{color:var(--ink2);font-weight:500;font-size:12px;white-space:normal;vertical-align:bottom}
td.num,th.num{text-align:right}td.name{white-space:normal;min-width:180px}
svg text{fill:var(--muted);font:11px system-ui,sans-serif}.empty{color:var(--muted);margin:0}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--surface);padding:6px 9px;border-radius:6px;font-size:12px;display:none;z-index:5}
details summary{cursor:pointer;color:var(--ink2);font-size:12.5px;margin-top:8px}
@media print{body{background:#fff}.card{break-inside:avoid}details{display:none}}
</style></head><body><main>
<h1>Just Framed visit report</h1>
<p class="sub">${esc(period)} · times in Beirut time · generated ${esc(longDate(Date.now()))}</p>
<div class="kpis">${kpis.map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${esc(s)}</div></div>`).join("")}</div>

<div class="card"><h2>Visits per day</h2><p class="note">Hover a day for its numbers.</p>
${columns(daily, "visits", d => `${longDate(d.d)}: ${d.visits} visits, ${d.visitors} visitors, ${d.views} page views, ${d.orders} WhatsApp orders`, d => d.d.slice(5))}
<details><summary>Show as table</summary>${table(["Day", "Visits", "Visitors", "Page views", "WhatsApp orders"], daily.map(d => [d.d, d.visits, d.visitors, d.views, d.orders]))}</details></div>

<div class="card"><h2>Most viewed prints</h2><p class="note">Order rate = share of visits that viewed the print and then tapped “Contact on WhatsApp” on it. Size and finish = the most picked option.</p>
<div class="scroll">${table(["Print", "Views", "Visitors", "Avg time", "Opened from home", "Photo browsing", "Shares", "WhatsApp orders", "Order rate", "Top size", "Top finish"],
  prints.map(p => [p.name, p.views, p.visitors, dur(p.time), p.opened, p.zooms, p.shares, p.orders, p.rate, p.size, p.finish]), true)}</div></div>

<div class="two">
${barCard("Pages viewed", count(views.map(pageLabel)), "Every page, by number of views.", 15)}
${barCard("Clicks", count(clicks.map(c => c.target)), "Buttons and links tapped.")}
</div>
<div class="two">
${barCard("Sizes picked", count(events.filter(e => e.type === "choose" && e.target === "size").map(e => e.detail)), "On print pages.")}
${barCard("Finishes picked", count(events.filter(e => e.type === "choose" && e.target === "finish").map(e => e.detail)), "On print pages.")}
</div>
<div class="two">
${barCard("First page of a visit", entries, "Where visits start.")}
${barCard("Last page of a visit", exits, "Where visitors leave.")}
</div>
<div class="two">
${barCard("Most common next steps", steps, "From one page to the next.", 12)}
${barCard("Most common journeys", paths, "First pages of visits with two or more pages.", 12)}
</div>
<div class="two">
${barCard("Where visitors came from", count(S.map(s => s.ref || "Direct (typed or bookmarked)")), "Other sites, shared print links and campaigns.")}
${barCard("Countries", count(S.map(s => countryName(s.country))), "By visit.")}
</div>
<div class="two">
${barCard("Cities", count(S.map(s => s.city ? `${s.city}, ${countryName(s.country)}` : null).filter(Boolean)), "By visit.", 12)}
${barCard("Devices", count(S.map(s => s.device)), "By visit.")}
</div>
<div class="two">
${barCard("Browsers and apps", count(S.map(s => s.browser)), "Instagram and Facebook apps open links in their own browser.")}
${barCard("Operating systems", count(S.map(s => s.os)), "By visit.")}
</div>
<div class="card"><h2>Busiest hours</h2><p class="note">Page views by hour of day.</p>${columns(hours, "views", h => `${h.d}: ${h.views} page views`, h => h.d.slice(0, 2), 1)}</div>
<div class="two">
${barCard("Busiest days of the week", Object.fromEntries(weekdays.map(d => [d.d, d.views])), "Page views.", 7, true)}
${barCard("Languages", count(S.map(s => s.lang)), "Browser language, by visit.")}
</div>

<div class="card"><h2>WhatsApp orders</h2><p class="note">Every tap on “Contact on WhatsApp” on a print page, newest first (size · finish · quantity · price shown).</p>
<div class="scroll">${table(["When", "Print", "Choice", "From", "Device"], orders.slice().reverse().slice(0, 100).map(o =>
  [longDate(o.ts, true), title(o.item), o.detail || "", [o.city, countryName(o.country)].filter(Boolean).join(", "), [o.device, o.browser].filter(Boolean).join(", ")]), false, true)}</div></div>

<p class="note">Counts only visitors who clicked Accept on the site's cookie banner, so the real number of visitors is higher. Search engines and link-preview robots are left out.</p>
</main><div id="tip"></div>
<script>const tip=document.getElementById("tip");document.addEventListener("pointermove",e=>{const t=e.target.closest("[data-tip]");if(!t){tip.style.display="none";return}tip.textContent=t.dataset.tip;tip.style.display="block";const x=Math.min(e.clientX+12,innerWidth-tip.offsetWidth-8);tip.style.left=x+"px";tip.style.top=(e.clientY+14)+"px"})</script>
</body></html>`;

const dir = join(ROOT, "analytics/reports");
mkdirSync(dir, { recursive: true });
const htmlPath = join(dir, `report-${stamp}.html`), csvPath = join(dir, `events-${stamp}.csv`), pdfPath = join(dir, `report-${stamp}.pdf`);
writeFileSync(htmlPath, html);
const cols = ["when", "visitor", "visit", "type", "page", "item", "target", "detail", "seconds", "came_from", "country", "city", "device", "browser", "os", "language"];
writeFileSync(csvPath, "\ufeff" + [cols, ...events.map(e => [longDate(e.ts, true), e.vid, e.sid, e.type, e.page, e.page === "print" ? title(e.item) : e.item, e.target, e.detail,
  e.dur == null ? "" : Math.round(e.dur / 1000), e.ref, e.country, e.city, e.device, e.browser, e.os, e.lang])]
  .map(r => r.map(v => /[",\n]/.test(v ?? "") ? `"${String(v).replace(/"/g, '""')}"` : v ?? "").join(",")).join("\r\n"));
const browser = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (browser) {
  try { execFileSync(browser, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href], { stdio: "ignore", timeout: 60000 }) }
  catch (e) { console.warn("PDF not made:", e.message) }
}
console.log(`Report: ${htmlPath}${existsSync(pdfPath) ? `\nPDF:    ${pdfPath}` : ""}\nExcel:  ${csvPath}`);

/* ---------- Helpers ---------- */
function count(list) { const o = {}; for (const k of list) if (k != null && k !== "") o[k] = (o[k] || 0) + 1; return o }
function group(list, f) { const o = {}; for (const x of list) (o[f(x)] ||= []).push(x); return o }
function top(list) { const c = Object.entries(count(list)).sort((a, b) => b[1] - a[1]); return c.length ? c[0][0] : "" }
function avg(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0 }
function fmt(n) { return Number(n).toLocaleString("en-US") }
function pct(a, b) { return b ? Math.round(a / b * 100) + "%" : "–" }
function dur(ms) { if (!ms) return "–"; const s = Math.round(ms / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s" }
function longDate(t, time) { return new Date(typeof t === "string" ? t + "T12:00:00Z" : t).toLocaleString("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }) }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])) }
function countryName(c) { if (!c) return "Unknown"; try { return new Intl.DisplayNames(["en"], { type: "region" }).of(c) } catch (e) { return c } }
function table(head, rows, firstIsName, wrapFirst2) {
  if (!rows.length) return `<p class="empty">Nothing recorded yet.</p>`;
  const num = v => typeof v === "number" || /^\d+%$/.test(v);
  return `<table><thead><tr>${head.map((h, i) => `<th class="${i && rows.every(r => num(r[i]) || r[i] === "–") ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r =>
    `<tr>${r.map((v, i) => `<td class="${(firstIsName && !i) || (wrapFirst2 && i === 1) ? "name" : num(v) || v === "–" ? "num" : ""}">${esc(typeof v === "number" ? fmt(v) : v)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function barCard(heading, counts, note, limit = 10, keepOrder) {
  const all = Object.entries(counts).sort((a, b) => keepOrder ? 0 : b[1] - a[1]), rows = all.slice(0, limit), max = rows[0]?.[1] || 1;
  const rest = all.slice(limit).reduce((a, r) => a + r[1], 0);
  if (rest) rows.push([`Other (${all.length - limit})`, rest]);
  return `<div class="card"><h2>${esc(heading)}</h2><p class="note">${esc(note)}</p>${rows.length ? `<div class="bars">${rows.map(([k, n]) =>
    `<span class="k" title="${esc(k)}">${esc(k)}</span><span class="t" data-tip="${esc(k)}: ${fmt(n)}"><i style="width:${Math.min(100, n / max * 100)}%"></i></span><span class="n">${fmt(n)}</span>`).join("")}</div>` : `<p class="empty">Nothing recorded yet.</p>`}</div>`;
}
function columns(list, key, tipText, label, labelEvery) {
  if (!list.some(d => d[key])) return `<p class="empty">Nothing recorded yet.</p>`;
  const W = 1000, H = 200, top = 16, bottom = 22, left = 34, max = Math.max(...list.map(d => d[key]));
  const step = (W - left) / list.length, bw = Math.min(24, step - 2), every = labelEvery || Math.ceil(list.length / 15);
  const y = v => H - bottom - v / max * (H - top - bottom);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Column chart">
${ticks.map(t => `<line x1="${left}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--${t ? "grid" : "axis"})"/><text x="${left - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}
${list.map((d, i) => { const x = left + i * step + (step - bw) / 2, h = H - bottom - y(d[key]);
    return `<g data-tip="${esc(tipText(d))}"><rect x="${left + i * step}" y="${top}" width="${step}" height="${H - top - bottom}" fill="transparent"/>${d[key] ? `<path d="M${x},${H - bottom}v${-(h - 4)}a4,4 0 0 1 4,-4h${bw - 8}a4,4 0 0 1 4,4v${h - 4}z" fill="var(--bar)"/>` : ""}</g>${i % every === 0 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(label(d))}</text>` : ""}`; }).join("")}
</svg>`;
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
function slugify(t) { return String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) }
