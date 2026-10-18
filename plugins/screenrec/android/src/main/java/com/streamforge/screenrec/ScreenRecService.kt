package com.streamforge.screenrec

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Outline
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Foreground service that owns the MediaProjection, the MediaRecorder and the floating
 * facecam bubble. Because the bubble is a real window on screen, MediaProjection
 * captures it together with the game — no compositing step needed on the phone.
 */
class ScreenRecService : LifecycleService() {
    companion object {
        const val ACTION_START = "com.streamforge.screenrec.START"
        const val ACTION_STOP = "com.streamforge.screenrec.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        private const val CHANNEL = "streamforge_recording"
        private const val NOTIFICATION_ID = 7341

        @Volatile var running = false
        @Volatile var lastPath: String? = null
        @Volatile var startedAt: Long = 0
        var onStopped: ((String?, String?) -> Unit)? = null
    }

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var recorder: MediaRecorder? = null
    private var bubble: View? = null
    private var outputPath: String? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_START -> start(intent)
            ACTION_STOP -> stopRecording(null)
        }
        return START_NOT_STICKY
    }

    private fun start(intent: Intent) {
        val camera = intent.getBooleanExtra("camera", true)
        val mic = intent.getBooleanExtra("mic", true)
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (Build.VERSION.SDK_INT >= 30) {
            if (camera) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            if (mic) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification(), type)
        else startForeground(NOTIFICATION_ID, notification())

        try {
            val mpm = getSystemService(MediaProjectionManager::class.java)
            @Suppress("DEPRECATION")
            val data: Intent = intent.getParcelableExtra(EXTRA_DATA)!!
            val proj = mpm.getMediaProjection(intent.getIntExtra(EXTRA_RESULT_CODE, 0), data)
            projection = proj
            proj.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    if (running) stopRecording(null)
                }
            }, Handler(Looper.getMainLooper()))

            // Size: keep the phone's aspect ratio, scale the short side to the requested height.
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            (getSystemService(WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(metrics)
            val shortSide = minOf(metrics.widthPixels, metrics.heightPixels)
            val scale = minOf(1f, intent.getIntExtra("height", 720).toFloat() / shortSide)
            val w = even((metrics.widthPixels * scale).toInt())
            val h = even((metrics.heightPixels * scale).toInt())

            val dir = getExternalFilesDir(Environment.DIRECTORY_MOVIES) ?: filesDir
            val stamp = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())
            val file = File(dir, "Recording_$stamp.mp4")
            outputPath = file.absolutePath

            val rec = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
            if (mic) rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setVideoSource(MediaRecorder.VideoSource.SURFACE)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setOutputFile(file.absolutePath)
            rec.setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            rec.setVideoSize(w, h)
            rec.setVideoFrameRate(intent.getIntExtra("fps", 30))
            rec.setVideoEncodingBitRate(intent.getIntExtra("bitrate", 6_000_000))
            if (mic) {
                rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                rec.setAudioEncodingBitRate(160_000)
                rec.setAudioSamplingRate(48_000)
            }
            rec.prepare()
            recorder = rec

            display = proj.createVirtualDisplay(
                "StreamForge", w, h, metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, rec.surface, null, null,
            )
            rec.start()
            running = true
            startedAt = System.currentTimeMillis()

            if (camera) showBubble(intent.getStringExtra("cameraShape") ?: "circle", intent.getFloatExtra("cameraSize", 0.28f), shortSide)
        } catch (e: Exception) {
            stopRecording("Could not start recording: ${e.message}")
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun showBubble(shape: String, sizeFraction: Float, shortSide: Int) {
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val size = (shortSide * sizeFraction).toInt()
        val preview = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE // TextureView: clips to outline
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        val frame = FrameLayout(this).apply {
            addView(preview, FrameLayout.LayoutParams(size, size))
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    when (shape) {
                        "square" -> outline.setRect(0, 0, view.width, view.height)
                        "rounded" -> outline.setRoundRect(0, 0, view.width, view.height, view.width * 0.18f)
                        else -> outline.setOval(0, 0, view.width, view.height)
                    }
                }
            }
            elevation = 12f
        }
        val params = WindowManager.LayoutParams(
            size, size,
            if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 24
            y = 160
        }
        // drag to reposition
        var startX = 0; var startY = 0; var touchX = 0f; var touchY = 0f
        frame.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { startX = params.x; startY = params.y; touchX = e.rawX; touchY = e.rawY; true }
                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (e.rawX - touchX).toInt()
                    params.y = startY + (e.rawY - touchY).toInt()
                    wm.updateViewLayout(frame, params)
                    true
                }
                else -> false
            }
        }
        wm.addView(frame, params)
        bubble = frame

        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                val useCase = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, useCase)
            } catch (_: Exception) {
                // no front camera: keep recording without the bubble
                removeBubble()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun removeBubble() {
        bubble?.let { (getSystemService(WINDOW_SERVICE) as WindowManager).removeView(it) }
        bubble = null
        try { ProcessCameraProvider.getInstance(this).get().unbindAll() } catch (_: Exception) {}
    }

    private fun stopRecording(error: String?) {
        var err = error
        try { if (running) recorder?.stop() } catch (e: Exception) { err = err ?: "Recording was too short" }
        recorder?.release(); recorder = null
        display?.release(); display = null
        projection?.stop(); projection = null
        removeBubble()
        running = false
        lastPath = if (err == null) outputPath else null
        onStopped?.invoke(lastPath, err)
        onStopped = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
        }
        val stop = PendingIntent.getService(
            this, 0, Intent(this, ScreenRecService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_IMMUTABLE)
        }
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("StreamForge is recording")
            .setContentText("Tap Stop when you're done")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stop)
            .build()
    }

    private fun even(n: Int) = n - (n % 2)
}
