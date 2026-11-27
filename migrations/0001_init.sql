-- One row per photo or video. The file itself lives in R2 at `key`; its thumbnail (JPEG) at `thumb_key`.
CREATE TABLE items (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  space         TEXT NOT NULL CHECK (space IN ('family', 'library')),
  kind          TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  captured_at   TEXT,              -- ISO 8601; from EXIF / video metadata, else the file's mtime
  captured_src  TEXT,              -- where captured_at came from: exif | video | mtime | manual
  width         INTEGER,
  height        INTEGER,
  duration      REAL,              -- seconds, videos only
  thumb_key     TEXT,
  -- The social pool: Phase 3 curation reads ONLY social_ok = 1. Family items can never be in it.
  social_ok     INTEGER NOT NULL DEFAULT 0 CHECK (social_ok IN (0, 1)),
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  status        TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  upload_id     TEXT,              -- R2 multipart upload id while status = 'uploading'
  uploaded_by   TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (social_ok = 0 OR space = 'library')
);
CREATE INDEX items_browse ON items (space, status, archived, captured_at DESC);
CREATE INDEX items_dupe ON items (filename, size);

CREATE TABLE item_tags (
  item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX item_tags_tag ON item_tags (tag);

-- What Phase 3 (AI curation) is allowed to read. Never query `items` directly for curation.
CREATE VIEW social_pool AS
  SELECT * FROM items WHERE social_ok = 1 AND space = 'library' AND archived = 0 AND status = 'ready';
