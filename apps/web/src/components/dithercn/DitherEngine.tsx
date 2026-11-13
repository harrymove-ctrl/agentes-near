import { useEffect, useRef } from "react";

export type DitherSceneVariant =
  | "horizon"
  | "aurora"
  | "plasma"
  | "waves"
  | "dither-orb";

export type BayerOrder = 4 | 8;

export type DitherColorTone =
  | "blue"
  | "green"
  | "pink"
  | "orange"
  | "purple"
  | "grey"
  | "cobalt"
  | "mint";

export interface DitherSceneProps {
  scene?: DitherSceneVariant;
  bayerOrder?: BayerOrder;
  pixelScale?: number;
  speed?: number;
  interactive?: boolean;
  paused?: boolean;
  palette?: Array<[number, number, number]>;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}

export const BAYER_4X4: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export const BAYER_8X8: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

export function bayerThreshold(x: number, y: number, order: BayerOrder = 4): number {
  if (order === 8) {
    const row = BAYER_8X8[y & 7] ?? BAYER_8X8[0]!;
    return ((row[x & 7] ?? 0) + 0.5) / 64;
  }
  const row = BAYER_4X4[y & 3] ?? BAYER_4X4[0]!;
  return ((row[x & 3] ?? 0) + 0.5) / 16;
}

export const DITHER_TONE_HEX: Record<DitherColorTone, { accent: string; soft: string; rgb: [number, number, number] }> = {
  blue: { accent: "#5b8eff", soft: "rgba(91, 142, 255, 0.22)", rgb: [91, 142, 255] },
  cobalt: { accent: "#3b6df5", soft: "rgba(59, 109, 245, 0.22)", rgb: [59, 109, 245] },
  green: { accent: "#22c55e", soft: "rgba(34, 197, 94, 0.22)", rgb: [34, 197, 94] },
  mint: { accent: "#00ec97", soft: "rgba(0, 236, 151, 0.22)", rgb: [0, 236, 151] },
  pink: { accent: "#f472b6", soft: "rgba(244, 114, 182, 0.22)", rgb: [244, 114, 182] },
  orange: { accent: "#fb923c", soft: "rgba(251, 146, 60, 0.22)", rgb: [251, 146, 60] },
  purple: { accent: "#a78bfa", soft: "rgba(167, 139, 250, 0.22)", rgb: [167, 139, 250] },
  grey: { accent: "#94a3b8", soft: "rgba(148, 163, 184, 0.22)", rgb: [148, 163, 184] },
};

export const SCENE_PALETTES: Record<DitherSceneVariant, Array<[number, number, number]>> = {
  horizon: [
    [6, 9, 18],
    [13, 24, 52],
    [25, 51, 110],
    [52, 92, 178],
    [124, 162, 230],
    [234, 188, 138],
  ],
  aurora: [
    [5, 8, 14],
    [8, 28, 34],
    [10, 62, 68],
    [14, 128, 110],
    [0, 214, 150],
    [166, 252, 218],
  ],
  plasma: [
    [7, 6, 16],
    [24, 16, 60],
    [64, 34, 136],
    [122, 68, 214],
    [194, 98, 224],
    [244, 188, 255],
  ],
  waves: [
    [6, 10, 20],
    [12, 28, 62],
    [22, 60, 124],
    [42, 108, 186],
    [98, 166, 232],
    [214, 236, 255],
  ],
  "dither-orb": [
    [5, 7, 14],
    [12, 22, 48],
    [24, 54, 124],
    [48, 108, 228],
    [118, 182, 255],
    [240, 248, 255],
  ],
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 0.9999 ? 0.9999 : v;
}

