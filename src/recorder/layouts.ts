// Camera layout geometry, shared by the live preview, the web (canvas) compositor and
// the native FFmpeg filter-graph builder so what you see is exactly what gets recorded.

export type CamShape = "circle" | "rounded" | "square" | "hexagon" | "heart";
export type CamMode =
  | "pip" // facecam bubble over gameplay
  | "split-left" // camera left half, game right half
  | "split-right"
  | "split-top" // vertical: camera top, game bottom (great for Shorts)
  | "side-by-side" // game 2/3 + camera 1/3 column
  | "screen-only"
  | "camera-only";
export type Corner = "tl" | "tr" | "bl" | "br";
export type CamFilter = "none" | "vivid" | "warm" | "cool" | "noir" | "retro" | "neon";

export interface CameraLayout {
  mode: CamMode;
  shape: CamShape;
  corner: Corner;
  size: number; // bubble size as a fraction of output height (pip)
  margin: number; // fraction of output height
  border: number; // px at 1080p
  borderColor: string;
  borderGlow: boolean; // voice-reactive glow ring
  mirror: boolean;
  zoom: number; // 1 = fit, >1 crops into the face
  filter: CamFilter;
  /** Optional custom position (fraction of output) set by dragging the bubble. */
  customX?: number;
  customY?: number;
}

