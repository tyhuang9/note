use std::{collections::HashSet, str::FromStr};

use chrono::{Datelike, Days, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Weekday};
use chrono_tz::Tz;

use super::{
    domain::{
        EventQueryRange, EventRecord, EventTime, OccurrenceOverrideReplacement, OccurrenceRecord,
    },
    error::DomainError,
};

pub const MAX_RRULE_CHARS: usize = 512;
pub const MAX_OCCURRENCES_PER_QUERY: usize = 1_000;
const MAX_RECURRENCE_CANDIDATES: usize = 500_000;
pub(crate) const MAX_AGENDA_BOUNDARY_INSPECTIONS: usize = MAX_RECURRENCE_CANDIDATES;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgendaOccurrenceSide {
    Before,
    After,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecurrenceRule {
    source: String,
    pattern: RecurrencePattern,
    termination: RecurrenceTermination,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RecurrencePattern {
    Daily,
    Weekdays,
    Weekly { weekdays: Vec<Weekday> },
    MonthlyByMonthDay { day: u32 },
    MonthlyByOrdinalWeekday { ordinal: u32, weekday: Weekday },
    Yearly { month: u32, day: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ParsedByDay {
    Plain(Vec<Weekday>),
    Ordinal { ordinal: u32, weekday: Weekday },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RecurrenceTermination {
    Unbounded,
    Count(u32),
    UntilDate(NaiveDate),
    UntilUtcMs(i64),
}

impl RecurrenceRule {
    pub fn validated(source: String, time: &EventTime) -> Result<Self, DomainError> {
        let source = source.trim();
        let source = source.strip_prefix("RRULE:").unwrap_or(source).to_owned();
        if source.is_empty() || source.chars().count() > MAX_RRULE_CHARS {
            return Err(DomainError::InvalidRecurrenceRule);
        }

        let mut seen = HashSet::new();
        let mut frequency = None;
        let mut by_day = None;
        let mut by_month_day = None;
        let mut count = None;
        let mut until = None;

        for component in source.split(';') {
            let (key, value) = component
                .split_once('=')
                .ok_or(DomainError::InvalidRecurrenceRule)?;
            if key.is_empty() || value.is_empty() || !seen.insert(key) {
                return Err(DomainError::InvalidRecurrenceRule);
            }
            match key {
                "FREQ" => frequency = Some(value),
                "BYDAY" => by_day = Some(parse_by_day(value)?),
                "BYMONTHDAY" => {
                    let parsed = value
                        .parse::<u32>()
                        .map_err(|_| DomainError::InvalidRecurrenceRule)?;
                    if !(1..=31).contains(&parsed) || value != parsed.to_string() {
                        return Err(DomainError::InvalidRecurrenceRule);
                    }
                    by_month_day = Some(parsed);
                }
                "COUNT" => {
                    let parsed = value
                        .parse::<u32>()
                        .map_err(|_| DomainError::InvalidRecurrenceRule)?;
                    if parsed == 0 || parsed as usize > MAX_RECURRENCE_CANDIDATES {
                        return Err(DomainError::InvalidRecurrenceRule);
                    }
                    count = Some(parsed);
                }
                "UNTIL" => until = Some(value),
                _ => return Err(DomainError::InvalidRecurrenceRule),
            }
        }

        if count.is_some() && until.is_some() {
            return Err(DomainError::InvalidRecurrenceRule);
        }

        let seed_date = event_seed_date(time)?;
        let pattern = match (frequency, by_day, by_month_day) {
            (Some("DAILY"), None, None) => RecurrencePattern::Daily,
            (Some("DAILY"), Some(ParsedByDay::Plain(days)), None) if is_weekdays(&days) => {
                RecurrencePattern::Weekdays
            }
            (Some("WEEKLY"), Some(ParsedByDay::Plain(days)), None) if !days.is_empty() => {
                RecurrencePattern::Weekly { weekdays: days }
            }
            (Some("MONTHLY"), None, Some(day)) if day == seed_date.day() => {
                RecurrencePattern::MonthlyByMonthDay { day }
            }
            (Some("MONTHLY"), Some(ParsedByDay::Ordinal { ordinal, weekday }), None)
                if ordinal == ordinal_in_month(seed_date) && weekday == seed_date.weekday() =>
            {
                RecurrencePattern::MonthlyByOrdinalWeekday { ordinal, weekday }
            }
            (Some("YEARLY"), None, None) => RecurrencePattern::Yearly {
                month: seed_date.month(),
                day: seed_date.day(),
            },
            _ => return Err(DomainError::InvalidRecurrenceRule),
        };

        let seed_weekday = seed_date.weekday();
        match &pattern {
            RecurrencePattern::Weekdays if seed_weekday.number_from_monday() > 5 => {
                return Err(DomainError::InvalidRecurrenceRule);
            }
            RecurrencePattern::Weekly { weekdays } if !weekdays.contains(&seed_weekday) => {
                return Err(DomainError::InvalidRecurrenceRule);
            }
            _ => {}
        }

        let termination = match (count, until, time) {
            (Some(count), None, _) => RecurrenceTermination::Count(count),
            (None, Some(value), EventTime::AllDay { .. }) => {
                RecurrenceTermination::UntilDate(parse_until_date(value)?)
            }
            (None, Some(value), EventTime::Timed { .. }) => {
                RecurrenceTermination::UntilUtcMs(parse_until_utc(value)?)
            }
            (None, None, _) => RecurrenceTermination::Unbounded,
            _ => return Err(DomainError::InvalidRecurrenceRule),
        };

        Ok(Self {
            source,
            pattern,
            termination,
        })
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    fn matches_date(&self, seed: NaiveDate, candidate: NaiveDate) -> bool {
        match &self.pattern {
            RecurrencePattern::Daily => true,
            RecurrencePattern::Weekdays => candidate.weekday().number_from_monday() <= 5,
            RecurrencePattern::Weekly { weekdays } => {
                candidate >= seed && weekdays.contains(&candidate.weekday())
            }
            RecurrencePattern::MonthlyByMonthDay { day } => candidate.day() == *day,
            RecurrencePattern::MonthlyByOrdinalWeekday { ordinal, weekday } => {
                candidate.weekday() == *weekday && ordinal_in_month(candidate) == *ordinal
            }
            RecurrencePattern::Yearly { month, day } => {
                candidate.month() == *month && candidate.day() == *day
            }
        }
    }

    fn count_reached(&self, generated: u32) -> bool {
        matches!(self.termination, RecurrenceTermination::Count(limit) if generated >= limit)
    }

    fn after_until_date(&self, date: NaiveDate) -> bool {
        matches!(self.termination, RecurrenceTermination::UntilDate(until) if date > until)
    }

    fn after_until_utc(&self, utc_ms: i64) -> bool {
        matches!(self.termination, RecurrenceTermination::UntilUtcMs(until) if utc_ms > until)
    }
}

fn parse_by_day(value: &str) -> Result<ParsedByDay, DomainError> {
    if !value.contains(',') && value.len() >= 3 {
        let (ordinal, weekday) = value.split_at(value.len() - 2);
        let ordinal = ordinal
            .parse::<u32>()
            .map_err(|_| DomainError::InvalidRecurrenceRule)?;
        if !(1..=5).contains(&ordinal) || ordinal.to_string().as_str() != ordinal_source(value) {
            return Err(DomainError::InvalidRecurrenceRule);
        }
        return Ok(ParsedByDay::Ordinal {
            ordinal,
            weekday: parse_weekday(weekday)?,
        });
    }

    let mut weekdays = Vec::new();
    for token in value.split(',') {
        let weekday = parse_weekday(token)?;
        if weekdays.contains(&weekday) {
            return Err(DomainError::InvalidRecurrenceRule);
        }
        weekdays.push(weekday);
    }
    weekdays.sort_by_key(|day| day.num_days_from_monday());
    Ok(ParsedByDay::Plain(weekdays))
}

fn ordinal_source(value: &str) -> &str {
    &value[..value.len() - 2]
}

fn parse_weekday(value: &str) -> Result<Weekday, DomainError> {
    match value {
        "MO" => Ok(Weekday::Mon),
        "TU" => Ok(Weekday::Tue),
        "WE" => Ok(Weekday::Wed),
        "TH" => Ok(Weekday::Thu),
        "FR" => Ok(Weekday::Fri),
        "SA" => Ok(Weekday::Sat),
        "SU" => Ok(Weekday::Sun),
        _ => Err(DomainError::InvalidRecurrenceRule),
    }
}

fn is_weekdays(days: &[Weekday]) -> bool {
    days == [
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
    ]
}

fn parse_until_date(value: &str) -> Result<NaiveDate, DomainError> {
    NaiveDate::parse_from_str(value, "%Y%m%d").map_err(|_| DomainError::InvalidRecurrenceRule)
}

fn parse_until_utc(value: &str) -> Result<i64, DomainError> {
    let utc = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ")
        .map_err(|_| DomainError::InvalidRecurrenceRule)?
        .and_utc();
    Ok(utc.timestamp_millis())
}

fn event_seed_date(time: &EventTime) -> Result<NaiveDate, DomainError> {
    match time {
        EventTime::AllDay { start_date, .. } => Ok(*start_date),
        EventTime::Timed {
            start_utc_ms,
            time_zone,
            ..
        } => {
            let zone = Tz::from_str(time_zone).map_err(|_| DomainError::InvalidRecurrenceRule)?;
            zone.timestamp_millis_opt(*start_utc_ms)
                .single()
                .map(|value| value.date_naive())
                .ok_or(DomainError::InvalidRecurrenceRule)
        }
    }
}

fn ordinal_in_month(date: NaiveDate) -> u32 {
    ((date.day() - 1) / 7) + 1
}

pub(crate) trait RecurrenceEngine: Send + Sync {
    fn project(
        &self,
        event: &EventRecord,
        range: &EventQueryRange,
        limit: usize,
    ) -> Result<Vec<OccurrenceRecord>, DomainError>;

    fn project_up_to(
        &self,
        event: &EventRecord,
        range: &EventQueryRange,
        limit: usize,
    ) -> Result<Vec<OccurrenceRecord>, DomainError>;

    /// Determines whether a master (including its moved replacements) has an
    /// occurrence on the requested side of an agenda civil-date boundary.
    /// `remaining_inspections` is shared across all masters in one request so
    /// pathological databases fail explicitly instead of consuming unbounded
    /// CPU while trying to prove exhaustion.
    fn has_occurrence_on_side(
        &self,
        event: &EventRecord,
        boundary_date: NaiveDate,
        boundary_utc_ms: i64,
        side: AgendaOccurrenceSide,
        remaining_inspections: &mut usize,
    ) -> Result<bool, DomainError>;
}

#[derive(Default)]
pub(crate) struct Rfc5545RecurrenceEngine;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProjectionLimitBehavior {
    Error,
    Truncate,
}

impl RecurrenceEngine for Rfc5545RecurrenceEngine {
    fn project(
        &self,
        event: &EventRecord,
        range: &EventQueryRange,
        limit: usize,
    ) -> Result<Vec<OccurrenceRecord>, DomainError> {
        self.project_with_limit_behavior(event, range, limit, ProjectionLimitBehavior::Error)
    }

    fn project_up_to(
        &self,
        event: &EventRecord,
        range: &EventQueryRange,
        limit: usize,
    ) -> Result<Vec<OccurrenceRecord>, DomainError> {
        self.project_with_limit_behavior(event, range, limit, ProjectionLimitBehavior::Truncate)
    }

    fn has_occurrence_on_side(
        &self,
        event: &EventRecord,
        boundary_date: NaiveDate,
        boundary_utc_ms: i64,
        side: AgendaOccurrenceSide,
        remaining_inspections: &mut usize,
    ) -> Result<bool, DomainError> {
        if event.occurrence_overrides.iter().any(|item| {
            item.replacement.as_ref().is_some_and(|replacement| {
                time_is_on_agenda_side(&replacement.time, boundary_date, boundary_utc_ms, side)
            })
        }) {
            return Ok(true);
        }

        let Some(rule) = &event.recurrence_rule else {
            return Ok(time_is_on_agenda_side(
                &event.time,
                boundary_date,
                boundary_utc_ms,
                side,
            ));
        };

        match &event.time {
            EventTime::Timed { .. } => has_timed_occurrence_on_side(
                event,
                rule,
                boundary_utc_ms,
                side,
                remaining_inspections,
            ),
            EventTime::AllDay { .. } => has_all_day_occurrence_on_side(
                event,
                rule,
                boundary_date,
                side,
                remaining_inspections,
            ),
        }
    }
}

fn consume_agenda_boundary_inspection(remaining: &mut usize) -> Result<(), DomainError> {
    if *remaining == 0 {
        return Err(DomainError::RecurrenceLimitExceeded);
    }
    *remaining -= 1;
    Ok(())
}

fn time_is_on_agenda_side(
    time: &EventTime,
    boundary_date: NaiveDate,
    boundary_utc_ms: i64,
    side: AgendaOccurrenceSide,
) -> bool {
    match (time, side) {
        (EventTime::Timed { start_utc_ms, .. }, AgendaOccurrenceSide::Before) => {
            *start_utc_ms < boundary_utc_ms
        }
        (EventTime::Timed { end_utc_ms, .. }, AgendaOccurrenceSide::After) => {
            *end_utc_ms > boundary_utc_ms
        }
        (EventTime::AllDay { start_date, .. }, AgendaOccurrenceSide::Before) => {
            *start_date < boundary_date
        }
        (
            EventTime::AllDay {
                end_date_exclusive, ..
            },
            AgendaOccurrenceSide::After,
        ) => *end_date_exclusive > boundary_date,
    }
}

fn has_timed_occurrence_on_side(
    event: &EventRecord,
    rule: &RecurrenceRule,
    boundary_utc_ms: i64,
    side: AgendaOccurrenceSide,
    remaining_inspections: &mut usize,
) -> Result<bool, DomainError> {
    let EventTime::Timed {
        start_utc_ms,
        end_utc_ms,
        time_zone,
    } = &event.time
    else {
        unreachable!();
    };
    let zone = Tz::from_str(time_zone).map_err(|_| DomainError::InvalidRecurrenceRule)?;
    let master_start = zone
        .timestamp_millis_opt(*start_utc_ms)
        .single()
        .ok_or(DomainError::InvalidRecurrenceRule)?
        .naive_local();
    let master_end = zone
        .timestamp_millis_opt(*end_utc_ms)
        .single()
        .ok_or(DomainError::InvalidRecurrenceRule)?
        .naive_local();
    let end_day_offset = master_end
        .date()
        .signed_duration_since(master_start.date())
        .num_days();
    let mut candidate_date = master_start.date();
    let mut generated = 0_u32;

    loop {
        consume_agenda_boundary_inspection(remaining_inspections)?;
        if rule.matches_date(master_start.date(), candidate_date) {
            if rule.count_reached(generated) {
                return Ok(false);
            }
            let local_start = NaiveDateTime::new(candidate_date, master_start.time());
            let Some(local_end_date) = add_signed_days(candidate_date, end_day_offset) else {
                return Ok(false);
            };
            let local_end = NaiveDateTime::new(local_end_date, master_end.time());
            if let Some((projected_start, projected_end)) =
                resolve_recurrence_start(zone, local_start).and_then(|start| {
                    resolve_recurrence_end(zone, local_end, start)
                        .map(|end| (start.timestamp_millis(), end.timestamp_millis()))
                })
            {
                if rule.after_until_utc(projected_start) {
                    return Ok(false);
                }
                generated += 1;
                let occurrence_key =
                    format!("{}/timed/{}", event.id, format_local_key(local_start));
                if !event_has_override(event, &occurrence_key) {
                    match side {
                        AgendaOccurrenceSide::Before if projected_start < boundary_utc_ms => {
                            return Ok(true);
                        }
                        AgendaOccurrenceSide::Before => return Ok(false),
                        AgendaOccurrenceSide::After if projected_end > boundary_utc_ms => {
                            return Ok(true);
                        }
                        AgendaOccurrenceSide::After => {}
                    }
                } else if side == AgendaOccurrenceSide::Before && projected_start >= boundary_utc_ms
                {
                    return Ok(false);
                }
            }
        }

        let Some(next) = candidate_date.succ_opt() else {
            return Ok(false);
        };
        candidate_date = next;
    }
}

fn has_all_day_occurrence_on_side(
    event: &EventRecord,
    rule: &RecurrenceRule,
    boundary_date: NaiveDate,
    side: AgendaOccurrenceSide,
    remaining_inspections: &mut usize,
) -> Result<bool, DomainError> {
    let EventTime::AllDay {
        start_date,
        end_date_exclusive,
    } = event.time
    else {
        unreachable!();
    };
    let duration_days = end_date_exclusive
        .signed_duration_since(start_date)
        .num_days();
    let mut candidate_date = start_date;
    let mut generated = 0_u32;

    loop {
        consume_agenda_boundary_inspection(remaining_inspections)?;
        if rule.matches_date(start_date, candidate_date) {
            if rule.count_reached(generated) || rule.after_until_date(candidate_date) {
                return Ok(false);
            }
            generated += 1;
            let Some(projected_end) = add_signed_days(candidate_date, duration_days) else {
                return Ok(false);
            };
            let occurrence_key = format!("{}/all-day/{candidate_date}", event.id);
            if !event_has_override(event, &occurrence_key) {
                match side {
                    AgendaOccurrenceSide::Before if candidate_date < boundary_date => {
                        return Ok(true);
                    }
                    AgendaOccurrenceSide::Before => return Ok(false),
                    AgendaOccurrenceSide::After if projected_end > boundary_date => {
                        return Ok(true);
                    }
                    AgendaOccurrenceSide::After => {}
                }
            } else if side == AgendaOccurrenceSide::Before && candidate_date >= boundary_date {
                return Ok(false);
            }
        }

        let Some(next) = candidate_date.succ_opt() else {
            return Ok(false);
        };
        candidate_date = next;
    }
}

impl Rfc5545RecurrenceEngine {
    fn project_with_limit_behavior(
        &self,
        event: &EventRecord,
        range: &EventQueryRange,
        limit: usize,
        limit_behavior: ProjectionLimitBehavior,
    ) -> Result<Vec<OccurrenceRecord>, DomainError> {
        if limit == 0 && limit_behavior == ProjectionLimitBehavior::Truncate {
            return Ok(Vec::new());
        }
        let mut occurrences = match (&event.recurrence_rule, &event.time) {
            (Some(rule), EventTime::Timed { .. }) => {
                project_timed(event, rule, range, limit, limit_behavior)
            }
            (Some(rule), EventTime::AllDay { .. }) => {
                project_all_day(event, rule, range, limit, limit_behavior)
            }
            (None, _) => match project_single(event, range)? {
                Some(_) if limit == 0 => Err(DomainError::RecurrenceLimitExceeded),
                Some(occurrence) => Ok(vec![occurrence]),
                None => Ok(Vec::new()),
            },
        }?;

        if event.recurrence_rule.is_some() {
            apply_replacements(event, range, &mut occurrences, limit, limit_behavior)?;
        }
        Ok(occurrences)
    }
}

pub(crate) fn validate_occurrence_key(
    event: &EventRecord,
    occurrence_key: &str,
) -> Result<(), DomainError> {
    if event.recurrence_rule.is_none() {
        return Err(DomainError::InvalidOccurrenceKey);
    }
    let range = occurrence_key_range(event, occurrence_key)?;

    let mut master = event.clone();
    master.occurrence_overrides.clear();
    let projected = Rfc5545RecurrenceEngine.project(&master, &range, 1)?;
    if projected
        .iter()
        .any(|occurrence| occurrence.occurrence_key == occurrence_key)
    {
        Ok(())
    } else {
        Err(DomainError::InvalidOccurrenceKey)
    }
}

#[cfg(test)]
pub(crate) fn resolve_occurrence(
    event: &EventRecord,
    occurrence_key: &str,
) -> Result<OccurrenceRecord, DomainError> {
    validate_occurrence_key(event, occurrence_key)?;

    if let Some(occurrence_override) = event
        .occurrence_overrides
        .iter()
        .find(|item| item.occurrence_key == occurrence_key)
    {
        return occurrence_override
            .replacement
            .as_ref()
            .map(|replacement| occurrence_from_replacement(event, occurrence_key, replacement))
            .ok_or(DomainError::InvalidOccurrenceKey);
    }

    Rfc5545RecurrenceEngine
        .project(event, &occurrence_key_range(event, occurrence_key)?, 1)?
        .into_iter()
        .find(|occurrence| occurrence.occurrence_key == occurrence_key)
        .ok_or(DomainError::InvalidOccurrenceKey)
}

fn occurrence_key_range(
    event: &EventRecord,
    occurrence_key: &str,
) -> Result<EventQueryRange, DomainError> {
    let prefix = format!("{}/", event.id);
    let local_key = occurrence_key
        .strip_prefix(&prefix)
        .ok_or(DomainError::InvalidOccurrenceKey)?;
    let range = match (&event.time, local_key) {
        (EventTime::AllDay { .. }, key) => {
            let date_source = key
                .strip_prefix("all-day/")
                .ok_or(DomainError::InvalidOccurrenceKey)?;
            let date = NaiveDate::parse_from_str(date_source, "%Y-%m-%d")
                .map_err(|_| DomainError::InvalidOccurrenceKey)?;
            if format!("all-day/{}", date.format("%Y-%m-%d")) != key {
                return Err(DomainError::InvalidOccurrenceKey);
            }
            let next = date.succ_opt().ok_or(DomainError::InvalidOccurrenceKey)?;
            let start_utc_ms = date
                .and_hms_opt(0, 0, 0)
                .ok_or(DomainError::InvalidOccurrenceKey)?
                .and_utc()
                .timestamp_millis();
            EventQueryRange::validated(
                start_utc_ms,
                start_utc_ms
                    .checked_add(1)
                    .ok_or(DomainError::InvalidOccurrenceKey)?,
                &date.format("%Y-%m-%d").to_string(),
                &next.format("%Y-%m-%d").to_string(),
            )?
        }
        (EventTime::Timed { time_zone, .. }, key) => {
            let local_source = key
                .strip_prefix("timed/")
                .ok_or(DomainError::InvalidOccurrenceKey)?;
            let local = NaiveDateTime::parse_from_str(local_source, "%Y-%m-%dT%H:%M:%S%.f")
                .map_err(|_| DomainError::InvalidOccurrenceKey)?;
            if format!("timed/{}", format_local_key(local)) != key {
                return Err(DomainError::InvalidOccurrenceKey);
            }
            let zone = Tz::from_str(time_zone).map_err(|_| DomainError::InvalidOccurrenceKey)?;
            let start_utc_ms = resolve_recurrence_start(zone, local)
                .ok_or(DomainError::InvalidOccurrenceKey)?
                .timestamp_millis();
            let date = local.date();
            let next = date.succ_opt().ok_or(DomainError::InvalidOccurrenceKey)?;
            EventQueryRange::validated(
                start_utc_ms,
                start_utc_ms
                    .checked_add(1)
                    .ok_or(DomainError::InvalidOccurrenceKey)?,
                &date.format("%Y-%m-%d").to_string(),
                &next.format("%Y-%m-%d").to_string(),
            )?
        }
    };

    Ok(range)
}

fn project_single(
    event: &EventRecord,
    range: &EventQueryRange,
) -> Result<Option<OccurrenceRecord>, DomainError> {
    let intersects = match &event.time {
        EventTime::Timed {
            start_utc_ms,
            end_utc_ms,
            ..
        } => {
            let (query_start, query_end) = range.instant_bounds();
            *start_utc_ms < query_end && *end_utc_ms > query_start
        }
        EventTime::AllDay {
            start_date,
            end_date_exclusive,
        } => {
            let (query_start, query_end) = range.date_bounds();
            *start_date < query_end && *end_date_exclusive > query_start
        }
    };
    if !intersects {
        return Ok(None);
    }
    Ok(Some(occurrence_from_time(event, event.time.clone())?))
}

fn project_timed(
    event: &EventRecord,
    rule: &RecurrenceRule,
    range: &EventQueryRange,
    limit: usize,
    limit_behavior: ProjectionLimitBehavior,
) -> Result<Vec<OccurrenceRecord>, DomainError> {
    let EventTime::Timed {
        start_utc_ms,
        end_utc_ms,
        time_zone,
    } = &event.time
    else {
        unreachable!();
    };
    let zone = Tz::from_str(time_zone).map_err(|_| DomainError::InvalidRecurrenceRule)?;
    let master_start = zone
        .timestamp_millis_opt(*start_utc_ms)
        .single()
        .ok_or(DomainError::InvalidRecurrenceRule)?
        .naive_local();
    let master_end = zone
        .timestamp_millis_opt(*end_utc_ms)
        .single()
        .ok_or(DomainError::InvalidRecurrenceRule)?
        .naive_local();
    let end_day_offset = master_end
        .date()
        .signed_duration_since(master_start.date())
        .num_days();
    let (query_start, query_end) = range.instant_bounds();
    let mut candidate_date = master_start.date();
    let mut generated = 0_u32;
    let mut inspected = 0_usize;
    let mut occurrences = Vec::new();

    loop {
        inspected += 1;
        if inspected > MAX_RECURRENCE_CANDIDATES {
            return Err(DomainError::RecurrenceLimitExceeded);
        }
        if rule.matches_date(master_start.date(), candidate_date) {
            if rule.count_reached(generated) {
                break;
            }
            let local_start = NaiveDateTime::new(candidate_date, master_start.time());
            let Some(local_end_date) = add_signed_days(candidate_date, end_day_offset) else {
                break;
            };
            let local_end = NaiveDateTime::new(local_end_date, master_end.time());
            let projected = resolve_recurrence_start(zone, local_start).and_then(|start| {
                resolve_recurrence_end(zone, local_end, start)
                    .map(|end| (start.timestamp_millis(), end.timestamp_millis()))
            });

            if let Some((projected_start, projected_end)) = projected {
                if rule.after_until_utc(projected_start) {
                    break;
                }
                generated += 1;
                if projected_start >= query_end {
                    break;
                }
                if projected_end > query_start {
                    let occurrence = occurrence_from_time(
                        event,
                        EventTime::Timed {
                            start_utc_ms: projected_start,
                            end_utc_ms: projected_end,
                            time_zone: time_zone.clone(),
                        },
                    )?;
                    if !event_has_override(event, &occurrence.occurrence_key) {
                        let should_continue =
                            push_bounded(&mut occurrences, occurrence, limit, limit_behavior)?;
                        if !should_continue {
                            break;
                        }
                    }
                }
            }
        }

        let Some(next) = candidate_date.succ_opt() else {
            break;
        };
        candidate_date = next;
    }

    Ok(occurrences)
}

fn resolve_recurrence_start(zone: Tz, local: NaiveDateTime) -> Option<chrono::DateTime<Tz>> {
    match zone.from_local_datetime(&local) {
        LocalResult::Single(value) => Some(value),
        LocalResult::Ambiguous(left, right) => Some(if left <= right { left } else { right }),
        LocalResult::None => None,
    }
}

fn resolve_recurrence_end(
    zone: Tz,
    local: NaiveDateTime,
    start: chrono::DateTime<Tz>,
) -> Option<chrono::DateTime<Tz>> {
    match zone.from_local_datetime(&local) {
        LocalResult::Single(value) if value > start => Some(value),
        LocalResult::Ambiguous(left, right) => [left, right]
            .into_iter()
            .filter(|candidate| *candidate > start)
            .min(),
        _ => None,
    }
}

fn project_all_day(
    event: &EventRecord,
    rule: &RecurrenceRule,
    range: &EventQueryRange,
    limit: usize,
    limit_behavior: ProjectionLimitBehavior,
) -> Result<Vec<OccurrenceRecord>, DomainError> {
    let EventTime::AllDay {
        start_date,
        end_date_exclusive,
    } = event.time
    else {
        unreachable!();
    };
    let duration_days = end_date_exclusive
        .signed_duration_since(start_date)
        .num_days();
    let (query_start, query_end) = range.date_bounds();
    let mut candidate_date = start_date;
    let mut generated = 0_u32;
    let mut inspected = 0_usize;
    let mut occurrences = Vec::new();

    loop {
        inspected += 1;
        if inspected > MAX_RECURRENCE_CANDIDATES {
            return Err(DomainError::RecurrenceLimitExceeded);
        }
        if rule.matches_date(start_date, candidate_date) {
            if rule.count_reached(generated) || rule.after_until_date(candidate_date) {
                break;
            }
            if candidate_date >= query_end {
                break;
            }
            let Some(projected_end) = add_signed_days(candidate_date, duration_days) else {
                break;
            };
            if projected_end > query_start {
                let occurrence = occurrence_from_time(
                    event,
                    EventTime::AllDay {
                        start_date: candidate_date,
                        end_date_exclusive: projected_end,
                    },
                )?;
                if !event_has_override(event, &occurrence.occurrence_key) {
                    let should_continue =
                        push_bounded(&mut occurrences, occurrence, limit, limit_behavior)?;
                    if !should_continue {
                        break;
                    }
                }
            }
            generated += 1;
        }

        let Some(next) = candidate_date.succ_opt() else {
            break;
        };
        candidate_date = next;
    }

    Ok(occurrences)
}

fn add_signed_days(date: NaiveDate, days: i64) -> Option<NaiveDate> {
    if days >= 0 {
        date.checked_add_days(Days::new(days.unsigned_abs()))
    } else {
        date.checked_sub_days(Days::new(days.unsigned_abs()))
    }
}

fn push_bounded(
    occurrences: &mut Vec<OccurrenceRecord>,
    occurrence: OccurrenceRecord,
    limit: usize,
    limit_behavior: ProjectionLimitBehavior,
) -> Result<bool, DomainError> {
    if occurrences.len() >= limit {
        return match limit_behavior {
            ProjectionLimitBehavior::Error => Err(DomainError::RecurrenceLimitExceeded),
            ProjectionLimitBehavior::Truncate => Ok(false),
        };
    }
    occurrences.push(occurrence);
    Ok(limit_behavior == ProjectionLimitBehavior::Error || occurrences.len() < limit)
}

fn event_has_override(event: &EventRecord, occurrence_key: &str) -> bool {
    event
        .occurrence_overrides
        .iter()
        .any(|item| item.occurrence_key == occurrence_key)
}

fn apply_replacements(
    event: &EventRecord,
    range: &EventQueryRange,
    occurrences: &mut Vec<OccurrenceRecord>,
    limit: usize,
    limit_behavior: ProjectionLimitBehavior,
) -> Result<(), DomainError> {
    for item in &event.occurrence_overrides {
        let Some(replacement) = &item.replacement else {
            continue;
        };
        if !time_intersects_range(&replacement.time, range) {
            continue;
        }
        let occurrence = occurrence_from_replacement(event, &item.occurrence_key, replacement);
        match limit_behavior {
            ProjectionLimitBehavior::Error => {
                push_bounded(occurrences, occurrence, limit, limit_behavior)?;
            }
            ProjectionLimitBehavior::Truncate => occurrences.push(occurrence),
        }
    }

    occurrences.sort_by(|left, right| {
        occurrence_time_sort_key(left)
            .cmp(&occurrence_time_sort_key(right))
            .then_with(|| left.occurrence_key.cmp(&right.occurrence_key))
    });
    if limit_behavior == ProjectionLimitBehavior::Truncate {
        occurrences.truncate(limit);
    }
    Ok(())
}

fn time_intersects_range(time: &EventTime, range: &EventQueryRange) -> bool {
    match time {
        EventTime::Timed {
            start_utc_ms,
            end_utc_ms,
            ..
        } => {
            let (start, end) = range.instant_bounds();
            *start_utc_ms < end && *end_utc_ms > start
        }
        EventTime::AllDay {
            start_date,
            end_date_exclusive,
        } => {
            let (start, end) = range.date_bounds();
            *start_date < end && *end_date_exclusive > start
        }
    }
}

fn occurrence_from_replacement(
    event: &EventRecord,
    occurrence_key: &str,
    replacement: &OccurrenceOverrideReplacement,
) -> OccurrenceRecord {
    OccurrenceRecord {
        event_id: event.id,
        occurrence_key: occurrence_key.to_owned(),
        calendar_id: event.calendar_id,
        title: replacement.title.clone(),
        notes: replacement.notes.clone(),
        location: replacement.location.clone(),
        time: replacement.time.clone(),
        revision: event.revision,
        recurrence_rule: event.recurrence_rule.clone(),
        reminder_offsets_minutes: replacement.reminder_offsets_minutes.clone(),
    }
}

fn occurrence_time_sort_key(occurrence: &OccurrenceRecord) -> (u8, i64, String) {
    match &occurrence.time {
        EventTime::AllDay { start_date, .. } => (0, 0, start_date.format("%Y-%m-%d").to_string()),
        EventTime::Timed { start_utc_ms, .. } => (1, *start_utc_ms, String::new()),
    }
}

fn occurrence_from_time(
    event: &EventRecord,
    time: EventTime,
) -> Result<OccurrenceRecord, DomainError> {
    let local_key = match &time {
        EventTime::Timed {
            start_utc_ms,
            time_zone,
            ..
        } => {
            let zone = Tz::from_str(time_zone).map_err(|_| DomainError::InvalidRecurrenceRule)?;
            let local = zone
                .timestamp_millis_opt(*start_utc_ms)
                .single()
                .ok_or(DomainError::InvalidRecurrenceRule)?
                .naive_local();
            format!("timed/{}", format_local_key(local))
        }
        EventTime::AllDay { start_date, .. } => {
            format!("all-day/{}", start_date.format("%Y-%m-%d"))
        }
    };

    Ok(OccurrenceRecord {
        event_id: event.id,
        occurrence_key: format!("{}/{}", event.id, local_key),
        calendar_id: event.calendar_id,
        title: event.title.clone(),
        notes: event.notes.clone(),
        location: event.location.clone(),
        time,
        revision: event.revision,
        recurrence_rule: event.recurrence_rule.clone(),
        reminder_offsets_minutes: event.reminder_offsets_minutes.clone(),
    })
}

fn format_local_key(local: NaiveDateTime) -> String {
    let millis = local.and_utc().timestamp_subsec_millis();
    if millis == 0 {
        local.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!("{}.{millis:03}", local.format("%Y-%m-%dT%H:%M:%S"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::domain::{CalendarId, EventId, EventQueryRange, OccurrenceOverride};
    use uuid::Uuid;

    fn timed_record(local_start: &str, local_end: &str, zone: &str, rule: &str) -> EventRecord {
        let time =
            crate::calendar::domain::resolve_timed_event(local_start, local_end, zone).unwrap();
        EventRecord {
            id: EventId(Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap()),
            calendar_id: CalendarId(
                Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap(),
            ),
            title: "Recurring".into(),
            notes: None,
            location: None,
            recurrence_rule: Some(RecurrenceRule::validated(rule.into(), &time).unwrap()),
            reminder_offsets_minutes: Vec::new(),
            time,
            revision: 2,
            created_at_utc_ms: 1,
            updated_at_utc_ms: 2,
            occurrence_overrides: Vec::new(),
        }
    }

    fn all_day_record(start: NaiveDate, duration_days: u64, rule: &str) -> EventRecord {
        let time = EventTime::AllDay {
            start_date: start,
            end_date_exclusive: start.checked_add_days(Days::new(duration_days)).unwrap(),
        };
        EventRecord {
            id: EventId(Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap()),
            calendar_id: CalendarId(
                Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap(),
            ),
            title: "Recurring".into(),
            notes: None,
            location: None,
            recurrence_rule: Some(RecurrenceRule::validated(rule.into(), &time).unwrap()),
            reminder_offsets_minutes: Vec::new(),
            time,
            revision: 2,
            created_at_utc_ms: 1,
            updated_at_utc_ms: 2,
            occurrence_overrides: Vec::new(),
        }
    }

    fn range(start_ms: i64, end_ms: i64, start: &str, end: &str) -> EventQueryRange {
        EventQueryRange::validated(start_ms, end_ms, start, end).unwrap()
    }

    #[test]
    fn parser_accepts_only_the_supported_rfc_subset() {
        let timed = EventTime::Timed {
            start_utc_ms: 0,
            end_utc_ms: 1,
            time_zone: "UTC".into(),
        };
        assert!(RecurrenceRule::validated("FREQ=DAILY".into(), &timed).is_ok());
        assert!(RecurrenceRule::validated(
            "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=12".into(),
            &timed
        )
        .is_ok());
        assert!(RecurrenceRule::validated("RRULE:FREQ=WEEKLY;BYDAY=TH,MO".into(), &timed).is_ok());
        assert!(RecurrenceRule::validated("FREQ=MONTHLY;BYMONTHDAY=1".into(), &timed).is_ok());
        assert!(RecurrenceRule::validated("FREQ=MONTHLY;BYDAY=1TH".into(), &timed).is_ok());
        assert!(RecurrenceRule::validated("FREQ=YEARLY".into(), &timed).is_ok());
        assert_eq!(
            RecurrenceRule::validated("RRULE:FREQ=DAILY".into(), &timed)
                .unwrap()
                .source(),
            "FREQ=DAILY"
        );
        assert!(
            RecurrenceRule::validated("FREQ=DAILY;UNTIL=20260103T090000Z".into(), &timed).is_ok()
        );
        for invalid in [
            "FREQ=MONTHLY",
            "FREQ=MONTHLY;BYMONTHDAY=2",
            "FREQ=MONTHLY;BYMONTHDAY=01",
            "FREQ=MONTHLY;BYDAY=-1TH",
            "FREQ=MONTHLY;BYDAY=01TH",
            "FREQ=MONTHLY;BYDAY=6TH",
            "FREQ=MONTHLY;BYDAY=1MO",
            "FREQ=MONTHLY;BYDAY=1TH;BYMONTHDAY=1",
            "FREQ=YEARLY;BYMONTHDAY=1",
            "FREQ=YEARLY;BYMONTH=7",
            "FREQ=WEEKLY",
            "FREQ=DAILY;INTERVAL=2",
            "FREQ=DAILY;COUNT=2;UNTIL=20260731T000000Z",
            "FREQ=WEEKLY;BYDAY=1MO",
            "FREQ=WEEKLY;BYDAY=MO",
            "freq=daily",
        ] {
            assert_eq!(
                RecurrenceRule::validated(invalid.into(), &timed),
                Err(DomainError::InvalidRecurrenceRule),
                "{invalid}"
            );
        }
    }

    #[test]
    fn monthly_month_day_skips_impossible_dates_and_counts_only_occurrences() {
        let event = all_day_record(
            NaiveDate::from_ymd_opt(2026, 1, 31).unwrap(),
            1,
            "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
        );
        let query = range(
            1_767_225_600_000,
            1_783_824_000_000,
            "2026-01-01",
            "2026-07-12",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(
            occurrences
                .iter()
                .map(|item| item.occurrence_key.rsplit('/').next().unwrap())
                .collect::<Vec<_>>(),
            ["2026-01-31", "2026-03-31", "2026-05-31"]
        );
    }

    #[test]
    fn monthly_fifth_weekday_skips_months_without_one() {
        let event = all_day_record(
            NaiveDate::from_ymd_opt(2026, 3, 30).unwrap(),
            1,
            "FREQ=MONTHLY;BYDAY=5MO;COUNT=3",
        );
        let query = range(
            1_772_323_200_000,
            1_788_480_000_000,
            "2026-03-01",
            "2026-09-04",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(
            occurrences
                .iter()
                .map(|item| item.occurrence_key.rsplit('/').next().unwrap())
                .collect::<Vec<_>>(),
            ["2026-03-30", "2026-06-29", "2026-08-31"]
        );
    }

    #[test]
    fn yearly_february_29_skips_non_leap_years() {
        let event = all_day_record(
            NaiveDate::from_ymd_opt(2024, 2, 29).unwrap(),
            1,
            "FREQ=YEARLY;COUNT=3",
        );
        let mut occurrences = Vec::new();
        for (start, end) in [
            ("2024-02-29", "2024-03-01"),
            ("2028-02-29", "2028-03-01"),
            ("2032-02-29", "2032-03-01"),
        ] {
            let start_date = NaiveDate::parse_from_str(start, "%Y-%m-%d").unwrap();
            let start_ms = start_date
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis();
            let query = range(start_ms, start_ms + 86_400_000, start, end);
            occurrences.extend(
                Rfc5545RecurrenceEngine
                    .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
                    .unwrap(),
            );
        }
        assert_eq!(
            occurrences
                .iter()
                .map(|item| item.occurrence_key.rsplit('/').next().unwrap())
                .collect::<Vec<_>>(),
            ["2024-02-29", "2028-02-29", "2032-02-29"]
        );
    }

    #[test]
    fn occurrence_key_validation_requires_canonical_current_series_member() {
        let event = all_day_record(
            NaiveDate::from_ymd_opt(2026, 1, 31).unwrap(),
            1,
            "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
        );
        let valid = format!("{}/all-day/2026-03-31", event.id);
        assert_eq!(validate_occurrence_key(&event, &valid), Ok(()));
        for invalid in [
            format!("{}/all-day/2026-02-28", event.id),
            format!("{}/all-day/2026-03-031", event.id),
            format!("{}/timed/2026-03-31T09:00:00", event.id),
            format!("{}/all-day/2026-07-31", event.id),
        ] {
            assert_eq!(
                validate_occurrence_key(&event, &invalid),
                Err(DomainError::InvalidOccurrenceKey),
                "{invalid}"
            );
        }
    }

    #[test]
    fn occurrence_resolution_returns_moved_overrides_and_rejects_cancellations() {
        let mut event = all_day_record(
            NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
            1,
            "FREQ=DAILY;COUNT=4",
        );
        let key = format!("{}/all-day/2026-07-22", event.id);
        event.occurrence_overrides.push(OccurrenceOverride {
            occurrence_key: key.clone(),
            replacement: Some(OccurrenceOverrideReplacement {
                title: "Moved occurrence".into(),
                notes: None,
                location: None,
                time: EventTime::AllDay {
                    start_date: NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
                    end_date_exclusive: NaiveDate::from_ymd_opt(2026, 8, 11).unwrap(),
                },
                reminder_offsets_minutes: vec![15],
            }),
        });

        let resolved = resolve_occurrence(&event, &key).unwrap();
        assert_eq!(resolved.title, "Moved occurrence");
        assert_eq!(resolved.occurrence_key, key);

        event.occurrence_overrides[0].replacement = None;
        assert_eq!(
            resolve_occurrence(&event, &event.occurrence_overrides[0].occurrence_key),
            Err(DomainError::InvalidOccurrenceKey)
        );
    }

    #[test]
    fn daily_timed_recurrence_preserves_wall_clock_across_dst() {
        let event = timed_record(
            "2026-03-06T09:00:00",
            "2026-03-06T10:00:00",
            "America/Chicago",
            "FREQ=DAILY;COUNT=5",
        );
        let query = range(
            1_772_755_200_000,
            1_773_187_200_000,
            "2026-03-05",
            "2026-03-10",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(occurrences.len(), 5);
        let starts: Vec<_> = occurrences
            .iter()
            .map(|item| match &item.time {
                EventTime::Timed {
                    start_utc_ms,
                    time_zone,
                    ..
                } => Tz::from_str(time_zone)
                    .unwrap()
                    .timestamp_millis_opt(*start_utc_ms)
                    .unwrap()
                    .format("%Y-%m-%d %H:%M %:z")
                    .to_string(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(
            starts,
            [
                "2026-03-06 09:00 -06:00",
                "2026-03-07 09:00 -06:00",
                "2026-03-08 09:00 -05:00",
                "2026-03-09 09:00 -05:00",
                "2026-03-10 09:00 -05:00",
            ]
        );
    }

    #[test]
    fn auckland_daily_recurrence_preserves_wall_clock_across_dst() {
        let event = timed_record(
            "2026-09-25T09:00:00",
            "2026-09-25T10:00:00",
            "Pacific/Auckland",
            "FREQ=DAILY;COUNT=5",
        );
        let query = range(
            1_790_236_800_000,
            1_790_668_800_000,
            "2026-09-24",
            "2026-09-29",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(occurrences.len(), 5);
        let starts: Vec<_> = occurrences
            .iter()
            .map(|item| match &item.time {
                EventTime::Timed {
                    start_utc_ms,
                    time_zone,
                    ..
                } => Tz::from_str(time_zone)
                    .unwrap()
                    .timestamp_millis_opt(*start_utc_ms)
                    .unwrap()
                    .format("%Y-%m-%d %H:%M %:z")
                    .to_string(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(
            starts,
            [
                "2026-09-25 09:00 +12:00",
                "2026-09-26 09:00 +12:00",
                "2026-09-27 09:00 +13:00",
                "2026-09-28 09:00 +13:00",
                "2026-09-29 09:00 +13:00",
            ]
        );
    }

    #[test]
    fn berlin_daily_recurrence_preserves_wall_clock_across_dst() {
        let event = timed_record(
            "2026-03-27T09:00:00",
            "2026-03-27T10:00:00",
            "Europe/Berlin",
            "FREQ=DAILY;COUNT=5",
        );
        let query = range(
            chrono::Utc
                .with_ymd_and_hms(2026, 3, 26, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            chrono::Utc
                .with_ymd_and_hms(2026, 4, 1, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            "2026-03-26",
            "2026-04-01",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        let starts: Vec<_> = occurrences
            .iter()
            .map(|item| match &item.time {
                EventTime::Timed {
                    start_utc_ms,
                    time_zone,
                    ..
                } => Tz::from_str(time_zone)
                    .unwrap()
                    .timestamp_millis_opt(*start_utc_ms)
                    .unwrap()
                    .format("%Y-%m-%d %H:%M %:z")
                    .to_string(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(
            starts,
            [
                "2026-03-27 09:00 +01:00",
                "2026-03-28 09:00 +01:00",
                "2026-03-29 09:00 +02:00",
                "2026-03-30 09:00 +02:00",
                "2026-03-31 09:00 +02:00",
            ]
        );
    }

    #[test]
    fn nonexistent_instances_do_not_consume_count() {
        let event = timed_record(
            "2026-03-07T02:30:00",
            "2026-03-07T03:30:00",
            "America/Chicago",
            "FREQ=DAILY;COUNT=3",
        );
        let query = range(
            chrono::Utc
                .with_ymd_and_hms(2026, 3, 7, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            chrono::Utc
                .with_ymd_and_hms(2026, 3, 12, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            "2026-03-07",
            "2026-03-12",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(
            occurrences
                .iter()
                .map(|item| item.occurrence_key.rsplit('/').next().unwrap())
                .collect::<Vec<_>>(),
            [
                "2026-03-07T02:30:00",
                "2026-03-09T02:30:00",
                "2026-03-10T02:30:00",
            ]
        );
    }

    #[test]
    fn ambiguous_fall_back_occurrence_uses_earliest_valid_instant() {
        let event = timed_record(
            "2026-10-25T01:30:00",
            "2026-10-25T02:30:00",
            "America/Chicago",
            "FREQ=WEEKLY;BYDAY=SU;COUNT=2",
        );
        let query = range(
            chrono::Utc
                .with_ymd_and_hms(2026, 10, 24, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            chrono::Utc
                .with_ymd_and_hms(2026, 11, 3, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            "2026-10-24",
            "2026-11-03",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(occurrences.len(), 2);
        let EventTime::Timed { start_utc_ms, .. } = occurrences[1].time else {
            unreachable!();
        };
        let local = chrono_tz::America::Chicago
            .timestamp_millis_opt(start_utc_ms)
            .single()
            .unwrap();
        assert_eq!(
            local.format("%Y-%m-%d %H:%M %:z").to_string(),
            "2026-11-01 01:30 -05:00"
        );
    }

    #[test]
    fn weekly_selected_days_count_and_local_keys_are_stable() {
        let event = timed_record(
            "2026-07-20T09:00:00",
            "2026-07-20T10:00:00",
            "Europe/Berlin",
            "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4",
        );
        let query = range(
            1_784_505_600_000,
            1_785_456_000_000,
            "2026-07-19",
            "2026-07-30",
        );
        let first = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        let second = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 4);
        assert_eq!(
            first
                .iter()
                .map(|item| item.occurrence_key.as_str())
                .collect::<Vec<_>>(),
            [
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/timed/2026-07-20T09:00:00",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/timed/2026-07-22T09:00:00",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/timed/2026-07-27T09:00:00",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/timed/2026-07-29T09:00:00",
            ]
        );
    }

    #[test]
    fn all_day_weekdays_and_until_are_inclusive_and_half_open() {
        let event = all_day_record(
            NaiveDate::from_ymd_opt(2026, 7, 17).unwrap(),
            1,
            "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20260721",
        );
        let query = range(
            1_784_448_000_000,
            1_784_880_000_000,
            "2026-07-19",
            "2026-07-24",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(
            occurrences
                .iter()
                .map(|item| match item.time {
                    EventTime::AllDay { start_date, .. } => start_date,
                    _ => unreachable!(),
                })
                .collect::<Vec<_>>(),
            [
                NaiveDate::from_ymd_opt(2026, 7, 20).unwrap(),
                NaiveDate::from_ymd_opt(2026, 7, 21).unwrap(),
            ]
        );
    }

    #[test]
    fn daily_all_day_recurrence_crosses_leap_day() {
        let event = all_day_record(
            NaiveDate::from_ymd_opt(2028, 2, 28).unwrap(),
            1,
            "FREQ=DAILY;COUNT=3",
        );
        let query = range(
            chrono::Utc
                .with_ymd_and_hms(2028, 2, 28, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            chrono::Utc
                .with_ymd_and_hms(2028, 3, 2, 0, 0, 0)
                .unwrap()
                .timestamp_millis(),
            "2028-02-28",
            "2028-03-02",
        );
        let occurrences = Rfc5545RecurrenceEngine
            .project(&event, &query, MAX_OCCURRENCES_PER_QUERY)
            .unwrap();
        assert_eq!(
            occurrences
                .iter()
                .map(|item| match item.time {
                    EventTime::AllDay { start_date, .. } => start_date,
                    _ => unreachable!(),
                })
                .collect::<Vec<_>>(),
            [
                NaiveDate::from_ymd_opt(2028, 2, 28).unwrap(),
                NaiveDate::from_ymd_opt(2028, 2, 29).unwrap(),
                NaiveDate::from_ymd_opt(2028, 3, 1).unwrap(),
            ]
        );
    }

    #[test]
    fn expansion_is_hard_capped() {
        let event = all_day_record(
            NaiveDate::from_ymd_opt(2020, 1, 1).unwrap(),
            3_000,
            "FREQ=DAILY",
        );
        let query = range(
            1_767_225_600_000,
            1_798_848_000_000,
            "2026-01-01",
            "2027-01-01",
        );
        assert_eq!(
            Rfc5545RecurrenceEngine.project(&event, &query, 3),
            Err(DomainError::RecurrenceLimitExceeded)
        );
        let prefix = Rfc5545RecurrenceEngine
            .project_up_to(&event, &query, 3)
            .unwrap();
        assert_eq!(prefix.len(), 3);
        assert_eq!(
            prefix
                .iter()
                .map(|occurrence| occurrence.occurrence_key.as_str())
                .collect::<Vec<_>>(),
            [
                format!("{}/all-day/2020-01-01", event.id),
                format!("{}/all-day/2020-01-02", event.id),
                format!("{}/all-day/2020-01-03", event.id),
            ]
        );
    }

    #[test]
    fn until_type_must_match_event_temporal_kind() {
        let timed = EventTime::Timed {
            start_utc_ms: 0,
            end_utc_ms: 1,
            time_zone: "UTC".into(),
        };
        let all_day = EventTime::AllDay {
            start_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            end_date_exclusive: NaiveDate::from_ymd_opt(2026, 1, 2).unwrap(),
        };
        assert!(RecurrenceRule::validated("FREQ=DAILY;UNTIL=20260103".into(), &timed).is_err());
        assert!(
            RecurrenceRule::validated("FREQ=DAILY;UNTIL=20260103T090000Z".into(), &all_day)
                .is_err()
        );
    }
}
