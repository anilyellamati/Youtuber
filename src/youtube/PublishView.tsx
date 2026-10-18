import { useEffect, useMemo, useRef, useState } from "react";
import { GAMES, VIDEO_TYPES, chapters, fitTags, generateMetadata, isShort } from "./seo";
import type { AiSuggestion } from "./ai";
import { ytLogin, ytLogout, ytUpload, type UploadProgress } from "./api";
import { useApp } from "../lib/appStore";
import { useSettings } from "../lib/settings";
import { baseName, fileUrl, formatBytes, formatTime, isTauri, joinPath, openExternal, outputDir, pickFiles, timestampName, uid, writeBytes } from "../lib/platform";
import { Icon } from "../components/Icon";

export function PublishView() {
  const app = useApp();
  const s = useSettings();
  const target = app.publishTarget;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [vid, setVid] = useState({ w: 16, h: 9, duration: target?.duration ?? 0 });

  // --- SEO inputs
  const [gameId, setGameId] = useState(() => localStorage.getItem("sf-last-game") || "minecraft");
  const [customGame, setCustomGame] = useState("");
  const [typeId, setTypeId] = useState("letsplay");
  const game = GAMES.find((g) => g.id === gameId)!;
  const type = VIDEO_TYPES.find((t) => t.id === typeId)!;
  const gameKey = gameId === "other" ? customGame.toLowerCase() : gameId;
  const [episode, setEpisode] = useState(0);
  const [hook, setHook] = useState(type.hooks[0]);
  const [notes, setNotes] = useState("");
  const vertical = vid.h > vid.w;
  const markers = target?.markers ?? [];

  useEffect(() => {
    setEpisode((s.seo.episodeCounters[gameKey] ?? 0) + 1);
    localStorage.setItem("sf-last-game", gameId);
  }, [gameKey, gameId, s.seo.episodeCounters]);

  const auto = useMemo(
    () => generateMetadata({ game, customGame, type, episode, hook, notes, markers, duration: vid.duration, vertical, profile: s.seo }),
    [game, customGame, type, episode, hook, notes, markers, vid.duration, vertical, s.seo],
  );

  // --- editable output (follows the generator until the user edits a field)
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [dirty, setDirty] = useState({ title: false, description: false, tags: false });
  useEffect(() => {
    if (!dirty.title) setTitle(auto.title);
    if (!dirty.description) setDescription(auto.description);
    if (!dirty.tags) setTags(auto.tags);
  }, [auto, dirty]);

  const [privacy, setPrivacy] = useState(s.seo.privacy);
  const [scheduleAt, setScheduleAt] = useState("");
  const [madeForKids, setMadeForKids] = useState(s.seo.madeForKids);
  const [notify, setNotify] = useState(s.seo.notifySubscribers);
  const [thumbPath, setThumbPath] = useState<string | null>(null);
  const [thumbText, setThumbText] = useState("");
  const [ai, setAi] = useState<AiSuggestion | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  useEffect(() => {
    setVideoId(null);
    setUpload(null);
    setThumbPath(null);
  }, [target?.path]);

  const pickVideo = async () => {
    const files = await pickFiles({ filters: [{ name: "Video", extensions: ["mp4", "mov", "webm", "mkv"] }] });
    if (files?.[0]) app.patch({ publishTarget: { path: files[0], name: baseName(files[0]), duration: 0, markers: [], createdAt: Date.now() } });
  };

  const login = async () => {
    setLoginBusy(true);
    try {
      const channel = await ytLogin(s.googleClientId, s.googleClientSecret);
      app.patch({ channel });
      app.toast(`Signed in as ${channel.title}`, "success");
    } catch (e) {
      app.toast(String(e), "error");
    } finally {
      setLoginBusy(false);
    }
  };

  const runAi = async () => {
    if (!s.anthropicKey) {
      app.toast("Add your Anthropic API key in Settings → AI to use the AI writer", "error");
      return;
    }
    setAiBusy(true);
    try {
      const { suggestMetadata } = await import("./ai"); // keeps the SDK out of the startup bundle
      const res = await suggestMetadata(s.anthropicKey, {
        game: gameId === "other" ? customGame : game.name,
        type: type.name,
        notes,
        chapters: chapters(markers, vid.duration),
        short: isShort(vid.duration, vertical),
        language: s.seo.language,
      });
      setAi(res);
      setThumbText(res.thumbnailText);
      setTitle(res.titles[0]);
      const chap = chapters(markers, vid.duration);
      setDescription(
        [res.description, chap.length ? ["", "⏱ Chapters", ...chap].join("\n") : "", "", s.seo.descriptionFooter, s.seo.socials ? `\n🔗 Follow me\n${s.seo.socials}` : "", "", auto.description.split("\n").pop()]
          .join("\n")
          .replace(/\n{3,}/g, "\n\n"),
      );
      setTags(fitTags([...res.tags, ...auto.tags]));
      setDirty({ title: true, description: true, tags: true });
    } catch (e) {
      app.toast(`AI writer: ${(e as Error).message}`, "error");
    } finally {
      setAiBusy(false);
    }
  };

  const doUpload = async () => {
    if (!target) return;
    const id = uid();
    setUpload({ id, sent: 0, total: 1, stage: "starting" });
    try {
      const vId = await ytUpload(
        id,
        {
          path: target.path, title, description, tags, categoryId: "20", privacy,
          publishAt: scheduleAt ? new Date(scheduleAt).toISOString() : undefined,
          madeForKids, language: s.seo.language, notifySubscribers: notify, thumbnail: thumbPath ?? undefined,
        },
        setUpload,
      );
      setVideoId(vId);
      s.setSeo({ episodeCounters: { ...s.seo.episodeCounters, [gameKey]: episode } });
      app.toast("Uploaded to YouTube 🎉", "success");
    } catch (e) {
      setUpload(null);
      app.toast(String(e), "error");
    }
  };

  const titleLen = title.length;
  const tagChars = tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0) + 1, 0);
  const pct = upload ? Math.round((upload.sent / Math.max(1, upload.total)) * 100) : 0;

  return (
    <div className="publish">
      <section className="pub-left">
        <div className="card channel">
          {app.channel ? (
            <>
              {app.channel.thumbnail ? <img src={app.channel.thumbnail} alt="" /> : <Icon name="youtube" size={32} />}
              <div className="grow">
                <b>{app.channel.title}</b>
                <span className="muted small">{Number(app.channel.subscribers).toLocaleString()} subscribers · {app.channel.videos} videos</span>
              </div>
              <button className="ghost" title="Sign out" onClick={async () => { await ytLogout(); app.patch({ channel: null }); }}><Icon name="logout" /></button>
            </>
          ) : (
            <>
              <Icon name="youtube" size={32} />
              <div className="grow">
                <b>Connect your YouTube channel</b>
                <span className="muted small">Sign in once with Google; StreamForge keeps you signed in.</span>
              </div>
              <button className="primary" disabled={!isTauri || loginBusy} onClick={login}>{loginBusy ? "Waiting for browser…" : "Sign in"}</button>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <b>Video</b>
            {isTauri && <button className="small" onClick={pickVideo}><Icon name="folder" size={14} /> Choose file</button>}
          </div>
          {target ? (
            <>
              <video
                ref={videoRef}
                className={`pub-video ${vertical ? "vertical" : ""}`}
                src={fileUrl(target.path)}
                controls
                crossOrigin="anonymous"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  setVid({ w: v.videoWidth || 16, h: v.videoHeight || 9, duration: isFinite(v.duration) ? v.duration : target.duration });
                }}
              />
              <p className="muted small">{target.name} · {formatTime(vid.duration)} · {vid.w}×{vid.h}{isShort(vid.duration, vertical) && " · will publish as a Short"}</p>
            </>
          ) : (
            <div className="empty-box">
              <Icon name="film" size={28} />
              <p>Record or export a video, or choose a file.</p>
            </div>
          )}
        </div>

        {target && <ThumbnailMaker video={videoRef} text={thumbText || hook} onText={setThumbText} onSaved={setThumbPath} saved={thumbPath} />}
      </section>

      <section className="pub-right">
        <div className="card">
          <div className="card-head">
            <b><Icon name="hash" size={16} /> SEO autopilot</b>
            <button className="small accent" onClick={runAi} disabled={aiBusy}>
              <Icon name="sparkles" size={14} /> {aiBusy ? "Writing…" : "AI write"}
            </button>
          </div>
          <div className="row2">
            <label className="field"><span>Game</span>
              <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
                {GAMES.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            {gameId === "other" ? (
              <label className="field"><span>Game name</span><input value={customGame} onChange={(e) => setCustomGame(e.target.value)} placeholder="e.g. Hollow Knight" /></label>
            ) : (
              <label className="field"><span>Episode #</span><input type="number" min={0} value={episode} onChange={(e) => setEpisode(+e.target.value)} /></label>
            )}
          </div>
          <div className="chips">
            {VIDEO_TYPES.map((t) => (
              <button key={t.id} className={`chip ${typeId === t.id ? "on" : ""}`} onClick={() => { setTypeId(t.id); setHook(t.hooks[0]); }}>{t.name}</button>
            ))}
          </div>
          <label className="field"><span>Hook</span>
            <input value={hook} onChange={(e) => setHook(e.target.value)} />
          </label>
          <div className="chips small">
            {type.hooks.map((h) => <button key={h} className="chip small" onClick={() => setHook(h)}>{h}</button>)}
          </div>
          <label className="field"><span>What happens in this video? (optional, improves SEO)</span>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Beat the Ender Dragon on hardcore with only wooden tools…" />
          </label>
          {ai && (
            <div className="chips">
              {ai.titles.map((t) => <button key={t} className={`chip ${title === t ? "on" : ""}`} onClick={() => setTitle(t)}>{t}</button>)}
            </div>
          )}
        </div>

        <div className="card">
          <label className="field">
            <span>Title <b className={titleLen > 100 ? "bad" : "muted"}>{titleLen}/100</b>
              {dirty.title && <button className="link" onClick={() => setDirty((d) => ({ ...d, title: false }))}>reset</button>}
            </span>
            <input value={title} maxLength={100} onChange={(e) => { setTitle(e.target.value); setDirty((d) => ({ ...d, title: true })); }} />
          </label>
          <label className="field">
            <span>Description <b className="muted">{description.length}/5000</b>
              {dirty.description && <button className="link" onClick={() => setDirty((d) => ({ ...d, description: false }))}>reset</button>}
            </span>
            <textarea rows={9} value={description} maxLength={5000} onChange={(e) => { setDescription(e.target.value); setDirty((d) => ({ ...d, description: true })); }} />
          </label>
          <div className="field">
            <span>Tags <b className={tagChars > 500 ? "bad" : "muted"}>{tagChars}/500</b></span>
            <div className="tags">
              {tags.map((t) => (
                <span key={t} className="tag">{t}<button onClick={() => { setTags(tags.filter((x) => x !== t)); setDirty((d) => ({ ...d, tags: true })); }}>×</button></span>
              ))}
              <input placeholder="add tag…" onKeyDown={(e) => {
                const v = e.currentTarget.value.trim();
                if ((e.key === "Enter" || e.key === ",") && v) {
                  e.preventDefault();
                  setTags(fitTags([...tags, v], 500));
                  setDirty((d) => ({ ...d, tags: true }));
                  e.currentTarget.value = "";
                }
              }} />
            </div>
          </div>
          <div className="row3">
            <label className="field"><span>Visibility</span>
              <select value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)} disabled={!!scheduleAt}>
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </select>
            </label>
            <label className="field"><span>Schedule (optional)</span>
              <input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            </label>
            <div className="field">
              <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify subscribers</label>
              <label className="check"><input type="checkbox" checked={madeForKids} onChange={(e) => setMadeForKids(e.target.checked)} /> Made for kids</label>
            </div>
          </div>

          {videoId ? (
            <div className="done-box">
              <Icon name="check" /> Published!
              <button className="link" onClick={() => openExternal(`https://youtu.be/${videoId}`)}>youtu.be/{videoId}</button>
              <button className="small" onClick={() => openExternal(`https://studio.youtube.com/video/${videoId}/edit`)}>Open in Studio</button>
            </div>
          ) : upload ? (
            <div className="progress"><div style={{ width: `${pct}%` }} /><span>{pct}% · {upload.stage} · {formatBytes(upload.sent)} / {formatBytes(upload.total)}</span></div>
          ) : (
            <button className="primary big" disabled={!target || !app.channel || !title.trim()} onClick={doUpload}>
              <Icon name="upload" /> {scheduleAt ? "Schedule on YouTube" : "Publish to YouTube"}
            </button>
          )}
          {!app.channel && <p className="muted small">Sign in to your channel to publish.</p>}
        </div>
      </section>
    </div>
  );
}

