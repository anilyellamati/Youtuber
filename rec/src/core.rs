//! Recording and export engine. FFmpeg does the heavy lifting in a separate,
//! below-normal-priority process: GPU desktop duplication feeds the GPU's own
//! encoder, so a running game keeps the CPU. This process only supervises.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const FPS: u32 = 30;
/// Stop recording when the output drive is this full.
pub const DISK_LIMIT: f64 = 0.97;

pub fn ffmpeg_path() -> PathBuf {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        if dir.join(exe).exists() {
            return dir.join(exe);
        }
    }
    for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if Path::new(p).exists() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from(exe)
}

/// FFmpeg child that never opens a console window and yields the CPU to games.
fn ffmpeg() -> Command {
    let mut cmd = ffmpeg_raw();
    cmd.arg("-nostdin");
    cmd
}

fn ffmpeg_raw() -> Command {
    let mut cmd = Command::new(ffmpeg_path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }
    cmd.args(["-hide_banner", "-loglevel", "warning", "-y"]);
    cmd
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Capture + encode strategies, best first. The first one that survives a one-second
/// trial on this machine is used.
pub const STRATEGIES: &[&str] = if cfg!(windows) {
    &["nvenc", "amf", "qsv", "mf", "x264-dd", "x264-gdi"]
} else {
    &["test"]
};

pub fn label(kind: &str) -> &'static str {
    match kind {
        "nvenc" => "NVIDIA GPU (NVENC)",
        "amf" => "AMD GPU (AMF)",
        "qsv" => "Intel GPU (Quick Sync)",
        "mf" => "Windows hardware encoder",
        "x264-dd" => "CPU encoder (light preset)",
        "x264-gdi" => "CPU encoder (compatibility mode)",
        _ => "Test source",
    }
}

