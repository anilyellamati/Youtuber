// Renders assets/icon.svg to a 1024px PNG; `tauri icon` then derives every
// platform size (.ico for Windows, .icns for macOS, Android mipmaps, iOS AppIcon).
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const svg = readFileSync(new URL("../assets/icon.svg", import.meta.url));
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
writeFileSync(new URL("../assets/icon-1024.png", import.meta.url), png);
writeFileSync(new URL("../public/icon.svg", import.meta.url), svg);
console.log("assets/icon-1024.png written");
