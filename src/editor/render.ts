// Real-time preview renderer: composites the timeline at time t onto a canvas using
// one media element per clip (kept in sync with the playhead) and the GPU-backed
// canvas 2D context. The same drawing code renders text overlays for export.
import { clipDuration, clipEnd, cssFilter, fadeFactor, type Asset, type Clip, type Project, type TextStyle } from "./model";

type Media = HTMLVideoElement | HTMLImageElement;

export class PreviewEngine {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private els = new Map<string, Media>(); // by clip id
  private audioCtx: AudioContext | null = null;
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private routed = new WeakSet<HTMLMediaElement>();

  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;
  }

  private element(clip: Clip, asset: Asset): Media {
    let el = this.els.get(clip.id);
    if (el && (el as HTMLVideoElement).dataset.src === asset.url) return el;
    if (asset.kind === "image") {
      const img = new Image();
      img.src = asset.url;
      img.dataset.src = asset.url;
      el = img;
    } else {
      const v = document.createElement("video");
      v.preload = "auto";
      v.playsInline = true;
      v.crossOrigin = "anonymous";
      v.src = asset.url;
      v.dataset.src = asset.url;
      el = v;
      if (this.audioDest) this.route(v);
    }
    this.els.set(clip.id, el);
    return el;
  }

  /** Routes all media audio into a MediaStream (used by the real-time web export). */
  captureAudio(): MediaStream {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: 48000 });
      this.audioDest = this.audioCtx.createMediaStreamDestination();
    }
    for (const el of this.els.values()) if (el instanceof HTMLVideoElement) this.route(el);
    return this.audioDest!.stream;
  }

  private route(v: HTMLVideoElement) {
    if (this.routed.has(v) || !this.audioCtx || !this.audioDest) return;
    const src = this.audioCtx.createMediaElementSource(v);
    src.connect(this.audioDest);
    src.connect(this.audioCtx.destination);
    this.routed.add(v);
  }

  /** Drop elements for clips that no longer exist. */
  prune(p: Project) {
    const ids = new Set(p.clips.map((c) => c.id));
    for (const [id, el] of this.els) {
      if (!ids.has(id)) {
        if (el instanceof HTMLVideoElement) {
          el.pause();
          el.removeAttribute("src");
          el.load();
        }
        this.els.delete(id);
      }
    }
  }

  pauseAll() {
    for (const el of this.els.values()) if (el instanceof HTMLVideoElement) el.pause();
  }

  render(p: Project, t: number, playing: boolean, selection: string[] = []) {
    const { ctx } = this;
    if (this.canvas.width !== p.width || this.canvas.height !== p.height) {
      this.canvas.width = p.width;
      this.canvas.height = p.height;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, p.width, p.height);
    const assets = new Map(p.assets.map((a) => [a.id, a]));
    // bottom track first
    const order = [...p.tracks].reverse();
    for (const track of order) {
      const clips = p.clips.filter((c) => c.trackId === track.id);
      for (const c of clips) {
        const active = t >= c.start && t < clipEnd(c);
        if (c.kind === "text") {
          if (active && !track.hidden && c.text) drawText(ctx, c, c.text, t, p.width, p.height);
          continue;
        }
        const asset = c.assetId ? assets.get(c.assetId) : undefined;
        if (!asset) continue;
        const el = this.element(c, asset);
        if (el instanceof HTMLVideoElement) this.sync(el, c, t, active && playing, active, track.muted || track.kind === "text");
        if (!active || track.hidden || track.kind === "audio" || asset.kind === "audio") continue;
        const ready = el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
        if (!ready) continue;
        this.drawMedia(c, el, t, p.width, p.height);
      }
    }
    // selection outline
    for (const id of selection) {
      const c = p.clips.find((x) => x.id === id);
      if (!c || c.kind !== "media" || t < c.start || t >= clipEnd(c)) continue;
      const a = assets.get(c.assetId!);
      if (!a || a.kind === "audio") continue;
      const r = mediaRect(c, a.width || p.width, a.height || p.height, p.width, p.height);
      ctx.save();
      ctx.translate(r.cx, r.cy);
      ctx.rotate((c.rotation * Math.PI) / 180);
      ctx.strokeStyle = "rgba(255,61,110,.9)";
      ctx.lineWidth = Math.max(2, p.width / 640);
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);
      ctx.restore();
    }
  }

  private sync(v: HTMLVideoElement, c: Clip, t: number, play: boolean, active: boolean, muted: boolean) {
    const src = c.in + (t - c.start) * c.speed;
    v.volume = Math.max(0, Math.min(1, c.volume * fadeFactor(c, t)));
    v.muted = muted || c.volume === 0;
    if (play) {
      if (v.playbackRate !== c.speed) v.playbackRate = c.speed;
      if (Math.abs(v.currentTime - src) > 0.3) v.currentTime = src;
      if (v.paused) void v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (active && Math.abs(v.currentTime - src) > 1 / 30) v.currentTime = src;
    }
  }

  private drawMedia(c: Clip, el: Media, t: number, W: number, H: number) {
    const iw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const ih = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    const r = mediaRect(c, iw, ih, W, H);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = c.opacity * fadeFactor(c, t);
    ctx.filter = cssFilter(c);
    ctx.translate(r.cx, r.cy);
    ctx.rotate((c.rotation * Math.PI) / 180);
    ctx.drawImage(el, -r.w / 2, -r.h / 2, r.w, r.h);
    ctx.restore();
  }
}

