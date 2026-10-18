import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TEXT, clipEnd, deleteClips, makeClip, projectDuration, removeRanges, splitAt, trackEnd, useEditor,
  type Asset, type Clip, type Project,
} from "./model";
import { PreviewEngine, makeThumbs, probeElement } from "./render";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { EXPORT_PRESETS, buildExportArgs, parseSilences, type ExportPreset } from "./exportNative";
import { useApp } from "../lib/appStore";
import { useSettings } from "../lib/settings";
import { bestEncoder, ENCODER_LABELS } from "../lib/encoders";
import {
  baseName, downloadBlob, fileUrl, formatTime, invoke, isTauri, joinPath, listen, outputDir, pickFiles, timestampName, uid,
} from "../lib/platform";
import { pickMime, extForMime } from "../recorder/webEngine";
import { Icon } from "../components/Icon";

const FORMATS = [
  { label: "16:9 Landscape", w: 1920, h: 1080 },
  { label: "9:16 Shorts", w: 1080, h: 1920 },
  { label: "1:1 Square", w: 1080, h: 1080 },
];

function kindOf(name: string): Asset["kind"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return "image";
  if (["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"].includes(ext)) return "audio";
  return "video";
}

export function EditorView() {
  const ed = useEditor();
  const app = useApp();
  const settings = useSettings();
  const p = ed.project;
  const engineRef = useRef<PreviewEngine | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const duration = projectDuration(p);

  // --- preview engine + playback loop
  useEffect(() => {
    const eng = new PreviewEngine();
    engineRef.current = eng;
    eng.canvas.className = "editor-canvas";
    hostRef.current?.appendChild(eng.canvas);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const st = useEditor.getState();
      if (st.playing) {
        const t = st.playhead + (now - last) / 1000;
        const end = projectDuration(st.project);
        if (t >= end) {
          st.setPlaying(false);
          st.setPlayhead(end);
        } else st.setPlayhead(t);
      }
      last = now;
      eng.render(st.project, useEditor.getState().playhead, st.playing, st.selection);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      eng.pauseAll();
      eng.canvas.remove();
    };
  }, []);

  useEffect(() => {
    engineRef.current?.prune(p);
  }, [p.clips.length, p]);

  useEffect(() => {
    if (!ed.playing) engineRef.current?.pauseAll();
  }, [ed.playing]);

  // --- import
  const addAssets = useCallback(async (items: { path: string; name: string; url: string }[], place = false, markers?: Project["markers"]) => {
    for (const it of items) {
      const kind = kindOf(it.name);
      try {
        const meta = await probeElement(it.url, kind);
        let hasAudio = kind !== "image";
        let duration = meta.duration;
        if (isTauri && kind !== "image") {
          const info = await invoke<{ duration: number; has_audio: boolean }>("probe_media", { path: it.path }).catch(() => null);
          if (info) {
            hasAudio = info.has_audio;
            if (!duration && info.duration) duration = info.duration;
          }
        }
        const asset: Asset = { id: uid(), path: it.path, url: it.url, name: it.name, kind, duration, width: meta.width, height: meta.height, hasAudio, thumbs: [] };
        useEditor.getState().commit((pp) => {
          let next = { ...pp, assets: [...pp.assets, asset] };
          if (place) {
            const trackId = kind === "audio" ? "A1" : "V1";
            next = { ...next, clips: [...next.clips, makeClip(asset, trackId, trackEnd(next, trackId))] };
            if (markers?.length) next = { ...next, markers: [...next.markers, ...markers] };
          }
          return next;
        });
        if (kind === "video") {
          makeThumbs(it.url, duration, Math.min(40, Math.max(8, Math.round(duration / 10))))
            .then((thumbs) => useEditor.getState().mutate((pp) => ({ ...pp, assets: pp.assets.map((a) => (a.id === asset.id ? { ...a, thumbs } : a)) })))
            .catch(() => {});
        }
      } catch (e) {
        app.toast(`Could not import ${it.name}: ${(e as Error).message}`, "error");
      }
    }
  }, [app]);

  // open a recording handed over from the recorder / library
  useEffect(() => {
    const target = app.editTarget;
    if (!target) return;
    app.patch({ editTarget: null });
    const fresh = useEditor.getState().project.clips.length === 0;
    if (fresh) useEditor.getState().load({ ...useEditor.getState().project, name: target.name.replace(/\.\w+$/, "") });
    void addAssets([{ path: target.path, name: target.name, url: fileUrl(target.path) }], true, target.markers);
  }, [app.editTarget, app, addAssets]);

  const importFiles = async () => {
    if (isTauri) {
      const files = await pickFiles({ multiple: true, filters: [{ name: "Media", extensions: ["mp4", "mov", "mkv", "webm", "mp3", "wav", "m4a", "aac", "ogg", "png", "jpg", "jpeg", "webp", "gif"] }] });
      if (files) await addAssets(files.map((f) => ({ path: f, name: baseName(f), url: fileUrl(f) })));
    } else fileInput.current?.click();
  };

  // --- edit actions
  const split = () => ed.commit((pp) => splitAt(pp, ed.selection, ed.playhead));
  const del = (ripple: boolean) => {
    if (!ed.selection.length) return;
    ed.commit((pp) => deleteClips(pp, ed.selection, ripple));
    ed.select([]);
  };
  const addText = () => {
    const clip = makeClip(null, "T1", ed.playhead, { ...DEFAULT_TEXT });
    ed.commit((pp) => ({ ...pp, clips: [...pp.clips, clip] }));
    ed.select([clip.id]);
  };
  const addMarker = () => ed.commit((pp) => ({ ...pp, markers: [...pp.markers, { time: ed.playhead, label: `Chapter ${pp.markers.length + 1}` }].sort((a, b) => a.time - b.time) }));
  const duplicate = () => {
    const sel = p.clips.filter((c) => ed.selection.includes(c.id));
    if (!sel.length) return;
    const copies = sel.map((c) => ({ ...c, id: uid(), start: clipEnd(c) }));
    ed.commit((pp) => ({ ...pp, clips: [...pp.clips, ...copies] }));
    ed.select(copies.map((c) => c.id));
  };

  const removeSilence = async (c: Clip) => {
    const asset = p.assets.find((a) => a.id === c.assetId);
    if (!asset) return;
    if (!isTauri) return app.toast("Silence detection needs the desktop app", "error");
    setBusy("Finding silent parts…");
    try {
      const log = await invoke<string>("ffmpeg_analyze", {
        args: ["-hide_banner", "-nostats", "-ss", String(c.in), "-t", String(c.out - c.in), "-i", asset.path, "-vn", "-af", "silencedetect=noise=-38dB:d=0.9", "-f", "null", "-"],
      });
      const silences = parseSilences(log).map((s) => ({ start: s.start + c.in, end: s.end + c.in }));
      if (!silences.length) app.toast("No silent parts found");
      else {
        ed.commit((pp) => removeRanges(pp, c.id, silences));
        app.toast(`Removed ${silences.length} silent gaps`, "success");
      }
    } catch (e) {
      app.toast(String(e), "error");
    } finally {
      setBusy("");
    }
  };

  // --- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const st = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && e.key.toLowerCase() === "y") st.redo();
      else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate();
      } else if (e.key === " ") {
        e.preventDefault();
        st.setPlaying(!st.playing);
      } else if (e.key.toLowerCase() === "s" && !mod) split();
      else if (e.key === "Delete" || e.key === "Backspace") del(e.shiftKey);
      else if (e.key.toLowerCase() === "m") addMarker();
      else if (e.key.toLowerCase() === "t") addText();
      else if (e.key === "ArrowLeft") st.setPlayhead(st.playhead - (e.shiftKey ? 1 : 1 / p.fps));
      else if (e.key === "ArrowRight") st.setPlayhead(st.playhead + (e.shiftKey ? 1 : 1 / p.fps));
      else if (e.key.toLowerCase() === "k") st.setPlaying(false);
      else if (e.key.toLowerCase() === "l") st.setPlaying(true);
      else if (e.key.toLowerCase() === "j") st.setPlayhead(st.playhead - 5);
      else if (e.key === "Home") st.setPlayhead(0);
      else if (e.key === "End") st.setPlayhead(projectDuration(st.project));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="editor">
      <div className="ed-toolbar">
        <input className="proj-name" value={p.name} onChange={(e) => ed.mutate((pp) => ({ ...pp, name: e.target.value }))} />
        <div className="sep" />
        <button className="icon-btn" onClick={ed.undo} disabled={!ed.past.length} title="Undo (Ctrl+Z)"><Icon name="undo" /></button>
        <button className="icon-btn" onClick={ed.redo} disabled={!ed.future.length} title="Redo (Ctrl+Shift+Z)"><Icon name="redo" /></button>
        <div className="sep" />
        <button className="icon-btn" onClick={split} title="Split at playhead (S)"><Icon name="scissors" /></button>
        <button className="icon-btn" onClick={() => del(false)} disabled={!ed.selection.length} title="Delete (Del) · Shift+Del ripple"><Icon name="trash" /></button>
        <button className="icon-btn" onClick={addText} title="Add title (T)"><Icon name="text" /></button>
        <button className="icon-btn" onClick={addMarker} title="Add chapter marker (M)"><Icon name="flag" /></button>
        <button className={`icon-btn ${ed.snapping ? "on" : ""}`} onClick={ed.toggleSnapping} title="Snapping"><Icon name="magnet" /></button>
        <div className="sep" />
        <button className="icon-btn" onClick={() => ed.setZoom(ed.zoom / 1.4)} title="Zoom out"><Icon name="zoomOut" /></button>
        <button className="icon-btn" onClick={() => ed.setZoom(ed.zoom * 1.4)} title="Zoom in"><Icon name="zoomIn" /></button>
        <select value={`${p.width}x${p.height}`} onChange={(e) => {
          const f = FORMATS.find((x) => `${x.w}x${x.h}` === e.target.value)!;
          ed.commit((pp) => ({ ...pp, width: f.w, height: f.h }));
        }}>
          {FORMATS.map((f) => <option key={f.label} value={`${f.w}x${f.h}`}>{f.label}</option>)}
        </select>
        <div className="grow" />
        {busy && <span className="busy"><span className="spinner" /> {busy}</span>}
        <button className="primary" onClick={() => setExportOpen(true)} disabled={!duration}><Icon name="download" /> Export</button>
      </div>

      <div className="ed-main">
        <aside className="bin">
          <div className="bin-head">
            <b>Media</b>
            <button className="small" onClick={importFiles}><Icon name="plus" size={14} /> Import</button>
            <input ref={fileInput} type="file" multiple hidden accept="video/*,audio/*,image/*" onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              void addAssets(files.map((f) => ({ path: f.name, name: f.name, url: URL.createObjectURL(f) })));
              e.target.value = "";
            }} />
          </div>
          {p.assets.length === 0 && (
            <div className="bin-empty" onClick={importFiles}>
              <Icon name="film" size={28} />
              <p>Import gameplay, music, images</p>
              <small className="muted">or record something first</small>
            </div>
          )}
          <div className="bin-list">
            {p.assets.map((a) => (
              <div key={a.id} className="asset" draggable onDragStart={(e) => e.dataTransfer.setData("application/x-asset", a.id)}
                onDoubleClick={() => {
                  const trackId = a.kind === "audio" ? "A1" : "V1";
                  ed.commit((pp) => ({ ...pp, clips: [...pp.clips, makeClip(a, trackId, trackEnd(pp, trackId))] }));
                }}
                title="Drag onto the timeline or double-click to append"
              >
                <div className="asset-thumb">
                  {a.thumbs[0] ? <img src={a.thumbs[0]} alt="" /> : a.kind === "image" ? <img src={a.url} alt="" /> : <Icon name={a.kind === "audio" ? "volume" : "film"} />}
                  <span className="dur">{a.kind === "image" ? "IMG" : formatTime(a.duration)}</span>
                </div>
                <span className="asset-name">{a.name}</span>
              </div>
            ))}
          </div>
        </aside>

        <section className="viewer">
          <div className={`viewer-frame ${p.height > p.width ? "vertical" : ""}`} ref={hostRef} />
          <div className="viewer-bar">
            <button className="icon-btn" onClick={() => ed.setPlayhead(0)} title="Start (Home)"><Icon name="undo" size={16} /></button>
            <button className="play-btn" onClick={() => ed.setPlaying(!ed.playing)} title="Play / pause (Space)">
              <Icon name={ed.playing ? "pause" : "play"} fill={!ed.playing} />
            </button>
            <span className="mono">{formatTime(ed.playhead, true)} / {formatTime(duration, true)}</span>
          </div>
        </section>

        <aside className="side">
          <Inspector onRemoveSilence={removeSilence} />
        </aside>
      </div>

      <Timeline />

      {exportOpen && <ExportDialog engine={engineRef.current!} onClose={() => setExportOpen(false)} encoders={app.encoders} encoderSetting={settings.encoder} outputDirSetting={settings.outputDir} />}
    </div>
  );
}

