#!/usr/bin/env bun
/**
 * Capture 6 crisp 2x Retina (2880x1800) Playwright screenshots of Agentes NEAR
 * into AVM_PROJECT_DIR/assets (or video/avm/assets by default).
 *
 * Sanitizes any pre-existing hero <video> playback before capturing shot-01-ocelli-hero.png.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PROJECT_DIR = process.env.AVM_PROJECT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../avm");
let chromium;
try {
  ({ chromium } = require(join(PROJECT_DIR, "node_modules/playwright")));
} catch {
  ({ chromium } = require("playwright"));
}

const BASE_URL = process.env.AG_CAPTURE_URL || "https://agentes-near-production.up.railway.app";
const OUT_DIR = join(PROJECT_DIR, "assets");
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORT = { width: 1440, height: 900 };

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  // Abort .mp4 requests immediately so streaming video never blocks page load or leaks old frames
  await page.route("**/*.mp4*", (route) => route.abort());

  console.log(`[1/6] Capturing /ocelli hero from ${BASE_URL}/ocelli ...`);
  await page.goto(`${BASE_URL}/ocelli`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('[data-testid="ocelli-hero-enter"]', { timeout: 30000 });
  await page.waitForTimeout(1100);

  // Sanitize hero <video> before capturing shot-01 so old MP4 frames never leak
  await page.evaluate(() => {
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
        '<div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">Agentes NEAR · 90s 60FPS Showreel</div>' +
        '<div style="font-size:12px;color:#8c95a8;">1Click Multi-Solver · OutLayer TDX · Corpus x402</div>';
      video.replaceWith(frame);
    }
  });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(OUT_DIR, "shot-01-ocelli-hero.png") });
  console.log("  saved shot-01-ocelli-hero.png (2880x1800)");

  console.log("[2/6] Capturing Terrace + Hunch Arena pane...");
  await page.locator('[data-testid="tab-arena"]').click();
  await page.locator("#demo-window").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -24));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT_DIR, "shot-02-ocelli-arcade.png") });
  console.log("  saved shot-02-ocelli-arcade.png (2880x1800)");

  console.log("[3/6] Capturing 1Click Solver + Kyvera PQ pane...");
  await page.locator('[data-testid="tab-solver"]').click();
  await page.locator('[data-testid="btn-exec-swap"]').click().catch(() => {});
  await page.locator("#demo-window").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -24));
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT_DIR, "shot-06-1click-swap.png") });
  console.log("  saved shot-06-1click-swap.png (2880x1800)");

  console.log("[4/6] Capturing Agent Motion Studio interactive canvas...");
  await page.evaluate(() => {
    const studio = document.querySelector('[data-testid="agent-motion-studio"]');
    if (studio) {
      const top = studio.getBoundingClientRect().top + window.scrollY - 88;
      window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    }
  });
  await page.locator('[data-testid="ams-mode-canvas"]').click().catch(() => {});
  await page.locator('[data-testid="ams-chapter-06"]').click().catch(() => {});
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT_DIR, "shot-03-motion-studio.png") });
  console.log("  saved shot-03-motion-studio.png (2880x1800)");

  console.log("[5/6] Entering live 3-column Slack workspace...");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(250);
  await page.locator('[data-testid="ocelli-hero-enter"]').click();
  await page.waitForSelector('[data-testid="near-control-trigger"]', { timeout: 30000 });
  const channelLink = page.locator("text=near-intents-arena").first();
  await channelLink.waitFor({ state: "visible", timeout: 20000 });
  await channelLink.click();
  await page.waitForSelector("text=1Click", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1100);
  await page.screenshot({ path: join(OUT_DIR, "shot-04-slack-channel.png") });
  console.log("  saved shot-04-slack-channel.png (2880x1800)");

  console.log("[6/6] Capturing OutLayer Intel TDX Guard modal ($45 cap enforcement)...");
  await page.locator('[data-testid="near-control-trigger"]').click();
  await page.waitForSelector('[data-testid="near-control-modal"]', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.locator('[data-testid="near-test-rogue-btn"]').click().catch(() => {});
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT_DIR, "shot-05-outlayer-guard.png") });
  console.log("  saved shot-05-outlayer-guard.png (2880x1800)");

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
