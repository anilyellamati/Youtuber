// Native capture engine: builds an FFmpeg command that grabs the desktop on the GPU
// (ddagrab on Windows, AVFoundation on macOS), overlays the facecam with an
// alpha mask rendered from the same shape code as the preview, mixes mic + system
// audio and hardware-encodes to a crash-safe fragmented MP4.
import { computeLayout, drawBorder, isBubble, shapePath, CAM_FILTERS_FFMPEG, type CameraLayout } from "./layouts";
import { encoderArgs, audioArgs } from "../lib/encoders";
import { invoke, isMac, isWindows, joinPath, listen, uid, writeBytes } from "../lib/platform";

export interface NativeDevices {
  video: { id: string; name: string }[];
  audio: { id: string; name: string }[];
  screens: { id: string; name: string }[];
}

export interface NativeOptions {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  encoder: string;
  lowSpec: boolean;
  layout: CameraLayout;
  screenId: string;
  cameraId: string; // "" = none
  micId: string;
  systemAudioId: string;
  micGain: number;
  systemGain: number;
  workDir: string;
  windowsCapture?: "ddagrab" | "gdigrab";
}

async function renderPng(w: number, h: number, paint: (ctx: OffscreenCanvasRenderingContext2D) => void, path: string) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  paint(ctx);
  const blob = await c.convertToBlob({ type: "image/png" });
  await writeBytes(path, blob);
}

export async function buildRecordArgs(o: NativeOptions, outPath: string, temps: string[] = []): Promise<string[]> {
  const W = o.width, H = o.height, fps = o.fps;
  const l = { ...o.layout };
  if (!o.cameraId && l.mode !== "screen-only") l.mode = "screen-only";
  const rects = computeLayout(l, W, H);
  const inputs: string[] = [];
  const addInput = (...a: string[]) => inputs.push("-thread_queue_size", "1024", ...a);
  const filters: string[] = [];
  let n = 0;
  let screenIdx = -1, camIdx = -1, maskIdx = -1, ringIdx = -1;
  const audioIdx: { idx: number; gain: number }[] = [];

  // --- video inputs
  if (rects.screen) {
    if (isMac) {
      addInput("-f", "avfoundation", "-capture_cursor", "1", "-framerate", String(fps), "-i", `${o.screenId || "1"}:none`);
    } else if (isWindows && o.windowsCapture !== "gdigrab") {
      addInput("-f", "lavfi", "-i", `ddagrab=output_idx=${o.screenId || 0}:framerate=${fps}:draw_mouse=1,hwdownload,format=bgra`);
    } else if (isWindows) {
      addInput("-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", "1", "-i", "desktop");
    } else {
      addInput("-f", "x11grab", "-framerate", String(fps), "-i", o.screenId || ":0.0");
    }
    screenIdx = n++;
  }
  if (rects.camera && o.cameraId) {
    if (isMac) addInput("-f", "avfoundation", "-framerate", "30", "-i", `${o.cameraId}:none`);
    else if (isWindows) addInput("-f", "dshow", "-rtbufsize", "256M", "-i", `video=${o.cameraId}`);
    else addInput("-f", "v4l2", "-i", o.cameraId);
    camIdx = n++;
  }
  const cam = rects.camera;
  if (cam && camIdx >= 0 && isBubble(l)) {
    const maskPath = joinPath(o.workDir, `.mask_${uid()}.png`);
    temps.push(maskPath);
    await renderPng(cam.w, cam.h, (ctx) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cam.w, cam.h);
      ctx.fillStyle = "#fff";
      shapePath(ctx, l.shape, { x: 0, y: 0, w: cam.w, h: cam.h });
      ctx.fill();
    }, maskPath);
    addInput("-loop", "1", "-framerate", String(fps), "-i", maskPath);
    maskIdx = n++;
    if (l.border > 0 || l.borderGlow) {
      const ringPath = joinPath(o.workDir, `.ring_${uid()}.png`);
      temps.push(ringPath);
      await renderPng(W, H, (ctx) => drawBorder(ctx, l, cam, 0.15), ringPath);
      addInput("-loop", "1", "-framerate", String(fps), "-i", ringPath);
      ringIdx = n++;
    }
  }

  // --- audio inputs
  const addAudio = (id: string, gain: number) => {
    if (!id) return;
    if (isMac) addInput("-f", "avfoundation", "-i", `:${id}`);
    else if (isWindows) addInput("-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${id}`);
    else addInput("-f", "pulse", "-i", id);
    audioIdx.push({ idx: n++, gain });
  };
  addAudio(o.micId, o.micGain);
  addAudio(o.systemAudioId, o.systemGain);

  // --- video graph
  let last = "base";
  const s = rects.screen;
  const fullScreen = !!s && s.x === 0 && s.y === 0 && s.w === W && s.h === H;
  if (s && screenIdx >= 0) {
    const fit = rects.screenCover
      ? `scale=${s.w}:${s.h}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${s.w}:${s.h}`
      : `scale=${s.w}:${s.h}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${s.w}:${s.h}:(ow-iw)/2:(oh-ih)/2:color=0x07060b`;
    if (fullScreen) {
      // gameplay fills the frame: no background canvas to composite onto
      filters.push(`[${screenIdx}:v]fps=${fps},${fit},setsar=1[v1]`);
    } else {
      filters.push(`color=c=0x07060b:s=${W}x${H}:r=${fps}[base]`);
      filters.push(`[${screenIdx}:v]fps=${fps},${fit}[scr]`);
      filters.push(`[base][scr]overlay=${s.x}:${s.y}:shortest=1[v1]`);
    }
    last = "v1";
  } else {
    filters.push(`color=c=0x07060b:s=${W}x${H}:r=${fps}[base]`);
  }
  if (cam && camIdx >= 0) {
    const zw = Math.round((cam.w * l.zoom) / 2) * 2, zh = Math.round((cam.h * l.zoom) / 2) * 2;
    const look = CAM_FILTERS_FFMPEG[l.filter];
    const chain = [
      `fps=${fps}`,
      `scale=${zw}:${zh}:force_original_aspect_ratio=increase`,
      `crop=${cam.w}:${cam.h}`,
      ...(l.mirror ? ["hflip"] : []),
      ...(look ? [look] : []),
    ].join(",");
    if (maskIdx >= 0) {
      filters.push(`[${camIdx}:v]${chain},format=yuva420p[camc]`);
      filters.push(`[${maskIdx}:v]format=gray,scale=${cam.w}:${cam.h}[mask]`);
      filters.push(`[camc][mask]alphamerge[cam]`);
    } else {
      filters.push(`[${camIdx}:v]${chain}[cam]`);
    }
    filters.push(`[${last}][cam]overlay=${cam.x}:${cam.y}:eof_action=repeat[v2]`);
    last = "v2";
    if (ringIdx >= 0) {
      filters.push(`[${last}][${ringIdx}:v]overlay=0:0:shortest=1[v3]`);
      last = "v3";
    }
  }
  filters.push(`[${last}]format=yuv420p[vout]`);

  // --- audio graph
  let audioMap: string[] = [];
  if (audioIdx.length) {
    audioIdx.forEach((a, i) => filters.push(`[${a.idx}:a]aresample=async=1:first_pts=0,aformat=channel_layouts=stereo,volume=${a.gain.toFixed(2)}[a${i}]`));
    if (audioIdx.length === 1) filters.push(`[a0]anull[aout]`);
    else filters.push(`${audioIdx.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audioIdx.length}:normalize=0:dropout_transition=0[aout]`);
    audioMap = ["-map", "[aout]", ...audioArgs];
  }

  return [
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    ...audioMap,
    ...encoderArgs(o.encoder, o.kbps, fps, "record", o.lowSpec),
    "-r", String(fps),
    // fragmented MP4: playable even if the app or PC crashes mid-recording
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "1000000",
    outPath,
  ];
}