function ExportDialog({ engine, onClose, encoders, encoderSetting, outputDirSetting }: {
  engine: PreviewEngine; onClose: () => void; encoders: string[]; encoderSetting: string; outputDirSetting: string;
}) {
  const app = useApp();
  const p = useEditor((s) => s.project);
  const vertical = p.height > p.width;
  const [preset, setPreset] = useState<ExportPreset>(EXPORT_PRESETS.find((x) => (vertical ? x.id === "shorts" : x.id === "yt1080"))!);
  const [encoder, setEncoder] = useState(encoderSetting === "auto" ? bestEncoder(encoders) : encoderSetting);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const cancelRef = useRef<() => void>(() => {});

  const runNative = async () => {
    const dir = await outputDir(outputDirSetting);
    const out = joinPath(dir, timestampName((p.name || "Export").replace(/[^\w\- ]+/g, "").trim() || "Export", "mp4"));
    const temps: string[] = [];
    const { args, duration } = await buildExportArgs(p, preset, encoder, out, dir, temps);
    const id = `export-${uid()}`;
    setProgress(0);
    setStatus(`Encoding with ${ENCODER_LABELS[encoder] ?? encoder}…`);
    const offP = await listen<{ id: string; out_time_ms: number; speed: string }>("ffmpeg://progress", (e) => {
      if (e.id === id) {
        setProgress(Math.min(1, e.out_time_ms / 1000 / duration));
        setStatus(`Encoding · ${e.speed || ""} realtime`);
      }
    });
    const done = new Promise<{ code: number | null; log: string }>((resolve) => {
      void listen<{ id: string; code: number | null; log: string }>("ffmpeg://exit", (e) => e.id === id && resolve(e)).then((off) => {
        cancelRef.current = () => {
          void invoke("ffmpeg_stop", { id });
          off();
        };
      });
    });
    await invoke("ffmpeg_start", { id, args });
    const res = await done;
    offP();
    await invoke("delete_temp_files", { paths: temps }).catch(() => {});
    if (res.code !== 0) throw new Error(res.log.split("\n").slice(-4).join("\n"));
    return out;
  };

  /** Browser fallback: play the timeline in real time and record the preview canvas. */
  const runWeb = async () => {
    const st = useEditor.getState();
    const dur = projectDuration(st.project);
    const audio = engine.captureAudio();
    const stream = new MediaStream([...engine.canvas.captureStream(st.project.fps).getVideoTracks(), ...audio.getAudioTracks()]);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: preset.kbps * 1000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    st.select([]);
    st.setPlayhead(0);
    await new Promise((r) => setTimeout(r, 300));
    rec.start(1000);
    st.setPlaying(true);
    setStatus("Rendering in real time…");
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        const s = useEditor.getState();
        setProgress(s.playhead / dur);
        if (!s.playing) {
          clearInterval(t);
          resolve();
        }
      }, 200);
      cancelRef.current = () => useEditor.getState().setPlaying(false);
    });
    await new Promise<void>((r) => {
      rec.onstop = () => r();
      rec.stop();
    });
    const blob = new Blob(chunks, { type: mime });
    downloadBlob(blob, timestampName(p.name || "Export", extForMime(mime)));
    return URL.createObjectURL(blob);
  };

  const start = async () => {
    try {
      setResult(null);
      const out = isTauri && app.hasNative ? await runNative() : await runWeb();
      setProgress(1);
      setStatus("Done");
      setResult(out);
      app.toast("Export finished", "success");
    } catch (e) {
      setProgress(null);
      setStatus("");
      app.toast(`Export failed: ${(e as Error).message ?? e}`, "error");
    }
  };

  const chapters = p.markers.length;
  const running = progress != null && progress < 1;

  return (
    <div className="modal-bg" onClick={() => !running && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2><Icon name="download" /> Export video</h2>
        <label className="field"><span>Preset</span>
          <select value={preset.id} disabled={running} onChange={(e) => setPreset(EXPORT_PRESETS.find((x) => x.id === e.target.value)!)}>
            {EXPORT_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.width}×{x.height} · {x.kbps / 1000} Mbps</option>)}
          </select>
        </label>
        {isTauri && app.hasNative && (
          <label className="field"><span>Encoder</span>
            <select value={encoder} disabled={running} onChange={(e) => setEncoder(e.target.value)}>
              {(encoders.length ? encoders : ["libx264"]).map((e) => <option key={e} value={e}>{ENCODER_LABELS[e] ?? e}</option>)}
            </select>
          </label>
        )}
        <p className="muted small">
          {formatTime(projectDuration(p))} · {p.clips.length} clips · {chapters} chapter markers (added to the YouTube description automatically)
          {!(isTauri && app.hasNative) && " · Browser mode renders in real time."}
        </p>
        {progress != null && (
          <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /><span>{Math.round(progress * 100)}% · {status}</span></div>
        )}
        <div className="modal-actions">
          {result ? (
            <>
              {isTauri && <button onClick={() => invoke("reveal_in_folder", { path: result })}><Icon name="folder" /> Show file</button>}
              <button className="primary" onClick={() => {
                app.patch({
                  publishTarget: { path: result, name: baseName(result), duration: projectDuration(p), markers: p.markers, createdAt: Date.now() },
                  view: "publish",
                });
                onClose();
              }}><Icon name="youtube" /> Publish to YouTube</button>
            </>
          ) : running ? (
            <button onClick={() => { cancelRef.current(); setProgress(null); setStatus(""); }}>Cancel</button>
          ) : (
            <>
              <button onClick={onClose}>Close</button>
              <button className="primary" onClick={start}><Icon name="download" /> Export</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
