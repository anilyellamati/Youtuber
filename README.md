# StreamForge

## ⬇️ Download

### [Download StreamForge Rec for Windows (64-bit) — StreamForgeRec-windows-x64.zip](https://github.com/anilyellamati/Youtuber/releases/download/rec-v1.0.1/StreamForgeRec-windows-x64.zip)

65 MB. Unzip anywhere and run `StreamForgeRec.exe` (keep `ffmpeg.exe` in the same folder). No installer needed.

**StreamForge Rec** is a strict, lightweight screen recorder:

- A small native Windows window with no browser engine and no live preview; the window itself uses about 2 MB of memory.
- Captures on the graphics card and encodes with its own encoder (NVIDIA, AMD or Intel), at below-normal priority so games keep the CPU.
- Dropdowns to choose what to record (any display or an open window), which microphone, and an optional camera shown in the bottom-right corner.
- Records computer sound. **F9** starts and stops from inside a game.
- Watches the disk and stops safely at 97% full.
- Four exports: YouTube High, YouTube Low, Story 9:16 High, Story 9:16 Low.

![StreamForge Rec](https://github.com/anilyellamati/Youtuber/releases/download/rec-v1.0.1/StreamForgeRec-screenshot.png)

**First launch:** Windows SmartScreen may warn about an unknown publisher; click **More info** → **Run anyway**.

---

The rest of this page describes the larger StreamForge studio app (recorder + editor + YouTube publishing), whose source is in this repository. It has no published builds at the moment.

## Platforms

| Platform | Build | Capture engine |
|---|---|---|
| Windows 10/11 x64 | `.exe` (NSIS) + `.msi` | Web (WebView2): screen + **game audio** + facecam, hardware MediaRecorder. Native FFmpeg `ddagrab` (GPU desktop duplication) optional |
| Windows x86 (32-bit) | `.exe` (NSIS) | Web engine (bundle a 32-bit FFmpeg via `FFMPEG_URL_I686` to enable native capture + fast export) |
| macOS Apple Silicon | `.dmg` | Native FFmpeg + AVFoundation + VideoToolbox |
| macOS Intel | `.dmg` | Native FFmpeg + AVFoundation + VideoToolbox |
| Android 7+ | `.apk` / `.aab` | MediaProjection + floating facecam bubble (native plugin) |
| iOS | via CI with signing | Editor + publishing; screen capture needs a ReplayKit broadcast extension (planned) |
| Linux x64 | `.deb` / `.AppImage` | Native FFmpeg `x11grab` |

## Why it's light

- **Tauri 2 (Rust + the OS webview)**: installers are ~10 MB instead of ~150 MB for Electron, and idle RAM is a fraction of it. There's no bundled Chromium, so WebView2 on Windows and WebKit on macOS do the rendering.
- **GPU-first capture**: Windows desktop duplication (`ddagrab`) and macOS AVFoundation feed hardware encoders (NVENC, Quick Sync, AMF, VideoToolbox, Media Foundation). Each encoder is test-run at startup and the fastest working one is chosen automatically. On machines with no usable GPU encoder, x264 `ultrafast` takes over.
- **The facecam is composited inside the encoder graph.** The bubble shape is rendered once to an alpha mask and `alphamerge`d, so there's no per-frame JavaScript work while you play.
- **Crash-safe recordings**: fragmented MP4 (native) or 1-second chunks streamed to disk (web), so a game crash loses at most a second.
- **One-pass export**: the whole timeline compiles to a single FFmpeg filter graph. The main track is concatenated rather than overlaid, and looks use LUT-based `eq`. On a dual-core 7 W MacBook Air (i5-8210Y), a 1080p timeline with a rotated PiP overlay exports at about 1.2× realtime.
- **Hotkeys work in-game**: F9 record/stop, F10 pause, F8 chapter marker (configurable).

## Features

**Recorder**
- Layouts: facecam bubble, camera left/right, side column, camera top (Shorts), game only, camera only.
- Bubble shapes: circle, rounded, square, hexagon, heart. Drag to move, scroll to resize.
- A border with a **voice-reactive glow ring**, camera zoom and mirror, and looks (vivid, warm, cool, noir, retro, neon).
- Mic and game-audio gain, a countdown, pause/resume (segments are joined losslessly), and chapter markers.
- Quality presets: Low-spec 720p30, 1080p30, 1080p60, 1440p60, Shorts 1080×1920.

**Editor (multi-track NLE)**
- Tracks: Titles, Overlay, Main, Music and Voice/SFX, each with mute, hide and lock.
- Drag, trim, split (S), ripple delete (Shift+Del), duplicate (Ctrl+D), snapping, filmstrip thumbnails, zoom (Ctrl+scroll), and undo/redo (100 steps).
- Per clip: position, scale, rotation and opacity (picture-in-picture), speed 0.25×–8× with pitch-correct audio, volume, fades, colour (brightness, contrast, saturation, hue, blur) and cinematic looks.
- Animated titles (pop, slide-up, fade) with YouTuber, lower-third, meme, neon and warning presets.
- **Auto jump-cut**: detects silent parts and removes them in one click.
- Chapter markers carry over from recording into the YouTube description.
- Export presets: 1080p, 1080p60, 1440p60, 4K60, Shorts 9:16 and 720p.
- Shortcuts: Space, J/K/L, arrow keys, Home/End, M (marker), T (title).

**Publisher**
- One-time Google sign-in (OAuth 2.0 + PKCE, loopback). Tokens auto-refresh, and the stored token file is readable only by your user account.
- **SEO autopilot**: 19 game keyword packs, 11 video types with hook suggestions, per-game episode counters and title templates. It enforces YouTube's limits: 100-character titles, 500 characters of tags, 15 hashtags, and valid chapter lists (starting at 0:00, ≥3 chapters, each ≥10 s).
- Optional **AI writer** (Claude) suggests five titles, a description, tags and thumbnail text, using your own API key.
- A **thumbnail maker** puts bold captions over any frame and attaches the result to the upload.
- Resumable 8 MB chunked uploads that auto-retry after network drops, plus scheduling, visibility, made-for-kids and notify settings.
- Automatic Shorts detection (vertical and ≤3 min).

## Develop

```bash
npm install
npm run tauri dev       # desktop app with hot reload
npm run dev             # UI only in a browser (web engine)
```

Requirements: Node 20+, Rust stable, and FFmpeg on your PATH for development. Release builds bundle FFmpeg.

### Build installers

CI ([.github/workflows/release.yml](.github/workflows/release.yml)) builds Windows x64/x86, macOS ARM/Intel, Linux and Android on every push, and iOS when `IOS_ENABLED=true` and the signing secrets are set. Push a `v*` tag to get a draft GitHub release containing every installer.

Local macOS build:

```bash
node scripts/fetch-ffmpeg.mjs x86_64-apple-darwin   # or aarch64-apple-darwin
npx tauri build --bundles app,dmg --config '{"bundle":{"externalBin":["bin/ffmpeg"]}}'
```

Regenerate the icon set after editing [assets/icon.svg](assets/icon.svg):

```bash
npm run icons
```

### YouTube API setup (one time, for the publisher)

1. In Google Cloud, create a project, enable the **YouTube Data API v3**, and configure the OAuth consent screen with the scopes `youtube.upload` and `youtube.readonly`.
2. Create an OAuth client of type **Desktop app**.
3. Either set `SF_GOOGLE_CLIENT_ID` / `SF_GOOGLE_CLIENT_SECRET` as CI secrets so users get one-click sign-in, or paste them into **Settings → YouTube connection**.
4. Uploads from unverified API projects are locked to *private* until Google approves the project through its API audit. Apply before public launch.

### Secrets used by CI (all optional)

| Secret | Purpose |
|---|---|
| `SF_GOOGLE_CLIENT_ID`, `SF_GOOGLE_CLIENT_SECRET` | Built-in YouTube sign-in |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | macOS signing and notarization |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` + variable `IOS_ENABLED=true` | iOS build |
| variable `FFMPEG_URL_I686` | 32-bit FFmpeg zip for the Windows x86 build |

## Project layout

```
src/
  recorder/   layouts.ts (shared geometry) · webEngine.ts · nativeEngine.ts · mobileEngine.ts · RecorderView.tsx
  editor/     model.ts (project + undo) · render.ts (preview) · exportNative.ts (timeline → FFmpeg) · Timeline/Inspector/EditorView
  youtube/    seo.ts (keyword packs + generator) · ai.ts (Claude) · api.ts · PublishView.tsx (+ thumbnail maker)
src-tauri/    Rust core: ffmpeg.rs (jobs, devices, encoder probe) · youtube.rs (OAuth PKCE + resumable upload) · files.rs
plugins/screenrec/   Android MediaProjection + facecam bubble plugin (Kotlin)
```

## Licensing note

Release builds ship FFmpeg as a separate executable. The default Windows build comes from BtbN, which is GPL because it includes x264. Distribute FFmpeg's license and a source offer with your installers, or switch the download URLs to LGPL builds.
