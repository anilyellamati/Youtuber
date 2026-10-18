//! Local media server for the webview. WebKit (macOS) is unreliable at streaming
//! video from custom URL schemes into <video> + canvas, so media files are served
//! over http://127.0.0.1 with Range support. A random per-launch token in the URL
//! keeps other local web pages from reading files through it.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;

static BASE: OnceLock<String> = OnceLock::new();

pub fn start() {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let mut buf = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut buf);
    let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    let _ = BASE.set(format!("http://127.0.0.1:{}/{}", addr.port(), token));
    #[cfg(debug_assertions)]
    eprintln!("media server: {}", BASE.get().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let token = token.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, &token);
            });
        }
    });
}

/// Base URL; the UI requests `{base}/f?p=<url-encoded absolute path>`.
#[tauri::command]
pub fn media_base() -> Option<String> {
    BASE.get().cloned()
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

fn handle(mut stream: TcpStream, token: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut range: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length\r\n";

    if method == "OPTIONS" {
        stream.write_all(format!("HTTP/1.1 204 No Content\r\n{cors}Access-Control-Allow-Headers: Range\r\nConnection: close\r\n\r\n").as_bytes())?;
        return Ok(());
    }
    let url = url::Url::parse(&format!("http://x{target}")).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let path = url.query_pairs().find(|(k, _)| k == "p").map(|(_, v)| v.into_owned());
    let ok_token = url.path() == format!("/{token}/f");
    let Some(path) = path.filter(|_| ok_token) else {
        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return Ok(());
    };
    let Ok(mut file) = File::open(&path) else {
        stream.write_all(format!("HTTP/1.1 404 Not Found\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())?;
        return Ok(());
    };
    let size = file.metadata()?.len();
    let (start, end, partial) = match range.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
        Some(spec) => {
            let (a, b) = spec.split_once('-').unwrap_or((spec, ""));
            let start: u64 = a.parse().unwrap_or(0);
            let end: u64 = b.parse().unwrap_or(size.saturating_sub(1)).min(size.saturating_sub(1));
            (start.min(size), end, true)
        }
        None => (0, size.saturating_sub(1), false),
    };
    let len = if size == 0 { 0 } else { end + 1 - start };
    let status = if partial { "206 Partial Content" } else { "200 OK" };
    let content_range = if partial { format!("Content-Range: bytes {start}-{end}/{size}\r\n") } else { String::new() };
    stream.write_all(
        format!(
            "HTTP/1.1 {status}\r\n{cors}Content-Type: {}\r\nAccept-Ranges: bytes\r\n{content_range}Content-Length: {len}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            mime(&path)
        )
        .as_bytes(),
    )?;
    if method == "HEAD" || len == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = len;
    let mut chunk = vec![0u8; 256 * 1024];
    while remaining > 0 {
        let want = remaining.min(chunk.len() as u64) as usize;
        let n = file.read(&mut chunk[..want])?;
        if n == 0 {
            break;
        }
        stream.write_all(&chunk[..n])?; // the player closing early just ends the loop
        remaining -= n as u64;
    }
    Ok(())
}

/// Grabs a downscaled still of a display for the recorder preview (native engine).
/// `display` is 1-based. Also triggers the macOS Screen Recording permission prompt.
#[tauri::command]
pub async fn screen_snapshot(app: tauri::AppHandle, display: u32) -> Result<String, String> {
    let out = std::env::temp_dir().join(format!("streamforge_preview_{display}.jpg"));
    let out_s = out.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    {
        let _ = &app;
        let mut child = tokio::process::Command::new("screencapture")
            .args(["-x", "-t", "jpg", "-D", &display.to_string(), &out_s])
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let ok = match tokio::time::timeout(std::time::Duration::from_secs(4), child.wait()).await {
            Ok(Ok(status)) => status.success(),
            _ => false, // hung (e.g. no permission): dropping the child kills it
        };
        if !ok {
            return Err("screencapture failed".into());
        }
        let _ = tokio::process::Command::new("sips").args(["-Z", "1280", &out_s]).output().await;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let ffmpeg = crate::ffmpeg::ffmpeg_path(&app);
        let mut cmd = tokio::process::Command::new(ffmpeg);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let input: Vec<&str> = if cfg!(windows) { vec!["-f", "gdigrab", "-i", "desktop"] } else { vec!["-f", "x11grab", "-i", ":0.0"] };
        let ok = cmd
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args(&input)
            .args(["-frames:v", "1", "-vf", "scale=1280:-2", &out_s])
            .status()
            .await
            .map_err(|e| e.to_string())?
            .success();
        if !ok {
            return Err("screen grab failed".into());
        }
    }
    Ok(out_s)
}
