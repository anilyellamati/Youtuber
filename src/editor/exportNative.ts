// Compiles the timeline into ONE FFmpeg filter graph: input-seeked sources, colour
// grading, transforms, alpha fades, overlays, text layers (pre-rendered PNGs, so they
// match the preview exactly), speed ramps and an audio mix. Encoding uses the GPU.
import { clipDuration, clipEnd, LOOKS, projectDuration, type Asset, type Clip, type Project } from "./model";
import { drawText } from "./render";
import { encoderArgs, audioArgs } from "../lib/encoders";
import { joinPath, uid, writeBytes } from "../lib/platform";

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "yt1080", label: "YouTube 1080p", width: 1920, height: 1080, fps: 30, kbps: 10000 },
  { id: "yt1080p60", label: "YouTube 1080p60", width: 1920, height: 1080, fps: 60, kbps: 15000 },
  { id: "yt1440", label: "YouTube 1440p60", width: 2560, height: 1440, fps: 60, kbps: 28000 },
  { id: "yt4k", label: "YouTube 4K60", width: 3840, height: 2160, fps: 60, kbps: 60000 },
  { id: "shorts", label: "YouTube Shorts 9:16", width: 1080, height: 1920, fps: 60, kbps: 12000 },
  { id: "yt720", label: "720p (fast / low-spec)", width: 1280, height: 720, fps: 30, kbps: 6000 },
];

const n3 = (x: number) => (Math.round(x * 1000) / 1000).toString();
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

/** atempo accepts 0.5–2.0 per stage; chain stages for larger changes. */
function atempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 0.001) out.push(`atempo=${n3(s)}`);
  return out;
}

function colorChain(c: Clip): string[] {
  const f: string[] = [];
  const { brightness, contrast, saturation, hue, blur } = c.color;
  if (brightness || contrast !== 1 || saturation !== 1) f.push(`eq=brightness=${n3(brightness * 0.5)}:contrast=${n3(contrast)}:saturation=${n3(saturation)}`);
  if (hue) f.push(`hue=h=${n3(hue)}`);
  if (blur) f.push(`boxblur=${Math.max(1, Math.round(blur))}`);
  if (LOOKS[c.look].ff) f.push(LOOKS[c.look].ff);
  return f;
}