/**
 * A native recording session. Pausing closes the current segment; stop() joins all
 * segments losslessly into the final file.
 */
export class NativeRecording {
  private segments: string[] = [];
  private temps: string[] = [];
  private jobId = "";
  private segStart = 0;
  private accumulated = 0;
  private exitWaiters = new Map<string, (r: { code: number | null; log: string }) => void>();
  private unlisten: (() => void) | null = null;
  markers: { time: number; label: string }[] = [];
  paused = false;
  lastError = "";
  onFatal: ((msg: string) => void) | null = null;

  constructor(private opts: NativeOptions, private finalPath: string) {}

  async start() {
    this.unlisten = await listen<{ id: string; code: number | null; log: string }>("ffmpeg://exit", (e) => {
      const w = this.exitWaiters.get(e.id);
      if (w) {
        this.exitWaiters.delete(e.id);
        w(e);
      } else if (e.id === this.jobId && e.code !== 0) {
        this.lastError = e.log;
        this.onFatal?.(e.log);
      }
    });
    await this.startSegment();
  }

  private async startSegment() {
    const path = this.finalPath.replace(/\.mp4$/, `.part${this.segments.length}.mp4`);
    this.segments.push(path);
    this.jobId = `rec-${uid()}`;
    const args = await buildRecordArgs(this.opts, path, this.temps);
    await invoke("ffmpeg_start", { id: this.jobId, args });
    this.segStart = performance.now();
  }

  private stopSegment(): Promise<{ code: number | null; log: string }> {
    const id = this.jobId;
    const done = new Promise<{ code: number | null; log: string }>((res) => this.exitWaiters.set(id, res));
    void invoke("ffmpeg_stop", { id });
    this.accumulated += (performance.now() - this.segStart) / 1000;
    return done;
  }

  get elapsed() {
    return this.accumulated + (this.paused ? 0 : (performance.now() - this.segStart) / 1000);
  }

  addMarker(label?: string) {
    this.markers.push({ time: this.elapsed, label: label || `Moment ${this.markers.length + 1}` });
  }

  async pause() {
    if (this.paused) return;
    this.paused = true;
    await this.stopSegment();
  }

  async resume() {
    if (!this.paused) return;
    this.paused = false;
    await this.startSegment();
  }

  async stop(): Promise<{ path: string; duration: number; markers: { time: number; label: string }[] }> {
    if (!this.paused) await this.stopSegment();
    this.paused = true;
    this.unlisten?.();
    const duration = this.accumulated;
    if (this.segments.length === 1) {
      await invoke("ffmpeg_run", { args: ["-y", "-i", this.segments[0], "-c", "copy", "-movflags", "+faststart", this.finalPath] });
    } else {
      const list = this.segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n");
      const listPath = this.finalPath.replace(/\.mp4$/, ".concat.txt");
      await writeBytes(listPath, new TextEncoder().encode(list));
      await invoke("ffmpeg_run", { args: ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", this.finalPath] });
      this.temps.push(listPath);
    }
    await invoke("delete_temp_files", { paths: [...this.segments, ...this.temps] }).catch(() => {});
    return { path: this.finalPath, duration, markers: this.markers };
  }
}
