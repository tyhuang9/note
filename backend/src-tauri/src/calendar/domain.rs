use std::{fmt, str::FromStr};

use chrono::{Days, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::error::DomainError;
use super::recurrence::RecurrenceRule;

pub const MAX_QUERY_DAYS: i64 = 366;
pub const MAX_SEARCH_QUERY_CHARS: usize = 200;
pub const MAX_SEARCH_RESULTS: usize = 50;
pub const MIN_AGENDA_PAGE_DAYS: i64 = 12;
pub const MAX_AGENDA_PAGE_DAYS: i64 = 64;
pub const MAX_TITLE_CHARS: usize = 500;
pub const MAX_LOCATION_CHARS: usize = 2_000;
pub const MAX_NOTES_CHARS: usize = 20_000;
pub const MAX_REMINDERS_PER_EVENT: usize = 5;
pub const MAX_REMINDER_LEAD_MINUTES: i64 = 50_400;
const MILLIS_PER_DAY: i64 = 86_400_000;
// A query remains limited to 366 civil dates. Its UTC bounds can be one hour
// longer when a display zone crosses a fall DST transition, so permit a small
// offset cushion without turning this into an unbounded instant query.
const MAX_QUERY_INSTANT_MILLIS: i64 = MAX_QUERY_DAYS * MILLIS_PER_DAY + 2 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EventId(pub Uuid);

impl EventId {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        Uuid::parse_str(value)
            .map(Self)
            .map_err(|_| DomainError::InvalidIdentifier { field: "eventId" })
    }
}

impl fmt::Display for EventId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CalendarId(pub Uuid);

