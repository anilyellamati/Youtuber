// Picks the fastest working encoder and its settings. Hardware encoders keep CPU free
// for the game, which is what makes recording viable on low-spec machines.

export const ENCODER_LABELS: Record<string, string> = {
  h264_nvenc: "NVIDIA NVENC (H.264)",
  hevc_nvenc: "NVIDIA NVENC (HEVC)",
  h264_qsv: "Intel Quick Sync (H.264)",
  h264_amf: "AMD AMF (H.264)",
  h264_videotoolbox: "Apple VideoToolbox (H.264)",
  hevc_videotoolbox: "Apple VideoToolbox (HEVC)",
  h264_mf: "Windows Media Foundation (H.264)",
  libx264: "Software x264 (CPU)",
};

const PRIORITY = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox", "h264_mf", "libx264"];

export function bestEncoder(available: string[]): string {
  return PRIORITY.find((e) => available.includes(e)) ?? "libx264";
}

export function encoderArgs(enc: string, kbps: number, fps: number, mode: "record" | "export", lowSpec = false): string[] {
  const b = `${kbps}k`, max = `${Math.round(kbps * 1.5)}k`, buf = `${kbps * 2}k`;
  const gop = String(Math.round(fps * 2)); // 2s keyframes, as YouTube recommends
  const common = ["-g", gop, "-pix_fmt", "yuv420p"];
  switch (enc) {
    case "h264_nvenc":
    case "hevc_nvenc":
      return ["-c:v", enc, "-preset", mode === "record" ? "p3" : "p5", "-tune", "hq", "-rc", "vbr", "-cq", mode === "record" ? "23" : "20", "-b:v", b, "-maxrate", max, "-bufsize", buf, "-bf", "2", ...common];
    case "h264_qsv":
      return ["-c:v", enc, "-preset", mode === "record" ? "veryfast" : "medium", "-global_quality", mode === "record" ? "24" : "21", "-b:v", b, "-maxrate", max, ...common.slice(0, 2), "-pix_fmt", "nv12"];
    case "h264_amf":
      return ["-c:v", enc, "-usage", "transcoding", "-quality", mode === "record" ? "speed" : "balanced", "-rc", "vbr_peak", "-b:v", b, "-maxrate", max, ...common];
    case "h264_videotoolbox":
    case "hevc_videotoolbox":
      return ["-c:v", enc, "-b:v", b, "-maxrate", max, "-bufsize", buf, ...(mode === "record" ? ["-realtime", "1"] : []), "-allow_sw", "1", ...(enc.startsWith("hevc") ? ["-tag:v", "hvc1"] : []), ...common];
    case "h264_mf":
      return ["-c:v", enc, "-b:v", b, "-hw_encoding", "1", "-rate_control", "pc_vbr", ...common];
    default:
      return [
        "-c:v", "libx264",
        "-preset", mode === "record" ? (lowSpec ? "ultrafast" : "veryfast") : lowSpec ? "veryfast" : "faster",
        "-crf", mode === "record" ? "23" : "20",
        "-maxrate", max, "-bufsize", buf,
        ...(mode === "export" ? ["-profile:v", "high"] : []),
        ...common,
      ];
  }
}

export const audioArgs = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"];
