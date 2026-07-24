fn main() {
    let app_manifest =
        tauri_build::AppManifest::new().commands(&["load_app_data", "save_app_data"]);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to build Tauri application metadata");
}
