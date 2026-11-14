/**
 * Bespoke Agentes NEAR choreography (v5.0.0) combining:
 * 1. Warm Tactile Studio Hook (cream paper #F6F3EC, floating optical bokeh shapes, elastic spring pill).
 * 2. Continuous 3D Studio-Floor Landing Page Fly-Over (zero internal cuts, 24px corners, lifted tiles).
 * 3. Cutline-Style 4-Node Pipeline Execution Diagram with directional signal packets.
 * 4. Elevated Obsidian macOS Browser Windows popping off the bright studio floor with real screenshots.
 * 5. Pure deterministic f(u) evaluation: zero Date, zero Math.random, zero CSS transitions.
 */
import type { Builder, Ctx } from "../../../../libs/film-kit/scenes/kit.ts";
import { el, esc, fin, media, outro, px, safe } from "../../../../libs/film-kit/scenes/kit.ts";
import { clamp, ease, h, lerp, prog, sfx } from "../../../../libs/film-kit/film/lib.ts";
import {
  computeAccentBadgePhysics,
  computeKineticEntrance,
  springSolve,
} from "../../../../libs/film-kit/film/kinetic-physics.ts";

const STUDIO_BG =
  "radial-gradient(ellipse 84% 78% at 48% 44%, #FAF8F3 0%, var(--bg, #F6F3EC) 62%, color-mix(in srgb, var(--bg, #F6F3EC) 88%, #12151C) 100%)";

const OBSIDIAN_SURFACE = "#12151C";
const OBSIDIAN_PANEL = "#171C28";
const STUDIO_INK = "var(--fg, #12151C)";
const STUDIO_MUTED = "var(--muted, #465061)";
const STUDIO_EMERALD = "var(--accent, #067A4B)";
const STUDIO_TERRA = "var(--accent2, #BE3A1A)";
const DARK_FG = "#F6F3EC";
const DARK_MUTED = "#B8C2D4";
const DARK_EMERALD = "#00EC97";
const DARK_SKY = "#38BDF8";
const DARK_AMBER = "#F59E0B";
const DARK_CORAL = "#FF7A59";

interface BokehShape {
  el: HTMLElement;
  baseX: number;
  baseY: number;
  ampX: number;
  ampY: number;
  freq: number;
  phase: number;
  rot: number;
}

/** Mounts warm studio radial paper ground and peripheral bokeh shapes kept strictly outside text regions. */
function mountStudioBackdrop(root: HTMLElement, uScale: number, seedOffset = 0): (u: number) => void {
  const ground = el(root, `inset:0;background:${STUDIO_BG};pointer-events:none;z-index:0`);
  ground.dataset.studioLayer = "ground";

  const specs = [
    {
      css: `width:${150 * uScale}px;height:${150 * uScale}px;border-radius:50%;border:${18 * uScale}px solid #EBC647;background:transparent;filter:blur(${7 * uScale}px);opacity:0.86`,
      x: 120 * uScale,
      y: 28 * uScale,
      ampX: 16 * uScale,
      ampY: 12 * uScale,
      freq: 0.9,
      phase: 0.4 + seedOffset,
      rot: 0,
    },
    {
      css: `width:${290 * uScale}px;height:${290 * uScale}px;border-radius:50%;background:#F3CE56;box-shadow:0 ${18 * uScale}px ${44 * uScale}px rgba(18,21,28,0.08)`,
      x: 1675 * uScale,
      y: -70 * uScale,
      ampX: 14 * uScale,
      ampY: 10 * uScale,
      freq: 0.75,
      phase: 1.3 + seedOffset,
      rot: 0,
    },
    {
      css: `width:${170 * uScale}px;height:${120 * uScale}px;border-radius:${26 * uScale}px;background:#086646;box-shadow:0 ${18 * uScale}px ${36 * uScale}px rgba(6,95,70,0.16)`,
      x: 1120 * uScale,
      y: -76 * uScale,
      ampX: 12 * uScale,
      ampY: 8 * uScale,
      freq: 0.85,
      phase: 2.1 + seedOffset,
      rot: -14,
    },
    {
      css: `width:${82 * uScale}px;height:${82 * uScale}px;border-radius:${16 * uScale}px;background:#2444F5;filter:blur(${5 * uScale}px);opacity:0.88`,
      x: 1715 * uScale,
      y: 350 * uScale,
      ampX: 18 * uScale,
      ampY: 15 * uScale,
      freq: 1.25,
      phase: 2.8 + seedOffset,
      rot: 6,
    },
    {
      css: `width:${390 * uScale}px;height:${340 * uScale}px;border-radius:${42 * uScale}px;background:#F2AEAD;box-shadow:0 ${24 * uScale}px ${56 * uScale}px rgba(190,58,26,0.12)`,
      x: -55 * uScale,
      y: 805 * uScale,
      ampX: 14 * uScale,
      ampY: 10 * uScale,
      freq: 0.7,
      phase: 3.6 + seedOffset,
      rot: -11,
    },
    {
      css: `width:${112 * uScale}px;height:${112 * uScale}px;border-radius:50%;background:#D95D39;filter:blur(${11 * uScale}px);opacity:0.85`,
      x: 1185 * uScale,
      y: 845 * uScale,
      ampX: 20 * uScale,
      ampY: 12 * uScale,
      freq: 1.05,
      phase: 4.2 + seedOffset,
      rot: 0,
    },
    {
      css: `width:${310 * uScale}px;height:${340 * uScale}px;border-radius:${48 * uScale}px;background:#1A3BFF;box-shadow:0 ${24 * uScale}px ${52 * uScale}px rgba(26,59,255,0.16)`,
      x: 1680 * uScale,
      y: 785 * uScale,
      ampX: 14 * uScale,
      ampY: 12 * uScale,
      freq: 0.8,
      phase: 5.0 + seedOffset,
      rot: -13,
    },
  ];

  const shapes: BokehShape[] = specs.map((sp) => {
    const node = el(root, `${sp.css};pointer-events:none;z-index:1;left:0;top:0`);
    return {
      el: node,
      baseX: sp.x,
      baseY: sp.y,
      ampX: sp.ampX,
      ampY: sp.ampY,
      freq: sp.freq,
      phase: sp.phase,
      rot: sp.rot,
    };
  });

  return (u: number) => {
    shapes.forEach((sh) => {
      const dx = Math.sin(u * sh.freq + sh.phase) * sh.ampX;
      const dy = Math.cos(u * (sh.freq * 0.87) + sh.phase) * sh.ampY;
      const dr = Math.sin(u * 0.6 + sh.phase) * 2.2;
      sh.el.style.transform = `translate3d(${(sh.baseX + dx).toFixed(1)}px, ${(sh.baseY + dy).toFixed(1)}px, 0) rotate(${(sh.rot + dr).toFixed(2)}deg)`;
    });
  };
}

/** Creates an elevated obsidian macOS browser window container with high-contrast header chrome. */
function makeBrowserWindow(
  parent: HTMLElement,
  uScale: number,
  bounds: { x: number; y: number; w: number; h: number },
  urlText: string,
  badgeText?: string,
) {
  const frame = el(
    parent,
    `left:${px(bounds.x)};top:${px(bounds.y)};width:${px(bounds.w)};height:${px(bounds.h)};border-radius:${px(22 * uScale)};background:${OBSIDIAN_SURFACE};overflow:hidden;box-shadow:0 ${px(34 * uScale)} ${px(86 * uScale)} ${px(-18 * uScale)} rgba(18,21,28,0.34),0 0 0 ${px(1.5 * uScale)} rgba(18,21,28,0.18);z-index:4`,
  );
  const topbar = el(
    frame,
    `left:0;right:0;top:0;height:${px(42 * uScale)};background:#1A202E;border-bottom:${px(1)} solid rgba(255,255,255,0.09);display:flex;align-items:center;justify-content:space-between;padding:0 ${px(16 * uScale)};z-index:3`,
  );
  const left = h("div", "", topbar);
  left.style.cssText = `display:flex;align-items:center;gap:${px(8 * uScale)}`;
  ["#FF5F56", "#FFBD2E", "#27C93F"].forEach((dotColor) => {
    const dot = h("span", "", left);
    dot.style.cssText = `width:${px(11 * uScale)};height:${px(11 * uScale)};border-radius:50%;background:${dotColor};display:inline-block`;
  });
  const url = h("span", "", left, esc(urlText));
  url.style.cssText = `margin-left:${px(12 * uScale)};font-family:var(--mono);font-size:${px(18 * uScale)};font-weight:500;color:${DARK_MUTED};letter-spacing:0.01em`;

  if (badgeText) {
    const chip = h("span", "", topbar, esc(badgeText));
    chip.style.cssText = `font-family:var(--mono);font-size:${px(17 * uScale)};font-weight:700;color:${DARK_EMERALD};background:rgba(0,236,151,0.12);border:1px solid rgba(0,236,151,0.34);padding:${px(4 * uScale)} ${px(12 * uScale)};border-radius:999px`;
  }

  const body = el(
    frame,
    `left:0;right:0;top:${px(42 * uScale)};bottom:0;overflow:hidden;background:#090D16`,
  );
  return { frame, body };
}

