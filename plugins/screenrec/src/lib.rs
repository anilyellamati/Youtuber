//! Screen recording on phones. Android uses MediaProjection + MediaRecorder in a
//! foreground service and shows the facecam as a floating bubble over the game, so
//! the bubble is part of the captured screen. Desktop builds never register this.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub camera: bool,
    pub camera_shape: String,
    pub camera_size: f32,
    pub mic: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecordingResult {
    pub path: String,
}

pub struct ScreenRec<R: Runtime>(#[allow(dead_code)] PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("screenrec")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let handle = _api.register_android_plugin("com.streamforge.screenrec", "ScreenRecPlugin")?;
            #[cfg(target_os = "ios")]
            let handle: PluginHandle<R> = return Err("Screen recording on iOS requires a ReplayKit broadcast extension".into());
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            let handle: PluginHandle<R> = return Ok(());
            #[allow(unreachable_code)]
            {
                app.manage(ScreenRec(handle));
                Ok(())
            }
        })
        .build()
}
