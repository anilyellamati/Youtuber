import { useEffect, useRef } from "react";
import { clipDuration, makeClip, projectDuration, snapTime, updateClip, useEditor, type Clip, type Track } from "./model";
import { formatTime } from "../lib/platform";
import { Icon } from "../components/Icon";

const LABEL_W = 132;

export function Timeline() {
  const { project: p, zoom, playhead, selection, snapping } = useEditor();
  const ed = useEditor.getState;
  const scrollRef = useRef<HTMLDivElement>(null);
  const duration = Math.max(projectDuration(p) + 30, 60);
  const width = duration * zoom;

  // keep the playhead in view while playing
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !useEditor.getState().playing) return;
    const x = playhead * zoom;
    if (x > el.scrollLeft + el.clientWidth - 80) el.scrollLeft = x - 80;
  }, [playhead, zoom]);

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - LABEL_W + el.scrollLeft) / zoom);
  };

  const scrub = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    ed().setPlayhead(timeAt(e.clientX));
    const move = (ev: PointerEvent) => ed().setPlayhead(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const el = scrollRef.current!;
      const t = timeAt(e.clientX);
      const nz = Math.min(400, Math.max(2, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      ed().setZoom(nz);
      requestAnimationFrame(() => {
        el.scrollLeft = t * nz - (e.clientX - el.getBoundingClientRect().left - LABEL_W);
      });
    }
  };

  // ruler ticks
  const step = niceStep(80 / zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);

  return (
    <div className="timeline">
      <div className="tl-scroll" ref={scrollRef} onWheel={onWheel}>
        <div className="tl-inner" style={{ width: width + LABEL_W }}>
          <div className="tl-ruler" onPointerDown={scrub}>
            <div className="tl-corner" style={{ width: LABEL_W }}>
              <span className="mono">{formatTime(playhead, true)}</span>
            </div>
            {ticks.map((t) => (
              <div key={t} className="tick" style={{ left: LABEL_W + t * zoom }}>
                <span>{formatTime(t)}</span>
              </div>
            ))}
            {p.markers.map((m, i) => (
              <div key={i} className="tl-marker" style={{ left: LABEL_W + m.time * zoom }} title={`${m.label} (${formatTime(m.time)})`}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const label = prompt("Chapter title", m.label);
                  if (label != null) ed().commit((pp) => ({ ...pp, markers: pp.markers.map((x, j) => (j === i ? { ...x, label } : x)) }));
                }}
              >
                <Icon name="flag" size={12} />
              </div>
            ))}
          </div>
          {p.tracks.map((track) => (
            <Lane key={track.id} track={track} timeAt={timeAt} snapping={snapping} selection={selection} />
          ))}
          <div className="tl-playhead" style={{ left: LABEL_W + playhead * zoom }} />
        </div>
      </div>
    </div>
  );
}

function Lane({ track, timeAt, snapping, selection }: { track: Track; timeAt: (x: number) => number; snapping: boolean; selection: string[] }) {
  const { project: p, zoom } = useEditor();
  const ed = useEditor.getState;
  const clips = p.clips.filter((c) => c.trackId === track.id);

  const setTrack = (patch: Partial<Track>) =>
    ed().commit((pp) => ({ ...pp, tracks: pp.tracks.map((t) => (t.id === track.id ? { ...t, ...patch } : t)) }));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const assetId = e.dataTransfer.getData("application/x-asset");
    if (!assetId || track.locked) return;
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const okKind = track.kind === "audio" ? asset.hasAudio : track.kind === "video" && asset.kind !== "audio";
    if (!okKind) return;
    const clip = makeClip(asset, track.id, timeAt(e.clientX));
    ed().commit((pp) => ({ ...pp, clips: [...pp.clips, clip] }));
    ed().select([clip.id]);
  };

  return (
    <div className={`tl-lane ${track.kind}`} data-track={track.id}>
      <div className="tl-label" style={{ width: LABEL_W }}>
        <span className="tl-name">{track.id} · {track.name}</span>
        <div className="tl-btns">
          {track.kind !== "text" && (
            <button className={`icon-btn ${track.muted ? "on" : ""}`} title="Mute" onClick={() => setTrack({ muted: !track.muted })}>
              <Icon name={track.muted ? "mute" : "volume"} size={14} />
            </button>
          )}
          {track.kind !== "audio" && (
            <button className={`icon-btn ${track.hidden ? "on" : ""}`} title="Hide" onClick={() => setTrack({ hidden: !track.hidden })}>
              <Icon name={track.hidden ? "eyeOff" : "eye"} size={14} />
            </button>
          )}
          <button className={`icon-btn ${track.locked ? "on" : ""}`} title="Lock" onClick={() => setTrack({ locked: !track.locked })}>
            <Icon name="lock" size={14} />
          </button>
        </div>
      </div>
      <div className="tl-track" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) ed().select([]);
        }}
      >
        {clips.map((c) => (
          <ClipView key={c.id} clip={c} track={track} zoom={zoom} selected={selection.includes(c.id)} snapping={snapping} />
        ))}
      </div>
    </div>
  );
}

