/**
 * Step-by-step Live Product Tour choreography (v6.0.0) for Agentes NEAR.
 * Visual anchor: Obsidian Enclave (#090D16 ground, #0D1320 chrome, #111827 solid
 * 2-line explainer cards, #00EC97 emerald, #38BDF8 cyan, #FF5A5F block coral).
 * Uses real headless Chromium walkthrough MP4 clips paired with settled 2x Retina
 * PNG zoom plates and live `bun run check:near` verification lines.
 * Pure deterministic f(u) evaluation: zero Date, zero Math.random, zero rAF.
 */
import type { Builder, Ctx } from "../../../../libs/film-kit/scenes/kit.ts";
import { el, fin, media, outro, px } from "../../../../libs/film-kit/scenes/kit.ts";
import { clamp, ease, lerp, prog, sfx } from "../../../../libs/film-kit/film/lib.ts";
import {
  pointer,
  pointerAt,
  TRAVEL,
  type Waypoint,
} from "../../../../libs/film-kit/scenes/snapcn/screens-helpers.ts";
import TOUR_MANIFEST from "../../assets/tour-manifest.json" with { type: "json" };

const BG_OBSIDIAN = "#090D16";
const CHROME_BG = "#0D1320";
const CARD_BG = "#111827";
const INK = "#F8FAFC";
const MUTED = "#CBD5E1";
const EMERALD = "#00EC97";
const CYAN = "#38BDF8";
const CORAL_BORDER = "#FF5A5F";
const CORAL_TEXT = "#FDA4AF";
const CLICK_SOUNDS = ["click", "tick", "pop", "blip"] as const;

type Corner = "top-right" | "top-left" | "bottom-right" | "bottom-left";

interface CalloutSpec {
  what: string;
  why: string;
  corner: Corner;
  tone?: "emerald" | "cyan" | "coral";
  startSec: number;
  endSec: number;
}

interface ZoomHold {
  startSec: number;
  endSec: number;
  zoom: number;
  focusX: number;
  focusY: number;
  plate: string;
}

interface ClickSpec {
  name: string;
  at: number;
  box: number[];
}

function clampFocus(v: number, zoom: number): number {
  const lo = 0.5 / zoom;
  return lo >= 1 - lo ? 0.5 : clamp(v, lo, 1 - lo);
}

function addObsidianStageBase(root: HTMLElement, u: number) {
  el(
    root,
    `inset:0;background:radial-gradient(70% 45% at 50% 0%, rgba(0,236,151,0.06) 0%, transparent 68%), ${BG_OBSIDIAN};pointer-events:none;z-index:0`,
  );
  const grid = el(
    root,
    `inset:0;opacity:0.06;background-image:radial-gradient(rgba(148,163,184,0.85) ${px(1.2 * u)}, transparent 0);background-size:${px(28 * u)} ${px(28 * u)};pointer-events:none;z-index:0`,
  );
  grid.dataset.tourGrid = "true";
}

function buildChromeWindow(
  root: HTMLElement,
  c: Ctx,
  stepPill: string,
  urlLabel: string,
  accentHex = EMERALD,
) {
  const u = c.u;
  // Exact 1.6:1 viewport matching 1440x900 native captures with 0 edge clipping.
  const vpW = 1520 * u;
  const vpH = 950 * u;
  const barH = 46 * u;
  const winW = vpW;
  const winH = vpH + barH;
  const winX = (c.w - winW) / 2;
  const winY = (c.h - winH) / 2;

  const shell = el(
    root,
    `left:${px(winX)};top:${px(winY)};width:${px(winW)};height:${px(winH)};border-radius:${px(18 * u)};overflow:hidden;background:${CHROME_BG};border:${px(1.5 * u)} solid rgba(148,163,184,0.22);box-shadow:0 ${px(32 * u)} ${px(90 * u)} rgba(0,0,0,0.72), 0 0 0 ${px(1 * u)} rgba(255,255,255,0.06);z-index:10`,
  );

  const bar = el(
    shell,
    `left:0;right:0;top:0;height:${px(barH)};background:${CHROME_BG};border-bottom:${px(1 * u)} solid rgba(148,163,184,0.16);display:flex;align-items:center;justify-content:space-between;padding:0 ${px(20 * u)};box-sizing:border-box;z-index:30`,
  );
  const dotsWrap = el(
    bar,
    `position:relative;display:flex;align-items:center;gap:${px(8 * u)};flex:0 0 auto`,
  );
  for (const hex of ["#FF5F56", "#FFBD2E", "#27C93F"]) {
    el(
      dotsWrap,
      `position:relative;width:${px(11 * u)};height:${px(11 * u)};border-radius:50%;background:${hex}`,
    );
  }

  const urlNode = el(
    bar,
    `position:relative;font-family:"JetBrains Mono", monospace;font-size:${px(20 * u)};line-height:1;color:${MUTED};background:rgba(15,23,42,0.85);border:1px solid rgba(148,163,184,0.18);border-radius:${px(8 * u)};padding:${px(6 * u)} ${px(16 * u)};white-space:nowrap`,
  );
  urlNode.textContent = urlLabel;

  const badgeNode = el(
    bar,
    `position:relative;font-family:"JetBrains Mono", monospace;font-weight:700;font-size:${px(20 * u)};line-height:1;color:${BG_OBSIDIAN};background:${accentHex};border-radius:${px(8 * u)};padding:${px(6 * u)} ${px(14 * u)};white-space:nowrap`,
  );
  badgeNode.textContent = stepPill;

  const progressTrack = el(
    bar,
    `left:0;right:0;bottom:0;height:${px(3 * u)};background:rgba(148,163,184,0.14)`,
  );
  const progressFill = el(
    progressTrack,
    `left:0;top:0;bottom:0;width:0%;background:${accentHex}`,
  );

  const vp = el(
    shell,
    `left:0;top:${px(barH)};width:${px(vpW)};height:${px(vpH)};overflow:hidden;background:${BG_OBSIDIAN}`,
  );

  return { shell, vp, vpW, vpH, progressFill };
}

