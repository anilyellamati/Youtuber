// Editor project model + store with undo/redo. Updates are immutable so history is a
// cheap list of snapshots.
import { create } from "zustand";
import { uid } from "../lib/platform";

export type TrackKind = "video" | "audio" | "text";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}

export interface Asset {
  id: string;
  path: string;
  url: string;
  name: string;
  kind: "video" | "audio" | "image";
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumbs: string[]; // filmstrip data urls
}

export interface ColorAdjust {
  brightness: number; // -1..1
  contrast: number; // 0..3
  saturation: number; // 0..3
  hue: number; // degrees
  blur: number; // px at 1080p
}

export type Look = "none" | "cinematic" | "vivid" | "warm" | "cool" | "noir" | "retro" | "fade";
export type TextAnim = "none" | "fade" | "slide-up" | "pop";

export interface TextStyle {
  text: string;
  font: string;
  size: number; // px at 1080p height
  color: string;
  stroke: string;
  strokeWidth: number;
  box: string; // background box colour, "" = none
  bold: boolean;
  anim: TextAnim;
}

export interface Clip {
  id: string;
  trackId: string;
  kind: "media" | "text";
  assetId?: string;
  start: number; // timeline seconds
  in: number; // source seconds
  out: number; // source seconds (text/images: in=0, out=duration)
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  opacity: number;
  x: number; // centre, fraction of frame
  y: number;
  scale: number;
  rotation: number;
  color: ColorAdjust;
  look: Look;
  text?: TextStyle;
}

export interface Project {
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[]; // top of the list = top of the stack
  clips: Clip[];
  assets: Asset[];
  markers: { time: number; label: string }[];
}

export const NEUTRAL_COLOR: ColorAdjust = { brightness: 0, contrast: 1, saturation: 1, hue: 0, blur: 0 };

export const LOOKS: Record<Look, { css: string; ff: string }> = {
  none: { css: "", ff: "" },
  cinematic: { css: "contrast(1.15) saturate(0.85) sepia(0.12)", ff: "eq=contrast=1.15:saturation=0.85:gamma_r=1.03:gamma_b=0.96" },
  vivid: { css: "saturate(1.45) contrast(1.1)", ff: "eq=saturation=1.45:contrast=1.1" },
  warm: { css: "sepia(0.25) saturate(1.2)", ff: "eq=saturation=1.2:gamma_r=1.07:gamma_b=0.92" },
  cool: { css: "hue-rotate(12deg) saturate(1.1)", ff: "eq=saturation=1.1:gamma_r=0.94:gamma_b=1.08" },
  noir: { css: "grayscale(1) contrast(1.3)", ff: "hue=s=0,eq=contrast=1.3" },
  retro: { css: "sepia(0.55) contrast(1.1) saturate(1.3)", ff: "eq=contrast=1.1:saturation=0.55:gamma_r=1.1:gamma_b=0.85" },
  fade: { css: "contrast(0.85) brightness(1.08) saturate(0.8)", ff: "eq=contrast=0.85:brightness=0.04:saturation=0.8" },
};

export const DEFAULT_TEXT: TextStyle = {
  text: "SUBSCRIBE!",
  font: "Impact, 'Arial Black', system-ui, sans-serif",
  size: 96,
  color: "#ffffff",
  stroke: "#000000",
  strokeWidth: 8,
  box: "",
  bold: true,
  anim: "pop",
};

export const clipDuration = (c: Clip) => (c.out - c.in) / c.speed;
export const clipEnd = (c: Clip) => c.start + clipDuration(c);
export const projectDuration = (p: Project) => Math.max(0, ...p.clips.map(clipEnd));

export function newProject(width = 1920, height = 1080, fps = 30): Project {
  return {
    name: "Untitled project",
    width,
    height,
    fps,
    tracks: [
      { id: "T1", kind: "text", name: "Titles", muted: false, hidden: false, locked: false },
      { id: "V2", kind: "video", name: "Overlay", muted: false, hidden: false, locked: false },
      { id: "V1", kind: "video", name: "Main", muted: false, hidden: false, locked: false },
      { id: "A1", kind: "audio", name: "Music", muted: false, hidden: false, locked: false },
      { id: "A2", kind: "audio", name: "Voice / SFX", muted: false, hidden: false, locked: false },
    ],
    clips: [],
    assets: [],
    markers: [],
  };
}

export function makeClip(asset: Asset | null, trackId: string, start: number, text?: TextStyle): Clip {
  const dur = asset ? (asset.kind === "image" ? 5 : asset.duration) : 4;
  return {
    id: uid(),
    trackId,
    kind: text ? "text" : "media",
    assetId: asset?.id,
    start,
    in: 0,
    out: dur,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    x: 0.5,
    y: text ? 0.82 : 0.5,
    scale: 1,
    rotation: 0,
    color: { ...NEUTRAL_COLOR },
    look: "none",
    text,
  };
}

interface EditorState {
  project: Project;
  past: Project[];
  future: Project[];
  selection: string[];
  playhead: number;
  playing: boolean;
  zoom: number; // px per second
  snapping: boolean;
  /** Apply a change and record it in history. */
  commit: (fn: (p: Project) => Project) => void;
  /** Apply a change without history (live drags; call checkpoint() first). */
  mutate: (fn: (p: Project) => Project) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  load: (p: Project) => void;
  select: (ids: string[]) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (b: boolean) => void;
  setZoom: (z: number) => void;
  toggleSnapping: () => void;
}

const HISTORY = 100;