function evaluateSceneTone(
  scene: DitherSceneVariant,
  nx: number,
  ny: number,
  t: number,
  px: number,
  py: number,
): number {
  const dx = nx - px;
  const dy = ny - py;
  const pointerPull = Math.exp(-(dx * dx + dy * dy) * 7.5) * 0.22;

  switch (scene) {
    case "horizon": {
      const horizonY = 0.64 + Math.sin(nx * 3.1 + t * 0.45) * 0.025;
      const band = Math.exp(-Math.pow((ny - horizonY) * 4.2, 2));
      const sunX = 0.68 + (px - 0.5) * 0.16;
      const sunY = horizonY - 0.09 + (py - 0.5) * 0.08;
      const sunDist = Math.hypot((nx - sunX) * 1.45, ny - sunY);
      const sunGlow = Math.exp(-sunDist * 4.4) * 0.72;
      const skyWave = Math.sin(nx * 4.8 + t * 0.55) * Math.cos(ny * 3.6 - t * 0.35) * 0.14;
      const reflection =
        ny > horizonY
          ? Math.exp(-(ny - horizonY) * 5.2) *
            (0.45 + 0.4 * Math.sin(nx * 18 + t * 1.6) * Math.cos(ny * 36 - t * 2.1))
          : 0;
      const base = ny < horizonY ? (1 - ny / horizonY) * 0.42 + band * 0.55 : band * 0.48 + reflection * 0.45;
      return clamp01(base + sunGlow + skyWave + pointerPull * 0.8);
    }

    case "aurora": {
      const curtain1 = Math.sin(nx * 6.5 + t * 0.7 + Math.sin(ny * 4.2 - t * 0.4));
      const curtain2 = Math.cos(nx * 4.1 - t * 0.5 + ny * 3.1);
      const ribbon = Math.exp(-Math.pow((ny - (0.36 + curtain1 * 0.14 + (py - 0.5) * 0.12)) * 4.8, 2));
      const ribbon2 = Math.exp(-Math.pow((ny - (0.54 + curtain2 * 0.12)) * 5.6, 2));
      const verticalFade = Math.max(0, 1 - ny * 0.82);
      const shimmer = 0.5 + 0.5 * Math.sin(nx * 14 + ny * 8 - t * 1.4);
      return clamp01(
        verticalFade * 0.24 +
          ribbon * (0.48 + shimmer * 0.26) +
          ribbon2 * 0.34 +
          pointerPull * 0.9,
      );
    }

    case "plasma": {
      const cx = 0.5 + (px - 0.5) * 0.24;
      const cy = 0.5 + (py - 0.5) * 0.24;
      const v1 = Math.sin(nx * 7.2 + t * 1.1);
      const v2 = Math.sin((ny * 6.4 - t * 0.85) + Math.cos(nx * 4.1 + t * 0.6));
      const v3 = Math.sin(Math.hypot(nx - cx, ny - cy) * 12.0 - t * 1.5);
      const combined = (v1 + v2 + v3 + 3) / 6;
      const vignette = 1 - Math.hypot(nx - 0.5, ny - 0.5) * 0.48;
      return clamp01(combined * 0.85 * vignette + pointerPull * 0.7);
    }

    case "waves": {
      let ridgeSum = 0;
      for (let i = 0; i < 4; i++) {
        const yTarget = 0.28 + i * 0.16 + Math.sin(nx * (4.2 + i * 1.1) + t * (0.7 + i * 0.22) + i) * 0.06;
        const crest = Math.exp(-Math.pow((ny - yTarget) * 11, 2));
        ridgeSum += crest * (0.42 - i * 0.05);
      }
      const deepCurrent = (1 - ny) * 0.28 + Math.sin(nx * 9 - ny * 5 + t) * 0.08;
      return clamp01(deepCurrent + ridgeSum + pointerPull);
    }

    case "dither-orb": {
      const ox = 0.5 + Math.sin(t * 0.45) * 0.06 + (px - 0.5) * 0.25;
      const oy = 0.48 + Math.cos(t * 0.38) * 0.05 + (py - 0.5) * 0.25;
      const r = Math.hypot((nx - ox) * 1.35, ny - oy);
      const core = Math.exp(-r * r * 11.5);
      const halo = Math.exp(-Math.pow((r - 0.27) * 8.2, 2)) * 0.52;
      const ripple = (0.5 + 0.5 * Math.sin(r * 22 - t * 2.1)) * Math.exp(-r * 3.4) * 0.28;
      return clamp01(core * 0.92 + halo + ripple + pointerPull * 0.45);
    }
  }
}

