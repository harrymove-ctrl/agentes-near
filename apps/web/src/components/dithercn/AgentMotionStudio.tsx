import { useEffect, useMemo, useRef, useState } from "react";
import { DitherButton, DitherCard } from "./DitherPrimitives";

export type MotionTemplateId =
  | "things-moving"
  | "yapp-99k"
  | "cutline-flow"
  | "fitting-lookbook"
  | "ai-tool-graph"
  | "molote-parche"
  | "one-design-sting";

export type PaletteMode =
  | "preset"
  | "near-mint"
  | "cobalt-paper"
  | "zine-vermilion"
  | "violet-tomato";

export type StageMediaMode = "canvas" | "mp4";
export type Mp4FilmVariant = "demo-80s" | "teaser-45s";

export interface MotionChapterMeta {
  id: MotionTemplateId;
  chapterNum: string;
  name: string;
  tag: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  defaultBpm: number;
  defaultHeadline: string;
  directorNote: string;
  accentColor: string;
}

export const TOTAL_MASTER_DURATION_SEC = 80;

export const MOTION_PRESETS: MotionChapterMeta[] = [
  {
    id: "things-moving",
    chapterNum: "01",
    name: "Kinetic Hook",
    tag: "0-12s · 97 BPM Wave",
    startSec: 0,
    endSec: 12,
    durationSec: 12,
    defaultBpm: 97,
    defaultHeadline: "AGENTES NEAR / SLACK FOR TEAMS / & AI SWARMS.",
    directorNote:
      "@mira synced 97 BPM tone-on-tone wave rows, concentric rings, and 3-line Agentes NEAR lockup.",
    accentColor: "#00EC97",
  },
  {
    id: "yapp-99k",
    chapterNum: "02",
    name: "99K Intents Counter",
    tag: "12-20s · 104 BPM Viral",
    startSec: 12,
    endSec: 20,
    durationSec: 8,
    defaultBpm: 104,
    defaultHeadline: "We gave @ada a live NEAR wallet in Slack. Please act normal.",
    directorNote:
      "@mira staged the 99K Anton counter, 4.6s comic silence cut, and @ada OutLayer TDX Top reply.",
    accentColor: "#D81B78",
  },
  {
    id: "cutline-flow",
    chapterNum: "03",
    name: "1Click Flow Unfold",
    tag: "20-30s · 116 BPM Timeline",
    startSec: 20,
    endSec: 30,
    durationSec: 10,
    defaultBpm: 116,
    defaultHeadline: "Agentes 2.0 / released",
    directorNote:
      "@mira wired #near-intents-arena + 1Click + TDX Guard into AGENTES ENGINE and 3-track timeline.",
    accentColor: "#F2B01E",
  },
  {
    id: "fitting-lookbook",
    chapterNum: "04",
    name: "One Slack Lookbook",
    tag: "30-45s · 60fps Editorial",
    startSec: 30,
    endSec: 45,
    durationSec: 15,
    defaultBpm: 110,
    defaultHeadline: "One Slack. / Every agent.",
    directorNote:
      "@mira fanned 5 real Agentes NEAR UI plates, 3x2 agent swarm matrix, and 4 paper swatches.",
    accentColor: "#2E4BFF",
  },
  {
    id: "ai-tool-graph",
    chapterNum: "05",
    name: "AI Tool Graph",
    tag: "45-55s · 118 BPM Hub",
    startSec: 45,
    endSec: 55,
    durationSec: 10,
    defaultBpm: 118,
    defaultHeadline: "@ada: route 12 USDC -> wNEAR under $25 TDX cap & launch Motion Studio",
    directorNote:
      "@mira burst 5 glowing tool nodes from @ada Tool Hub with ML-DSA-65 signed live preview.",
    accentColor: "#4C82FF",
  },
  {
    id: "molote-parche",
    chapterNum: "06",
    name: "Enclave Zine Drop",
    tag: "55-67s · 120 BPM 12fps",
    startSec: 55,
    endSec: 67,
    durationSec: 12,
    defaultBpm: 120,
    defaultHeadline: "AGENTES NEAR · OUTLAYER TDX · S A F E",
    directorNote:
      "@mira quantized torn-paper collage to 12fps on-twos with embossed tape and $25/TX cap proof.",
    accentColor: "#F05A28",
  },
  {
    id: "one-design-sting",
    chapterNum: "07",
    name: "ONE Workspace Finale",
    tag: "67-80s · 108 BPM Lockup",
    startSec: 67,
    endSec: 80,
    durationSec: 13,
    defaultBpm: 108,
    defaultHeadline: "ONE workspace · AGENTES NEAR 2026",
    directorNote:
      "@mira animated the 'you' cursor morphing Channels + TEE Agents + Motion Studio into ONE.",
    accentColor: "#5B3FD6",
  },
];

const AUTO_DIRECT_PROMPTS: Array<{
  label: string;
  presetId: MotionTemplateId;
  bpm: number;
  palette: PaletteMode;
  headline: string;
  masterMode?: boolean;
}> = [
  {
    label: "Full 80s Agentes Master",
    presetId: "things-moving",
    bpm: 110,
    palette: "preset",
    headline: "AGENTES NEAR / SLACK FOR TEAMS / & AI SWARMS.",
    masterMode: true,
  },
  {
    label: "99K Viral Slack Wallet",
    presetId: "yapp-99k",
    bpm: 104,
    palette: "preset",
    headline: "We gave @ada a live NEAR wallet in Slack. Please act normal.",
  },
  {
    label: "1Click -> TDX Timeline",
    presetId: "cutline-flow",
    bpm: 116,
    palette: "preset",
    headline: "Agentes 2.0 / released",
  },
  {
    label: "One Slack Swarm Lookbook",
    presetId: "fitting-lookbook",
    bpm: 110,
    palette: "cobalt-paper",
    headline: "One Slack. / Every agent.",
  },
  {
    label: "OutLayer $25 Zine Drop",
    presetId: "molote-parche",
    bpm: 120,
    palette: "zine-vermilion",
    headline: "AGENTES NEAR · OUTLAYER TDX · S A F E",
  },
  {
    label: "ONE Workspace Finale",
    presetId: "one-design-sting",
    bpm: 108,
    palette: "violet-tomato",
    headline: "ONE workspace · AGENTES NEAR 2026",
  },
];

const PALETTE_THEMES: Record<
  Exclude<PaletteMode, "preset">,
  { bg: string; fg: string; accent: string; secondary: string; card: string }
> = {
  "near-mint": {
    bg: "#D8F8E8",
    fg: "#0B3B2B",
    accent: "#00A86B",
    secondary: "#FF2E93",
    card: "#F3FCF7",
  },
  "cobalt-paper": {
    bg: "#EEE9E0",
    fg: "#16233F",
    accent: "#2E4BFF",
    secondary: "#F3D36B",
    card: "#FAF7F2",
  },
  "zine-vermilion": {
    bg: "#F6F0E2",
    fg: "#1E1E1E",
    accent: "#F05A28",
    secondary: "#3BA55C",
    card: "#FFFFFF",
  },
  "violet-tomato": {
    bg: "#F5F3EE",
    fg: "#1E1E1E",
    accent: "#5B3FD6",
    secondary: "#E5483A",
    card: "#FFFFFF",
  },
};

