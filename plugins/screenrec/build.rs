const COMMANDS: &[&str] = &["start", "stop", "status"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
