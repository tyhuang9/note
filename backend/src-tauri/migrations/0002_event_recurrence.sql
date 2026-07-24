ALTER TABLE events
  ADD COLUMN rrule TEXT
  CHECK(
    rrule IS NULL
    OR length(rrule) BETWEEN 1 AND 512
  );

CREATE INDEX idx_events_recurrence_candidates
  ON events(rrule, temporal_kind, start_utc, start_date)
  WHERE rrule IS NOT NULL;
