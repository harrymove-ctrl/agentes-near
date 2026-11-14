#!/usr/bin/env bun
/**
 * Records real headless Chromium browser walkthroughs (1440x900) and 2x Retina
 * plates (2880x1800) against a clean temporary PGlite + Bun server instance,
 * captures live `bun run check:near` verification output, and writes
 * `tour-manifest.json` with exact normalized click coordinates and timestamps.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT_DIR =
  process.env.AVM_PROJECT_DIR || resolve(ROOT, "video/avm");
const OUT_DIR = join(PROJECT_DIR, "assets");
const PORT = Number(process.env.AG_TOUR_PORT || 4788);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1440, height: 900 };

let chromium;
try {
  ({ chromium } = require(join(PROJECT_DIR, "node_modules/playwright")));
} catch {
  ({ chromium } = require("playwright"));
}

function ffprobeDuration(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return 0;
  return Number.parseFloat(r.stdout.trim()) || 0;
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  let lastErr = "no response";
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await fetch(`${url}/api/health`);
      const n = await fetch(`${url}/api/near/status`);
      if (h.ok && n.ok) return;
      lastErr = `health=${h.status} near=${n.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for server at ${url}: ${lastErr}`);
}

function sanitizeOcelliMedia(page) {
  return page.evaluate(() => {
    const video = document.querySelector(".oc-live-ws__video");
    if (video && video.parentElement) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.removeAttribute("poster");
        video.load();
      } catch {
        // ignore media teardown quirks
      }
      const frame = document.createElement("div");
      frame.style.cssText =
        "width:100%;aspect-ratio:16/9;border-radius:10px;background:radial-gradient(circle at 25% 25%,rgba(0,236,151,0.18),rgba(9,17,29,0.96) 65%),#09111d;border:1px solid rgba(0,236,151,0.28);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:18px;box-sizing:border-box;color:#f3f5f9;font-family:monospace;";
      frame.innerHTML =
        '<div style="font-size:11px;letter-spacing:0.16em;color:#00ec97;text-transform:uppercase;">AI VIDEO MAKER · MASTER STUDIO FEED</div>' +
        '<div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">Agentes NEAR · Step-by-Step Product Tour</div>' +
        '<div style="font-size:12px;color:#94a3b8;">1Click Multi-Solver · OutLayer TDX · Corpus x402</div>';
      video.replaceWith(frame);
    }
  });
}

async function run() {
  mkdirSync(OUT_DIR, { recursive: true });
  const workTmp = mkdtempSync(join(tmpdir(), "agentes-tour-"));
  const pgliteDir = join(workTmp, "pglite");
  const filesDir = join(workTmp, "files");
  const rawVideoDir = join(workTmp, "raw-video");
  mkdirSync(pgliteDir, { recursive: true });
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(rawVideoDir, { recursive: true });

  console.log("[0/7] Running bun run check:near to capture live 8/8 PASS telemetry...");
  const checkProc = spawnSync("bun", ["run", "check:near"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const checkNearStdout = (checkProc.stdout || "").trim();
  if (checkProc.status !== 0 || !checkNearStdout.includes("NEAR CHECK: PASS (8/8)")) {
    throw new Error(
      `bun run check:near failed (code=${checkProc.status}):\n${checkNearStdout}\n${checkProc.stderr || ""}`,
    );
  }
  const checkNearLines = checkNearStdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  console.log(`  captured ${checkNearLines.length} lines from check:near (8/8 PASS)`);

  console.log(`[0/7] Launching temporary PGlite + Bun server at ${BASE_URL}...`);
  const serverLog = [];
  const server = spawn("bun", [join(ROOT, "apps/server/src/main.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      PUBLIC_URL: BASE_URL,
      DATABASE_URL: `pglite://${pgliteDir}`,
      FILES_DIR: filesDir,
      WEB_DIR: join(ROOT, "apps/web/dist"),
      ZEN_DEMO_MODE: "true",
      EMBEDDINGS_PROVIDER: "none",
      TELEMETRY: "off",
      PUSH_SENDER: "off",
      WEB_PUSH: "off",
      AGENTES_SECRET: "agentes-near-hackathon-2026-demo-secret-32chars",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => serverLog.push(d.toString()));
  server.stderr.on("data", (d) => serverLog.push(d.toString()));

  let browser;
  const manifest = {
    generatedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    retinaScale: 2,
    clips: {},
    plates: [],
    checkNearLines,
  };

  try {
    await waitForServer(BASE_URL, 60000);
    console.log("  temporary server online (health + /api/near/status 200)");

    browser = await chromium.launch({ headless: true });
    let authState;

    async function recordClip(key, outMp4Name, opts, fn) {
      const clipRawDir = mkdtempSync(join(rawVideoDir, `${key}-`));
      const ctxOpts = {
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        colorScheme: "dark",
        recordVideo: { dir: clipRawDir, size: VIEWPORT },
      };
      if (opts.storageState) ctxOpts.storageState = opts.storageState;

      const context = await browser.newContext(ctxOpts);
      const contextStartMs = Date.now();
      const page = await context.newPage();
      await page.route("**/*.mp4*", (route) => route.abort());

      let readyMs = contextStartMs;
      const meta = {
        clip: `assets/${outMp4Name}`,
        clicks: [],
        events: [],
        plates: [],
      };

      const markEvent = (name) => {
        const at = relSec();
        meta.events.push({ name, at });
        return at;
      };

      const markReady = async () => {
        await page.evaluate(() => document.fonts?.ready);
        await page.waitForTimeout(250);
        readyMs = Date.now();
      };

      const relSec = () => Number(Math.max(0, (Date.now() - readyMs) / 1000).toFixed(3));

      const measureAndClick = async (name, locator, extra = {}) => {
        await locator.waitFor({ state: "visible", timeout: 20000 });
        await locator.scrollIntoViewIfNeeded();
        await page.waitForTimeout(160);
        const box = await locator.boundingBox();
        if (!box) throw new Error(`${key}: missing bounding box for ${name}`);
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const normX = Number((cx / VIEWPORT.width).toFixed(4));
        const normY = Number((cy / VIEWPORT.height).toFixed(4));
        await page.mouse.move(cx, cy, { steps: 10 });
        await page.waitForTimeout(120);
        const at = relSec();
        meta.clicks.push({ name, at, box: [normX, normY] });
        if (extra.click !== false) {
          await locator.click();
        }
        return { at, box: [normX, normY] };
      };

      const savePlate = async (plateName) => {
        const outPath = join(OUT_DIR, plateName);
        await page.waitForTimeout(180);
        await page.screenshot({ path: outPath });
        const rel = `assets/${plateName}`;
        meta.plates.push(rel);
        manifest.plates.push(rel);
        console.log(`    plate ${rel}`);
      };

      const extraOut = await fn({
        page,
        context,
        markReady,
        markEvent,
        relSec,
        measureAndClick,
        savePlate,
      });

      const video = page.video();
      await page.close();
      await context.close();

      const rawWebm = await video.path();
      if (!rawWebm || !existsSync(rawWebm)) {
        throw new Error(`${key}: recorded webm missing`);
      }

      const trimStartSec = Math.max(0, (readyMs - contextStartMs - 120) / 1000);
      const outMp4 = join(OUT_DIR, outMp4Name);
      const ff = spawnSync(
        "ffmpeg",
        [
          "-loglevel",
          "error",
          "-y",
          "-ss",
          trimStartSec.toFixed(3),
          "-i",
          rawWebm,
          "-vf",
          "fps=30,scale=1440:900:flags=lanczos",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-crf",
          "15",
          "-an",
          outMp4,
        ],
        { encoding: "utf8" },
      );
      if (ff.status !== 0) {
        throw new Error(`${key}: ffmpeg failed: ${ff.stderr}`);
      }
      const dur = ffprobeDuration(outMp4);
      meta.duration = Number(dur.toFixed(3));
      manifest.clips[key] = meta;
      console.log(`  [${key}] saved assets/${outMp4Name} (${dur.toFixed(2)}s, ${meta.clicks.length} clicks)`);
      return extraOut;
    }

    // 1. /ocelli hero -> 1-Click Enter Live Slack Workspace
    authState = await recordClip("step01", "tour-01-ocelli-login.mp4", {}, async ({
      page,
      context,
      markReady,
      measureAndClick,
      savePlate,
    }) => {
      await page.goto(`${BASE_URL}/ocelli`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="ocelli-hero-enter"]', { timeout: 30000 });
      await sanitizeOcelliMedia(page);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await markReady();
      await page.waitForTimeout(1000);
      await savePlate("ret-01-ocelli-hero.png");

      await measureAndClick("ocelliHeroEnter", page.locator('[data-testid="ocelli-hero-enter"]'));
      await page.waitForSelector('[data-testid="near-control-trigger"]', { timeout: 30000 });
      const arena = page.locator("text=near-intents-arena").first();
      await arena.waitFor({ state: "visible", timeout: 20000 });
      await page.waitForTimeout(400);
      await measureAndClick("arenaChannel", arena);
      await page.waitForSelector('textarea[id^="composer-"], .ac-composer textarea', {
        timeout: 20000,
      });
      await page.waitForTimeout(1500);
      await savePlate("ret-01-ocelli-enter.png");
      return context.storageState();
    });

    // 2. #near-intents-arena live @kronos mention + streamed NEAR 1Click/TDX reply
    await recordClip("step02", "tour-02-slack-kronos.mp4", { storageState: authState }, async ({
      page,
      markReady,
      markEvent,
      measureAndClick,
      savePlate,
    }) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="near-control-trigger"]', { timeout: 30000 });
      await page.locator("text=near-intents-arena").first().click();
      const boxLoc = page.locator('textarea[id^="composer-"], .ac-composer textarea').first();
      await boxLoc.waitFor({ state: "visible", timeout: 20000 });
      await markReady();
      await page.waitForTimeout(600);

      await measureAndClick("composer", boxLoc);
      await page.keyboard.type("@kronos quote $12 USDC -> wNEAR under OutLayer TDX", {
        delay: 22,
      });
      await page.waitForTimeout(250);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      const sendBtn = page.locator(".ac-composer__send").first();
      await measureAndClick("sendBtn", sendBtn);

      await page.locator("text=3.5739 wNEAR").last().waitFor({ state: "visible", timeout: 25000 });
      await page.waitForTimeout(600);
      await page.locator("text=ML-DSA-65").last().waitFor({ state: "visible", timeout: 15000 });
      await page.locator("text=3.5739 wNEAR").last().scrollIntoViewIfNeeded();
      markEvent("kronosReplied");
      await page.waitForTimeout(1800);
      await savePlate("ret-02-kronos-reply.png");
    });

    // 3. Open NEAR Intents & TEE modal + run 1Click multi-solver quote
    await recordClip("step03", "tour-03-1click-quotes.mp4", { storageState: authState }, async ({
      page,
      markReady,
      measureAndClick,
      savePlate,
    }) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="near-control-trigger"]', { timeout: 30000 });
      await page.locator("text=near-intents-arena").first().click();
      await page.waitForTimeout(450);
      await markReady();
      await page.waitForTimeout(550);

      await measureAndClick("openModal", page.locator('[data-testid="near-control-trigger"]'));
      await page.waitForSelector('[data-testid="near-control-modal"]', { timeout: 15000 });
      await page.waitForTimeout(450);

      const quoteBtn = page.locator('[data-testid="near-fetch-quote-btn"]');
      await measureAndClick("fetchQuote", quoteBtn);
      await page.waitForSelector('[data-testid="near-quote-table"]', { timeout: 15000 });
      await page.locator('[data-testid="near-quote-table"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(2100);
      await savePlate("ret-03-1click-table.png");
    });

    // 4. OutLayer Intel TDX Guard: $12 APPROVED -> $45 BLOCKED_PER_TX_CAP
    await recordClip("step04", "tour-04-outlayer-guard.mp4", { storageState: authState }, async ({
      page,
      markReady,
      measureAndClick,
      savePlate,
    }) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="near-control-trigger"]', { timeout: 30000 });
      await page.locator('[data-testid="near-control-trigger"]').click();
      await page.waitForSelector('[data-testid="near-approve-safe-btn"]', { timeout: 15000 });
      await markReady();
      await page.waitForTimeout(550);

      await measureAndClick("approveSafe12", page.locator('[data-testid="near-approve-safe-btn"]'));
      await page.waitForSelector('[data-testid="near-enclave-result"][data-allowed="true"]', {
        timeout: 15000,
      });
      await page.locator('[data-testid="near-enclave-result"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(1900);
      await savePlate("ret-04a-safe-pass.png");

      await measureAndClick("blockRogue45", page.locator('[data-testid="near-test-rogue-btn"]'));
      await page.waitForSelector('[data-testid="near-enclave-result"][data-allowed="false"]', {
        timeout: 15000,
      });
      await page.locator('[data-testid="near-enclave-result"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(2200);
      await savePlate("ret-04b-rogue-block.png");
    });

    // 5. Terrace Markets 10 wNEAR BACK conviction bet + burn-on-miss receipt
    await recordClip("step05", "tour-05-terrace-markets.mp4", { storageState: authState }, async ({
      page,
      markReady,
      measureAndClick,
      savePlate,
    }) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="near-control-trigger"]', { timeout: 30000 });
      await page.locator('[data-testid="near-control-trigger"]').click();
      await page.waitForSelector('[data-testid="near-control-modal"]', { timeout: 15000 });
      await page.getByRole("tab", { name: /Terrace Markets/i }).click();
      await page.waitForSelector('[data-testid="near-bet-back-mkt-1click-route"]', { timeout: 15000 });
      await markReady();
      await page.waitForTimeout(550);

      await measureAndClick("stake10Wnear", page.locator('button.near-pill-btn:has-text("10 wNEAR")'));
      await page.waitForTimeout(400);
      await measureAndClick(
        "backRouteMarket",
        page.locator('[data-testid="near-bet-back-mkt-1click-route"]'),
      );
      await page.waitForSelector('[data-testid="near-bet-receipt"]', { timeout: 15000 });
      await page.locator('[data-testid="near-bet-receipt"]').scrollIntoViewIfNeeded();
      await page.waitForTimeout(2000);
      await savePlate("ret-05-terrace-bet.png");
    });

    // 6. Corpus Endowment (+4h H100 TEE) + Kanmani Escrow (Hire + Release Level Up NEP-171)
    await recordClip("step06", "tour-06-corpus-kanmani.mp4", { storageState: authState }, async ({
      page,
      markReady,
      measureAndClick,
      savePlate,
    }) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="near-control-trigger"]', { timeout: 30000 });
      await page.locator('[data-testid="near-control-trigger"]').click();
      await page.waitForSelector('[data-testid="near-control-modal"]', { timeout: 15000 });
      await page.getByRole("tab", { name: /Corpus Endowment/i }).click();
      await page.waitForSelector('[data-testid="near-fund-4h-btn"]', { timeout: 15000 });
      await markReady();
      await page.waitForTimeout(550);

      await measureAndClick("fund4hTee", page.locator('[data-testid="near-fund-4h-btn"]'));
      await page.waitForTimeout(1600);
      await savePlate("ret-06a-corpus-endow.png");

      const hireBtn = page.locator('[data-testid="near-escrow-hire-btn"]');
      const releaseBtn = page.locator('[data-testid="near-escrow-release-btn"]');
      await page.locator(".near-cred-grid").scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      await measureAndClick("escrowHire", hireBtn);
      await page.waitForTimeout(750);
      await measureAndClick("escrowReleaseNft", releaseBtn);
      await page.waitForSelector('[data-testid="near-escrow-result"]', { timeout: 15000 });
      await page.locator(".near-cred-grid").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1900);
      await savePlate("ret-06b-escrow-nft.png");
    });

    // 7. /ocelli#motion-studio @mira 60fps Canvas Direct
    await recordClip("step07", "tour-07-motion-studio.mp4", {}, async ({
      page,
      markReady,
      measureAndClick,
      savePlate,
    }) => {
      await page.goto(`${BASE_URL}/ocelli`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForSelector('[data-testid="agent-motion-studio"]', { timeout: 30000 });
      await sanitizeOcelliMedia(page);
      await page.addStyleTag({ content: ".oc-nav-wrap { position: static !important; }" });
      await page.evaluate(() => {
        const studio = document.querySelector('[data-testid="agent-motion-studio"]');
        if (studio) {
          const top = studio.getBoundingClientRect().top + window.scrollY - 14;
          window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
        }
      });
      await markReady();
      await page.waitForTimeout(500);

      await measureAndClick("canvasMode", page.locator('[data-testid="ams-mode-canvas"]'));
      await page.waitForTimeout(300);
      await measureAndClick("miraDirect", page.locator('[data-testid="ams-mira-submit"]'));
      await page.waitForTimeout(900);
      const ch03 = page.locator('[data-testid="ams-chapter-03"]');
      if (await ch03.count()) {
        await measureAndClick("chapter03", ch03.first());
      }
      await page.waitForTimeout(2400);
      await savePlate("ret-07-motion-studio.png");
    });

    const manifestPath = join(OUT_DIR, "tour-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${manifestPath}`);
  } catch (err) {
    console.error("Server logs tail:\n" + serverLog.slice(-20).join(""));
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try {
      server.kill("SIGTERM");
    } catch {
      // ignore
    }
    rmSync(workTmp, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
