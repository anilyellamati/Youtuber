//! The whole interface: one small native Win32 window. No preview, no web engine;
//! a 500 ms timer updates the clock, watches the disk and polls the export.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use native_windows_gui as nwg;

use crate::core::{self, ExportState, Recording, Source, PRESETS};
use crate::{audio, win};

#[derive(Default)]
struct Ui {
    window: nwg::Window,
    big: nwg::Font,
    status: nwg::Label,
    disk: nwg::Label,
    l_src: nwg::Label,
    src: nwg::ComboBox<String>,
    refresh: nwg::Button,
    l_mic: nwg::Label,
    mic: nwg::ComboBox<String>,
    l_cam: nwg::Label,
    cam: nwg::ComboBox<String>,
    sys: nwg::CheckBox,
    rec: nwg::Button,
    last: nwg::Label,
    exports: [nwg::Button; 4],
    bar: nwg::ProgressBar,
    folder: nwg::Button,
    engine: nwg::Label,
    timer: nwg::AnimationTimer,
}

struct State {
    dir: PathBuf,
    strategy: Option<&'static str>,
    detecting: bool,
    sources: Vec<Source>,
    mics: Vec<String>,
    cams: Vec<String>,
    rec: Option<Recording>,
    last: Option<PathBuf>,
    export: Option<(Arc<Mutex<ExportState>>, &'static str)>,
}

type Detected = Arc<Mutex<Option<(Option<&'static str>, Vec<String>)>>>;

enum Msg {
    Info(String),
    Error(String),
}

fn build(ui: &mut Ui) -> Result<(), nwg::NwgError> {
    nwg::Font::builder().family("Segoe UI").size(26).weight(700).build(&mut ui.big)?;
    nwg::Window::builder()
        .size((460, 462))
        .position((320, 220))
        .title("StreamForge Rec")
        .flags(nwg::WindowFlags::WINDOW | nwg::WindowFlags::VISIBLE | nwg::WindowFlags::MINIMIZE_BOX)
        .build(&mut ui.window)?;
    let w = &ui.window;
    nwg::Label::builder().text("Starting…").position((20, 12)).size((420, 34)).font(Some(&ui.big)).parent(w).build(&mut ui.status)?;
    nwg::Label::builder().text("").position((20, 50)).size((420, 20)).parent(w).build(&mut ui.disk)?;
    nwg::Label::builder().text("Screen / window:").position((20, 82)).size((108, 20)).parent(w).build(&mut ui.l_src)?;
    nwg::ComboBox::builder().position((130, 78)).size((240, 24)).parent(w).build(&mut ui.src)?;
    nwg::Button::builder().text("Refresh").position((376, 77)).size((64, 26)).parent(w).build(&mut ui.refresh)?;
    nwg::Label::builder().text("Microphone:").position((20, 114)).size((108, 20)).parent(w).build(&mut ui.l_mic)?;
    nwg::ComboBox::builder().position((130, 110)).size((310, 24)).parent(w).build(&mut ui.mic)?;
    nwg::Label::builder().text("Camera:").position((20, 146)).size((108, 20)).parent(w).build(&mut ui.l_cam)?;
    nwg::ComboBox::builder().position((130, 142)).size((310, 24)).parent(w).build(&mut ui.cam)?;
    nwg::CheckBox::builder().text("Record computer sound").position((20, 174)).size((300, 22)).check_state(nwg::CheckBoxState::Checked).parent(w).build(&mut ui.sys)?;
    nwg::Button::builder().text("Start recording  (F9)").position((20, 202)).size((420, 48)).enabled(false).parent(w).build(&mut ui.rec)?;
    nwg::Label::builder().text("Export for YouTube: record something first.").position((20, 264)).size((420, 20)).parent(w).build(&mut ui.last)?;
    let spots = [(20, 290), (235, 290), (20, 330), (235, 330)];
    for (i, b) in ui.exports.iter_mut().enumerate() {
        nwg::Button::builder().text(PRESETS[i].label).position(spots[i]).size((205, 34)).enabled(false).parent(w).build(b)?;
    }
    nwg::ProgressBar::builder().range(0..100).pos(0).position((20, 376)).size((420, 14)).parent(w).build(&mut ui.bar)?;
    nwg::Button::builder().text("Open recordings folder").position((20, 402)).size((170, 28)).parent(w).build(&mut ui.folder)?;
    nwg::Label::builder().text("").position((200, 407)).size((240, 20)).parent(w).build(&mut ui.engine)?;
    nwg::AnimationTimer::builder().parent(w).interval(Duration::from_millis(500)).active(true).build(&mut ui.timer)?;
    Ok(())
}

fn show(ui: &Ui, msg: Option<Msg>) {
    match msg {
        Some(Msg::Info(t)) => {
            nwg::modal_info_message(&ui.window, "StreamForge Rec", &t);
        }
        Some(Msg::Error(t)) => {
            nwg::modal_error_message(&ui.window, "StreamForge Rec", &t);
        }
        None => {}
    }
}

/// Fills the screen/window dropdown with every display, then every open window.
fn load_sources(ui: &Ui, st: &mut State) {
    let mons = win::monitors();
    let mut names = Vec::new();
    st.sources.clear();
    for (i, m) in mons.iter().enumerate() {
        names.push(format!("Display {} ({}x{}){}", i + 1, m.w, m.h, if i == 0 { " - main" } else { "" }));
        st.sources.push(win::display_source(i, m));
    }
    for (title, rect) in win::windows() {
        if let Some(src) = win::window_source(&rect, &mons) {
            let short: String = title.chars().take(60).collect();
            names.push(format!("Window: {short}"));
            st.sources.push(src);
        }
    }
    if st.sources.is_empty() {
        names.push("Main display".into());
        st.sources.push(Source::default());
    }
    ui.src.set_collection(names);
    ui.src.set_selection(Some(0));
}

fn load_mics(ui: &Ui, st: &mut State) {
    st.mics = audio::list_mics();
    let mut names = vec!["Default microphone".to_string()];
    names.extend(st.mics.iter().cloned());
    names.push("No microphone".into());
    ui.mic.set_collection(names);
    ui.mic.set_selection(Some(0));
}

fn load_cams(ui: &Ui, st: &mut State, cams: Vec<String>) {
    st.cams = cams;
    let mut names = vec!["No camera".to_string()];
    names.extend(st.cams.iter().cloned());
    ui.cam.set_collection(names);
    ui.cam.set_selection(Some(0));
}

fn set_inputs(ui: &Ui, on: bool) {
    ui.src.set_enabled(on);
    ui.refresh.set_enabled(on);
    ui.mic.set_enabled(on);
    ui.cam.set_enabled(on);
    ui.sys.set_enabled(on);
}

fn set_exports(ui: &Ui, on: bool) {
    for b in &ui.exports {
        b.set_enabled(on);
    }
}

fn disk_full_msg(used: f64) -> String {
    format!(
        "Disk is {:.0}% full.\n\nRecording stops at {:.0}% so Windows keeps working. Free up space or delete old recordings, then record again.",
        used * 100.0,
        core::DISK_LIMIT * 100.0
    )
}

fn finish_recording(ui: &Ui, st: &mut State) {
    if let Some(rec) = st.rec.take() {
        ui.status.set_text("Saving…");
        let (path, secs) = rec.stop();
        ui.last.set_text(&format!("Export last recording ({}) for YouTube:", core::fmt_time(secs)));
        st.last = Some(path);
        ui.rec.set_text("Start recording  (F9)");
        ui.status.set_text("Ready");
        set_inputs(ui, true);
        set_exports(ui, true);
    }
}

fn toggle(ui: &Ui, state: &RefCell<State>) -> Option<Msg> {
    let mut st = state.try_borrow_mut().ok()?;
    if st.rec.is_some() {
        finish_recording(ui, &mut st);
        return None;
    }
    let kind = st.strategy?;
    if st.export.is_some() {
        return Some(Msg::Info("Wait for the export to finish first.".into()));
    }
    if let Some(d) = core::disk(&st.dir) {
        if d.used >= core::DISK_LIMIT {
            return Some(Msg::Error(disk_full_msg(d.used)));
        }
    }
    let sys = ui.sys.check_state() == nwg::CheckBoxState::Checked;
    // dropdown rows: 0 = default, 1..=n = a device, last = none
    let mic = match ui.mic.selection().unwrap_or(0) {
        0 => Some(String::new()),
        i if i <= st.mics.len() => Some(st.mics[i - 1].clone()),
        _ => None,
    };
    let cam = match ui.cam.selection().unwrap_or(0) {
        0 => None,
        i => st.cams.get(i - 1).cloned(),
    };
    let src = st.sources.get(ui.src.selection().unwrap_or(0)).cloned().unwrap_or_default();
    match Recording::start(&st.dir, kind, &src, sys, mic, cam) {
        Ok(rec) => {
            st.rec = Some(rec);
            ui.rec.set_text("Stop recording  (F9)");
            set_inputs(ui, false);
            set_exports(ui, false);
            None
        }
        Err(e) => Some(Msg::Error(e)),
    }
}

fn tick(ui: &Ui, state: &RefCell<State>, detected: &Detected) -> Option<Msg> {
    let mut st = state.try_borrow_mut().ok()?;
    let mut msg = None;

    if st.detecting {
        if let Some((found, cams)) = detected.lock().unwrap().take() {
            st.detecting = false;
            load_cams(ui, &mut st, cams);
            st.strategy = found;
            match found {
                Some(kind) => {
                    ui.status.set_text("Ready");
                    ui.engine.set_text(core::label(kind));
                    ui.rec.set_enabled(true);
                }
                None => {
                    ui.status.set_text("Cannot record");
                    msg = Some(Msg::Error("No working screen capture method was found. Make sure ffmpeg.exe is in the same folder as StreamForgeRec.exe.".into()));
                }
            }
        } else {
            ui.status.set_text("Checking graphics card…");
        }
    }

    let disk = core::disk(&st.dir);
    if let Some(d) = &disk {
        ui.disk.set_text(&format!("Disk: {:.0}% used, {} free (stops at {:.0}%)", d.used * 100.0, core::fmt_gb(d.free_bytes), core::DISK_LIMIT * 100.0));
    } else {
        ui.disk.set_text("Disk: unknown");
    }

    if st.rec.is_some() {
        let alive = st.rec.as_mut().map(|r| r.alive()).unwrap_or(false);
        let secs = st.rec.as_ref().map(|r| r.started.elapsed().as_secs_f64()).unwrap_or(0.0);
        if !alive {
            let log = st.rec.as_ref().map(|r| r.error_log()).unwrap_or_default();
            finish_recording(ui, &mut st);
            msg = Some(Msg::Error(format!("Recording stopped unexpectedly after {}.\n\n{log}", core::fmt_time(secs))));
        } else if disk.as_ref().map(|d| d.used >= core::DISK_LIMIT).unwrap_or(false) {
            finish_recording(ui, &mut st);
            msg = Some(Msg::Error(format!("Recording was stopped and saved.\n\n{}", disk_full_msg(disk.map(|d| d.used).unwrap_or(1.0)))));
        } else {
            ui.status.set_text(&format!("REC  {}", core::fmt_time(secs)));
        }
    }

    let mut finished = None;
    if let Some((ex, name)) = &st.export {
        let mut e = ex.lock().unwrap();
        ui.bar.set_pos((e.progress * 100.0) as u32);
        if let Some(res) = e.done.take() {
            finished = Some((res, *name));
        }
    }
    if let Some((res, name)) = finished {
        st.export = None;
        ui.bar.set_pos(0);
        ui.status.set_text("Ready");
        set_exports(ui, st.last.is_some());
        ui.rec.set_enabled(st.strategy.is_some());
        msg = Some(match res {
            Ok(path) => Msg::Info(format!("Export finished: {name}\n\n{}", path.display())),
            Err(e) => Msg::Error(format!("Export failed: {name}\n\n{e}")),
        });
    }
    msg
}

fn export(ui: &Ui, state: &RefCell<State>, i: usize) -> Option<Msg> {
    let mut st = state.try_borrow_mut().ok()?;
    if st.rec.is_some() || st.export.is_some() {
        return None;
    }
    let master = st.last.clone()?;
    let kind = st.strategy.unwrap_or("x264");
    st.export = Some((core::start_export(master, PRESETS[i], kind.to_string()), PRESETS[i].label));
    set_exports(ui, false);
    ui.rec.set_enabled(false);
    ui.status.set_text("Exporting…");
    None
}

pub fn run() {
    nwg::init().expect("init");
    let _ = nwg::Font::set_global_family("Segoe UI");
    let mut ui = Ui::default();
    build(&mut ui).expect("window");
    let ui = Rc::new(ui);

    let state = Rc::new(RefCell::new(State { dir: core::output_dir(), strategy: None, detecting: true, sources: Vec::new(), mics: Vec::new(), cams: Vec::new(), rec: None, last: None, export: None }));

    {
        let mut st = state.borrow_mut();
        load_sources(&ui, &mut st);
        load_mics(&ui, &mut st);
        load_cams(&ui, &mut st, Vec::new());
    }

    // Trial-run the capture strategies and list cameras off the UI thread.
    let detected: Detected = Arc::new(Mutex::new(None));
    {
        let d = detected.clone();
        std::thread::spawn(move || {
            let found = core::detect_strategy();
            *d.lock().unwrap() = Some((found, core::list_cameras()));
        });
    }

    // F9 works while a game has focus.
    const WM_HOTKEY: u32 = 0x0312;
    if let Some(hwnd) = ui.window.handle.hwnd() {
        unsafe {
            winapi::um::winuser::RegisterHotKey(hwnd, 1, 0, winapi::um::winuser::VK_F9 as u32);
        }
    }
    let (ui_h, st_h) = (ui.clone(), state.clone());
    let _raw = nwg::bind_raw_event_handler(&ui.window.handle, 0x1_0001, move |_hwnd, m, _w, _l| {
        if m == WM_HOTKEY {
            let msg = toggle(&ui_h, &st_h);
            show(&ui_h, msg);
        }
        None
    });

    let (ui_e, st_e) = (ui.clone(), state.clone());
    let _handler = nwg::full_bind_event_handler(&ui.window.handle, move |evt, _data, handle| {
        use nwg::Event as E;
        let msg = match evt {
            E::OnTimerTick if handle == ui_e.timer.handle => tick(&ui_e, &st_e, &detected),
            E::OnButtonClick if handle == ui_e.rec.handle => toggle(&ui_e, &st_e),
            E::OnButtonClick if handle == ui_e.refresh.handle => {
                if let Ok(mut st) = st_e.try_borrow_mut() {
                    load_sources(&ui_e, &mut st);
                    load_mics(&ui_e, &mut st);
                    let cams = core::list_cameras();
                    load_cams(&ui_e, &mut st, cams);
                }
                None
            }
            E::OnButtonClick if handle == ui_e.folder.handle => {
                let dir = st_e.borrow().dir.clone();
                let _ = std::process::Command::new("explorer").arg(dir).spawn();
                None
            }
            E::OnButtonClick => match ui_e.exports.iter().position(|b| handle == b.handle) {
                Some(i) => export(&ui_e, &st_e, i),
                None => None,
            },
            E::OnWindowClose if handle == ui_e.window.handle => {
                // never leave a recording running or unfinished
                if let Ok(mut st) = st_e.try_borrow_mut() {
                    finish_recording(&ui_e, &mut st);
                }
                nwg::stop_thread_dispatch();
                None
            }
            _ => None,
        };
        show(&ui_e, msg); // shown after all state borrows are released
    });

    nwg::dispatch_thread_events();
}