impl fmt::Display for CalendarId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventTime {
    Timed {
        start_utc_ms: i64,
        end_utc_ms: i64,
        time_zone: String,
    },
    AllDay {
        start_date: NaiveDate,
        end_date_exclusive: NaiveDate,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventDraft {
    title: String,
    notes: Option<String>,
    location: Option<String>,
    time: EventTime,
    recurrence_rule: Option<RecurrenceRule>,
    reminder_offsets_minutes: Vec<i64>,
}

impl EventDraft {
    #[cfg(test)]
    pub fn validated(
        title: String,
        notes: Option<String>,
        location: Option<String>,
        time: EventTime,
    ) -> Result<Self, DomainError> {
        Self::validated_with_recurrence(title, notes, location, time, None)
    }

    #[cfg(test)]
    pub fn validated_with_recurrence(
        title: String,
        notes: Option<String>,
        location: Option<String>,
        time: EventTime,
        recurrence_rule: Option<String>,
    ) -> Result<Self, DomainError> {
        Self::validated_with_recurrence_and_reminders(
            title,
            notes,
            location,
            time,
            recurrence_rule,
            Vec::new(),
        )
    }

    pub fn validated_with_recurrence_and_reminders(
        title: String,
        notes: Option<String>,
        location: Option<String>,
        time: EventTime,
        recurrence_rule: Option<String>,
        reminder_offsets_minutes: Vec<i64>,
    ) -> Result<Self, DomainError> {
        let title = title.trim().to_owned();
        let title_length = title.chars().count();
        if title_length == 0 || title_length > MAX_TITLE_CHARS {
            return Err(DomainError::InvalidTitle);
        }

        let notes = normalize_optional(notes, "notes", MAX_NOTES_CHARS)?;
        let location = normalize_optional(location, "location", MAX_LOCATION_CHARS)?;

        validate_event_time(&time)?;
        let recurrence_rule = recurrence_rule
            .map(|source| RecurrenceRule::validated(source, &time))
            .transpose()?;
        let reminder_offsets_minutes = validate_reminder_offsets(reminder_offsets_minutes)?;

        Ok(Self {
            title,
            notes,
            location,
            time,
            recurrence_rule,
            reminder_offsets_minutes,
        })
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        String,
        Option<String>,
        Option<String>,
        EventTime,
        Option<RecurrenceRule>,
    ) {
        (
            self.title,
            self.notes,
            self.location,
            self.time,
            self.recurrence_rule,
        )
    }

    pub(crate) fn reminder_offsets_minutes(&self) -> &[i64] {
        &self.reminder_offsets_minutes
    }
}

pub fn validate_reminder_offsets(mut offsets: Vec<i64>) -> Result<Vec<i64>, DomainError> {
    if offsets.len() > MAX_REMINDERS_PER_EVENT
        || offsets
            .iter()
            .any(|value| !(0..=MAX_REMINDER_LEAD_MINUTES).contains(value))
    {
        return Err(DomainError::InvalidReminderOffsets);
    }
    offsets.sort_unstable();
    if offsets.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(DomainError::InvalidReminderOffsets);
    }
    Ok(offsets)
}

fn normalize_optional(
    value: Option<String>,
    field: &'static str,
    maximum: usize,
) -> Result<Option<String>, DomainError> {
    match value {
        Some(value) if value.is_empty() => Ok(None),
        Some(value) if value.chars().count() > maximum => {
            Err(DomainError::FieldTooLong { field, maximum })
        }
        value => Ok(value),
    }
}

fn validate_event_time(time: &EventTime) -> Result<(), DomainError> {
    match time {
        EventTime::Timed {
            start_utc_ms,
            end_utc_ms,
            time_zone,
        } => {
            Tz::from_str(time_zone).map_err(|_| DomainError::InvalidTimeZone {
                field: "time.timeZone",
            })?;
            if end_utc_ms <= start_utc_ms {
                return Err(DomainError::InvalidRange {
                    field: "time.localEnd",
                });
            }
        }
        EventTime::AllDay {
            start_date,
            end_date_exclusive,
        } if end_date_exclusive <= start_date => {
            return Err(DomainError::InvalidRange {
                field: "time.endDateExclusive",
            });
        }
        EventTime::AllDay { .. } => {}
    }
    Ok(())
}

pub fn resolve_timed_event(
    local_start: &str,
    local_end: &str,
    time_zone: &str,
) -> Result<EventTime, DomainError> {
    let time_zone = Tz::from_str(time_zone).map_err(|_| DomainError::InvalidTimeZone {
        field: "time.timeZone",
    })?;
    let start = parse_local_datetime(local_start, "time.localStart")?;
    let end = parse_local_datetime(local_end, "time.localEnd")?;
    let start = resolve_local_datetime(time_zone, start, "time.localStart")?;
    let end = resolve_local_datetime(time_zone, end, "time.localEnd")?;

    let time = EventTime::Timed {
        start_utc_ms: start.timestamp_millis(),
        end_utc_ms: end.timestamp_millis(),
        time_zone: time_zone.name().to_owned(),
    };
    validate_event_time(&time)?;
    Ok(time)
}

pub fn parse_all_day_event(
    start_date: &str,
    end_date_exclusive: &str,
) -> Result<EventTime, DomainError> {
    let start_date = parse_date(start_date, "time.startDate")?;
    let end_date_exclusive = parse_date(end_date_exclusive, "time.endDateExclusive")?;
    let time = EventTime::AllDay {
        start_date,
        end_date_exclusive,
    };
    validate_event_time(&time)?;
    Ok(time)
}

fn parse_local_datetime(value: &str, field: &'static str) -> Result<NaiveDateTime, DomainError> {
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
        .map_err(|_| DomainError::InvalidRange { field })
}

fn resolve_local_datetime(
    time_zone: Tz,
    local: NaiveDateTime,
    field: &'static str,
) -> Result<chrono::DateTime<Tz>, DomainError> {
    match time_zone.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(value),
        LocalResult::None => Err(DomainError::NonexistentLocalTime { field }),
        LocalResult::Ambiguous(_, _) => Err(DomainError::AmbiguousLocalTime { field }),
    }
}

