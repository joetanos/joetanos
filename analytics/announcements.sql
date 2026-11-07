-- New release announcements, for a database made before them (run once, before deploying the worker that uses them):
--   npx wrangler d1 execute justframed-analytics --remote --file analytics/announcements.sql
-- Adds subscribers.unsubscribed and the three announcement tables (see schema.sql).
ALTER TABLE subscribers ADD COLUMN unsubscribed INTEGER NOT NULL DEFAULT 0;
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
