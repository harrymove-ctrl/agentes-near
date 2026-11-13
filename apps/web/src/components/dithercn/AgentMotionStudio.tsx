import { useEffect, useMemo, useRef, useState } from "react";
import { DitherButton, DitherCard } from "./DitherPrimitives";

export type MotionTemplateId =
  | "things-moving"
  | "fitting-lookbook"
  | "cutline-flow"
  | "molote-parche"
  | "ai-tool-graph"
  | "yapp-99k"
  | "one-design-sting";

export type PaletteMode =
  | "preset"
  | "near-mint"
  | "cobalt-paper"
  | "zine-vermilion"
  | "violet-tomato";

export type StageMediaMode = "canvas" | "mp4";
export type Mp4FilmVariant = "demo-240s" | "teaser-60s";

export interface ChapterStepItem {
  num: "STEP 01" | "STEP 02" | "STEP 03";
  title: string;
  metric: string;
}

export interface MotionChapterMeta {
  id: MotionTemplateId;
  chapterNum: string;
  testId: string;
  name: string;
  tag: string;
  timeRangeLabel: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  defaultBpm: number;
  defaultHeadline: string;
  directorNote: string;
  accentColor: string;
  voiceActor: "ALEX · FOUNDER" | "@ada · 1CLICK QUANT" | "@kronos · OUTLAYER TDX" | "@mira · V-DRILL";
  voiceColor: string;
  steps: [ChapterStepItem, ChapterStepItem, ChapterStepItem];
  whatItIs: string;
  whyItHelps: string;
  voiceTranscript: string;
}

export const TOTAL_MASTER_DURATION_SEC = 240;

