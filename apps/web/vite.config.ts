import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { preloadLocale } from "./vite-locale-preload";

// In development the web app runs on Vite (port 5173) and proxies /api,
// including the WebSocket at /api/ws, to the server (port 3000). In
// production the server serves the built files itself (WEB_DIR), so one
// process serves the API, the WebSocket and the app.
// React Compiler: components and hooks are memoized at build time (what doesn't follow the rules of
// React is left as written; `"use no memo"` opts a file out).
export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    preloadLocale(),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": { target: "http://localhost:3000", ws: true } } },
  // `screen.html`: the agent's screen for the phone app (ADR 0098), a small page of its own, not the web app.
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        screen: fileURLToPath(new URL("./screen.html", import.meta.url)),
      },
    },
  },
});
