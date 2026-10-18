import { useEffect, useState } from "react";
import { useApp } from "./lib/appStore";
import { useSettings } from "./lib/settings";
import { fileUrl, formatBytes, invoke, isTauri, outputDir } from "./lib/platform";
import { Icon } from "./components/Icon";

interface VideoFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export function LibraryView() {
  const app = useApp();
  const s = useSettings();
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<VideoFile[]>([]);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const d = await outputDir(s.outputDir);
      setDir(d);
      setFiles(await invoke<VideoFile[]>("list_videos", { dir: d }));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    if (isTauri) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.outputDir]);

  if (!isTauri) {
    return (
      <div className="library empty-box big">
        <Icon name="library" size={32} />
        <p>The recordings library is available in the desktop app. In the browser, recordings download straight to your Downloads folder.</p>
      </div>
    );
  }

  const asRecording = (f: VideoFile) => ({ path: f.path, name: f.name, duration: 0, markers: [], createdAt: f.modified * 1000 });

  return (
    <div className="library">
      <div className="lib-head">
        <div>
          <h2>Library</h2>
          <span className="muted small mono">{dir}</span>
        </div>
        <div className="grow" />
        <button onClick={() => invoke("reveal_in_folder", { path: dir })}><Icon name="folder" /> Open folder</button>
        <button className="icon-btn" onClick={load} title="Refresh"><Icon name="refresh" /></button>
      </div>
      {error && <p className="bad">{error}</p>}
      {files.length === 0 && !error && (
        <div className="empty-box big">
          <Icon name="film" size={32} />
          <p>No recordings yet. Hit <b>Record</b> to capture your first session.</p>
        </div>
      )}
      <div className="lib-grid">
        {files.map((f) => (
          <div key={f.path} className="lib-item">
            <video src={`${fileUrl(f.path)}#t=1`} preload="metadata" muted />
            <div className="lib-meta">
              <b title={f.name}>{f.name}</b>
              <span className="muted small">{new Date(f.modified * 1000).toLocaleString()} · {formatBytes(f.size)}</span>
            </div>
            <div className="lib-actions">
              <button className="small" onClick={() => app.patch({ editTarget: asRecording(f), view: "edit" })}><Icon name="scissors" size={14} /> Edit</button>
              <button className="small primary" onClick={() => app.patch({ publishTarget: asRecording(f), view: "publish" })}><Icon name="youtube" size={14} /> Publish</button>
              <button className="icon-btn" onClick={() => invoke("reveal_in_folder", { path: f.path })} title="Show in folder"><Icon name="folder" size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
