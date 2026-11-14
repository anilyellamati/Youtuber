//! Recording and export engine. FFmpeg does the heavy lifting in a separate,
//! process: GPU desktop duplication feeds the GPU's own
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

/// FFmpeg child that never opens a console window.
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
        // Normal priority on purpose. At below-normal priority a game that keeps every
        // CPU core busy starves ffmpeg almost completely: it takes tens of seconds to
        // start and then captures only a few frames a minute.
        cmd.creation_flags(CREATE_NO_WINDOW);
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

/// What to capture. Coordinates are real pixels.
#[derive(Clone, Debug, Default)]
pub struct Source {
    /// Display number (0 = primary) for GPU desktop duplication.
    pub output: u32,
    /// Area inside that display: (x, y, w, h). None = the whole display.
    pub region: Option<(i32, i32, i32, i32)>,
    /// The same area in virtual-desktop coordinates (compatibility capture).
    pub virt: Option<(i32, i32, i32, i32)>,
}

const EVEN: &str = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

fn is_dd(kind: &str) -> bool {
    matches!(kind, "nvenc" | "amf" | "qsv" | "mf" | "x264-dd")
}

/// Video input args. `software` = frames must come back to system memory (needed
/// when the camera is overlaid); otherwise GPU kinds stay on the GPU end to end.
fn video_input(kind: &str, src: &Source, software: bool) -> Vec<String> {
    if is_dd(kind) {
        let area = match src.region {
            Some((x, y, w, h)) => format!(":video_size={w}x{h}:offset_x={x}:offset_y={y}"),
            None => String::new(),
        };
        let tail = if software {
            ",hwdownload,format=bgra".to_string()
        } else {
            match kind {
                "qsv" => ",hwmap=derive_device=qsv,format=qsv".to_string(),
                "mf" => format!(",hwdownload,format=bgra,{EVEN},format=nv12"),
                "x264-dd" => format!(",hwdownload,format=bgra,{EVEN},format=yuv420p"),
                _ => String::new(),
            }
        };
        return s(&["-f", "lavfi", "-i", &format!("ddagrab=output_idx={}:framerate={FPS}:draw_mouse=1{area}{tail}", src.output)]);
    }
    if kind == "x264-gdi" {
        let mut v = s(&["-f", "gdigrab", "-framerate", "24", "-draw_mouse", "1"]);
        if let Some((x, y, w, h)) = src.virt {
            v.extend(s(&["-offset_x", &x.to_string(), "-offset_y", &y.to_string(), "-video_size", &format!("{w}x{h}")]));
        }
        v.extend(s(&["-i", "desktop"]));
        return v;
    }
    s(&["-re", "-f", "lavfi", "-i", &format!("testsrc2=s=1280x720:r={FPS}")])
}

/// Encoder args for live capture. `software` = input frames are in system memory.
fn video_codec(kind: &str, software: bool) -> Vec<String> {
    let gop = (FPS * 2).to_string();
    let mut v = match kind {
        "nvenc" => s(&["-c:v", "h264_nvenc", "-preset", "p3", "-rc", "vbr", "-cq", "24", "-b:v", "10M", "-maxrate", "16M", "-g", &gop]),
        "amf" => s(&["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "speed", "-rc", "vbr_peak", "-b:v", "10M", "-maxrate", "16M", "-g", &gop]),
        "qsv" => s(&["-c:v", "h264_qsv", "-preset", "veryfast", "-b:v", "10M", "-maxrate", "16M", "-g", &gop]),
        "mf" => s(&["-c:v", "h264_mf", "-hw_encoding", "1", "-b:v", "10M", "-g", &gop]),
        "x264-dd" => s(&["-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-threads", "2", "-g", &gop]),
        "x264-gdi" => s(&["-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-threads", "2", "-g", "48"]),
        _ => s(&["-c:v", "libx264", "-preset", "ultrafast", "-g", &gop]),
    };
    if software || kind == "x264-gdi" || kind == "test" {
        v.extend(s(&["-pix_fmt", if matches!(kind, "qsv" | "mf") { "nv12" } else { "yuv420p" }]));
    }
    v
}

/// (video input args, video encoder args) for plain screen capture.
fn capture_args(kind: &str) -> (Vec<String>, Vec<String>) {
    let mut codec = Vec::new();
    if kind == "x264-gdi" {
        codec.extend(s(&["-vf", EVEN]));
    }
    codec.extend(video_codec(kind, false));
    (video_input(kind, &Source::default(), false), codec)
}

/// Cameras known to DirectShow (Windows).
pub fn list_cameras() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let Ok(out) = ffmpeg().args(["-loglevel", "info", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]).output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stderr).into_owned();
    let mut cams = Vec::new();
    for line in text.lines().filter(|l| l.contains("(video)")) {
        if let (Some(a), Some(b)) = (line.find('"'), line.rfind('"')) {
            if b > a + 1 && !cams.iter().any(|c| c == &line[a + 1..b]) {
                cams.push(line[a + 1..b].to_string());
            }
        }
    }
    cams
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
    audio_url: String,
}