function mountCalloutCard(
  parent: HTMLElement,
  u: number,
  vpW: number,
  vpH: number,
  spec: CalloutSpec,
) {
  const toneHex =
    spec.tone === "coral" ? CORAL_BORDER : spec.tone === "cyan" ? CYAN : EMERALD;
  const labelHex =
    spec.tone === "coral" ? CORAL_TEXT : spec.tone === "cyan" ? CYAN : EMERALD;
  const padEdgeX = 28 * u;
  const padEdgeY = 28 * u;
  const topEdgeY = 68 * u;
  const cardW = 590 * u;

  let posCss = "";
  if (spec.corner === "top-right") posCss = `right:${px(padEdgeX)};top:${px(topEdgeY)}`;
  else if (spec.corner === "top-left") posCss = `left:${px(padEdgeX)};top:${px(topEdgeY)}`;
  else if (spec.corner === "bottom-left") posCss = `left:${px(padEdgeX)};bottom:${px(padEdgeY)}`;
  else posCss = `right:${px(padEdgeX)};bottom:${px(padEdgeY)}`;

  const card = el(
    parent,
    `${posCss};width:${px(Math.min(cardW, vpW - 60 * u))};background:${CARD_BG};border:${px(2 * u)} solid ${toneHex};border-radius:${px(14 * u)};padding:${px(16 * u)} ${px(20 * u)};box-sizing:border-box;box-shadow:0 ${px(22 * u)} ${px(48 * u)} rgba(0,0,0,0.78);z-index:75;pointer-events:none;opacity:0`,
  );

  const r1 = el(card, `position:relative;display:flex;align-items:baseline;gap:${px(10 * u)};margin-bottom:${px(8 * u)}`);
  const tag1 = el(
    r1,
    `position:relative;font-family:"JetBrains Mono", monospace;font-weight:700;font-size:${px(19 * u)};letter-spacing:0.06em;color:${labelHex};flex:0 0 auto`,
  );
  tag1.textContent = "WHAT IT IS";
  const txt1 = el(
    r1,
    `position:relative;font-family:"Onest", "Inter", sans-serif;font-weight:700;font-size:${px(25 * u)};line-height:1.25;color:${INK}`,
  );
  txt1.textContent = spec.what;

  const r2 = el(card, `position:relative;display:flex;align-items:baseline;gap:${px(10 * u)}`);
  const tag2 = el(
    r2,
    `position:relative;font-family:"JetBrains Mono", monospace;font-weight:700;font-size:${px(19 * u)};letter-spacing:0.06em;color:${CYAN};flex:0 0 auto`,
  );
  tag2.textContent = "WHY";
  const txt2 = el(
    r2,
    `position:relative;font-family:"Onest", "Inter", sans-serif;font-weight:500;font-size:${px(24 * u)};line-height:1.28;color:${MUTED}`,
  );
  txt2.textContent = spec.why;

  const dir = spec.corner.includes("right") ? 1 : -1;
  return {
    draw(sec: number) {
      const enter = ease.outCubic(prog(sec, spec.startSec, 0.38));
      const exit = 1 - ease.inCubic(prog(sec, Math.max(spec.startSec + 0.5, spec.endSec - 0.35), 0.35));
      const op = clamp(enter * exit, 0, 1);
      card.style.opacity = op.toFixed(3);
      card.style.visibility = op <= 0.005 || vpH <= 0 ? "hidden" : "";
      card.style.transform = `translate3d(${px(dir * (1 - enter) * 24 * u)}, 0, 0)`;
    },
  };
}

function buildWaypointsFromClicks(
  clicks: ClickSpec[],
  toSceneSec: (clipSec: number) => number,
  vpW: number,
  vpH: number,
  startSec: number,
): { waypoints: Waypoint[]; sfxTimes: number[] } {
  const waypoints: Waypoint[] = [
    { at: startSec, x: 0.52 * vpW, y: 0.44 * vpH, dur: 0.25 },
  ];
  const sfxTimes: number[] = [];
  for (const cl of clicks) {
    const landingSec = toSceneSec(cl.at);
    const arriveStart = Math.max(startSec + 0.1, landingSec - TRAVEL);
    const x = (cl.box[0] ?? 0.5) * vpW;
    const y = (cl.box[1] ?? 0.5) * vpH;
    waypoints.push({ at: arriveStart, x, y, dur: TRAVEL, click: true });
    sfxTimes.push(landingSec);
  }
  return { waypoints, sfxTimes };
}

function evaluateZoomHolds(
  sec: number,
  holds: ZoomHold[],
  plateUrls: string[],
): { zoom: number; focusX: number; focusY: number; activePlateOp: Record<string, number> } {
  let zoom = 1.0;
  let focusX = 0.5;
  let focusY = 0.5;
  const activePlateOp: Record<string, number> = {};
  for (const p of plateUrls) activePlateOp[p] = 0;

  for (const h of holds) {
    if (sec < h.startSec || sec > h.endSec) continue;
    const inEase = ease.inOutCubic(prog(sec, h.startSec, 0.58));
    const outEase = 1 - ease.inOutCubic(prog(sec, Math.max(h.startSec + 0.6, h.endSec - 0.52), 0.52));
    const blend = clamp(Math.min(inEase, outEase), 0, 1);
    const span = Math.max(0.5, h.endSec - h.startSec);
    // Gentle linear micro-drift avoids any frozen pixels during zoom hold.
    const drift = 0.032 * prog(sec, h.startSec, span);
    zoom = lerp(1.0, h.zoom + drift, blend);
    focusX = lerp(0.5, h.focusX, blend);
    focusY = lerp(0.5, h.focusY, blend);
    activePlateOp[h.plate] = Math.max(activePlateOp[h.plate] ?? 0, ease.outCubic(prog(sec, h.startSec, 0.35)) * outEase);
  }

  return { zoom, focusX, focusY, activePlateOp };
}