/* -------------------------------------------------------------------------- */
/* Scene 1: Tactile Figma-Config Studio Pill Hook + Kinetic Wave ("Things")   */
/* -------------------------------------------------------------------------- */
export function buildTactileHookScene(mode: "full" | "teaser"): Builder {
  return (root, _s, c) => {
    const uS = c.u;
    const z = safe(c);
    const drawBokeh = mountStudioBackdrop(root, uS, 0.2);

    if (mode === "full") {
      sfx(c.a + 0.18, "pop", 0.55);
      sfx(c.a + 2.0, "blip", 0.5);
      sfx(c.a + 3.8, "chime", 0.52);
      sfx(c.a + 5.7, "whoosh", 0.56);
      sfx(c.a + 8.0, "impact", 0.62);
    } else {
      sfx(c.a + 0.15, "pop", 0.55);
      sfx(c.a + 2.0, "blip", 0.52);
      sfx(c.a + 3.7, "impact", 0.58);
    }

    const hookStage = el(root, `inset:0;z-index:4;pointer-events:none`);

    const eyebrow = el(
      hookStage,
      `left:${px(Math.max(168 * uS, z.x + 36 * uS))};top:${px(230 * uS)};font-family:var(--mono);font-size:${px(22 * uS)};font-weight:700;letter-spacing:0.08em;color:${STUDIO_MUTED};text-transform:uppercase`,
      "AGENTES NEAR · SLACK WORKSPACE FOR HUMAN TEAMS & 6 AI AGENTS",
    );

    const headlineWrap = el(
      hookStage,
      `left:${px(Math.max(168 * uS, z.x + 36 * uS))};top:${px(292 * uS)};width:${px(1540 * uS)};font-family:var(--sans);font-weight:800;font-size:${px(112 * uS)};line-height:1.12;letter-spacing:-0.04em;color:${STUDIO_INK}`,
    );

    const line1 = h("div", "", headlineWrap, "What will your");
    line1.style.cssText = `white-space:nowrap;transform-origin:left center`;

    const line2 = h("div", "", headlineWrap);
    line2.style.cssText = `display:flex;align-items:center;gap:${px(22 * uS)};margin-top:${px(10 * uS)};white-space:nowrap`;

    const prefix2 = h("span", "", line2, "NEAR agents");
    prefix2.style.cssText = `display:inline-block`;

    const pill = h("span", "", line2);
    pill.style.cssText = `display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:${px(4 * uS)} ${px(48 * uS)} ${px(12 * uS)} ${px(48 * uS)};color:#FAF7F0;font-size:${px(106 * uS)};font-weight:800;letter-spacing:-0.03em;box-shadow:0 ${px(20 * uS)} ${px(44 * uS)} rgba(18,21,28,0.16);transform-origin:left center`;

    const subChipRow = el(
      hookStage,
      `left:${px(Math.max(168 * uS, z.x + 36 * uS))};top:${px(616 * uS)};display:flex;gap:${px(16 * uS)};align-items:center`,
    );
    const pillsData = [
      { label: "NEAR 1Click Multi-Solver", tone: STUDIO_EMERALD },
      { label: "OutLayer Intel TDX $25 Cap", tone: STUDIO_TERRA },
      { label: "NIST FIPS 204 Verified", tone: OBSIDIAN_SURFACE },
    ];
    const subChips = pillsData.map((p) => {
      const ch = h("div", "", subChipRow, esc(p.label));
      ch.style.cssText = `font-family:var(--mono);font-size:${px(21 * uScaleValue(uS))};font-weight:700;padding:${px(12 * uS)} ${px(22 * uS)};border-radius:${px(14 * uS)};background:${OBSIDIAN_SURFACE};color:${DARK_FG};border:${px(2)} solid ${p.tone};box-shadow:0 ${px(10 * uS)} ${px(24 * uS)} rgba(18,21,28,0.14)`;
      return ch;
    });

    // Act B: Full-bleed Canvas2D "Things are moving" wave + final lockup
    const waveLayer = el(root, `inset:0;z-index:5;pointer-events:none`);
    const canvas = document.createElement("canvas");
    canvas.width = c.W;
    canvas.height = c.H;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    waveLayer.appendChild(canvas);
    const ctx2d = canvas.getContext("2d");

    const waveRestCard = el(
      waveLayer,
      `left:${px(240 * uS)};right:${px(240 * uS)};top:${px(310 * uS)};padding:${px(48 * uS)} ${px(56 * uS)};border-radius:${px(30 * uS)};background:${OBSIDIAN_SURFACE};box-shadow:0 ${px(38 * uS)} ${px(96 * uS)} rgba(18,21,28,0.28);text-align:center`,
    );
    const waveHeadline = h("div", "", waveRestCard, "One workspace. Six autonomous agents.");
    waveHeadline.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(66 * uS)};line-height:1.12;letter-spacing:-0.03em;color:${DARK_FG}`;
    const waveSub = h(
      "div",
      "",
      waveRestCard,
      "Chat in channels. Route 1Click swaps. Enforce Intel TDX caps.",
    );
    waveSub.style.cssText = `font-family:var(--sans);font-weight:600;font-size:${px(30 * uS)};color:${DARK_EMERALD};margin-top:${px(18 * uS)}`;

    const waveSwitchAt = mode === "full" ? 5.65 : 3.55;
    const waveLockAt = mode === "full" ? 7.75 : 4.2;

    return (u) => {
      drawBokeh(u);
      const outP = outro(u, c, 0.28);

      // Act A: Elastic Tactile Hook
      const hookVisible = u < waveSwitchAt + 0.3;
      hookStage.style.display = hookVisible ? "" : "none";
      if (hookVisible) {
        const hookFade = u >= waveSwitchAt ? 1 - ease.inOutCubic(prog(u, waveSwitchAt, 0.3)) : 1;
        hookStage.style.opacity = (hookFade * outP).toFixed(3);

        const ebIn = fin(u, 0.02, 0.35);
        eyebrow.style.opacity = ebIn.toFixed(3);
        eyebrow.style.transform = `translateY(${((1 - ebIn) * 18 * uS).toFixed(1)}px)`;

        const l1Phys = computeKineticEntrance(u, 0.04, {
          springPreset: "snappy",
          startDistance: 42 * uS,
          duration: 0.45,
        });
        line1.style.opacity = l1Phys.opacity.toFixed(3);
        line1.style.transform = `translateY(${l1Phys.translateY.toFixed(1)}px) scale(${l1Phys.scale.toFixed(4)})`;

        const l2Phys = computeKineticEntrance(u, 0.14, {
          springPreset: "snappy",
          startDistance: 46 * uS,
          duration: 0.5,
        });
        line2.style.opacity = l2Phys.opacity.toFixed(3);
        line2.style.transform = `translateY(${l2Phys.translateY.toFixed(1)}px)`;

        const wordsCycle =
          mode === "full"
            ? [
                { word: "make?", start: 0.22, bg: "#BE3A1A" },
                { word: "swap?", start: 2.0, bg: "#067A4B" },
                { word: "guard?", start: 3.8, bg: "#12151C" },
              ]
            : [
                { word: "make?", start: 0.2, bg: "#BE3A1A" },
                { word: "guard?", start: 2.0, bg: "#067A4B" },
              ];
        let active = wordsCycle[0]!;
        for (const item of wordsCycle) {
          if (u >= item.start) active = item;
        }
        const badgePhys = computeAccentBadgePhysics(u, active.start, "bouncy");
        pill.textContent = active.word;
        pill.style.background = active.bg;
        pill.style.transform = `scale(${badgePhys.scaleX.toFixed(4)}, ${badgePhys.scaleY.toFixed(4)})`;

        subChips.forEach((chip, idx) => {
          const cp = clamp(springSolve(u, 0.32 + idx * 0.14, "snappy"), 0, 1.08);
          chip.style.opacity = clamp((u - (0.3 + idx * 0.14)) * 5).toFixed(3);
          chip.style.transform = `translateY(${((1 - cp) * 28 * uS).toFixed(1)}px)`;
        });
      }

      // Act B: "Things are moving" Canvas Wave + Locked Studio Card
      const waveActive = u >= waveSwitchAt - 0.05;
      waveLayer.style.display = waveActive ? "" : "none";
      if (waveActive && ctx2d) {
        const wIn = prog(u, waveSwitchAt, 0.28);
        waveLayer.style.opacity = (wIn * outP).toFixed(3);
        const beat = Math.floor(u * 2); // 120 BPM = 2 beats/sec
        const palettes = [
          { bg: "#ECF7F1", fg: "#067A4B", rev: "#BE3A1A" },
          { bg: "#F6F3EC", fg: "#12151C", rev: "#067A4B" },
          { bg: "#FBECE8", fg: "#BE3A1A", rev: "#12151C" },
        ];
        const pal = palettes[beat % palettes.length]!;
        const localBeatFrac = u * 2 - beat;
        const pulseBeat = Math.exp(-localBeatFrac * 5.2);

        ctx2d.fillStyle = pal.bg;
        ctx2d.fillRect(0, 0, c.W, c.H);

        const rows = 7;
        const rowH = c.H / rows;
        ctx2d.font = `800 ${Math.round(rowH * 0.54)}px 'Inter', system-ui, sans-serif`;
        ctx2d.textBaseline = "middle";
        const phrase = "AGENTS ARE MOVING · NEAR + TDX · ";
        const measured = Math.ceil(ctx2d.measureText(phrase).width);
        const span = Math.max(960, measured);
        const showRest = u >= waveLockAt - 0.05;
        const waveFade = showRest ? 1 - 0.68 * clamp(prog(u, waveLockAt, 0.25)) : 1;
        ctx2d.globalAlpha = waveFade;

        for (let r = 0; r < rows; r++) {
          const reverse = r === 3;
          ctx2d.fillStyle = reverse ? pal.rev : pal.fg;
          const dir = reverse ? -1 : 1;
          const shift = (((u - waveSwitchAt) * 210 * dir + r * 260) % span) - span;
          const yBase = (r + 0.5) * rowH;
          for (let col = -1; col <= 3; col++) {
            const x = col * span + shift;
            const waveY = Math.sin(x * 0.0045 + u * 5.0 + r * 0.65) * (15 + pulseBeat * 12);
            ctx2d.fillText(phrase, x, yBase + waveY);
          }
        }
        ctx2d.globalAlpha = 1;

        const lockP = ease.outBack(prog(u, waveLockAt, 0.34), 1.3);
        waveRestCard.style.opacity = showRest ? clamp(prog(u, waveLockAt, 0.22)).toFixed(3) : "0";
        waveRestCard.style.transform = `translateY(${((1 - clamp(lockP, 0, 1.06)) * 42 * uS).toFixed(1)}px) scale(${(0.92 + 0.08 * clamp(lockP, 0, 1.06)).toFixed(4)})`;
      }
    };
  };
}

function uScaleValue(uS: number): number {
  return uS;
}

/* -------------------------------------------------------------------------- */
/* Scene 2: Continuous 3D Studio-Floor Landing Page Fly-Over                  */
/* -------------------------------------------------------------------------- */
export function buildStudioFlyoverScene(mode: "full" | "teaser"): Builder {
  return (root, _s, c) => {
    const uS = c.u;
    const z = safe(c);
    const drawBokeh = mountStudioBackdrop(root, uS, 1.7);

    if (mode === "full") {
      sfx(c.a + 0.4, "whoosh", 0.54);
      sfx(c.a + 4.4, "shimmer", 0.45);
      sfx(c.a + 8.8, "click", 0.46);
      sfx(c.a + 10.6, "ding", 0.52);
    } else {
      sfx(c.a + 0.4, "whoosh", 0.52);
      sfx(c.a + 3.6, "ding", 0.5);
    }

    // Feathered top light veil keeps the 2-line studio title clean while the 3D strip glides underneath
    const topMask = el(
      root,
      `left:0;right:0;top:0;height:${px(304 * uS)};background:linear-gradient(to bottom, #FAF8F3 72%, rgba(246,243,236,0) 100%);pointer-events:none;z-index:9`,
    );
    topMask.dataset.studioLayer = "header-mask";

    // Two-line header pinned safely inside top studio zone
    const kicker = el(
      root,
      `left:${px(Math.max(164 * uS, z.x + 32 * uS))};top:${px(96 * uS)};font-family:var(--mono);font-size:${px(21 * uS)};font-weight:700;letter-spacing:0.08em;color:${STUDIO_EMERALD};z-index:12`,
      "CONTINUOUS STUDIO-FLOOR FLY-OVER · LIVE AT AGENTES-NEAR-PRODUCTION",
    );
    const titleWrap = el(
      root,
      `left:${px(Math.max(164 * uS, z.x + 32 * uS))};top:${px(134 * uS)};z-index:12;line-height:1.1`,
    );
    const titleLine1 = h("div", "", titleWrap, "One self-hosted Slack.");
    titleLine1.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(54 * uS)};letter-spacing:-0.03em;color:${STUDIO_INK}`;
    const titleLine2 = h("div", "", titleWrap, "Every NEAR agent inside open channels.");
    titleLine2.style.cssText = `font-family:var(--sans);font-weight:600;font-style:italic;font-size:${px(40 * uS)};letter-spacing:-0.02em;color:${STUDIO_EMERALD};margin-top:${px(4 * uS)}`;

    // 3D Stage Rig
    const viewport = el(
      root,
      `left:0;right:0;top:${px(274 * uS)};bottom:${px(80 * uS)};perspective:${px(1500 * uS)};perspective-origin:50% 42%;overflow:visible;z-index:6`,
    );

    const stripW = 1120 * uS;
    const stripH = 1980 * uS;
    const plane = el(
      viewport,
      `left:50%;top:0;width:${px(stripW)};height:${px(stripH)};margin-left:${px(-stripW / 2)};transform-style:preserve-3d;transform-origin:50% 18%`,
    );

    // Wide ambient floor shadow under the rounded page strip
    const floorShadow = el(
      plane,
      `inset:0;border-radius:${px(24 * uS)};box-shadow:0 ${px(64 * uS)} ${px(130 * uS)} rgba(18,21,28,0.28);transform:translateZ(${px(-28 * uS)})`,
    );

    // The rounded 24px composite landing page card on the studio floor
    const pageCard = el(
      plane,
      `inset:0;border-radius:${px(24 * uS)};overflow:hidden;background:#090E1A;border:${px(2 * uS)} solid rgba(18,21,28,0.18);display:flex;flex-direction:column;gap:${px(12 * uS)};padding:${px(12 * uS)}`,
    );

    const stripPanels = [
      { path: "assets/shot-01-ocelli-hero.png", pos: "50% 0%", origin: "50% 10%", scale: 1 },
      { path: "assets/shot-05-outlayer-guard.png", pos: "50% 48%", origin: "50% 48%", scale: 1.08 },
      { path: "assets/shot-06-1click-swap.png", pos: "50% 96%", origin: "50% 96%", scale: 1.72 },
      { path: "assets/shot-02-ocelli-arcade.png", pos: "50% 95%", origin: "50% 95%", scale: 1.66 },
    ];
    stripPanels.forEach((panel, idx) => {
      const m = media(panel.path);
      const wrap = h("div", "", pageCard);
      const hPx = idx === 0 ? 640 * uS : 430 * uS;
      wrap.style.cssText = `position:relative;width:100%;height:${px(hPx)};border-radius:${px(16 * uS)};overflow:hidden;flex-shrink:0;background:#070B14`;
      m.el.style.cssText = `width:100%;height:100%;object-fit:cover;object-position:${panel.pos};transform-origin:${panel.origin};transform:scale(${panel.scale});display:block`;
      wrap.appendChild(m.el);
    });

    // 4 floating logo/agent tiles that lift off beside the landed hero card (per user direction!)
    const tileConfigs = [
      { x: 164 * uS, y: 318 * uS, tag: "@ada", sub: "1Click Quoter", bg: OBSIDIAN_SURFACE, fg: DARK_EMERALD },
      { x: 164 * uS, y: 454 * uS, tag: "@kronos", sub: "354.18 wNEAR", bg: OBSIDIAN_SURFACE, fg: DARK_FG },
      { x: 1478 * uS, y: 318 * uS, tag: "@theo", sub: "$25 TDX Cap", bg: STUDIO_TERRA, fg: "#FAF7F0" },
      { x: 1478 * uS, y: 454 * uS, tag: "@zen", sub: "ML-DSA-65", bg: STUDIO_EMERALD, fg: "#FAF7F0" },
    ];
    const tileEls = tileConfigs.map((cfg) => {
      const card = el(
        root,
        `left:${px(cfg.x)};top:${px(cfg.y)};width:${px(268 * uS)};padding:${px(16 * uS)} ${px(18 * uS)};border-radius:${px(18 * uS)};background:${cfg.bg};color:${cfg.fg};box-shadow:0 ${px(22 * uS)} ${px(48 * uS)} rgba(18,21,28,0.22);display:flex;align-items:center;gap:${px(14 * uS)};z-index:10`,
      );
      const logo = media("assets/agentes-logo.svg");
      logo.el.style.cssText = `width:${px(40 * uS)};height:${px(40 * uS)};border-radius:${px(10 * uS)};flex-shrink:0`;
      card.appendChild(logo.el);
      const col = h("div", "", card);
      const t1 = h("div", "", col, esc(cfg.tag));
      t1.style.cssText = `font-family:var(--mono);font-size:${px(22 * uS)};font-weight:700`;
      const t2 = h("div", "", col, esc(cfg.sub));
      t2.style.cssText = `font-family:var(--sans);font-size:${px(20 * uS)};font-weight:600;opacity:0.92`;
      return card;
    });

    return (u) => {
      drawBokeh(u);
      const outP = outro(u, c, 0.3);
      const total = Math.max(1, c.len);
      const p = clamp(u / total);

      const hIn = fin(u, 0.05, 0.4);
      kicker.style.opacity = (hIn * outP).toFixed(3);
      titleWrap.style.opacity = (hIn * outP).toFixed(3);
      titleWrap.style.transform = `translateY(${((1 - hIn) * 18 * uS).toFixed(1)}px)`;

      // Continuous 3D Fly-Over curve (never a cut):
      // 0..0.42: low glide backwards down strip (rx 50->38deg, ty 60->-760px, scale 1.06->0.88)
      // 0.42..0.70: rise overhead showing full strip (rx 38->14deg, ty -760->-340px, scale 0.88->0.44)
      // 0.70..1.00: dive and land cleanly on Hero card under title (rx 14->0deg, ty -340->36px, scale 0.44->0.82)
      let rx = 0;
      let ry = 0;
      let ty = 0;
      let sc = 0.82;
      if (p < 0.42) {
        const s = ease.inOutCubic(p / 0.42);
        rx = lerp(48, 36, s);
        ry = lerp(-4, 3, s);
        ty = lerp(40, -680 * uS, s);
        sc = lerp(1.02, 0.82, s);
      } else if (p < 0.7) {
        const s = ease.inOutCubic((p - 0.42) / 0.28);
        rx = lerp(36, 13, s);
        ry = lerp(3, 0, s);
        ty = lerp(-680 * uS, -310 * uS, s);
        sc = lerp(0.82, 0.45, s);
      } else {
        const s = ease.outCubic((p - 0.7) / 0.3);
        rx = lerp(13, 0, s);
        ry = 0;
        ty = lerp(-310 * uS, 28 * uS, s);
        sc = lerp(0.45, 0.84, s);
      }

      plane.style.opacity = outP.toFixed(3);
      plane.style.transform = `translate3d(0, ${ty.toFixed(1)}px, 0) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
      floorShadow.style.opacity = (0.7 + 0.3 * clamp(1 - rx / 60)).toFixed(3);

      // Lifted agent logo tiles float gently along side margins, popping cleanly into final flank alignment
      tileEls.forEach((tile, idx) => {
        const tp = fin(u, 0.45 + idx * 0.22, 0.48);
        const bob = Math.sin(u * 2.1 + idx * 1.4) * 8 * uS;
        const driftX = (idx < 2 ? -1 : 1) * (1 - clamp(prog(p, 0.65, 0.32))) * 22 * uS;
        tile.style.opacity = (tp * outP).toFixed(3);
        tile.style.transform = `translate3d(${driftX.toFixed(1)}px, ${(bob + (1 - tp) * 32 * uS).toFixed(1)}px, 0)`;
      });
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Scene 3: Cutline-Style 4-Node Flow Pipeline Diagram                        */
/* -------------------------------------------------------------------------- */
export function buildCutlineFlowScene(): Builder {
  return (root, _s, c) => {
    const uS = c.u;
    const z = safe(c);
    const drawBokeh = mountStudioBackdrop(root, uS, 3.1);

    sfx(c.a + 0.4, "click", 0.46);
    sfx(c.a + 2.0, "pop", 0.52);
    sfx(c.a + 3.8, "blip", 0.5);
    sfx(c.a + 5.6, "ding", 0.56);
    sfx(c.a + 7.6, "chime", 0.54);

    const padX = Math.max(168 * uS, z.x + 36 * uS);
    const header = el(
      root,
      `left:${px(padX)};top:${px(106 * uS)};right:${px(padX)};z-index:8`,
    );
    const kicker = h("div", "", header, "ARCHITECTURE · ONE SLACK WORKSPACE TO HARDWARE PROOF");
    kicker.style.cssText = `font-family:var(--mono);font-size:${px(21 * uS)};font-weight:700;letter-spacing:0.08em;color:${STUDIO_TERRA}`;
    const title = h("div", "", header, "Agent swaps execute on-chain behind Intel TDX caps");
    title.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(48 * uS)};letter-spacing:-0.03em;color:${STUDIO_INK};margin-top:${px(8 * uS)};white-space:nowrap`;

    // Problem -> Solution Contrast Pills
    const contrastRow = el(
      root,
      `left:${px(padX)};right:${px(padX)};top:${px(262 * uS)};display:flex;gap:${px(20 * uS)};z-index:8`,
    );
    const contrasts = [
      { bad: "Split terminal bots", good: "Shared #near-intents-arena Slack" },
      { bad: "Unbounded private keys", good: "$25 OutLayer Intel TDX policy cap" },
      { bad: "Opaque agent black box", good: "NIST FIPS 204 ML-DSA-65 proof" },
    ];
    const contrastCards = contrasts.map((ct) => {
      const card = h("div", "", contrastRow);
      card.style.cssText = `flex:1;padding:${px(18 * uS)} ${px(22 * uS)};border-radius:${px(18 * uS)};background:${OBSIDIAN_SURFACE};box-shadow:0 ${px(16 * uS)} ${px(40 * uS)} rgba(18,21,28,0.16);border:1px solid rgba(255,255,255,0.08)`;
      const top = h("div", "", card, esc(ct.bad));
      top.style.cssText = `font-family:var(--mono);font-size:${px(19 * uS)};font-weight:500;color:${DARK_CORAL};text-decoration:line-through`;
      const bot = h("div", "", card, esc(ct.good));
      bot.style.cssText = `font-family:var(--sans);font-size:${px(26 * uS)};font-weight:700;color:${DARK_FG};margin-top:${px(8 * uS)}`;
      return card;
    });

    // Cutline SVG Flow Connectors + 4 Node Cards
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${c.W} ${c.H}`);
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:6;pointer-events:none";
    root.appendChild(svg);

    const nodeW = 356 * uS;
    const nodeH = 330 * uS;
    const nodeTop = 436 * uS;
    const totalW = c.W - 2 * padX;
    const gap = (totalW - 4 * nodeW) / 3;
    const nodeCentersX = [0, 1, 2, 3].map((i) => padX + i * (nodeW + gap) + nodeW * 0.5);

    const beamLines = [0, 1, 2].map((i) => {
      const x1 = padX + i * (nodeW + gap) + nodeW;
      const x2 = padX + (i + 1) * (nodeW + gap);
      const ym = nodeTop + nodeH * 0.5;
      const bgLine = document.createElementNS(svgNS, "line");
      bgLine.setAttribute("x1", x1.toFixed(1));
      bgLine.setAttribute("y1", ym.toFixed(1));
      bgLine.setAttribute("x2", x2.toFixed(1));
      bgLine.setAttribute("y2", ym.toFixed(1));
      bgLine.setAttribute("stroke", "#C8C1B4");
      bgLine.setAttribute("stroke-width", (6 * uS).toFixed(1));
      bgLine.setAttribute("stroke-linecap", "round");
      svg.appendChild(bgLine);

      const activeLine = document.createElementNS(svgNS, "line");
      activeLine.setAttribute("x1", x1.toFixed(1));
      activeLine.setAttribute("y1", ym.toFixed(1));
      activeLine.setAttribute("x2", x1.toFixed(1));
      activeLine.setAttribute("y2", ym.toFixed(1));
      activeLine.setAttribute("stroke", "#067A4B");
      activeLine.setAttribute("stroke-width", (8 * uS).toFixed(1));
      activeLine.setAttribute("stroke-linecap", "round");
      svg.appendChild(activeLine);

      const dot = document.createElementNS(svgNS, "circle");
      dot.setAttribute("cx", x1.toFixed(1));
      dot.setAttribute("cy", ym.toFixed(1));
      dot.setAttribute("r", (11 * uS).toFixed(1));
      dot.setAttribute("fill", "#BE3A1A");
      dot.style.opacity = "0";
      svg.appendChild(dot);

      return { x1, x2, ym, activeLine, dot };
    });

    const nodesMeta = [
      {
        step: "01 · TRIGGER",
        name: "@mention in Slack",
        detail: "1,250 USDC to wNEAR",
        badge: "#near-intents-arena",
        tone: DARK_EMERALD,
      },
      {
        step: "02 · AUCTION",
        name: "1Click Multi-Solver",
        detail: "367.731 wNEAR (4 bps)",
        badge: "wintermute.near",
        tone: DARK_SKY,
      },
      {
        step: "03 · ENCLAVE",
        name: "OutLayer Intel TDX",
        detail: "$12 Pass / $45 Block",
        badge: "$25 Per-Tx Cap",
        tone: DARK_AMBER,
      },
      {
        step: "04 · PROOF",
        name: "Post-Quantum Receipt",
        detail: "NIST FIPS 204 Verified",
        badge: "100% ML-DSA-65",
        tone: DARK_EMERALD,
      },
    ];

    const nodeCards = nodesMeta.map((n, i) => {
      const nx = nodeCentersX[i]! - nodeW * 0.5;
      const card = el(
        root,
        `left:${px(nx)};top:${px(nodeTop)};width:${px(nodeW)};height:${px(nodeH)};border-radius:${px(24 * uS)};padding:${px(26 * uS)};background:${OBSIDIAN_SURFACE};box-shadow:0 ${px(26 * uS)} ${px(56 * uS)} rgba(18,21,28,0.22);display:flex;flex-direction:column;justify-content:space-between;z-index:8;border:${px(2.5 * uS)} solid rgba(255,255,255,0.1)`,
      );
      const top = h("div", "", card);
      const st = h("div", "", top, esc(n.step));
      st.style.cssText = `font-family:var(--mono);font-size:${px(20 * uS)};font-weight:700;color:${n.tone};letter-spacing:0.06em`;
      const nm = h("div", "", top, esc(n.name));
      nm.style.cssText = `font-family:var(--sans);font-size:${px(34 * uS)};font-weight:800;color:${DARK_FG};line-height:1.15;margin-top:${px(14 * uS)}`;
      const dt = h("div", "", top, esc(n.detail));
      dt.style.cssText = `font-family:var(--sans);font-size:${px(26 * uS)};font-weight:600;color:${DARK_MUTED};margin-top:${px(12 * uS)}`;

      const pill = h("div", "", card, esc(n.badge));
      pill.style.cssText = `align-self:flex-start;font-family:var(--mono);font-size:${px(20 * uS)};font-weight:700;color:${OBSIDIAN_SURFACE};background:${n.tone};padding:${px(8 * uS)} ${px(16 * uS)};border-radius:999px`;
      return card;
    });

    const footerPill = el(
      root,
      `left:${px(padX)};top:${px(826 * uS)};padding:${px(14 * uS)} ${px(26 * uS)};border-radius:999px;background:${STUDIO_EMERALD};color:#FAF7F0;font-family:var(--mono);font-size:${px(22 * uS)};font-weight:700;box-shadow:0 ${px(14 * uS)} ${px(32 * uS)} rgba(6,122,75,0.25);z-index:8`,
      "DETERMINISTIC PIPELINE · SIGNED NEP-413 · ZERO PRIVATE KEY LEAKS",
    );

    return (u) => {
      drawBokeh(u);
      const outP = outro(u, c, 0.28);
      const hIn = fin(u, 0.04, 0.36);
      header.style.opacity = (hIn * outP).toFixed(3);
      header.style.transform = `translateY(${((1 - hIn) * 20 * uS).toFixed(1)}px)`;

      contrastCards.forEach((cc, i) => {
        const cp = fin(u, 0.25 + i * 0.14, 0.35);
        cc.style.opacity = (cp * outP).toFixed(3);
        cc.style.transform = `translateY(${((1 - cp) * 18 * uS).toFixed(1)}px)`;
      });

      // Sequential node illumination (ignites at 0.9s, 2.5s, 4.1s, 5.7s)
      const igniteTimes = [0.65, 2.3, 4.0, 5.7];
      nodeCards.forEach((card, i) => {
        const enterP = clamp(springSolve(u, 0.5 + i * 0.16, "snappy"), 0, 1.05);
        const lit = u >= igniteTimes[i]!;
        const glowPulse = lit ? clamp(prog(u, igniteTimes[i]!, 0.45)) : 0;
        card.style.opacity = (clamp((u - (0.45 + i * 0.16)) * 5) * outP).toFixed(3);
        card.style.transform = `translateY(${((1 - enterP) * 32 * uS - glowPulse * 8 * uS).toFixed(1)}px) scale(${(1 + glowPulse * 0.02).toFixed(4)})`;
        card.style.borderColor = lit ? nodesMeta[i]!.tone : "rgba(255,255,255,0.1)";
      });

      beamLines.forEach((b, i) => {
        const startT = igniteTimes[i]! + 0.5;
        const p = clamp(prog(u, startT, 1.1));
        const curX = lerp(b.x1, b.x2, ease.inOutCubic(p));
        b.activeLine.setAttribute("x2", curX.toFixed(1));
        b.activeLine.style.opacity = (p > 0.01 ? outP : 0).toFixed(3);
        b.dot.setAttribute("cx", curX.toFixed(1));
        b.dot.style.opacity = (p > 0.01 && p < 0.99 ? outP : 0).toFixed(3);
      });

      const fp = fin(u, 6.3, 0.4);
      footerPill.style.opacity = (fp * outP).toFixed(3);
      footerPill.style.transform = `translateY(${((1 - fp) * 16 * uS).toFixed(1)}px)`;
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Scene 4: Live Slack Workspace + 1Click Multi-Solver Auction Proof          */
/* -------------------------------------------------------------------------- */
export function buildSolverWorkspaceScene(mode: "full" | "teaser"): Builder {
  return (root, _s, c) => {
    const uS = c.u;
    const z = safe(c);
    const drawBokeh = mountStudioBackdrop(root, uS, 4.4);

    if (mode === "full") {
      sfx(c.a + 0.6, "pop", 0.48);
      sfx(c.a + 3.2, "blip", 0.5);
      sfx(c.a + 6.4, "shimmer", 0.46);
      sfx(c.a + 9.2, "ding", 0.52);
    } else {
      sfx(c.a + 0.5, "pop", 0.48);
      sfx(c.a + 2.8, "shimmer", 0.48);
    }

    const padX = Math.max(164 * uS, z.x + 32 * uS);
    const railW = 500 * uS;
    const rail = el(root, `left:${px(padX)};top:${px(116 * uS)};width:${px(railW)};z-index:8`);

    const kicker = h("div", "", rail, "01 · 1CLICK MULTI-SOLVER");
    kicker.style.cssText = `font-family:var(--mono);font-size:${px(20 * uS)};font-weight:700;letter-spacing:0.08em;color:${STUDIO_EMERALD}`;
    const title = h("div", "", rail, "Best solver quotes inside Slack");
    title.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(50 * uS)};line-height:1.1;letter-spacing:-0.03em;color:${STUDIO_INK};margin-top:${px(10 * uS)}`;
    const copy = h(
      "div",
      "",
      rail,
      "Mention @kronos or @ada in #near-intents-arena to race live market makers.",
    );
    copy.style.cssText = `font-family:var(--sans);font-weight:500;font-size:${px(26 * uS)};line-height:1.32;color:${STUDIO_MUTED};margin-top:${px(14 * uS)}`;

    const metrics = [
      { k: "LIVE DRY QUOTE", v: "367.731 wNEAR", s: "Input 1,250 USDC via 1Click", bg: OBSIDIAN_SURFACE, fg: DARK_EMERALD },
      { k: "WINNING SOLVER", v: "354.18 wNEAR", s: "wintermute.near · 4 bps spread", bg: OBSIDIAN_SURFACE, fg: DARK_SKY },
      { k: "BLOCK + RECEIPT", v: "277,602,026", s: "16 bps edge · 22s finality", bg: STUDIO_EMERALD, fg: "#FAF7F0" },
    ];
    const cards = metrics.map((m, idx) => {
      const card = el(
        root,
        `left:${px(padX)};top:${px((460 + idx * 140) * uS)};width:${px(railW)};padding:${px(18 * uS)} ${px(22 * uS)};border-radius:${px(20 * uS)};background:${m.bg};box-shadow:0 ${px(20 * uS)} ${px(48 * uS)} rgba(18,21,28,0.18);z-index:8`,
      );
      const top = h("div", "", card, esc(m.k));
      top.style.cssText = `font-family:var(--mono);font-size:${px(18 * uS)};font-weight:700;letter-spacing:0.06em;color:${m.fg}`;
      const val = h("div", "", card, esc(m.v));
      val.style.cssText = `font-family:var(--sans);font-size:${px(34 * uS)};font-weight:800;color:#FAF7F0;margin-top:${px(4 * uS)}`;
      const sub = h("div", "", card, esc(m.s));
      sub.style.cssText = `font-family:var(--sans);font-size:${px(24 * uS)};font-weight:500;color:${idx === 2 ? "#FAF7F0" : DARK_MUTED};margin-top:${px(4 * uS)}`;
      return card;
    });

    // Right: Elevated obsidian browser showcasing shot-04 (Slack channel) and shot-06 (1Click solver card)
    const winX = padX + railW + 46 * uS;
    const winW = c.W - winX - padX;
    const winH = 640 * uS;
    const win = makeBrowserWindow(
      root,
      uS,
      { x: winX, y: 164 * uS, w: winW, h: winH },
      "agentes-near-production.up.railway.app/ocelli",
      "1Click Auction Live",
    );

    const slackShot = media("assets/shot-04-slack-channel.png");
    slackShot.el.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 62%;transform-origin:50% 68%`;
    win.body.appendChild(slackShot.el);

    const swapShot = media("assets/shot-06-1click-swap.png");
    swapShot.el.style.cssText = `position:absolute;left:0;bottom:0;width:100%;height:auto;transform-origin:50% 100%`;
    win.body.appendChild(swapShot.el);

    return (u) => {
      drawBokeh(u);
      const outP = outro(u, c, 0.28);
      const rIn = fin(u, 0.05, 0.36);
      rail.style.opacity = (rIn * outP).toFixed(3);
      rail.style.transform = `translateY(${((1 - rIn) * 20 * uS).toFixed(1)}px)`;

      cards.forEach((card, i) => {
        const sp = clamp(springSolve(u, 0.35 + i * 0.22, "snappy"), 0, 1.05);
        card.style.opacity = (clamp((u - (0.3 + i * 0.22)) * 5) * outP).toFixed(3);
        card.style.transform = `translateX(${((1 - sp) * -28 * uS).toFixed(1)}px)`;
      });

      const winIn = fin(u, 0.15, 0.45);
      win.frame.style.opacity = (winIn * outP).toFixed(3);
      win.frame.style.transform = `translateY(${((1 - winIn) * 28 * uS).toFixed(1)}px) scale(${(0.96 + 0.04 * winIn).toFixed(4)})`;

      if (mode === "full") {
        // Cross-reveal from Slack channel view (#near-intents-arena) into zoomed 1Click Solver Auction card
        const switchP = ease.inOutCubic(prog(u, 5.4, 0.85));
        const zoom1 = 1 + 0.16 * prog(u, 0.4, 5.4);
        const zoom2 = 1.14 + 0.06 * prog(u, 5.4, 8.6);
        slackShot.el.style.opacity = (1 - switchP).toFixed(3);
        slackShot.el.style.transform = `scale(${zoom1.toFixed(4)})`;
        swapShot.el.style.opacity = switchP.toFixed(3);
        swapShot.el.style.transform = `scale(${zoom2.toFixed(4)})`;
      } else {
        const zoom = 1.14 + 0.06 * prog(u, 0, c.len);
        slackShot.el.style.opacity = "0";
        swapShot.el.style.opacity = "1";
        swapShot.el.style.transform = `scale(${zoom.toFixed(4)})`;
      }
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Scene 5: OutLayer Intel TDX Hardware Spend Guard ($12 Pass vs $45 Blocked) */
/* -------------------------------------------------------------------------- */
export function buildOutlayerGuardScene(mode: "full" | "teaser"): Builder {
  return (root, _s, c) => {
    const uS = c.u;
    const z = safe(c);
    const drawBokeh = mountStudioBackdrop(root, uS, 6.1);

    if (mode === "full") {
      sfx(c.a + 0.5, "click", 0.46);
      sfx(c.a + 2.4, "chime", 0.52);
      sfx(c.a + 5.0, "impact", 0.62);
      sfx(c.a + 8.5, "blip", 0.5);
    } else {
      sfx(c.a + 0.5, "click", 0.48);
      sfx(c.a + 2.4, "impact", 0.6);
    }

    const padX = Math.max(164 * uS, z.x + 32 * uS);
    const railW = 500 * uS;
    const rail = el(root, `left:${px(padX)};top:${px(116 * uS)};width:${px(railW)};z-index:8`);

    const kicker = h("div", "", rail, "02 · SILICON ENCLAVE · OUTLAYER TDX");
    kicker.style.cssText = `font-family:var(--mono);font-size:${px(20 * uS)};font-weight:700;letter-spacing:0.08em;color:${STUDIO_TERRA}`;
    const title = h("div", "", rail, "$45 drains stopped in silicon");
    title.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(50 * uS)};line-height:1.1;letter-spacing:-0.03em;color:${STUDIO_INK};margin-top:${px(10 * uS)}`;
    const copy = h(
      "div",
      "",
      rail,
      "WASI hardware policy enforces spend caps outside model prompts.",
    );
    copy.style.cssText = `font-family:var(--sans);font-weight:500;font-size:${px(26 * uS)};line-height:1.32;color:${STUDIO_MUTED};margin-top:${px(14 * uS)}`;

    const verdicts = [
      {
        pill: "$12 SAFE INTENT · APPROVED",
        metric: "42 ms · 4,110 WASI fuel",
        note: "Signed with NEP-413 under $25 per-tx cap",
        bg: STUDIO_EMERALD,
        text: "#FAF7F0",
      },
      {
        pill: "$45 ROGUE DRAIN · BLOCKED",
        metric: "BLOCKED_PER_TX_CAP",
        note: "Rejected deterministically against $25 / $100 limits",
        bg: STUDIO_TERRA,
        text: "#FAF7F0",
      },
    ];
    const verdictCards = verdicts.map((v, idx) => {
      const card = el(
        root,
        `left:${px(padX)};top:${px((462 + idx * 198) * uS)};width:${px(railW)};padding:${px(24 * uS)};border-radius:${px(22 * uS)};background:${v.bg};box-shadow:0 ${px(22 * uS)} ${px(52 * uS)} rgba(18,21,28,0.22);z-index:8`,
      );
      const t1 = h("div", "", card, esc(v.pill));
      t1.style.cssText = `font-family:var(--mono);font-size:${px(20 * uS)};font-weight:700;letter-spacing:0.06em;color:${v.text}`;
      const t2 = h("div", "", card, esc(v.metric));
      t2.style.cssText = `font-family:var(--sans);font-size:${px(34 * uS)};font-weight:800;color:${v.text};margin-top:${px(6 * uS)}`;
      const t3 = h("div", "", card, esc(v.note));
      t3.style.cssText = `font-family:var(--sans);font-size:${px(25 * uS)};font-weight:500;color:${v.text};margin-top:${px(6 * uS)}`;
      return card;
    });

    const winX = padX + railW + 46 * uS;
    const winW = c.W - winX - padX;
    const winH = 740 * uS;
    const win = makeBrowserWindow(
      root,
      uS,
      { x: winX, y: 120 * uS, w: winW, h: winH },
      "agentes.near / OutLayer TEE Guard",
      "$25 Cap Enforced",
    );

    const guardShot = media("assets/shot-05-outlayer-guard.png");
    guardShot.el.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 45%;transform-origin:50% 56%`;
    win.body.appendChild(guardShot.el);

    return (u) => {
      drawBokeh(u);
      const outP = outro(u, c, 0.28);
      const rIn = fin(u, 0.05, 0.36);
      rail.style.opacity = (rIn * outP).toFixed(3);
      rail.style.transform = `translateY(${((1 - rIn) * 20 * uS).toFixed(1)}px)`;

      const timing = mode === "full" ? [0.45, 2.8] : [0.35, 1.8];
      verdictCards.forEach((card, i) => {
        const sp = clamp(springSolve(u, timing[i]!, "snappy"), 0, 1.05);
        card.style.opacity = (clamp((u - timing[i]!) * 5) * outP).toFixed(3);
        card.style.transform = `translateY(${((1 - sp) * 28 * uS).toFixed(1)}px)`;
      });

      const winIn = fin(u, 0.14, 0.45);
      win.frame.style.opacity = (winIn * outP).toFixed(3);
      win.frame.style.transform = `translateY(${((1 - winIn) * 28 * uS).toFixed(1)}px) scale(${(0.96 + 0.04 * winIn).toFixed(4)})`;

      const panP = ease.inOutCubic(prog(u, 0.6, Math.max(2, c.len - 1.2)));
      const zoom = 1.04 + 0.18 * panP;
      const panY = lerp(0, -18 * uS, panP);
      guardShot.el.style.transform = `translateY(${panY.toFixed(1)}px) scale(${zoom.toFixed(4)})`;
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Scene 6: Self-Funding H100 Compute & Conviction Markets                    */
/* -------------------------------------------------------------------------- */
export function buildEconomyArenaScene(): Builder {
  return (root, _s, c) => {
    const uS = c.u;
    const z = safe(c);
    const drawBokeh = mountStudioBackdrop(root, uS, 7.8);

    sfx(c.a + 0.6, "pop", 0.48);
    sfx(c.a + 3.4, "chime", 0.5);
    sfx(c.a + 6.8, "shimmer", 0.48);

    const padX = Math.max(164 * uS, z.x + 32 * uS);
    const header = el(root, `left:${px(padX)};right:${px(padX)};top:${px(108 * uS)};z-index:8`);
    const kicker = h("div", "", header, "03 · AGENT ECONOMY · CORPUS x402 + TERRACE CONVICTION");
    kicker.style.cssText = `font-family:var(--mono);font-size:${px(20 * uS)};font-weight:700;letter-spacing:0.08em;color:${STUDIO_EMERALD}`;
    const title = h("div", "", header, "Agents fund H100 compute and price accuracy live");
    title.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(54 * uS)};letter-spacing:-0.03em;color:${STUDIO_INK};margin-top:${px(6 * uS)}`;

    const win = makeBrowserWindow(
      root,
      uS,
      { x: padX, y: 244 * uS, w: 1030 * uS, h: 632 * uS },
      "agentes.near/ocelli · Terrace BACK / FADE Markets",
      "85% Arena Pool",
    );
    const arenaShot = media("assets/shot-02-ocelli-arcade.png");
    arenaShot.el.style.cssText = `position:absolute;left:0;bottom:0;width:100%;height:auto;transform-origin:50% 100%`;
    win.body.appendChild(arenaShot.el);

    const colX = padX + 1068 * uS;
    const colW = c.W - padX - colX;
    const stats = [
      { k: "CORPUS x402 COMPUTE", v: "$1.84 / hr", s: "Autonomous H100 TEE inference", bg: OBSIDIAN_SURFACE, fg: DARK_EMERALD },
      { k: "TERRACE CONVICTION", v: "85% BACK", s: "Burn-on-miss thesis markets", bg: OBSIDIAN_SURFACE, fg: DARK_SKY },
      { k: "RETAINER + FIPS 204", v: "$240 Retainer", s: "100% ML-DSA-65 verified ledger", bg: STUDIO_EMERALD, fg: "#FAF7F0" },
    ];
    const statEls = stats.map((st, idx) => {
      const card = el(
        root,
        `left:${px(colX)};top:${px((244 + idx * 218) * uS)};width:${px(colW)};height:${px(194 * uS)};padding:${px(24 * uS)};border-radius:${px(22 * uS)};background:${st.bg};box-shadow:0 ${px(22 * uS)} ${px(50 * uS)} rgba(18,21,28,0.2);display:flex;flex-direction:column;justify-content:center;z-index:8`,
      );
      const t1 = h("div", "", card, esc(st.k));
      t1.style.cssText = `font-family:var(--mono);font-size:${px(19 * uS)};font-weight:700;letter-spacing:0.06em;color:${st.fg}`;
      const t2 = h("div", "", card, esc(st.v));
      t2.style.cssText = `font-family:var(--sans);font-size:${px(42 * uS)};font-weight:800;color:#FAF7F0;margin-top:${px(6 * uS)}`;
      const t3 = h("div", "", card, esc(st.s));
      t3.style.cssText = `font-family:var(--sans);font-size:${px(25 * uS)};font-weight:500;color:${idx === 2 ? "#FAF7F0" : DARK_MUTED};margin-top:${px(6 * uS)}`;
      return card;
    });

    return (u) => {
      drawBokeh(u);
      const outP = outro(u, c, 0.28);
      const hIn = fin(u, 0.04, 0.36);
      header.style.opacity = (hIn * outP).toFixed(3);
      header.style.transform = `translateY(${((1 - hIn) * 18 * uS).toFixed(1)}px)`;

      const wIn = fin(u, 0.16, 0.42);
      win.frame.style.opacity = (wIn * outP).toFixed(3);
      win.frame.style.transform = `translateY(${((1 - wIn) * 26 * uS).toFixed(1)}px)`;
      arenaShot.el.style.transform = `scale(${(1.14 + 0.06 * prog(u, 0, c.len)).toFixed(4)})`;

      statEls.forEach((card, i) => {
        const sp = clamp(springSolve(u, 0.36 + i * 0.28, "snappy"), 0, 1.05);
        card.style.opacity = (clamp((u - (0.32 + i * 0.28)) * 5) * outP).toFixed(3);
        card.style.transform = `translateX(${((1 - sp) * 28 * uS).toFixed(1)}px)`;
      });
    };
  };
}

