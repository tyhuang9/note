ALTER TABLE calendar_settings ADD COLUMN default_reminder_minutes INTEGER DEFAULT NULL
  CHECK(
    default_reminder_minutes IS NULL
    OR (
      typeof(default_reminder_minutes) = 'integer'
      AND default_reminder_minutes BETWEEN 0 AND 50400
    )
  );

CREATE TABLE reminders (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  lead_minutes INTEGER NOT NULL
    CHECK(typeof(lead_minutes) = 'integer' AND lead_minutes BETWEEN 0 AND 50400),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(event_id, lead_minutes)
);

CREATE INDEX idx_reminders_event_id ON reminders(event_id, lead_minutes);

CREATE TABLE reminder_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  event_revision INTEGER NOT NULL CHECK(event_revision >= 1),
  scheduled_utc INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'claimed', 'delivered', 'failed', 'expired')),
  claimed_at INTEGER,
  delivered_at INTEGER,
  failed_at INTEGER,
  expired_at INTEGER,
  error_code TEXT CHECK(
    error_code IS NULL
    OR (
      length(error_code) BETWEEN 1 AND 64
      AND error_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(event_id, occurrence_key, reminder_id),
  CHECK(
    (status = 'pending' AND claimed_at IS NULL AND delivered_at IS NULL AND failed_at IS NULL AND expired_at IS NULL)
    OR (status = 'claimed' AND claimed_at IS NOT NULL AND delivered_at IS NULL AND failed_at IS NULL AND expired_at IS NULL)
    OR (status = 'delivered' AND claimed_at IS NOT NULL AND delivered_at IS NOT NULL AND failed_at IS NULL AND expired_at IS NULL)
    OR (status = 'failed' AND claimed_at IS NOT NULL AND delivered_at IS NULL AND failed_at IS NOT NULL AND expired_at IS NULL)
    OR (status = 'expired' AND delivered_at IS NULL AND failed_at IS NULL AND expired_at IS NOT NULL)
  )
);

CREATE INDEX idx_reminder_deliveries_pending_due
  ON reminder_deliveries(scheduled_utc DESC, id)
  WHERE status = 'pending';

CREATE TABLE reminder_scheduler_state (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id = 1),
  checkpoint_utc INTEGER NOT NULL DEFAULT 0,
  horizon_end_utc INTEGER NOT NULL DEFAULT 0,
  system_time_zone TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO reminder_scheduler_state (singleton_id) VALUES (1);
