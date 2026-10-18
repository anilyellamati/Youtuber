// Downloads a static FFmpeg build for a Rust target triple and places it where Tauri
// expects a sidecar: src-tauri/bin/ffmpeg-<triple>[.exe].
//
//   node scripts/fetch-ffmpeg.mjs x86_64-pc-windows-msvc
//   FFMPEG_URL=https://…/ffmpeg.zip node scripts/fetch-ffmpeg.mjs i686-pc-windows-msvc
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCES = {
  "x86_64-pc-windows-msvc": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
  // BtbN has no 32-bit builds; pass FFMPEG_URL for i686 (the app falls back to the web engine without it)
  "i686-pc-windows-msvc": process.env.FFMPEG_URL_I686 || "",
  "x86_64-apple-darwin": "https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip",
  "aarch64-apple-darwin": "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
  "x86_64-unknown-linux-gnu": "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
};

const triple = process.argv[2];
if (!triple || !(triple in SOURCES)) {
  console.error(`usage: fetch-ffmpeg <${Object.keys(SOURCES).join("|")}>`);
  process.exit(1);
}
const url = process.env.FFMPEG_URL || SOURCES[triple];
if (!url) {
  console.warn(`No FFmpeg source for ${triple}; skipping (native engine disabled in this build).`);
  process.exit(0);
}

const exe = triple.includes("windows") ? ".exe" : "";
const outDir = new URL("../src-tauri/bin/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `ffmpeg-${triple}${exe}`);
if (existsSync(out) && !process.env.FORCE) {
  console.log(`${out} already present`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "ffmpeg-"));
const archive = join(work, url.endsWith(".tar.xz") ? "ff.tar.xz" : "ff.zip");
console.log(`Downloading ${url}`);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) throw new Error(`download failed: ${res.status}`);
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

const extract = join(work, "x");
mkdirSync(extract);
// bsdtar (Windows, macOS) handles zip; GNU tar on Linux handles .tar.xz
if (archive.endsWith(".zip") && process.platform === "linux") execFileSync("unzip", ["-q", archive, "-d", extract]);
else execFileSync("tar", ["-xf", archive, "-C", extract]);

function find(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const hit = find(p);
      if (hit) return hit;
    } else if (name === `ffmpeg${exe}`) return p;
  }
  return null;
}
const bin = find(extract);
if (!bin) throw new Error("ffmpeg binary not found in archive");
copyFileSync(bin, out);
if (!exe) chmodSync(out, 0o755);
console.log(`Installed ${out}`);
