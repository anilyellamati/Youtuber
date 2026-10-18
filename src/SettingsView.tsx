import { useEffect, useState } from "react";
import { useSettings, type Engine } from "./lib/settings";
import { useApp } from "./lib/appStore";
import { ENCODER_LABELS, bestEncoder } from "./lib/encoders";
import { invoke, isTauri, openExternal, outputDir, pickFolder } from "./lib/platform";
import { Icon } from "./components/Icon";

export function SettingsView() {
  const s = useSettings();
  const app = useApp();
  const [dir, setDir] = useState(s.outputDir);
  const [ff, setFf] = useState<{ path: string; version: string; os: string; arch: string } | null>(null);

  useEffect(() => {
    void outputDir(s.outputDir).then(setDir).catch(() => {});
    if (isTauri) invoke<typeof ff>("ffmpeg_info").then(setFf).catch(() => setFf(null));
  }, [s.outputDir]);

  const reprobe = async () => {
    try {
      const encoders = await invoke<string[]>("ffmpeg_probe_encoders");
      app.patch({ encoders, hasNative: true });
      app.toast(`Found: ${encoders.map((e) => ENCODER_LABELS[e] ?? e).join(", ")}`, "success");
    } catch (e) {
      app.toast(String(e), "error");
    }
  };

  const seo = s.seo;

  return (
    <div className="settings">
      <div className="card">
        <h3><Icon name="folder" size={16} /> Recording</h3>
        <label className="field"><span>Save videos to</span>
          <div className="inline">
            <input value={dir} readOnly />
            <button disabled={!isTauri} onClick={async () => { const d = await pickFolder(); if (d) s.set({ outputDir: d }); }}>Change</button>
          </div>
        </label>
        <div className="row2">
          <label className="field"><span>Capture engine</span>
            <select value={s.engine} onChange={(e) => s.set({ engine: e.target.value as Engine })}>
              <option value="auto">Automatic (recommended)</option>
              <option value="native" disabled={!app.hasNative}>Native FFmpeg (GPU capture)</option>
              <option value="web">Web (WebCodecs / MediaRecorder)</option>
            </select>
          </label>
          <label className="field"><span>Encoder</span>
            <div className="inline">
              <select value={s.encoder} onChange={(e) => s.set({ encoder: e.target.value })}>
                <option value="auto">Auto · {ENCODER_LABELS[bestEncoder(app.encoders)] ?? "detecting…"}</option>
                {app.encoders.map((e) => <option key={e} value={e}>{ENCODER_LABELS[e] ?? e}</option>)}
              </select>
              <button className="icon-btn" disabled={!isTauri} title="Re-detect GPU encoders" onClick={reprobe}><Icon name="refresh" /></button>
            </div>
          </label>
        </div>
        <label className="check"><input type="checkbox" checked={s.autoOpenEditor} onChange={(e) => s.set({ autoOpenEditor: e.target.checked })} /> Open the editor automatically when a recording stops</label>
        <p className="muted small">{ff ? `${ff.version} · ${ff.os}/${ff.arch}` : isTauri ? "FFmpeg not found: native capture and fast export are disabled. Reinstall StreamForge or install FFmpeg." : "Running in the browser: the web engine is used."}</p>
      </div>

      <div className="card">
        <h3><Icon name="settings" size={16} /> Hotkeys <span className="muted small">(work while you're in-game)</span></h3>
        <div className="row3">
          {(["toggleRecord", "pause", "marker"] as const).map((k) => (
            <label key={k} className="field"><span>{{ toggleRecord: "Start / stop", pause: "Pause / resume", marker: "Chapter marker" }[k]}</span>
              <input value={s.hotkeys[k]} onChange={(e) => s.set({ hotkeys: { ...s.hotkeys, [k]: e.target.value } })} placeholder="e.g. F9 or CommandOrControl+Shift+R" />
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h3><Icon name="youtube" size={16} /> YouTube connection</h3>
        <p className="muted small">
          StreamForge signs in with Google OAuth (PKCE + loopback). Builds can embed a client ID; otherwise create a <b>Desktop app</b> OAuth client in Google Cloud with the YouTube Data API v3 enabled and paste it here.{" "}
          <button className="link" onClick={() => openExternal("https://console.cloud.google.com/apis/credentials")}>Open Google Cloud console</button>
        </p>
        <div className="row2">
          <label className="field"><span>OAuth client ID</span><input value={s.googleClientId} onChange={(e) => s.set({ googleClientId: e.target.value.trim() })} placeholder="xxxx.apps.googleusercontent.com" /></label>
          <label className="field"><span>Client secret (Desktop clients)</span><input type="password" value={s.googleClientSecret} onChange={(e) => s.set({ googleClientSecret: e.target.value.trim() })} /></label>
        </div>
      </div>

      <div className="card">
        <h3><Icon name="hash" size={16} /> Default SEO profile</h3>
        <div className="row2">
          <label className="field"><span>Channel name</span><input value={seo.channelName} onChange={(e) => s.setSeo({ channelName: e.target.value })} /></label>
          <label className="field"><span>Title template</span>
            <input value={seo.titleTemplate} onChange={(e) => s.setSeo({ titleTemplate: e.target.value })} />
            <small className="muted">Variables: {"{game} {type} {episode} {hook} {channel}"}</small>
          </label>
        </div>
        <div className="row2">
          <label className="field"><span>Default hashtags</span><input value={seo.defaultHashtags} onChange={(e) => s.setSeo({ defaultHashtags: e.target.value })} /></label>
          <label className="field"><span>Default tags (comma separated)</span><input value={seo.defaultTags} onChange={(e) => s.setSeo({ defaultTags: e.target.value })} /></label>
        </div>
        <div className="row2">
          <label className="field"><span>Social links (added to every description)</span><textarea rows={3} value={seo.socials} onChange={(e) => s.setSeo({ socials: e.target.value })} placeholder={"Twitch: twitch.tv/you\nDiscord: discord.gg/…"} /></label>
          <label className="field"><span>Description footer</span><textarea rows={3} value={seo.descriptionFooter} onChange={(e) => s.setSeo({ descriptionFooter: e.target.value })} /></label>
        </div>
        <div className="row3">
          <label className="field"><span>Default visibility</span>
            <select value={seo.privacy} onChange={(e) => s.setSeo({ privacy: e.target.value as typeof seo.privacy })}>
              <option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option>
            </select>
          </label>
          <label className="field"><span>Language</span>
            <select value={seo.language} onChange={(e) => s.setSeo({ language: e.target.value })}>
              {[["en", "English"], ["hi", "Hindi"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["ja", "Japanese"], ["ko", "Korean"], ["id", "Indonesian"], ["ar", "Arabic"], ["ru", "Russian"], ["ta", "Tamil"], ["te", "Telugu"], ["bn", "Bengali"]].map(([c, n]) => (
                <option key={c} value={c}>{n}</option>
              ))}
            </select>
          </label>
          <div className="field">
            <label className="check"><input type="checkbox" checked={seo.notifySubscribers} onChange={(e) => s.setSeo({ notifySubscribers: e.target.checked })} /> Notify subscribers</label>
            <label className="check"><input type="checkbox" checked={seo.madeForKids} onChange={(e) => s.setSeo({ madeForKids: e.target.checked })} /> Made for kids</label>
          </div>
        </div>
      </div>

      <div className="card">
        <h3><Icon name="sparkles" size={16} /> AI writer (optional)</h3>
        <p className="muted small">Uses Claude to write titles, descriptions, tags and thumbnail text. Your key is stored only on this device.</p>
        <label className="field"><span>Anthropic API key</span><input type="password" value={s.anthropicKey} onChange={(e) => s.set({ anthropicKey: e.target.value.trim() })} placeholder="sk-ant-…" /></label>
      </div>
    </div>
  );
}
