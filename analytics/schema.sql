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
  country TEXT, city TEXT, lang TEXT
);
