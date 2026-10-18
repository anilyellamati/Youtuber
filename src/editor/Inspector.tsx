import { useEffect, useState } from "react";
import { LOOKS, NEUTRAL_COLOR, updateClip, useEditor, type Clip, type ColorAdjust, type Look, type TextAnim, type TextStyle } from "./model";
import { Icon } from "../components/Icon";

const FONTS = [
  { label: "Impact", value: "Impact, 'Arial Black', system-ui, sans-serif" },
  { label: "Bold Sans", value: "'Arial Black', 'Helvetica Neue', system-ui, sans-serif" },
  { label: "System", value: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { label: "Rounded", value: "'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif" },
  { label: "Mono", value: "'Courier New', ui-monospace, monospace" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
];

const TEXT_PRESETS: { label: string; style: Partial<TextStyle> }[] = [
  { label: "YouTuber", style: { color: "#ffffff", stroke: "#000000", strokeWidth: 10, box: "", font: FONTS[0].value, anim: "pop" } },
  { label: "Lower third", style: { color: "#ffffff", stroke: "#000000", strokeWidth: 0, box: "rgba(255,45,111,0.92)", font: FONTS[1].value, size: 54, anim: "slide-up" } },
  { label: "Meme", style: { color: "#ffffff", stroke: "#000000", strokeWidth: 12, font: FONTS[0].value, size: 110, anim: "none" } },
  { label: "Neon", style: { color: "#39ff14", stroke: "#0b3d02", strokeWidth: 6, font: FONTS[1].value, anim: "fade" } },
  { label: "Warning", style: { color: "#111111", stroke: "#ffd400", strokeWidth: 0, box: "#ffd400", font: FONTS[1].value, size: 64, anim: "pop" } },
];

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4, 8];

export function Inspector({ onRemoveSilence }: { onRemoveSilence: (c: Clip) => void }) {
  const { project: p, selection } = useEditor();
  const clip = p.clips.find((c) => c.id === selection[0]);
  const [tab, setTab] = useState<"basic" | "color" | "text">("basic");
  const clipKind = clip?.kind;
  useEffect(() => {
    setTab(clipKind === "text" ? "text" : "basic");
  }, [clip?.id, clipKind]);
  if (!clip) {
    return (
      <div className="inspector empty">
        <Icon name="layers" size={28} />
        <p>Select a clip to edit its properties.</p>
        <p className="muted small">Tip: <kbd>S</kbd> split · <kbd>Del</kbd> delete · <kbd>Shift</kbd>+<kbd>Del</kbd> ripple delete · <kbd>M</kbd> marker · <kbd>Space</kbd> play</p>
      </div>
    );
  }
  const asset = p.assets.find((a) => a.id === clip.assetId);
  const ed = useEditor.getState();
  const set = (patch: Partial<Clip>, history = true) =>
    history ? ed.commit((pp) => updateClip(pp, clip.id, patch)) : ed.mutate((pp) => updateClip(pp, clip.id, patch));
  const setColor = (patch: Partial<ColorAdjust>) => set({ color: { ...clip.color, ...patch } }, false);
  const setText = (patch: Partial<TextStyle>) => set({ text: { ...clip.text!, ...patch } }, false);
  const slider = (label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, fmt = (v: number) => v.toFixed(2)) => (
    <label className="field">
      <span>{label} <b className="mono">{fmt(value)}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onPointerDown={() => ed.checkpoint()} onChange={(e) => onChange(+e.target.value)} />
    </label>
  );
  const isText = clip.kind === "text";
  const tabs = isText ? (["text", "basic"] as const) : (["basic", "color"] as const);
  const current = tabs.includes(tab as never) ? tab : tabs[0];

  return (
    <div className="inspector">
      <div className="insp-head">
        <b>{isText ? "Text" : asset?.name}</b>
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t} className={current === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </div>

      {current === "text" && clip.text && (
        <>
          <textarea rows={3} value={clip.text.text} onFocus={() => ed.checkpoint()} onChange={(e) => setText({ text: e.target.value })} />
          <div className="chips">
            {TEXT_PRESETS.map((tp) => (
              <button key={tp.label} className="chip" onClick={() => set({ text: { ...clip.text!, ...tp.style } })}>{tp.label}</button>
            ))}
          </div>
          <label className="field"><span>Font</span>
            <select value={clip.text.font} onChange={(e) => set({ text: { ...clip.text!, font: e.target.value } })}>
              {FONTS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          {slider("Size", clip.text.size, 16, 260, 1, (v) => setText({ size: v }), (v) => `${v}px`)}
          <div className="row3">
            <label className="field"><span>Fill</span><input type="color" value={clip.text.color} onChange={(e) => setText({ color: e.target.value })} /></label>
            <label className="field"><span>Outline</span><input type="color" value={clip.text.stroke} onChange={(e) => setText({ stroke: e.target.value })} /></label>
            <label className="field"><span>Box</span>
              <input type="color" value={clip.text.box && clip.text.box.startsWith("#") ? clip.text.box : "#000000"} onChange={(e) => setText({ box: e.target.value })} />
            </label>
          </div>
          {slider("Outline width", clip.text.strokeWidth, 0, 24, 1, (v) => setText({ strokeWidth: v }), (v) => `${v}px`)}
          <div className="row2">
            <label className="check"><input type="checkbox" checked={clip.text.bold} onChange={(e) => set({ text: { ...clip.text!, bold: e.target.checked } })} /> Heavy</label>
            <label className="check"><input type="checkbox" checked={!!clip.text.box} onChange={(e) => set({ text: { ...clip.text!, box: e.target.checked ? "#000000" : "" } })} /> Background box</label>
          </div>
          <label className="field"><span>Animation</span>
            <div className="chips">
              {(["none", "fade", "slide-up", "pop"] as TextAnim[]).map((a) => (
                <button key={a} className={`chip ${clip.text!.anim === a ? "on" : ""}`} onClick={() => set({ text: { ...clip.text!, anim: a } })}>{a}</button>
              ))}
            </div>
          </label>
        </>
      )}

      {current === "basic" && (
        <>
          <div className="row2">
            {slider("X", clip.x, 0, 1, 0.005, (v) => set({ x: v }, false), (v) => `${Math.round(v * 100)}%`)}
            {slider("Y", clip.y, 0, 1, 0.005, (v) => set({ y: v }, false), (v) => `${Math.round(v * 100)}%`)}
          </div>
          <div className="row2">
            {slider("Scale", clip.scale, 0.1, 4, 0.01, (v) => set({ scale: v }, false), (v) => `${Math.round(v * 100)}%`)}
            {slider("Rotation", clip.rotation, -180, 180, 1, (v) => set({ rotation: v }, false), (v) => `${v}°`)}
          </div>
          {slider("Opacity", clip.opacity, 0, 1, 0.01, (v) => set({ opacity: v }, false), (v) => `${Math.round(v * 100)}%`)}
          <div className="chips">
            <button className="chip" onClick={() => set({ x: 0.5, y: 0.5, scale: 1, rotation: 0 })}>Reset</button>
            <button className="chip" onClick={() => set({ x: 0.82, y: 0.8, scale: 0.32 })}>Picture-in-picture</button>
            <button className="chip" onClick={() => set({ scale: Math.max(p.width / p.height, p.height / p.width) })}>Fill frame</button>
          </div>
          {!isText && (
            <>
              <label className="field"><span>Speed</span>
                <div className="chips">
                  {SPEEDS.map((s) => (
                    <button key={s} className={`chip ${clip.speed === s ? "on" : ""}`} onClick={() => set({ speed: s })}>{s}×</button>
                  ))}
                </div>
              </label>
              {asset?.hasAudio && slider("Volume", clip.volume, 0, 2, 0.01, (v) => set({ volume: v }, false), (v) => `${Math.round(v * 100)}%`)}
            </>
          )}
          <div className="row2">
            {slider("Fade in", clip.fadeIn, 0, 5, 0.05, (v) => set({ fadeIn: v }, false), (v) => `${v.toFixed(1)}s`)}
            {slider("Fade out", clip.fadeOut, 0, 5, 0.05, (v) => set({ fadeOut: v }, false), (v) => `${v.toFixed(1)}s`)}
          </div>
          {!isText && asset?.hasAudio && asset.kind === "video" && (
            <button className="wide" onClick={() => onRemoveSilence(clip)} title="Detects silent parts and jump-cuts them out">
              <Icon name="wand" /> Auto jump-cut silences
            </button>
          )}
        </>
      )}

      {current === "color" && !isText && (
        <>
          <label className="field"><span>Look</span>
            <div className="chips">
              {(Object.keys(LOOKS) as Look[]).map((l) => (
                <button key={l} className={`chip ${clip.look === l ? "on" : ""}`} onClick={() => set({ look: l })}>{l}</button>
              ))}
            </div>
          </label>
          {slider("Brightness", clip.color.brightness, -0.5, 0.5, 0.01, (v) => setColor({ brightness: v }))}
          {slider("Contrast", clip.color.contrast, 0.3, 2, 0.01, (v) => setColor({ contrast: v }))}
          {slider("Saturation", clip.color.saturation, 0, 2.5, 0.01, (v) => setColor({ saturation: v }))}
          {slider("Hue", clip.color.hue, -180, 180, 1, (v) => setColor({ hue: v }), (v) => `${v}°`)}
          {slider("Blur", clip.color.blur, 0, 30, 1, (v) => setColor({ blur: v }), (v) => `${v}px`)}
          <button className="wide" onClick={() => set({ color: { ...NEUTRAL_COLOR }, look: "none" })}><Icon name="refresh" /> Reset colour</button>
        </>
      )}
    </div>
  );
}