/** Scene 1: Brief Problem Hook -> Live 1-Click Entry into #near-intents-arena. */
export function buildTourEntryScene(mode: "full" | "cut"): Builder {
  return (root, _s, c) => {
    const u = c.u;
    addObsidianStageBase(root, u);

    const hookDur = mode === "full" ? 3.8 : 1.8;
    const clipInfo = TOUR_MANIFEST.clips.step01;
    const clipDur = clipInfo.duration;

    // 1. Problem Hook Layer (dark enclave obsidian only)
    const hookLayer = el(
      root,
      `inset:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:0 ${px(140 * u)};z-index:20;background:${BG_OBSIDIAN}`,
    );
    const eye = el(
      hookLayer,
      `position:relative;font-family:"JetBrains Mono", monospace;font-weight:700;font-size:${px(22 * u)};letter-spacing:0.12em;color:${EMERALD};margin-bottom:${px(20 * u)}`,
    );
    eye.textContent = "AUTONOMOUS TEAMS ON NEAR";

    const title = el(
      hookLayer,
      `position:relative;font-family:"Onest", "Inter", sans-serif;font-weight:800;font-size:${px(66 * u)};line-height:1.08;letter-spacing:-0.025em;color:${INK};max-width:${px(1380 * u)};margin-bottom:${px(22 * u)}`,
    );
    title.textContent =
      mode === "full"
        ? "Agents can talk in chat, or hold keys. Rarely safely both."
        : "Your team and NEAR agents, with hardware spend caps.";

    const sub = el(
      hookLayer,
      `position:relative;font-family:"Onest", "Inter", sans-serif;font-weight:500;font-size:${px(28 * u)};line-height:1.35;color:${MUTED};max-width:${px(1220 * u)};margin-bottom:${px(34 * u)}`,
    );
    sub.textContent =
      "Walk through every live step: @kronos swaps, OutLayer TDX caps, Terrace bets, GPU pools, and 8/8 checks.";

    const pillRow = el(hookLayer, `position:relative;display:flex;gap:${px(16 * u)};flex-wrap:wrap`);
    for (const [label, hex] of [
      ["1Click Multi-Solver", EMERALD],
      ["OutLayer Intel TDX ($25/tx)", CYAN],
      ["100% ML-DSA-65 Receipts", EMERALD],
    ] as const) {
      const p = el(
        pillRow,
        `position:relative;font-family:"JetBrains Mono", monospace;font-weight:700;font-size:${px(21 * u)};color:${INK};background:${CARD_BG};border:1.5px solid ${hex};border-radius:${px(10 * u)};padding:${px(10 * u)} ${px(18 * u)}`,
      );
      p.textContent = label;
    }

    // 2. Live Browser Walkthrough Layer
    const stageWrap = el(root, `inset:0;opacity:0;z-index:25`);
    const { shell, vp, vpW, vpH, progressFill } = buildChromeWindow(
      stageWrap,
      c,
      "STEP 01 / 07 · 1-CLICK LOGIN",
      "https://agentes-near-production.up.railway.app/ocelli",
    );
    const camera = el(vp, "left:0;top:0;width:100%;height:100%;transform-origin:0 0");
    camera.dataset.avmCamera = "true";

    const clip = media(clipInfo.clip);
    clip.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill";
    camera.appendChild(clip.el);

    const retEnter = media("assets/ret-01-ocelli-enter.png");
    retEnter.el.style.cssText =
      "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;opacity:0";
    camera.appendChild(retEnter.el);

    const cur = pointer(camera, 28 * u, { ink: INK, rim: BG_OBSIDIAN, ring: EMERALD });

    const { waypoints, sfxTimes } = buildWaypointsFromClicks(
      clipInfo.clicks,
      (cs) => hookDur + cs,
      vpW,
      vpH,
      hookDur,
    );
    sfxTimes.forEach((st, idx) => {
      sfx(c.a + st, CLICK_SOUNDS[idx % CLICK_SOUNDS.length]!, 0.2 + (idx % 2) * 0.04);
    });

    const callout = mountCalloutCard(shell, u, vpW, vpH, {
      what: "One shared Slack for humans and agents",
      why: "Sign in with one click directly into #near-intents-arena",
      corner: "top-right",
      tone: "emerald",
      startSec: hookDur + 4.4,
      endSec: c.len - 0.3,
    });

    const holds: ZoomHold[] = [
      {
        startSec: hookDur + clipDur - 0.4,
        endSec: c.len - 0.2,
        zoom: 1.38,
        focusX: 0.48,
        focusY: 0.62,
        plate: "assets/ret-01-ocelli-enter.png",
      },
    ];

    return (t) => {
      const hookOp = 1 - ease.inOutCubic(prog(t, hookDur - 0.32, 0.48));
      hookLayer.style.opacity = hookOp.toFixed(3);
      hookLayer.style.visibility = hookOp <= 0.01 ? "hidden" : "";
      const enterSlide = ease.outCubic(prog(t, 0, 0.45));
      title.style.transform = `translate3d(0, ${px((1 - enterSlide) * 20 * u)}, 0)`;
      sub.style.transform = `translate3d(0, ${px((1 - enterSlide) * 28 * u)}, 0)`;
      const shimmerShift = Math.sin(t * 2.2) * 3 * u;
      pillRow.style.transform = `translate3d(${px(shimmerShift)}, 0, 0)`;

      const stageOp = ease.outCubic(prog(t, hookDur - 0.25, 0.45));
      stageWrap.style.opacity = stageOp.toFixed(3);

      const cu = clamp(t - hookDur, 0, clipDur);
      clip.draw(cu);
      retEnter.draw(t);

      const z = evaluateZoomHolds(t, holds, ["assets/ret-01-ocelli-enter.png"]);
      retEnter.el.style.opacity = (z.activePlateOp["assets/ret-01-ocelli-enter.png"] ?? 0).toFixed(3);

      const fx = clampFocus(z.focusX, z.zoom);
      const fy = clampFocus(z.focusY, z.zoom);
      camera.style.transform = `translate(${((0.5 - fx * z.zoom) * 100).toFixed(3)}%, ${((0.5 - fy * z.zoom) * 100).toFixed(3)}%) scale(${z.zoom.toFixed(4)})`;

      const p = pointerAt(t, waypoints);
      cur.draw(p.x, p.y, {
        click: p.click,
        opacity: p.opacity * stageOp * (1 - (z.activePlateOp["assets/ret-01-ocelli-enter.png"] ?? 0) * 0.8),
      });

      progressFill.style.width = `${(prog(t, 0, c.len) * 100).toFixed(2)}%`;
      callout.draw(t);
      root.style.opacity = outro(t, c).toFixed(3);
    };
  };
}