/* -------------------------------------------------------------------------- */
/* Scene 7: Proof Counters + Tactile Warm-Bone Lockup Finale                  */
/* -------------------------------------------------------------------------- */
export function buildFinaleLockupScene(mode: "full" | "teaser"): Builder {
  return (root, _s, c) => {
    const uS = c.u;
    const z = safe(c);
    const drawBokeh = mountStudioBackdrop(root, uS, 9.5);

    if (mode === "full") {
      sfx(c.a + 0.4, "pop", 0.5);
      sfx(c.a + 2.4, "ding", 0.52);
      sfx(c.a + 5.1, "chime", 0.58);
    } else {
      sfx(c.a + 0.4, "chime", 0.56);
      sfx(c.a + 2.6, "ding", 0.52);
    }

    const padX = Math.max(168 * uS, z.x + 36 * uS);

    // Proof grid stage (Full mode Act A: 0..4.9s)
    const proofStage = el(root, `inset:0;z-index:8;pointer-events:none`);
    const proofTitle = el(
      proofStage,
      `left:${px(padX)};top:${px(124 * uS)};font-family:var(--sans);font-weight:800;font-size:${px(60 * uS)};letter-spacing:-0.03em;color:${STUDIO_INK}`,
      "Measured across one verified NEAR runtime",
    );

    const kpis = [
      { n: 13, suffix: "", label: "NEAR Tracks Covered", tone: DARK_EMERALD },
      { n: 6, suffix: "", label: "AI Agents In One Slack", tone: DARK_SKY },
      { n: 8, suffix: "/8", label: "Live CLI Probes Passing", tone: DARK_AMBER },
      { n: 100, suffix: "%", label: "FIPS 204 PQ Verified", tone: DARK_EMERALD },
    ];
    const boxW = (c.W - 2 * padX - 3 * 24 * uS) / 4;
    const kpiBoxes = kpis.map((k, idx) => {
      const bx = padX + idx * (boxW + 24 * uS);
      const box = el(
        proofStage,
        `left:${px(bx)};top:${px(250 * uS)};width:${px(boxW)};height:${px(248 * uS)};padding:${px(32 * uS)} ${px(24 * uS)};border-radius:${px(24 * uS)};background:${OBSIDIAN_SURFACE};box-shadow:0 ${px(26 * uS)} ${px(60 * uS)} rgba(18,21,28,0.22);display:flex;flex-direction:column;justify-content:space-between`,
      );
      const numEl = h("div", "", box, "0");
      numEl.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(84 * uS)};line-height:1;font-variant-numeric:tabular-nums;color:${k.tone}`;
      const lbl = h("div", "", box, esc(k.label));
      lbl.style.cssText = `font-family:var(--sans);font-weight:600;font-size:${px(27 * uS)};line-height:1.25;color:${DARK_FG};margin-top:${px(18 * uS)}`;
      return { box, numEl, target: k.n, suffix: k.suffix };
    });

    const cliBar = el(
      proofStage,
      `left:${px(padX)};right:${px(padX)};top:${px(590 * uS)};padding:${px(28 * uS)} ${px(32 * uS)};border-radius:${px(22 * uS)};background:${OBSIDIAN_PANEL};box-shadow:0 ${px(22 * uS)} ${px(56 * uS)} rgba(18,21,28,0.2);font-family:var(--mono);font-size:${px(26 * uS)};font-weight:700;color:${DARK_EMERALD}`,
      "$ bun run check:near   ->   8/8 LIVE NEAR & OUTLAYER TDX PROBES PASS (42 ms)",
    );

    // Final Tactile Studio Lockup (Full mode 4.9..12.0s; Teaser 0..6.0s)
    const lockStage = el(root, `inset:0;z-index:9;pointer-events:none`);
    const lockSwitchAt = mode === "full" ? 4.9 : 0;

    const lockWrap = el(
      lockStage,
      `left:${px(padX)};right:${px(padX)};top:${px(228 * uS)};z-index:10`,
    );
    const brandRow = h("div", "", lockWrap);
    brandRow.style.cssText = `display:flex;align-items:center;gap:${px(20 * uS)}`;
    const logo = media("assets/agentes-logo.svg");
    logo.el.style.cssText = `width:${px(74 * uS)};height:${px(74 * uS)};border-radius:${px(18 * uS)};box-shadow:0 ${px(14 * uS)} ${px(32 * uS)} rgba(18,21,28,0.16)`;
    brandRow.appendChild(logo.el);
    const brandText = h("div", "", brandRow, "Agentes NEAR · MIT Open Source");
    brandText.style.cssText = `font-family:var(--mono);font-size:${px(24 * uS)};font-weight:700;letter-spacing:0.06em;color:${STUDIO_MUTED};text-transform:uppercase`;

    const lockLine1 = h("div", "", lockWrap, "Ship agent teams");
    lockLine1.style.cssText = `font-family:var(--sans);font-weight:800;font-size:${px(108 * uS)};line-height:1.08;letter-spacing:-0.04em;color:${STUDIO_INK};margin-top:${px(24 * uS)}`;

    const lockLine2 = h("div", "", lockWrap);
    lockLine2.style.cssText = `display:flex;align-items:center;gap:${px(22 * uS)};margin-top:${px(8 * uS)};font-family:var(--sans);font-weight:800;font-size:${px(108 * uS)};line-height:1.08;letter-spacing:-0.04em;color:${STUDIO_INK}`;
    h("span", "", lockLine2, "you can");
    const deployPill = h("span", "", lockLine2, "trust.");
    deployPill.style.cssText = `display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:${px(4 * uS)} ${px(50 * uS)} ${px(14 * uS)} ${px(50 * uS)};background:${STUDIO_EMERALD};color:#FAF7F0;box-shadow:0 ${px(20 * uS)} ${px(48 * uS)} rgba(6,122,75,0.28);transform-origin:left center`;

    const urlPill = el(
      lockWrap,
      `position:relative;display:inline-flex;margin-top:${px(44 * uS)};padding:${px(18 * uS)} ${px(34 * uS)};border-radius:${px(18 * uS)};background:${OBSIDIAN_SURFACE};color:${DARK_EMERALD};font-family:var(--mono);font-size:${px(28 * uS)};font-weight:700;box-shadow:0 ${px(18 * uS)} ${px(44 * uS)} rgba(18,21,28,0.2)`,
      "agentes-near-production.up.railway.app/ocelli",
    );

    return (u) => {
      drawBokeh(u);
      const outP = outro(u, c, 0.35);

      if (mode === "full") {
        const proofVis = u < lockSwitchAt + 0.3;
        proofStage.style.display = proofVis ? "" : "none";
        if (proofVis) {
          const pOut = u >= lockSwitchAt ? 1 - ease.inOutCubic(prog(u, lockSwitchAt, 0.3)) : 1;
          proofStage.style.opacity = (pOut * outP).toFixed(3);
          const tIn = fin(u, 0.04, 0.35);
          proofTitle.style.opacity = tIn.toFixed(3);
          kpiBoxes.forEach((k, idx) => {
            const kp = clamp(springSolve(u, 0.25 + idx * 0.14, "snappy"), 0, 1.04);
            const countP = ease.outCubic(prog(u, 0.25 + idx * 0.12, 1.2));
            k.numEl.textContent = `${Math.round(lerp(0, k.target, countP))}${k.suffix}`;
            k.box.style.opacity = clamp((u - (0.2 + idx * 0.12)) * 5).toFixed(3);
            k.box.style.transform = `translateY(${((1 - kp) * 30 * uS).toFixed(1)}px)`;
          });
          const cp = fin(u, 0.85, 0.45);
          cliBar.style.opacity = cp.toFixed(3);
          cliBar.style.transform = `translateY(${((1 - cp) * 20 * uS).toFixed(1)}px)`;
        }
      } else {
        proofStage.style.display = "none";
      }

      const lockActive = u >= lockSwitchAt - 0.05;
      lockStage.style.display = lockActive ? "" : "none";
      if (lockActive) {
        const lu = Math.max(0, u - lockSwitchAt);
        const lFade = mode === "full" ? prog(u, lockSwitchAt, 0.28) : fin(u, 0.02, 0.32);
        lockStage.style.opacity = (lFade * outP).toFixed(3);
        const lPhys = computeKineticEntrance(lu, 0.04, {
          springPreset: "snappy",
          startDistance: 36 * uS,
          duration: 0.5,
        });
        lockWrap.style.transform = `translateY(${lPhys.translateY.toFixed(1)}px)`;
        const pillPhys = computeAccentBadgePhysics(lu, 0.24, "bouncy");
        deployPill.style.transform = `scale(${pillPhys.scaleX.toFixed(4)}, ${pillPhys.scaleY.toFixed(4)})`;
        const up = fin(lu, 0.36, 0.38);
        urlPill.style.opacity = up.toFixed(3);
        urlPill.style.transform = `translateY(${((1 - up) * 18 * uS).toFixed(1)}px)`;
      }
    };
  };
}
