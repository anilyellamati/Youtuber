// Developer self-test (SF_SELFTEST=<video path>): checks which media URL forms the
// platform webview can play and draw, logging results to the app's stderr.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export async function runSelftest(path: string, mediaBase: string | null) {
  const log = (l: string) => invoke("selftest_log", { line: l });
  await log(`origin=${location.origin} ua=${navigator.userAgent}`);
  const variants: [string, string, boolean][] = [];
  if (mediaBase) {
    const u = `${mediaBase}/f?p=${encodeURIComponent(path)}`;
    variants.push(["http", u, false], ["http+cors", u, true]);
  }
  const a = convertFileSrc(path);
  variants.push(["asset", a, false], ["asset+cors", a, true]);
  for (const [name, url, cors] of variants) {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    if (cors) v.crossOrigin = "anonymous";
    const res = await new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve("timeout"), 8000);
      v.onloadeddata = () => { clearTimeout(t); resolve(`loaded ${v.videoWidth}x${v.videoHeight} dur=${v.duration.toFixed(1)}`); };
      v.onerror = () => { clearTimeout(t); resolve(`error code=${v.error?.code} ${v.error?.message ?? ""}`); };
      v.src = url;
    });
    let draw = "-";
    if (res.startsWith("loaded")) {
      try {
        const c = document.createElement("canvas");
        c.width = 64; c.height = 36;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(v, 0, 0, 64, 36);
        const px = ctx.getImageData(32, 18, 1, 1).data;
        draw = `pixels ok rgb=${px[0]},${px[1]},${px[2]}`;
      } catch (e) {
        draw = `tainted: ${(e as Error).message}`;
      }
    }
    await log(`${name}: ${res} | ${draw} | ${url.slice(0, 60)}`);
  }
  if (mediaBase) {
    try {
      const r = await fetch(`${mediaBase}/f?p=${encodeURIComponent(path)}`, { headers: { Range: "bytes=0-9" } });
      await log(`fetch http: ${r.status}`);
    } catch (e) {
      await log(`fetch http failed: ${(e as Error).message}`);
    }
  }
  // the editor's real import path
  const { probeElement, makeThumbs } = await import("./editor/render");
  const { fileUrl } = await import("./lib/platform");
  const url = fileUrl(path);
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    try {
      const r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15000))]);
      await log(`${name}: ok in ${Math.round(performance.now() - t0)}ms ${JSON.stringify(r)?.slice(0, 120)}`);
    } catch (e) {
      await log(`${name}: FAILED ${(e as Error).message}`);
    }
  };
  await step("probeElement", () => probeElement(url, "video"));
  await step("probe_media", () => invoke("probe_media", { path }));
  await step("makeThumbs", async () => (await makeThumbs(url, 20, 4)).map((t) => t.length));
  await log("DONE");
}
