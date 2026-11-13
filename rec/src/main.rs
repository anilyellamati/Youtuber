// No console window for the GUI.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod audio;
mod core;
#[cfg(windows)]
mod gui;

use std::io::Write;
use std::time::Duration;

/// `--selftest [seconds]`: records, stops, exports all four presets and writes
/// the results to stdout and selftest.log next to the working directory.
fn selftest(secs: u64) -> i32 {
    let mut log = std::fs::File::create("selftest.log").ok();
    let mut say = |line: String| {
        println!("{line}");
        if let Some(f) = log.as_mut() {
            let _ = writeln!(f, "{line}");
        }
    };
    say(format!("ffmpeg: {}", core::ffmpeg_path().display()));
    let Some(kind) = core::detect_strategy() else {
        say("FAIL: no working capture strategy (is ffmpeg present?)".into());
        return 1;
    };
    say(format!("strategy: {kind} ({})", core::label(kind)));
    let dir = std::env::temp_dir().join("sfrec-selftest");
    let _ = std::fs::create_dir_all(&dir);
    if let Some(d) = core::disk(&dir) {
        say(format!("disk: {:.1}% used, {} free", d.used * 100.0, core::fmt_gb(d.free_bytes)));
    }
    let mut rec = match core::Recording::start(&dir, kind, true, true) {
        Ok(r) => r,
        Err(e) => {
            say(format!("FAIL: {e}"));
            return 1;
        }
    };
    for _ in 0..secs * 2 {
        std::thread::sleep(Duration::from_millis(500));
        if !rec.alive() {
            say(format!("FAIL: recorder exited early: {}", rec.error_log()));
            return 1;
        }
    }
    let (path, _) = rec.stop();
    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
    let dur = core::duration(&path);
    say(format!("recording: {} bytes, duration {:?}", size, dur));
    let mut code = 0;
    if size < 10_000 || dur.map(|d| d < secs as f64 * 0.5).unwrap_or(true) {
        say("FAIL: recording too small or too short".into());
        code = 1;
    }
    for p in core::PRESETS {
        let st = core::start_export(path.clone(), p, kind.to_string());
        let res = loop {
            std::thread::sleep(Duration::from_millis(200));
            if let Some(r) = st.lock().unwrap().done.take() {
                break r;
            }
        };
        match res {
            Ok(out) => say(format!("export {}: ok, {} bytes, duration {:?}", p.id, out.metadata().map(|m| m.len()).unwrap_or(0), core::duration(&out))),
            Err(e) => {
                say(format!("FAIL export {}: {e}", p.id));
                code = 1;
            }
        }
    }
    say(if code == 0 { "SELFTEST PASSED".into() } else { "SELFTEST FAILED".into() });
    code
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--selftest") {
        std::process::exit(selftest(args.get(2).and_then(|s| s.parse().ok()).unwrap_or(5)));
    }
    #[cfg(windows)]
    gui::run();
    #[cfg(not(windows))]
    eprintln!("The window is Windows-only. Use --selftest here.");
}