interface GenericTourConfig {
  stepKey: keyof typeof TOUR_MANIFEST.clips;
  stepPill: string;
  urlLabel: string;
  accentHex?: string;
  clipRate?: number;
  holds: (clipEndSec: number, slotLen: number) => ZoomHold[];
  calloutA: (slotLen: number) => CalloutSpec;
  calloutB?: (slotLen: number) => CalloutSpec;
}

function buildClipAndRetinaScene(cfg: GenericTourConfig): Builder {
  return (root, _s, c) => {
    const u = c.u;
    addObsidianStageBase(root, u);

    const clipInfo = TOUR_MANIFEST.clips[cfg.stepKey];
    const rate = cfg.clipRate ?? 1.0;
    const clipEndSec = clipInfo.duration / rate;

    const { shell, vp, vpW, vpH, progressFill } = buildChromeWindow(
      root,
      c,
      cfg.stepPill,
      cfg.urlLabel,
      cfg.accentHex ?? EMERALD,
    );
    const camera = el(vp, "left:0;top:0;width:100%;height:100%;transform-origin:0 0");
    camera.dataset.avmCamera = "true";

    const clip = media(clipInfo.clip);
    clip.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill";
    camera.appendChild(clip.el);

    const holds = cfg.holds(clipEndSec, c.len);
    const uniquePlates = Array.from(new Set(holds.map((h) => h.plate)));
    const plates = uniquePlates.map((path) => {
      const m = media(path);
      m.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;opacity:0";
      camera.appendChild(m.el);
      return { path, media: m };
    });

    const cur = pointer(camera, 28 * u, {
      ink: INK,
      rim: BG_OBSIDIAN,
      ring: cfg.accentHex ?? EMERALD,
    });

    const { waypoints, sfxTimes } = buildWaypointsFromClicks(
      clipInfo.clicks,
      (cs) => cs / rate,
      vpW,
      vpH,
      0,
    );
    sfxTimes.forEach((st, idx) => {
      sfx(c.a + st, CLICK_SOUNDS[idx % CLICK_SOUNDS.length]!, 0.2 + (idx % 2) * 0.04);
    });

    const calloutA = mountCalloutCard(shell, u, vpW, vpH, cfg.calloutA(c.len));
    const calloutB = cfg.calloutB ? mountCalloutCard(shell, u, vpW, vpH, cfg.calloutB(c.len)) : null;

    return (t) => {
      const cu = clamp(t * rate, 0, clipInfo.duration);
      clip.draw(cu);
      for (const p of plates) p.media.draw(t);

      const z = evaluateZoomHolds(t, holds, uniquePlates);
      for (const p of plates) {
        p.media.el.style.opacity = (z.activePlateOp[p.path] ?? 0).toFixed(3);
      }

      const fx = clampFocus(z.focusX, z.zoom);
      const fy = clampFocus(z.focusY, z.zoom);
      camera.style.transform = `translate(${((0.5 - fx * z.zoom) * 100).toFixed(3)}%, ${((0.5 - fy * z.zoom) * 100).toFixed(3)}%) scale(${z.zoom.toFixed(4)})`;

      const pt = pointerAt(t, waypoints);
      const maxPlateOp = Math.max(0, ...Object.values(z.activePlateOp));
      cur.draw(pt.x, pt.y, { click: pt.click, opacity: pt.opacity * (1 - maxPlateOp * 0.85) });

      progressFill.style.width = `${(prog(t, 0, c.len) * 100).toFixed(2)}%`;
      calloutA.draw(t);
      calloutB?.draw(t);
      root.style.opacity = outro(t, c).toFixed(3);
    };
  };
}

