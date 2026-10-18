import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compositor, WebRecording, extForMime, pickMime } from "./webEngine";
import { NativeRecording, type NativeDevices } from "./nativeEngine";
import { MobileRecording } from "./mobileEngine";
import { computeLayout, type CamFilter, type CamMode, type CamShape, type Corner } from "./layouts";
import { useSettings, qualityPreset, resolveEngine, QUALITY_PRESETS } from "../lib/settings";
import { useApp, recorderControls, type Marker } from "../lib/appStore";
import { bestEncoder, ENCODER_LABELS } from "../lib/encoders";
import { fileUrl, invoke, isMac, openExternal, isMobile, isTauri, isWindows, joinPath, outputDir, timestampName, formatTime, downloadBlob, baseName } from "../lib/platform";
import { Icon } from "../components/Icon";

const MODES: { id: CamMode; label: string }[] = [
  { id: "pip", label: "Bubble" },
  { id: "split-left", label: "Cam left" },
  { id: "split-right", label: "Cam right" },
  { id: "side-by-side", label: "Side column" },
  { id: "split-top", label: "Cam top" },
  { id: "screen-only", label: "Game only" },
  { id: "camera-only", label: "Cam only" },
];
const SHAPES: CamShape[] = ["circle", "rounded", "square", "hexagon", "heart"];
const LOOKS: CamFilter[] = ["none", "vivid", "warm", "cool", "noir", "retro", "neon"];
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

type Session = WebRecording | NativeRecording | MobileRecording;

