import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { initMedia, isTauri, invoke } from "./lib/platform";

async function boot() {
  const target = isTauri ? await invoke<string | null>("selftest_target").catch(() => null) : null;
  if (target) {
    await initMedia();
    const { runSelftest } = await import("./selftest");
    return runSelftest(target, await invoke<string | null>("media_base"));
  }
  render(); // don't hold the first paint; media URLs are only needed after user actions
  void initMedia();
}

const render = () =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

void boot();

if (import.meta.env.DEV) {
  // handles for debugging in devtools
  void Promise.all([import("./editor/model"), import("./lib/appStore")]).then(([m, a]) => {
    Object.assign(window, { __sf: { useEditor: m.useEditor, useApp: a.useApp } });
  });
}
