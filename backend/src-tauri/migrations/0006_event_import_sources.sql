CREATE TABLE event_import_sources (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_uid TEXT CHECK(source_uid IS NULL OR length(source_uid) BETWEEN 1 AND 1024),
  source_sequence INTEGER CHECK(source_sequence IS NULL OR source_sequence BETWEEN 0 AND 2147483647),
  parser_version TEXT NOT NULL CHECK(length(parser_version) BETWEEN 1 AND 100),
  imported_at INTEGER NOT NULL,
  CHECK((source_uid IS NULL) = (source_sequence IS NULL))
);

CREATE INDEX idx_event_import_sources_identity
  ON event_import_sources(source_uid, source_sequence);