export function DitherScene({
  scene = "horizon",
  bayerOrder = 8,
  pixelScale = 4,
  speed = 1,
  interactive = true,
  paused = false,
  palette,
  className,
  style,
  ariaLabel,
}: DitherSceneProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerTarget = useRef({ x: 0.62, y: 0.38 });
  const pointerCurrent = useRef({ x: 0.62, y: 0.38 });
  const isVisibleRef = useRef(true);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const colors = palette && palette.length >= 2 ? palette : SCENE_PALETTES[scene];
    const scale = Math.max(2, Math.min(8, Math.round(pixelScale)));
    let width = 120;
    let height = 80;
    let imgData = ctx.createImageData(width, height);
    let raf = 0;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const nextW = Math.max(64, Math.min(480, Math.ceil((rect.width || 640) / scale)));
      const nextH = Math.max(48, Math.min(320, Math.ceil((rect.height || 360) / scale)));
      if (nextW !== width || nextH !== height) {
        width = nextW;
        height = nextH;
        canvas.width = width;
        canvas.height = height;
        imgData = ctx.createImageData(width, height);
      }
    };

    const drawFrame = (timeMs: number) => {
      const t = timeMs * 0.0007 * speed;
      const cur = pointerCurrent.current;
      const tgt = pointerTarget.current;
      cur.x += (tgt.x - cur.x) * 0.09;
      cur.y += (tgt.y - cur.y) * 0.09;

      const data = imgData.data;
      const maxStop = colors.length - 1;
      const invW = 1 / width;
      const invH = 1 / height;

      for (let y = 0; y < height; y++) {
        const ny = (y + 0.5) * invH;
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
          const nx = (x + 0.5) * invW;
          const tone = evaluateSceneTone(scene, nx, ny, t, cur.x, cur.y);
          const scaled = tone * maxStop;
          const baseIdx = Math.floor(scaled);
          const frac = scaled - baseIdx;
          const threshold = bayerThreshold(x, y, bayerOrder);
          const stopIdx = Math.min(maxStop, baseIdx + (frac > threshold ? 1 : 0));
          const rgb = colors[stopIdx] ?? colors[0]!;
          const p = (rowOffset + x) * 4;
          data[p] = rgb[0];
          data[p + 1] = rgb[1];
          data[p + 2] = rgb[2];
          data[p + 3] = 255;
        }
      }

      ctx.putImageData(imgData, 0, 0);
    };

    resize();
    drawFrame(1400);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ro = new ResizeObserver(() => {
      resize();
      if (reducedMotion || paused) {
        drawFrame(1400);
      }
    });
    ro.observe(wrap);

    const io = new IntersectionObserver(
      (entries) => {
        isVisibleRef.current = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0.01 },
    );
    io.observe(wrap);

    if (!reducedMotion && !paused) {
      let lastDraw = 0;
      const loop = (now: number) => {
        if (isVisibleRef.current && !document.hidden && now - lastDraw >= 32) {
          lastDraw = now;
          drawFrame(now);
        }
        raf = window.requestAnimationFrame(loop);
      };
      raf = window.requestAnimationFrame(loop);
    }

    return () => {
      ro.disconnect();
      io.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [scene, bayerOrder, pixelScale, speed, paused, palette]);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    pointerTarget.current = {
      x: Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height)),
    };
  };

  return (
    <div
      ref={wrapRef}
      className={className ? `dcn-scene ${className}` : "dcn-scene"}
      style={style}
      onPointerMove={handlePointerMove}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <canvas ref={canvasRef} className="dcn-scene-canvas" />
    </div>
  );
}
