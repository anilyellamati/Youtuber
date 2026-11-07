// StreamForge Lite: one window, one job. Pick a screen or window, a camera and a
// microphone, choose a look, press Record. Everything runs in the system webview
// (WebView2 on Windows) with the hardware MediaRecorder, so no FFmpeg is bundled.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Compositor, WebRecording, extForMime, pickMime } from "../recorder/webEngine";
import { DEFAULT_LAYOUT, type CamFilter, type CamMode, type CamShape, type CameraLayout, type Corner } from "../recorder/layouts";
import { QUALITY_PRESETS, qualityPreset } from "../lib/settings";
import { baseName, downloadBlob, formatBytes, formatTime, invoke, isTauri, joinPath, outputDir, pickFolder, timestampName } from "../lib/platform";
import { Icon } from "../components/Icon";

// ---------- looks ----------
export const LOOKS: { id: string; label: string; css: string }[] = [
  { id: "none", label: "Original", css: "" },
  { id: "vivid", label: "Vivid", css: "saturate(1.45) contrast(1.1)" },
  { id: "cinematic", label: "Cinematic", css: "contrast(1.15) saturate(0.85) sepia(0.12)" },
  { id: "warm", label: "Warm", css: "sepia(0.25) saturate(1.2)" },
  { id: "cool", label: "Cool", css: "hue-rotate(12deg) saturate(1.1) brightness(1.03)" },
  { id: "bw", label: "B&W", css: "grayscale(1) contrast(1.25)" },
  { id: "vintage", label: "Vintage", css: "sepia(0.55) contrast(1.1) saturate(1.3) brightness(0.95)" },
  { id: "neon", label: "Neon", css: "saturate(1.9) contrast(1.2) hue-rotate(-15deg)" },
  { id: "soft", label: "Soft", css: "contrast(0.88) brightness(1.08) saturate(0.85)" },
];

const LAYOUTS: { id: CamMode; label: string }[] = [
  { id: "pip", label: "Bubble" },
  { id: "split-right", label: "Side by side" },
  { id: "screen-only", label: "Screen only" },
  { id: "camera-only", label: "Camera only" },
];
const SHAPES: CamShape[] = ["circle", "rounded", "square", "hexagon"];
const CAM_LOOKS: CamFilter[] = ["none", "vivid", "warm", "cool", "noir", "retro"];
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];
const LITE_QUALITY = QUALITY_PRESETS.filter((q) => ["potato", "balanced", "smooth"].includes(q.id));

interface LiteSettings {
  quality: string;
  cameraId: string; // "" default, "none" off
  micId: string;
  systemAudio: boolean;
  micGain: number;
  systemGain: number;
  layout: CameraLayout;
  look: string;
  brightness: number;
  contrast: number;
  saturation: number;
  outputDir: string;
  set: (p: Partial<LiteSettings>) => void;
  setLayout: (p: Partial<CameraLayout>) => void;
}

const useLite = create<LiteSettings>()(
  persist(
    (set) => ({
      quality: "balanced",
      cameraId: "",
      micId: "",
      systemAudio: true,
      micGain: 1,
      systemGain: 0.8,
      layout: { ...DEFAULT_LAYOUT, size: 0.26 },
      look: "none",
      brightness: 1,
      contrast: 1,
      saturation: 1,
      outputDir: "",
      set: (p) => set(p),
      setLayout: (p) => set((s) => ({ layout: { ...s.layout, ...p } })),
    }),
    { name: "streamforge-lite", partialize: ({ set: _a, setLayout: _b, ...rest }) => rest },
  ),
);

export function filterCss(look: string, b: number, c: number, s: number) {
  const parts = [LOOKS.find((l) => l.id === look)?.css ?? ""];
  if (b !== 1) parts.push(`brightness(${b.toFixed(2)})`);
  if (c !== 1) parts.push(`contrast(${c.toFixed(2)})`);
  if (s !== 1) parts.push(`saturate(${s.toFixed(2)})`);
  return parts.filter(Boolean).join(" ") || "none";
}

type Phase = "idle" | "recording" | "paused" | "saving";