fn parse_date(value: &str, field: &'static str) -> Result<NaiveDate, DomainError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| DomainError::InvalidRange { field })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventRecord {
    pub id: EventId,
    pub calendar_id: CalendarId,
    pub title: String,
    pub notes: Option<String>,
    pub location: Option<String>,
    pub time: EventTime,
    pub recurrence_rule: Option<RecurrenceRule>,
    pub reminder_offsets_minutes: Vec<i64>,
    pub revision: i64,
    pub created_at_utc_ms: i64,
    pub updated_at_utc_ms: i64,
    pub occurrence_overrides: Vec<OccurrenceOverride>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OccurrenceOverride {
    pub occurrence_key: String,
    pub replacement: Option<OccurrenceOverrideReplacement>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OccurrenceOverrideReplacement {
    pub title: String,
    pub notes: Option<String>,
    pub location: Option<String>,
    pub time: EventTime,
    pub reminder_offsets_minutes: Vec<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OccurrenceRecord {
    pub event_id: EventId,
    pub occurrence_key: String,
    pub calendar_id: CalendarId,
    pub title: String,
    pub notes: Option<String>,
    pub location: Option<String>,
    pub time: EventTime,
    pub revision: i64,
    pub recurrence_rule: Option<RecurrenceRule>,
    pub reminder_offsets_minutes: Vec<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventQueryRange {
    start_utc_ms: i64,
    end_utc_ms: i64,
    start_date: NaiveDate,
    end_date_exclusive: NaiveDate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventSearchQuery {
    value: String,
    limit: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgendaPageQuery {
    range: EventQueryRange,
    start_date: NaiveDate,
    end_date_exclusive: NaiveDate,
    display_time_zone: Tz,
    next_cursor: Option<String>,
    exhausted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgendaDirection {
    Before,
    After,
}

impl AgendaDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
        }
    }
}

impl AgendaPageQuery {
    pub fn validated(
        direction: AgendaDirection,
        anchor_date: Option<&str>,
        cursor: Option<&str>,
        display_time_zone: &str,
        limit: i64,
    ) -> Result<Self, DomainError> {
        if anchor_date.is_some() == cursor.is_some() {
            return Err(DomainError::InvalidAgendaCursor {
                field: "anchorDate",
            });
        }

        let zone = Tz::from_str(display_time_zone).map_err(|_| DomainError::InvalidTimeZone {
            field: "displayTimeZone",
        })?;
        let day_limit = limit.clamp(MIN_AGENDA_PAGE_DAYS, MAX_AGENDA_PAGE_DAYS) as u64;
        let minimum = NaiveDate::from_ymd_opt(1, 1, 1).unwrap();
        let maximum_exclusive = NaiveDate::from_ymd_opt(9999, 12, 31).unwrap();

        let boundary = if let Some(anchor_date) = anchor_date {
            parse_date(anchor_date, "anchorDate")?
        } else {
            decode_agenda_cursor(cursor.unwrap(), direction, display_time_zone, "cursor")?
        };
        let (mut start_date, mut end_date_exclusive) = match direction {
            AgendaDirection::Before => (
                boundary
                    .checked_sub_days(Days::new(day_limit))
                    .unwrap_or(minimum),
                boundary,
            ),
            AgendaDirection::After => (
                boundary,
                boundary
                    .checked_add_days(Days::new(day_limit))
                    .unwrap_or(maximum_exclusive),
            ),
        };

        start_date = start_date.max(minimum);
        end_date_exclusive = end_date_exclusive.min(maximum_exclusive);
        if end_date_exclusive <= start_date {
            return Err(DomainError::InvalidAgendaCursor { field: "cursor" });
        }

        let start_utc_ms = zoned_date_start_utc_ms(start_date, zone)?;
        let end_utc_ms = zoned_date_start_utc_ms(end_date_exclusive, zone)?;
        let range = EventQueryRange::validated(
            start_utc_ms,
            end_utc_ms,
            &start_date.format("%Y-%m-%d").to_string(),
            &end_date_exclusive.format("%Y-%m-%d").to_string(),
        )?;
        let exhausted = match direction {
            AgendaDirection::Before => start_date == minimum,
            AgendaDirection::After => end_date_exclusive == maximum_exclusive,
        };
        let next_boundary = match direction {
            AgendaDirection::Before => start_date,
            AgendaDirection::After => end_date_exclusive,
        };
        let next_cursor =
            (!exhausted).then(|| encode_agenda_cursor(next_boundary, direction, display_time_zone));

        Ok(Self {
            range,
            start_date,
            end_date_exclusive,
            display_time_zone: zone,
            next_cursor,
            exhausted,
        })
    }

    pub fn into_parts(
        self,
    ) -> (
        EventQueryRange,
        NaiveDate,
        NaiveDate,
        Tz,
        Option<String>,
        bool,
    ) {
        (
            self.range,
            self.start_date,
            self.end_date_exclusive,
            self.display_time_zone,
            self.next_cursor,
            self.exhausted,
        )
    }
}

fn encode_agenda_cursor(
    boundary: NaiveDate,
    direction: AgendaDirection,
    display_time_zone: &str,
) -> String {
    let payload = format!(
        "cal-agenda-v2\0{}\0{display_time_zone}\0{}",
        direction.as_str(),
        boundary.format("%Y-%m-%d")
    );
    payload
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_agenda_cursor(
    cursor: &str,
    requested_direction: AgendaDirection,
    requested_time_zone: &str,
    field: &'static str,
) -> Result<NaiveDate, DomainError> {
    if cursor.is_empty() || cursor.len() > 512 || !cursor.len().is_multiple_of(2) {
        return Err(DomainError::InvalidAgendaCursor { field });
    }
    let bytes = cursor
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair)
                .map_err(|_| DomainError::InvalidAgendaCursor { field })?;
            u8::from_str_radix(pair, 16).map_err(|_| DomainError::InvalidAgendaCursor { field })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let payload =
        String::from_utf8(bytes).map_err(|_| DomainError::InvalidAgendaCursor { field })?;
    let mut parts = payload.split('\0');
    let version = parts.next();
    let cursor_direction = parts.next();
    let cursor_time_zone = parts.next();
    let boundary = parts.next();
    if version != Some("cal-agenda-v2")
        || cursor_direction != Some(requested_direction.as_str())
        || cursor_time_zone != Some(requested_time_zone)
        || parts.next().is_some()
    {
        return Err(DomainError::InvalidAgendaCursor { field });
    }
    parse_date(
        boundary.ok_or(DomainError::InvalidAgendaCursor { field })?,
        field,
    )
    .map_err(|_| DomainError::InvalidAgendaCursor { field })
}

pub(crate) fn zoned_date_start_utc_ms(date: NaiveDate, time_zone: Tz) -> Result<i64, DomainError> {
    let target_as_utc = Utc
        .from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .timestamp_millis();
    let mut low = target_as_utc - 48 * 60 * 60 * 1000;
    let mut high = target_as_utc + 48 * 60 * 60 * 1000;
    while low < high {
        let midpoint = low + (high - low) / 2;
        let local_date = time_zone
            .timestamp_millis_opt(midpoint)
            .single()
            .ok_or(DomainError::InvalidRange {
                field: "anchorDate",
            })?
            .date_naive();
        if local_date < date {
            low = midpoint + 1;
        } else {
            high = midpoint;
        }
    }
    let resolved_date = time_zone
        .timestamp_millis_opt(low)
        .single()
        .ok_or(DomainError::InvalidRange {
            field: "anchorDate",
        })?
        .date_naive();
    if resolved_date != date {
        return Err(DomainError::InvalidRange {
            field: "anchorDate",
        });
    }
    Ok(low)
}

impl EventSearchQuery {
    pub fn validated(value: String, limit: i64) -> Result<Self, DomainError> {
        let value = value.trim().to_owned();
        if value.is_empty() {
            return Err(DomainError::InvalidSearchQuery);
        }
        if value.chars().count() > MAX_SEARCH_QUERY_CHARS {
            return Err(DomainError::FieldTooLong {
                field: "query",
                maximum: MAX_SEARCH_QUERY_CHARS,
            });
        }
        if !(1..=MAX_SEARCH_RESULTS as i64).contains(&limit) {
            return Err(DomainError::InvalidSearchLimit);
        }

        Ok(Self {
            value,
            limit: limit as usize,
        })
    }

    pub(crate) fn value(&self) -> &str {
        &self.value
    }

    pub(crate) fn limit(&self) -> usize {
        self.limit
    }
}

impl EventQueryRange {
    pub fn validated(
        start_utc_ms: i64,
        end_utc_ms: i64,
        start_date: &str,
        end_date_exclusive: &str,
    ) -> Result<Self, DomainError> {
        let instant_length = end_utc_ms
            .checked_sub(start_utc_ms)
            .ok_or(DomainError::InvalidRange { field: "endUtcMs" })?;
        if instant_length <= 0 || instant_length > MAX_QUERY_INSTANT_MILLIS {
            return Err(DomainError::InvalidRange { field: "endUtcMs" });
        }

        let start_date = parse_date(start_date, "startDate")?;
        let end_date_exclusive = parse_date(end_date_exclusive, "endDateExclusive")?;
        let date_length = end_date_exclusive
            .signed_duration_since(start_date)
            .num_days();
        if date_length <= 0 || date_length > MAX_QUERY_DAYS {
            return Err(DomainError::InvalidRange {
                field: "endDateExclusive",
            });
        }

        Ok(Self {
            start_utc_ms,
            end_utc_ms,
            start_date,
            end_date_exclusive,
        })
    }

    pub(crate) fn instant_bounds(&self) -> (i64, i64) {
        (self.start_utc_ms, self.end_utc_ms)
    }

    pub(crate) fn date_bounds(&self) -> (NaiveDate, NaiveDate) {
        (self.start_date, self.end_date_exclusive)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_events_resolve_utc_and_non_hour_offset_zones() {
        let utc = resolve_timed_event("2026-07-21T15:00:00", "2026-07-21T15:45:00", "UTC").unwrap();
        assert_eq!(
            utc,
            EventTime::Timed {
                start_utc_ms: 1_784_646_000_000,
                end_utc_ms: 1_784_648_700_000,
                time_zone: "UTC".into(),
            }
        );

        let kolkata =
            resolve_timed_event("2026-07-21T15:00:00", "2026-07-21T15:45:00", "Asia/Kolkata")
                .unwrap();
        assert_eq!(
            kolkata,
            EventTime::Timed {
                start_utc_ms: 1_784_626_200_000,
                end_utc_ms: 1_784_628_900_000,
                time_zone: "Asia/Kolkata".into(),
            }
        );
    }

    #[test]
    fn chicago_summer_time_uses_daylight_offset() {
        let event = resolve_timed_event(
            "2026-07-21T15:00:00",
            "2026-07-21T15:45:00",
            "America/Chicago",
        )
        .unwrap();
        assert_eq!(
            event,
            EventTime::Timed {
                start_utc_ms: 1_784_664_000_000,
                end_utc_ms: 1_784_666_700_000,
                time_zone: "America/Chicago".into(),
            }
        );
    }

    #[test]
    fn daylight_saving_gaps_and_repeats_are_rejected() {
        assert_eq!(
            resolve_timed_event(
                "2026-03-08T02:30:00",
                "2026-03-08T03:30:00",
                "America/Chicago"
            ),
            Err(DomainError::NonexistentLocalTime {
                field: "time.localStart"
            })
        );
        assert_eq!(
            resolve_timed_event(
                "2026-11-01T01:30:00",
                "2026-11-01T02:30:00",
                "America/Chicago"
            ),
            Err(DomainError::AmbiguousLocalTime {
                field: "time.localStart"
            })
        );
    }

    #[test]
    fn title_and_optional_text_are_normalized_and_bounded() {
        let event = EventDraft::validated(
            "  Planning  ".into(),
            Some(String::new()),
            Some(" Room 1 ".into()),
            parse_all_day_event("2026-07-21", "2026-07-22").unwrap(),
        )
        .unwrap();
        assert_eq!(event.title, "Planning");
        assert_eq!(event.notes, None);
        assert_eq!(event.location.as_deref(), Some(" Room 1 "));

        assert_eq!(
            EventDraft::validated(
                " ".into(),
                None,
                None,
                parse_all_day_event("2026-07-21", "2026-07-22").unwrap(),
            ),
            Err(DomainError::InvalidTitle)
        );
        assert!(matches!(
            EventDraft::validated(
                "Valid".into(),
                Some("x".repeat(MAX_NOTES_CHARS + 1)),
                None,
                parse_all_day_event("2026-07-21", "2026-07-22").unwrap(),
            ),
            Err(DomainError::FieldTooLong { field: "notes", .. })
        ));
    }

    #[test]
    fn event_and_query_ranges_are_half_open_and_bounded() {
        assert!(parse_all_day_event("2026-07-21", "2026-07-22").is_ok());
        assert!(parse_all_day_event("2026-07-21", "2026-07-21").is_err());
        assert!(EventQueryRange::validated(
            0,
            MAX_QUERY_DAYS * MILLIS_PER_DAY,
            "2026-01-01",
            "2027-01-02"
        )
        .is_ok());
        // 366 display-zone dates may span an extra hour around a fall DST
        // transition even though the civil-date request remains bounded.
        assert!(EventQueryRange::validated(
            0,
            MAX_QUERY_DAYS * MILLIS_PER_DAY + 60 * 60 * 1000,
            "2026-01-01",
            "2027-01-02"
        )
        .is_ok());
        assert!(EventQueryRange::validated(
            0,
            MAX_QUERY_INSTANT_MILLIS + 1,
            "2026-01-01",
            "2027-01-02"
        )
        .is_err());
    }

    #[test]
    fn search_queries_are_trimmed_unicode_bounded_and_limit_capped() {
        let query = EventSearchQuery::validated("  Planning  ".into(), 50).unwrap();
        assert_eq!(query.value(), "Planning");
        assert_eq!(query.limit(), 50);

        assert_eq!(
            EventSearchQuery::validated(" \n ".into(), 10),
            Err(DomainError::InvalidSearchQuery)
        );
        assert!(matches!(
            EventSearchQuery::validated("é".repeat(MAX_SEARCH_QUERY_CHARS + 1), 10),
            Err(DomainError::FieldTooLong {
                field: "query",
                maximum: MAX_SEARCH_QUERY_CHARS
            })
        ));
        for invalid_limit in [0, 51, i64::MAX] {
            assert_eq!(
                EventSearchQuery::validated("Planning".into(), invalid_limit),
                Err(DomainError::InvalidSearchLimit)
            );
        }
    }

    #[test]
    fn agenda_pages_are_bounded_zone_bound_and_bidirectional() {
        let (_, before_start, before_end, _, before_cursor, before_exhausted) =
            AgendaPageQuery::validated(
                AgendaDirection::Before,
                Some("2026-07-21"),
                None,
                "America/Chicago",
                30,
            )
            .unwrap()
            .into_parts();
        assert_eq!(before_start, NaiveDate::from_ymd_opt(2026, 6, 21).unwrap());
        assert_eq!(before_end, NaiveDate::from_ymd_opt(2026, 7, 21).unwrap());
        assert!(!before_exhausted);

        let (_, earlier_start, earlier_end, _, _, _) = AgendaPageQuery::validated(
            AgendaDirection::Before,
            None,
            before_cursor.as_deref(),
            "America/Chicago",
            30,
        )
        .unwrap()
        .into_parts();
        assert_eq!(earlier_start, NaiveDate::from_ymd_opt(2026, 5, 22).unwrap());
        assert_eq!(earlier_end, before_start);

        let (_, after_start, after_end, _, after_cursor, after_exhausted) =
            AgendaPageQuery::validated(
                AgendaDirection::After,
                Some("2026-07-21"),
                None,
                "America/Chicago",
                30,
            )
            .unwrap()
            .into_parts();
        assert_eq!(after_start, NaiveDate::from_ymd_opt(2026, 7, 21).unwrap());
        assert_eq!(after_end, NaiveDate::from_ymd_opt(2026, 8, 20).unwrap());
        assert!(!after_exhausted);

        let (_, later_start, later_end, _, _, _) = AgendaPageQuery::validated(
            AgendaDirection::After,
            None,
            after_cursor.as_deref(),
            "America/Chicago",
            30,
        )
        .unwrap()
        .into_parts();
        assert_eq!(later_start, after_end);
        assert_eq!(later_end, NaiveDate::from_ymd_opt(2026, 9, 19).unwrap());
    }

    #[test]
    fn agenda_page_selector_and_opaque_cursor_are_strict() {
        assert!(matches!(
            AgendaPageQuery::validated(
                AgendaDirection::After,
                Some("2026-07-21"),
                Some("tampered"),
                "UTC",
                30,
            ),
            Err(DomainError::InvalidAgendaCursor { .. })
        ));
        assert!(matches!(
            AgendaPageQuery::validated(AgendaDirection::After, None, Some("not-hex"), "UTC", 30,),
            Err(DomainError::InvalidAgendaCursor { field: "cursor" })
        ));

        let (_, _, _, _, after, _) = AgendaPageQuery::validated(
            AgendaDirection::After,
            Some("2026-07-21"),
            None,
            "America/Chicago",
            1,
        )
        .unwrap()
        .into_parts();
        let after = after.unwrap();
        assert!(matches!(
            AgendaPageQuery::validated(AgendaDirection::After, None, Some(&after), "UTC", 500,),
            Err(DomainError::InvalidAgendaCursor { field: "cursor" })
        ));
        assert!(matches!(
            AgendaPageQuery::validated(
                AgendaDirection::Before,
                None,
                Some(&after),
                "America/Chicago",
                30,
            ),
            Err(DomainError::InvalidAgendaCursor { field: "cursor" })
        ));

        let (_, start, end, _, _, _) =
            AgendaPageQuery::validated(AgendaDirection::After, Some("2026-07-21"), None, "UTC", 1)
                .unwrap()
                .into_parts();
        assert_eq!(
            end.signed_duration_since(start).num_days(),
            MIN_AGENDA_PAGE_DAYS
        );
    }
}
