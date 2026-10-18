use std::io::Write;
use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request};

/// `~/Videos/StreamForge` (or `~/Movies/StreamForge` on macOS); created on demand.
#[tauri::command]
pub fn default_output_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let base = dirs::video_dir()
        .or_else(|| app.path().video_dir().ok())
        .or_else(|| app.path().app_data_dir().ok())
        .ok_or("no writable folder")?;
    let dir = base.join("StreamForge");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Appends a raw binary chunk to a file. The path travels in the `x-path` header and
/// `x-truncate: 1` starts a fresh file. Raw IPC bodies avoid JSON-encoding video bytes,
/// which matters a lot on low-spec machines.
#[tauri::command]
pub fn save_chunk(request: Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = PathBuf::from(urlencoding_decode(path));
    let truncate = request.headers().get("x-truncate").map(|v| v == "1").unwrap_or(false);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw binary body".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open")
        .arg(p.parent().unwrap_or(&p))
        .spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

fn urlencoding_decode(s: &str) -> String {
    url::form_urlencoded::parse(format!("p={s}").as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| s.to_string())
}

#[derive(serde::Serialize)]
pub struct VideoFile {
    name: String,
    path: String,
    size: u64,
    modified: u64,
}

/// Lists video files in a folder, newest first (the recordings library).
#[tauri::command]
pub fn list_videos(dir: String) -> Result<Vec<VideoFile>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if !["mp4", "mkv", "webm", "mov"].contains(&ext.as_str()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() == 0 {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(VideoFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            modified,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Removes intermediate files StreamForge created (recording segments, masks).
/// Only files whose names carry StreamForge's temp markers are touched.
#[tauri::command]
pub fn delete_temp_files(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        let name = PathBuf::from(&p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let is_temp = name.starts_with(".mask_")
            || name.starts_with(".ring_")
            || name.starts_with(".text_")
            || name.contains(".part")
            || name.ends_with(".concat.txt");
        if is_temp {
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(())
}