function ClipView({ clip: c, track, zoom, selected, snapping }: { clip: Clip; track: Track; zoom: number; selected: boolean; snapping: boolean }) {
  const ed = useEditor.getState;
  const asset = useEditor((s) => s.project.assets.find((a) => a.id === c.assetId));
  const dur = clipDuration(c);

  const begin = (e: React.PointerEvent, mode: "move" | "left" | "right") => {
    if (track.locked) return;
    e.stopPropagation();
    const multi = e.shiftKey || e.metaKey || e.ctrlKey;
    const sel = ed().selection;
    ed().select(multi ? (sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id]) : sel.includes(c.id) ? sel : [c.id]);
    ed().checkpoint();
    const x0 = e.clientX;
    const orig = { ...c };
    const maxOut = asset && asset.kind !== "image" ? asset.duration : Infinity;
    const tol = 8 / zoom;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      const st = ed();
      if (mode === "move") {
        let start = Math.max(0, orig.start + dt);
        if (st.snapping && snapping) {
          const s1 = snapTime(st.project, start, tol, [c.id], st.playhead);
          const s2 = snapTime(st.project, start + dur, tol, [c.id], st.playhead) - dur;
          start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : s2;
        }
        // vertical move to another lane of the same kind
        const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-track]") as HTMLElement | null;
        const target = lane && st.project.tracks.find((t) => t.id === lane.dataset.track);
        const trackId = target && !target.locked && target.kind === track.kind ? target.id : c.trackId;
        st.mutate((pp) => updateClip(pp, c.id, { start: Math.max(0, start), trackId }));
      } else if (mode === "left") {
        let start = orig.start + dt;
        if (st.snapping && snapping) start = snapTime(st.project, start, tol, [c.id], st.playhead);
        const delta = start - orig.start;
        let newIn = orig.in + delta * orig.speed;
        if (newIn < 0) newIn = 0;
        if (newIn > orig.out - 0.1) newIn = orig.out - 0.1;
        const realDelta = (newIn - orig.in) / orig.speed;
        st.mutate((pp) => updateClip(pp, c.id, { in: newIn, start: Math.max(0, orig.start + realDelta) }));
      } else {
        let end = orig.start + (orig.out - orig.in) / orig.speed + dt;
        if (st.snapping && snapping) end = snapTime(st.project, end, tol, [c.id], st.playhead);
        let out = orig.in + (end - orig.start) * orig.speed;
        out = Math.min(maxOut, Math.max(orig.in + 0.1, out));
        st.mutate((pp) => updateClip(pp, c.id, { out }));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const label = c.kind === "text" ? c.text?.text.split("\n")[0] : asset?.name ?? "missing media";
  const thumbs = asset?.thumbs ?? [];
  const w = dur * zoom;
  const thumbW = 54 * ((asset?.width || 16) / (asset?.height || 9));
  const count = Math.max(1, Math.ceil(w / thumbW));
  const srcDur = asset?.duration || 1;

  return (
    <div
      className={`tl-clip ${c.kind === "text" ? "text" : asset?.kind ?? ""} ${track.kind} ${selected ? "sel" : ""}`}
      style={{ left: c.start * zoom, width: Math.max(4, w) }}
      onPointerDown={(e) => begin(e, "move")}
      title={`${label} · ${formatTime(dur, true)}${c.speed !== 1 ? ` · ${c.speed}×` : ""}`}
    >
      {track.kind === "video" && thumbs.length > 0 && w > 30 && (
        <div className="filmstrip">
          {Array.from({ length: Math.min(count, 60) }, (_, i) => {
            const srcT = c.in + ((i + 0.5) * thumbW / zoom) * c.speed;
            const ti = Math.min(thumbs.length - 1, Math.max(0, Math.floor((srcT / srcDur) * thumbs.length)));
            return <img key={i} src={thumbs[ti]} style={{ width: thumbW }} alt="" draggable={false} />;
          })}
        </div>
      )}
      {track.kind === "audio" && <div className="wave" />}
      {c.fadeIn > 0 && <div className="fade-in" style={{ width: c.fadeIn * zoom }} />}
      {c.fadeOut > 0 && <div className="fade-out" style={{ width: c.fadeOut * zoom }} />}
      <span className="clip-label">
        {c.kind === "text" && <Icon name="text" size={12} />} {label}
        {c.speed !== 1 && <b> {c.speed}×</b>}
      </span>
      <div className="handle l" onPointerDown={(e) => begin(e, "left")} />
      <div className="handle r" onPointerDown={(e) => begin(e, "right")} />
    </div>
  );
}

function niceStep(min: number) {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]) if (s >= min) return s;
  return 3600;
}

