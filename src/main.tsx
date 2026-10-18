import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { initMedia } from "./lib/platform";

void initMedia().finally(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);

if (import.meta.env.DEV) {
  // handles for debugging in devtools
  void Promise.all([import("./editor/model"), import("./lib/appStore")]).then(([m, a]) => {
    Object.assign(window, { __sf: { useEditor: m.useEditor, useApp: a.useApp } });
  });
}
