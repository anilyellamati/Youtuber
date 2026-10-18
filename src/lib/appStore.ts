import { create } from "zustand";

export type View = "record" | "edit" | "publish" | "library" | "settings";
export type RecState = "idle" | "countdown" | "recording" | "paused" | "stopping";

export interface Marker {
  time: number;
  label: string;
}

export interface RecordedVideo {
  path: string; // file path (desktop) or blob: url (browser)
  name: string;
  duration: number;
  markers: Marker[];
  createdAt: number;
}

export interface Channel {
  id: string;
  title: string;
  thumbnail: string;
  subscribers: string;
  videos: string;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

interface AppState {
  view: View;
  recState: RecState;
  lastRecording: RecordedVideo | null;
  /** Video queued for the Publish screen (a recording or an export). */
  publishTarget: RecordedVideo | null;
  /** Recording to open in the editor. */
  editTarget: RecordedVideo | null;
  channel: Channel | null;
  hasNative: boolean;
  encoders: string[];
  toasts: Toast[];
  setView: (v: View) => void;
  patch: (p: Partial<AppState>) => void;
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

export const useApp = create<AppState>((set) => ({
  view: "record",
  recState: "idle",
  lastRecording: null,
  publishTarget: null,
  editTarget: null,
  channel: null,
  hasNative: false,
  encoders: [],
  toasts: [],
  setView: (view) => set({ view }),
  patch: (p) => set(p),
  toast: (text, kind = "info") => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 9000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Actions the recorder registers so global hotkeys can drive it from anywhere. */
export const recorderControls: {
  toggle?: () => void;
  pause?: () => void;
  marker?: () => void;
} = {};
