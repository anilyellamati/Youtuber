mod ffmpeg;
mod files;
mod media;
#[cfg(feature = "youtube")]
mod youtube;
#[cfg(not(feature = "youtube"))]
#[path = "youtube_stub.rs"]
mod youtube;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    media::start();
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_screenrec::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ffmpeg::Jobs::default())
        .invoke_handler(tauri::generate_handler![
            ffmpeg::ffmpeg_info,
            ffmpeg::ffmpeg_list_devices,
            ffmpeg::ffmpeg_probe_encoders,
            ffmpeg::ffmpeg_start,
            ffmpeg::ffmpeg_stop,
            ffmpeg::ffmpeg_run,
            ffmpeg::ffmpeg_analyze,
            ffmpeg::screen_permission,
            ffmpeg::probe_media,
            media::media_base,
            media::selftest_target,
            media::selftest_log,
            media::screen_snapshot,
            files::default_output_dir,
            files::save_chunk,
            files::path_exists,
            files::list_videos,
            files::delete_temp_files,
            files::reveal_in_folder,
            youtube::yt_login,
            youtube::yt_status,
            youtube::yt_logout,
            youtube::yt_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StreamForge");
}