export function RecorderView() {
  const s = useSettings();
  const app = useApp();
  const q = qualityPreset(s.quality);
  const nativeMobile = isMobile && isTauri;
  const engine = nativeMobile ? "mobile" : resolveEngine(s.engine, app.hasNative);
  const hostRef = useRef<HTMLDivElement>(null);
  const compRef = useRef<Compositor | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [webCams, setWebCams] = useState<MediaDeviceInfo[]>([]);
  const [webMics, setWebMics] = useState<MediaDeviceInfo[]>([]);
  const [native, setNative] = useState<NativeDevices | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [hasScreen, setHasScreen] = useState(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [gameAudio, setGameAudio] = useState<boolean | null>(null);
  const encoder = s.encoder === "auto" ? bestEncoder(app.encoders) : s.encoder;
  const lowSpec = q.id === "potato";

  // --- compositor lifecycle (drives preview + web recording)
  useEffect(() => {
    const comp = new Compositor({ width: q.width, height: q.height, fps: q.fps, kbps: q.kbps, micGain: s.micGain, systemGain: s.systemGain }, s.layout);
    compRef.current = comp;
    hostRef.current?.appendChild(comp.canvas);
    comp.canvas.className = "preview-canvas";
    const t = setInterval(() => setLevel(comp.level), 80);
    return () => {
      clearInterval(t);
      // keep a live recording alive if the user navigates away mid-recording
      if (!sessionRef.current) {
        comp.dispose();
        comp.canvas.remove();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (compRef.current) compRef.current.layout = s.layout;
  }, [s.layout]);

  useEffect(() => {
    compRef.current?.resize({ width: q.width, height: q.height, fps: q.fps, kbps: q.kbps, micGain: s.micGain, systemGain: s.systemGain });
  }, [q.width, q.height, q.fps, q.kbps, s.micGain, s.systemGain]);

  // --- devices
  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setWebCams(list.filter((d) => d.kind === "videoinput"));
      setWebMics(list.filter((d) => d.kind === "audioinput"));
    } catch {
      /* no media devices */
    }
    if (app.hasNative) {
      try {
        setNative(await invoke<NativeDevices>("ffmpeg_list_devices"));
      } catch {
        setNative(null);
      }
    }
  }, [app.hasNative]);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [refreshDevices]);

  // Camera preview: in native mode pick the web camera whose label matches the ffmpeg device.
  const previewCamId = useMemo(() => {
    if (s.cameraId === "none") return null;
    if (engine === "web") return s.cameraId || "";
    const name = native?.video.find((v) => v.id === s.cameraId)?.name;
    return webCams.find((c) => name && c.label.includes(name))?.deviceId ?? "";
  }, [engine, s.cameraId, native, webCams]);

  useEffect(() => {
    const comp = compRef.current;
    if (!comp || sessionRef.current) return;
    comp.setCamera(previewCamId).then(refreshDevices).catch((e) => app.toast(`Camera: ${e.message ?? e}`, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewCamId]);

  useEffect(() => {
    const comp = compRef.current;
    if (!comp || sessionRef.current) return;
    const id = engine === "web" ? (s.micId === "none" ? null : s.micId || "") : s.micId === "none" ? null : "";
    comp.setMic(id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.micId, engine]);

  // Native engine: show a live still of the chosen display (refreshes ~1/s while idle).
  const recIdle = app.recState === "idle";
  useEffect(() => {
    if (engine !== "native" || !recIdle) return;
    const name = native?.screens.find((d) => d.id === s.screenId)?.name ?? native?.screens[0]?.name ?? "";
    const display = isMac ? Number(name.match(/(\d+)\s*$/)?.[1] ?? 0) + 1 : 1;
    let stop = false;
    let failures = 0;
    const tick = async () => {
      if (stop) return;
      if (isMac && !(await invoke<boolean>("screen_permission", { request: false }).catch(() => false))) {
        if (!stop) setTimeout(tick, 4000); // wait until the user grants Screen Recording
        return;
      }
      try {
        const path = await invoke<string>("screen_snapshot", { display });
        const img = new Image();
        img.src = `${fileUrl(path)}&t=${Date.now()}`;
        await img.decode();
        if (!stop && compRef.current) {
          compRef.current.screenStill = Object.assign(img, { videoWidth: img.naturalWidth, videoHeight: img.naturalHeight });
        }
        failures = 0;
      } catch {
        failures++;
      }
      if (!stop) setTimeout(tick, failures > 3 ? 5000 : 1200);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [engine, recIdle, native, s.screenId]);

  // --- recording
  const pickScreen = async () => {
    try {
      const audio = await compRef.current!.pickScreen();
      setHasScreen(true);
      setGameAudio(audio);
      return true;
    } catch {
      return false;
    }
  };

  const start = async () => {
    const comp = compRef.current!;
    if (engine === "native" && isMac && !(await invoke<boolean>("screen_permission", { request: false }))) {
      await invoke("screen_permission", { request: true });
      app.toast("StreamForge needs Screen Recording permission. Turn it on in the window that opened (Privacy & Security → Screen Recording), then quit and reopen StreamForge.", "error");
      void openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
      return;
    }
    if (engine === "web" && !comp.hasScreen && s.layout.mode !== "camera-only" && !nativeMobile) {
      if (!(await pickScreen())) return;
    }
    if (s.countdown > 0) {
      app.patch({ recState: "countdown" });
      for (let i = s.countdown; i > 0; i--) {
        setCountdown(i);
        await new Promise((r) => setTimeout(r, 1000));
      }
      setCountdown(0);
    }
    const dir = await outputDir(s.outputDir);
    try {
      let session: Session;
      if (engine === "mobile") {
        await comp.setCamera(null); // the native bubble needs the camera
        session = await MobileRecording.start({ height: Math.min(q.width, q.height), fps: q.fps, kbps: q.kbps, layout: s.layout, camera: s.cameraId !== "none", mic: s.micId !== "none" });
      } else if (engine === "web") {
        comp.placeholder = false;
        const path = isTauri ? joinPath(dir, timestampName("Recording", extForMime(pickMime()))) : undefined;
        session = new WebRecording(comp, path);
        session.start();
      } else {
        if (isWindows) await comp.setCamera(null); // DirectShow cameras are single-client
        const rec = new NativeRecording(
          {
            width: q.width, height: q.height, fps: q.fps, kbps: q.kbps, encoder, lowSpec,
            layout: s.layout,
            screenId: s.screenId || native?.screens[0]?.id || (isMac ? "1" : "0"),
            cameraId: s.cameraId === "none" ? "" : s.cameraId || native?.video[0]?.id || "",
            micId: s.micId === "none" ? "" : s.micId || native?.audio[0]?.id || "",
            systemAudioId: s.systemAudioId,
            micGain: s.micGain, systemGain: s.systemGain,
            workDir: dir,
          },
          joinPath(dir, timestampName("Recording", "mp4")),
        );
        rec.onFatal = (log) => {
          app.toast(`Recording stopped: ${log.split("\n").slice(-2).join(" ")}`, "error");
          sessionRef.current = null;
          app.patch({ recState: "idle" });
        };
        await rec.start();
        session = rec;
      }
      sessionRef.current = session;
      setMarkers([]);
      app.patch({ recState: "recording" });
    } catch (e) {
      comp.placeholder = true;
      app.patch({ recState: "idle" });
      app.toast(`Could not start recording: ${(e as Error).message ?? e}`, "error");
    }
  };

  const stop = async () => {
    const session = sessionRef.current;
    if (!session) return;
    app.patch({ recState: "stopping" });
    try {
      const res = await session.stop();
      sessionRef.current = null;
      let path = "path" in res && res.path ? res.path : "";
      if (!path && "blob" in res && res.blob) path = URL.createObjectURL(res.blob);
      if ("blob" in res && res.blob && !isTauri) downloadBlob(res.blob, timestampName("Recording", extForMime(res.mime)));
      const rec = { path, name: baseName(path) || "Recording", duration: res.duration, markers: res.markers, createdAt: Date.now() };
      app.patch({ recState: "idle", lastRecording: rec });
      app.toast(`Saved ${formatTime(res.duration)} recording`, "success");
      if (s.autoOpenEditor) app.patch({ editTarget: rec, view: "edit" });
    } catch (e) {
      sessionRef.current = null;
      app.patch({ recState: "idle" });
      app.toast(`Stopping failed: ${(e as Error).message ?? e}`, "error");
    } finally {
      const comp = compRef.current;
      if (comp) {
        comp.placeholder = true;
        if ((engine === "native" && isWindows) || engine === "mobile") void comp.setCamera(previewCamId);
      }
    }
  };

  const togglePause = async () => {
    const session = sessionRef.current;
    if (!session) return;
    if (session.paused) {
      await session.resume();
      app.patch({ recState: "recording" });
    } else {
      await session.pause();
      app.patch({ recState: "paused" });
    }
  };

  const addMarker = () => {
    const session = sessionRef.current;
    if (!session) return;
    session.addMarker();
    setMarkers([...session.markers]);
    app.toast(`Marker at ${formatTime(session.elapsed)}`);
  };

  // register for global hotkeys
  useEffect(() => {
    recorderControls.toggle = () => (sessionRef.current ? void stop() : useApp.getState().recState === "idle" && void start());
    recorderControls.pause = () => void togglePause();
    recorderControls.marker = addMarker;
  });

  useEffect(() => {
    const t = setInterval(() => setElapsed(sessionRef.current?.elapsed ?? 0), 250);
    return () => clearInterval(t);
  }, []);

  // --- drag the facecam bubble on the preview
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const toCanvas = (e: React.PointerEvent) => {
    const c = compRef.current!.canvas;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (s.layout.mode !== "pip") return;
    const p = toCanvas(e);
    const cam = computeLayout(s.layout, q.width, q.height).camera;
    if (cam && p.x >= cam.x && p.x <= cam.x + cam.w && p.y >= cam.y && p.y <= cam.y + cam.h) {
      drag.current = { dx: p.x - (cam.x + cam.w / 2), dy: p.y - (cam.y + cam.h / 2) };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const p = toCanvas(e);
    s.setLayout({ customX: (p.x - drag.current.dx) / q.width, customY: (p.y - drag.current.dy) / q.height });
  };
  const onWheel = (e: React.WheelEvent) => {
    if (s.layout.mode !== "pip") return;
    s.setLayout({ size: Math.min(0.6, Math.max(0.1, s.layout.size - e.deltaY * 0.0005)) });
  };

  const recState = app.recState;
  const busy = recState !== "idle";
  const camList = engine === "web" ? webCams.map((c) => ({ id: c.deviceId, name: c.label || "Camera" })) : native?.video ?? [];
  const micList = engine === "web" ? webMics.map((c) => ({ id: c.deviceId, name: c.label || "Microphone" })) : native?.audio ?? [];
  const L = s.layout;

  return (
    <div className="recorder">
      <section className="stage">
        <div className={`preview ${q.height > q.width ? "vertical" : ""}`}>
          <div
            ref={hostRef}
            className="preview-host"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onWheel={onWheel}
          />
          {countdown > 0 && <div className="countdown">{countdown}</div>}
          {(recState === "recording" || recState === "paused") && (
            <div className={`rec-badge ${recState}`}>
              <span className="dot" /> {recState === "paused" ? "PAUSED" : "REC"} {formatTime(elapsed)}
            </div>
          )}
          {L.mode === "pip" && !busy && <div className="hint">Drag the bubble to move it · scroll to resize</div>}
        </div>

        <div className="transport">
          <div className="meter" title="Mic level">
            <Icon name="mic" size={16} />
            <div className="bar"><div style={{ width: `${Math.round(level * 100)}%` }} /></div>
          </div>
          <div className="transport-main">
            <button className="ghost round" disabled={!sessionRef.current} onClick={addMarker} title={`Add chapter marker (${s.hotkeys.marker})`}>
              <Icon name="flag" />
            </button>
            {recState === "idle" || recState === "countdown" ? (
              <button className="rec-btn" disabled={recState === "countdown"} onClick={start} title={`Start recording (${s.hotkeys.toggleRecord})`}>
                <span className="rec-dot" /> Record
              </button>
            ) : (
              <button className="rec-btn stop" disabled={recState === "stopping"} onClick={stop} title={`Stop (${s.hotkeys.toggleRecord})`}>
                <Icon name="stop" fill size={16} /> {recState === "stopping" ? "Saving…" : "Stop"}
              </button>
            )}
            <button className="ghost round" disabled={!sessionRef.current} onClick={togglePause} title={`Pause / resume (${s.hotkeys.pause})`}>
              <Icon name={recState === "paused" ? "play" : "pause"} />
            </button>
          </div>
          <div className="engine-tag" title="Capture engine and encoder">
            {engine === "mobile" ? "Phone · MediaProjection" : engine === "native" ? (app.encoders.length ? `Native · ${ENCODER_LABELS[encoder] ?? encoder}` : "Native · detecting GPU encoder…") : "Web · hardware MediaRecorder"}
          </div>
        </div>

        {markers.length > 0 && (
          <div className="marker-strip">
            {markers.map((m, i) => (
              <span key={i} className="chip small"><Icon name="flag" size={12} /> {formatTime(m.time)}</span>
            ))}
          </div>
        )}

        {app.lastRecording && !busy && (
          <div className="saved-card">
            <Icon name="check" />
            <div className="grow">
              <b>{app.lastRecording.name}</b>
              <span className="muted"> · {formatTime(app.lastRecording.duration)} · {app.lastRecording.markers.length} markers</span>
            </div>
            <button onClick={() => app.patch({ editTarget: app.lastRecording, view: "edit" })}><Icon name="scissors" /> Edit</button>
            <button className="primary" onClick={() => app.patch({ publishTarget: app.lastRecording, view: "publish" })}>
              <Icon name="youtube" /> Quick publish
            </button>
            {isTauri && (
              <button className="ghost" onClick={() => invoke("reveal_in_folder", { path: app.lastRecording!.path })} title="Show in folder">
                <Icon name="folder" />
              </button>
            )}
          </div>
        )}
      </section>

      <aside className="panel">
        <h3>Sources</h3>
        {engine === "mobile" ? (
          <p className="note">Your whole screen is recorded. Open your game after pressing Record — the facecam floats as a bubble you can drag, and the notification has a Stop button.</p>
        ) : engine === "web" ? (
          <button className="wide" disabled={busy} onClick={pickScreen}>
            <Icon name="monitor" /> {hasScreen ? "Change screen / game window" : "Choose screen or game window"}
          </button>
        ) : (
          <label className="field">
            <span><Icon name="monitor" size={14} /> Screen</span>
            <select value={s.screenId} disabled={busy} onChange={(e) => s.set({ screenId: e.target.value })}>
              {(native?.screens ?? [{ id: "", name: "Primary display" }]).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
        )}
        {engine === "web" && gameAudio === false && <p className="note">No game audio shared. In the share dialog tick “Share system audio”.</p>}
        <label className="field">
          <span><Icon name="camera" size={14} /> Camera</span>
          <select value={s.cameraId} disabled={busy} onChange={(e) => s.set({ cameraId: e.target.value })}>
            <option value="">Default camera</option>
            {camList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value="none">No camera</option>
          </select>
        </label>
        <label className="field">
          <span><Icon name="mic" size={14} /> Microphone</span>
          <select value={s.micId} disabled={busy} onChange={(e) => s.set({ micId: e.target.value })}>
            <option value="">Default microphone</option>
            {micList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value="none">No microphone</option>
          </select>
        </label>
        {engine === "native" && (
          <label className="field">
            <span><Icon name="speaker" size={14} /> Game / system audio</span>
            <select value={s.systemAudioId} disabled={busy} onChange={(e) => s.set({ systemAudioId: e.target.value })}>
              <option value="">Off</option>
              {micList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <small className="muted">{isMac ? "Pick a loopback device such as BlackHole." : "Pick “Stereo Mix” or a virtual audio cable."}</small>
          </label>
        )}
        <div className="row2">
          <label className="field"><span>Mic {Math.round(s.micGain * 100)}%</span>
            <input type="range" min={0} max={2} step={0.05} value={s.micGain} onChange={(e) => s.set({ micGain: +e.target.value })} />
          </label>
          <label className="field"><span>Game {Math.round(s.systemGain * 100)}%</span>
            <input type="range" min={0} max={2} step={0.05} value={s.systemGain} onChange={(e) => s.set({ systemGain: +e.target.value })} />
          </label>
        </div>

        <h3>Facecam layout</h3>
        <div className="layout-grid">
          {MODES.map((m) => (
            <button key={m.id} className={`layout-tile ${L.mode === m.id ? "on" : ""}`} onClick={() => s.setLayout({ mode: m.id })} disabled={busy && engine === "native"}>
              <LayoutGlyph mode={m.id} />
              <span>{m.label}</span>
            </button>
          ))}
        </div>
        {L.mode === "pip" && (
          <>
            <div className="chips">
              {SHAPES.map((sh) => (
                <button key={sh} className={`chip ${L.shape === sh ? "on" : ""}`} onClick={() => s.setLayout({ shape: sh })}>{sh}</button>
              ))}
            </div>
            <div className="row2">
              <label className="field"><span>Size</span>
                <input type="range" min={0.1} max={0.6} step={0.01} value={L.size} onChange={(e) => s.setLayout({ size: +e.target.value })} />
              </label>
              <div className="field"><span>Corner</span>
                <div className="corners">
                  {CORNERS.map((c) => (
                    <button key={c} className={`corner ${c} ${L.corner === c && L.customX == null ? "on" : ""}`} onClick={() => s.setLayout({ corner: c, customX: undefined, customY: undefined })} />
                  ))}
                </div>
              </div>
            </div>
            <div className="row2">
              <label className="field"><span>Border {L.border}px</span>
                <input type="range" min={0} max={20} value={L.border} onChange={(e) => s.setLayout({ border: +e.target.value })} />
              </label>
              <label className="field"><span>Color</span>
                <input type="color" value={L.borderColor} onChange={(e) => s.setLayout({ borderColor: e.target.value })} />
              </label>
            </div>
            <label className="check"><input type="checkbox" checked={L.borderGlow} onChange={(e) => s.setLayout({ borderGlow: e.target.checked })} /> Voice-reactive glow ring</label>
          </>
        )}
        <div className="row2">
          <label className="field"><span>Zoom {L.zoom.toFixed(2)}×</span>
            <input type="range" min={1} max={2.5} step={0.05} value={L.zoom} onChange={(e) => s.setLayout({ zoom: +e.target.value })} />
          </label>
          <label className="check"><input type="checkbox" checked={L.mirror} onChange={(e) => s.setLayout({ mirror: e.target.checked })} /> Mirror</label>
        </div>
        <div className="field"><span>Camera look</span>
          <div className="chips">
            {LOOKS.map((f) => (
              <button key={f} className={`chip ${L.filter === f ? "on" : ""}`} onClick={() => s.setLayout({ filter: f })}>{f}</button>
            ))}
          </div>
        </div>

        <h3>Output</h3>
        <label className="field">
          <span>Quality</span>
          <select value={s.quality} disabled={busy} onChange={(e) => s.set({ quality: e.target.value })}>
            {QUALITY_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.hint}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Countdown</span>
          <select value={s.countdown} onChange={(e) => s.set({ countdown: +e.target.value })}>
            {[0, 3, 5, 10].map((n) => <option key={n} value={n}>{n ? `${n} seconds` : "Off"}</option>)}
          </select>
        </label>
        <p className="muted small">
          Hotkeys work in-game: <kbd>{s.hotkeys.toggleRecord}</kbd> record/stop · <kbd>{s.hotkeys.pause}</kbd> pause · <kbd>{s.hotkeys.marker}</kbd> marker
        </p>
      </aside>
    </div>
  );
}

function LayoutGlyph({ mode }: { mode: CamMode }) {
  const r = computeLayout({ mode, shape: "circle", corner: "br", size: 0.34, margin: 0.06, border: 0, borderColor: "", borderGlow: false, mirror: false, zoom: 1, filter: "none" }, 64, 36);
  return (
    <svg viewBox="0 0 64 36" width={56} height={32}>
      <rect x="0" y="0" width="64" height="36" rx="3" fill="var(--glyph-bg)" />
      {r.screen && <rect x={r.screen.x + 1} y={r.screen.y + 1} width={r.screen.w - 2} height={r.screen.h - 2} rx="2" fill="var(--glyph-screen)" />}
      {r.camera &&
        (mode === "pip" ? (
          <circle cx={r.camera.x + r.camera.w / 2} cy={r.camera.y + r.camera.h / 2} r={r.camera.w / 2} fill="var(--accent)" />
        ) : (
          <rect x={r.camera.x + 1} y={r.camera.y + 1} width={r.camera.w - 2} height={r.camera.h - 2} rx="2" fill="var(--accent)" />
        ))}
    </svg>
  );
}