/** Split two-phase scene pausing smoothly on first Retina plate mid-clip before clicking second action. */
interface TwoPhaseTourConfig {
  stepKey: keyof typeof TOUR_MANIFEST.clips;
  stepPill: string;
  urlLabel: string;
  splitClipSec: number;
  hold1StartSec: number;
  hold1EndSec: number;
  plate1: string;
  focus1: { zoom: number; x: number; y: number };
  callout1: CalloutSpec;
  plate2: string;
  focus2: { zoom: number; x: number; y: number };
  callout2: CalloutSpec;
}

function buildTwoPhaseTourScene(cfg: TwoPhaseTourConfig): Builder {
  return (root, _s, c) => {
    const u = c.u;
    addObsidianStageBase(root, u);

    const clipInfo = TOUR_MANIFEST.clips[cfg.stepKey];
    const pauseDur = cfg.hold1EndSec - cfg.hold1StartSec;

    const toSceneSec = (cs: number) =>
      cs <= cfg.splitClipSec ? cs : cfg.hold1EndSec + (cs - cfg.splitClipSec);

    const { shell, vp, vpW, vpH, progressFill } = buildChromeWindow(
      root,
      c,
      cfg.stepPill,
      cfg.urlLabel,
      EMERALD,
    );
    const camera = el(vp, "left:0;top:0;width:100%;height:100%;transform-origin:0 0");
    camera.dataset.avmCamera = "true";

    const clip = media(clipInfo.clip);
    clip.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill";
    camera.appendChild(clip.el);

    const p1 = media(cfg.plate1);
    p1.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;opacity:0";
    camera.appendChild(p1.el);

    const p2 = media(cfg.plate2);
    p2.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;opacity:0";
    camera.appendChild(p2.el);

    const cur = pointer(camera, 28 * u, { ink: INK, rim: BG_OBSIDIAN, ring: EMERALD });
    const { waypoints, sfxTimes } = buildWaypointsFromClicks(
      clipInfo.clicks,
      toSceneSec,
      vpW,
      vpH,
      0,
    );
    sfxTimes.forEach((st, idx) => {
      sfx(c.a + st, CLICK_SOUNDS[idx % CLICK_SOUNDS.length]!, 0.2 + (idx % 2) * 0.04);
    });

    const holds: ZoomHold[] = [
      {
        startSec: cfg.hold1StartSec,
        endSec: cfg.hold1EndSec - 0.15,
        zoom: cfg.focus1.zoom,
        focusX: cfg.focus1.x,
        focusY: cfg.focus1.y,
        plate: cfg.plate1,
      },
      {
        startSec: cfg.hold1EndSec + (clipInfo.duration - cfg.splitClipSec) - 0.6,
        endSec: c.len - 0.25,
        zoom: cfg.focus2.zoom,
        focusX: cfg.focus2.x,
        focusY: cfg.focus2.y,
        plate: cfg.plate2,
      },
    ];

    const callout1 = mountCalloutCard(shell, u, vpW, vpH, cfg.callout1);
    const callout2 = mountCalloutCard(shell, u, vpW, vpH, cfg.callout2);

    return (t) => {
      const cu =
        t < cfg.hold1StartSec
          ? t
          : t < cfg.hold1EndSec
            ? cfg.splitClipSec
            : clamp(t - pauseDur, cfg.splitClipSec, clipInfo.duration);

      clip.draw(cu);
      p1.draw(t);
      p2.draw(t);

      const z = evaluateZoomHolds(t, holds, [cfg.plate1, cfg.plate2]);
      p1.el.style.opacity = (z.activePlateOp[cfg.plate1] ?? 0).toFixed(3);
      p2.el.style.opacity = (z.activePlateOp[cfg.plate2] ?? 0).toFixed(3);

      const fx = clampFocus(z.focusX, z.zoom);
      const fy = clampFocus(z.focusY, z.zoom);
      camera.style.transform = `translate(${((0.5 - fx * z.zoom) * 100).toFixed(3)}%, ${((0.5 - fy * z.zoom) * 100).toFixed(3)}%) scale(${z.zoom.toFixed(4)})`;

      const pt = pointerAt(t, waypoints);
      const maxPlateOp = Math.max(z.activePlateOp[cfg.plate1] ?? 0, z.activePlateOp[cfg.plate2] ?? 0);
      cur.draw(pt.x, pt.y, { click: pt.click, opacity: pt.opacity * (1 - maxPlateOp * 0.85) });

      progressFill.style.width = `${(prog(t, 0, c.len) * 100).toFixed(2)}%`;
      callout1.draw(t);
      callout2.draw(t);
      root.style.opacity = outro(t, c).toFixed(3);
    };
  };
}

/** Scene 2: Mention @kronos in #near-intents-arena -> Live streamed NEAR 1Click + OutLayer TDX reply. */
export const buildTourKronosChatScene = (rate = 1.0): Builder =>
  buildClipAndRetinaScene({
    stepKey: "step02",
    stepPill: "STEP 02 / 07 · @KRONOS IN SLACK",
    urlLabel: "agentes-near-production.up.railway.app/#near-intents-arena",
    clipRate: rate,
    holds: (clipEnd, len) => [
      {
        startSec: Math.min(clipEnd - 0.4, len * 0.62),
        endSec: len - 0.25,
        zoom: 1.48,
        focusX: 0.44,
        focusY: 0.54,
        plate: "assets/ret-02-kronos-reply.png",
      },
    ],
    calloutA: (len) => ({
      what: "Mention @kronos inside #near-intents-arena",
      why: "Streams 3.5739 wNEAR, NEP-413, and ML-DSA-65 inline",
      corner: "top-right",
      tone: "emerald",
      startSec: Math.min(len * 0.42, 6.2),
      endSec: len - 0.3,
    }),
  });