export const MOTION_PRESETS: MotionChapterMeta[] = [
  {
    id: "things-moving",
    chapterNum: "01",
    testId: "ams-chapter-01",
    name: "Problem & 99K Hook",
    tag: "0:00-0:34 · 97 BPM V-Drill",
    timeRangeLabel: "0:00-0:34",
    startSec: 0,
    endSec: 34,
    durationSec: 34,
    defaultBpm: 97,
    defaultHeadline: "AGENTES NEAR / SLACK FOR TEAMS / & AI SWARMS.",
    directorNote:
      "@mira V-Drill producer tag + Alex & Kronos staging the 3 fatal AI failures and 99K Intents hook.",
    accentColor: "#00EC97",
    voiceActor: "@mira · V-DRILL",
    voiceColor: "#EC4899",
    steps: [
      { num: "STEP 01", title: "3 Fatal AI Failures", metric: "Siloed Bots" },
      { num: "STEP 02", title: "Key Leak & Drain Risk", metric: "$0 Cap Guard" },
      { num: "STEP 03", title: "99K Intents in Slack", metric: "22s Settlement" },
    ],
    whatItIs: "Autonomous NEAR AI agents working side-by-side with your team in Slack.",
    whyItHelps: "Replaces fragmented terminal bots and raw private keys with one audited workspace.",
    voiceTranscript:
      "Agentes NEAR on the Viet-Drill beat: your team and 6 autonomous NEAR agents in one Slack workspace.",
  },
  {
    id: "fitting-lookbook",
    chapterNum: "02",
    testId: "ams-chapter-02",
    name: "One Slack + 6 Agents",
    tag: "0:34-1:10 · 110 BPM Lookbook",
    timeRangeLabel: "0:34-1:10",
    startSec: 34,
    endSec: 70,
    durationSec: 36,
    defaultBpm: 110,
    defaultHeadline: "One Slack. / Every agent.",
    directorNote:
      "Alex tours the 3-column Ocelli workspace, 6 autonomous TEE agents, and 1-click judge login.",
    accentColor: "#2E4BFF",
    voiceActor: "ALEX · FOUNDER",
    voiceColor: "#00EC97",
    steps: [
      { num: "STEP 01", title: "Ocelli 3-Col Workspace", metric: "Mainnet + TDX" },
      { num: "STEP 02", title: "6 Autonomous TEE Agents", metric: "@ada..@zen" },
      { num: "STEP 03", title: "1-Click Judge Login", metric: "Zero Passwords" },
    ],
    whatItIs: "A 3-column macOS Dark Glass Slack workspace with 6 specialized NEAR agents.",
    whyItHelps: "Judges and teams enter in 1 click and coordinate swaps, guards, and video live.",
    voiceTranscript:
      "One Slack, every agent: @ada, @kronos, @theo, @lia, @mira, and @zen coordinate in open channels.",
  },
  {
    id: "cutline-flow",
    chapterNum: "03",
    testId: "ams-chapter-03",
    name: "Step-by-Step 1Click Swaps",
    tag: "1:10-1:48 · 116 BPM Timeline",
    timeRangeLabel: "1:10-1:48",
    startSec: 70,
    endSec: 108,
    durationSec: 38,
    defaultBpm: 116,
    defaultHeadline: "1,250 USDC -> 358.1357 wNEAR (+16 bps)",
    directorNote:
      "@ada demonstrates live 1Click cross-chain solver auctions beating Wintermute by +16 bps.",
    accentColor: "#F2B01E",
    voiceActor: "@ada · 1CLICK QUANT",
    voiceColor: "#38BDF8",
    steps: [
      { num: "STEP 01", title: "Prompt @ada 1,250 USDC", metric: "#intents-arena" },
      { num: "STEP 02", title: "1Click Solver Auction", metric: "358.1357 wNEAR" },
      { num: "STEP 03", title: "22s Settlement + NEP-297", metric: "+16 bps Edge" },
    ],
    whatItIs: "Live NEAR Intents 1Click multi-solver auction routing directly from Slack.",
    whyItHelps: "Delivers best execution across competing market makers with NEP-297 receipts.",
    voiceTranscript:
      "@ada routes 1,250 USDC into 358.1357 wNEAR in 22 seconds, beating competing quotes by 16 bps.",
  },
  {
    id: "molote-parche",
    chapterNum: "04",
    testId: "ams-chapter-04",
    name: "Step-by-Step OutLayer TDX",
    tag: "1:48-2:28 · 120 BPM Zine",
    timeRangeLabel: "1:48-2:28",
    startSec: 108,
    endSec: 148,
    durationSec: 40,
    defaultBpm: 120,
    defaultHeadline: "OUTLAYER TDX · $25.00/TX CAP · S A F E",
    directorNote:
      "@kronos & @mira prove the $25.00/tx WASI policy: $12 approved in 4ms, $45 rogue drain blocked.",
    accentColor: "#F05A28",
    voiceActor: "@kronos · OUTLAYER TDX",
    voiceColor: "#F59E0B",
    steps: [
      { num: "STEP 01", title: "$25.00/tx WASI Guard", metric: "wasm32-wasip2" },
      { num: "STEP 02", title: "$12.00 NEP-413 Approve", metric: "4ms Enclave OK" },
      { num: "STEP 03", title: "$45.00 Drain Blocked", metric: "ML-DSA-65 Proof" },
    ],
    whatItIs: "Hardware-enforced $25.00 per-transaction ceiling inside Intel TDX enclaves.",
    whyItHelps: "Even a prompt-injected agent can never drain treasury funds above your slider cap.",
    voiceTranscript:
      "OutLayer Intel TDX approves the $12 intent in 4ms and deterministically blocks the $45 rogue drain.",
  },
  {
    id: "ai-tool-graph",
    chapterNum: "05",
    testId: "ams-chapter-05",
    name: "Step-by-Step Winner Mechanics",
    tag: "2:28-3:14 · 118 BPM Hub",
    timeRangeLabel: "2:28-3:14",
    startSec: 148,
    endSec: 194,
    durationSec: 46,
    defaultBpm: 118,
    defaultHeadline: "Corpus x402 ($1.84/hr) + Terrace BACK 76¢ + Kanmani",
    directorNote:
      "@ada walks through Corpus x402 H100 compute, Terrace conviction markets, and Kanmani escrow.",
    accentColor: "#4C82FF",
    voiceActor: "@ada · 1CLICK QUANT",
    voiceColor: "#38BDF8",
    steps: [
      { num: "STEP 01", title: "Corpus $250K Endowment", metric: "$1.84/hr H100" },
      { num: "STEP 02", title: "Terrace BACK YES 76¢", metric: "38,420 Burned" },
      { num: "STEP 03", title: "Kanmani + Tab + NEP-171", metric: "Level 7 NFT" },
    ],
    whatItIs: "Four Monad Metropolis winner clusters adapted natively to NEAR protocol rails.",
    whyItHelps: "Self-funds H100 TEE inference via x402 while rewarding accurate agent theses.",
    voiceTranscript:
      "Corpus streams $1.84/hr H100 TEE compute, Terrace burns 38,420 $AGENTES on misses, and Kanmani levels up NEP-171 NFTs.",
  },
  {
    id: "yapp-99k",
    chapterNum: "06",
    testId: "ams-chapter-06",
    name: "Step-by-Step @mira Studio",
    tag: "3:14-3:44 · 112 BPM V-Drill",
    timeRangeLabel: "3:14-3:44",
    startSec: 194,
    endSec: 224,
    durationSec: 30,
    defaultBpm: 112,
    defaultHeadline: "Prompt @mira · 240s Master Film · Viet-Drill Synth",
    directorNote:
      "@mira directs live headlines, 7-chapter 240s scrubbing, and Dan Tranh + 808 V-Drill audio.",
    accentColor: "#D81B78",
    voiceActor: "@mira · V-DRILL",
    voiceColor: "#EC4899",
    steps: [
      { num: "STEP 01", title: "Prompt @mira Director", metric: "Live Headline" },
      { num: "STEP 02", title: "Scrub 240s Canvas / MP4", metric: "7 Chapters" },
      { num: "STEP 03", title: "Dan Tranh + 808 Synth", metric: "-14 LUFS Master" },
    ],
    whatItIs: "Interactive 60fps Canvas2D and 1080p MP4 film studio powered by @mira.",
    whyItHelps: "Lets judges customize scenes, jump chapters, and play Viet-Drill 808 audio in browser.",
    voiceTranscript:
      "Prompt @mira to restyle any chapter live, switch to the 4-minute MP4, or trigger the Dan Tranh and 808 V-Drill synth.",
  },
  {
    id: "one-design-sting",
    chapterNum: "07",
    testId: "ams-chapter-07",
    name: "Quickstart & ONE Lockup",
    tag: "3:44-4:00 · 108 BPM Finale",
    timeRangeLabel: "3:44-4:00",
    startSec: 224,
    endSec: 240,
    durationSec: 16,
    defaultBpm: 108,
    defaultHeadline: "ONE workspace · AGENTES NEAR 2026",
    directorNote:
      "Alex closes with the 3-command local quickstart (`check:near` 8/8) and ONE Workspace finale.",
    accentColor: "#5B3FD6",
    voiceActor: "ALEX · FOUNDER",
    voiceColor: "#00EC97",
    steps: [
      { num: "STEP 01", title: "git clone agentes-near", metric: "MIT Open Source" },
      { num: "STEP 02", title: "bun run check:near", metric: "8/8 Probes PASS" },
      { num: "STEP 03", title: "ONE Workspace Finale", metric: "13/13 Tracks" },
    ],
    whatItIs: "Complete self-hosted Bun + PGlite + NEAR Intents + OutLayer TDX monorepo.",
    whyItHelps: "Clone, verify all 8 live NEAR probes, and launch your team swarm in one minute.",
    voiceTranscript:
      "Run bun run check:near for 8 of 8 live checks. Agentes NEAR: one Slack workspace for humans and autonomous swarms.",
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
    label: "4:00 Full Narrated Master (240s)",
    presetId: "things-moving",
    bpm: 97,
    palette: "preset",
    headline: "AGENTES NEAR / SLACK FOR TEAMS / & AI SWARMS.",
    masterMode: true,
  },
  {
    label: "Ch 02: One Slack + 6 Agents",
    presetId: "fitting-lookbook",
    bpm: 110,
    palette: "cobalt-paper",
    headline: "One Slack. / Every agent.",
  },
  {
    label: "Ch 03: 1Click 358.13 wNEAR",
    presetId: "cutline-flow",
    bpm: 116,
    palette: "preset",
    headline: "1,250 USDC -> 358.1357 wNEAR (+16 bps)",
  },
  {
    label: "Ch 04: OutLayer $25 TDX Guard",
    presetId: "molote-parche",
    bpm: 120,
    palette: "zine-vermilion",
    headline: "OUTLAYER TDX · $25.00/TX CAP · S A F E",
  },
  {
    label: "Ch 05: Winner Mechanics x402",
    presetId: "ai-tool-graph",
    bpm: 118,
    palette: "preset",
    headline: "Corpus x402 ($1.84/hr) + Terrace BACK 76¢ + Kanmani",
  },
  {
    label: "Ch 07: ONE Workspace Finale",
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

function formatMmSs(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
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
  activeStepIndex: 0 | 1 | 2;
} {
  const safeMaster = Number.isFinite(masterSec)
    ? ((masterSec % TOTAL_MASTER_DURATION_SEC) + TOTAL_MASTER_DURATION_SEC) %
      TOTAL_MASTER_DURATION_SEC
    : 0;
  for (const ch of MOTION_PRESETS) {
    if (safeMaster >= ch.startSec && safeMaster < ch.endSec) {
      const localSec = Math.max(0, safeMaster - ch.startSec);
      const ratio = clamp01(localSec / Math.max(1, ch.durationSec));
      const activeStepIndex: 0 | 1 | 2 = ratio < 0.34 ? 0 : ratio < 0.67 ? 1 : 2;
      return { chapter: ch, localSec, activeStepIndex };
    }
  }
  const first = MOTION_PRESETS[0]!;
  return { chapter: first, localSec: 0, activeStepIndex: 0 };
}

/**
 * Vietnamese Drill (V-Drill) Pentatonic Dan Tranh + Bamboo Flute + 808 Glide Synthesizer:
 * 1) Vietnamese Minor Pentatonic Dan Tranh (16-string plucked zither harmonics D-F-G-A-C)
 * 2) Sliding 808 sub-bass portamento glides (root -> fifth -> octave)
 * 3) Syncopated 3-3-2 tresillo + triplet drill hi-hat rolls
 * 4) Snappy rimshot/clap + Sáo Trúc bamboo flute airy fifth overtone
 */
function playSynthBeat(ctx: AudioContext, beatIndex: number, _template: MotionTemplateId) {
  const now = ctx.currentTime;
  const barStep = beatIndex % 8;

  // 1. Punchy Kick + Sliding 808 Sub-Bass Portamento Glide (D minor V-Drill)
  const kickOsc = ctx.createOscillator();
  const kickGain = ctx.createGain();
  kickOsc.type = "sine";
  kickOsc.frequency.setValueAtTime(146, now);
  kickOsc.frequency.exponentialRampToValueAtTime(44, now + 0.09);
  kickGain.gain.setValueAtTime(0.28, now);
  kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  kickOsc.connect(kickGain);
  kickGain.connect(ctx.destination);
  kickOsc.start(now);
  kickOsc.stop(now + 0.16);

  // D-F-G-A-C sub-bass roots & drill glide targets
  const bassNotes = [36.71, 36.71, 43.65, 55.0, 36.71, 65.41, 49.0, 43.65];
  const glideTargets = [73.42, 36.71, 87.31, 110.0, 55.0, 110.0, 73.42, 36.71];
  const rootHz = bassNotes[barStep] ?? 36.71;
  const targetHz = glideTargets[barStep] ?? 73.42;

  const subOsc = ctx.createOscillator();
  const subFilter = ctx.createBiquadFilter();
  const subGain = ctx.createGain();
  subOsc.type = "triangle";
  subFilter.type = "lowpass";
  subFilter.frequency.setValueAtTime(205, now);

  subOsc.frequency.setValueAtTime(rootHz, now);
  if (barStep % 2 === 1 || barStep === 6) {
    subOsc.frequency.setValueAtTime(rootHz, now + 0.07);
    subOsc.frequency.exponentialRampToValueAtTime(targetHz, now + 0.24);
  }

  subGain.gain.setValueAtTime(0.23, now);
  subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
  subOsc.connect(subFilter);
  subFilter.connect(subGain);
  subGain.connect(ctx.destination);
  subOsc.start(now);
  subOsc.stop(now + 0.35);

  // 2. Vietnamese Minor Pentatonic Dan Tranh (16-String Plucked Zither: D4, F4, G4, A4, C5, D5, F5)
  const danTranhScale = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 440.0];
  const pluckFreq = danTranhScale[barStep] ?? 293.66;
  const graceFreq = danTranhScale[(barStep + 2) % danTranhScale.length] ?? 440.0;

  [0, 0.14].forEach((delay, idx) => {
    const zOsc = ctx.createOscillator();
    const zOvertone = ctx.createOscillator();
    const zFilter = ctx.createBiquadFilter();
    const zGain = ctx.createGain();

    const f = idx === 0 ? pluckFreq : graceFreq;
    zOsc.type = "sawtooth";
    zOvertone.type = "triangle";
    // Subtle Dan Tranh pitch bend vibrato after pluck
    zOsc.frequency.setValueAtTime(f, now + delay);
    zOsc.frequency.exponentialRampToValueAtTime(f * 1.012, now + delay + 0.06);
    zOsc.frequency.exponentialRampToValueAtTime(f, now + delay + 0.18);
    zOvertone.frequency.setValueAtTime(f * 2, now + delay);

    zFilter.type = "bandpass";
    zFilter.frequency.setValueAtTime(1850, now + delay);
    zFilter.Q.setValueAtTime(2.2, now + delay);

    zGain.gain.setValueAtTime(idx === 0 ? 0.085 : 0.055, now + delay);
    zGain.gain.exponentialRampToValueAtTime(0.0008, now + delay + 0.24);

    zOsc.connect(zFilter);
    zOvertone.connect(zFilter);
    zFilter.connect(zGain);
    zGain.connect(ctx.destination);

    zOsc.start(now + delay);
    zOvertone.start(now + delay);
    zOsc.stop(now + delay + 0.25);
    zOvertone.stop(now + delay + 0.25);
  });

  // 3. Crisp Viet-Drill Triplet Hi-Hat Rolls
  const hatOffsets = barStep % 2 === 1 ? [0, 0.07, 0.14, 0.21] : [0, 0.14];
  hatOffsets.forEach((offset, hi) => {
    const hatOsc = ctx.createOscillator();
    const hatFilter = ctx.createBiquadFilter();
    const hatGain = ctx.createGain();
    hatOsc.type = "square";
    hatOsc.frequency.setValueAtTime(6400 + hi * 480, now + offset);
    hatFilter.type = "highpass";
    hatFilter.frequency.setValueAtTime(5400, now + offset);
    const vel = hi === 0 ? 0.044 : 0.026;
    hatGain.gain.setValueAtTime(vel, now + offset);
    hatGain.gain.exponentialRampToValueAtTime(0.0008, now + offset + 0.036);
    hatOsc.connect(hatFilter);
    hatFilter.connect(hatGain);
    hatGain.connect(ctx.destination);
    hatOsc.start(now + offset);
    hatOsc.stop(now + offset + 0.04);
  });

  // 4. Snappy Beat-3 Rimshot + Sáo Trúc Bamboo Flute Overtone on Bar Downbeats
  if (beatIndex % 2 === 1) {
    const rimOsc = ctx.createOscillator();
    const rimGain = ctx.createGain();
    rimOsc.type = "triangle";
    rimOsc.frequency.setValueAtTime(940, now);
    rimOsc.frequency.exponentialRampToValueAtTime(250, now + 0.045);
    rimGain.gain.setValueAtTime(0.14, now);
    rimGain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
    rimOsc.connect(rimGain);
    rimGain.connect(ctx.destination);
    rimOsc.start(now);
    rimOsc.stop(now + 0.07);
  }

  if (beatIndex % 4 === 0) {
    const fluteNotes = [587.33, 698.46, 880.0];
    for (const freq of fluteNotes) {
      const pad = ctx.createOscillator();
      const padGain = ctx.createGain();
      pad.type = "sine";
      pad.frequency.setValueAtTime(freq, now);
      pad.frequency.exponentialRampToValueAtTime(freq * 1.004, now + 0.28);
      padGain.gain.setValueAtTime(0.036, now);
      padGain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);
      pad.connect(padGain);
      padGain.connect(ctx.destination);
      pad.start(now);
      pad.stop(now + 0.37);
    }
  }
}

