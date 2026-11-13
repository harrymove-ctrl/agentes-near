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

interface MotionPresetMeta {
  id: MotionTemplateId;
  name: string;
  tag: string;
  defaultBpm: number;
  durationSec: number;
  defaultHeadline: string;
  directorNote: string;
}

export const MOTION_PRESETS: MotionPresetMeta[] = [
  {
    id: "things-moving",
    name: "Things Are Moving",
    tag: "97 BPM · Kinetic Wave",
    defaultBpm: 97,
    durationSec: 12,
    defaultHeadline: "AGENTES NEAR / SLACK FOR TEAMS / & NEAR AGENTS",
    directorNote: "@ada synced sine-wave typography & concentric baseline rings to 97 BPM.",
  },
  {
    id: "yapp-99k",
    name: "Yapp 99K Counter",
    tag: "104 BPM · Viral Card",
    defaultBpm: 104,
    durationSec: 10,
    defaultHeadline: "Launch day. Please act normal.",
    directorNote: "@theo wired beat-driven typing, 99K Anton odometer, and Top Reply sticker.",
  },
  {
    id: "cutline-flow",
    name: "Cutline Flow Diagram",
    tag: "116 BPM · Node Unfold",
    defaultBpm: 116,
    durationSec: 10,
    defaultHeadline: "1Click -> OutLayer -> ML-DSA-65",
    directorNote: "@lia mapped solver graph edges into a 3-track timeline fold + v1.0 stamp.",
  },
  {
    id: "fitting-lookbook",
    name: "Fitting Lookbook",
    tag: "60fps · Editorial Grid",
    defaultBpm: 110,
    durationSec: 10,
    defaultHeadline: "COBALT TEE · 5 PAPER PALETTES",
    directorNote: "@ada choreographed 3x2 badge checkmarks, 5 swatches, and 3D wallet cards.",
  },
  {
    id: "ai-tool-graph",
    name: "AI Tool Graph",
    tag: "112 BPM · Dark Hub",
    defaultBpm: 112,
    durationSec: 10,
    defaultHeadline: "Direct NEAR Agentic Launch",
    directorNote: "@kronos connected 5 pulsing NEAR tool nodes into a live preview card.",
  },
  {
    id: "molote-parche",
    name: "Molote Parche 2",
    tag: "120 BPM · 12fps On-Twos",
    defaultBpm: 120,
    durationSec: 10,
    defaultHeadline: "L O U D · 11.21 DROP",
    directorNote: "@theo quantized canvas to 12fps on-twos torn paper zine & label tape.",
  },
  {
    id: "one-design-sting",
    name: "ONE design Sting",
    tag: "108 BPM · Cursor Morph",
    defaultBpm: 108,
    durationSec: 9,
    defaultHeadline: "BUILT BY YOU + NEAR AGENTS",
    directorNote: "@lia animated the 'you' cursor morphing shapes into ONE + tomato wipe.",
  },
];

