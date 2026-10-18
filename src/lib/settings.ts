import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CameraLayout } from "../recorder/layouts";
import { DEFAULT_LAYOUT } from "../recorder/layouts";
import { isWindows } from "./platform";

export type Engine = "auto" | "native" | "web";

export interface QualityPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
  hint: string;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  { id: "potato", label: "Low-spec 720p30", width: 1280, height: 720, fps: 30, kbps: 4500, hint: "Old/x86 laptops, integrated GPUs" },
  { id: "balanced", label: "1080p30", width: 1920, height: 1080, fps: 30, kbps: 8000, hint: "Most PCs" },
  { id: "smooth", label: "1080p60", width: 1920, height: 1080, fps: 60, kbps: 12000, hint: "Fast-paced games" },
  { id: "qhd", label: "1440p60", width: 2560, height: 1440, fps: 60, kbps: 24000, hint: "YouTube serves VP9/AV1 at 1440p+" },
  { id: "shorts", label: "Shorts 1080×1920", width: 1080, height: 1920, fps: 60, kbps: 10000, hint: "Vertical for YouTube Shorts" },
];

export interface SeoProfile {
  channelName: string;
  socials: string; // multi-line "Twitch: …"
  defaultHashtags: string; // "#gaming #letsplay"
  defaultTags: string; // comma-separated
  descriptionFooter: string;
  titleTemplate: string;
  privacy: "public" | "unlisted" | "private";
  language: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
  episodeCounters: Record<string, number>; // per game
}

export interface Hotkeys {
  toggleRecord: string;
  pause: string;
  marker: string;
}

export interface Settings {
  outputDir: string;
  engine: Engine;
  encoder: string; // "auto" or an ffmpeg encoder name
  quality: string; // QualityPreset id
  layout: CameraLayout;
  screenId: string;
  cameraId: string; // native: device id; web: deviceId
  micId: string;
  systemAudioId: string; // native loopback device (e.g. BlackHole / Stereo Mix)
  micGain: number;
  systemGain: number;
  countdown: number;
  autoOpenEditor: boolean;
  googleClientId: string;
  googleClientSecret: string;
  anthropicKey: string;
  seo: SeoProfile;
  hotkeys: Hotkeys;
  set: (patch: Partial<Settings>) => void;
  setLayout: (patch: Partial<CameraLayout>) => void;
  setSeo: (patch: Partial<SeoProfile>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      outputDir: "",
      engine: "auto",
      encoder: "auto",
      quality: "balanced",
      layout: DEFAULT_LAYOUT,
      screenId: "",
      cameraId: "",
      micId: "",
      systemAudioId: "",
      micGain: 1,
      systemGain: 0.8,
      countdown: 3,
      autoOpenEditor: false,
      googleClientId: "",
      googleClientSecret: "",
      anthropicKey: "",
      seo: {
        channelName: "",
        socials: "",
        defaultHashtags: "#gaming #gameplay",
        defaultTags: "gaming, gameplay, let's play",
        descriptionFooter: "👍 Like & subscribe for more!",
        titleTemplate: "{game} {type} #{episode} | {hook}",
        privacy: "public",
        language: "en",
        madeForKids: false,
        notifySubscribers: true,
        episodeCounters: {},
      },
      hotkeys: { toggleRecord: "F9", pause: "F10", marker: "F8" },
      set: (patch) => set(patch),
      setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),
      setSeo: (patch) => set((s) => ({ seo: { ...s.seo, ...patch } })),
    }),
    {
      name: "streamforge-settings",
      version: 1,
      partialize: ({ set: _a, setLayout: _b, setSeo: _c, ...rest }) => rest,
    },
  ),
);

export function qualityPreset(id: string): QualityPreset {
  return QUALITY_PRESETS.find((q) => q.id === id) ?? QUALITY_PRESETS[1];
}

/**
 * Engine choice. On Windows the web engine (WebView2 = Chromium) captures game audio
 * natively via getDisplayMedia; on macOS the native FFmpeg/AVFoundation path is more
 * reliable than WKWebView screen capture.
 */
export function resolveEngine(engine: Engine, hasNative: boolean): "native" | "web" {
  if (engine !== "auto") return engine === "native" && !hasNative ? "web" : engine;
  if (!hasNative) return "web";
  return isWindows ? "web" : "native";
}