/** Scene 3: Open NEAR Intents & TEE -> Run live 1Click Multi-Solver Auction. */
export const buildTourOneClickScene = (): Builder =>
  buildClipAndRetinaScene({
    stepKey: "step03",
    stepPill: "STEP 03 / 07 · 1CLICK SOLVERS",
    urlLabel: "agentes-near-production.up.railway.app :: NEAR Intents & TEE",
    holds: (clipEnd, len) => [
      {
        startSec: clipEnd - 0.4,
        endSec: len - 0.25,
        zoom: 1.54,
        focusX: 0.48,
        focusY: 0.84,
        plate: "assets/ret-03-1click-table.png",
      },
    ],
    calloutA: (len) => ({
      what: "Live 1click.chaindefuser.com multi-solver auction",
      why: "Agents benchmark competing NEAR solvers before execution",
      corner: "top-right",
      tone: "cyan",
      startSec: 5.5,
      endSec: len - 0.3,
    }),
  });

/** Scene 4 (Full 22s): OutLayer Intel TDX Guard ($12 APPROVED -> $45 BLOCKED_PER_TX_CAP). */
export const buildTourOutlayerFullScene = (): Builder =>
  buildTwoPhaseTourScene({
    stepKey: "step04",
    stepPill: "STEP 04 / 07 · OUTLAYER INTEL TDX",
    urlLabel: "agentes-near-production.up.railway.app :: OutLayer TDX Guard",
    splitClipSec: 3.5,
    hold1StartSec: 3.5,
    hold1EndSec: 10.2,
    plate1: "assets/ret-04a-safe-pass.png",
    focus1: { zoom: 1.5, x: 0.48, y: 0.72 },
    callout1: {
      what: "$12 Safe Intent approved inside TDX",
      why: "Signed with NEP-413 under your $25 per-tx cap",
      corner: "top-right",
      tone: "emerald",
      startSec: 3.7,
      endSec: 9.8,
    },
    plate2: "assets/ret-04b-rogue-block.png",
    focus2: { zoom: 1.52, x: 0.48, y: 0.72 },
    callout2: {
      what: "$45 Rogue Drain stopped in enclave",
      why: "Enforces BLOCKED_PER_TX_CAP before any funds move",
      corner: "top-right",
      tone: "coral",
      startSec: 13.8,
      endSec: 21.6,
    },
  });

/** Scene 4 (Cut 10s): Fast OutLayer TDX Guard showcase ($12 Pass -> $45 Block). */
export const buildTourOutlayerCutScene = (): Builder =>
  buildClipAndRetinaScene({
    stepKey: "step04",
    stepPill: "OUTLAYER INTEL TDX GUARD",
    urlLabel: "agentes-near-production.up.railway.app :: $12 PASS -> $45 BLOCK",
    accentHex: CORAL_BORDER,
    clipRate: 1.25,
    holds: (clipEnd, len) => [
      {
        startSec: clipEnd - 0.3,
        endSec: len - 0.2,
        zoom: 1.52,
        focusX: 0.48,
        focusY: 0.72,
        plate: "assets/ret-04b-rogue-block.png",
      },
    ],
    calloutA: (len) => ({
      what: "Hardware TDX enforces $25 per-tx caps",
      why: "$12 passes NEP-413 while $45 drains trigger BLOCKED_PER_TX_CAP",
      corner: "top-right",
      tone: "coral",
      startSec: 4.8,
      endSec: len - 0.25,
    }),
  });

/** Scene 5: Terrace Conviction Markets (10 wNEAR BACK + $AGENTES Burn-on-Miss). */
export const buildTourTerraceScene = (): Builder =>
  buildClipAndRetinaScene({
    stepKey: "step05",
    stepPill: "STEP 05 / 07 · TERRACE MARKETS",
    urlLabel: "agentes-near-production.up.railway.app :: Terrace Markets",
    holds: (clipEnd, len) => [
      {
        startSec: clipEnd - 0.35,
        endSec: len - 0.25,
        zoom: 1.46,
        focusX: 0.48,
        focusY: 0.46,
        plate: "assets/ret-05-terrace-bet.png",
      },
    ],
    calloutA: (len) => ({
      what: "Conviction markets settled via NEP-297",
      why: "10 wNEAR BACK position routes misses to burn 12.5 $AGENTES",
      corner: "bottom-right",
      tone: "emerald",
      startSec: 4.8,
      endSec: len - 0.3,
    }),
  });

/** Scene 6 (Full 18s): Corpus x402 H100 TEE ($1.84/hr) + Kanmani Escrow Level Up (NEP-171). */
export const buildTourCorpusKanmaniScene = (): Builder =>
  buildTwoPhaseTourScene({
    stepKey: "step06",
    stepPill: "STEP 06 / 07 · CORPUS x402 + KANMANI NFT",
    urlLabel: "agentes-near-production.up.railway.app :: Endowment & Escrow",
    splitClipSec: 3.3,
    hold1StartSec: 3.3,
    hold1EndSec: 8.6,
    plate1: "assets/ret-06a-corpus-endow.png",
    focus1: { zoom: 1.5, x: 0.48, y: 0.36 },
    callout1: {
      what: "Corpus x402 H100 confidential GPU pool",
      why: "Add +4h runway at $1.84/hr with Tab BNPL credit",
      corner: "bottom-right",
      tone: "cyan",
      startSec: 3.4,
      endSec: 8.2,
    },
    plate2: "assets/ret-06b-escrow-nft.png",
    focus2: { zoom: 1.46, x: 0.48, y: 0.68 },
    callout2: {
      what: "Kanmani escrow upgrades NEP-171 credentials",
      why: "Releasing USDC tasks promotes @ada to Lv.3 Gold (290 XP)",
      corner: "top-right",
      tone: "emerald",
      startSec: 12.4,
      endSec: 17.6,
    },
  });

