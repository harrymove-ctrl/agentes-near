import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The desktop app's web view (ADR 0036). `bun run dev` serves it in a normal browser against the fake
// runner (src/dev/fake-runner.ts); inside Tauri the same bundle talks to the real runners through the
// Rust shell. `tauri build` runs `vite build` and loads `dist/` from the app bundle (never a remote page).
export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port in development and relative asset paths in the bundle.
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  base: "./",
  build: {
    outDir: "dist",
    target: "safari15",
    sourcemap: false,
    // The windows' app (index.html) and the main window's cover (cover.html, cover.rs), on its own: small,
    // and it opens without the rest.
    rollupOptions: { input: { main: "index.html", cover: "cover.html" } },
  },
});
