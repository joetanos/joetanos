# Just Framed — website

A static website: `index.html` plus the `images/` folder. No database or build
step is needed, so it runs on almost any host.

## Folder contents

| File | What it is |
|---|---|
| `index.html` | The whole site: pages, design and behaviour |
| `prints.csv` | Your current prints, ready to import into Google Sheets |
| `images/` | Logo, favicon and all print photos |
| `.nojekyll` | Needed only for GitHub Pages |
| `wrangler.jsonc`, `.assetsignore` | Settings for Cloudflare (tell it which files to publish) |

## Hosting options (pick one)

### Netlify (easiest, free)
1. Log in at app.netlify.com.
2. Open **Sites**, then drag this whole folder onto the "Deploy manually" area.
3. To update your existing joetanos.netlify.app site instead: open that site →
   **Deploys** → drag the folder onto the upload area.

### Vercel (free)
1. Log in at vercel.com → **Add New… → Project**.
2. Upload this folder (or connect a GitHub repository containing it).
3. Framework preset: **Other**. No build command. Deploy.

### GitHub Pages (free)
1. Create a new repository and upload all files, keeping the `images` folder.
2. **Settings → Pages** → Source: *Deploy from a branch* → `main` / root → Save.

### Shared hosting / cPanel (e.g. a paid domain host)
1. Open **File Manager** → `public_html`.
2. Upload `index.html` and the `images` folder. The other files aren't needed.

### Your own server (VPS, Render, Railway…)
Requires Node.js 18 or newer.
```
npm install
npm start
```
The site runs on port 3000, or on the `PORT` your host provides.

## Adding prints and photos without re-uploading the site

The site can read all of its prints (titles, text, prices and photo links)
from a **Google Sheet**, with the photos stored on **Cloudinary**. Once this
is set up, you add a print by adding a row to the sheet. You never touch the
website files again.

### 1. Put your photos on Cloudinary (free)
1. Create a free account at cloudinary.com.
2. Open **Media Library** → **Upload** and add your photos.
3. Click a photo → **Copy URL**. That link is what goes in the sheet.

Cloudinary links are automatically served at a web-friendly size and format,
so you can upload full-resolution files.

### 2. Create the sheet from `prints.csv`
1. Open sheets.new (a new Google Sheet).
2. **File → Import → Upload** → choose `prints.csv` from this folder →
   *Replace current sheet* → **Import data**.
3. Your current prints are now rows in the sheet.

### 3. Publish the sheet
1. **File → Share → Publish to web**.
2. Choose the sheet tab, then **Comma-separated values (.csv)** → **Publish**.
3. Copy the link it gives you.

### 4. Connect it (the last time you upload the site)
1. Open `index.html` in a text editor and find `const CATALOG_URL = "";`
2. Paste your link between the quotes, e.g.
   `const CATALOG_URL = "https://docs.google.com/spreadsheets/d/e/…/pub?output=csv";`
3. Upload the site once more.

From now on, edit only the sheet. Changes appear on the site within about
5 minutes, since Google refreshes published sheets on its own schedule.

### Sheet columns

| Column | What to write |
|---|---|
| `slug` | Short web name, e.g. `eiffel`. Leave empty to create it from the title. Don't change it later, or old links to that print will break. |
| `title` | The print's name. |
| `place` | e.g. `Paris, France` (optional). |
| `year` | e.g. `2025` (optional). |
| `description` | The text under the title. |
| `collections` | Collection names separated by commas, e.g. `New releases, Landscape`. |
| `coordinates` | e.g. `48.8584° N, 2.2945° E` (optional). |
| `images` | Photo links separated by ` \| `. **The first link is the main image**, the second shows on hover, all of them appear in the gallery. |
| `sizes` | Optional, only for prints with their own sizes: `30 × 45 cm = 60 \| 50 × 75 cm = 120`. Empty = the standard sizes. |
| `show` | `yes`, or `no` to hide a print without deleting it. |

The order of the rows is the order on the site. Collections, standard sizes,
finishes, prices and the WhatsApp number stay in `index.html`.

The photos in `images/` (and the prints written in `index.html`) are only a
backup: the site uses them if the sheet can't be reached.

## Custom domain
Every option above lets you connect your own domain (e.g. joetanos.com) from
its domain/DNS settings page.

## Editing the site
Open `index.html` in a text editor. Near the top of the `<script>` section:

- `WHATSAPP_NUMBER` — the number every WhatsApp button uses.
- `IMAGES` — which image file belongs to which print (`louvre-1` = main image,
  `louvre-2` = secondary, and so on).
- `SIZES` / `FINISHES` — standard print sizes, finishes and prices.
- `COLLECTIONS` — collection names and descriptions.
- `PRINTS` — every print: title, place, year, description, collections,
  coordinates, and the photos it uses.

To add a print: put its photos in `images/` (e.g. `newprint-1.jpg`,
`newprint-2.jpg`), add them to `IMAGES`, then add an entry to `PRINTS` with
`slug:"newprint"` and `photos:["room","photo"]`.