export function LiteApp() {
  const s = useLite();
  const q = qualityPreset(s.quality);
  const hostRef = useRef<HTMLDivElement>(null);
  const compRef = useRef<Compositor | null>(null);
  const recRef = useRef<WebRecording | null>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [hasScreen, setHasScreen] = useState(false);
  const [screenAudio, setScreenAudio] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [dir, setDir] = useState("");
  const [saved, setSaved] = useState<{ path: string; duration: number; size?: number } | null>(null);
  const [error, setError] = useState("");

  // compositor = live preview + recording source
  useEffect(() => {
    const comp = new Compositor({ width: q.width, height: q.height, fps: q.fps, kbps: q.kbps, micGain: s.micGain, systemGain: s.systemGain }, s.layout);
    comp.canvas.className = "lite-canvas";
    hostRef.current?.appendChild(comp.canvas);
    compRef.current = comp;
    const t = setInterval(() => {
      setLevel(comp.level);
      setElapsed(recRef.current?.elapsed ?? 0);
    }, 100);
    return () => {
      clearInterval(t);
      comp.dispose();
      comp.canvas.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (compRef.current) compRef.current.layout = s.layout;
  }, [s.layout]);
  useEffect(() => {
    if (compRef.current) compRef.current.screenFilter = filterCss(s.look, s.brightness, s.contrast, s.saturation);
  }, [s.look, s.brightness, s.contrast, s.saturation]);
  useEffect(() => {
    if (phase === "idle") compRef.current?.resize({ width: q.width, height: q.height, fps: q.fps, kbps: q.kbps, micGain: s.micGain, systemGain: s.systemGain });
  }, [q.width, q.height, q.fps, q.kbps, s.micGain, s.systemGain, phase]);

  // devices
  const refreshDevices = async () => {
    const list = await navigator.mediaDevices?.enumerateDevices().catch(() => []) ?? [];
    setCams(list.filter((d) => d.kind === "videoinput"));
    setMics(list.filter((d) => d.kind === "audioinput"));
  };
  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, []);
  useEffect(() => {
    const comp = compRef.current;
    if (!comp || phase !== "idle") return;
    comp.setCamera(s.cameraId === "none" ? null : s.cameraId).then(refreshDevices).catch(() => setError("Camera unavailable or permission denied."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.cameraId]);
  useEffect(() => {
    const comp = compRef.current;
    if (!comp || phase !== "idle") return;
    comp.setMic(s.micId === "none" ? null : s.micId).then(refreshDevices).catch(() => setError("Microphone unavailable or permission denied."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.micId]);
  useEffect(() => {
    void outputDir(s.outputDir).then(setDir).catch(() => {});
  }, [s.outputDir]);

  const chooseScreen = async () => {
    setError("");
    try {
      const audio = await compRef.current!.pickScreen(s.systemAudio);
      setHasScreen(true);
      setScreenAudio(audio);
      return true;
    } catch {
      return false;
    }
  };

  const start = async () => {
    setError("");
    setSaved(null);
    const comp = compRef.current!;
    if (!comp.hasScreen && s.layout.mode !== "camera-only" && !(await chooseScreen())) return;
    comp.placeholder = false;
    const path = isTauri ? joinPath(dir || (await outputDir(s.outputDir)), timestampName("Recording", extForMime(pickMime()))) : undefined;
    const rec = new WebRecording(comp, path);
    rec.start();
    recRef.current = rec;
    setPhase("recording");
  };

  const stop = async () => {
    const rec = recRef.current;
    if (!rec) return;
    setPhase("saving");
    const res = await rec.stop();
    recRef.current = null;
    compRef.current!.placeholder = true;
    setPhase("idle");
    if (rec.writeError) setError(`Could not save: ${rec.writeError}`);
    if (res.blob) {
      downloadBlob(res.blob, timestampName("Recording", extForMime(res.mime)));
      setSaved({ path: "Downloads", duration: res.duration, size: res.blob.size });
    } else if (res.path) setSaved({ path: res.path, duration: res.duration });
  };

  const togglePause = () => {
    const rec = recRef.current;
    if (!rec) return;
    if (rec.paused) {
      rec.resume();
      setPhase("recording");
    } else {
      rec.pause();
      setPhase("paused");
    }
  };

  // F9 start/stop, F10 pause — global, so they work while a game has focus
  const actions = useRef({ start, stop, togglePause, phase });
  actions.current = { start, stop, togglePause, phase };
  useEffect(() => {
    if (!isTauri) return;
    void (async () => {
      try {
        const gs = await import("@tauri-apps/plugin-global-shortcut");
        await gs.unregisterAll();
        await gs.register("F9", (e) => {
          if (e.state !== "Pressed") return;
          const a = actions.current;
          void (a.phase === "idle" ? a.start() : a.stop());
        });
        await gs.register("F10", (e) => e.state === "Pressed" && actions.current.togglePause());
      } catch {
        /* hotkey taken by another app */
      }
    })();
  }, []);

  const busy = phase !== "idle";
  const L = s.layout;
  const showCamOptions = L.mode !== "screen-only";
  const estMB = ((q.kbps + 160) * 60) / 8 / 1024;

  return (
    <div className="lite">
      <header className="lite-head">
        <img src="/icon.svg" alt="" />
        <b>StreamForge Lite</b>
        <span className={`pill ${phase}`}>
          {phase === "idle" ? "Ready" : phase === "saving" ? "Saving…" : (
            <><i className="dot" /> {phase === "paused" ? "Paused" : "Recording"} {formatTime(elapsed)}</>
          )}
        </span>
        <div className="grow" />
        <span className="muted small">{q.width}×{q.height} · {q.fps} fps · ~{estMB.toFixed(0)} MB/min</span>
      </header>

      <main className="lite-main">
        <section className="lite-stage">
          <div className="lite-preview" ref={hostRef} />
          {!hasScreen && L.mode !== "camera-only" && !busy && (
            <button className="lite-overlay-btn" onClick={chooseScreen}>
              <Icon name="monitor" size={20} /> Choose screen or window
            </button>
          )}
          <div className="lite-controls">
            <div className="meter" title="Microphone level">
              <Icon name="mic" size={16} />
              <div className="bar"><div style={{ width: `${Math.round(level * 100)}%` }} /></div>
            </div>
            <div className="lite-buttons">
              <button className="ghost round" disabled={!busy || phase === "saving"} onClick={togglePause} title="Pause / resume (F10)">
                <Icon name={phase === "paused" ? "play" : "pause"} />
              </button>
              {phase === "idle" ? (
                <button className="rec-btn" onClick={start} title="Start recording (F9)"><span className="rec-dot" /> Record</button>
              ) : (
                <button className="rec-btn stop" disabled={phase === "saving"} onClick={stop} title="Stop (F9)">
                  <Icon name="stop" fill size={16} /> {phase === "saving" ? "Saving…" : "Stop"}
                </button>
              )}
            </div>
            <span className="muted small hk">F9 record · F10 pause</span>
          </div>
          {error && <div className="lite-msg bad"><Icon name="info" size={16} /> {error}</div>}
          {saved && (
            <div className="lite-msg ok">
              <Icon name="check" size={16} />
              <span className="grow">Saved <b>{baseName(saved.path)}</b> · {formatTime(saved.duration)}{saved.size ? ` · ${formatBytes(saved.size)}` : ""}</span>
              {isTauri && <button className="small" onClick={() => invoke("reveal_in_folder", { path: saved.path })}><Icon name="folder" size={14} /> Show file</button>}
            </div>
          )}
        </section>

        <aside className="lite-panel">
          <h4>Capture</h4>
          <button className="wide" disabled={busy} onClick={chooseScreen}>
            <Icon name="monitor" /> {hasScreen ? "Change screen / window" : "Choose screen or window"}
          </button>
          <label className="check"><input type="checkbox" checked={s.systemAudio} disabled={busy} onChange={(e) => s.set({ systemAudio: e.target.checked })} /> Record computer / game sound</label>
          {hasScreen && s.systemAudio && screenAudio === false && <p className="note">No sound was shared. Choose “Entire screen” and tick “Share system audio”.</p>}
          <label className="field"><span><Icon name="camera" size={14} /> Camera</span>
            <select value={s.cameraId} disabled={busy} onChange={(e) => s.set({ cameraId: e.target.value })}>
              <option value="">Default camera</option>
              {cams.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label || "Camera"}</option>)}
              <option value="none">No camera</option>
            </select>
          </label>
          <label className="field"><span><Icon name="mic" size={14} /> Microphone</span>
            <select value={s.micId} disabled={busy} onChange={(e) => s.set({ micId: e.target.value })}>
              <option value="">Default microphone</option>
              {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || "Microphone"}</option>)}
              <option value="none">No microphone</option>
            </select>
          </label>
          <div className="row2">
            <label className="field"><span>Mic {Math.round(s.micGain * 100)}%</span>
              <input type="range" min={0} max={2} step={0.05} value={s.micGain} disabled={busy} onChange={(e) => s.set({ micGain: +e.target.value })} /></label>
            <label className="field"><span>Sound {Math.round(s.systemGain * 100)}%</span>
              <input type="range" min={0} max={2} step={0.05} value={s.systemGain} disabled={busy} onChange={(e) => s.set({ systemGain: +e.target.value })} /></label>
          </div>

          <h4>Layout</h4>
          <div className="chips">
            {LAYOUTS.map((l) => <button key={l.id} className={`chip ${L.mode === l.id ? "on" : ""}`} onClick={() => s.setLayout({ mode: l.id })}>{l.label}</button>)}
          </div>
          {L.mode === "pip" && (
            <>
              <div className="chips">
                {SHAPES.map((sh) => <button key={sh} className={`chip ${L.shape === sh ? "on" : ""}`} onClick={() => s.setLayout({ shape: sh })}>{sh}</button>)}
              </div>
              <div className="row2">
                <label className="field"><span>Bubble size</span>
                  <input type="range" min={0.12} max={0.5} step={0.01} value={L.size} onChange={(e) => s.setLayout({ size: +e.target.value })} /></label>
                <div className="field"><span>Corner</span>
                  <div className="corners">
                    {CORNERS.map((c) => <button key={c} className={`corner ${L.corner === c ? "on" : ""}`} onClick={() => s.setLayout({ corner: c, customX: undefined, customY: undefined })} />)}
                  </div>
                </div>
              </div>
            </>
          )}

          <h4>Video filter</h4>
          <div className="looks">
            {LOOKS.map((l) => (
              <button key={l.id} className={`look ${s.look === l.id ? "on" : ""}`} onClick={() => s.set({ look: l.id })}>
                <span className="swatch" style={{ filter: l.css || "none" }} />
                {l.label}
              </button>
            ))}
          </div>
          {[["Brightness", "brightness", 0.6, 1.5], ["Contrast", "contrast", 0.6, 1.6], ["Saturation", "saturation", 0, 2]].map(([label, key, min, max]) => (
            <label key={key as string} className="field"><span>{label as string} <b className="mono">{Math.round((s[key as "brightness"] as number) * 100)}%</b></span>
              <input type="range" min={min as number} max={max as number} step={0.01} value={s[key as "brightness"] as number} onChange={(e) => s.set({ [key as string]: +e.target.value } as Partial<LiteSettings>)} />
            </label>
          ))}
          {showCamOptions && (
            <div className="field"><span>Camera look</span>
              <div className="chips">
                {CAM_LOOKS.map((f) => <button key={f} className={`chip ${L.filter === f ? "on" : ""}`} onClick={() => s.setLayout({ filter: f })}>{f === "none" ? "natural" : f}</button>)}
                <button className={`chip ${L.mirror ? "on" : ""}`} onClick={() => s.setLayout({ mirror: !L.mirror })}>mirror</button>
              </div>
            </div>
          )}
          <button className="small" onClick={() => s.set({ look: "none", brightness: 1, contrast: 1, saturation: 1 })}><Icon name="refresh" size={14} /> Reset filters</button>

          <h4>Output</h4>
          <label className="field"><span>Quality</span>
            <select value={s.quality} disabled={busy} onChange={(e) => s.set({ quality: e.target.value })}>
              {LITE_QUALITY.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.hint}</option>)}
            </select>
          </label>
          <div className="field"><span>Save to</span>
            <div className="inline">
              <input readOnly value={isTauri ? dir : "Downloads folder"} title={dir} />
              <button className="small" disabled={!isTauri || busy} onClick={async () => { const d = await pickFolder(); if (d) s.set({ outputDir: d }); }}>Change</button>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