export const useEditor = create<EditorState>((set, get) => ({
  project: newProject(),
  past: [],
  future: [],
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 40,
  snapping: true,
  commit: (fn) => set((s) => ({ past: [...s.past.slice(-HISTORY), s.project], future: [], project: fn(s.project) })),
  mutate: (fn) => set((s) => ({ project: fn(s.project) })),
  checkpoint: () => set((s) => ({ past: [...s.past.slice(-HISTORY), s.project], future: [] })),
  undo: () => {
    const { past, project, future } = get();
    if (!past.length) return;
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future] });
  },
  redo: () => {
    const { past, project, future } = get();
    if (!future.length) return;
    set({ project: future[0], future: future.slice(1), past: [...past, project] });
  },
  load: (project) => set({ project, past: [], future: [], selection: [], playhead: 0 }),
  select: (selection) => set({ selection }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (zoom) => set({ zoom: Math.min(400, Math.max(2, zoom)) }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
}));

// ---------- pure operations ----------

export const updateClip = (p: Project, id: string, patch: Partial<Clip>): Project => ({
  ...p,
  clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
});

export function splitAt(p: Project, ids: string[], t: number): Project {
  const clips: Clip[] = [];
  for (const c of p.clips) {
    if (ids.length && !ids.includes(c.id)) {
      clips.push(c);
      continue;
    }
    if (t <= c.start + 0.02 || t >= clipEnd(c) - 0.02) {
      clips.push(c);
      continue;
    }
    const cut = c.in + (t - c.start) * c.speed;
    clips.push({ ...c, out: cut, fadeOut: 0 });
    clips.push({ ...c, id: uid(), start: t, in: cut, fadeIn: 0 });
  }
  return { ...p, clips };
}

export function deleteClips(p: Project, ids: string[], ripple: boolean): Project {
  let clips = p.clips.filter((c) => !ids.includes(c.id));
  if (ripple) {
    for (const removed of p.clips.filter((c) => ids.includes(c.id))) {
      const d = clipDuration(removed);
      clips = clips.map((c) => (c.trackId === removed.trackId && c.start >= clipEnd(removed) - 0.001 ? { ...c, start: c.start - d } : c));
    }
  }
  return { ...p, clips };
}

/** Next free time on a track (append position). */
export const trackEnd = (p: Project, trackId: string) =>
  Math.max(0, ...p.clips.filter((c) => c.trackId === trackId).map(clipEnd));

/**
 * Jump-cut: replace a clip with the parts that are NOT silent, packed back to back.
 * `silences` are source-time ranges.
 */
export function removeRanges(p: Project, clipId: string, silences: { start: number; end: number }[], pad = 0.15): Project {
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return p;
  const keep: { a: number; b: number }[] = [];
  let cursor = c.in;
  for (const s of silences) {
    const a = Math.max(c.in, s.start + pad), b = Math.min(c.out, s.end - pad);
    if (b - a < 0.3) continue;
    if (a > cursor) keep.push({ a: cursor, b: a });
    cursor = Math.max(cursor, b);
  }
  if (cursor < c.out) keep.push({ a: cursor, b: c.out });
  if (keep.length <= 1 && keep[0]?.a === c.in && keep[0]?.b === c.out) return p;
  const removedDur = clipDuration(c) - keep.reduce((n, k) => n + (k.b - k.a) / c.speed, 0);
  let t = c.start;
  const pieces = keep.map((k) => {
    const piece: Clip = { ...c, id: uid(), start: t, in: k.a, out: k.b, fadeIn: 0, fadeOut: 0 };
    t += (k.b - k.a) / c.speed;
    return piece;
  });
  const after = clipEnd(c);
  const clips = p.clips
    .filter((x) => x.id !== clipId)
    .map((x) => (x.trackId === c.trackId && x.start >= after - 0.001 ? { ...x, start: x.start - removedDur } : x));
  return { ...p, clips: [...clips, ...pieces] };
}

/** Snap a time to clip edges, markers and the playhead within `tol` seconds. */
export function snapTime(p: Project, t: number, tol: number, exclude: string[], playhead: number): number {
  let best = t, bestD = tol;
  const pts = [0, playhead, ...p.markers.map((m) => m.time)];
  for (const c of p.clips) if (!exclude.includes(c.id)) pts.push(c.start, clipEnd(c));
  for (const x of pts) {
    const d = Math.abs(x - t);
    if (d < bestD) {
      bestD = d;
      best = x;
    }
  }
  return best;
}

export function cssFilter(c: Clip): string {
  const parts: string[] = [];
  const { brightness, contrast, saturation, hue, blur } = c.color;
  if (brightness) parts.push(`brightness(${(1 + brightness).toFixed(2)})`);
  if (contrast !== 1) parts.push(`contrast(${contrast.toFixed(2)})`);
  if (saturation !== 1) parts.push(`saturate(${saturation.toFixed(2)})`);
  if (hue) parts.push(`hue-rotate(${hue}deg)`);
  if (blur) parts.push(`blur(${blur}px)`);
  if (LOOKS[c.look].css) parts.push(LOOKS[c.look].css);
  return parts.join(" ") || "none";
}

/** Opacity multiplier from fade in/out at timeline time t. */
export function fadeFactor(c: Clip, t: number): number {
  const local = t - c.start, dur = clipDuration(c);
  let f = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) f = Math.min(f, local / c.fadeIn);
  if (c.fadeOut > 0 && local > dur - c.fadeOut) f = Math.min(f, (dur - local) / c.fadeOut);
  return Math.max(0, Math.min(1, f));
}