function drawCanvasStepAndVoiceHud(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  chapter: MotionChapterMeta,
  activeStepIndex: 0 | 1 | 2,
  pulse: number,
  monoFont: string,
  sansFont: string,
) {
  // Top Step-by-Step Progress Rail (STEP 01 -> STEP 02 -> STEP 03)
  const topY = 12;
  const pillW = 212;
  const pillH = 30;
  const startX = (w - (pillW * 3 + 16)) / 2;

  chapter.steps.forEach((st, idx) => {
    const x = startX + idx * (pillW + 8);
    const active = idx === activeStepIndex;
    ctx.fillStyle = active ? "rgba(8, 12, 22, 0.94)" : "rgba(8, 12, 22, 0.72)";
    drawRoundedRect(ctx, x, topY, pillW, pillH, 999);
    ctx.fill();
    ctx.strokeStyle = active ? chapter.accentColor : "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = active ? 2 : 1;
    ctx.stroke();

    ctx.fillStyle = active ? chapter.accentColor : "#94A3B8";
    ctx.font = `700 10px ${monoFont}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(st.num, x + 10, topY + pillH / 2);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = `600 11px ${sansFont}`;
    ctx.fillText(st.title.slice(0, 19), x + 62, topY + pillH / 2);
  });

  // Bottom Voiceover & 2-Line Explainer HUD Bar
  const barW = w - 32;
  const barH = 56;
  const barX = 16;
  const barY = h - barH - 10;

  ctx.fillStyle = "rgba(7, 10, 19, 0.92)";
  drawRoundedRect(ctx, barX, barY, barW, barH, 12);
  ctx.fill();
  ctx.strokeStyle = chapter.voiceColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Active Voice Actor Pill
  ctx.fillStyle = chapter.voiceColor;
  drawRoundedRect(ctx, barX + 10, barY + 10, 152, 36, 8);
  ctx.fill();
  ctx.fillStyle = "#060911";
  ctx.font = `700 11px ${monoFont}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(chapter.voiceActor, barX + 86, barY + 28);

  // 5-bar animated V-Drill waveform
  for (let b = 0; b < 5; b++) {
    const bh = Math.max(6, Math.min(28, 10 + Math.sin(pulse * 6 + b * 1.3) * 12 + pulse * 10));
    ctx.fillStyle = chapter.voiceColor;
    ctx.fillRect(barX + 172 + b * 6, barY + 28 - bh / 2, 3.5, bh);
  }

  // 2-Line Explainer + Synchronized Promo Line
  ctx.textAlign = "left";
  ctx.fillStyle = "#E2ECFF";
  ctx.font = `700 12px ${sansFont}`;
  ctx.fillText(
    `${chapter.steps[activeStepIndex].num} (${chapter.steps[activeStepIndex].metric}): ${chapter.whatItIs}`,
    barX + 212,
    barY + 20,
  );
  ctx.fillStyle = "#82F9C8";
  ctx.font = `500 11.5px ${monoFont}`;
  ctx.fillText(`"${chapter.voiceTranscript.slice(0, 88)}"`, barX + 212, barY + 39);
}

function renderMotionFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  chapter: MotionChapterMeta,
  timeSec: number,
  durationSec: number,
  bpm: number,
  headline: string,
  paletteMode: PaletteMode,
  activeStepIndex: 0 | 1 | 2,
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

  switch (chapter.id) {
    /* ------------------------------------------------------------------ */
    /* Ch 01. Problem & 99K Hook (0:00-0:34, 97 BPM Kinetic Wave + Rings) */
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
        const radii = [100, 175, 250];

        ctx.font = `700 40px ${displayFont}`;
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
        const lineHeight = h / 3.8;

        lines.forEach((line, li) => {
          const localP = clamp01((progress - 0.74) / 0.22 - li * 0.14);
          const scale = easeOutBack(localP);
          ctx.save();
          ctx.translate(w / 2, h * 0.24 + li * lineHeight);
          ctx.scale(scale, scale);
          ctx.fillStyle = li === 1 ? accent : fg;
          ctx.font = `700 ${Math.round(h * 0.15)}px ${displayFont}`;
          ctx.fillText(line.toUpperCase(), 0, Math.sin(safeTime * 6 + li) * 4 * pulse);
          ctx.restore();
        });
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Ch 02. One Slack + 6 Agents (0:34-1:10, 110 BPM Lookbook)          */
    /* ------------------------------------------------------------------ */
    case "fitting-lookbook": {
      const bg = override ? override.bg : "#EEE9E0";
      const cobalt = override ? override.accent : "#2E4BFF";
      const butter = override ? override.secondary : "#F3D36B";
      const ink = override ? override.fg : "#141A29";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const cardX = w * 0.05;
      const cardY = h * 0.11;
      const cardW = w * 0.37;
      const cardH = h * 0.72;
      ctx.fillStyle = cobalt;
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
      ctx.fill();

      ctx.fillStyle = "#0D1326";
      drawRoundedRect(ctx, cardX + 20, cardY + 24, cardW - 40, cardH * 0.54, 14);
      ctx.fill();
      ctx.strokeStyle = "#6EF7BE";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#6EF7BE";
      ctx.font = `700 12px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("#near-intents-arena · OUTLAYER $25 CAP", cardX + 34, cardY + 52);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 21px ${serifFont}`;
      ctx.fillText("One Slack. Every NEAR Agent.", cardX + 34, cardY + 86);

      ctx.fillStyle = "#A9C4FF";
      ctx.font = `500 12.5px ${monoFont}`;
      ctx.fillText("1Click Quote -> TDX Guard -> ML-DSA-65", cardX + 34, cardY + 118);
      ctx.fillText("Terrace BACK/FADE + Corpus x402 H100", cardX + 34, cardY + 142);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 20px ${sansFont}`;
      ctx.textAlign = "center";
      ctx.fillText(safeHeadline.slice(0, 28), cardX + cardW * 0.5, cardY + cardH - 72);

      const swatches = ["#F3D36B", "#F4EFE6", "#D96B43", "#94B49F", "#8A9EB5"];
      swatches.forEach((sw, si) => {
        const sx = cardX + 42 + si * 56;
        const sy = cardY + cardH - 34;
        ctx.fillStyle = sw;
        ctx.beginPath();
        ctx.arc(sx, sy, si === beatIndex % 5 ? 15 + pulse * 3 : 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      const agents = [
        { handle: "@ada", role: "Lead Strategist", plate: "1Click Intents" },
        { handle: "@kronos", role: "1Click Execution", plate: "Solver Auction" },
        { handle: "@theo", role: "OutLayer Guard", plate: "$25 TDX Enclave" },
        { handle: "@lia", role: "x402 Compute", plate: "H100 TEE Pool" },
        { handle: "@mira", role: "Motion Director", plate: "V-Drill Studio" },
        { handle: "@zen", role: "PQ Verifier", plate: "ML-DSA-65 Audit" },
      ];
      const gridX = w * 0.45;
      const gridY = h * 0.11;
      const cellW = w * 0.155;
      const cellH = h * 0.34;
      const cellColors = [butter, "#D8F8E8", "#F7E2D8", "#DDE7FF", "#E2ECE9", "#F5E9C9"];

      agents.forEach((ag, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const cx = gridX + col * (cellW + 14);
        const cy = gridY + row * (cellH + 14);
        const checked = progress > 0.1 + i * 0.11;

        ctx.fillStyle = cellColors[i] ?? butter;
        drawRoundedRect(ctx, cx, cy, cellW, cellH, 16);
        ctx.fill();
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.fillStyle = ink;
        ctx.font = `700 15px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText(ag.handle, cx + 12, cy + 28);

        ctx.font = `600 12.5px ${sansFont}`;
        ctx.fillText(ag.role, cx + 12, cy + 54);

        ctx.fillStyle = "#16233F";
        ctx.font = `600 11px ${monoFont}`;
        ctx.fillText(ag.plate, cx + 12, cy + cellH - 20);

        if (checked) {
          ctx.fillStyle = cobalt;
          ctx.beginPath();
          ctx.arc(cx + cellW - 20, cy + 24, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#FFFFFF";
          ctx.font = `700 12px ${sansFont}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("✓", cx + cellW - 20, cy + 24);
        }
      });
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Ch 03. Step-by-Step 1Click Swaps (1:10-1:48, 116 BPM Timeline)     */
    /* ------------------------------------------------------------------ */
    case "cutline-flow": {
      const bg = override ? override.bg : "#F2EEE5";
      const navy = override ? override.fg : "#16233F";
      const crimson = override ? override.accent : "#C2185B";
      const marigold = override ? override.secondary : "#F2B01E";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.fillStyle = "rgba(22, 35, 63, 0.06)";
      ctx.font = `700 ${Math.round(h * 0.48)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("1CLICK", w * 0.5 - (safeTime % 12) * 8, h * 0.36);
      ctx.restore();

      const nodes = [
        { x: w * 0.16, y: h * 0.24, label: "1,250 USDC" },
        { x: w * 0.41, y: h * 0.19, label: "1Click +16 bps" },
        { x: w * 0.66, y: h * 0.26, label: "358.13 wNEAR" },
        { x: w * 0.86, y: h * 0.2, label: "DONE ✓ 22s" },
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
        drawRoundedRect(ctx, n.x - 86, n.y - 26, 172, 52, 12);
        ctx.fill();
        ctx.strokeStyle = navy;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = active ? "#FFFFFF" : navy;
        ctx.font = `700 14px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.label, n.x, n.y);
      });

      const unfold = easeOutCubic(clamp01((progress - 0.2) / 0.34));
      if (unfold > 0.02) {
        const edW = w * 0.84;
        const edH = h * 0.38 * unfold;
        const edX = (w - edW) / 2;
        const edY = h * 0.42;
        ctx.fillStyle = navy;
        drawRoundedRect(ctx, edX, edY, edW, edH, 16);
        ctx.fill();

        if (unfold > 0.5) {
          const tracks = [
            { name: "1CLK", desc: "1Click Solver Auction · 358.1357 wNEAR (+16 bps)", color: marigold, wRatio: 0.84 },
            { name: "TDX", desc: "OutLayer Intel TDX · NEP-413 Signed", color: crimson, wRatio: 0.72 },
            { name: "PQ", desc: "Kyvera FIPS 204 ML-DSA-65 + NEP-297", color: "#00EC97", wRatio: 0.9 },
          ];
          tracks.forEach((tr, ti) => {
            const ty = edY + 26 + ti * 46;
            ctx.fillStyle = "#94A3B8";
            ctx.font = `700 12px ${monoFont}`;
            ctx.textAlign = "left";
            ctx.fillText(tr.name, edX + 20, ty + 14);

            ctx.fillStyle = tr.color;
            drawRoundedRect(ctx, edX + 86, ty, (edW - 126) * tr.wRatio, 28, 8);
            ctx.fill();

            ctx.fillStyle = "#081022";
            ctx.font = `700 11.5px ${monoFont}`;
            ctx.fillText(tr.desc, edX + 100, ty + 14);
          });
        }
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Ch 04. Step-by-Step OutLayer TDX (1:48-2:28, 120 BPM 12fps Zine)   */
    /* ------------------------------------------------------------------ */
    case "molote-parche": {
      const steppedTime = Math.floor(safeTime * 12) / 12;
      const stepBeat = Math.floor(steppedTime / beatDur);
      const vermilion = override ? override.accent : "#F05A28";
      const green = override ? override.secondary : "#3BA55C";
      const cream = override ? override.bg : "#F6F0E2";

      ctx.fillStyle = stepBeat % 2 === 0 ? cream : "#EFE6D2";
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(w * 0.24, h * 0.46);
      ctx.rotate(stepBeat % 2 === 0 ? -0.06 : 0.04);
      ctx.fillStyle = vermilion;
      ctx.fillRect(-165, -160, 330, 320);
      ctx.restore();

      ctx.save();
      ctx.translate(w * 0.73, h * 0.48);
      ctx.rotate(stepBeat % 2 === 0 ? 0.05 : -0.04);
      ctx.fillStyle = green;
      ctx.fillRect(-165, -150, 330, 300);
      ctx.restore();

      ctx.save();
      ctx.translate(w * 0.5, h * 0.2);
      ctx.rotate(-0.02);
      ctx.fillStyle = "#141414";
      ctx.fillRect(-290, -24, 580, 48);
      ctx.fillStyle = "#F6F0E2";
      ctx.font = `700 19px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("OUTLAYER INTEL TDX · $25.00/TX CAP · $45 BLOCKED", 0, 0);
      ctx.restore();

      const letters = ["S", "A", "F", "E"];
      letters.forEach((lt, li) => {
        const lx = w * 0.28 + li * (w * 0.145);
        const ly = h * 0.49 + ((li + stepBeat) % 2 === 0 ? -10 : 10);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate((li % 2 === 0 ? 1 : -1) * 0.08 + ((stepBeat % 3) - 1) * 0.04);
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(-48, -56, 96, 112);
        ctx.strokeStyle = "#141414";
        ctx.lineWidth = 4;
        ctx.strokeRect(-48, -56, 96, 112);
        ctx.fillStyle = "#141414";
        ctx.font = `700 68px ${displayFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lt, 0, 4);
        ctx.restore();
      });
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Ch 05. Step-by-Step Winner Mechanics (2:28-3:14, 118 BPM Hub)      */
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

      const hub = { x: w * 0.34, y: h * 0.48 };
      const tools = [
        { x: w * 0.14, y: h * 0.26, label: "[Corpus x402]" },
        { x: w * 0.14, y: h * 0.68, label: "[1Click Swap]" },
        { x: w * 0.52, y: h * 0.24, label: "[OutLayer TDX]" },
        { x: w * 0.54, y: h * 0.7, label: "[Terrace 76¢]" },
        { x: w * 0.34, y: h * 0.76, label: "[Kanmani NFT]" },
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
        drawRoundedRect(ctx, tl.x - 76, tl.y - 18, 152, 36, 10);
        ctx.fill();
        ctx.strokeStyle = ti === beatIndex % tools.length ? accent : blue;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = "#F4F6FB";
        ctx.font = `600 12.5px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tl.label, tl.x, tl.y);
      });

      ctx.fillStyle = blue;
      ctx.beginPath();
      ctx.arc(hub.x, hub.y, 44 + pulse * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 14px ${monoFont}`;
      ctx.fillText("@ada HUB", hub.x, hub.y);

      ctx.fillStyle = "#121826";
      drawRoundedRect(ctx, w * 0.62, h * 0.18, w * 0.33, h * 0.56, 18);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.font = `700 12px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("WINNER MECHANICS LIVE", w * 0.645, h * 0.25);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 18px ${sansFont}`;
      ctx.fillText("Corpus: $1.84/hr H100 TEE", w * 0.645, h * 0.35);
      ctx.fillStyle = "#FCD34D";
      ctx.fillText("38,420 $AGENTES Burned", w * 0.645, h * 0.45);
      ctx.fillStyle = "#93B2FF";
      ctx.font = `600 13px ${monoFont}`;
      ctx.fillText("Kanmani: @lia Level 7 NFT ✓", w * 0.645, h * 0.56);
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Ch 06. Step-by-Step @mira Studio (3:14-3:44, 112 BPM Viral Studio) */
    /* ------------------------------------------------------------------ */
    case "yapp-99k": {
      const bg = override ? override.bg : "#F7F7F2";
      const fg = override ? override.fg : "#161614";
      const magenta = override ? override.accent : "#D81B78";
      const green = override ? override.secondary : "#3DA35D";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      const countVal = Math.round(99 * easeOutCubic(clamp01(progress / 0.65)));
      const counterScale = 1 + pulse * 0.05;
      ctx.save();
      ctx.translate(w / 2, h * 0.68);
      ctx.scale(counterScale, counterScale);
      ctx.fillStyle = magenta;
      ctx.font = `700 ${Math.round(h * 0.22)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${countVal}K INTENTS`, 0, 0);
      ctx.restore();

      const cardW = w * 0.78;
      const cardH = h * 0.38;
      const cardX = (w - cardW) / 2;
      const cardY = h * 0.12;
      ctx.fillStyle = "#FFFFFF";
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 22);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = fg;
      ctx.stroke();

      ctx.fillStyle = "#EC4899";
      ctx.beginPath();
      ctx.arc(cardX + 48, cardY + 46, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 14px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("@mira", cardX + 48, cardY + 46);

      ctx.textAlign = "left";
      ctx.fillStyle = fg;
      ctx.font = `700 20px ${sansFont}`;
      ctx.fillText("@mira · AI Video Director · #motion-studio", cardX + 86, cardY + 38);
      ctx.fillStyle = "#5A6065";
      ctx.font = `500 14px ${monoFont}`;
      ctx.fillText("240s Narrated Master Film · Dan Tranh + 808 Viet-Drill Synth", cardX + 86, cardY + 62);

      ctx.fillStyle = fg;
      ctx.font = `600 23px ${sansFont}`;
      ctx.fillText(safeHeadline.slice(0, 56), cardX + 32, cardY + 118);

      ctx.fillStyle = green;
      drawRoundedRect(ctx, cardX + 32, cardY + cardH - 46, 360, 32, 999);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 14px ${monoFont}`;
      ctx.fillText("Top reply · @ada: 358.1357 wNEAR settled in 22s", cardX + 48, cardY + cardH - 30);
      break;
    }

    /* ------------------------------------------------------------------ */
    /* Ch 07. Quickstart & ONE Lockup (3:44-4:00, 108 BPM Finale)         */
    /* ------------------------------------------------------------------ */
    case "one-design-sting": {
      const stone = override ? override.bg : "#F5F3EE";
      const charcoal = override ? override.fg : "#1E1E1E";
      const violet = override ? override.accent : "#5B3FD6";
      const tomato = override ? override.secondary : "#E5483A";

      ctx.fillStyle = stone;
      ctx.fillRect(0, 0, w, h);

      const morphP = easeOutCubic(clamp01(progress / 0.52));
      const spread = (1 - morphP) * 180;
      ctx.fillStyle = "rgba(91, 63, 214, 0.16)";
      ctx.beginPath();
      ctx.arc(w * 0.5 - spread, h * 0.34, 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(229, 72, 58, 0.16)";
      ctx.fillRect(w * 0.5 + spread - 40, h * 0.34 - 40, 80, 80);

      ctx.fillStyle = charcoal;
      ctx.font = `700 ${Math.round(h * 0.24)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("ONE", w * 0.5, h * 0.4);

      ctx.fillStyle = violet;
      ctx.font = `italic 500 ${Math.round(h * 0.12)}px ${serifFont}`;
      ctx.fillText("workspace", w * 0.5, h * 0.59);

      if (progress > 0.52) {
        const wipe = easeOutCubic((progress - 0.52) / 0.18);
        ctx.fillStyle = tomato;
        ctx.fillRect(0, 0, w * wipe, h);

        if (progress > 0.64) {
          const lockWipe = easeOutCubic((progress - 0.64) / 0.18);
          ctx.fillStyle = violet;
          ctx.fillRect(0, 0, w * lockWipe, h);
          if (lockWipe > 0.45) {
            ctx.fillStyle = "#FFFFFF";
            ctx.font = `700 ${Math.round(h * 0.1)}px ${displayFont}`;
            ctx.fillText("ONE WORKSPACE · AGENTES NEAR 2026", w * 0.5, h * 0.36);
            ctx.font = `italic 500 32px ${serifFont}`;
            ctx.fillText("Slack for Teams & Autonomous NEAR Swarms", w * 0.5, h * 0.52);
            ctx.fillStyle = "#00EC97";
            ctx.font = `700 15px ${monoFont}`;
            ctx.fillText(
              "bun run check:near (8/8 PASS) · 13/13 NEAR Tracks · /ocelli",
              w * 0.5,
              h * 0.68,
            );
          }
        }
      }
      break;
    }
  }

  // Always render the synchronized Step-by-Step + Voiceover HUD Overlay on top of the canvas
  drawCanvasStepAndVoiceHud(ctx, w, h, chapter, activeStepIndex, pulse, monoFont, sansFont);

  ctx.restore();
}

export function AgentMotionStudio() {
  const [masterMode, setMasterMode] = useState<boolean>(true);
  const [stageMode, setStageMode] = useState<StageMediaMode>("canvas");
  const [mp4Variant, setMp4Variant] = useState<Mp4FilmVariant>("demo-240s");
  const [videoError, setVideoError] = useState<boolean>(false);

  const [templateId, setTemplateId] = useState<MotionTemplateId>("things-moving");
  const [masterTimeSec, setMasterTimeSec] = useState<number>(0);
  const [soloTimeSec, setSoloTimeSec] = useState<number>(0);

  const resolvedState = useMemo(() => {
    if (masterMode) {
      return resolveChapterAtMasterTime(masterTimeSec);
    }
    const ch = MOTION_PRESETS.find((p) => p.id === templateId) ?? MOTION_PRESETS[0]!;
    const ratio = clamp01(soloTimeSec / Math.max(1, ch.durationSec));
    const activeStepIndex: 0 | 1 | 2 = ratio < 0.34 ? 0 : ratio < 0.67 ? 1 : 2;
    return { chapter: ch, localSec: soloTimeSec, activeStepIndex };
  }, [masterMode, masterTimeSec, soloTimeSec, templateId]);

  const activeChapter = resolvedState.chapter;
  const activeStepIndex = resolvedState.activeStepIndex;

  const [isPlaying, setIsPlaying] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [bpm, setBpm] = useState(MOTION_PRESETS[0]!.defaultBpm);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("preset");
  const [headline, setHeadline] = useState(MOTION_PRESETS[0]!.defaultHeadline);
  const [customHeadlineLocked, setCustomHeadlineLocked] = useState(false);
  const [miraPrompt, setMiraPrompt] = useState("");
  const [directorNote, setDirectorNote] = useState(
    "4:00 Narrated Master Film (240.0s · V-Drill) active: playing Chapters 01 to 07 seamlessly.",
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastBeatIndexRef = useRef(-1);
  const masterTimeRef = useRef(0);
  const soloTimeRef = useRef(0);
  const lastChapterIdRef = useRef<MotionTemplateId>("things-moving");

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
          mp4Variant === "demo-240s"
            ? preset.startSec
            : Math.min(59, (preset.startSec / TOTAL_MASTER_DURATION_SEC) * 60);
        void videoRef.current.play();
      } catch {
        // Ignore seek error before metadata loads
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
    if (lower.includes("slack") || lower.includes("lookbook") || lower.includes("6 agents")) {
      targetChapter = MOTION_PRESETS[1]!;
    } else if (lower.includes("1click") || lower.includes("swap") || lower.includes("solver")) {
      targetChapter = MOTION_PRESETS[2]!;
    } else if (
      lower.includes("tdx") ||
      lower.includes("outlayer") ||
      lower.includes("$25") ||
      lower.includes("zine") ||
      lower.includes("safe")
    ) {
      targetChapter = MOTION_PRESETS[3]!;
    } else if (
      lower.includes("winner") ||
      lower.includes("corpus") ||
      lower.includes("terrace") ||
      lower.includes("x402")
    ) {
      targetChapter = MOTION_PRESETS[4]!;
    } else if (lower.includes("mira") || lower.includes("studio") || lower.includes("drill")) {
      targetChapter = MOTION_PRESETS[5]!;
    } else if (lower.includes("finale") || lower.includes("one") || lower.includes("quickstart")) {
      targetChapter = MOTION_PRESETS[6]!;
    } else if (lower.includes("hook") || lower.includes("problem") || lower.includes("99k")) {
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
        const { chapter, localSec, activeStepIndex: stepIdx } = resolveChapterAtMasterTime(
          masterTimeRef.current,
        );
        const chapterHeadline = customHeadlineLocked ? headline : chapter.defaultHeadline;
        renderMotionFrame(
          ctx,
          width,
          height,
          chapter,
          localSec,
          chapter.durationSec,
          chapter.defaultBpm,
          chapterHeadline,
          paletteMode,
          stepIdx,
        );
      } else {
        const soloChapter =
          MOTION_PRESETS.find((p) => p.id === templateId) ?? MOTION_PRESETS[0]!;
        const ratio = clamp01(soloTimeRef.current / Math.max(1, soloChapter.durationSec));
        const stepIdx: 0 | 1 | 2 = ratio < 0.34 ? 0 : ratio < 0.67 ? 1 : 2;
        renderMotionFrame(
          ctx,
          width,
          height,
          soloChapter,
          soloTimeRef.current,
          soloChapter.durationSec,
          bpm,
          headline,
          paletteMode,
          stepIdx,
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
    mp4Variant === "demo-240s"
      ? "/video/agentes-near-demo.mp4"
      : "/video/agentes-near-x-teaser.mp4";

  return (
    <div className="ams-studio" data-testid="agent-motion-studio">
      {/* Top Mode Bar: Interactive 60fps Agent Canvas vs Watch 4:00 Narrated Master Film (MP4) */}
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
            Watch 4:00 Narrated Master Film (MP4)
          </button>
        </div>

        <div className="ams-mode-meta">
          <button
            type="button"
            data-testid="ams-hero-sound-cta"
            className="ams-sound-hero-cta"
            aria-pressed={soundOn}
            onClick={() => {
              toggleSound();
              setIsPlaying(true);
            }}
          >
            {soundOn ? "🔊 Viet-Drill + 808 Sound Active" : "▶ Play With Viet-Drill + 808 Sound"}
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
                    "4:00 Narrated Master Film (240.0s · V-Drill) active: playing Chapters 01 to 07 seamlessly.",
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
                ? "Mode: 4:00 Full Promotion Talk & Step-by-Step Demo (240s)"
                : `Mode: Loop Ch ${activeChapter.chapterNum} (${activeChapter.name})`}
            </button>
          ) : (
            <div className="ams-mp4-variants">
              <button
                type="button"
                className="ams-flow-pill"
                aria-pressed={mp4Variant === "demo-240s"}
                onClick={() => {
                  setVideoError(false);
                  setMp4Variant("demo-240s");
                }}
              >
                4:00 Narrated Master Film (240s · V-Drill)
              </button>
              <button
                type="button"
                className="ams-flow-pill"
                aria-pressed={mp4Variant === "teaser-60s"}
                onClick={() => {
                  setVideoError(false);
                  setMp4Variant("teaser-60s");
                }}
              >
                60s X Teaser (1080p)
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

      {/* 7-Chapter 240.0s (4:00) Master Timeline Bar */}
      <div className="ams-master-timeline" data-testid="ams-master-timeline">
        <div className="ams-master-timeline__head">
          <span className="ams-master-timeline__title">
            4:00 (240.0s) NARRATED MASTER TIMELINE · CH {activeChapter.chapterNum}{" "}
            {activeChapter.name.toUpperCase()} ({activeChapter.timeRangeLabel})
          </span>
          <span className="ams-master-timeline__clock">
            {formatMmSs(masterTimeSec)} / 4:00 ({masterTimeSec.toFixed(1)}s /{" "}
            {TOTAL_MASTER_DURATION_SEC.toFixed(1)}s) · Dan Tranh + 808 V-Drill (-14 LUFS)
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
                data-testid={ch.testId}
                className="ams-master-seg"
                data-active={isCurrent ? "true" : "false"}
                style={{ flexGrow: ch.durationSec }}
                onClick={() => selectPreset(ch)}
                title={`Jump to ${ch.chapterNum} ${ch.name} (${ch.timeRangeLabel})`}
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
                  if (mp4Variant === "demo-240s") {
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

          {/* Synchronized Step-by-Step Feature & Voiceover HUD Overlay Bar */}
          <div className="ams-voice-hud" data-testid="ams-voice-hud">
            <div className="ams-voice-hud__top">
              <span
                className="ams-voice-pill"
                style={{
                  borderColor: activeChapter.voiceColor,
                  color: activeChapter.voiceColor,
                }}
              >
                🎙️ {activeChapter.voiceActor}
              </span>
              <div className="ams-step-pills">
                {activeChapter.steps.map((st, idx) => (
                  <span
                    key={st.num}
                    className="ams-step-pill"
                    data-active={idx === activeStepIndex ? "true" : "false"}
                  >
                    <strong>{st.num}</strong> {st.title} ({st.metric})
                  </span>
                ))}
              </div>
            </div>
            <div className="ams-voice-hud__callout">
              <div>
                <strong>What it is:</strong> {activeChapter.whatItIs}
              </div>
              <div>
                <strong>Why it helps you:</strong> {activeChapter.whyItHelps}
              </div>
            </div>
          </div>

          <div className="ams-stage-meta">
            <span>
              Ch {activeChapter.chapterNum} {activeChapter.name} ({activeChapter.timeRangeLabel}) ·
              Beat #{beatNumber} ({bpm} BPM)
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
                <option value={112}>112 BPM</option>
                <option value={116}>116 BPM</option>
                <option value={118}>118 BPM</option>
                <option value={120}>120 BPM</option>
              </select>
            </div>
          </div>

          <div className="ams-ctrl-group">
            <div className="ams-scrub-head">
              <span className="ams-ctrl-label">
                {masterMode ? "4:00 (240s) Master Scrubber" : "Chapter Scrubber"}
              </span>
              <span className="ams-scrub-time">
                {formatMmSs(effectiveTimeSec)} / {formatMmSs(effectiveDurationSec)} (
                {effectiveTimeSec.toFixed(1)}s)
              </span>
            </div>
            <input
              type="range"
              aria-label="Motion timeline scrubber"
              className="ams-scrubber"
              min={0}
              max={effectiveDurationSec}
              step={0.1}
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
              {soundOn ? "Viet-Drill + 808 On" : "Sound Muted"}
            </DitherButton>
          </div>
        </DitherCard>
      </div>
    </div>
  );
}
