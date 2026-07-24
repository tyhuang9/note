use std::sync::Arc;

use crate::calendar_store::SettingsRepository;
use serde::{Deserialize, Serialize};

use super::{
    domain::MAX_REMINDER_LEAD_MINUTES,
    error::{DomainError, StoreError},
};

const DEFAULT_EVENT_DURATION_MINUTES_FIELD: &str = "defaultEventDurationMinutes";
const WEEK_STARTS_ON_FIELD: &str = "weekStartsOn";
const TIME_FORMAT_FIELD: &str = "timeFormat";
const DEFAULT_REMINDER_MINUTES_FIELD: &str = "defaultReminderMinutes";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WeekStartsOn {
    Monday,
    Sunday,
}

impl WeekStartsOn {
    fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "monday" => Ok(Self::Monday),
            "sunday" => Ok(Self::Sunday),
            _ => Err(DomainError::InvalidSetting {
                field: WEEK_STARTS_ON_FIELD,
            }),
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Monday => "monday",
            Self::Sunday => "sunday",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum TimeFormat {
    #[serde(rename = "system")]
    System,
    #[serde(rename = "12h")]
    TwelveHour,
    #[serde(rename = "24h")]
    TwentyFourHour,
}

impl TimeFormat {
    fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "system" => Ok(Self::System),
            "12h" => Ok(Self::TwelveHour),
            "24h" => Ok(Self::TwentyFourHour),
            _ => Err(DomainError::InvalidSetting {
                field: TIME_FORMAT_FIELD,
            }),
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::TwelveHour => "12h",
            Self::TwentyFourHour => "24h",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSettings {
    pub default_event_duration_minutes: i64,
    pub week_starts_on: WeekStartsOn,
    pub time_format: TimeFormat,
    pub default_reminder_minutes: Option<i64>,
}

impl CalendarSettings {
    pub(crate) fn from_persisted(
        default_event_duration_minutes: i64,
        week_starts_on: &str,
        time_format: &str,
        default_reminder_minutes: Option<i64>,
    ) -> Result<Self, StoreError> {
        validate_duration(default_event_duration_minutes).map_err(|_| StoreError::InvalidData)?;
        let week_starts_on =
            WeekStartsOn::parse(week_starts_on).map_err(|_| StoreError::InvalidData)?;
        let time_format = TimeFormat::parse(time_format).map_err(|_| StoreError::InvalidData)?;
        validate_default_reminder(default_reminder_minutes).map_err(|_| StoreError::InvalidData)?;
        Ok(Self {
            default_event_duration_minutes,
            week_starts_on,
            time_format,
            default_reminder_minutes,
        })
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CalendarSettingsPatch {
    default_event_duration_minutes: Option<i64>,
    week_starts_on: Option<WeekStartsOn>,
    time_format: Option<TimeFormat>,
    default_reminder_minutes: Option<Option<i64>>,
}

impl CalendarSettingsPatch {
    pub(crate) fn validated(request: SettingsPatchRequest) -> Result<Self, DomainError> {
        Self::validated_values_with_reminder(
            request.default_event_duration_minutes,
            request.week_starts_on.as_deref(),
            request.time_format.as_deref(),
            request.default_reminder_minutes,
        )
    }

    #[cfg(test)]
    pub(crate) fn validated_values(
        default_event_duration_minutes: Option<i64>,
        week_starts_on: Option<&str>,
        time_format: Option<&str>,
    ) -> Result<Self, DomainError> {
        Self::validated_values_with_reminder(
            default_event_duration_minutes,
            week_starts_on,
            time_format,
            None,
        )
    }

    pub(crate) fn validated_values_with_reminder(
        default_event_duration_minutes: Option<i64>,
        week_starts_on: Option<&str>,
        time_format: Option<&str>,
        default_reminder_minutes: Option<Option<i64>>,
    ) -> Result<Self, DomainError> {
        if let Some(value) = default_event_duration_minutes {
            validate_duration(value)?;
        }

        let week_starts_on = week_starts_on.map(WeekStartsOn::parse).transpose()?;
        let time_format = time_format.map(TimeFormat::parse).transpose()?;
        if let Some(value) = default_reminder_minutes {
            validate_default_reminder(value)?;
        }

        Ok(Self {
            default_event_duration_minutes,
            week_starts_on,
            time_format,
            default_reminder_minutes,
        })
    }

    pub(crate) const fn is_empty(&self) -> bool {
        self.default_event_duration_minutes.is_none()
            && self.week_starts_on.is_none()
            && self.time_format.is_none()
            && self.default_reminder_minutes.is_none()
    }

    pub(crate) const fn default_event_duration_minutes(&self) -> Option<i64> {
        self.default_event_duration_minutes
    }

    pub(crate) fn week_starts_on(&self) -> Option<&'static str> {
        self.week_starts_on.map(WeekStartsOn::as_str)
    }

    pub(crate) fn time_format(&self) -> Option<&'static str> {
        self.time_format.map(TimeFormat::as_str)
    }

