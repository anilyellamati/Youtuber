//! Stand-ins for the YouTube commands in builds without the `youtube` feature
//! (StreamForge Lite), so the command table stays the same.

const MSG: &str = "YouTube publishing is not included in this edition";

#[tauri::command]
pub async fn yt_login(client_id: Option<String>, client_secret: Option<String>) -> Result<(), String> {
    let _ = (client_id, client_secret);
    Err(MSG.into())
}

#[tauri::command]
pub async fn yt_status() -> Result<Option<()>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn yt_logout() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn yt_upload(
    id: String,
    path: String,
    metadata: serde_json::Value,
    thumbnail: Option<String>,
    notify: Option<bool>,
) -> Result<String, String> {
    let _ = (id, path, metadata, thumbnail, notify);
    Err(MSG.into())
}
