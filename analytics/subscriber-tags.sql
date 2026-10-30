-- Subscriber visit tracking, for a database made before it (run once, before deploying the worker that uses it):
--   npx wrangler d1 execute justframed-analytics --remote --file analytics/subscriber-tags.sql
-- Gives every existing subscriber a tag and adds the subscriber_visitors table (see schema.sql).
ALTER TABLE subscribers ADD COLUMN tag TEXT;
UPDATE subscribers SET tag = lower(hex(randomblob(5))) WHERE tag IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscribers_tag ON subscribers (tag);
CREATE TABLE IF NOT EXISTS subscriber_visitors (
  tag TEXT NOT NULL,
  vid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (tag, vid)
);
CREATE INDEX IF NOT EXISTS subscriber_visitors_vid ON subscriber_visitors (vid);