/// (video input args, video encoder args) for live capture.
fn capture_args(kind: &str) -> (Vec<String>, Vec<String>) {
    let dd = |tail: &str| s(&["-f", "lavfi", "-i", &format!("ddagrab=framerate={FPS}:draw_mouse=1{tail}")]);
    let even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    let gop = (FPS * 2).to_string();
    match kind {
        // GPU frames go straight from desktop duplication into the GPU encoder.
        "nvenc" => (dd(""), s(&["-c:v", "h264_nvenc", "-preset", "p3", "-rc", "vbr", "-cq", "24", "-b:v", "10M", "-maxrate", "16M", "-g", &gop])),
        "amf" => (dd(""), s(&["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed", "-rc", "vbr_peak", "-b:v", "10M", "-maxrate", "16M", "-g", &gop])),
        "qsv" => (dd(",hwmap=derive_device=qsv,format=qsv"), s(&["-c:v", "h264_qsv", "-preset", "veryfast", "-b:v", "10M", "-maxrate", "16M", "-g", &gop])),
        "mf" => (dd(&format!(",hwdownload,format=bgra,{even},format=nv12")), s(&["-c:v", "h264_mf", "-hw_encoding", "1", "-b:v", "10M", "-g", &gop])),
        "x264-dd" => (dd(&format!(",hwdownload,format=bgra,{even},format=yuv420p")), s(&["-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-threads", "2", "-g", &gop])),
        "x264-gdi" => (
            s(&["-f", "gdigrab", "-framerate", "24", "-draw_mouse", "1", "-i", "desktop"]),
            s(&["-vf", &format!("{even},format=yuv420p"), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-threads", "2", "-g", "48"]),
        ),
        _ => (
            s(&["-re", "-f", "lavfi", "-i", &format!("testsrc2=s=1280x720:r={FPS}")]),
            s(&["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", &gop]),
        ),
    }
}

fn wait_timeout(child: &mut Child, limit: Duration) -> Option<bool> {
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Some(st.success()),
            Ok(None) if t0.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Picks the lightest strategy that actually works here (each is trial-run for 1 s).
pub fn detect_strategy() -> Option<&'static str> {
    for kind in STRATEGIES {
        let (input, codec) = capture_args(kind);
        let mut child = match ffmpeg().args(&input).args(["-t", "1"]).args(&codec).args(["-f", "null", "-"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
            Ok(c) => c,
            Err(_) => return None, // ffmpeg missing
        };
        if wait_timeout(&mut child, Duration::from_secs(20)) == Some(true) {
            return Some(kind);
        }
    }
    None
}

// ---------- disk ----------

pub struct Disk {
    pub used: f64, // 0..1
    pub free_bytes: u64,
}

pub fn disk(dir: &Path) -> Option<Disk> {
    // use the nearest existing folder so a not-yet-created output folder still reports
    let dir = dir.ancestors().find(|p| p.exists())?;
    let total = fs2::total_space(dir).ok()?;
    let free = fs2::available_space(dir).ok()?;
    if total == 0 {
        return None;
    }
    Some(Disk { used: 1.0 - free as f64 / total as f64, free_bytes: free })
}

pub fn output_dir() -> PathBuf {
    let dir = dirs::video_dir().or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from(".")).join("StreamForge Rec");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// ---------- recording ----------

pub struct Recording {
    child: Child,
    stop: Arc<AtomicBool>,
    audio: Option<std::thread::JoinHandle<()>>,
    pub path: PathBuf,
    pub started: Instant,
    log: Arc<Mutex<String>>,
}

impl Recording {
    pub fn start(dir: &Path, kind: &str, system_sound: bool, mic: bool) -> Result<Recording, String> {
        let name = chrono::Local::now().format("Rec_%Y-%m-%d_%H-%M-%S.mkv").to_string();
        let path = dir.join(name);
        let (input, codec) = capture_args(kind);
        // Audio reaches ffmpeg over a loopback socket as raw PCM mixed by this process;
        // stdin stays free for the "q" (finish file) command. `-shortest` is avoided:
        // with a live audio input it stalls the video stream in FFmpeg 8.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let mut cmd = ffmpeg_raw();
        cmd.args(&input)
            .args(["-probesize", "32", "-analyzeduration", "0", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", &format!("tcp://127.0.0.1:{port}")])
            .args(["-map", "0:v", "-map", "1:a"])
            .args(&codec)
            .args(["-c:a", "aac", "-b:a", "160k"])
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the recorder (ffmpeg): {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let audio = crate::audio::spawn_mixer(listener, stop.clone(), system_sound, mic);
        let log = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = child.stderr.take() {
            let log = log.clone();
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = err.read_to_string(&mut buf);
                *log.lock().unwrap() = buf;
            });
        }
        Ok(Recording { child, stop, audio: Some(audio), path, started: Instant::now(), log })
    }

    /// False once ffmpeg has exited on its own (capture failure).
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn error_log(&self) -> String {
        let l = self.log.lock().unwrap();
        l.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")
    }

    /// Asks ffmpeg to finish the file ("q"), then ends the audio stream.
    /// MKV stays playable even if ffmpeg has to be killed.
    pub fn stop(mut self) -> (PathBuf, f64) {
        use std::io::Write;
        let secs = self.started.elapsed().as_secs_f64();
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        self.stop.store(true, Ordering::SeqCst);
        if let Some(a) = self.audio.take() {
            let _ = a.join();
        }
        let _ = wait_timeout(&mut self.child, Duration::from_secs(10));
        (self.path.clone(), secs)
    }
}

// ---------- export ----------

#[derive(Clone, Copy, PartialEq)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub w: u32,
    pub h: u32,
    pub kbps: u32,
}

pub const PRESETS: [Preset; 4] = [
    Preset { id: "YouTube-High", label: "YouTube - High quality", w: 1920, h: 1080, kbps: 10000 },
    Preset { id: "YouTube-Low", label: "YouTube - Low quality", w: 1280, h: 720, kbps: 3500 },
    Preset { id: "Story-High", label: "Story 9:16 - High quality", w: 1080, h: 1920, kbps: 8000 },
    Preset { id: "Story-Low", label: "Story 9:16 - Low quality", w: 720, h: 1280, kbps: 3000 },
];

#[derive(Default)]
pub struct ExportState {
    pub progress: f32, // 0..1
    pub done: Option<Result<PathBuf, String>>,
}

fn export_codec(kind: &str, kbps: u32) -> Vec<String> {
    let b = format!("{kbps}k");
    let max = format!("{}k", kbps * 3 / 2);
    match kind {
        "nvenc" => s(&["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-b:v", &b, "-maxrate", &max, "-pix_fmt", "yuv420p"]),
        "amf" => s(&["-c:v", "h264_amf", "-quality", "balanced", "-rc", "vbr_peak", "-b:v", &b, "-maxrate", &max, "-pix_fmt", "yuv420p"]),
        "qsv" => s(&["-c:v", "h264_qsv", "-preset", "medium", "-b:v", &b, "-maxrate", &max, "-pix_fmt", "nv12"]),
        "mf" => s(&["-c:v", "h264_mf", "-hw_encoding", "1", "-b:v", &b, "-pix_fmt", "nv12"]),
        _ => s(&["-c:v", "libx264", "-preset", "veryfast", "-b:v", &b, "-maxrate", &max, "-bufsize", &format!("{}k", kbps * 2), "-pix_fmt", "yuv420p"]),
    }
}

fn export_filter(p: &Preset) -> String {
    let (w, h) = (p.w, p.h);
    if h > w {
        // Mobile 9:16: the whole screen stays visible, over a blurred copy of itself.
        format!(
            "[0:v]fps={FPS},split[a][b];[a]scale={sw}:{sh}:force_original_aspect_ratio=increase,crop={sw}:{sh},boxblur=6,scale={w}:{h}[bg];\
             [b]scale={w}:{h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]",
            sw = w / 4,
            sh = h / 4
        )
    } else {
        format!("[0:v]fps={FPS},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v]")
    }
}

/// Duration in seconds, read from ffmpeg's own probe output.
pub fn duration(path: &Path) -> Option<f64> {
    let out = ffmpeg().args(["-loglevel", "info", "-i"]).arg(path).output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).into_owned();
    let line = text.lines().find(|l| l.trim_start().starts_with("Duration:"))?;
    let t = line.trim_start().strip_prefix("Duration:")?.split(',').next()?.trim();
    let parts: Vec<f64> = t.split(':').filter_map(|x| x.parse().ok()).collect();
    (parts.len() == 3).then(|| parts[0] * 3600.0 + parts[1] * 60.0 + parts[2])
}

pub fn export_path(master: &Path, p: &Preset) -> PathBuf {
    let stem = master.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Rec".into());
    master.with_file_name(format!("{stem}_{}.mp4", p.id))
}

fn run_export(master: &Path, p: &Preset, kind: &str, total: Option<f64>, state: &Arc<Mutex<ExportState>>) -> Result<PathBuf, String> {
    let out = export_path(master, p);
    let mut child = ffmpeg()
        .args(["-progress", "pipe:1", "-nostats", "-i"])
        .arg(master)
        .args(["-filter_complex", &export_filter(p), "-map", "[v]", "-map", "0:a?"])
        .args(export_codec(kind, p.kbps))
        .args(["-r", &FPS.to_string(), "-g", &(FPS * 2).to_string(), "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart"])
        .arg(&out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start export: {e}"))?;
    let mut err = child.stderr.take().unwrap();
    let errt = std::thread::spawn(move || {
        let mut b = String::new();
        let _ = err.read_to_string(&mut b);
        b
    });
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        if let (Some(us), Some(total)) = (line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()), total) {
            state.lock().unwrap().progress = ((us / 1e6) / total).clamp(0.0, 1.0) as f32;
        }
    }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false);
    let log = errt.join().unwrap_or_default();
    if ok && out.metadata().map(|m| m.len() > 1000).unwrap_or(false) {
        Ok(out)
    } else {
        let _ = std::fs::remove_file(&out);
        Err(log.lines().rev().take(2).collect::<Vec<_>>().join(" "))
    }
}

/// Exports in the background; falls back to the CPU encoder if the GPU one refuses.
pub fn start_export(master: PathBuf, p: Preset, kind: String) -> Arc<Mutex<ExportState>> {
    let state = Arc::new(Mutex::new(ExportState::default()));
    let st = state.clone();
    std::thread::spawn(move || {
        let total = duration(&master);
        let mut res = run_export(&master, &p, &kind, total, &st);
        if res.is_err() && !kind.starts_with("x264") && kind != "test" {
            res = run_export(&master, &p, "x264", total, &st);
        }
        let mut s = st.lock().unwrap();
        s.progress = 1.0;
        s.done = Some(res);
    });
    state
}

pub fn fmt_time(secs: f64) -> String {
    let t = secs as u64;
    if t >= 3600 {
        format!("{}:{:02}:{:02}", t / 3600, t % 3600 / 60, t % 60)
    } else {
        format!("{:02}:{:02}", t / 60, t % 60)
    }
}

pub fn fmt_gb(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
}