const THINGS_MOVING_PALETTES = [
  { bg: "#D8F8E8", fg: "#00A86B", accent: "#FF2E93" },
  { bg: "#13294B", fg: "#74B3FF", accent: "#FF85B3" },
  { bg: "#FDF6E9", fg: "#F05A28", accent: "#0F766E" },
  { bg: "#1B4332", fg: "#A8F5C8", accent: "#FF6B9D" },
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

function easeOutBack(t: number): number {
  const c = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(c - 1, 3) + c1 * Math.pow(c - 1, 2);
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function resolveChapterAtMasterTime(masterSec: number): {
  chapter: MotionChapterMeta;
  localSec: number;
} {
  const safeMaster = Number.isFinite(masterSec)
    ? ((masterSec % TOTAL_MASTER_DURATION_SEC) + TOTAL_MASTER_DURATION_SEC) %
      TOTAL_MASTER_DURATION_SEC
    : 0;
  for (const ch of MOTION_PRESETS) {
    if (safeMaster >= ch.startSec && safeMaster < ch.endSec) {
      return { chapter: ch, localSec: Math.max(0, safeMaster - ch.startSec) };
    }
  }
  const first = MOTION_PRESETS[0]!;
  return { chapter: first, localSec: 0 };
}

/**
 * Melodic UK-Drill / Bounce Web Audio synthesizer:
 * 1) Sliding 808 sub-bass glides (smooth exponential portamento between root, fifth, and octave)
 * 2) Crisp triplet hi-hat rolls
 * 3) Snappy beat-3 rimshot / clap
 * 4) Warm Rhodes / synth chord stabs
 */
function playSynthBeat(ctx: AudioContext, beatIndex: number, template: MotionTemplateId) {
  const now = ctx.currentTime;
  const barStep = beatIndex % 8;

  // 1. Punchy Kick + Sliding 808 Sub-Bass Glide
  const kickOsc = ctx.createOscillator();
  const kickGain = ctx.createGain();
  kickOsc.type = "sine";
  kickOsc.frequency.setValueAtTime(148, now);
  kickOsc.frequency.exponentialRampToValueAtTime(46, now + 0.09);
  kickGain.gain.setValueAtTime(0.28, now);
  kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  kickOsc.connect(kickGain);
  kickGain.connect(ctx.destination);
  kickOsc.start(now);
  kickOsc.stop(now + 0.16);

  // Sliding 808 Sub-Bass with portamento glide into 5th / octave
  const bassNotes = [55.0, 55.0, 65.41, 73.42, 55.0, 82.41, 61.74, 49.0];
  const glideTargets = [110.0, 55.0, 98.0, 110.0, 73.42, 110.0, 82.41, 55.0];
  const rootHz = bassNotes[barStep] ?? 55.0;
  const targetHz = glideTargets[barStep] ?? 110.0;

  const subOsc = ctx.createOscillator();
  const subFilter = ctx.createBiquadFilter();
  const subGain = ctx.createGain();
  subOsc.type = "triangle";
  subFilter.type = "lowpass";
  subFilter.frequency.setValueAtTime(210, now);

  subOsc.frequency.setValueAtTime(rootHz, now);
  if (barStep % 2 === 1 || barStep === 6) {
    // Signature drill 808 pitch slide
    subOsc.frequency.setValueAtTime(rootHz, now + 0.08);
    subOsc.frequency.exponentialRampToValueAtTime(targetHz, now + 0.24);
  }

  subGain.gain.setValueAtTime(0.22, now);
  subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
  subOsc.connect(subFilter);
  subFilter.connect(subGain);
  subGain.connect(ctx.destination);
  subOsc.start(now);
  subOsc.stop(now + 0.35);

  // 2. Crisp UK-Drill Triplet Hi-Hat Rolls
  const hatOffsets = barStep % 2 === 1 ? [0, 0.075, 0.15, 0.225] : [0, 0.14];
  hatOffsets.forEach((offset, hi) => {
    const hatOsc = ctx.createOscillator();
    const hatFilter = ctx.createBiquadFilter();
    const hatGain = ctx.createGain();
    hatOsc.type = "square";
    hatOsc.frequency.setValueAtTime(6200 + hi * 450, now + offset);
    hatFilter.type = "highpass";
    hatFilter.frequency.setValueAtTime(5200, now + offset);
    const vel = hi === 0 ? 0.045 : 0.028;
    hatGain.gain.setValueAtTime(vel, now + offset);
    hatGain.gain.exponentialRampToValueAtTime(0.0008, now + offset + 0.038);
    hatOsc.connect(hatFilter);
    hatFilter.connect(hatGain);
    hatGain.connect(ctx.destination);
    hatOsc.start(now + offset);
    hatOsc.stop(now + offset + 0.042);
  });

  // 3. Snappy Drill Rimshot / Clap on Beat 3 and Syncopated Counter-Snare
  if (beatIndex % 2 === 1) {
    const rimOsc = ctx.createOscillator();
    const rimGain = ctx.createGain();
    rimOsc.type = "triangle";
    rimOsc.frequency.setValueAtTime(920, now);
    rimOsc.frequency.exponentialRampToValueAtTime(240, now + 0.045);
    rimGain.gain.setValueAtTime(0.14, now);
    rimGain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    rimOsc.connect(rimGain);
    rimGain.connect(ctx.destination);
    rimOsc.start(now);
    rimOsc.stop(now + 0.07);
  }

  // 4. Warm Melodic Rhodes / Synth Chord Stabs on Bar Downbeats
  if (beatIndex % 4 === 0) {
    const baseFreqs =
      template === "ai-tool-graph"
        ? [220, 261.63, 329.63, 392.0]
        : template === "molote-parche"
          ? [246.94, 293.66, 369.99, 440.0]
          : [220, 277.18, 329.63, 415.3];
    for (const freq of baseFreqs) {
      const pad = ctx.createOscillator();
      const padGain = ctx.createGain();
      pad.type = "sine";
      pad.frequency.setValueAtTime(freq, now);
      pad.frequency.exponentialRampToValueAtTime(freq * 1.003, now + 0.25);
      padGain.gain.setValueAtTime(0.042, now);
      padGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
      pad.connect(padGain);
      padGain.connect(ctx.destination);
      pad.start(now);
      pad.stop(now + 0.35);
    }
  }
}

function renderMotionFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  template: MotionTemplateId,
  timeSec: number,
  durationSec: number,
  bpm: number,
  headline: string,
  paletteMode: PaletteMode,
) {
  const safeTime = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 10;
  const beatDur = 60 / Math.max(60, bpm);
  const beatPos = safeTime / beatDur;
  const beatIndex = Math.max(0, Math.floor(beatPos));
  const beatFrac = beatPos - beatIndex;
  const pulse = Math.exp(-beatFrac * 5.2);
  const progress = clamp01(safeTime / safeDuration);

  const displayFont = `"Anton", "Impact", "Arial Narrow", sans-serif`;
  const serifFont = `"Instrument Serif", "Iowan Old Style", "Palatino", Georgia, serif`;
  const sansFont = `"Inter Tight", "Source Sans 3", system-ui, sans-serif`;
  const monoFont = `"JetBrains Mono", ui-monospace, monospace`;

  const override = paletteMode !== "preset" ? PALETTE_THEMES[paletteMode] : null;
  const safeHeadline = headline.trim() || "AGENTES NEAR";

  ctx.save();

  switch (template) {
    /* ------------------------------------------------------------------ */
    /* Chapter 1. Kinetic Hook (0-12s, 97 BPM Kinetic Wave + Rings)       */
    /* ------------------------------------------------------------------ */
    case "things-moving": {
      const pair =
        THINGS_MOVING_PALETTES[beatIndex % THINGS_MOVING_PALETTES.length] ??
        THINGS_MOVING_PALETTES[0]!;
      const bg = override ? override.bg : pair.bg;
      const fg = override ? override.fg : pair.fg;
      const accent = override ? override.accent : pair.accent;

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const wavePhrases = [
        "THINGS ARE MOVING · AGENTES NEAR",
        "YOUR TEAM + AI AGENTS · ONE SLACK",
        "OUTLAYER INTEL TDX · $25 SPEND CAP",
        "1CLICK MULTI-SOLVER · ZERO KEY LEAKS",
      ];

      if (progress < 0.44) {
        const rows = 7;
        const rowH = h / rows;
        ctx.font = `700 ${Math.round(rowH * 0.68)}px ${displayFont}`;
        ctx.textBaseline = "middle";
        const phrase =
          wavePhrases[beatIndex % wavePhrases.length] ??
          (safeHeadline.split("/")[0]?.trim() || "THINGS ARE MOVING · AGENTES NEAR");

        for (let r = 0; r < rows; r++) {
          const isAccent = r === 3;
          ctx.fillStyle = isAccent ? accent : fg;
          const dir = isAccent ? -1 : 1;
          const shift = ((safeTime * 165 * dir + r * 95) % 520) - 260;
          const yBase = (r + 0.5) * rowH;

          for (let c = -2; c <= 4; c++) {
            const x = c * 520 + shift;
            const waveY = Math.sin(x * 0.008 + safeTime * 4.2 + r * 0.6) * (12 + pulse * 10);
            ctx.fillText(phrase.toUpperCase(), x, yBase + waveY);
          }
        }
      } else if (progress < 0.74) {
        const cx = w / 2;
        const cy = h / 2;
        const ringText = "AGENTES · NEAR · SLACK · FOR · TEAMS · ";
        const radii = [110, 190, 275];

        ctx.font = `700 42px ${displayFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        radii.forEach((rad, ri) => {
          const spin = safeTime * (ri % 2 === 0 ? 0.85 : -0.72) + pulse * 0.08;
          const count = 20 + ri * 6;
          ctx.fillStyle = ri === 1 ? accent : fg;
          for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2 + spin;
            const ch = ringText[i % ringText.length] ?? "A";
            ctx.save();
            ctx.translate(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
            ctx.rotate(a + Math.PI / 2);
            ctx.fillText(ch, 0, 0);
            ctx.restore();
          }
        });
      } else {
        const rawParts = safeHeadline
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean);
        const lines = [
          rawParts[0] ?? "AGENTES NEAR",
          rawParts[1] ?? "SLACK FOR TEAMS",
          rawParts[2] ?? "& AI SWARMS.",
        ];
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const lineHeight = h / 3.4;

        lines.forEach((line, li) => {
          const localP = clamp01((progress - 0.74) / 0.22 - li * 0.14);
          const scale = easeOutBack(localP);
          ctx.save();
          ctx.translate(w / 2, h * 0.24 + li * lineHeight);
          ctx.scale(scale, scale);
          ctx.fillStyle = li === 1 ? accent : fg;
          ctx.font = `700 ${Math.round(h * 0.165)}px ${displayFont}`;
          ctx.fillText(line.toUpperCase(), 0, Math.sin(safeTime * 6 + li) * 4 * pulse);
          ctx.restore();
        });
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Chapter 2. 99K Intents Counter (12-20s, 104 BPM Agentes Slack)     */
    /* ------------------------------------------------------------------ */
    case "yapp-99k": {
      const bg = override ? override.bg : "#F7F7F2";
      const fg = override ? override.fg : "#161614";
      const magenta = override ? override.accent : "#D81B78";
      const green = override ? override.secondary : "#3DA35D";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = magenta;
      ctx.lineWidth = 4 + pulse * 6;
      ctx.strokeRect(18, 18, w - 36, h - 36);

      // Giant 99K Anton Intent Counter behind the Slack card
      const countVal = Math.round(99 * easeOutCubic(clamp01(progress / 0.72)));
      const counterScale = 1 + pulse * 0.06;
      ctx.save();
      ctx.translate(w / 2, h * 0.75);
      ctx.scale(counterScale, counterScale);
      ctx.fillStyle = magenta;
      ctx.font = `700 ${Math.round(h * 0.26)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${countVal}K INTENTS`, 0, 0);
      ctx.restore();

      // Agentes NEAR Slack Channel Card
      const cardW = w * 0.78;
      const cardH = h * 0.44;
      const cardX = (w - cardW) / 2;
      const cardY = h * 0.1;
      ctx.fillStyle = "#FFFFFF";
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = fg;
      ctx.stroke();

      // Avatar badge HP
      ctx.fillStyle = "#16233F";
      ctx.beginPath();
      ctx.arc(cardX + 52, cardY + 52, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 18px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("HP", cardX + 52, cardY + 52);

      ctx.textAlign = "left";
      ctx.fillStyle = fg;
      ctx.font = `700 21px ${sansFont}`;
      ctx.fillText("Harry Phan · @harry.near · #near-intents-arena", cardX + 92, cardY + 44);
      ctx.fillStyle = "#5A6065";
      ctx.font = `500 15px ${monoFont}`;
      ctx.fillText("Agentes NEAR Workspace · OutLayer Intel TDX Guard Active", cardX + 92, cardY + 70);

      // Typed post inside Slack card
      const postText =
        safeHeadline.length > 12
          ? safeHeadline
          : "We gave @ada a live NEAR wallet in Slack. Please act normal.";
      const typingProgress = clamp01(progress / 0.48);
      const visibleChars = Math.max(1, Math.floor(postText.length * typingProgress));
      const typed = postText.slice(0, visibleChars);
      ctx.fillStyle = fg;
      ctx.font = `600 26px ${sansFont}`;
      ctx.fillText(
        typed + (Math.floor(safeTime * 3) % 2 === 0 && typingProgress < 1 ? "|" : ""),
        cardX + 34,
        cardY + 136,
      );

      // Reaction pills inside Slack post
      const pills = ["⚡ 1Click 22s", "🛡️ $25 TDX Cap", "🔥 BACK +5 wNEAR"];
      pills.forEach((pText, pi) => {
        const px = cardX + 34 + pi * 188;
        const py = cardY + cardH - 48;
        ctx.fillStyle = "#F2EFE9";
        drawRoundedRect(ctx, px, py, 174, 32, 999);
        ctx.fill();
        ctx.fillStyle = fg;
        ctx.font = `600 13px ${monoFont}`;
        ctx.fillText(pText, px + 14, py + 17);
      });

      // @ada OutLayer TDX Top Reply Sticker Pop-in after 4.6s silence cut
      if (progress > 0.54) {
        const pop = easeOutBack((progress - 0.54) / 0.18);
        ctx.save();
        ctx.translate(w * 0.62, h * 0.54);
        ctx.rotate(-0.06);
        ctx.scale(pop, pop);
        ctx.fillStyle = green;
        drawRoundedRect(ctx, -250, -34, 500, 68, 999);
        ctx.fill();
        ctx.strokeStyle = "#161614";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = "#FFFFFF";
        ctx.font = `700 18px ${sansFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Top reply · @ada: Settled 12 USDC -> 3.40 wNEAR in 22s", 0, 0);
        ctx.restore();
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Chapter 3. 1Click Flow Unfold (20-30s, 116 BPM Agentes Engine)     */
    /* ------------------------------------------------------------------ */
    case "cutline-flow": {
      const bg = override ? override.bg : "#F2EEE5";
      const navy = override ? override.fg : "#16233F";
      const crimson = override ? override.accent : "#C2185B";
      const marigold = override ? override.secondary : "#F2B01E";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Giant cropped "SHIP" drifting behind on paper
      ctx.save();
      ctx.fillStyle = "rgba(22, 35, 63, 0.06)";
      ctx.font = `700 ${Math.round(h * 0.52)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("SHIP", w * 0.5 - safeTime * 12, h * 0.36);
      ctx.restore();

      const nodes = [
        { x: w * 0.16, y: h * 0.25, label: "#intents-arena" },
        { x: w * 0.41, y: h * 0.2, label: "1Click + TDX Guard" },
        { x: w * 0.66, y: h * 0.28, label: "AGENTES ENGINE" },
        { x: w * 0.86, y: h * 0.22, label: "DONE ✓ 22s" },
      ];

      for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i]!;
        const b = nodes[i + 1]!;
        const edgeP = clamp01((progress - i * 0.12) / 0.2);
        ctx.strokeStyle = edgeP >= 1 ? crimson : navy;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * edgeP, a.y + (b.y - a.y) * edgeP);
        ctx.stroke();
      }

      nodes.forEach((n, idx) => {
        const active = progress >= idx * 0.12;
        ctx.fillStyle = active ? (idx === 2 ? crimson : navy) : "#FFFFFF";
        drawRoundedRect(ctx, n.x - 88, n.y - 28, 176, 56, 12);
        ctx.fill();
        ctx.strokeStyle = navy;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = active ? "#FFFFFF" : navy;
        ctx.font = `700 15px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.label, n.x, n.y);
      });

      // Unfolded 3-track Agentes NEAR execution timeline below
      const unfold = easeOutCubic(clamp01((progress - 0.28) / 0.34));
      if (unfold > 0.02) {
        const edW = w * 0.84;
        const edH = h * 0.44 * unfold;
        const edX = (w - edW) / 2;
        const edY = h * 0.46;
        ctx.fillStyle = navy;
        drawRoundedRect(ctx, edX, edY, edW, edH, 16);
        ctx.fill();

        if (unfold > 0.5) {
          const tracks = [
            { name: "1CLK", desc: "1Click Solver Auction · 3.40 wNEAR", color: marigold, wRatio: 0.8 },
            { name: "TDX", desc: "OutLayer Intel TDX · $25 Cap Enforced", color: crimson, wRatio: 0.68 },
            { name: "PQ", desc: "Kyvera FIPS 204 ML-DSA-65 Receipt", color: "#00EC97", wRatio: 0.9 },
          ];
          tracks.forEach((tr, ti) => {
            const ty = edY + 34 + ti * 52;
            ctx.fillStyle = "#94A3B8";
            ctx.font = `700 13px ${monoFont}`;
            ctx.textAlign = "left";
            ctx.fillText(tr.name, edX + 22, ty + 16);

            ctx.fillStyle = tr.color;
            drawRoundedRect(ctx, edX + 94, ty, (edW - 134) * tr.wRatio, 30, 8);
            ctx.fill();

            ctx.fillStyle = "#081022";
            ctx.font = `700 12px ${monoFont}`;
            ctx.fillText(tr.desc, edX + 108, ty + 16);
          });

          const phX = edX + 94 + (edW - 134) * progress;
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(phX, edY + 18);
          ctx.lineTo(phX, edY + edH - 18);
          ctx.stroke();
        }
      }

      // v2.0 Stamp + "Agentes 2.0 / released"
      if (progress > 0.6) {
        const stP = easeOutBack((progress - 0.6) / 0.16);
        ctx.save();
        ctx.translate(w * 0.82, h * 0.78);
        ctx.rotate(-0.12);
        ctx.scale(stP, stP);
        ctx.fillStyle = marigold;
        drawRoundedRect(ctx, -96, -30, 192, 60, 12);
        ctx.fill();
        ctx.strokeStyle = navy;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = navy;
        ctx.font = `800 22px ${displayFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("AGENTES v2.0", 0, 0);
        ctx.restore();
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Chapter 4. One Slack Lookbook (30-45s, 60fps Agentes Swarm Grid)   */
    /* ------------------------------------------------------------------ */
    case "fitting-lookbook": {
      const bg = override ? override.bg : "#EEE9E0";
      const cobalt = override ? override.accent : "#2E4BFF";
      const butter = override ? override.secondary : "#F3D36B";
      const ink = override ? override.fg : "#141A29";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Left: Agentes NEAR Workspace Hero Card + 5 Paper Theme Swatches
      const cardX = w * 0.05;
      const cardY = h * 0.1;
      const cardW = w * 0.37;
      const cardH = h * 0.8;
      ctx.fillStyle = cobalt;
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
      ctx.fill();

      // Framed Workspace Screen Plate inside Cobalt Card
      ctx.fillStyle = "#0D1326";
      drawRoundedRect(ctx, cardX + 22, cardY + 28, cardW - 44, cardH * 0.54, 14);
      ctx.fill();
      ctx.strokeStyle = "#6EF7BE";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#6EF7BE";
      ctx.font = `700 13px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("#near-intents-arena · OUTLAYER $25 CAP", cardX + 36, cardY + 58);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 22px ${serifFont}`;
      ctx.fillText("One Slack. Every NEAR Agent.", cardX + 36, cardY + 96);

      ctx.fillStyle = "#A9C4FF";
      ctx.font = `500 13px ${monoFont}`;
      ctx.fillText("1Click Quote -> TDX Guard -> ML-DSA-65", cardX + 36, cardY + 132);
      ctx.fillText("Terrace BACK/FADE + Corpus x402 H100", cardX + 36, cardY + 158);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 22px ${sansFont}`;
      ctx.textAlign = "center";
      ctx.fillText(safeHeadline.slice(0, 28), cardX + cardW * 0.5, cardY + cardH - 86);

      // 5 paper backdrop swatches
      const swatches = ["#F3D36B", "#F4EFE6", "#D96B43", "#94B49F", "#8A9EB5"];
      swatches.forEach((sw, si) => {
        const sx = cardX + 42 + si * 56;
        const sy = cardY + cardH - 42;
        ctx.fillStyle = sw;
        ctx.beginPath();
        ctx.arc(sx, sy, si === beatIndex % 5 ? 16 + pulse * 3 : 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      // Right: 3x2 Autonomous NEAR Agent Roster Checkmark Matrix
      const agents = [
        { handle: "@ada", role: "Lead Strategist", plate: "1Click Intents" },
        { handle: "@kronos", role: "1Click Execution", plate: "Solver Auction" },
        { handle: "@theo", role: "OutLayer Guard", plate: "$25 TDX Enclave" },
        { handle: "@lia", role: "x402 Compute", plate: "H100 TEE Pool" },
        { handle: "@mira", role: "Motion Director", plate: "60fps Studio" },
        { handle: "@zen", role: "PQ Verifier", plate: "ML-DSA-65 Audit" },
      ];
      const gridX = w * 0.45;
      const gridY = h * 0.1;
      const cellW = w * 0.155;
      const cellH = h * 0.37;
      const cellColors = [butter, "#D8F8E8", "#F7E2D8", "#DDE7FF", "#E2ECE9", "#F5E9C9"];

      agents.forEach((ag, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const cx = gridX + col * (cellW + 14);
        const cy = gridY + row * (cellH + 18);
        const checked = progress > 0.1 + i * 0.11;

        ctx.fillStyle = cellColors[i] ?? butter;
        drawRoundedRect(ctx, cx, cy, cellW, cellH, 16);
        ctx.fill();
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.fillStyle = ink;
        ctx.font = `700 16px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText(ag.handle, cx + 14, cy + 32);

        ctx.font = `600 13px ${sansFont}`;
        ctx.fillText(ag.role, cx + 14, cy + 62);

        ctx.fillStyle = "#16233F";
        ctx.font = `600 11px ${monoFont}`;
        ctx.fillText(ag.plate, cx + 14, cy + cellH - 22);

        if (checked) {
          ctx.fillStyle = cobalt;
          ctx.beginPath();
          ctx.arc(cx + cellW - 22, cy + 26, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#FFFFFF";
          ctx.font = `700 13px ${sansFont}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("✓", cx + cellW - 22, cy + 26);
        }
      });
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Chapter 5. AI Tool Graph (45-55s, 118 BPM Dark @ada Tool Hub)      */
    /* ------------------------------------------------------------------ */
    case "ai-tool-graph": {
      const bg = override ? override.bg : "#0D1017";
      const accent = override ? override.accent : "#00EC97";
      const blue = override ? override.secondary : "#4C82FF";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = "rgba(168, 192, 240, 0.14)";
      for (let x = 24; x < w; x += 28) {
        for (let y = 24; y < h; y += 28) {
          ctx.fillRect(x, y, 1.5, 1.5);
        }
      }

      // Top assistant prompt bar
      ctx.fillStyle = "#161B28";
      drawRoundedRect(ctx, w * 0.12, 26, w * 0.76, 48, 999);
      ctx.fill();
      ctx.strokeStyle = "rgba(0, 236, 151, 0.35)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#E2ECFF";
      ctx.font = `600 14px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`> ${safeHeadline.slice(0, 68)}`, w * 0.5, 50);

      const hub = { x: w * 0.34, y: h * 0.55 };
      const tools = [
        { x: w * 0.14, y: h * 0.32, label: "[Motion Studio]" },
        { x: w * 0.14, y: h * 0.74, label: "[1Click Swap]" },
        { x: w * 0.52, y: h * 0.28, label: "[OutLayer TDX]" },
        { x: w * 0.54, y: h * 0.78, label: "[Terrace Bet]" },
        { x: w * 0.34, y: h * 0.86, label: "[x402 Compute]" },
      ];

      tools.forEach((tl, ti) => {
        ctx.strokeStyle = ti === beatIndex % tools.length ? accent : "rgba(76, 130, 255, 0.45)";
        ctx.lineWidth = ti === beatIndex % tools.length ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(hub.x, hub.y);
        ctx.lineTo(tl.x, tl.y);
        ctx.stroke();

        const pktT = (safeTime * 0.9 + ti * 0.21) % 1;
        const px = hub.x + (tl.x - hub.x) * pktT;
        const py = hub.y + (tl.y - hub.y) * pktT;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#151C2B";
        drawRoundedRect(ctx, tl.x - 76, tl.y - 20, 152, 40, 10);
        ctx.fill();
        ctx.strokeStyle = ti === beatIndex % tools.length ? accent : blue;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = "#F4F6FB";
        ctx.font = `600 13px ${monoFont}`;
        ctx.fillText(tl.label, tl.x, tl.y);
      });

      // Central @ada Tool Hub
      ctx.fillStyle = blue;
      ctx.beginPath();
      ctx.arc(hub.x, hub.y, 46 + pulse * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 15px ${monoFont}`;
      ctx.fillText("@ada HUB", hub.x, hub.y);

      // Right Detailed Card with Agentes NEAR Telemetry & ML-DSA-65 SIGNED
      const cardP = easeOutCubic(clamp01((progress - 0.12) / 0.28));
      ctx.fillStyle = "#121826";
      drawRoundedRect(ctx, w * 0.62, h * 0.22, w * 0.33, h * 0.6 * cardP + 80, 18);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.font = `700 12px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("AGENTES NEAR · OUTLAYER TDX", w * 0.645, h * 0.29);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 20px ${sansFont}`;
      ctx.fillText("$12.00 Safe Intent -> APPROVED", w * 0.645, h * 0.4);
      ctx.fillStyle = "#F87171";
      ctx.fillText("$45.00 Drain -> BLOCKED ($25 Cap)", w * 0.645, h * 0.5);
      ctx.fillStyle = "#93B2FF";
      ctx.font = `600 13px ${monoFont}`;
      ctx.fillText("KYVERA: ML-DSA-65 SIGNED ✓", w * 0.645, h * 0.62);
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Chapter 6. Enclave Zine Drop (55-67s, 120 BPM · 12fps On-Twos)     */
    /* ------------------------------------------------------------------ */
    case "molote-parche": {
      const steppedTime = Math.floor(safeTime * 12) / 12;
      const stepBeat = Math.floor(steppedTime / beatDur);
      const vermilion = override ? override.accent : "#F05A28";
      const green = override ? override.secondary : "#3BA55C";
      const cream = override ? override.bg : "#F6F0E2";

      ctx.fillStyle = stepBeat % 2 === 0 ? cream : "#EFE6D2";
      ctx.fillRect(0, 0, w, h);

      // Torn paper collage blocks
      ctx.save();
      ctx.translate(w * 0.24, h * 0.5);
      ctx.rotate(stepBeat % 2 === 0 ? -0.06 : 0.04);
      ctx.fillStyle = vermilion;
      ctx.fillRect(-175, -180, 350, 360);
      ctx.restore();

      ctx.save();
      ctx.translate(w * 0.73, h * 0.52);
      ctx.rotate(stepBeat % 2 === 0 ? 0.05 : -0.04);
      ctx.fillStyle = green;
      ctx.fillRect(-175, -160, 350, 320);
      ctx.restore();

      // Embossed black label-maker tape strip
      ctx.save();
      ctx.translate(w * 0.5, h * 0.22);
      ctx.rotate(-0.02);
      ctx.fillStyle = "#141414";
      ctx.fillRect(-290, -26, 580, 52);
      ctx.fillStyle = "#F6F0E2";
      ctx.font = `700 20px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("AGENTES NEAR · OUTLAYER TDX · $25/TX CAP", 0, 0);
      ctx.restore();

      // Cut-paper S A F E letters
      const letters = ["S", "A", "F", "E"];
      letters.forEach((lt, li) => {
        const lx = w * 0.28 + li * (w * 0.145);
        const ly = h * 0.53 + ((li + stepBeat) % 2 === 0 ? -12 : 12);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate((li % 2 === 0 ? 1 : -1) * 0.08 + ((stepBeat % 3) - 1) * 0.04);
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(-52, -62, 104, 124);
        ctx.strokeStyle = "#141414";
        ctx.lineWidth = 4;
        ctx.strokeRect(-52, -62, 104, 124);
        ctx.fillStyle = "#141414";
        ctx.font = `700 76px ${displayFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lt, 0, 4);
        ctx.restore();
      });

      // Bottom zine badge: Zero key leaks · 13 NEAR TRACKS
      ctx.fillStyle = "#141414";
      drawRoundedRect(ctx, w * 0.26, h * 0.8, w * 0.48, 46, 999);
      ctx.fill();
      ctx.fillStyle = cream;
      ctx.font = `700 17px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("ZERO KEY LEAKS · DROP v2.0 · 13 NEAR TRACKS", w * 0.5, h * 0.8 + 23);
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Chapter 7. ONE Workspace Finale (67-80s, 108 BPM Grand Lockup)     */
    /* ------------------------------------------------------------------ */
    case "one-design-sting": {
      const stone = override ? override.bg : "#F5F3EE";
      const charcoal = override ? override.fg : "#1E1E1E";
      const violet = override ? override.accent : "#5B3FD6";
      const tomato = override ? override.secondary : "#E5483A";

      ctx.fillStyle = stone;
      ctx.fillRect(0, 0, w, h);

      const morphP = easeOutCubic(clamp01(progress / 0.52));

      // Floating geometric primitives (Channels, TEE Agents, Motion Studio) converging
      const spread = (1 - morphP) * 180;
      ctx.fillStyle = "rgba(91, 63, 214, 0.16)";
      ctx.beginPath();
      ctx.arc(w * 0.5 - spread, h * 0.34, 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(229, 72, 58, 0.16)";
      ctx.fillRect(w * 0.5 + spread - 40, h * 0.34 - 40, 80, 80);

      ctx.fillStyle = charcoal;
      ctx.font = `700 ${Math.round(h * 0.26)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("ONE", w * 0.5, h * 0.44);

      ctx.fillStyle = violet;
      ctx.font = `italic 500 ${Math.round(h * 0.13)}px ${serifFont}`;
      ctx.fillText("workspace", w * 0.5, h * 0.65);

      ctx.fillStyle = charcoal;
      ctx.font = `600 16px ${monoFont}`;
      ctx.fillText("Channels  +  OutLayer TEE Agents  +  Motion Studio", w * 0.5, h * 0.82);

      // Animated "you" cursor dragging into ONE
      const cx = w * (0.24 + morphP * 0.52);
      const cy = h * (0.3 + Math.sin(morphP * Math.PI * 2) * 0.14);
      ctx.fillStyle = tomato;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + 18, cy + 12);
      ctx.lineTo(cx + 6, cy + 20);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = charcoal;
      drawRoundedRect(ctx, cx + 14, cy + 16, 48, 24, 999);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 12px ${monoFont}`;
      ctx.fillText("you", cx + 38, cy + 28);

      // Phase B: Tomato wipe to Violet Grand Finale Lockup
      if (progress > 0.56) {
        const wipe = easeOutCubic((progress - 0.56) / 0.18);
        ctx.fillStyle = tomato;
        ctx.fillRect(0, 0, w * wipe, h);

        if (progress > 0.68) {
          const lockWipe = easeOutCubic((progress - 0.68) / 0.18);
          ctx.fillStyle = violet;
          ctx.fillRect(0, 0, w * lockWipe, h);
          if (lockWipe > 0.45) {
            ctx.fillStyle = "#FFFFFF";
            ctx.font = `700 ${Math.round(h * 0.11)}px ${displayFont}`;
            ctx.fillText("ONE WORKSPACE · AGENTES NEAR 2026", w * 0.5, h * 0.38);
            ctx.font = `italic 500 34px ${serifFont}`;
            ctx.fillText("Slack for Teams & Autonomous NEAR Swarms", w * 0.5, h * 0.55);
            ctx.fillStyle = "#00EC97";
            ctx.font = `700 16px ${monoFont}`;
            ctx.fillText(
              "agentes.near · /ocelli · github.com/harrymove-ctrl/agentes-near",
              w * 0.5,
              h * 0.72,
            );
          }
        }
      }
      break;
    }
  }

  ctx.restore();
}

export function AgentMotionStudio() {
  // Default to Unified 80s 7-Chapter Product Film Mode (`unified-master`)
  const [masterMode, setMasterMode] = useState<boolean>(true);
  const [stageMode, setStageMode] = useState<StageMediaMode>("canvas");
  const [mp4Variant, setMp4Variant] = useState<Mp4FilmVariant>("demo-80s");
  const [videoError, setVideoError] = useState<boolean>(false);

  const [templateId, setTemplateId] = useState<MotionTemplateId>("things-moving");
  const [masterTimeSec, setMasterTimeSec] = useState<number>(0);
  const [soloTimeSec, setSoloTimeSec] = useState<number>(0);

  const activeChapter = useMemo(() => {
    if (masterMode) {
      return resolveChapterAtMasterTime(masterTimeSec).chapter;
    }
    return MOTION_PRESETS.find((p) => p.id === templateId) ?? MOTION_PRESETS[0]!;
  }, [masterMode, masterTimeSec, templateId]);

  const [isPlaying, setIsPlaying] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [bpm, setBpm] = useState(MOTION_PRESETS[0]!.defaultBpm);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("preset");
  const [headline, setHeadline] = useState(MOTION_PRESETS[0]!.defaultHeadline);
  const [customHeadlineLocked, setCustomHeadlineLocked] = useState(false);
  const [miraPrompt, setMiraPrompt] = useState("");
  const [directorNote, setDirectorNote] = useState(
    "Unified 80.0s Master Film active: playing Chapters 01 to 07 seamlessly across Agentes NEAR.",
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastBeatIndexRef = useRef(-1);
  const masterTimeRef = useRef(0);
  const soloTimeRef = useRef(0);
  const lastChapterIdRef = useRef<MotionTemplateId>("things-moving");

  // Jump to a specific chapter (works in both Unified 80s Master mode, Solo Loop mode, and MP4 mode)
  const selectPreset = (preset: MotionChapterMeta) => {
    setTemplateId(preset.id);
    lastChapterIdRef.current = preset.id;
    setBpm(preset.defaultBpm);
    if (!customHeadlineLocked) {
      setHeadline(preset.defaultHeadline);
    }
    setDirectorNote(preset.directorNote);
    masterTimeRef.current = preset.startSec;
    soloTimeRef.current = 0;
    lastBeatIndexRef.current = -1;
    setMasterTimeSec(preset.startSec);
    setSoloTimeSec(0);
    setIsPlaying(true);

    if (stageMode === "mp4" && videoRef.current) {
      try {
        videoRef.current.currentTime =
          mp4Variant === "demo-80s"
            ? preset.startSec
            : Math.min(44, (preset.startSec / TOTAL_MASTER_DURATION_SEC) * 45);
        void videoRef.current.play();
      } catch {
        // Ignore media seek errors before metadata loads
      }
    }
  };

  const applyAutoDirect = (item: (typeof AUTO_DIRECT_PROMPTS)[number]) => {
    const preset = MOTION_PRESETS.find((p) => p.id === item.presetId) ?? MOTION_PRESETS[0]!;
    const nextMaster = item.masterMode ?? true;
    setMasterMode(nextMaster);
    setTemplateId(preset.id);
    lastChapterIdRef.current = preset.id;
    setBpm(item.bpm);
    setPaletteMode(item.palette);
    setHeadline(item.headline);
    setCustomHeadlineLocked(false);
    setDirectorNote(
      `@mira Auto-Direct: "${item.label}" -> Ch ${preset.chapterNum} ${preset.name} @ ${item.bpm} BPM`,
    );
    masterTimeRef.current = preset.startSec;
    soloTimeRef.current = 0;
    lastBeatIndexRef.current = -1;
    setMasterTimeSec(preset.startSec);
    setSoloTimeSec(0);
    setIsPlaying(true);
  };

  const handleMiraPromptSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = miraPrompt.trim();
    if (!raw) return;
    const lower = raw.toLowerCase();

    let targetChapter = activeChapter;
    if (lower.includes("99k") || lower.includes("viral") || lower.includes("wallet")) {
      targetChapter = MOTION_PRESETS[1]!;
    } else if (lower.includes("1click") || lower.includes("timeline") || lower.includes("solver")) {
      targetChapter = MOTION_PRESETS[2]!;
    } else if (lower.includes("lookbook") || lower.includes("swarm") || lower.includes("roster")) {
      targetChapter = MOTION_PRESETS[3]!;
    } else if (lower.includes("graph") || lower.includes("hub") || lower.includes("tool")) {
      targetChapter = MOTION_PRESETS[4]!;
    } else if (
      lower.includes("zine") ||
      lower.includes("tdx") ||
      lower.includes("enclave") ||
      lower.includes("$25") ||
      lower.includes("safe")
    ) {
      targetChapter = MOTION_PRESETS[5]!;
    } else if (lower.includes("finale") || lower.includes("one") || lower.includes("lockup")) {
      targetChapter = MOTION_PRESETS[6]!;
    } else if (lower.includes("hook") || lower.includes("wave") || lower.includes("moving")) {
      targetChapter = MOTION_PRESETS[0]!;
    }

    let nextPalette: PaletteMode = paletteMode;
    if (lower.includes("mint") || lower.includes("green")) nextPalette = "near-mint";
    else if (lower.includes("cobalt") || lower.includes("blue")) nextPalette = "cobalt-paper";
    else if (lower.includes("zine") || lower.includes("orange")) nextPalette = "zine-vermilion";
    else if (lower.includes("violet") || lower.includes("purple")) nextPalette = "violet-tomato";

    const bpmMatch = raw.match(/\b(9\d|1[0-3]\d)\s*bpm\b/i);
    const nextBpm = bpmMatch ? Number(bpmMatch[1]) : targetChapter.defaultBpm;

    setTemplateId(targetChapter.id);
    lastChapterIdRef.current = targetChapter.id;
    setBpm(nextBpm);
    setPaletteMode(nextPalette);
    setHeadline(raw);
    setCustomHeadlineLocked(true);
    masterTimeRef.current = targetChapter.startSec;
    soloTimeRef.current = 0;
    setMasterTimeSec(targetChapter.startSec);
    setSoloTimeSec(0);
    setIsPlaying(true);
    setDirectorNote(
      `@mira directed Ch ${targetChapter.chapterNum} (${targetChapter.name}) @ ${nextBpm} BPM: "${raw}"`,
    );
    setMiraPrompt("");
  };

  const toggleSound = () => {
    if (!soundOn) {
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!audioCtxRef.current && AudioCtx) {
          audioCtxRef.current = new AudioCtx();
        }
        if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
          void audioCtxRef.current.resume();
        }
        setSoundOn(true);
      } catch {
        setSoundOn(false);
      }
    } else {
      setSoundOn(false);
    }
  };

  useEffect(() => {
    if (stageMode !== "canvas") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = 960;
    const height = 540;
    canvas.width = width;
    canvas.height = height;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let lastNow = performance.now();

    const drawFrameAtCurrentState = () => {
      if (masterMode) {
        const { chapter, localSec } = resolveChapterAtMasterTime(masterTimeRef.current);
        const chapterHeadline = customHeadlineLocked ? headline : chapter.defaultHeadline;
        const chapterBpm = chapter.defaultBpm;
        renderMotionFrame(
          ctx,
          width,
          height,
          chapter.id,
          localSec,
          chapter.durationSec,
          chapterBpm,
          chapterHeadline,
          paletteMode,
        );
      } else {
        const soloChapter =
          MOTION_PRESETS.find((p) => p.id === templateId) ?? MOTION_PRESETS[0]!;
        renderMotionFrame(
          ctx,
          width,
          height,
          soloChapter.id,
          soloTimeRef.current,
          soloChapter.durationSec,
          bpm,
          headline,
          paletteMode,
        );
      }
    };

    const draw = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - lastNow) / 1000));
      lastNow = now;

      if (isPlaying && !reducedMotion) {
        if (masterMode) {
          const nextMaster =
            Math.max(0, masterTimeRef.current + dt) % TOTAL_MASTER_DURATION_SEC;
          masterTimeRef.current = nextMaster;
          setMasterTimeSec(nextMaster);

          const { chapter, localSec } = resolveChapterAtMasterTime(nextMaster);
          if (chapter.id !== lastChapterIdRef.current) {
            lastChapterIdRef.current = chapter.id;
            setTemplateId(chapter.id);
            setBpm(chapter.defaultBpm);
            if (!customHeadlineLocked) {
              setHeadline(chapter.defaultHeadline);
            }
            setDirectorNote(chapter.directorNote);
          }

          const beatIdx = Math.max(
            0,
            Math.floor(localSec / (60 / Math.max(60, chapter.defaultBpm))),
          );
          if (beatIdx !== lastBeatIndexRef.current) {
            lastBeatIndexRef.current = beatIdx;
            if (soundOn && audioCtxRef.current) {
              playSynthBeat(audioCtxRef.current, beatIdx, chapter.id);
            }
          }
        } else {
          const soloChapter =
            MOTION_PRESETS.find((p) => p.id === templateId) ?? MOTION_PRESETS[0]!;
          const nextSolo = Math.max(0, (soloTimeRef.current + dt) % soloChapter.durationSec);
          soloTimeRef.current = nextSolo;
          setSoloTimeSec(nextSolo);
          setMasterTimeSec(soloChapter.startSec + nextSolo);

          const beatIdx = Math.max(0, Math.floor(nextSolo / (60 / Math.max(60, bpm))));
          if (beatIdx !== lastBeatIndexRef.current) {
            lastBeatIndexRef.current = beatIdx;
            if (soundOn && audioCtxRef.current) {
              playSynthBeat(audioCtxRef.current, beatIdx, soloChapter.id);
            }
          }
        }
      }

      drawFrameAtCurrentState();

      if (isPlaying && !reducedMotion) {
        raf = window.requestAnimationFrame(draw);
      }
    };

    drawFrameAtCurrentState();

    if (isPlaying && !reducedMotion) {
      raf = window.requestAnimationFrame(draw);
    }

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [
    bpm,
    customHeadlineLocked,
    headline,
    isPlaying,
    masterMode,
    paletteMode,
    soundOn,
    stageMode,
    templateId,
  ]);

  const effectiveTimeSec = masterMode ? masterTimeSec : soloTimeSec;
  const effectiveDurationSec = masterMode
    ? TOTAL_MASTER_DURATION_SEC
    : activeChapter.durationSec;
  const beatNumber =
    Math.floor(
      (masterMode
        ? Math.max(0, masterTimeSec - activeChapter.startSec)
        : soloTimeSec) /
        (60 / Math.max(60, bpm)),
    ) + 1;

  const mp4Src =
    mp4Variant === "demo-80s"
      ? "/video/agentes-near-demo.mp4"
      : "/video/agentes-near-x-teaser.mp4";

  return (
    <div className="ams-studio" data-testid="agent-motion-studio">
      {/* Top Mode Bar: Interactive 60fps Agent Canvas vs Watch 1080p60 Master Film (MP4) */}
      <div className="ams-mode-bar">
        <div className="ams-mode-switch" role="tablist" aria-label="Motion Studio Stage Mode">
          <button
            type="button"
            role="tab"
            data-testid="ams-mode-canvas"
            className="ams-mode-btn"
            aria-selected={stageMode === "canvas"}
            onClick={() => setStageMode("canvas")}
          >
            Interactive 60fps Agent Canvas
          </button>
          <button
            type="button"
            role="tab"
            data-testid="ams-mode-mp4"
            className="ams-mode-btn"
            aria-selected={stageMode === "mp4"}
            onClick={() => {
              setVideoError(false);
              setStageMode("mp4");
            }}
          >
            Watch 1080p60 Master Film (MP4)
          </button>
        </div>

        <div className="ams-mode-meta">
          <button
            type="button"
            data-testid="ams-hero-sound-cta"
            className="ams-sound-hero-cta"
            aria-pressed={soundOn}
            onClick={() => {
              if (!soundOn) {
                toggleSound();
              } else {
                toggleSound();
              }
              setIsPlaying(true);
            }}
          >
            {soundOn ? "🔊 808 Drill Sound Active" : "▶ Play With 808 Drill Sound"}
          </button>

          {stageMode === "canvas" ? (
            <button
              type="button"
              data-testid="ams-loop-mode-toggle"
              className="ams-flow-pill"
              aria-pressed={masterMode}
              onClick={() => {
                const next = !masterMode;
                setMasterMode(next);
                if (next) {
                  masterTimeRef.current = activeChapter.startSec + soloTimeSec;
                  setMasterTimeSec(masterTimeRef.current);
                  setDirectorNote(
                    "Unified 80.0s Master Film active: playing Chapters 01 to 07 seamlessly.",
                  );
                } else {
                  soloTimeRef.current = Math.max(0, masterTimeSec - activeChapter.startSec);
                  setSoloTimeSec(soloTimeRef.current);
                  setDirectorNote(
                    `Solo Chapter Loop active: repeating Ch ${activeChapter.chapterNum} (${activeChapter.name}).`,
                  );
                }
              }}
            >
              {masterMode
                ? "Mode: Unified 80s Master Film (Ch 01-07)"
                : `Mode: Loop Ch ${activeChapter.chapterNum} (${activeChapter.name})`}
            </button>
          ) : (
            <div className="ams-mp4-variants">
              <button
                type="button"
                className="ams-flow-pill"
                aria-pressed={mp4Variant === "demo-80s"}
                onClick={() => {
                  setVideoError(false);
                  setMp4Variant("demo-80s");
                }}
              >
                80s Master Film (1080p60)
              </button>
              <button
                type="button"
                className="ams-flow-pill"
                aria-pressed={mp4Variant === "teaser-45s"}
                onClick={() => {
                  setVideoError(false);
                  setMp4Variant("teaser-45s");
                }}
              >
                45s X Teaser (1080p60)
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Interactive @mira AI Video Agent Composer + Auto-Direct Chips */}
      <div className="ams-autodirect">
        <form className="ams-mira-form" onSubmit={handleMiraPromptSubmit}>
          <span className="ams-autodirect__label">@mira AI Video Director:</span>
          <input
            type="text"
            data-testid="ams-mira-input"
            className="ams-mira-input"
            value={miraPrompt}
            onChange={(e) => setMiraPrompt(e.target.value)}
            placeholder="Prompt @mira to direct headline, chapter, BPM, or palette (e.g. 'OutLayer $25 TDX guard at 120 BPM zine')..."
            aria-label="Prompt @mira AI Video Director"
          />
          <button type="submit" data-testid="ams-mira-submit" className="ams-mira-submit">
            Direct Film -&gt;
          </button>
        </form>
        <div className="ams-autodirect__chips">
          {AUTO_DIRECT_PROMPTS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="ams-prompt-chip"
              aria-pressed={
                activeChapter.id === item.presetId &&
                headline === item.headline &&
                Boolean(item.masterMode) === masterMode
              }
              onClick={() => applyAutoDirect(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* 7-Chapter Master Timeline Bar (0..80s Continuous Visual Segment Scrubber) */}
      <div className="ams-master-timeline" data-testid="ams-master-timeline">
        <div className="ams-master-timeline__head">
          <span className="ams-master-timeline__title">
            80.0s UNIFIED MASTER TIMELINE · CH {activeChapter.chapterNum}{" "}
            {activeChapter.name.toUpperCase()}
          </span>
          <span className="ams-master-timeline__clock">
            {masterTimeSec.toFixed(1)}s / {TOTAL_MASTER_DURATION_SEC.toFixed(1)}s · Melodic Drill
            Score (-14 LUFS)
          </span>
        </div>
        <div className="ams-master-segments">
          {MOTION_PRESETS.map((ch) => {
            const isCurrent = activeChapter.id === ch.id;
            const fillPct =
              masterTimeSec <= ch.startSec
                ? 0
                : masterTimeSec >= ch.endSec
                  ? 100
                  : ((masterTimeSec - ch.startSec) / ch.durationSec) * 100;
            return (
              <button
                key={ch.id}
                type="button"
                className="ams-master-seg"
                data-active={isCurrent ? "true" : "false"}
                style={{ flexGrow: ch.durationSec }}
                onClick={() => selectPreset(ch)}
                title={`Jump to ${ch.chapterNum} ${ch.name} (${ch.startSec}s - ${ch.endSec}s)`}
              >
                <span
                  className="ams-master-seg__fill"
                  style={{
                    width: `${fillPct}%`,
                    backgroundColor: ch.accentColor,
                  }}
                />
                <span className="ams-master-seg__label">
                  <strong>{ch.chapterNum}</strong> {ch.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 7 Chapter Switcher Pills */}
      <div className="ams-presets" role="tablist" aria-label="7 Agentes NEAR Film Chapters">
        {MOTION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="tab"
            className="ams-preset-btn"
            aria-selected={activeChapter.id === preset.id}
            onClick={() => selectPreset(preset)}
          >
            <span className="ams-preset-num">{preset.chapterNum}</span>
            <span className="ams-preset-info">
              <strong>{preset.name}</strong>
              <small>{preset.tag}</small>
            </span>
          </button>
        ))}
      </div>

      {/* Main Stage + Controls */}
      <div className="ams-workspace">
        <div className="ams-canvas-wrap">
          {stageMode === "canvas" ? (
            <canvas
              ref={canvasRef}
              className="ams-canvas"
              aria-label={`${activeChapter.name} interactive motion preview`}
            />
          ) : (
            <div className="ams-video-stage">
              <video
                ref={videoRef}
                key={mp4Src}
                data-testid="ams-video-player"
                className="ams-canvas"
                controls
                playsInline
                preload="metadata"
                poster="/screenshots/motion-studio.png"
                src={mp4Src}
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  if (mp4Variant === "demo-80s") {
                    setMasterTimeSec(Math.min(TOTAL_MASTER_DURATION_SEC, t));
                  }
                }}
                onError={() => setVideoError(true)}
              />
              {videoError && (
                <div className="ams-video-fallback">
                  <p>
                    Master MP4 (`{mp4Src}`) is rendering or syncing to public assets. Switch to the{" "}
                    <strong>Interactive 60fps Agent Canvas</strong> above to preview all 7 chapters
                    live right now.
                  </p>
                  <DitherButton tone="mint" size="sm" onClick={() => setStageMode("canvas")}>
                    Return to Live 60fps Canvas
                  </DitherButton>
                </div>
              )}
            </div>
          )}

          <div className="ams-stage-meta">
            <span>
              Ch {activeChapter.chapterNum} {activeChapter.name} · Beat #{beatNumber} ({bpm} BPM)
            </span>
            <span>{directorNote}</span>
          </div>
        </div>

        <DitherCard tone="blue" padding="md" className="ams-controls">
          <div className="ams-ctrl-group">
            <label className="ams-ctrl-label" htmlFor="ams-headline-input">
              Live Headline / Agentes NEAR Copy
            </label>
            <input
              id="ams-headline-input"
              type="text"
              className="ams-input"
              value={headline}
              onChange={(e) => {
                setHeadline(e.target.value);
                setCustomHeadlineLocked(true);
              }}
              placeholder="AGENTES NEAR / SLACK FOR TEAMS"
            />
          </div>

          <div className="ams-ctrl-row">
            <div className="ams-ctrl-group" style={{ flex: 1 }}>
              <label className="ams-ctrl-label" htmlFor="ams-palette-select">
                Palette
              </label>
              <select
                id="ams-palette-select"
                className="ams-select"
                value={paletteMode}
                onChange={(e) => setPaletteMode(e.target.value as PaletteMode)}
              >
                <option value="preset">Chapter Native</option>
                <option value="near-mint">NEAR Mint (#00A86B)</option>
                <option value="cobalt-paper">Cobalt Editorial (#2E4BFF)</option>
                <option value="zine-vermilion">Paper Zine (#F05A28)</option>
                <option value="violet-tomato">Violet Tomato (#5B3FD6)</option>
              </select>
            </div>

            <div className="ams-ctrl-group" style={{ width: 120 }}>
              <label className="ams-ctrl-label" htmlFor="ams-bpm-select">
                Tempo (BPM)
              </label>
              <select
                id="ams-bpm-select"
                className="ams-select"
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
              >
                <option value={97}>97 BPM</option>
                <option value={104}>104 BPM</option>
                <option value={108}>108 BPM</option>
                <option value={110}>110 BPM</option>
                <option value={116}>116 BPM</option>
                <option value={118}>118 BPM</option>
                <option value={120}>120 BPM</option>
              </select>
            </div>
          </div>

          <div className="ams-ctrl-group">
            <div className="ams-scrub-head">
              <span className="ams-ctrl-label">
                {masterMode ? "80s Master Film Scrubber" : "Chapter Scrubber"}
              </span>
              <span className="ams-scrub-time">
                {effectiveTimeSec.toFixed(1)}s / {effectiveDurationSec.toFixed(1)}s
              </span>
            </div>
            <input
              type="range"
              aria-label="Motion timeline scrubber"
              className="ams-scrubber"
              min={0}
              max={effectiveDurationSec}
              step={0.05}
              value={effectiveTimeSec}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (masterMode) {
                  masterTimeRef.current = next;
                  setMasterTimeSec(next);
                  const { chapter } = resolveChapterAtMasterTime(next);
                  setTemplateId(chapter.id);
                } else {
                  soloTimeRef.current = next;
                  setSoloTimeSec(next);
                  setMasterTimeSec(activeChapter.startSec + next);
                }
                setIsPlaying(false);
              }}
            />
          </div>

          <div className="ams-btn-bar">
            <DitherButton tone="mint" size="sm" onClick={() => setIsPlaying((p) => !p)}>
              {isPlaying ? "Pause" : "Play"}
            </DitherButton>
            <DitherButton
              variant="secondary"
              size="sm"
              onClick={() => {
                masterTimeRef.current = masterMode ? 0 : activeChapter.startSec;
                soloTimeRef.current = 0;
                lastBeatIndexRef.current = -1;
                setMasterTimeSec(masterMode ? 0 : activeChapter.startSec);
                setSoloTimeSec(0);
                setIsPlaying(true);
              }}
            >
              Restart Film
            </DitherButton>
            <DitherButton
              variant={soundOn ? "primary" : "secondary"}
              tone={soundOn ? "purple" : "grey"}
              size="sm"
              onClick={toggleSound}
              data-testid="ams-sound-toggle"
            >
              {soundOn ? "808 Drill Synth On" : "Sound Muted"}
            </DitherButton>
          </div>
        </DitherCard>
      </div>
    </div>
  );
}
