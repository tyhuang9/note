use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{
    App, AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::events::{NAVIGATE, WIDGET_STATUS_CHANGED};

pub(crate) const WIDGET_WINDOW_LABEL: &str = "widget";
const MAIN_WINDOW_LABEL: &str = "main";
const WIDGET_STATE_FILE: &str = "widget-state.json";
const WIDGET_STATE_VERSION: u8 = 1;
const MAX_WIDGET_STATE_BYTES: u64 = 4 * 1024;
const DESKTOP_ATTACHMENT_UNAVAILABLE: &str = "desktop_attachment_unavailable";
const WIDGET_TRAY_UNAVAILABLE: &str = "widget_tray_unavailable";

const MIN_WIDGET_WIDTH: f64 = 300.0;
const MIN_WIDGET_HEIGHT: f64 = 220.0;
const MAX_WIDGET_WIDTH: f64 = 480.0;
const MAX_WIDGET_HEIGHT: f64 = 620.0;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WidgetRequestedMode {
    #[default]
    Floating,
    Desktop,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WidgetRequestedModeRequest {
    mode: WidgetRequestedMode,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WidgetSizePreset {
    Small,
    #[default]
    Medium,
    Large,
}

impl WidgetSizePreset {
    const fn dimensions(self) -> (f64, f64) {
        match self {
            Self::Small => (320.0, 300.0),
            Self::Medium => (360.0, 420.0),
            Self::Large => (440.0, 560.0),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetStatus {
    requested_mode: WidgetRequestedMode,
    effective_mode: WidgetRequestedMode,
    visibility_requested: bool,
    visible: bool,
    locked: bool,
    size_preset: WidgetSizePreset,
    attached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_reason: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetApiError {
    code: &'static str,
    message: &'static str,
}

impl WidgetApiError {
    const fn forbidden_window() -> Self {
        Self {
            code: "forbidden_window",
            message: "This window cannot access widget controls.",
        }
    }

    const fn unavailable() -> Self {
        Self {
            code: "widget_unavailable",
            message: "The agenda widget is unavailable right now.",
        }
    }

    const fn state_unavailable() -> Self {
        Self {
            code: "widget_state_unavailable",
            message: "The agenda widget setting could not be saved.",
        }
    }

    const fn main_unavailable() -> Self {
        Self {
            code: "main_window_unavailable",
            message: "The main calendar window is unavailable right now.",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWidgetState {
    version: u8,
    size_preset: WidgetSizePreset,
    locked: bool,
    visibility_requested: bool,
    requested_mode: WidgetRequestedMode,
}

impl Default for PersistedWidgetState {
    fn default() -> Self {
        Self {
            version: WIDGET_STATE_VERSION,
            size_preset: WidgetSizePreset::default(),
            locked: false,
            visibility_requested: false,
            requested_mode: WidgetRequestedMode::default(),
        }
    }
}

impl PersistedWidgetState {
    const fn is_valid(&self) -> bool {
        self.version == WIDGET_STATE_VERSION
    }
}

pub(crate) struct WidgetState {
    path: PathBuf,
    persisted: Mutex<PersistedWidgetState>,
    runtime_error: Mutex<Option<&'static str>>,
    tray_unavailable: Mutex<bool>,
}

impl WidgetState {
    fn load(path: PathBuf) -> Self {
        Self {
            persisted: Mutex::new(read_persisted_state(&path)),
            path,
            runtime_error: Mutex::new(None),
            tray_unavailable: Mutex::new(false),
        }
    }

    fn snapshot(&self) -> PersistedWidgetState {
        self.persisted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn runtime_error(&self) -> Option<&'static str> {
        let operation_error = *self
            .runtime_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        operation_error.or_else(|| {
            (*self
                .tray_unavailable
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()))
            .then_some(WIDGET_TRAY_UNAVAILABLE)
        })
    }

    fn set_runtime_error(&self, error: Option<&'static str>) {
        *self
            .runtime_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = error;
    }

    fn set_tray_available(&self, available: bool) {
        *self
            .tray_unavailable
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = !available;
    }

    fn update(&self, change: impl FnOnce(&mut PersistedWidgetState)) -> Result<(), WidgetApiError> {
        let mut persisted = self
            .persisted
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = persisted.clone();
        change(&mut next);
        write_persisted_state(&self.path, &next)?;
        *persisted = next;
        Ok(())
    }

    fn set_visibility_requested(&self, visible: bool) -> Result<(), WidgetApiError> {
        self.update(|persisted| persisted.visibility_requested = visible)
    }

    fn set_locked(&self, locked: bool) -> Result<(), WidgetApiError> {
        self.update(|persisted| persisted.locked = locked)
    }

    fn set_size_preset(&self, size_preset: WidgetSizePreset) -> Result<(), WidgetApiError> {
        self.update(|persisted| persisted.size_preset = size_preset)
    }

    fn set_requested_mode(
        &self,
        requested_mode: WidgetRequestedMode,
    ) -> Result<(), WidgetApiError> {
        self.update(|persisted| persisted.requested_mode = requested_mode)
    }
}

pub(crate) fn initialize(app: &App) -> tauri::Result<()> {
    let _timer = crate::performance::Timer::start(crate::performance::Operation::WidgetCreation);
    let state_path = app.path().app_data_dir()?.join(WIDGET_STATE_FILE);
    app.manage(WidgetState::load(state_path));

    #[cfg(desktop)]
    {
        let state = app.state::<WidgetState>();
        state.set_tray_available(install_tray(app.handle()).is_ok());
        if state.runtime_error().is_some() {
            emit_status(app.handle(), &state);
        }
        if state.snapshot().visibility_requested {
            let _ = show_widget(app.handle(), &state);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn widget_status_get(
    window: WebviewWindow,
    state: State<'_, WidgetState>,
) -> Result<WidgetStatus, WidgetApiError> {
    ensure_widget_control_window(&window)?;
    status_for(window.app_handle(), &state)
}

#[tauri::command]
pub fn widget_show(
    window: WebviewWindow,
    state: State<'_, WidgetState>,
) -> Result<WidgetStatus, WidgetApiError> {
    ensure_widget_control_window(&window)?;
    show_widget(window.app_handle(), &state)
}

#[tauri::command]
pub fn widget_hide(
    window: WebviewWindow,
    state: State<'_, WidgetState>,
) -> Result<WidgetStatus, WidgetApiError> {
    ensure_widget_control_window(&window)?;
    hide_widget(window.app_handle(), &state)
}

#[tauri::command]
pub fn widget_toggle(
    window: WebviewWindow,
    state: State<'_, WidgetState>,
) -> Result<WidgetStatus, WidgetApiError> {
    ensure_widget_control_window(&window)?;
    if status_for(window.app_handle(), &state)?.visible {
        hide_widget(window.app_handle(), &state)
    } else {
        show_widget(window.app_handle(), &state)
    }
}

#[tauri::command]
pub fn widget_set_locked(
    window: WebviewWindow,
    state: State<'_, WidgetState>,
    locked: bool,
) -> Result<WidgetStatus, WidgetApiError> {
    ensure_widget_control_window(&window)?;
    if let Some(widget) = window.app_handle().get_webview_window(WIDGET_WINDOW_LABEL) {
        if widget.set_resizable(!locked).is_err() {
            state.set_runtime_error(Some(WidgetApiError::unavailable().code));
            emit_status(window.app_handle(), &state);
            return Err(WidgetApiError::unavailable());
        }
    }
    if let Err(error) = state.set_locked(locked) {
        state.set_runtime_error(Some(error.code));
        emit_status(window.app_handle(), &state);
        return Err(error);
    }
    state.set_runtime_error(None);
    emit_status(window.app_handle(), &state);
    status_for(window.app_handle(), &state)
}

#[tauri::command]
pub fn widget_set_size_preset(
    window: WebviewWindow,
    state: State<'_, WidgetState>,
    size_preset: WidgetSizePreset,
) -> Result<WidgetStatus, WidgetApiError> {
    ensure_widget_control_window(&window)?;
    if let Some(widget) = window.app_handle().get_webview_window(WIDGET_WINDOW_LABEL) {
        if set_widget_size(&widget, size_preset).is_err() {
            state.set_runtime_error(Some(WidgetApiError::unavailable().code));
            emit_status(window.app_handle(), &state);
            return Err(WidgetApiError::unavailable());
        }
    }
    if let Err(error) = state.set_size_preset(size_preset) {
        state.set_runtime_error(Some(error.code));
        emit_status(window.app_handle(), &state);
        return Err(error);
    }
    state.set_runtime_error(None);
    emit_status(window.app_handle(), &state);
    status_for(window.app_handle(), &state)
}

#[tauri::command]
pub fn widget_set_requested_mode(
    window: WebviewWindow,
    state: State<'_, WidgetState>,
    request: WidgetRequestedModeRequest,
) -> Result<WidgetStatus, WidgetApiError> {
    ensure_main_widget_control_window(&window)?;
    if let Err(error) = state.set_requested_mode(request.mode) {
        state.set_runtime_error(Some(error.code));
        emit_status(window.app_handle(), &state);
        return Err(error);
    }
    state.set_runtime_error(None);
    emit_status(window.app_handle(), &state);
    status_for(window.app_handle(), &state)
}

#[tauri::command]
pub fn widget_open_calendar(window: WebviewWindow) -> Result<(), WidgetApiError> {
    ensure_widget_control_window(&window)?;
    show_main_calendar(window.app_handle())
}

fn ensure_widget_control_window(window: &WebviewWindow) -> Result<(), WidgetApiError> {
    widget_control_window_label_is_allowed(window.label())
        .then_some(())
        .ok_or_else(WidgetApiError::forbidden_window)
}

fn ensure_main_widget_control_window(window: &WebviewWindow) -> Result<(), WidgetApiError> {
    main_widget_control_window_label_is_allowed(window.label())
        .then_some(())
        .ok_or_else(WidgetApiError::forbidden_window)
}

fn widget_control_window_label_is_allowed(label: &str) -> bool {
    matches!(label, MAIN_WINDOW_LABEL | WIDGET_WINDOW_LABEL)
}

fn main_widget_control_window_label_is_allowed(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

fn show_widget(app: &AppHandle, state: &WidgetState) -> Result<WidgetStatus, WidgetApiError> {
    if let Err(error) = state.set_visibility_requested(true) {
        state.set_runtime_error(Some(error.code));
        emit_status(app, state);
        return Err(error);
    }

    let result = widget_window(app, state).and_then(|widget| {
        apply_window_safety(&widget, &state.snapshot())?;
        widget
            .unminimize()
            .map_err(|_| WidgetApiError::unavailable())?;
        widget.show().map_err(|_| WidgetApiError::unavailable())?;
        widget
            .set_focus()
            .map_err(|_| WidgetApiError::unavailable())
    });
    if let Err(error) = result {
        state.set_runtime_error(Some(error.code));
        emit_status(app, state);
        return Err(error);
    }

    state.set_runtime_error(None);
    emit_status(app, state);
    status_for(app, state)
}

fn hide_widget(app: &AppHandle, state: &WidgetState) -> Result<WidgetStatus, WidgetApiError> {
    if let Err(error) = state.set_visibility_requested(false) {
        state.set_runtime_error(Some(error.code));
        emit_status(app, state);
        return Err(error);
    }

    if let Some(widget) = app.get_webview_window(WIDGET_WINDOW_LABEL) {
        if widget.hide().is_err() {
            let error = WidgetApiError::unavailable();
            state.set_runtime_error(Some(error.code));
            emit_status(app, state);
            return Err(error);
        }
    }

    state.set_runtime_error(None);
    emit_status(app, state);
    status_for(app, state)
}

fn widget_window(app: &AppHandle, state: &WidgetState) -> Result<WebviewWindow, WidgetApiError> {
    if let Some(window) = app.get_webview_window(WIDGET_WINDOW_LABEL) {
        return Ok(window);
    }

    let persisted = state.snapshot();
    let (width, height) = persisted.size_preset.dimensions();
    let window = WebviewWindowBuilder::new(
        app,
        WIDGET_WINDOW_LABEL,
        WebviewUrl::App("widget.html".into()),
    )
    .title("Note Agenda")
    .inner_size(width, height)
    .min_inner_size(MIN_WIDGET_WIDTH, MIN_WIDGET_HEIGHT)
    .max_inner_size(MAX_WIDGET_WIDTH, MAX_WIDGET_HEIGHT)
    .decorations(false)
    .resizable(!persisted.locked)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|_| WidgetApiError::unavailable())?;
    install_widget_close_handler(&window);
    Ok(window)
}

fn apply_window_safety(
    window: &WebviewWindow,
    persisted: &PersistedWidgetState,
) -> Result<(), WidgetApiError> {
    set_widget_size(window, persisted.size_preset)?;
    window
        .set_resizable(!persisted.locked)
        .map_err(|_| WidgetApiError::unavailable())?;
    window
        .set_always_on_top(true)
        .map_err(|_| WidgetApiError::unavailable())?;
    window
        .set_skip_taskbar(true)
        .map_err(|_| WidgetApiError::unavailable())
}

fn set_widget_size(
    window: &WebviewWindow,
    size_preset: WidgetSizePreset,
) -> Result<(), WidgetApiError> {
    let (width, height) = size_preset.dimensions();
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|_| WidgetApiError::unavailable())
}

fn install_widget_close_handler(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let state = app.state::<WidgetState>();
            let _ = hide_widget(&app, &state);
        }
    });
}

fn show_main_calendar(app: &AppHandle) -> Result<(), WidgetApiError> {
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(WidgetApiError::main_unavailable)?;
    main.unminimize()
        .map_err(|_| WidgetApiError::main_unavailable())?;
    main.show()
        .map_err(|_| WidgetApiError::main_unavailable())?;
    main.set_focus()
        .map_err(|_| WidgetApiError::main_unavailable())?;
    main.emit(NAVIGATE, MainCalendarNavigation::calendar())
        .map_err(|_| WidgetApiError::main_unavailable())
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct MainCalendarNavigation {
    destination: &'static str,
}

impl MainCalendarNavigation {
    const fn calendar() -> Self {
        Self {
            destination: "calendar",
        }
    }
}

fn status_for(app: &AppHandle, state: &WidgetState) -> Result<WidgetStatus, WidgetApiError> {
    let visible = match app.get_webview_window(WIDGET_WINDOW_LABEL) {
        Some(widget) => widget
            .is_visible()
            .map_err(|_| WidgetApiError::unavailable())?,
        None => false,
    };
    Ok(status_from_parts(
        &state.snapshot(),
        visible,
        state.runtime_error(),
    ))
}

fn status_from_parts(
    persisted: &PersistedWidgetState,
    visible: bool,
    error_reason: Option<&'static str>,
) -> WidgetStatus {
    let fallback_reason = (persisted.requested_mode == WidgetRequestedMode::Desktop)
        .then_some(DESKTOP_ATTACHMENT_UNAVAILABLE);
    WidgetStatus {
        requested_mode: persisted.requested_mode,
        effective_mode: WidgetRequestedMode::Floating,
        visibility_requested: persisted.visibility_requested,
        visible,
        locked: persisted.locked,
        size_preset: persisted.size_preset,
        attached: false,
        fallback_reason,
        error_reason,
    }
}

fn emit_status(app: &AppHandle, state: &WidgetState) {
    if let Ok(status) = status_for(app, state) {
        let _ = app.emit(WIDGET_STATUS_CHANGED, status);
    }
}

fn read_persisted_state(path: &Path) -> PersistedWidgetState {
    let Ok(metadata) = fs::metadata(path) else {
        return PersistedWidgetState::default();
    };
    if metadata.len() > MAX_WIDGET_STATE_BYTES {
        return PersistedWidgetState::default();
    }
    match fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PersistedWidgetState>(&bytes).ok())
    {
        Some(persisted) if persisted.is_valid() => persisted,
        _ => PersistedWidgetState::default(),
    }
}

fn write_persisted_state(path: &Path, state: &PersistedWidgetState) -> Result<(), WidgetApiError> {
    let bytes = serde_json::to_vec(state).map_err(|_| WidgetApiError::state_unavailable())?;
    if bytes.len() > usize::try_from(MAX_WIDGET_STATE_BYTES).unwrap_or(usize::MAX) {
        return Err(WidgetApiError::state_unavailable());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| WidgetApiError::state_unavailable())?;
    }
    fs::write(path, bytes).map_err(|_| WidgetApiError::state_unavailable())
}

#[cfg(desktop)]
fn install_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };

    let show_widget_item =
        MenuItem::with_id(app, "show-widget", "Show agenda widget", true, None::<&str>)?;
    let show_calendar =
        MenuItem::with_id(app, "show-calendar", "Show calendar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Note", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_widget_item, &show_calendar, &quit])?;

    let tray = TrayIconBuilder::with_id("note-widget-tray")
        .menu(&menu)
        .tooltip("Note")
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "show-widget" => {
                let state = app.state::<WidgetState>();
                let _ = show_widget(app, &state);
            }
            "show-calendar" => {
                let _ = show_main_calendar(app);
            }
            "quit" => app.exit(0),
            _ => {}
        });

    let tray = if let Some(icon) = app.default_window_icon() {
        tray.icon(icon.clone())
    } else {
        tray
    };
    tray.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn corrupt_or_oversized_widget_state_uses_safe_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(WIDGET_STATE_FILE);
        fs::write(&path, b"not-json").unwrap();
        assert_eq!(
            read_persisted_state(&path).size_preset,
            WidgetSizePreset::Medium
        );

        fs::write(&path, vec![b'x'; (MAX_WIDGET_STATE_BYTES + 1) as usize]).unwrap();
        let restored = read_persisted_state(&path);
        assert!(!restored.locked);
        assert!(!restored.visibility_requested);
        assert_eq!(restored.requested_mode, WidgetRequestedMode::Floating);
    }

    #[test]
    fn state_round_trip_only_persists_bounded_controls() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(WIDGET_STATE_FILE);
        let state = WidgetState::load(path.clone());
        state.set_locked(true).unwrap();
        state.set_size_preset(WidgetSizePreset::Large).unwrap();
        state.set_visibility_requested(true).unwrap();
        state
            .set_requested_mode(WidgetRequestedMode::Desktop)
            .unwrap();

        let saved: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["version"], WIDGET_STATE_VERSION);
        assert_eq!(saved["sizePreset"], "large");
        assert_eq!(saved["locked"], true);
        assert_eq!(saved["visibilityRequested"], true);
        assert_eq!(saved["requestedMode"], "desktop");
        assert_eq!(saved.as_object().unwrap().len(), 5);

        let restored = read_persisted_state(&path);
        assert_eq!(restored.requested_mode, WidgetRequestedMode::Desktop);
        let status = status_from_parts(&restored, false, None);
        assert_eq!(status.effective_mode, WidgetRequestedMode::Floating);
        assert!(!status.attached);
        assert_eq!(status.fallback_reason, Some(DESKTOP_ATTACHMENT_UNAVAILABLE));
    }

    #[test]
    fn desktop_request_is_always_reported_as_unattached_floating_fallback() {
        let persisted = PersistedWidgetState {
            requested_mode: WidgetRequestedMode::Desktop,
            ..PersistedWidgetState::default()
        };
        let status = status_from_parts(&persisted, true, None);

        assert_eq!(status.requested_mode, WidgetRequestedMode::Desktop);
        assert_eq!(status.effective_mode, WidgetRequestedMode::Floating);
        assert!(status.visible);
        assert!(!status.attached);
        assert_eq!(status.fallback_reason, Some(DESKTOP_ATTACHMENT_UNAVAILABLE));
    }

    #[test]
    fn widget_controls_are_limited_to_main_and_widget_labels() {
        assert!(widget_control_window_label_is_allowed("main"));
        assert!(widget_control_window_label_is_allowed("widget"));
        for label in ["quick-command", "event-editor", "Main", "widget-2", ""] {
            assert!(!widget_control_window_label_is_allowed(label));
        }
    }

    #[test]
    fn requested_mode_control_is_limited_to_the_main_label() {
        assert!(main_widget_control_window_label_is_allowed("main"));
        for label in [
            "widget",
            "quick-command",
            "event-editor",
            "Main",
            "widget-2",
            "",
        ] {
            assert!(!main_widget_control_window_label_is_allowed(label));
        }
    }

    #[test]
    fn requested_mode_request_only_accepts_the_bounded_mode_field() {
        for (source, expected) in [
            (
                serde_json::json!({ "mode": "floating" }),
                WidgetRequestedMode::Floating,
            ),
            (
                serde_json::json!({ "mode": "desktop" }),
                WidgetRequestedMode::Desktop,
            ),
        ] {
            let request: WidgetRequestedModeRequest = serde_json::from_value(source).unwrap();
            assert_eq!(request.mode, expected);
        }
        for source in [
            serde_json::json!({ "mode": "attached" }),
            serde_json::json!({ "mode": "desktop", "attached": true }),
            serde_json::json!({}),
        ] {
            assert!(serde_json::from_value::<WidgetRequestedModeRequest>(source).is_err());
        }
    }

    #[test]
    fn tray_failure_is_sanitized_and_does_not_block_widget_state_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let state = WidgetState::load(directory.path().join(WIDGET_STATE_FILE));

        state.set_tray_available(false);
        assert_eq!(state.runtime_error(), Some(WIDGET_TRAY_UNAVAILABLE));
        state.set_visibility_requested(true).unwrap();
        state.set_runtime_error(None);
        assert_eq!(state.runtime_error(), Some(WIDGET_TRAY_UNAVAILABLE));
        let status = status_from_parts(&state.snapshot(), false, state.runtime_error());
        assert_eq!(status.error_reason, Some(WIDGET_TRAY_UNAVAILABLE));
        assert_eq!(status.effective_mode, WidgetRequestedMode::Floating);
        assert!(!status.attached);
        let serialized = serde_json::to_value(status).unwrap();
        assert_eq!(serialized["errorReason"], WIDGET_TRAY_UNAVAILABLE);
        assert_eq!(serialized.as_object().unwrap().len(), 8);

        state.set_tray_available(true);
        assert_eq!(state.runtime_error(), None);
        assert!(state.snapshot().visibility_requested);
    }

    #[test]
    fn status_is_sanitized_and_never_claims_attachment() {
        let status = status_from_parts(&PersistedWidgetState::default(), false, None);
        let serialized = serde_json::to_value(status).unwrap();

        assert_eq!(serialized["effectiveMode"], "floating");
        assert_eq!(serialized["attached"], false);
        assert!(serialized.get("fallbackReason").is_none());
        assert!(serialized.get("errorReason").is_none());
    }

    #[test]
    fn capability_only_exposes_bounded_widget_shell_commands_and_widget_agenda() {
        let widget: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/widget.json")).unwrap();
        let permissions = widget["permissions"].as_array().unwrap();
        let permissions = permissions
            .iter()
            .map(|permission| permission.as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        let allowed_shell_commands = [
            "allow-widget-status-get",
            "allow-widget-show",
            "allow-widget-hide",
            "allow-widget-toggle",
            "allow-widget-set-locked",
            "allow-widget-set-size-preset",
            "allow-widget-open-calendar",
        ];

        for permission in allowed_shell_commands {
            assert!(permissions.contains(permission));
        }
        assert!(!permissions.contains("allow-widget-set-requested-mode"));
        let calendar_permissions = permissions
            .iter()
            .filter(|permission| permission.starts_with("allow-calendar-"))
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(calendar_permissions, ["allow-calendar-widget-agenda"]);
        assert!(!permissions.iter().any(|permission| {
            permission.starts_with("allow-notification-")
                || permission.starts_with("allow-models-ai-")
                || permission.starts_with("allow-voice-")
                || permission == &"allow-load-app-data"
                || permission == &"allow-save-app-data"
        }));
    }

    #[test]
    fn widget_commands_are_registered_in_the_tauri_app_manifest() {
        let manifest = include_str!("../build.rs");
        for command in [
            "widget_status_get",
            "widget_show",
            "widget_hide",
            "widget_toggle",
            "widget_set_locked",
            "widget_set_size_preset",
            "widget_set_requested_mode",
            "widget_open_calendar",
        ] {
            assert!(manifest.contains(&format!("\"{command}\"")));
        }
    }
}
