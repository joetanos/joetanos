/* Share links: /p/<slug>
   Link previews (WhatsApp, Instagram, iMessage…) never see the part of a URL
   after "#", so they always showed the home page. For /p/<slug> this worker
   serves index.html with that print's title, description and photo in the
   preview tags; the page then switches itself to #/print/<slug> as usual.
   /img?u=<photo link>&w=<width> serves a smaller, cached copy of a photo (see sized() in index.html).
   Every other request is served from the static files untouched. */

// Keep in sync with CATALOG_URL in index.html
const CATALOG_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSqN9mnutNqWcd_N8J0_7H0kcn_sGsiIbF-ZNJnkYYgNFAPoR1wfc968rXAjQIBnmo4NiD3XAN7WZsh/pub?output=csv";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/img") return resized(request, url, env, ctx);
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
        el.prepend(`<base href="/"><script>history.replaceState(null,"","/#/print/${encodeURIComponent(slug)}")</script>`, { html: true });
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

async function findPrint(slug, url, env) {
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
  const seen = new Set();
  for (const r of t.slice(1)) {
    const row = Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()]));
    const title = row.title;
    if (!title || /^(no|hide|hidden|false|0)$/i.test(row.show || row.visible || "")) continue;
    // Same slug rules as the page, including -2, -3 for duplicates
    const base = row.slug || slugify(title);
    let s = base, k = 2;
    while (seen.has(s)) s = base + "-" + k++;
    seen.add(s);
    if (s === slug) {
      const images = (row.images || row.image || row.photos || "").split(/\||\n|\s+(?=https?:)/).map(x => x.trim()).filter(Boolean);
      return { title, place: row.place || row.location, year: row.year, description: row.description || row.desc, image: images[0] };
    }
  }
  return null;
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