/** Contain-fit inside the frame, then scaled and centred at (x, y). */
export function mediaRect(c: Clip, iw: number, ih: number, W: number, H: number) {
  const fit = Math.min(W / (iw || W), H / (ih || H));
  const w = (iw || W) * fit * c.scale;
  const h = (ih || H) * fit * c.scale;
  return { cx: c.x * W, cy: c.y * H, w, h };
}

/** Animation state for a text clip at time t. */
function textAnim(c: Clip, s: TextStyle, t: number) {
  const local = t - c.start, dur = clipDuration(c), d = 0.35;
  const inP = Math.min(1, local / d), outP = Math.min(1, (dur - local) / d);
  const p = Math.min(inP, outP);
  const ease = 1 - Math.pow(1 - Math.max(0, p), 3);
  switch (s.anim) {
    case "fade":
      return { alpha: ease, dy: 0, scale: 1 };
    case "slide-up":
      return { alpha: ease, dy: (1 - ease) * 60, scale: 1 };
    case "pop": {
      const over = inP < 1 ? 1 + Math.sin(inP * Math.PI) * 0.18 : 1;
      return { alpha: Math.min(1, p * 3), dy: 0, scale: (0.6 + 0.4 * ease) * over };
    }
    default:
      return { alpha: 1, dy: 0, scale: 1 };
  }
}

export function drawText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  c: Clip,
  s: TextStyle,
  t: number | null,
  W: number,
  H: number,
) {
  const k = H / 1080;
  const a = t == null ? { alpha: 1, dy: 0, scale: 1 } : textAnim(c, s, t);
  const size = s.size * k * c.scale;
  const lines = s.text.split("\n");
  ctx.save();
  ctx.globalAlpha = c.opacity * a.alpha;
  ctx.translate(c.x * W, c.y * H + a.dy * k);
  ctx.rotate((c.rotation * Math.PI) / 180);
  ctx.scale(a.scale, a.scale);
  ctx.font = `${s.bold ? "900" : "600"} ${size}px ${s.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const lh = size * 1.12;
  const top = (-(lines.length - 1) * lh) / 2;
  if (s.box) {
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 0.8;
    const h = lines.length * lh + size * 0.35;
    ctx.fillStyle = s.box;
    ctx.beginPath();
    ctx.roundRect(-w / 2, top - lh / 2 - size * 0.18, w, h, size * 0.2);
    ctx.fill();
  }
  lines.forEach((line, i) => {
    const y = top + i * lh;
    if (s.strokeWidth > 0) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth * k * c.scale;
      ctx.strokeText(line, 0, y);
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, 0, y);
  });
  ctx.restore();
}

/** Builds filmstrip thumbnails for a video asset (one every ~duration/count seconds). */
export async function makeThumbs(url: string, duration: number, count = 12): Promise<string[]> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  v.src = url;
  await new Promise<void>((res, rej) => {
    v.onloadeddata = () => res();
    v.onerror = () => rej(new Error("cannot decode video"));
  });
  const c = document.createElement("canvas");
  c.height = 54;
  c.width = Math.round((54 * (v.videoWidth || 16)) / (v.videoHeight || 9));
  const ctx = c.getContext("2d")!;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, (duration * (i + 0.5)) / count);
    await new Promise<void>((res) => {
      const done = () => res();
      v.onseeked = done;
      setTimeout(done, 1500);
      v.currentTime = Math.max(0, t);
    });
    ctx.drawImage(v, 0, 0, c.width, c.height);
    out.push(c.toDataURL("image/jpeg", 0.6));
  }
  v.removeAttribute("src");
  v.load();
  return out;
}

export async function probeElement(url: string, kind: "video" | "audio" | "image") {
  if (kind === "image") {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { duration: 5, width: img.naturalWidth, height: img.naturalHeight };
  }
  const v = document.createElement("video");
  v.preload = "metadata";
  v.src = url;
  await new Promise<void>((res, rej) => {
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error("Unsupported media"));
  });
  // MediaRecorder WebM files report Infinity until the end is seeked
  if (!isFinite(v.duration)) {
    v.currentTime = 1e9;
    await new Promise((r) => (v.ontimeupdate = r));
  }
  return { duration: isFinite(v.duration) ? v.duration : 0, width: v.videoWidth, height: v.videoHeight };
}
