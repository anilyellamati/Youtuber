//! The whole interface: one small native Win32 window. No preview, no web engine;
//! a 500 ms timer updates the clock, watches the disk and polls the export.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use native_windows_gui as nwg;

use crate::core::{self, ExportState, Recording, PRESETS};

#[derive(Default)]
struct Ui {
    window: nwg::Window,
    big: nwg::Font,
    status: nwg::Label,
    disk: nwg::Label,
    sys: nwg::CheckBox,
    mic: nwg::CheckBox,
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
    rec: Option<Recording>,
    last: Option<PathBuf>,
    export: Option<(Arc<Mutex<ExportState>>, &'static str)>,
}

enum Msg {
    Info(String),
    Error(String),
}

fn build(ui: &mut Ui) -> Result<(), nwg::NwgError> {
    nwg::Font::builder().family("Segoe UI").size(26).weight(700).build(&mut ui.big)?;
    nwg::Window::builder()
        .size((460, 372))
        .position((320, 220))
        .title("StreamForge Rec")
        .flags(nwg::WindowFlags::WINDOW | nwg::WindowFlags::VISIBLE | nwg::WindowFlags::MINIMIZE_BOX)
        .build(&mut ui.window)?;
    let w = &ui.window;
    nwg::Label::builder().text("Starting…").position((20, 12)).size((420, 34)).font(Some(&ui.big)).parent(w).build(&mut ui.status)?;
    nwg::Label::builder().text("").position((20, 50)).size((420, 20)).parent(w).build(&mut ui.disk)?;
    nwg::CheckBox::builder().text("Record computer sound").position((20, 78)).size((200, 22)).check_state(nwg::CheckBoxState::Checked).parent(w).build(&mut ui.sys)?;
    nwg::CheckBox::builder().text("Record microphone").position((240, 78)).size((200, 22)).check_state(nwg::CheckBoxState::Checked).parent(w).build(&mut ui.mic)?;
    nwg::Button::builder().text("Start recording  (F9)").position((20, 108)).size((420, 48)).enabled(false).parent(w).build(&mut ui.rec)?;
    nwg::Label::builder().text("Export: record something first.").position((20, 172)).size((420, 20)).parent(w).build(&mut ui.last)?;
    let spots = [(20, 198), (235, 198), (20, 238), (235, 238)];
    for (i, b) in ui.exports.iter_mut().enumerate() {
        nwg::Button::builder().text(PRESETS[i].label).position(spots[i]).size((205, 34)).enabled(false).parent(w).build(b)?;
    }
    nwg::ProgressBar::builder().range(0..100).pos(0).position((20, 284)).size((420, 14)).parent(w).build(&mut ui.bar)?;
    nwg::Button::builder().text("Open recordings folder").position((20, 310)).size((170, 28)).parent(w).build(&mut ui.folder)?;
    nwg::Label::builder().text("").position((200, 315)).size((240, 20)).parent(w).build(&mut ui.engine)?;
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
        ui.last.set_text(&format!("Export last recording ({}):", core::fmt_time(secs)));
        st.last = Some(path);
        ui.rec.set_text("Start recording  (F9)");
        ui.status.set_text("Ready");
        ui.sys.set_enabled(true);
        ui.mic.set_enabled(true);
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
    let mic = ui.mic.check_state() == nwg::CheckBoxState::Checked;
    match Recording::start(&st.dir, kind, sys, mic) {
        Ok(rec) => {
            st.rec = Some(rec);
            ui.rec.set_text("Stop recording  (F9)");
            ui.sys.set_enabled(false);
            ui.mic.set_enabled(false);
            set_exports(ui, false);
            None
        }
        Err(e) => Some(Msg::Error(e)),
    }
}

fn tick(ui: &Ui, state: &RefCell<State>, detected: &Arc<Mutex<Option<Option<&'static str>>>>) -> Option<Msg> {
    let mut st = state.try_borrow_mut().ok()?;
    let mut msg = None;

    if st.detecting {
        if let Some(found) = detected.lock().unwrap().take() {
            st.detecting = false;
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
        ui.disk.set_text(&format!("Disk: {:.0}% used, {} free", d.used * 100.0, core::fmt_gb(d.free_bytes)));
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

    let state = Rc::new(RefCell::new(State { dir: core::output_dir(), strategy: None, detecting: true, rec: None, last: None, export: None }));

    // Trial-run the capture strategies off the UI thread (a few seconds on first start).
    let detected: Arc<Mutex<Option<Option<&'static str>>>> = Arc::new(Mutex::new(None));
    {
        let d = detected.clone();
        std::thread::spawn(move || {
            let found = core::detect_strategy();
            *d.lock().unwrap() = Some(found);
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
