// StreamForge Lite: recorder-only build (screen + camera + audio + filters).
// Entry page is lite.html; the Lite window opens it via tauri.lite.conf.json.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, open: false },
  build: {
    outDir: "dist-lite",
    emptyOutDir: true,
    target: ["es2021", "chrome100"],
    rollupOptions: { input: "lite.html" },
  },
});
