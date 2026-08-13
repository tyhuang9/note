fn main() {
    #[cfg(target_os = "windows")]
    embed_common_controls_manifest();

    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "load_app_data",
        "save_app_data",
        "calendar_list_events",
        "calendar_widget_agenda",
        "calendar_agenda_page",
        "calendar_search",
        "calendar_get_event",
        "calendar_create_event",
        "calendar_update_event",
        "calendar_delete_event",
        "calendar_update_occurrence",
        "calendar_delete_occurrence",
        "calendar_get_settings",
        "calendar_update_settings",
        "calendar_readiness_get",
        "calendar_retry_initialization",
        "notification_status_get",
        "notification_permission_request",
        "import_ics_preview",
        "import_ics_commit",
        "export_ics",
        "backup_create",
        "backup_restore_preview",
        "backup_restore_commit",
        "cal_import_preview",
        "cal_import_commit",
        "unified_backup_create",
        "unified_backup_restore_preview",
        "unified_backup_restore_commit",
        "assistant_calendar_tool_execute",
        "assistant_calendar_create_propose",
        "assistant_calendar_create_revise",
        "assistant_calendar_create_confirm",
        "assistant_calendar_create_cancel",
        "assistant_calendar_create_reconciliation_status",
        "assistant_calendar_create_reconciliation_acknowledge",
        "models_ai_state_get",
        "models_ai_settings_save",
        "models_ai_migrate_legacy",
        "models_ai_credential_set",
        "models_ai_credential_delete",
        "models_ai_provider_test",
        "models_ai_provider_list_models",
        "models_ai_chat",
        "models_ai_ollama_status",
        "models_ai_ollama_pull",
        "models_ai_ollama_cancel_pull",
        "models_ai_ollama_remove",
        "voice_status_get",
        "voice_quick_command_ready",
        "voice_capture_start",
        "voice_capture_stop",
        "voice_capture_cancel",
        "voice_typed_proposal",
        "voice_proposal_submit",
        "voice_config_get",
        "voice_microphones_get",
        "voice_microphone_select",
        "voice_shortcuts_status_get",
        "voice_shortcuts_register",
        "voice_model_status",
        "voice_model_install",
        "voice_model_cancel_install",
        "voice_model_remove",
        "widget_status_get",
        "widget_show",
        "widget_hide",
        "widget_toggle",
        "widget_set_locked",
        "widget_set_size_preset",
        "widget_set_requested_mode",
        "widget_open_calendar",
    ]);

    #[cfg(target_os = "windows")]
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
        .app_manifest(app_manifest);
    #[cfg(not(target_os = "windows"))]
    let attributes = tauri_build::Attributes::new().app_manifest(app_manifest);

    tauri_build::try_build(attributes).expect("failed to build Tauri application metadata");
}

#[cfg(target_os = "windows")]
fn embed_common_controls_manifest() {
    let manifest_path = std::path::PathBuf::from(
        std::env::var("OUT_DIR").expect("Cargo must provide OUT_DIR to build scripts"),
    )
    .join("note-common-controls.manifest");
    std::fs::write(
        &manifest_path,
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>"#,
    )
    .expect("failed to write the Common Controls test manifest");
    println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
}