    pub(crate) const fn default_reminder_minutes(&self) -> Option<Option<i64>> {
        self.default_reminder_minutes
    }
}

fn validate_duration(value: i64) -> Result<(), DomainError> {
    if (15..=480).contains(&value) && value % 5 == 0 {
        Ok(())
    } else {
        Err(DomainError::InvalidSetting {
            field: DEFAULT_EVENT_DURATION_MINUTES_FIELD,
        })
    }
}

fn validate_default_reminder(value: Option<i64>) -> Result<(), DomainError> {
    if value.is_none_or(|minutes| (0..=MAX_REMINDER_LEAD_MINUTES).contains(&minutes)) {
        Ok(())
    } else {
        Err(DomainError::InvalidSetting {
            field: DEFAULT_REMINDER_MINUTES_FIELD,
        })
    }
}

#[derive(Clone)]
pub struct SettingsService {
    repository: Arc<dyn SettingsRepository>,
}

impl SettingsService {
    pub fn new(repository: Arc<dyn SettingsRepository>) -> Self {
        Self { repository }
    }

    pub(crate) async fn get(&self) -> Result<CalendarSettings, StoreError> {
        self.repository.get_settings().await
    }

    pub(crate) async fn update(
        &self,
        patch: CalendarSettingsPatch,
    ) -> Result<CalendarSettings, StoreError> {
        self.repository.update_settings(patch).await
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatchRequest {
    default_event_duration_minutes: Option<i64>,
    week_starts_on: Option<String>,
    time_format: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_reminder")]
    default_reminder_minutes: Option<Option<i64>>,
}

fn deserialize_nullable_reminder<'de, D>(deserializer: D) -> Result<Option<Option<i64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<i64>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsUpdateRequest {
    patch: SettingsPatchRequest,
}

impl SettingsUpdateRequest {
    pub(crate) fn into_patch(self) -> Result<CalendarSettingsPatch, DomainError> {
        CalendarSettingsPatch::validated(self.patch)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::calendar::error::ApiError;

    #[test]
    fn update_request_accepts_camel_case_partial_and_empty_patches() {
        let partial: SettingsUpdateRequest = serde_json::from_value(json!({
            "patch": {
                "defaultEventDurationMinutes": 45,
                "weekStartsOn": "sunday"
            }
        }))
        .unwrap();
        let partial = CalendarSettingsPatch::validated(partial.patch).unwrap();
        assert_eq!(partial.default_event_duration_minutes(), Some(45));
        assert_eq!(partial.week_starts_on(), Some("sunday"));
        assert_eq!(partial.time_format(), None);

        let empty: SettingsUpdateRequest = serde_json::from_value(json!({ "patch": {} })).unwrap();
        assert!(CalendarSettingsPatch::validated(empty.patch)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn update_request_denies_unknown_fields_at_each_level() {
        assert!(serde_json::from_value::<SettingsUpdateRequest>(json!({
            "patch": {},
            "shortcut": "Ctrl+Space"
        }))
        .is_err());
        assert!(serde_json::from_value::<SettingsUpdateRequest>(json!({
            "patch": { "reminderMinutes": 10 }
        }))
        .is_err());
    }

    #[test]
    fn patch_validation_reports_exact_safe_fields() {
        for (patch, field) in [
            (
                json!({ "defaultEventDurationMinutes": 14 }),
                DEFAULT_EVENT_DURATION_MINUTES_FIELD,
            ),
            (
                json!({ "defaultEventDurationMinutes": 17 }),
                DEFAULT_EVENT_DURATION_MINUTES_FIELD,
            ),
            (json!({ "weekStartsOn": "saturday" }), WEEK_STARTS_ON_FIELD),
            (json!({ "timeFormat": "locale" }), TIME_FORMAT_FIELD),
        ] {
            let request: SettingsPatchRequest = serde_json::from_value(patch).unwrap();
            let error = CalendarSettingsPatch::validated(request).unwrap_err();
            assert_eq!(
                ApiError::from(error),
                ApiError {
                    code: "invalid_setting",
                    message: "Choose a valid value for this setting.",
                    field: Some(field),
                }
            );
        }

        for duration in [15, 60, 480] {
            assert!(CalendarSettingsPatch::validated_values(Some(duration), None, None).is_ok());
        }
        for duration in [10, 17, 485] {
            assert_eq!(
                CalendarSettingsPatch::validated_values(Some(duration), None, None).unwrap_err(),
                DomainError::InvalidSetting {
                    field: DEFAULT_EVENT_DURATION_MINUTES_FIELD,
                }
            );
        }
    }

    #[test]
    fn canonical_response_uses_frozen_camel_case_contract() {
        let response = CalendarSettings::from_persisted(60, "monday", "system", None).unwrap();
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "defaultEventDurationMinutes": 60,
                "weekStartsOn": "monday",
                "timeFormat": "system"
                ,"defaultReminderMinutes": null
            })
        );
        assert_eq!(
            ApiError::from(StoreError::InvalidData),
            ApiError {
                code: "storage_unavailable",
                message: "Calendar storage is temporarily unavailable.",
                field: None,
            }
        );
    }
}
