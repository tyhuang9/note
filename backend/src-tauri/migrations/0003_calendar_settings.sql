CREATE TABLE calendar_settings (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id = 1),
  default_event_duration_minutes INTEGER NOT NULL DEFAULT 60
    CHECK(
      typeof(default_event_duration_minutes) = 'integer'
      AND default_event_duration_minutes BETWEEN 15 AND 480
      AND default_event_duration_minutes % 5 = 0
    ),
  week_starts_on TEXT NOT NULL DEFAULT 'monday'
    CHECK(week_starts_on IN ('monday', 'sunday')),
  time_format TEXT NOT NULL DEFAULT 'system'
    CHECK(time_format IN ('system', '12h', '24h'))
);

INSERT INTO calendar_settings (singleton_id) VALUES (1);
