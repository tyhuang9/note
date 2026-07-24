CREATE TABLE event_overrides (
  id TEXT PRIMARY KEY NOT NULL,
  parent_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  original_start_key TEXT NOT NULL,
  override_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(parent_event_id, original_start_key),
  CHECK(length(original_start_key) BETWEEN 48 AND 128),
  CHECK(original_start_key LIKE parent_event_id || '/%'),
  CHECK(override_event_id IS NULL OR override_event_id <> parent_event_id),
  CHECK(updated_at >= created_at)
);

CREATE INDEX idx_event_overrides_parent_event_id
  ON event_overrides(parent_event_id, original_start_key);

CREATE UNIQUE INDEX idx_event_overrides_override_event_id
  ON event_overrides(override_event_id)
  WHERE override_event_id IS NOT NULL;

CREATE TRIGGER cleanup_event_override_replacement
AFTER DELETE ON event_overrides
WHEN OLD.override_event_id IS NOT NULL
BEGIN
  DELETE FROM events WHERE id = OLD.override_event_id;
END;