export const DEFAULT_LAYOUT: CameraLayout = {
  mode: "pip",
  shape: "circle",
  corner: "br",
  size: 0.28,
  margin: 0.03,
  border: 6,
  borderColor: "#ff2d6f",
  borderGlow: true,
  mirror: true,
  zoom: 1.15,
  filter: "none",
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutRects {
  screen: Rect | null;
  camera: Rect | null;
  /** Whether the screen is drawn "cover" (cropped to fill) instead of letterboxed. */
  screenCover: boolean;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const er = (r: Rect): Rect => ({ x: even(r.x), y: even(r.y), w: even(r.w), h: even(r.h) });

export function computeLayout(l: CameraLayout, W: number, H: number): LayoutRects {
  const full: Rect = { x: 0, y: 0, w: W, h: H };
  switch (l.mode) {
    case "screen-only":
      return { screen: full, camera: null, screenCover: false };
    case "camera-only":
      return { screen: null, camera: full, screenCover: false };
    case "split-left":
      return { camera: er({ x: 0, y: 0, w: W / 2, h: H }), screen: er({ x: W / 2, y: 0, w: W / 2, h: H }), screenCover: true };
    case "split-right":
      return { screen: er({ x: 0, y: 0, w: W / 2, h: H }), camera: er({ x: W / 2, y: 0, w: W / 2, h: H }), screenCover: true };
    case "split-top": {
      const camH = H >= W ? H * 0.38 : H / 2;
      return { camera: er({ x: 0, y: 0, w: W, h: camH }), screen: er({ x: 0, y: camH, w: W, h: H - camH }), screenCover: true };
    }
    case "side-by-side": {
      const gw = (W * 2) / 3;
      return { screen: er({ x: 0, y: 0, w: gw, h: H }), camera: er({ x: gw, y: 0, w: W - gw, h: H }), screenCover: true };
    }
    case "pip":
    default: {
      const size = Math.min(W, H) * l.size;
      const w = l.shape === "rounded" ? size * (16 / 11) : size;
      const h = size;
      const m = Math.min(W, H) * l.margin;
      let x: number, y: number;
      if (l.customX != null && l.customY != null) {
        x = l.customX * W - w / 2;
        y = l.customY * H - h / 2;
      } else {
        x = l.corner.endsWith("l") ? m : W - w - m;
        y = l.corner.startsWith("t") ? m : H - h - m;
      }
      x = Math.min(Math.max(0, x), W - w);
      y = Math.min(Math.max(0, y), H - h);
      return { screen: full, camera: er({ x, y, w, h }), screenCover: H > W };
    }
  }
}

/** Whether the camera is a shaped bubble (masked) or fills a split panel. */
export const isBubble = (l: CameraLayout) => l.mode === "pip";

/** Traces the bubble outline into ctx (caller fills/clips/strokes). */
export function shapePath(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, shape: CamShape, r: Rect) {
  const { x, y, w, h } = r;
  ctx.beginPath();
  switch (shape) {
    case "circle":
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "rounded":
      ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.18);
      break;
    case "square":
      ctx.rect(x, y, w, h);
      break;
    case "hexagon": {
      const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        const px = cx + rx * Math.cos(a), py = cy + ry * Math.sin(a);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case "heart": {
      const cx = x + w / 2;
      ctx.moveTo(cx, y + h * 0.95);
      ctx.bezierCurveTo(x - w * 0.15, y + h * 0.55, x + w * 0.1, y - h * 0.05, cx, y + h * 0.25);
      ctx.bezierCurveTo(x + w * 0.9, y - h * 0.05, x + w * 1.15, y + h * 0.55, cx, y + h * 0.95);
      ctx.closePath();
      break;
    }
  }
}

/** CSS/canvas filter strings for camera looks (canvas `ctx.filter`). */
export const CAM_FILTERS: Record<CamFilter, string> = {
  none: "none",
  vivid: "saturate(1.45) contrast(1.1)",
  warm: "sepia(0.25) saturate(1.2) hue-rotate(-8deg)",
  cool: "saturate(1.1) hue-rotate(12deg) brightness(1.03)",
  noir: "grayscale(1) contrast(1.25)",
  retro: "sepia(0.55) contrast(1.15) saturate(1.3)",
  neon: "saturate(1.9) contrast(1.2) hue-rotate(-15deg)",
};

/** FFmpeg equivalents for the native engine. */
export const CAM_FILTERS_FFMPEG: Record<CamFilter, string> = {
  none: "",
  vivid: "eq=saturation=1.45:contrast=1.1",
  warm: "eq=saturation=1.2:gamma_r=1.07:gamma_b=0.92",
  cool: "eq=saturation=1.1:brightness=0.02:gamma_r=0.94:gamma_b=1.08",
  noir: "hue=s=0,eq=contrast=1.25",
  retro: "eq=contrast=1.1:saturation=0.55:gamma_r=1.1:gamma_b=0.85",
  neon: "eq=saturation=1.9:contrast=1.2,hue=h=-15",
};

/**
 * Draws the camera frame into `r` with object-fit: cover + zoom + mirror, clipped to
 * the bubble shape when in pip mode. Shared by preview and web recorder.
 */
export function drawCamera(
  ctx: CanvasRenderingContext2D,
  cam: CanvasImageSource & { videoWidth?: number; videoHeight?: number },
  l: CameraLayout,
  r: Rect,
  level = 0,
) {
  const vw = cam.videoWidth || 1280;
  const vh = cam.videoHeight || 720;
  const scale = Math.max(r.w / vw, r.h / vh) * l.zoom;
  const dw = vw * scale, dh = vh * scale;
  const dx = r.x + (r.w - dw) / 2, dy = r.y + (r.h - dh) / 2;
  const bubble = isBubble(l);
  ctx.save();
  if (bubble) {
    shapePath(ctx, l.shape, r);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
  }
  ctx.filter = CAM_FILTERS[l.filter];
  if (l.mirror) {
    ctx.translate(dx * 2 + dw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(cam, dx, dy, dw, dh);
  ctx.restore();
  if (bubble) drawBorder(ctx, l, r, level);
}

export function drawBorder(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  l: CameraLayout,
  r: Rect,
  level = 0,
) {
  const unit = Math.max(r.w, r.h) / 300;
  if (l.border <= 0 && !l.borderGlow) return;
  ctx.save();
  if (l.borderGlow) {
    ctx.shadowColor = l.borderColor;
    ctx.shadowBlur = (8 + level * 50) * unit;
  }
  shapePath(ctx, l.shape, r);
  ctx.lineWidth = Math.max(1, l.border * unit * (1 + level * 0.8));
  ctx.strokeStyle = l.borderColor;
  ctx.stroke();
  ctx.restore();
}

/** Draws the gameplay frame into r, letterboxed (contain) or cropped (cover). */
export function drawScreen(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource & { videoWidth?: number; videoHeight?: number },
  r: Rect,
  cover: boolean,
) {
  const vw = src.videoWidth || 1920;
  const vh = src.videoHeight || 1080;
  const s = cover ? Math.max(r.w / vw, r.h / vh) : Math.min(r.w / vw, r.h / vh);
  const dw = vw * s, dh = vh * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.drawImage(src, r.x + (r.w - dw) / 2, r.y + (r.h - dh) / 2, dw, dh);
  ctx.restore();
}