const AUTO_DIRECT_PROMPTS: Array<{
  label: string;
  presetId: MotionTemplateId;
  bpm: number;
  palette: PaletteMode;
  headline: string;
}> = [
  {
    label: "97 BPM Kinetic Hook",
    presetId: "things-moving",
    bpm: 97,
    palette: "preset",
    headline: "AGENTES NEAR / SLACK FOR TEAMS / & NEAR AGENTS",
  },
  {
    label: "Viral 99K Counter",
    presetId: "yapp-99k",
    bpm: 104,
    palette: "preset",
    headline: "Launch day. Please act normal.",
  },
  {
    label: "Node Flow Unfold",
    presetId: "cutline-flow",
    bpm: 116,
    palette: "preset",
    headline: "1Click -> OutLayer -> ML-DSA-65",
  },
  {
    label: "Paper Stop-Motion Drop",
    presetId: "molote-parche",
    bpm: 120,
    palette: "zine-vermilion",
    headline: "L O U D · 11.21 DROP",
  },
  {
    label: "ONE Cursor Sting",
    presetId: "one-design-sting",
    bpm: 108,
    palette: "violet-tomato",
    headline: "ONE WORKSPACE · ZERO LOCK-IN",
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

function playSynthBeat(ctx: AudioContext, beatIndex: number, template: MotionTemplateId) {
  const now = ctx.currentTime;

  // Punchy kick on every beat
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(142, now);
  osc.frequency.exponentialRampToValueAtTime(42, now + 0.11);
  gain.gain.setValueAtTime(0.28, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.17);

  // Off-beat crisp percussive snap on beats 1 and 3 (2 and 4 in 4/4)
  if (beatIndex % 2 === 1) {
    const snapOsc = ctx.createOscillator();
    const snapGain = ctx.createGain();
    snapOsc.type = "triangle";
    snapOsc.frequency.setValueAtTime(780, now);
    snapOsc.frequency.exponentialRampToValueAtTime(220, now + 0.05);
    snapGain.gain.setValueAtTime(0.11, now);
    snapGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    snapOsc.connect(snapGain);
    snapGain.connect(ctx.destination);
    snapOsc.start(now);
    snapOsc.stop(now + 0.07);
  }

  // Chord / harmonic sting on bar downbeats (every 4th beat)
  if (beatIndex % 4 === 0) {
    const baseFreqs =
      template === "ai-tool-graph"
        ? [220, 277.18, 329.63]
        : template === "molote-parche"
          ? [261.63, 311.13, 392.0]
          : [293.66, 369.99, 440.0];
    for (const freq of baseFreqs) {
      const pad = ctx.createOscillator();
      const padGain = ctx.createGain();
      pad.type = "sine";
      pad.frequency.setValueAtTime(freq, now);
      padGain.gain.setValueAtTime(0.045, now);
      padGain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      pad.connect(padGain);
      padGain.connect(ctx.destination);
      pad.start(now);
      pad.stop(now + 0.29);
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
    /* 1. Things Are Moving (97 BPM Kinetic Type Wave + Rings + 3-Line)   */
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

      if (progress < 0.44) {
        // Phase A: Full-frame wavy text rows riding a synced sine wave
        const rows = 7;
        const rowH = h / rows;
        ctx.font = `700 ${Math.round(rowH * 0.72)}px ${displayFont}`;
        ctx.textBaseline = "middle";
        const unitText = safeHeadline.split("/")[0]?.trim() || "THINGS ARE MOVING";

        for (let r = 0; r < rows; r++) {
          const isPink = r === 3;
          ctx.fillStyle = isPink ? accent : fg;
          const dir = isPink ? -1 : 1;
          const shift = ((timeSec * 165 * dir + r * 95) % 420) - 210;
          const yBase = (r + 0.5) * rowH;

          for (let c = -2; c <= 4; c++) {
            const x = c * 390 + shift;
            const waveY = Math.sin(x * 0.008 + timeSec * 4.2 + r * 0.6) * (12 + pulse * 10);
            ctx.fillText(unitText.toUpperCase(), x, yBase + waveY);
          }
        }
      } else if (progress < 0.74) {
        // Phase B: Spinning concentric rings of one large letter size sitting baseline-to-baseline
        const cx = w / 2;
        const cy = h / 2;
        const ringText = (safeHeadline.replace(/\//g, " ") + "  ").toUpperCase();
        const radii = [110, 190, 275];

        ctx.font = `700 44px ${displayFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        radii.forEach((rad, ri) => {
          const spin = timeSec * (ri % 2 === 0 ? 0.85 : -0.72) + pulse * 0.08;
          const count = 18 + ri * 6;
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
        // Phase C: 3 stacked full-frame lines with character letter ripple
        const rawParts = safeHeadline.split("/").map((s) => s.trim()).filter(Boolean);
        const lines = [
          rawParts[0] ?? "AGENTES NEAR",
          rawParts[1] ?? "SLACK FOR TEAMS",
          rawParts[2] ?? "& NEAR AGENTS",
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
          ctx.font = `700 ${Math.round(h * 0.17)}px ${displayFont}`;
          ctx.fillText(line.toUpperCase(), 0, Math.sin(timeSec * 6 + li) * 4 * pulse);
          ctx.restore();
        });
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* 2. Yapp 99K Counter (104 BPM Flat #F7F7F2 / #D81B78 / #3DA35D)     */
    /* ------------------------------------------------------------------ */
    case "yapp-99k": {
      const bg = override ? override.bg : "#F7F7F2";
      const fg = override ? override.fg : "#161614";
      const magenta = override ? override.accent : "#D81B78";
      const green = override ? override.secondary : "#3DA35D";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Subtle beat bar border
      ctx.strokeStyle = magenta;
      ctx.lineWidth = 4 + pulse * 6;
      ctx.strokeRect(18, 18, w - 36, h - 36);

      // Viral Social Card
      const cardW = w * 0.74;
      const cardH = h * 0.42;
      const cardX = (w - cardW) / 2;
      const cardY = h * 0.12;
      ctx.fillStyle = "#FFFFFF";
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = fg;
      ctx.stroke();

      // Avatar circle
      ctx.fillStyle = green;
      ctx.beginPath();
      ctx.arc(cardX + 54, cardY + 54, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 20px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("@ada", cardX + 54, cardY + 54);

      ctx.textAlign = "left";
      ctx.fillStyle = fg;
      ctx.font = `700 22px ${sansFont}`;
      ctx.fillText("Agentes NEAR · #near-intents-arena", cardX + 96, cardY + 46);
      ctx.fillStyle = "#66686F";
      ctx.font = `500 16px ${monoFont}`;
      ctx.fillText("OutLayer TDX Verified · Live Intent Pool", cardX + 96, cardY + 72);

      // Typed headline inside post
      const typingProgress = clamp01(progress / 0.45);
      const visibleChars = Math.max(1, Math.floor(safeHeadline.length * typingProgress));
      const typed = safeHeadline.slice(0, visibleChars);
      ctx.fillStyle = fg;
      ctx.font = `600 34px ${sansFont}`;
      ctx.fillText(
        typed + (Math.floor(timeSec * 3) % 2 === 0 && typingProgress < 1 ? "|" : ""),
        cardX + 34,
        cardY + 148,
      );

      // Giant 99K Anton odometer rolling up on beat
      const countVal = Math.round(99 * easeOutCubic(clamp01(progress / 0.78)));
      const counterScale = 1 + pulse * 0.08;
      ctx.save();
      ctx.translate(w / 2, h * 0.74);
      ctx.scale(counterScale, counterScale);
      ctx.fillStyle = magenta;
      ctx.font = `700 ${Math.round(h * 0.25)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${countVal}K`, 0, 0);
      ctx.restore();

      // Tilted "Top reply" sticker pop-in
      if (progress > 0.42) {
        const pop = easeOutBack((progress - 0.42) / 0.18);
        ctx.save();
        ctx.translate(w * 0.74, h * 0.56);
        ctx.rotate(-0.12);
        ctx.scale(pop, pop);
        ctx.fillStyle = green;
        drawRoundedRect(ctx, -110, -28, 220, 56, 999);
        ctx.fill();
        ctx.fillStyle = "#FFFFFF";
        ctx.font = `700 22px ${sansFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Top reply · BACK +5", 0, 0);
        ctx.restore();
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* 3. Cutline Flow Diagram (116 BPM Flat #F2EEE5 / #16233F / #C2185B)  */
    /* ------------------------------------------------------------------ */
    case "cutline-flow": {
      const bg = override ? override.bg : "#F2EEE5";
      const navy = override ? override.fg : "#16233F";
      const crimson = override ? override.accent : "#C2185B";
      const marigold = override ? override.secondary : "#F2B01E";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Subtle blueprint grid
      ctx.strokeStyle = "rgba(22, 35, 63, 0.08)";
      ctx.lineWidth = 1;
      for (let gx = 40; gx < w; gx += 48) {
        ctx.beginPath();
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, h);
        ctx.stroke();
      }
      for (let gy = 40; gy < h; gy += 48) {
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(w, gy);
        ctx.stroke();
      }

      const nodes = [
        { x: w * 0.16, y: h * 0.28, label: "1Click Quote" },
        { x: w * 0.42, y: h * 0.22, label: "OutLayer TDX" },
        { x: w * 0.66, y: h * 0.31, label: "ML-DSA-65" },
        { x: w * 0.85, y: h * 0.24, label: "NEAR Settle" },
      ];

      // Draw animated graph connections
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
        ctx.fillStyle = active ? (idx === 1 ? crimson : navy) : "#FFFFFF";
        drawRoundedRect(ctx, n.x - 86, n.y - 28, 172, 56, 12);
        ctx.fill();
        ctx.strokeStyle = navy;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = active ? "#FFFFFF" : navy;
        ctx.font = `700 17px ${monoFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.label, n.x, n.y);
      });

      // Unfolded 3-track timeline editor below
      const unfold = easeOutCubic(clamp01((progress - 0.3) / 0.35));
      if (unfold > 0.02) {
        const edW = w * 0.82;
        const edH = h * 0.42 * unfold;
        const edX = (w - edW) / 2;
        const edY = h * 0.48;
        ctx.fillStyle = navy;
        drawRoundedRect(ctx, edX, edY, edW, edH, 16);
        ctx.fill();

        if (unfold > 0.5) {
          const tracks = [
            { name: "VIDEO", color: marigold, wRatio: 0.78 },
            { name: "SFX", color: crimson, wRatio: 0.62 },
            { name: "AGENTS", color: "#34D399", wRatio: 0.88 },
          ];
          tracks.forEach((tr, ti) => {
            const ty = edY + 36 + ti * 52;
            ctx.fillStyle = "#94A3B8";
            ctx.font = `600 13px ${monoFont}`;
            ctx.textAlign = "left";
            ctx.fillText(tr.name, edX + 24, ty + 16);

            ctx.fillStyle = tr.color;
            drawRoundedRect(ctx, edX + 110, ty, (edW - 150) * tr.wRatio, 30, 8);
            ctx.fill();
          });

          // Playhead
          const phX = edX + 110 + (edW - 150) * progress;
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(phX, edY + 20);
          ctx.lineTo(phX, edY + edH - 20);
          ctx.stroke();
        }
      }

      // v1.0 Stamp
      if (progress > 0.62) {
        const stP = easeOutBack((progress - 0.62) / 0.16);
        ctx.save();
        ctx.translate(w * 0.84, h * 0.78);
        ctx.rotate(-0.14);
        ctx.scale(stP, stP);
        ctx.fillStyle = marigold;
        drawRoundedRect(ctx, -68, -28, 136, 56, 10);
        ctx.fill();
        ctx.strokeStyle = navy;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = navy;
        ctx.font = `800 26px ${displayFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("v1.0", 0, 0);
        ctx.restore();
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* 4. Fitting Lookbook (60fps Warm #EEE9E0 / Cobalt #2E4BFF / Butter) */
    /* ------------------------------------------------------------------ */
    case "fitting-lookbook": {
      const bg = override ? override.bg : "#EEE9E0";
      const cobalt = override ? override.accent : "#2E4BFF";
      const butter = override ? override.secondary : "#F3D36B";
      const ink = override ? override.fg : "#141A29";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Left: Garment Drop Card + 5 Color Swatches
      const cardX = w * 0.06;
      const cardY = h * 0.12;
      const cardW = w * 0.36;
      const cardH = h * 0.76;
      ctx.fillStyle = cobalt;
      drawRoundedRect(ctx, cardX, cardY, cardW, cardH, 24);
      ctx.fill();

      // Stylized overshirt silhouette
      ctx.fillStyle = "#E8EEFF";
      drawRoundedRect(ctx, cardX + cardW * 0.25, cardY + 74, cardW * 0.5, cardH * 0.44, 16);
      ctx.fill();
      ctx.fillStyle = cobalt;
      ctx.font = `700 22px ${serifFont}`;
      ctx.textAlign = "center";
      ctx.fillText("Agentes Wool", cardX + cardW * 0.5, cardY + cardH * 0.34);

      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 24px ${sansFont}`;
      ctx.fillText(safeHeadline.slice(0, 26), cardX + cardW * 0.5, cardY + cardH - 84);

      // 5 paper swatches
      const swatches = ["#F3D36B", "#FDF6E9", "#C85A32", "#7FA38B", "#94A3B8"];
      swatches.forEach((sw, si) => {
        const sx = cardX + 34 + si * 54;
        const sy = cardY + cardH - 46;
        ctx.fillStyle = sw;
        ctx.beginPath();
        ctx.arc(sx, sy, si === beatIndex % 5 ? 16 + pulse * 3 : 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      // Right: 3x2 Model / Agent Checkmark Matrix
      const gridX = w * 0.46;
      const gridY = h * 0.12;
      const cellW = w * 0.15;
      const cellH = h * 0.34;
      const cellColors = [butter, "#D8F8E8", "#F7E2D8", "#DDE7FF", "#E2ECE9", "#F5E9C9"];

      for (let i = 0; i < 6; i++) {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const cx = gridX + col * (cellW + 14);
        const cy = gridY + row * (cellH + 16);
        const checked = progress > 0.12 + i * 0.1;

        ctx.fillStyle = cellColors[i] ?? butter;
        drawRoundedRect(ctx, cx, cy, cellW, cellH, 16);
        ctx.fill();
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = ink;
        ctx.font = `600 14px ${monoFont}`;
        ctx.textAlign = "left";
        ctx.fillText(`LOOK 0${i + 1}`, cx + 12, cy + 26);

        if (checked) {
          ctx.fillStyle = cobalt;
          ctx.beginPath();
          ctx.arc(cx + cellW - 22, cy + 24, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#FFFFFF";
          ctx.font = `700 13px ${sansFont}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("✓", cx + cellW - 22, cy + 24);
        }
      }
      break;
    }

    /* ------------------------------------------------------------------ */
    /* 5. AI Tool Graph (Dark #0D1017 Hub + 5 Pulsing Tool Nodes)          */
    /* ------------------------------------------------------------------ */
    case "ai-tool-graph": {
      const bg = override ? override.bg : "#0D1017";
      const accent = override ? override.accent : "#00EC97";
      const blue = override ? override.secondary : "#4C82FF";

      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Dot grid
      ctx.fillStyle = "rgba(168, 192, 240, 0.14)";
      for (let x = 24; x < w; x += 28) {
        for (let y = 24; y < h; y += 28) {
          ctx.fillRect(x, y, 1.5, 1.5);
        }
      }

      // Top assistant bar
      ctx.fillStyle = "#161B28";
      drawRoundedRect(ctx, w * 0.18, 28, w * 0.64, 48, 999);
      ctx.fill();
      ctx.strokeStyle = "rgba(168, 192, 240, 0.25)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#E2ECFF";
      ctx.font = `500 16px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`> ${safeHeadline}`, w * 0.5, 52);

      const hub = { x: w * 0.34, y: h * 0.55 };
      const tools = [
        { x: w * 0.14, y: h * 0.32, label: "[Images]" },
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

        // Moving packet along wire
        const pktT = (timeSec * 0.9 + ti * 0.21) % 1;
        const px = hub.x + (tl.x - hub.x) * pktT;
        const py = hub.y + (tl.y - hub.y) * pktT;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#151C2B";
        drawRoundedRect(ctx, tl.x - 72, tl.y - 20, 144, 40, 10);
        ctx.fill();
        ctx.strokeStyle = ti === beatIndex % tools.length ? accent : blue;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = "#F4F6FB";
        ctx.font = `600 13px ${monoFont}`;
        ctx.fillText(tl.label, tl.x, tl.y);
      });

      // Central Hub
      ctx.fillStyle = blue;
      ctx.beginPath();
      ctx.arc(hub.x, hub.y, 44 + pulse * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 16px ${monoFont}`;
      ctx.fillText("AGENT HUB", hub.x, hub.y);

      // Right Preview Card
      const cardP = easeOutCubic(clamp01((progress - 0.15) / 0.3));
      ctx.fillStyle = "#121826";
      drawRoundedRect(ctx, w * 0.64, h * 0.24, w * 0.3, h * 0.56 * cardP + 80, 18);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = accent;
      ctx.font = `700 13px ${monoFont}`;
      ctx.textAlign = "left";
      ctx.fillText("LIVE PREVIEW · OUTLAYER TEE", w * 0.665, h * 0.31);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `700 22px ${sansFont}`;
      ctx.fillText("$12.00 Safe Intent", w * 0.665, h * 0.42);
      ctx.fillStyle = "#F87171";
      ctx.fillText("$45.00 Drain Blocked", w * 0.665, h * 0.52);
      break;
    }

    /* ------------------------------------------------------------------ */
    /* 6. Molote Parche 2 (120 BPM · 12fps On-Twos Torn Paper Stop-Motion) */
    /* ------------------------------------------------------------------ */
    case "molote-parche": {
      // Quantize time to 12fps on-twos for crisp stop-motion feel
      const steppedTime = Math.floor(timeSec * 12) / 12;
      const stepBeat = Math.floor(steppedTime / beatDur);
      const vermilion = override ? override.accent : "#F05A28";
      const green = override ? override.secondary : "#3BA55C";
      const cream = override ? override.bg : "#F6F0E2";

      ctx.fillStyle = stepBeat % 2 === 0 ? cream : "#EFE6D2";
      ctx.fillRect(0, 0, w, h);

      // Torn paper blocks
      ctx.save();
      ctx.translate(w * 0.24, h * 0.5);
      ctx.rotate(stepBeat % 2 === 0 ? -0.06 : 0.04);
      ctx.fillStyle = vermilion;
      ctx.fillRect(-170, -180, 340, 360);
      ctx.restore();

      ctx.save();
      ctx.translate(w * 0.72, h * 0.52);
      ctx.rotate(stepBeat % 2 === 0 ? 0.05 : -0.04);
      ctx.fillStyle = green;
      ctx.fillRect(-170, -160, 340, 320);
      ctx.restore();

      // Embossed black label-maker tape strip
      ctx.save();
      ctx.translate(w * 0.5, h * 0.24);
      ctx.rotate(-0.02);
      ctx.fillStyle = "#161614";
      ctx.fillRect(-260, -26, 520, 52);
      ctx.fillStyle = "#F6F0E2";
      ctx.font = `700 22px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(safeHeadline.toUpperCase().slice(0, 34), 0, 0);
      ctx.restore();

      // L O U D paper cutouts
      const letters = ["L", "O", "U", "D"];
      letters.forEach((lt, li) => {
        const lx = w * 0.28 + li * (w * 0.145);
        const ly = h * 0.54 + ((li + stepBeat) % 2 === 0 ? -12 : 12);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(((li % 2 === 0 ? 1 : -1) * 0.08) + ((stepBeat % 3) - 1) * 0.04);
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(-52, -62, 104, 124);
        ctx.strokeStyle = "#161614";
        ctx.lineWidth = 4;
        ctx.strokeRect(-52, -62, 104, 124);
        ctx.fillStyle = "#161614";
        ctx.font = `700 76px ${displayFont}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lt, 0, 4);
        ctx.restore();
      });

      // 11.21 drop pill
      ctx.fillStyle = "#161614";
      drawRoundedRect(ctx, w * 0.4, h * 0.8, w * 0.2, 46, 999);
      ctx.fill();
      ctx.fillStyle = cream;
      ctx.font = `700 20px ${monoFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("11.21 DROP", w * 0.5, h * 0.8 + 23);
      break;
    }

    /* ------------------------------------------------------------------ */
    /* 7. ONE design Sting (108 BPM Cursor "you" + Morph + Tomato Wipe)   */
    /* ------------------------------------------------------------------ */
    case "one-design-sting": {
      const stone = override ? override.bg : "#F5F3EE";
      const charcoal = override ? override.fg : "#1E1E1E";
      const violet = override ? override.accent : "#5B3FD6";
      const tomato = override ? override.secondary : "#E5483A";

      ctx.fillStyle = stone;
      ctx.fillRect(0, 0, w, h);

      // Phase A: Morphing shapes into ONE
      const morphP = easeOutCubic(clamp01(progress / 0.58));
      ctx.fillStyle = charcoal;
      ctx.font = `700 ${Math.round(h * 0.28)}px ${displayFont}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("ONE", w * 0.5, h * 0.48);

      ctx.fillStyle = violet;
      ctx.font = `italic 500 ${Math.round(h * 0.14)}px ${serifFont}`;
      ctx.fillText("design", w * 0.5, h * 0.68);

      // Animated "you" cursor drawing circle -> square
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

      // Phase B: Tomato wipe to Violet lockup
      if (progress > 0.62) {
        const wipe = easeOutCubic((progress - 0.62) / 0.22);
        ctx.fillStyle = tomato;
        ctx.fillRect(0, 0, w * wipe, h);

        if (progress > 0.74) {
          const lockWipe = easeOutCubic((progress - 0.74) / 0.18);
          ctx.fillStyle = violet;
          ctx.fillRect(0, 0, w * lockWipe, h);
          if (lockWipe > 0.5) {
            ctx.fillStyle = "#FFFFFF";
            ctx.font = `700 ${Math.round(h * 0.11)}px ${displayFont}`;
            ctx.fillText(safeHeadline.toUpperCase().slice(0, 32), w * 0.5, h * 0.46);
            ctx.font = `italic 500 32px ${serifFont}`;
            ctx.fillText("Agentes NEAR · Confidential Studio", w * 0.5, h * 0.62);
          }
        }
      }
      break;
    }
  }

  ctx.restore();
}

export function AgentMotionStudio() {
  const [templateId, setTemplateId] = useState<MotionTemplateId>("things-moving");
  const activePreset = useMemo(
    () => MOTION_PRESETS.find((p) => p.id === templateId) ?? MOTION_PRESETS[0]!,
    [templateId],
  );

  const [isPlaying, setIsPlaying] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [bpm, setBpm] = useState(activePreset.defaultBpm);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("preset");
  const [headline, setHeadline] = useState(activePreset.defaultHeadline);
  const [timeSec, setTimeSec] = useState(0);
  const [directorNote, setDirectorNote] = useState(activePreset.directorNote);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastBeatIndexRef = useRef(-1);
  const timeRef = useRef(0);

  const selectPreset = (preset: MotionPresetMeta) => {
    setTemplateId(preset.id);
    setBpm(preset.defaultBpm);
    setHeadline(preset.defaultHeadline);
    setDirectorNote(preset.directorNote);
    timeRef.current = 0;
    lastBeatIndexRef.current = -1;
    setTimeSec(0);
    setIsPlaying(true);
  };

  const applyAutoDirect = (item: (typeof AUTO_DIRECT_PROMPTS)[number]) => {
    const preset = MOTION_PRESETS.find((p) => p.id === item.presetId) ?? MOTION_PRESETS[0]!;
    setTemplateId(preset.id);
    setBpm(item.bpm);
    setPaletteMode(item.palette);
    setHeadline(item.headline);
    setDirectorNote(`AI Auto-Direct: "${item.label}" -> ${preset.name} @ ${item.bpm} BPM`);
    timeRef.current = 0;
    lastBeatIndexRef.current = -1;
    setTimeSec(0);
    setIsPlaying(true);
  };

  const toggleSound = () => {
    if (!soundOn) {
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

    const draw = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - lastNow) / 1000));
      lastNow = now;

      if (isPlaying && !reducedMotion) {
        const nextT = Math.max(0, (timeRef.current + dt) % activePreset.durationSec);
        timeRef.current = nextT;
        setTimeSec(nextT);

        const beatIdx = Math.max(0, Math.floor(nextT / (60 / Math.max(60, bpm))));
        if (beatIdx !== lastBeatIndexRef.current) {
          lastBeatIndexRef.current = beatIdx;
          if (soundOn && audioCtxRef.current) {
            playSynthBeat(audioCtxRef.current, beatIdx, templateId);
          }
        }
      }

      renderMotionFrame(
        ctx,
        width,
        height,
        templateId,
        timeRef.current,
        activePreset.durationSec,
        bpm,
        headline,
        paletteMode,
      );

      if (isPlaying && !reducedMotion) {
        raf = window.requestAnimationFrame(draw);
      }
    };

    renderMotionFrame(
      ctx,
      width,
      height,
      templateId,
      timeRef.current,
      activePreset.durationSec,
      bpm,
      headline,
      paletteMode,
    );

    if (isPlaying && !reducedMotion) {
      raf = window.requestAnimationFrame(draw);
    }

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [activePreset.durationSec, bpm, headline, isPlaying, paletteMode, soundOn, templateId]);

  const beatNumber = Math.floor(timeSec / (60 / Math.max(60, bpm))) + 1;

  return (
    <div className="ams-studio" data-testid="agent-motion-studio">
      {/* AI Agent Auto-Direct Prompt Bar */}
      <div className="ams-autodirect">
        <span className="ams-autodirect__label">AI Agent Auto-Direct:</span>
        <div className="ams-autodirect__chips">
          {AUTO_DIRECT_PROMPTS.map((item) => (
            <button
              key={item.label}
              type="button"
              className="ams-prompt-chip"
              aria-pressed={templateId === item.presetId && headline === item.headline}
              onClick={() => applyAutoDirect(item)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* 7 Template Switcher Pills */}
      <div className="ams-presets" role="tablist" aria-label="7 Agentic Motion Presets">
        {MOTION_PRESETS.map((preset, idx) => (
          <button
            key={preset.id}
            type="button"
            role="tab"
            className="ams-preset-btn"
            aria-selected={templateId === preset.id}
            onClick={() => selectPreset(preset)}
          >
            <span className="ams-preset-num">0{idx + 1}</span>
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
          <canvas
            ref={canvasRef}
            className="ams-canvas"
            aria-label={`${activePreset.name} interactive motion preview`}
          />
          <div className="ams-stage-meta">
            <span>
              {activePreset.name} · Beat #{beatNumber} ({bpm} BPM)
            </span>
            <span>{directorNote}</span>
          </div>
        </div>

        <DitherCard tone="blue" padding="md" className="ams-controls">
          <div className="ams-ctrl-group">
            <label className="ams-ctrl-label" htmlFor="ams-headline-input">
              Live Headline / Brand Phrase
            </label>
            <input
              id="ams-headline-input"
              type="text"
              className="ams-input"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
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
                <option value="preset">Preset Native</option>
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
                <option value={112}>112 BPM</option>
                <option value={116}>116 BPM</option>
                <option value={120}>120 BPM</option>
              </select>
            </div>
          </div>

          <div className="ams-ctrl-group">
            <div className="ams-scrub-head">
              <span className="ams-ctrl-label">Timeline Scrubber</span>
              <span className="ams-scrub-time">
                {timeSec.toFixed(1)}s / {activePreset.durationSec.toFixed(1)}s
              </span>
            </div>
            <input
              type="range"
              aria-label="Motion timeline scrubber"
              className="ams-scrubber"
              min={0}
              max={activePreset.durationSec}
              step={0.05}
              value={timeSec}
              onChange={(e) => {
                const next = Number(e.target.value);
                timeRef.current = next;
                setTimeSec(next);
                setIsPlaying(false);
              }}
            />
          </div>

          <div className="ams-btn-bar">
            <DitherButton
              tone="mint"
              size="sm"
              onClick={() => setIsPlaying((p) => !p)}
            >
              {isPlaying ? "Pause" : "Play"}
            </DitherButton>
            <DitherButton
              variant="secondary"
              size="sm"
              onClick={() => {
                timeRef.current = 0;
                lastBeatIndexRef.current = -1;
                setTimeSec(0);
                setIsPlaying(true);
              }}
            >
              Restart Beat
            </DitherButton>
            <DitherButton
              variant={soundOn ? "primary" : "secondary"}
              tone={soundOn ? "purple" : "grey"}
              size="sm"
              onClick={toggleSound}
              data-testid="ams-sound-toggle"
            >
              {soundOn ? "Sound On (Web Audio)" : "Sound Muted"}
            </DitherButton>
          </div>
        </DitherCard>
      </div>
    </div>
  );
}
