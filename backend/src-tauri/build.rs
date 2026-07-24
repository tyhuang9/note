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
