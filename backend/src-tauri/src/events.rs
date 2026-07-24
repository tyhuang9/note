pub const NOTE_DATA_CHANGED: &str = "note://note-data-changed";
pub const CALENDAR_CHANGED: &str = "note://calendar-changed";
pub const REMINDER_STATUS_CHANGED: &str = "note://reminder-status-changed";
pub const WIDGET_STATUS_CHANGED: &str = "note://widget-status-changed";
pub const VOICE_LIFECYCLE_RESET: &str = "note://voice-lifecycle-reset";
pub const NAVIGATE: &str = "note://navigate";
pub const MODEL_PROGRESS: &str = "note://model-progress";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_events_use_the_note_namespace() {
        for event in [
            NOTE_DATA_CHANGED,
            CALENDAR_CHANGED,
            REMINDER_STATUS_CHANGED,
            WIDGET_STATUS_CHANGED,
            VOICE_LIFECYCLE_RESET,
            NAVIGATE,
            MODEL_PROGRESS,
        ] {
            assert!(event.starts_with("note://"));
            assert!(!event.starts_with("cal://"));
        }
    }
}
