import React, { useEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";

export type BayerSceneMode = "horizon" | "aurora" | "waves" | "shield" | "night-sky";

interface BayerDitherBackdropProps {
  mode: BayerSceneMode;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  opacity?: number;
}

// Standard 8x8 Bayer ordered dithering threshold matrix (0..63)
const BAYER_8X8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const num = parseInt(clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function hash2d(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

/**
 * Deterministic 60 FPS ordered 8x8 Bayer dither canvas inspired by dithercn.dev and updates.css.
 * Renders onto a crisp 384x216 pixel lattice scaled cleanly with pixelated rendering.
 */
export const BayerDitherBackdrop: React.FC<BayerDitherBackdropProps> = ({
  mode,
  primaryColor = "#5aa8ff",
  secondaryColor = "#00ec97",
  accentColor = "#8fb2f5",
  opacity = 0.92,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const W = 384;
  const H = 216;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = ctx.createImageData(W, H);
    const data = img.data;
    const t = frame / fps;

    const baseRgb: [number, number, number] = [5, 6, 10];
    const deepRgb: [number, number, number] = [9, 18, 46];
    const pRgb = hexToRgb(primaryColor);
    const sRgb = hexToRgb(secondaryColor);
    const aRgb = hexToRgb(accentColor);

    for (let y = 0; y < H; y++) {
      const ny = y / H;
      const by = (y & 7) * 8;
      for (let x = 0; x < W; x++) {
        const nx = x / W;
        const threshold = (BAYER_8X8[by + (x & 7)] + 0.5) / 64.0;

        let intensity = 0.0;
        let mixSec = 0.0;

        if (mode === "horizon") {
          // Sweeping night horizon + dual sine mountain ridge
          const ridge =
            0.56 +
            0.08 * Math.sin(nx * 5.4 + t * 0.45) +
            0.04 * Math.cos(nx * 11.2 - t * 0.32);
          const dist = ny - ridge;
          const glow = Math.exp(-Math.pow((ny - ridge) * 5.8, 2));
          const sunDx = nx - 0.72;
          const sunDy = (ny - 0.28) * 1.77;
          const sun = Math.exp(-(sunDx * sunDx + sunDy * sunDy) * 11.0) * 0.78;
          const below = dist > 0 ? Math.max(0.08, 0.55 - dist * 1.1) : 0.0;
          const stars =
            dist < -0.05 && hash2d(x, y) > 0.994
              ? 0.5 + 0.5 * Math.sin(t * 2.2 + x * 0.3)
              : 0;
          intensity = Math.min(1.0, glow * 0.85 + sun + below + stars * 0.65);
          mixSec = Math.min(1.0, Math.max(0.0, sun * 0.9 + (dist > 0 ? 0.35 : 0.1)));
        } else if (mode === "aurora") {
          const band1 = Math.sin(nx * 4.5 + t * 0.65 + Math.cos(ny * 3.8 - t * 0.4));
          const band2 = Math.cos(nx * 3.1 - t * 0.45 + ny * 5.0);
          const ribbon = Math.exp(-Math.pow((ny - 0.42 - band1 * 0.14) * 5.2, 2));
          const ribbon2 = Math.exp(-Math.pow((ny - 0.58 - band2 * 0.12) * 6.0, 2));
          intensity = Math.min(1.0, 0.16 + ribbon * 0.72 + ribbon2 * 0.52);
          mixSec = Math.min(1.0, ribbon2 / Math.max(0.15, ribbon + ribbon2));
        } else if (mode === "waves") {
          const w1 = Math.sin(nx * 12.0 + t * 1.3 + Math.sin(ny * 8.0 - t * 0.7));
          const w2 = Math.cos(ny * 10.0 - t * 0.9 + Math.cos(nx * 7.0 + t * 0.5));
          const v = (w1 + w2) * 0.25 + 0.5;
          intensity = Math.min(1.0, 0.12 + v * 0.56);
          mixSec = Math.max(0, Math.min(1, 0.5 + 0.45 * Math.sin(nx * 6.0 - t)));
        } else if (mode === "shield") {
          const dx = nx - 0.5;
          const dy = (ny - 0.5) * 0.5625;
          const rad = Math.sqrt(dx * dx + dy * dy);
          const ring = Math.exp(-Math.pow((rad - (0.28 + 0.03 * Math.sin(t * 2.0))) * 14.0, 2));
          const core = Math.exp(-rad * rad * 18.0) * 0.65;
          intensity = Math.min(1.0, 0.14 + core + ring * 0.85);
          mixSec = rad > 0.26 ? 0.85 : 0.15;
        } else {
          // night-sky: updates.css inspired dithered radial nebula + crisp starfield
          const dx = nx - 0.5;
          const dy = (ny - 0.42) * 0.5625;
          const rad = Math.sqrt(dx * dx + dy * dy);
          const nebula = Math.exp(-rad * rad * 4.5) * 0.68;
          const twinkle =
            hash2d(x, y) > 0.992 ? 0.45 + 0.55 * Math.sin(t * 1.9 + x * 0.7 + y) : 0;
          intensity = Math.min(1.0, 0.12 + nebula + twinkle * 0.8);
          mixSec = Math.min(1.0, Math.max(0.0, 0.25 + 0.35 * Math.sin(nx * 3.0 + t * 0.4)));
        }

        // Quantize with 8x8 Bayer threshold
        const lit = intensity > threshold;
        const mid = intensity * 0.62 > threshold;

        let r = baseRgb[0];
        let g = baseRgb[1];
        let b = baseRgb[2];

        if (lit) {
          const blendR = pRgb[0] * (1 - mixSec) + sRgb[0] * mixSec;
          const blendG = pRgb[1] * (1 - mixSec) + sRgb[1] * mixSec;
          const blendB = pRgb[2] * (1 - mixSec) + sRgb[2] * mixSec;
          const gain = intensity > 0.72 ? 0.78 : 0.44;
          r = Math.round(deepRgb[0] * (1 - gain) + blendR * gain);
          g = Math.round(deepRgb[1] * (1 - gain) + blendG * gain);
          b = Math.round(deepRgb[2] * (1 - gain) + blendB * gain);
        } else if (mid) {
          r = Math.round(baseRgb[0] * 0.5 + aRgb[0] * 0.16);
          g = Math.round(baseRgb[1] * 0.5 + aRgb[1] * 0.16);
          b = Math.round(baseRgb[2] * 0.5 + aRgb[2] * 0.16);
        } else {
          r = Math.round(baseRgb[0] + deepRgb[0] * 0.35 * (1 - ny));
          g = Math.round(baseRgb[1] + deepRgb[1] * 0.35 * (1 - ny));
          b = Math.round(baseRgb[2] + deepRgb[2] * 0.35 * (1 - ny));
        }

        const idx = (y * W + x) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
  }, [frame, fps, mode, primaryColor, secondaryColor, accentColor]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", backgroundColor: "#05060a" }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          imageRendering: "pixelated",
          opacity,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(110% 85% at 50% 42%, rgba(5,6,10,0.08) 0%, rgba(5,6,10,0.52) 72%, rgba(5,6,10,0.88) 100%)",
        }}
      />
    </div>
  );
};
