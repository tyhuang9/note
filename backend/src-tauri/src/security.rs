// Tauri does not expose a supported cross-platform native WebView media-permission
// denial hook. This early, non-configurable shim is defense in depth until native
// voice replaces renderer capture; it is not treated as an OS permission boundary.
pub(crate) const BROWSER_MEDIA_CAPTURE_DEFENSE_IN_DEPTH_SCRIPT: &str = r#"
(() => {
  const deny = () => Promise.reject(new DOMException(
    "Browser media capture is unavailable. Use Note's native voice service.",
    "NotAllowedError",
  ));
  const targets = [globalThis.MediaDevices?.prototype, navigator.mediaDevices]
    .filter(Boolean);
  for (const target of targets) {
    for (const method of ["getUserMedia", "getDisplayMedia"]) {
      if (method in target) {
        try {
          Object.defineProperty(target, method, {
            configurable: false,
            enumerable: false,
            value: deny,
            writable: false,
          });
        } catch {
          // A successful definition on either the prototype or instance is sufficient.
        }
      }
    }
  }
})();
"#;

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::Value;

    use super::*;

    const CONFIG: &str = include_str!("../tauri.conf.json");
    const MAIN_CAPABILITY: &str = include_str!("../capabilities/main.json");
    const WIDGET_CAPABILITY: &str = include_str!("../capabilities/widget.json");
    const QUICK_COMMAND_CAPABILITY: &str = include_str!("../capabilities/quick-command.json");
    const EVENT_EDITOR_CAPABILITY: &str = include_str!("../capabilities/event-editor.json");

    #[test]
    fn initialization_script_is_only_a_media_capture_defense_in_depth() {
        assert!(BROWSER_MEDIA_CAPTURE_DEFENSE_IN_DEPTH_SCRIPT.contains("getUserMedia"));
        assert!(BROWSER_MEDIA_CAPTURE_DEFENSE_IN_DEPTH_SCRIPT.contains("getDisplayMedia"));
        assert!(BROWSER_MEDIA_CAPTURE_DEFENSE_IN_DEPTH_SCRIPT.contains("NotAllowedError"));
        assert!(BROWSER_MEDIA_CAPTURE_DEFENSE_IN_DEPTH_SCRIPT.contains("configurable: false"));
    }

    #[test]
    fn capabilities_use_exact_labels_and_exclude_renderer_event_emission() {
        let expected = [
            (
                "main",
                MAIN_CAPABILITY,
                [
                    "allow-calendar-agenda-page",
                    "allow-calendar-create-event",
                    "allow-calendar-delete-event",
                    "allow-calendar-delete-occurrence",
                    "allow-calendar-get-event",
                    "allow-calendar-get-settings",
                    "allow-calendar-list-events",
                    "allow-calendar-readiness-get",
                    "allow-calendar-retry-initialization",
                    "allow-calendar-search",
                    "allow-calendar-update-event",
                    "allow-calendar-update-occurrence",
                    "allow-calendar-update-settings",
                    "allow-notification-status-get",
                    "allow-notification-permission-request",
                    "allow-import-ics-preview",
                    "allow-import-ics-commit",
                    "allow-export-ics",
                    "allow-backup-create",
                    "allow-backup-restore-preview",
                    "allow-backup-restore-commit",
                    "allow-assistant-calendar-tool-execute",
                    "allow-assistant-calendar-create-propose",
                    "allow-assistant-calendar-create-revise",
                    "allow-assistant-calendar-create-confirm",
                    "allow-assistant-calendar-create-cancel",
                    "allow-assistant-calendar-create-reconciliation-status",
                    "allow-assistant-calendar-create-reconciliation-acknowledge",
                    "allow-models-ai-state-get",
                    "allow-models-ai-settings-save",
                    "allow-models-ai-migrate-legacy",
                    "allow-models-ai-credential-set",
                    "allow-models-ai-credential-delete",
                    "allow-models-ai-provider-test",
                    "allow-models-ai-provider-list-models",
                    "allow-models-ai-chat",
                    "allow-models-ai-ollama-status",
                    "allow-models-ai-ollama-pull",
                    "allow-models-ai-ollama-cancel-pull",
                    "allow-models-ai-ollama-remove",
                    "allow-voice-config-get",
                    "allow-voice-microphones-get",
                    "allow-voice-microphone-select",
                    "allow-voice-shortcuts-status-get",
                    "allow-voice-shortcuts-register",
                    "allow-voice-model-status",
                    "allow-voice-model-install",
                    "allow-voice-model-cancel-install",
                    "allow-voice-model-remove",
                    "allow-widget-status-get",
                    "allow-widget-show",
                    "allow-widget-hide",
                    "allow-widget-toggle",
                    "allow-widget-set-locked",
                    "allow-widget-set-size-preset",
                    "allow-widget-set-requested-mode",
                    "allow-widget-open-calendar",
                    "allow-load-app-data",
                    "allow-save-app-data",
                    "core:event:allow-listen",
                    "core:event:allow-unlisten",
                ]
                .as_slice(),
            ),
            (
                "widget",
                WIDGET_CAPABILITY,
                [
                    "allow-calendar-widget-agenda",
                    "allow-widget-status-get",
                    "allow-widget-show",
                    "allow-widget-hide",
                    "allow-widget-toggle",
                    "allow-widget-set-locked",
                    "allow-widget-set-size-preset",
                    "allow-widget-open-calendar",
                    "core:event:allow-listen",
                    "core:event:allow-unlisten",
                ]
                .as_slice(),
            ),
            (
                "quick-command",
                QUICK_COMMAND_CAPABILITY,
                [
                    "allow-voice-status-get",
                    "allow-voice-quick-command-ready",
                    "allow-voice-capture-start",
                    "allow-voice-capture-stop",
                    "allow-voice-capture-cancel",
                    "allow-voice-typed-proposal",
                    "allow-voice-proposal-submit",
                    "core:event:allow-listen",
                    "core:event:allow-unlisten",
                ]
                .as_slice(),
            ),
            (
                "event-editor",
                EVENT_EDITOR_CAPABILITY,
                ["core:event:allow-listen", "core:event:allow-unlisten"].as_slice(),
            ),
        ];

        for (label, source, expected_permissions) in expected {
            let capability: Value = serde_json::from_str(source).unwrap();
            assert_eq!(capability["identifier"], label);
            assert_eq!(capability["windows"], serde_json::json!([label]));
            assert!(!label.contains(['*', '?', '[', ']']));

            let permissions = capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|permission| permission.as_str().unwrap())
                .collect::<BTreeSet<_>>();
            assert_eq!(
                permissions,
                expected_permissions
                    .iter()
                    .copied()
                    .collect::<BTreeSet<_>>()
            );
            assert!(!permissions.contains("core:default"));
            assert!(!permissions.contains("core:event:allow-emit"));
            assert!(!permissions.contains("core:event:allow-emit-to"));
        }
    }

    #[test]
    fn requested_mode_permission_is_main_only() {
        let permissions = |source: &str| {
            let capability: Value = serde_json::from_str(source).unwrap();
            capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|permission| permission.as_str().unwrap().to_owned())
                .collect::<BTreeSet<_>>()
        };

        assert!(permissions(MAIN_CAPABILITY).contains("allow-widget-set-requested-mode"));
        assert!(!permissions(WIDGET_CAPABILITY).contains("allow-widget-set-requested-mode"));
    }

    #[test]
    fn widget_is_dynamic_while_other_auxiliary_windows_remain_non_created() {
        let config: Value = serde_json::from_str(CONFIG).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0]["label"], "main");
        assert_eq!(windows[0]["url"], "index.html");

        assert!(!windows.iter().any(|window| window["label"] == "widget"));
        for (label, url) in [
            ("quick-command", "quick-command.html"),
            ("event-editor", "event-editor.html"),
        ] {
            let window = windows
                .iter()
                .find(|window| window["label"] == label)
                .unwrap();
            assert_eq!(window["url"], url);
            assert_eq!(window["create"], false);
            assert_eq!(window["visible"], false);
        }

        assert_eq!(
            config["app"]["security"]["capabilities"],
            serde_json::json!(["main", "widget", "quick-command", "event-editor"])
        );
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        assert!(csp.contains("connect-src"));
        assert!(csp.contains("https:"));
        assert!(csp.contains("http://127.0.0.1:*"));
        assert!(csp.contains("http://localhost:*"));
        assert!(csp.contains("media-src 'none'"));
    }
}
