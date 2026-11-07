-- Visit statistics recorded by worker.js (/t). One row per event.
-- Apply with: npx wrangler d1 execute justframed-analytics --remote --file analytics/schema.sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,   -- time, ms since 1970 (UTC)
  vid TEXT,              -- random visitor id (kept in the visitor's browser)
  sid TEXT,              -- random visit (session) id
  type TEXT NOT NULL,    -- view, leave, click, choose
  path TEXT,             -- page address after #, e.g. /print/bekaa
  page TEXT,             -- page kind: home, shop, print, collection, about, ...
  item TEXT,             -- print or collection slug
  target TEXT,           -- what was clicked or chosen
  detail TEXT,           -- extra, e.g. size and finish of a WhatsApp order
  dur INTEGER,           -- ms spent on the page (leave events)
  ref TEXT,              -- where the visit came from
  country TEXT, city TEXT, device TEXT, browser TEXT, os TEXT, lang TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);

-- Newsletter sign-ups from the pop-up (worker.js /subscribe). One row per email address or phone number.
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,          -- sign-up time, ms since 1970 (UTC)
  contact TEXT NOT NULL UNIQUE, -- email address (lowercase) or phone number (+961…)
  kind TEXT NOT NULL,           -- email or phone
  code TEXT NOT NULL UNIQUE,    -- personal promo code, e.g. JF10-7K3QX9
  emailed INTEGER DEFAULT 0,    -- 1 once the code was emailed to them
  whatsapped INTEGER DEFAULT 0, -- 1 once the code was sent to them on WhatsApp (added later: ALTER TABLE subscribers ADD COLUMN whatsapped INTEGER DEFAULT 0)
  country TEXT, city TEXT, lang TEXT,
  tag TEXT,                     -- private id kept by their browser and in their personal link (/?s=<tag>); added later, see subscriber-tags.sql
  unsubscribed INTEGER NOT NULL DEFAULT 0 -- 1: no new release messages (their email's link, or a WhatsApp STOP); added later, see announcements.sql
);
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_tag ON subscribers (tag);

-- Which browsers (events.vid) belong to which subscriber (worker.js /t). A browser is linked once it
-- sends the subscriber's tag: after signing up, entering their promo code or opening their personal
-- link. All its visits, from before and after, then count as theirs.
-- To forget someone: DELETE FROM subscriber_visitors WHERE tag = '<tag>'; DELETE FROM subscribers WHERE tag = '<tag>';
CREATE TABLE IF NOT EXISTS subscriber_visitors (
  tag TEXT NOT NULL,   -- subscribers.tag
  vid TEXT NOT NULL,   -- events.vid
  ts INTEGER NOT NULL, -- when the browser was linked, ms since 1970 (UTC)
  PRIMARY KEY (tag, vid)
);
CREATE INDEX IF NOT EXISTS subscriber_visitors_vid ON subscriber_visitors (vid);

-- The studio's own browsers: opening /?me=1 marks one (index.html, worker.js /t). The reports leave
-- out every visit of these visitor ids, from before and after. Safe to run on an existing database.
CREATE TABLE IF NOT EXISTS owner_visitors (
  vid TEXT PRIMARY KEY, -- events.vid
  ts INTEGER NOT NULL   -- when it was marked, ms since 1970 (UTC)
);

-- The studio's own promo codes (worker.js /promo). Usable any number of times while active = 1.
-- Add one:     INSERT INTO promo_codes (code, percent, min, note, created) VALUES ('NAME20-XXXX', 20, 0, 'what it is for', strftime('%s','now') * 1000);
-- Turn it off: UPDATE promo_codes SET active = 0 WHERE code = 'NAME20-XXXX';
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,   -- in capitals, e.g. JUST20-K7QM
  percent INTEGER NOT NULL, -- discount, e.g. 20 for 20% off
  min REAL DEFAULT 0,      -- smallest order (subtotal in $) it works on; 0 for any order
  active INTEGER DEFAULT 1, -- 0 turns the code off
  note TEXT,               -- what the code is for
  created INTEGER          -- ms since 1970 (UTC)
);

-- New release announcements (worker.js announcements): prints marked yes in the sheet's announce column,
-- sent once to the subscribers. To stop someone: UPDATE subscribers SET unsubscribed = 1 WHERE contact = '<email or +961…>';
CREATE TABLE IF NOT EXISTS announced (
  slug TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  prints TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS announcement_sends (
  announcement INTEGER NOT NULL,
  sub INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  tries INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (announcement, sub)
);
