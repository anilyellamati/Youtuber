package com.streamforge.screenrec

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class StartArgs {
    var height: Int = 720
    var fps: Int = 30
    var bitrate: Int = 6_000_000
    var camera: Boolean = true
    var cameraShape: String = "circle"
    var cameraSize: Float = 0.28f
    var mic: Boolean = true
}

@TauriPlugin
class ScreenRecPlugin(private val activity: Activity) : Plugin(activity) {
    private var pendingArgs: StartArgs? = null
    private var stopInvoke: Invoke? = null

    @Command
    fun start(invoke: Invoke) {
        val args = invoke.parseArgs(StartArgs::class.java)

        val needed = mutableListOf<String>()
        if (args.mic) needed += Manifest.permission.RECORD_AUDIO
        if (args.camera) needed += Manifest.permission.CAMERA
        if (Build.VERSION.SDK_INT >= 33) needed += Manifest.permission.POST_NOTIFICATIONS
        val missing = needed.filter { ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(activity, missing.toTypedArray(), 4711)
            invoke.reject("Allow camera, microphone and notifications, then press Record again.")
            return
        }
        if (args.camera && !Settings.canDrawOverlays(activity)) {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}"))
            )
            invoke.reject("Allow \"Display over other apps\" so your facecam bubble can float over the game, then press Record again.")
            return
        }

        pendingArgs = args
        val mpm = activity.getSystemService(MediaProjectionManager::class.java)
        startActivityForResult(invoke, mpm.createScreenCaptureIntent(), "onProjectionResult")
    }

    @ActivityCallback
    fun onProjectionResult(invoke: Invoke, result: ActivityResult) {
        val args = pendingArgs ?: StartArgs()
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.reject("Screen capture permission was denied")
            return
        }
        val intent = Intent(activity, ScreenRecService::class.java).apply {
            action = ScreenRecService.ACTION_START
            putExtra(ScreenRecService.EXTRA_RESULT_CODE, result.resultCode)
            putExtra(ScreenRecService.EXTRA_DATA, data)
            putExtra("height", args.height)
            putExtra("fps", args.fps)
            putExtra("bitrate", args.bitrate)
            putExtra("camera", args.camera)
            putExtra("cameraShape", args.cameraShape)
            putExtra("cameraSize", args.cameraSize)
            putExtra("mic", args.mic)
        }
        ContextCompat.startForegroundService(activity, intent)
        // Send the user back to their game: the recording continues in the background.
        activity.moveTaskToBack(true)
        invoke.resolve(JSObject().put("started", true))
    }

    @Command
    fun stop(invoke: Invoke) {
        if (!ScreenRecService.running) {
            val path = ScreenRecService.lastPath
            if (path != null) invoke.resolve(JSObject().put("path", path)) else invoke.reject("Not recording")
            return
        }
        stopInvoke = invoke
        ScreenRecService.onStopped = { path, error ->
            activity.runOnUiThread {
                val inv = stopInvoke
                stopInvoke = null
                if (error != null) inv?.reject(error) else inv?.resolve(JSObject().put("path", path))
            }
        }
        activity.startService(Intent(activity, ScreenRecService::class.java).setAction(ScreenRecService.ACTION_STOP))
    }

    @Command
    fun status(invoke: Invoke) {
        invoke.resolve(
            JSObject()
                .put("recording", ScreenRecService.running)
                .put("lastPath", ScreenRecService.lastPath)
                .put("startedAt", ScreenRecService.startedAt)
        )
    }
}