const THUMB_STYLES = [
  { id: "bold", label: "Bold", color: "#ffffff", stroke: "#000000", band: "" },
  { id: "red", label: "Red band", color: "#ffffff", stroke: "#000000", band: "#e0115f" },
  { id: "yellow", label: "Yellow", color: "#ffe600", stroke: "#000000", band: "" },
  { id: "neon", label: "Neon", color: "#39ff14", stroke: "#08130a", band: "rgba(0,0,0,.55)" },
];

function ThumbnailMaker({ video, text, onText, onSaved, saved }: {
  video: React.RefObject<HTMLVideoElement>; text: string; onText: (t: string) => void; onSaved: (p: string) => void; saved: string | null;
}) {
  const app = useApp();
  const settings = useSettings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [style, setStyle] = useState(THUMB_STYLES[1]);
  const [side, setSide] = useState<"left" | "right">("left");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const bump = () => setTick((t) => t + 1);
    v.addEventListener("seeked", bump);
    v.addEventListener("loadeddata", bump);
    return () => {
      v.removeEventListener("seeked", bump);
      v.removeEventListener("loadeddata", bump);
    };
  }, [video]);

  useEffect(() => {
    const c = canvasRef.current, v = video.current;
    if (!c || !v) return;
    const ctx = c.getContext("2d")!;
    const W = 1280, H = 720;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, W, H);
    if (v.readyState >= 2) {
      const s = Math.max(W / v.videoWidth, H / v.videoHeight);
      ctx.filter = "saturate(1.35) contrast(1.12)";
      ctx.drawImage(v, (W - v.videoWidth * s) / 2, (H - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
      ctx.filter = "none";
    }
    // darken the text side for legibility
    const g = ctx.createLinearGradient(side === "left" ? 0 : W, 0, side === "left" ? W : 0, 0);
    g.addColorStop(0, "rgba(0,0,0,.65)");
    g.addColorStop(0.6, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const words = text.toUpperCase().split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    for (const w of words) {
      const lastLine = lines[lines.length - 1];
      if (lastLine && (lastLine + " " + w).length <= 11) lines[lines.length - 1] = lastLine + " " + w;
      else lines.push(w);
    }
    const shown = lines.slice(0, 3);
    const size = shown.length > 2 ? 120 : 150;
    ctx.font = `900 ${size}px Impact, 'Arial Black', sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = side === "left" ? "left" : "right";
    ctx.lineJoin = "round";
    const x = side === "left" ? 56 : W - 56;
    const top = H / 2 - ((shown.length - 1) * size * 1.02) / 2;
    shown.forEach((line, i) => {
      const y = top + i * size * 1.02;
      if (style.band && i === shown.length - 1) {
        const w = ctx.measureText(line).width + 40;
        ctx.fillStyle = style.band;
        ctx.fillRect(side === "left" ? x - 20 : x - w + 20, y - size * 0.55, w, size * 1.08);
      }
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = 18;
      ctx.strokeText(line, x, y);
      ctx.fillStyle = style.color;
      ctx.fillText(line, x, y);
    });
  }, [text, style, side, tick, video]);

  const save = async () => {
    const c = canvasRef.current!;
    try {
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/jpeg", 0.9));
      if (!isTauri) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "thumbnail.jpg";
        a.click();
        return;
      }
      const path = joinPath(await outputDir(settings.outputDir), timestampName("Thumbnail", "jpg"));
      await writeBytes(path, blob);
      onSaved(path);
      app.toast("Thumbnail saved and attached", "success");
    } catch (e) {
      app.toast(`Thumbnail: ${(e as Error).message}`, "error");
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <b><Icon name="image" size={16} /> Thumbnail</b>
        <span className="muted small">Scrub the video above to pick a frame</span>
      </div>
      <canvas ref={canvasRef} width={1280} height={720} className="thumb-canvas" />
      <div className="row2">
        <label className="field"><span>Text</span><input value={text} onChange={(e) => onText(e.target.value)} /></label>
        <div className="field"><span>Style</span>
          <div className="chips">
            {THUMB_STYLES.map((t) => <button key={t.id} className={`chip ${style.id === t.id ? "on" : ""}`} onClick={() => setStyle(t)}>{t.label}</button>)}
            <button className="chip" onClick={() => setSide(side === "left" ? "right" : "left")}>⇄</button>
          </div>
        </div>
      </div>
      <button className={saved ? "" : "primary"} onClick={save}><Icon name={saved ? "check" : "image"} /> {saved ? "Saved — save again" : "Use this thumbnail"}</button>
    </div>
  );
}
