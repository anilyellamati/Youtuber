//! FFmpeg process management: the native capture + export engine.
//!
//! FFmpeg does desktop capture (ddagrab / gdigrab on Windows, AVFoundation on macOS),
//! composites the facecam in its filter graph and encodes on the GPU when available
//! (NVENC / QuickSync / AMF / VideoToolbox / Media Foundation). The UI builds the
//! argument list; this module only spawns, streams progress, and stops jobs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Jobs(Arc<Mutex<HashMap<String, Job>>>);

struct Job {
    stdin: Option<ChildStdin>,
    pid: Option<u32>,
}

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    out_time_ms: i64,
    fps: f64,
    speed: String,
    frame: i64,
}

#[derive(Serialize, Clone)]
struct Exit {
    id: String,
    code: Option<i32>,
    log: String,
}

#[derive(Serialize)]
pub struct FfmpegInfo {
    path: String,
    version: String,
    os: String,
    arch: String,
}

#[derive(Serialize, Default)]
pub struct Devices {
    video: Vec<Device>,
    audio: Vec<Device>,
    screens: Vec<Device>,
}

#[derive(Serialize, Clone)]
pub struct Device {
    id: String,
    name: String,
}

pub fn ffmpeg_path(app: &AppHandle) -> PathBuf {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    // Release builds ship FFmpeg as a sidecar next to the app executable.
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        let sidecar = dir.join(exe);
        if sidecar.exists() {
            return sidecar;
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("bin").join(exe);
        if bundled.exists() {
            return bundled;
        }
    }
    // Homebrew is not on the PATH of GUI apps launched from Finder.
    for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if cfg!(target_os = "macos") && PathBuf::from(p).exists() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(exe)
}

fn command(app: &AppHandle) -> Command {
    let mut cmd = Command::new(ffmpeg_path(app));
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);
    cmd
}

async fn run_capture(app: &AppHandle, args: &[&str]) -> Result<(String, String, Option<i32>), String> {
    let out = command(app)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("could not run ffmpeg ({e}). Install FFmpeg or reinstall StreamForge."))?;
    Ok((
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        out.status.code(),
    ))
}

#[tauri::command]
pub async fn ffmpeg_info(app: AppHandle) -> Result<FfmpegInfo, String> {
    let (stdout, _, _) = run_capture(&app, &["-hide_banner", "-version"]).await?;
    Ok(FfmpegInfo {
        path: ffmpeg_path(&app).to_string_lossy().into_owned(),
        version: stdout.lines().next().unwrap_or_default().to_string(),
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    })
}

