import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, selectComposition } from "@remotion/renderer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "out");
const CHUNK_FRAMES = 720;
const WORKER_COUNT = 2;

function findCachedChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (fs.existsSync(cacheRoot)) {
    const dirs = fs
      .readdirSync(cacheRoot)
      .filter((d) => d.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const candidate = path.join(
        cacheRoot,
        dir,
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const chromeMac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(chromeMac)) return chromeMac;
  return null;
}

function buildFrameChunks(totalFrames, chunkSize) {
  const chunks = [];
  for (let start = 0, idx = 0; start < totalFrames; start += chunkSize, idx += 1) {
    const end = Math.min(totalFrames - 1, start + chunkSize - 1);
    chunks.push({ idx, start, end });
  }
  return chunks;
}

async function renderChunkWithFreshBrowser({
  serveUrl,
  composition,
  browserExecutable,
  chunk,
  chunkFile,
}) {
  const puppeteerInstance = await openBrowser("chrome", {
    browserExecutable,
    chromiumOptions: { gl: "angle" },
  });
  try {
    await renderMedia({
      composition,
      serveUrl,
      puppeteerInstance,
      codec: "h264",
      crf: 17,
      pixelFormat: "yuv420p",
      muted: true,
      frameRange: [chunk.start, chunk.end],
      outputLocation: chunkFile,
      concurrency: 1,
    });
  } finally {
    await puppeteerInstance.close({ silent: true }).catch(() => {});
  }
}

async function renderCompositionChunked({
  serveUrl,
  id,
  outFile,
  audioPath,
  browserExecutable,
}) {
  const startedAt = Date.now();
  const outPath = path.join(OUT_DIR, outFile);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agentes-near-render-${id}-`));

  console.log(`[render] Selecting composition ${id}...`);
  const composition = await selectComposition({
    serveUrl,
    id,
    browserExecutable,
    chromiumOptions: { gl: "angle" },
  });

  const chunks = buildFrameChunks(composition.durationInFrames, CHUNK_FRAMES);
  console.log(
    `[render] Rendering ${id} (${composition.durationInFrames} frames @ ${composition.fps}fps) across ${chunks.length} isolated browser chunks (workers=${WORKER_COUNT})...`
  );

  const chunkFiles = new Array(chunks.length);
  let cursor = 0;

  async function worker(workerId) {
    while (true) {
      const myIndex = cursor;
      cursor += 1;
      if (myIndex >= chunks.length) return;
      const chunk = chunks[myIndex];
      const chunkFile = path.join(
        tmpDir,
        `chunk-${String(chunk.idx).padStart(3, "0")}.mp4`
      );
      const t0 = Date.now();
      console.log(
        `[render] [w${workerId}] ${id} chunk ${chunk.idx + 1}/${chunks.length} frames ${chunk.start}..${chunk.end}`
      );
      await renderChunkWithFreshBrowser({
        serveUrl,
        composition,
        browserExecutable,
        chunk,
        chunkFile,
      });
      chunkFiles[myIndex] = chunkFile;
      console.log(
        `[render] [w${workerId}] ${id} chunk ${chunk.idx + 1}/${chunks.length} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(WORKER_COUNT, chunks.length) }, (_, i) =>
      worker(i + 1)
    )
  );

  const concatListPath = path.join(tmpDir, "concat.txt");
  fs.writeFileSync(
    concatListPath,
    chunkFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    "utf8"
  );

  const expectedSec = (composition.durationInFrames / composition.fps).toFixed(3);
  console.log(`[render] Stitching ${chunks.length} H.264 chunks + ${path.basename(audioPath)} -> ${outFile}...`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-i",
      audioPath,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-t",
      expectedSec,
      "-movflags",
      "+faststart",
      outPath,
    ],
    { stdio: "inherit" }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  const sizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[render] Completed ${outFile} (${sizeMb} MB) in ${totalSec}s`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browserExecutable = findCachedChromium();
  if (!browserExecutable) {
    throw new Error("Chromium binary not found");
  }
  console.log(`[render] Using browser: ${browserExecutable}`);

  console.log("[render] Bundling Remotion project...");
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, "src", "index.ts"),
    publicDir: path.join(ROOT, "public"),
  });

  const targets = [
    {
      id: "AgentesNearDemo",
      file: "agentes-near-demo.mp4",
      audio: path.join(ROOT, "public", "audio", "demo-mix.wav"),
    },
    {
      id: "AgentesNearXTeaser",
      file: "agentes-near-x-teaser.mp4",
      audio: path.join(ROOT, "public", "audio", "teaser-mix.wav"),
    },
  ];

  for (const t of targets) {
    await renderCompositionChunked({
      serveUrl,
      id: t.id,
      outFile: t.file,
      audioPath: t.audio,
      browserExecutable,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