/// Why a recording produced nothing, for the user. Points at the log file.
pub fn failure_help(dir: &Path) -> String {
    format!("Nothing was recorded.\n\nPlease send this file so it can be fixed:\n{}", dir.join("last-recording-log.txt").display())
}

impl Recording {
    /// `mic`: None = off, Some("") = default device, Some(name) = that device.
    /// `camera`: a DirectShow camera shown as a small picture in the bottom-right corner.
    /// `with_audio` false records the picture only (used when sound cannot be delivered).
    pub fn start(dir: &Path, kind: &str, src: &Source, with_audio: bool, system_sound: bool, mic: Option<String>, camera: Option<String>) -> Result<Recording, String> {
        let _ = std::fs::create_dir_all(dir);
        let name = chrono::Local::now().format("Rec_%Y-%m-%d_%H-%M-%S.mkv").to_string();
        let path = dir.join(name);
        let cam = camera.filter(|c| !c.is_empty());
        let software = cam.is_some();
        // Audio reaches ffmpeg through a private pipe as raw PCM mixed by this process;
        // stdin stays free for the "q" (finish file) command. `-shortest` is avoided:
        // with a live audio input it stalls the video stream in FFmpeg 8.
        let (sink, audio_url) = if with_audio {
            let (s, u) = crate::audio::Sink::create()?;
            (Some(s), u)
        } else {
            (None, String::new())
        };
        let mut cmd = ffmpeg_raw();
        cmd.args(video_input(kind, src, software));
        if let Some(cam) = &cam {
            cmd.args(["-f", "dshow", "-rtbufsize", "64M", "-i", &format!("video={cam}")]);
        }
        let audio_idx = if cam.is_some() { 2 } else { 1 };
        if with_audio {
            cmd.args(["-probesize", "32", "-analyzeduration", "0", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", &audio_url]);
        }
        if cam.is_some() {
            // camera: about a quarter of the frame height, bottom-right corner
            // The camera's clock (system time) is rebased to zero like the screen's; left
            // as is, the overlay stalls waiting on mismatched timestamps and drops
            // almost every frame.
            let screen_h = src.region.or(src.virt).map(|r| r.3).unwrap_or(1080);
            let cam_h = (screen_h / 4).max(120) & !1;
            cmd.args(["-filter_complex", &format!("[1:v]setpts=PTS-STARTPTS,scale=-2:{cam_h}[cam];[0:v][cam]overlay=W-w-24:H-h-24:eof_action=pass,{EVEN}[v]"), "-map", "[v]"]);
        } else {
            if kind == "x264-gdi" {
                cmd.args(["-vf", EVEN]);
            }
            cmd.args(["-map", "0:v"]);
        }
        if with_audio {
            cmd.args(["-map", &format!("{audio_idx}:a"), "-c:a", "aac", "-b:a", "160k"]);
        }
        cmd.args(video_codec(kind, software))
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let cmdline = format!("{cmd:?}");
        let log_path = dir.join("last-recording-log.txt");
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the recorder (ffmpeg): {e}"))?;
        let stop = Arc::new(AtomicBool::new(false));
        let audio = sink.map(|sink| crate::audio::spawn_mixer(sink, stop.clone(), system_sound, mic));
        let log = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = child.stderr.take() {
            let log = log.clone();
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = err.read_to_string(&mut buf);
                // kept on disk so a failed recording can be diagnosed from one file
                let _ = std::fs::write(&log_path, format!("StreamForge Rec {}\n{cmdline}\n\n{buf}", env!("CARGO_PKG_VERSION")));
                *log.lock().unwrap() = buf;
            });
        }
        Ok(Recording { child, stop, audio, path, started: Instant::now(), log, audio_url })
    }

    /// False once ffmpeg has exited on its own (capture failure).
    pub fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub fn error_log(&self) -> String {
        let l = self.log.lock().unwrap();
        l.lines().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")
    }

    pub fn has_audio(&self) -> bool {
        !self.audio_url.is_empty()
    }

    /// True when the recorder is running but nothing is reaching the file: ffmpeg
    /// creates the file once all inputs are open and adds data every few seconds.
    pub fn stalled(&self) -> bool {
        let secs = self.started.elapsed().as_secs_f64();
        match self.path.metadata() {
            Err(_) => secs >= 30.0,
            Ok(m) => m.len() == 0 && secs >= 45.0,
        }
    }

