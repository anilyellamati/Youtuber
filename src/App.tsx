import { useEffect } from "react";
import { RecorderView } from "./recorder/RecorderView";
import { EditorView } from "./editor/EditorView";
import { PublishView } from "./youtube/PublishView";
import { LibraryView } from "./LibraryView";
import { SettingsView } from "./SettingsView";
import { useApp, recorderControls, type View } from "./lib/appStore";
import { useSettings } from "./lib/settings";
import { invoke, isTauri } from "./lib/platform";
import { ytStatus } from "./youtube/api";
import { Icon } from "./components/Icon";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "record", label: "Record", icon: "record" },
  { id: "edit", label: "Edit", icon: "scissors" },
  { id: "publish", label: "Publish", icon: "youtube" },
  { id: "library", label: "Library", icon: "library" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function App() {
  const app = useApp();
  const hotkeys = useSettings((s) => s.hotkeys);

  // detect native capabilities once
  useEffect(() => {
    if (!isTauri) return;
    invoke("ffmpeg_info")
      .then(async () => {
        app.patch({ hasNative: true });
        const encoders = await invoke<string[]>("ffmpeg_probe_encoders").catch(() => ["libx264"]);
        app.patch({ encoders });
      })
      .catch(() => app.patch({ hasNative: false }));
    ytStatus()
      .then((channel) => app.patch({ channel }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // global hotkeys (work while a game has focus)
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    (async () => {
      try {
        const gs = await import("@tauri-apps/plugin-global-shortcut");
        await gs.unregisterAll();
        const bind = async (key: string, fn: () => void) => {
          if (!key || cancelled) return;
          try {
            await gs.register(key, (e) => e.state === "Pressed" && fn());
          } catch {
            useApp.getState().toast(`Hotkey ${key} is taken by another app`, "error");
          }
        };
        await bind(hotkeys.toggleRecord, () => recorderControls.toggle?.());
        await bind(hotkeys.pause, () => recorderControls.pause?.());
        await bind(hotkeys.marker, () => recorderControls.marker?.());
      } catch {
        /* mobile: no global shortcuts */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hotkeys]);

  const live = app.recState === "recording" || app.recState === "paused";

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand" title="StreamForge">
          <img src="/icon.svg" alt="" />
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav ${app.view === n.id ? "on" : ""}`} onClick={() => app.setView(n.id)}>
            <Icon name={n.icon} size={20} fill={n.id === "record" && live} />
            <span>{n.label}</span>
            {n.id === "record" && live && <i className="live-dot" />}
          </button>
        ))}
        <div className="grow" />
        {app.channel && (
          <div className="nav-channel" title={app.channel.title}>
            {app.channel.thumbnail ? <img src={app.channel.thumbnail} alt="" /> : <Icon name="youtube" />}
          </div>
        )}
      </nav>
      <main className="content">
        {/* Recorder and editor stay mounted so a recording or edit survives navigation */}
        <div className="view" hidden={app.view !== "record"}><RecorderView /></div>
        <div className="view" hidden={app.view !== "edit"}><EditorView /></div>
        {app.view === "publish" && <div className="view"><PublishView /></div>}
        {app.view === "library" && <div className="view"><LibraryView /></div>}
        {app.view === "settings" && <div className="view"><SettingsView /></div>}
      </main>
      <div className="toasts">
        {app.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => app.dismiss(t.id)}>
            <Icon name={t.kind === "error" ? "x" : t.kind === "success" ? "check" : "info"} size={16} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
