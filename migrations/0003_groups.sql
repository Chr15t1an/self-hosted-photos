-- Groups (albums): a named, ordered set of items picked by hand, for sharing from a phone's share sheet.
-- A group can hold items from either space. Being in a group changes nothing about an item: not its space, not
-- social_ok, not who can see it. Groups are private like everything else here (no public links).
CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE group_items (
  group_id  TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, item_id)
);
CREATE INDEX group_items_item ON group_items (item_id);
