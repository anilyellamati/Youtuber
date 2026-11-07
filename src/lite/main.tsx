import React from "react";
import ReactDOM from "react-dom/client";
import { LiteApp } from "./LiteApp";
import "../styles.css";
import "./lite.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LiteApp />
  </React.StrictMode>,
);