    /// Ends a recording that produced nothing, without waiting, and removes the empty file.
    pub fn abort(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        if cfg!(windows) && self.has_audio() {
            let _ = std::fs::File::open(&self.audio_url);
        }
        if let Some(a) = self.audio.take() {
            let _ = a.join();
        }
        if self.path.metadata().map(|m| m.len() < 1000).unwrap_or(false) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// Asks ffmpeg to finish the file ("q"), then ends the audio stream.
    /// MKV stays playable even if ffmpeg has to be killed.
    /// The path is None when no usable file was produced.
    pub fn stop(mut self) -> (Option<PathBuf>, f64) {
        use std::io::Write;
        let secs = self.started.elapsed().as_secs_f64();
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        self.stop.store(true, Ordering::SeqCst);
        // If ffmpeg never opened the audio pipe, the mixer is still waiting for it:
        // opening the pipe ourselves releases that wait. (No effect once connected.)
        if cfg!(windows) && self.has_audio() {
            let _ = std::fs::File::open(&self.audio_url);
        }
        if let Some(a) = self.audio.take() {
            let _ = a.join();
        }
        let _ = wait_timeout(&mut self.child, Duration::from_secs(10));
        let ok = self.path.metadata().map(|m| m.len() >= 1000).unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_file(&self.path);
        }
        (ok.then(|| self.path.clone()), secs)
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
            "[0:v]fps={FPS},split[a][b];[a]scale={sw}:{sh}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop={sw}:{sh},boxblur=3,scale={w}:{h}:flags=fast_bilinear[bg];\
             [b]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bilinear[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]",
            sw = w / 8,
            sh = h / 8
        )
    } else {
        format!("[0:v]fps={FPS},scale={w}:{h}:force_original_aspect_ratio=decrease:flags=bilinear,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v]")
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

/// Video frame size, read from ffmpeg's probe output.
pub fn video_size(path: &Path) -> Option<(u32, u32)> {
    let out = ffmpeg().args(["-loglevel", "info", "-i"]).arg(path).output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).into_owned();
    let line = text.lines().find(|l| l.contains("Video:"))?;
    line.split([' ', ',']).find_map(|tok| {
        let (w, h) = tok.split_once('x')?;
        let (w, h) = (w.parse::<u32>().ok()?, h.parse::<u32>().ok()?);
        (w >= 16 && h >= 16).then_some((w, h))
    })
}

/// "YouTube High" for a recording that is already 1080p or smaller: repackage as
/// MP4 without re-encoding. Takes seconds and keeps the original quality.
fn run_copy(master: &Path, p: &Preset, state: &Arc<Mutex<ExportState>>) -> Result<PathBuf, String> {
    let out = export_path(master, p);
    let res = ffmpeg().arg("-i").arg(master).args(["-map", "0:v", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart"]).arg(&out).output().map_err(|e| e.to_string())?;
    if res.status.success() && out.metadata().map(|m| m.len() > 1000).unwrap_or(false) {
        state.lock().unwrap().progress = 1.0;
        Ok(out)
    } else {
        let _ = std::fs::remove_file(&out);
        Err(String::from_utf8_lossy(&res.stderr).lines().rev().take(2).collect::<Vec<_>>().join(" "))
    }
}

/// Number of video frames actually stored in a file (decodes it once).
pub fn frame_count(path: &Path) -> Option<u64> {
    let out = ffmpeg().args(["-loglevel", "info", "-i"]).arg(path).args(["-map", "0:v", "-f", "null", "-"]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).replace('\r', "\n");
    let line = text.lines().rev().find(|l| l.starts_with("frame="))?;
    line["frame=".len()..].split_whitespace().next()?.parse().ok()
}

pub fn export_path(master: &Path, p: &Preset) -> PathBuf {
    let stem = master.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Rec".into());
    master.with_file_name(format!("{stem}_{}.mp4", p.id))
}

fn run_export(master: &Path, p: &Preset, kind: &str, total: Option<f64>, state: &Arc<Mutex<ExportState>>) -> Result<PathBuf, String> {
    let out = export_path(master, p);
    let mut child = ffmpeg()
        // decode on the graphics card when possible (falls back to CPU by itself)
        .args(["-progress", "pipe:1", "-nostats", "-hwaccel", "auto", "-i"])
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
        if p.id == "YouTube-High" && video_size(&master).map(|(w, h)| w <= 1920 && h <= 1080).unwrap_or(false) {
            if let Ok(out) = run_copy(&master, &p, &st) {
                let mut s = st.lock().unwrap();
                s.progress = 1.0;
                s.done = Some(Ok(out));
                return;
            }
        }
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
