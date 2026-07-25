-- Forward-only additive migration: existing calendars and events are untouched.
-- Dropping this table as a rollback would remove an unresolved duplicate-write
-- guard, so rollback must first reconcile or explicitly acknowledge its row.
CREATE TABLE assistant_calendar_create_reconciliation (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id = 1),
  created_at_utc_ms INTEGER NOT NULL
);
