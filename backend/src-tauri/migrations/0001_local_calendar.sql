PRAGMA foreign_keys = ON;

CREATE TABLE calendars (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  color_token TEXT,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
  is_read_only INTEGER NOT NULL DEFAULT 0 CHECK(is_read_only IN (0, 1)),
  source_type TEXT NOT NULL DEFAULT 'local' CHECK(source_type = 'local'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_calendars_one_default
  ON calendars(is_default)
  WHERE is_default = 1;

CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 500),
  description TEXT CHECK(description IS NULL OR length(description) <= 20000),
  location TEXT CHECK(location IS NULL OR length(location) <= 2000),
  temporal_kind TEXT NOT NULL CHECK(temporal_kind IN ('timed', 'all_day')),
  start_utc INTEGER,
  end_utc INTEGER,
  time_zone TEXT,
  start_date TEXT,
  end_date_exclusive TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status = 'confirmed'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(
    (
      temporal_kind = 'timed'
      AND start_utc IS NOT NULL
      AND end_utc IS NOT NULL
      AND end_utc > start_utc
      AND time_zone IS NOT NULL
      AND start_date IS NULL
      AND end_date_exclusive IS NULL
    )
    OR
    (
      temporal_kind = 'all_day'
      AND start_utc IS NULL
      AND end_utc IS NULL
      AND time_zone IS NULL
      AND start_date IS NOT NULL
      AND end_date_exclusive IS NOT NULL
      AND end_date_exclusive > start_date
    )
  )
);

CREATE INDEX idx_events_timed_range ON events(calendar_id, start_utc, end_utc);
CREATE INDEX idx_events_all_day_range
  ON events(calendar_id, start_date, end_date_exclusive);

INSERT INTO calendars (
  id,
  name,
  color_token,
  is_default,
  is_read_only,
  source_type,
  created_at,
  updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Personal',
  'calendar-default',
  1,
  0,
  'local',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