export async function buildExportArgs(
  src: Project,
  preset: ExportPreset,
  encoder: string,
  outPath: string,
  workDir: string,
  temps: string[],
): Promise<{ args: string[]; duration: number }> {
  const W = preset.width, H = preset.height, fps = preset.fps;
  // the project is authored at its own size; scale positions into the export size
  const p = src;
  const total = projectDuration(p);
  if (total <= 0) throw new Error("The timeline is empty");
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  const inputs: string[] = [];
  const vf: string[] = [];
  const af: string[] = [];
  const audioLabels: string[] = [];
  let n = 0;

  const addAudio = (c: Clip, idx: number) => {
    const delay = Math.round(c.start * 1000);
    const dur = clipDuration(c);
    const chain = [
      "asetpts=PTS-STARTPTS",
      ...atempo(c.speed),
      `volume=${n3(c.volume)}`,
      ...(c.fadeIn > 0 ? [`afade=t=in:st=0:d=${n3(c.fadeIn)}`] : []),
      ...(c.fadeOut > 0 ? [`afade=t=out:st=${n3(Math.max(0, dur - c.fadeOut))}:d=${n3(c.fadeOut)}`] : []),
      "aformat=sample_rates=48000:channel_layouts=stereo",
      `adelay=${delay}:all=1`,
    ];
    af.push(`[${idx}:a]${chain.join(",")}[a${idx}]`);
    audioLabels.push(`[a${idx}]`);
  };
  const addInput = (c: Clip, a: Asset) => {
    if (a.kind === "image") inputs.push("-loop", "1", "-framerate", String(fps), "-t", n3(clipDuration(c)), "-i", a.path);
    else inputs.push("-ss", n3(c.in), "-t", n3(c.out - c.in), "-i", a.path);
    return n++;
  };
  const audible = (c: Clip, a: Asset, muted: boolean) => a.hasAudio && a.kind !== "image" && !muted && c.volume > 0;

  const order = [...p.tracks].reverse();
  const handled = new Set<string>();

  // Fast path: the bottom video track is usually a plain sequence of full-frame
  // clips. Concatenating it (black for gaps) is far cheaper than overlaying every
  // clip on a black canvas; only true overlays pay for alpha compositing.
  const baseTrack = order.find((t) => t.kind === "video" && !t.hidden);
  const baseClips = baseTrack
    ? p.clips.filter((c) => c.trackId === baseTrack.id && c.kind === "media" && assets.get(c.assetId!)?.kind !== "audio").sort((a, b) => a.start - b.start)
    : [];
  const simple = (c: Clip) => c.scale === 1 && !c.rotation && c.opacity === 1 && Math.abs(c.x - 0.5) < 1e-3 && Math.abs(c.y - 0.5) < 1e-3;
  const noOverlap = baseClips.every((c, i) => i === 0 || c.start >= clipEnd(baseClips[i - 1]) - 1e-3);
  let last: string;
  if (baseClips.length && baseClips.every(simple) && noOverlap) {
    const segs: string[] = [];
    let cursor = 0;
    const gap = (d: number) => {
      const label = `g${segs.length}`;
      vf.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${n3(d)},format=yuv420p,setsar=1[${label}]`);
      segs.push(`[${label}]`);
    };
    for (const c of baseClips) {
      const a = assets.get(c.assetId!)!;
      if (c.start > cursor + 1e-3) gap(c.start - cursor);
      const idx = addInput(c, a);
      const dur = clipDuration(c);
      const chain = [
        a.kind === "image" ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${n3(c.speed)}`,
        `fps=${fps}`,
        `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "setsar=1",
        ...colorChain(c),
        ...(c.fadeIn > 0 ? [`fade=t=in:st=0:d=${n3(c.fadeIn)}`] : []),
        ...(c.fadeOut > 0 ? [`fade=t=out:st=${n3(Math.max(0, dur - c.fadeOut))}:d=${n3(c.fadeOut)}`] : []),
        "format=yuv420p",
        `trim=duration=${n3(dur)}`,
        // a short source is held on its last frame rather than shortening the cut
        `tpad=stop_mode=clone:stop_duration=${n3(dur)}`,
        `trim=duration=${n3(dur)}`,
      ];
      vf.push(`[${idx}:v]${chain.join(",")}[s${idx}]`);
      segs.push(`[s${idx}]`);
      if (audible(c, a, baseTrack!.muted)) addAudio(c, idx);
      handled.add(c.id);
      cursor = clipEnd(c);
    }
    if (total > cursor + 1e-3) gap(total - cursor);
    vf.push(`${segs.join("")}concat=n=${segs.length}:v=1:a=0[base]`);
    last = "base";
  } else {
    vf.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${n3(total)}[base]`);
    last = "base";
  }

  for (const track of order) {
    const clips = p.clips.filter((c) => c.trackId === track.id && !handled.has(c.id)).sort((a, b) => a.start - b.start);
    for (const c of clips) {
      const dur = clipDuration(c);
      const st = n3(c.start), en = n3(clipEnd(c));

      if (c.kind === "text" && c.text) {
        if (track.hidden) continue;
        const png = joinPath(workDir, `.text_${uid()}.png`);
        temps.push(png);
        const canvas = new OffscreenCanvas(W, H);
        drawText(canvas.getContext("2d")!, c, c.text, null, W, H);
        await writeBytes(png, await canvas.convertToBlob({ type: "image/png" }));
        inputs.push("-loop", "1", "-framerate", String(fps), "-t", n3(dur), "-i", png);
        const idx = n++;
        const fade = c.text.anim === "none" ? [] : [`fade=t=in:st=0:d=0.3:alpha=1`, `fade=t=out:st=${n3(Math.max(0, dur - 0.3))}:d=0.3:alpha=1`];
        vf.push(`[${idx}:v]format=yuva420p,${[...fade, `setpts=PTS-STARTPTS+${st}/TB`].join(",")}[t${idx}]`);
        const y = c.text.anim === "slide-up" ? `'60*${H / 1080}*max(0,1-(t-${st})/0.35)'` : "0";
        vf.push(`[${last}][t${idx}]overlay=x=0:y=${y}:eof_action=pass:enable='between(t,${st},${en})'[o${idx}]`);
        last = `o${idx}`;
        continue;
      }

      const a = c.assetId ? assets.get(c.assetId) : undefined;
      if (!a) continue;
      const idx = addInput(c, a);

      const visual = a.kind !== "audio" && track.kind !== "audio" && !track.hidden;
      if (visual) {
        const fit = Math.min(W / (a.width || W), H / (a.height || H)) * c.scale;
        const w = even((a.width || W) * fit), h = even((a.height || H) * fit);
        const needsAlpha = !!c.rotation || c.opacity < 1 || c.fadeIn > 0 || c.fadeOut > 0;
        const chain = [
          a.kind === "image" ? "setpts=PTS-STARTPTS" : `setpts=(PTS-STARTPTS)/${n3(c.speed)}`,
          `fps=${fps}`,
          `scale=${w}:${h}`,
          ...colorChain(c),
          ...(needsAlpha ? ["format=yuva420p"] : []),
          ...(c.rotation ? [`rotate=${n3((c.rotation * Math.PI) / 180)}:c=none:ow=rotw(${n3((c.rotation * Math.PI) / 180)}):oh=roth(${n3((c.rotation * Math.PI) / 180)})`] : []),
          ...(c.opacity < 1 ? [`colorchannelmixer=aa=${n3(c.opacity)}`] : []),
          ...(c.fadeIn > 0 ? [`fade=t=in:st=0:d=${n3(c.fadeIn)}:alpha=1`] : []),
          ...(c.fadeOut > 0 ? [`fade=t=out:st=${n3(Math.max(0, dur - c.fadeOut))}:d=${n3(c.fadeOut)}:alpha=1`] : []),
          `setpts=PTS+${st}/TB`,
        ];
        vf.push(`[${idx}:v]${chain.join(",")}[v${idx}]`);
        vf.push(`[${last}][v${idx}]overlay=x=${n3(c.x * W)}-w/2:y=${n3(c.y * H)}-h/2:eof_action=pass:enable='between(t,${st},${en})'[o${idx}]`);
        last = `o${idx}`;
      }
      if (audible(c, a, track.muted)) addAudio(c, idx);
    }
  }

  vf.push(`[${last}]format=yuv420p[vout]`);
  if (audioLabels.length) {
    af.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,apad,atrim=0:${n3(total)},alimiter=limit=0.97[aout]`);
  } else {
    af.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n3(total)}[aout]`);
  }

  const graph = [...vf, ...af].join(";");
  let graphArgs = ["-filter_complex", graph];
  if (graph.length > 6000) {
    // stay under the Windows command-line limit with large timelines
    const scriptPath = joinPath(workDir, `.text_graph_${uid()}.txt`);
    temps.push(scriptPath);
    await writeBytes(scriptPath, new TextEncoder().encode(graph));
    graphArgs = ["-/filter_complex", scriptPath];
  }

  return {
    duration: total,
    args: [
      ...inputs,
      ...graphArgs,
      "-map", "[vout]",
      "-map", "[aout]",
      ...encoderArgs(encoder, preset.kbps, fps, "export"),
      ...audioArgs,
      "-r", String(fps),
      "-t", n3(total),
      "-movflags", "+faststart",
      outPath,
    ],
  };
}

/** Parses `silencedetect` output into source-time ranges. */
export function parseSilences(log: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s: number | null = null;
  for (const line of log.split("\n")) {
    const a = line.match(/silence_start: (-?[\d.]+)/);
    if (a) s = Math.max(0, parseFloat(a[1]));
    const b = line.match(/silence_end: ([\d.]+)/);
    if (b && s != null) {
      out.push({ start: s, end: parseFloat(b[1]) });
      s = null;
    }
  }
  return out;
}