/** Rapid Cut Scene 4: Terrace Markets -> Corpus x402 + Kanmani NEP-171. */
export const buildTourEconomyCutScene = (): Builder => {
  return (root, _s, c) => {
    const u = c.u;
    addObsidianStageBase(root, u);

    const { shell, vp, vpW, vpH, progressFill } = buildChromeWindow(
      root,
      c,
      "TERRACE + CORPUS x402 + KANMANI NEP-171",
      "agentes-near-production.up.railway.app :: Markets & Credentials",
      CYAN,
    );
    const camera = el(vp, "left:0;top:0;width:100%;height:100%;transform-origin:0 0");
    camera.dataset.avmCamera = "true";

    const terrace = media("assets/ret-05-terrace-bet.png");
    terrace.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill";
    camera.appendChild(terrace.el);

    const kanmani = media("assets/ret-06b-escrow-nft.png");
    kanmani.el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;opacity:0";
    camera.appendChild(kanmani.el);

    const c1 = mountCalloutCard(shell, u, vpW, vpH, {
      what: "Terrace conviction markets burn $AGENTES",
      why: "10 wNEAR BACK position emitted as signed NEP-297 log",
      corner: "bottom-right",
      tone: "emerald",
      startSec: 0.4,
      endSec: 4.7,
    });
    const c2 = mountCalloutCard(shell, u, vpW, vpH, {
      what: "52h H100 TEE + Lv.3 Gold NFT",
      why: "Agents fund Corpus GPUs and earn verified Kanmani XP",
      corner: "top-right",
      tone: "cyan",
      startSec: 5.0,
      endSec: c.len - 0.25,
    });

    return (t) => {
      terrace.draw(t);
      kanmani.draw(t);
      const swap = ease.inOutCubic(prog(t, 4.7, 0.55));
      kanmani.el.style.opacity = swap.toFixed(3);

      const zoom = lerp(1.36, 1.48, t / Math.max(0.1, c.len));
      const fx = clampFocus(lerp(0.49, 0.48, swap), zoom);
      const fy = clampFocus(lerp(0.45, 0.64, swap), zoom);
      camera.style.transform = `translate(${((0.5 - fx * zoom) * 100).toFixed(3)}%, ${((0.5 - fy * zoom) * 100).toFixed(3)}%) scale(${zoom.toFixed(4)})`;

      progressFill.style.width = `${(prog(t, 0, c.len) * 100).toFixed(2)}%`;
      c1.draw(t);
      c2.draw(t);
      root.style.opacity = outro(t, c).toFixed(3);
    };
  };
};

/** Scene 7: /ocelli#motion-studio @mira 60fps Canvas Direct. */
export const buildTourMotionStudioScene = (): Builder =>
  buildClipAndRetinaScene({
    stepKey: "step07",
    stepPill: "STEP 07 / 07 · @MIRA MOTION STUDIO",
    urlLabel: "agentes-near-production.up.railway.app/ocelli#motion-studio",
    accentHex: CYAN,
    holds: (clipEnd, len) => [
      {
        startSec: clipEnd - 0.4,
        endSec: len - 0.25,
        zoom: 1.42,
        focusX: 0.48,
        focusY: 0.62,
        plate: "assets/ret-07-motion-studio.png",
      },
    ],
    calloutA: (len) => ({
      what: "Built-in @mira 60fps Canvas video studio",
      why: "Direct product chapters in-app and render deterministic 1080p MP4",
      corner: "bottom-right",
      tone: "cyan",
      startSec: 4.5,
      endSec: len - 0.3,
    }),
  });

