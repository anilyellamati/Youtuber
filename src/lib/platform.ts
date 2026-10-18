// Thin layer over Tauri so the UI also runs in a plain browser (dev, PWA, mobile web)
// with graceful fallbacks.
import { invoke as tauriInvoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua);
export const isWindows = /Windows/.test(ua);
export const isMobile = /Android|iPhone|iPad|iPod/.test(ua);

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return Promise.reject(new Error(`"${cmd}" needs the desktop app`));
  return tauriInvoke<T>(cmd, args);
}

export function listen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return Promise.resolve(() => {});
  return tauriListen<T>(event, (e) => cb(e.payload));
}

/** URL a <video>/<img> can load for a local file path (or passthrough for blob: urls). */
export function fileUrl(path: string): string {
  if (/^(blob:|data:|https?:)/.test(path)) return path;
  return isTauri ? convertFileSrc(path) : path;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Streams binary data to a file through the raw-bytes IPC channel. */
export async function writeBytes(path: string, data: Uint8Array | Blob, append = false): Promise<void> {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  await tauriInvoke("save_chunk", bytes, {
    headers: { "x-path": encodeURIComponent(path), "x-truncate": append ? "0" : "1" },
  });
}

export async function outputDir(override?: string): Promise<string> {
  if (override) return override;
  return isTauri ? invoke<string>("default_output_dir") : "";
}

export function timestampName(prefix: string, ext: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}

/** Browser fallback: hand a blob to the user as a download. */
export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export async function pickFiles(opts: { multiple?: boolean; filters?: { name: string; extensions: string[] }[] }) {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: opts.multiple ?? false, filters: opts.filters });
  if (!res) return null;
  return Array.isArray(res) ? res : [res];
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ directory: true });
  return typeof res === "string" ? res : null;
}

export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    return openUrl(url);
  }
  window.open(url, "_blank", "noopener");
}

export function formatTime(sec: number, withMs = false): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return withMs ? `${base}.${String(Math.floor((sec % 1) * 100)).padStart(2, "0")}` : base;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export const uid = () => Math.random().toString(36).slice(2, 10);
