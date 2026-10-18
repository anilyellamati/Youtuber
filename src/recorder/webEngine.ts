// Web capture engine: getDisplayMedia (screen + game audio) + getUserMedia (facecam +
// mic) composited on a canvas and encoded by the browser's hardware MediaRecorder.
// Chunks stream to disk every second, so a crash loses at most one second.
import { computeLayout, drawCamera, drawScreen, type CameraLayout } from "./layouts";
import { isTauri, writeBytes } from "../lib/platform";

export interface WebRecorderOptions {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  micGain: number;
  systemGain: number;
}

export interface RecordingResult {
  path?: string; // desktop: file on disk
  blob?: Blob; // browser: in-memory
  mime: string;
  duration: number;
  markers: { time: number; label: string }[];
}

export function pickMime(): string {
  const candidates = [
    "video/mp4;codecs=avc1.640028,mp4a.40.2",
    "video/mp4;codecs=avc1,mp4a",
    "video/mp4",
    "video/webm;codecs=h264,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "video/webm";
}

export const extForMime = (mime: string) => (mime.startsWith("video/mp4") ? "mp4" : "webm");

/** A ticker that keeps running when the window is in the background (worker timers are not throttled like rAF). */
function makeTicker(fps: number, cb: () => void) {
  const src = `let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}`;
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  worker.onmessage = cb;
  worker.postMessage(1000 / fps);
  return () => {
    worker.postMessage(0);
    worker.terminate();
  };
}

function videoFor(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  void v.play().catch(() => {});
  return v;
}

/**
 * Owns the sources and the composited canvas. The same instance drives the live
 * preview and (for the web engine) the recording.
 */
export class Compositor {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  screenStream: MediaStream | null = null;
  camStream: MediaStream | null = null;
  micStream: MediaStream | null = null;
  private screenVideo: HTMLVideoElement | null = null;
  private camVideo: HTMLVideoElement | null = null;
  private stopTicker: (() => void) | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf = new Float32Array(1024);
  level = 0;
  layout: CameraLayout;
  placeholder = true; // draw a stand-in game frame when no screen is shared (native engine preview)
  /** Periodic snapshot of the selected display (native engine preview). */
  screenStill: (HTMLImageElement & { videoWidth?: number; videoHeight?: number }) | null = null;

  constructor(public opts: WebRecorderOptions, layout: CameraLayout) {
    this.layout = layout;
    this.canvas = document.createElement("canvas");
    this.canvas.width = opts.width;
    this.canvas.height = opts.height;
    this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })!;
    this.stopTicker = makeTicker(opts.fps, () => this.draw());
  }

  resize(opts: WebRecorderOptions) {
    this.opts = opts;
    if (this.canvas.width !== opts.width || this.canvas.height !== opts.height) {
      this.canvas.width = opts.width;
      this.canvas.height = opts.height;
    }
    this.stopTicker?.();
    this.stopTicker = makeTicker(opts.fps, () => this.draw());
  }

  async setCamera(deviceId: string | null) {
    this.camStream?.getTracks().forEach((t) => t.stop());
    this.camStream = null;
    this.camVideo = null;
    if (deviceId === null) return;
    this.camStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    this.camVideo = videoFor(this.camStream);
  }

  async setMic(deviceId: string | null) {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    if (deviceId === null) return;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.ensureAudio();
    const src = this.audioCtx!.createMediaStreamSource(this.micStream);
    src.connect(this.analyser!);
  }

  /** Must be called from a click (browser requirement). */
  async pickScreen(): Promise<boolean> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: this.opts.fps, max: 60 }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
      // Chromium hints: include game audio, prefer whole screen, keep app out of the capture.
      ...({ systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include", monitorTypeSurfaces: "include" } as object),
    } as DisplayMediaStreamOptions);
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = stream;
    this.screenVideo = videoFor(stream);
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (this.screenStream === stream) {
        this.screenStream = null;
        this.screenVideo = null;
      }
    });
    return stream.getAudioTracks().length > 0;
  }

  get hasScreen() {
    return !!this.screenStream;
  }
  get hasCamera() {
    return !!this.camStream;
  }

  private ensureAudio() {
    if (this.audioCtx) return;
    this.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
  }

  private sampleLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    const rms = Math.sqrt(sum / this.levelBuf.length);
    // smooth attack/release so the glow ring breathes with your voice
    const target = Math.min(1, rms * 6);
    this.level += (target - this.level) * (target > this.level ? 0.5 : 0.12);
    return this.level;
  }

  draw() {
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const rects = computeLayout(this.layout, W, H);
    ctx.fillStyle = "#07060b";
    ctx.fillRect(0, 0, W, H);
    if (rects.screen) {
      if (this.screenVideo && this.screenVideo.readyState >= 2) {
        drawScreen(ctx, this.screenVideo, rects.screen, rects.screenCover);
      } else if (this.screenStill && this.placeholder) {
        drawScreen(ctx, this.screenStill, rects.screen, rects.screenCover);
      } else if (this.placeholder) {
        drawPlaceholder(ctx, rects.screen);
      }
    }
    const level = this.sampleLevel();
    if (rects.camera) {
      if (this.camVideo && this.camVideo.readyState >= 2) {
        drawCamera(ctx, this.camVideo, this.layout, rects.camera, this.layout.borderGlow ? level : 0);
      } else if (this.placeholder) {
        drawCamPlaceholder(ctx, this.layout, rects.camera);
      }
    }
  }

  /** Mixed output stream: canvas video + (game audio, mic) mixed through WebAudio. */
  outputStream(): MediaStream {
    this.ensureAudio();
    const ac = this.audioCtx!;
    void ac.resume();
    const dest = ac.createMediaStreamDestination();
    const add = (stream: MediaStream | null, gain: number) => {
      if (!stream || !stream.getAudioTracks().length) return;
      const g = ac.createGain();
      g.gain.value = gain;
      ac.createMediaStreamSource(stream).connect(g).connect(dest);
    };
    add(this.screenStream, this.opts.systemGain);
    add(this.micStream, this.opts.micGain);
    const video = this.canvas.captureStream(this.opts.fps).getVideoTracks()[0];
    return new MediaStream([video, ...dest.stream.getAudioTracks()]);
  }

  dispose() {
    this.stopTicker?.();
    for (const s of [this.screenStream, this.camStream, this.micStream]) s?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
  }
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }) {
  const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
  g.addColorStop(0, "#1b1035");
  g.addColorStop(1, "#0d1b2e");
  ctx.fillStyle = g;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 2;
  const step = Math.max(40, r.w / 24);
  for (let x = r.x; x < r.x + r.w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `600 ${Math.round(r.h / 22)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("Your gameplay appears here", r.x + r.w / 2, r.y + r.h / 2);
  ctx.textAlign = "start";
}

let fakeCam: HTMLCanvasElement | null = null;
function drawCamPlaceholder(ctx: CanvasRenderingContext2D, l: CameraLayout, r: { x: number; y: number; w: number; h: number }) {
  if (!fakeCam) fakeCam = makeFakeCam();
  drawCamera(ctx, Object.assign(fakeCam, { videoWidth: 320, videoHeight: 240 }), { ...l, mirror: false, filter: "none" }, r);
}

function makeFakeCam() {
  const fake = document.createElement("canvas");
  fake.width = 320;
  fake.height = 240;
  const f = fake.getContext("2d")!;
  f.fillStyle = "#2a1e4a";
  f.fillRect(0, 0, 320, 240);
  f.fillStyle = "#ffb86b";
  f.beginPath();
  f.arc(160, 105, 48, 0, Math.PI * 2);
  f.fill();
  f.beginPath();
  f.ellipse(160, 250, 100, 70, 0, 0, Math.PI * 2);
  f.fill();
  return fake;
}

/** Records a Compositor's output with MediaRecorder, streaming chunks to `path`. */
export class WebRecording {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private first = true;
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  markers: { time: number; label: string }[] = [];
  readonly mime: string;
  writeError: string | null = null;

  constructor(comp: Compositor, private path: string | undefined) {
    this.mime = pickMime();
    this.rec = new MediaRecorder(comp.outputStream(), {
      mimeType: this.mime,
      videoBitsPerSecond: comp.opts.kbps * 1000,
      audioBitsPerSecond: 160_000,
    });
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      if (isTauri && this.path) {
        const append = !this.first;
        this.first = false;
        this.writeChain = this.writeChain.then(() =>
          writeBytes(this.path!, e.data, append).catch((err) => {
            this.writeError = String(err);
          }),
        );
      } else {
        this.chunks.push(e.data);
      }
    };
  }

  start() {
    this.startedAt = performance.now();
    this.rec.start(1000);
  }

  get elapsed() {
    const now = this.rec.state === "paused" ? this.pausedAt : performance.now();
    return Math.max(0, (now - this.startedAt - this.pausedTotal) / 1000);
  }

  pause() {
    if (this.rec.state !== "recording") return;
    this.rec.pause();
    this.pausedAt = performance.now();
  }

  resume() {
    if (this.rec.state !== "paused") return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.rec.resume();
  }

  get paused() {
    return this.rec.state === "paused";
  }

  addMarker(label?: string) {
    this.markers.push({ time: this.elapsed, label: label || `Moment ${this.markers.length + 1}` });
  }

  stop(): Promise<RecordingResult> {
    const duration = this.elapsed;
    return new Promise((resolve) => {
      this.rec.onstop = async () => {
        this.rec.stream.getTracks().forEach((t) => {
          if (t.kind === "audio") t.stop();
        });
        await this.writeChain;
        resolve({
          path: isTauri ? this.path : undefined,
          blob: isTauri ? undefined : new Blob(this.chunks, { type: this.mime }),
          mime: this.mime,
          duration,
          markers: this.markers,
        });
      };
      this.rec.stop();
    });
  }
}
