// Mobile capture engine: delegates to the native screenrec plugin (Android
// MediaProjection + floating facecam bubble). The recording keeps running while the
// user plays; it stops from the app or from the "Stop" notification.
import { invoke } from "../lib/platform";
import type { CameraLayout } from "./layouts";

export class MobileRecording {
  markers: { time: number; label: string }[] = [];
  paused = false;
  private t0 = performance.now();

  static async start(o: { height: number; fps: number; kbps: number; layout: CameraLayout; camera: boolean; mic: boolean }) {
    await invoke("plugin:screenrec|start", {
      height: o.height,
      fps: o.fps,
      bitrate: o.kbps * 1000,
      camera: o.camera && o.layout.mode !== "screen-only",
      cameraShape: o.layout.shape,
      cameraSize: o.layout.size,
      mic: o.mic,
    });
    return new MobileRecording();
  }

  get elapsed() {
    return (performance.now() - this.t0) / 1000;
  }

  async pause() {
    throw new Error("Pause isn't available on phones yet. Stop and start a new clip instead.");
  }

  async resume() {}

  addMarker(label?: string) {
    this.markers.push({ time: this.elapsed, label: label || `Moment ${this.markers.length + 1}` });
  }

  async stop() {
    const res = await invoke<{ path: string }>("plugin:screenrec|stop");
    return { path: res.path, duration: this.elapsed, markers: this.markers };
  }
}