/** Final Scene (Step 8 / Cut Finale): Real $ bun run check:near 8/8 PASS Terminal -> CTA Lockup. */
export function buildTourCliAndLockupScene(mode: "full" | "cut"): Builder {
  return (root, _s, c) => {
    const u = c.u;
    addObsidianStageBase(root, u);

    const terminalEnd = mode === "full" ? 9.4 : 4.2;
    const termWrap = el(root, `inset:0;z-index:20`);
    const { shell, vp, vpW, vpH, progressFill } = buildChromeWindow(
      termWrap,
      c,
      "LIVE VERIFICATION · $ bun run check:near",
      "zsh :: ~/agentes-near :: bun run check:near",
      EMERALD,
    );

    sfx(c.a + (mode === "full" ? 4.5 : 2.1), "chime", 0.18);

    const padX = 44 * u;
    const padY = 30 * u;
    const termCam = el(vp, "left:0;top:0;width:100%;height:100%;transform-origin:50% 30%");
    const termInner = el(
      termCam,
      `inset:0;padding:${px(padY)} ${px(padX)};background:#1C2940;font-family:"JetBrains Mono", monospace`,
    );

    const cmdLine = el(
      termInner,
      `position:relative;font-size:${px(24 * u)};font-weight:700;color:${CYAN};margin-bottom:${px(18 * u)}`,
    );
    const fullCmd = "$ bun run check:near";

    const lines = (TOUR_MANIFEST.checkNearLines ?? []).slice(0, 9);
    const lineNodes = lines.map((line, idx) => {
      const isSummary = line.startsWith("NEAR CHECK:");
      const row = el(
        termInner,
        `position:relative;display:flex;align-items:baseline;gap:${px(12 * u)};margin-bottom:${px((isSummary ? 0 : 10) * u)};margin-top:${px((isSummary ? 12 : 0) * u)};opacity:0;padding:${px(isSummary ? 10 * u : 1 * u)} ${px(isSummary ? 16 * u : 0)};border-radius:${px(10 * u)};${isSummary ? `background:rgba(0,236,151,0.12);border:1px solid ${EMERALD}` : ""}`,
      );
      if (!isSummary && line.startsWith("[PASS]")) {
        const passTag = el(
          row,
          `position:relative;font-weight:700;font-size:${px(18 * u)};color:${BG_OBSIDIAN};background:${EMERALD};border-radius:${px(6 * u)};padding:${px(3 * u)} ${px(10 * u)};flex:0 0 auto`,
        );
        passTag.textContent = "PASS";
        const body = el(
          row,
          `position:relative;font-size:${px(18 * u)};line-height:1.28;color:${idx % 2 === 0 ? INK : MUTED};white-space:normal;word-break:break-word;max-width:${px(vpW - 180 * u)}`,
        );
        body.textContent = line.replace(/^\[PASS\]\s*/, "");
      } else {
        const body = el(
          row,
          `position:relative;font-weight:700;font-size:${px(24 * u)};color:${EMERALD}`,
        );
        body.textContent = line;
      }
      return { row, startAt: 0.2 + idx * (mode === "full" ? 0.5 : 0.22) };
    });

    const termCallout = mountCalloutCard(shell, u, vpW, vpH, {
      what: "8/8 verified NEAR endpoints on boot",
      why: "1Click, OutLayer TDX, NEAR AI ITA, RPC, and ML-DSA-65 ledger pass",
      corner: "bottom-right",
      tone: "emerald",
      startSec: mode === "full" ? 4.4 : 1.9,
      endSec: terminalEnd - 0.15,
    });

    // Lockup End Card
    const lockWrap = el(
      root,
      `inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 ${px(140 * u)};text-align:center;opacity:0;z-index:30`,
    );
    const lockCard = el(
      lockWrap,
      `position:relative;display:flex;flex-direction:column;align-items:center;background:#182438;border:${px(2 * u)} solid ${EMERALD};border-radius:${px(24 * u)};padding:${px(52 * u)} ${px(76 * u)};box-shadow:0 ${px(28 * u)} ${px(72 * u)} rgba(0,0,0,0.65)`,
    );
    const logoBox = el(
      lockCard,
      `position:relative;display:flex;align-items:center;gap:${px(18 * u)};margin-bottom:${px(22 * u)}`,
    );
    const logoImg = media("assets/agentes-logo.svg");
    logoImg.el.style.cssText = `position:relative;width:${px(64 * u)};height:${px(64 * u)};display:block`;
    logoBox.appendChild(logoImg.el);
    const brandWord = el(
      logoBox,
      `position:relative;font-family:"JetBrains Mono", monospace;font-weight:700;font-size:${px(34 * u)};letter-spacing:-0.02em;color:${EMERALD}`,
    );
    brandWord.textContent = "agentes.near";

    const ctaTitle = el(
      lockCard,
      `position:relative;font-family:"Onest", "Inter", sans-serif;font-weight:800;font-size:${px(64 * u)};line-height:1.1;letter-spacing:-0.025em;color:${INK};max-width:${px(1280 * u)};margin-bottom:${px(22 * u)}`,
    );
    ctaTitle.textContent = "Deploy your self-hosted NEAR agent Slack today.";

    const ctaUrl = el(
      lockCard,
      `position:relative;font-family:"JetBrains Mono", monospace;font-weight:700;font-size:${px(26 * u)};color:${BG_OBSIDIAN};background:${EMERALD};border-radius:${px(12 * u)};padding:${px(14 * u)} ${px(30 * u)};margin-bottom:${px(22 * u)}`,
    );
    ctaUrl.textContent = "agentes-near-production.up.railway.app/ocelli";

    const ctaMeta = el(
      lockCard,
      `position:relative;font-family:"JetBrains Mono", monospace;font-size:${px(21 * u)};color:${MUTED}`,
    );
    ctaMeta.textContent = "13 NEAR Tracks · OutLayer Intel TDX · 100% ML-DSA-65 (NIST FIPS 204)";

    return (t) => {
      logoImg.draw(t);
      const typedCount = Math.max(1, Math.round(prog(t, 0, 0.7) * fullCmd.length));
      cmdLine.textContent = fullCmd.slice(0, typedCount);

      for (const ln of lineNodes) {
        const show = ease.outCubic(prog(t, ln.startAt, 0.24));
        ln.row.style.opacity = show.toFixed(3);
        ln.row.style.transform = `translate3d(0, ${px((1 - show) * 10 * u)}, 0)`;
      }

      const tp = prog(t, 0, terminalEnd);
      termCam.style.transform = `translate3d(0, ${px(-16 * u * tp)}, 0) scale(${lerp(1.0, 1.068, tp).toFixed(4)})`;

      const termOp = 1 - ease.inOutCubic(prog(t, terminalEnd - 0.2, 0.45));
      termWrap.style.opacity = termOp.toFixed(3);
      termWrap.style.visibility = termOp <= 0.01 ? "hidden" : "";
      termCallout.draw(t);
      progressFill.style.width = `${(tp * 100).toFixed(2)}%`;

      const lockOp = ease.outCubic(prog(t, terminalEnd - 0.35, 0.45));
      lockWrap.style.opacity = lockOp.toFixed(3);
      const lockLift = (1 - lockOp) * 18 * u;
      const lockPulse = 1 + Math.sin(Math.max(0, t - terminalEnd) * 2.1) * 0.012;
      lockWrap.style.transform = `translate3d(0, ${px(lockLift)}, 0) scale(${lockPulse.toFixed(4)})`;

      root.style.opacity = outro(t, c).toFixed(3);
    };
  };
}