/// Lists cameras, microphones and (on macOS) capturable screens.
#[tauri::command]
pub async fn ffmpeg_list_devices(app: AppHandle) -> Result<Devices, String> {
    let mut devices = Devices::default();
    if cfg!(target_os = "macos") {
        let (_, stderr, _) =
            run_capture(&app, &["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]).await?;
        let mut section = "";
        for line in stderr.lines() {
            if line.contains("AVFoundation video devices") {
                section = "video";
                continue;
            }
            if line.contains("AVFoundation audio devices") {
                section = "audio";
                continue;
            }
            // "[AVFoundation indev @ 0x..] [0] FaceTime HD Camera"
            let Some(rest) = line.rsplit_once("] [").map(|(_, r)| r) else { continue };
            let Some((idx, name)) = rest.split_once("] ") else { continue };
            let d = Device { id: idx.to_string(), name: name.trim().to_string() };
            match section {
                "video" if name.starts_with("Capture screen") => devices.screens.push(d),
                "video" => devices.video.push(d),
                "audio" => devices.audio.push(d),
                _ => {}
            }
        }
    } else if cfg!(windows) {
        let (_, stderr, _) =
            run_capture(&app, &["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]).await?;
        for line in stderr.lines() {
            // [dshow @ ...] "Integrated Camera" (video)
            let Some(start) = line.find('"') else { continue };
            let Some(end) = line[start + 1..].find('"') else { continue };
            let name = line[start + 1..start + 1 + end].to_string();
            if name.starts_with('@') {
                continue; // alternative name line
            }
            let d = Device { id: name.clone(), name };
            if line.contains("(video)") {
                devices.video.push(d);
            } else if line.contains("(audio)") {
                devices.audio.push(d);
            }
        }
        devices.screens.push(Device { id: "0".into(), name: "Primary display".into() });
    } else {
        devices.screens.push(Device { id: ":0.0".into(), name: "X11 display".into() });
    }
    Ok(devices)
}

/// Returns hardware H.264/HEVC encoders that actually work on this machine (a listed
/// encoder such as NVENC fails on machines without the GPU, so each one is test-run).
#[tauri::command]
pub async fn ffmpeg_probe_encoders(app: AppHandle) -> Result<Vec<String>, String> {
    let (stdout, _, _) = run_capture(&app, &["-hide_banner", "-encoders"]).await?;
    let candidates = [
        "h264_nvenc",
        "hevc_nvenc",
        "h264_qsv",
        "h264_amf",
        "h264_videotoolbox",
        "hevc_videotoolbox",
        "h264_mf",
    ];
    let mut working = Vec::new();
    for enc in candidates {
        if !stdout.contains(enc) {
            continue;
        }
        let (_, _, code) = run_capture(
            &app,
            &[
                "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                "color=c=black:s=640x360:r=30:d=0.2", "-c:v", enc, "-f", "null", "-",
            ],
        )
        .await?;
        if code == Some(0) {
            working.push(enc.to_string());
        }
    }
    working.push("libx264".into());
    Ok(working)
}

/// Starts a long-running ffmpeg job (recording or export). Progress arrives as
/// `ffmpeg://progress` events and completion as `ffmpeg://exit`.
#[tauri::command]
pub async fn ffmpeg_start(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    id: String,
    args: Vec<String>,
) -> Result<(), String> {
    let mut full = vec!["-hide_banner".to_string(), "-y".into(), "-progress".into(), "pipe:1".into(), "-nostats".into()];
    full.extend(args);
    let mut child: Child = command(&app)
        .args(&full)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start ffmpeg: {e}"))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    jobs.0.lock().await.insert(id.clone(), Job { stdin, pid: child.id() });

    // Progress: ffmpeg prints key=value blocks terminated by progress=continue|end.
    let app_p = app.clone();
    let id_p = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut p = Progress { id: id_p, out_time_ms: 0, fps: 0.0, speed: String::new(), frame: 0 };
        while let Ok(Some(line)) = lines.next_line().await {
            let Some((k, v)) = line.split_once('=') else { continue };
            match k {
                "out_time_us" | "out_time_ms" => p.out_time_ms = v.trim().parse::<i64>().unwrap_or(0) / 1000,
                "fps" => p.fps = v.trim().parse().unwrap_or(0.0),
                "speed" => p.speed = v.trim().to_string(),
                "frame" => p.frame = v.trim().parse().unwrap_or(0),
                "progress" => {
                    let _ = app_p.emit("ffmpeg://progress", p.clone());
                }
                _ => {}
            }
        }
    });

    let jobs_arc = jobs.0.clone();
    tauri::async_runtime::spawn(async move {
        let mut log: Vec<String> = Vec::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log.push(line);
            if log.len() > 60 {
                log.remove(0);
            }
        }
        let status = child.wait().await.ok();
        jobs_arc.lock().await.remove(&id);
        let _ = app.emit(
            "ffmpeg://exit",
            Exit { id, code: status.and_then(|s| s.code()), log: log.join("\n") },
        );
    });
    Ok(())
}

/// Gracefully stops a job by sending `q` so the MP4 gets its index written; kills it
/// if it has not exited within a few seconds.
#[tauri::command]
pub async fn ffmpeg_stop(jobs: State<'_, Jobs>, id: String) -> Result<(), String> {
    let pid = {
        let mut map = jobs.0.lock().await;
        let Some(job) = map.get_mut(&id) else { return Ok(()) };
        if let Some(stdin) = job.stdin.as_mut() {
            let _ = stdin.write_all(b"q\n").await;
            let _ = stdin.flush().await;
        }
        job.stdin = None;
        job.pid
    };
    let jobs_arc = jobs.0.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        if jobs_arc.lock().await.contains_key(&id) {
            if let Some(pid) = pid {
                kill_pid(pid);
            }
        }
    });
    Ok(())
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status();
    #[cfg(not(windows))]
    let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
}

/// Runs a short ffmpeg command to completion (thumbnails, concat, probes).
#[tauri::command]
pub async fn ffmpeg_run(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (stdout, stderr, code) = run_capture(&app, &refs).await?;
    if code == Some(0) {
        Ok(stdout)
    } else {
        Err(stderr.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
    }
}

#[derive(Serialize)]
pub struct MediaInfo {
    duration: f64,
    width: u32,
    height: u32,
    fps: f64,
    has_audio: bool,
    has_video: bool,
}

/// Reads duration / size / streams by parsing `ffmpeg -i` output (avoids bundling ffprobe).
#[tauri::command]
pub async fn probe_media(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    let (_, stderr, _) = run_capture(&app, &["-hide_banner", "-i", &path]).await?;
    let mut info = MediaInfo { duration: 0.0, width: 0, height: 0, fps: 0.0, has_audio: false, has_video: false };
    for line in stderr.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("Duration: ") {
            let t = rest.split(',').next().unwrap_or("");
            let parts: Vec<f64> = t.split(':').filter_map(|x| x.parse().ok()).collect();
            if parts.len() == 3 {
                info.duration = parts[0] * 3600.0 + parts[1] * 60.0 + parts[2];
            }
        }
        if l.contains("Stream #") && l.contains("Video:") && !info.has_video {
            info.has_video = !l.contains("attached pic");
            for tok in l.split([',', ' ']) {
                if let Some((w, h)) = tok.split_once('x') {
                    if let (Ok(w), Ok(h)) = (w.parse::<u32>(), h.parse::<u32>()) {
                        if w > 15 && h > 15 {
                            info.width = w;
                            info.height = h;
                            break;
                        }
                    }
                }
            }
            if let Some(i) = l.find(" fps") {
                let head = &l[..i];
                info.fps = head.rsplit(' ').next().and_then(|s| s.parse().ok()).unwrap_or(0.0);
            }
        }
        if l.contains("Stream #") && l.contains("Audio:") {
            info.has_audio = true;
        }
    }
    Ok(info)
}

/// Runs an analysis pass (silencedetect, loudness, …) and returns ffmpeg's log.
#[tauri::command]
pub async fn ffmpeg_analyze(app: AppHandle, args: Vec<String>) -> Result<String, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (_, stderr, _) = run_capture(&app, &refs).await?;
    Ok(stderr)
}
