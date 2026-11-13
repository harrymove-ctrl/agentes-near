import { type CSSProperties, type KeyboardEvent, type PointerEvent, useState } from "react";
import { gradientOf, hexToHsv, hsvToHex, isHexColor, pickerStart } from "../agent/engine.js";

export interface ColorPickerLabels {
  /** The saturation/brightness area's name. */
  area: string;
  hue: string;
  hex: string;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Our color picker (never the browser's dialog): a saturation/brightness area, a hue slider, a hex field and a
 * preview tile in the agent's shape painted as the color will really show (`gradientOf`, contrast-clamped).
 * Starts from the current color (a preset's own tone). Arrows move the area and the slider (Shift: 10×); Enter
 * applies the color shown, even untouched, then calls `onDone`.
 */
export function ColorPicker({
  value,
  onChange,
  onDone,
  labels,
}: {
  value: string;
  onChange: (hex: `#${string}`) => void;
  onDone?: () => void;
  labels: ColorPickerLabels;
}) {
  // Hue and saturation are kept here: a gray or black hex alone would forget them.
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(pickerStart(value)));
  const [text, setText] = useState<string>(() => pickerStart(value));
  const set = (next: [number, number, number]) => {
    setHsv(next);
    const hex = hsvToHex(...next);
    setText(hex);
    onChange(hex as `#${string}`);
  };
  const [h, s, v] = hsv;
  const hex = hsvToHex(h, s, v);
  const [top, bottom] = gradientOf(hex);

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    set([h, clamp01((e.clientX - r.left) / r.width), clamp01(1 - (e.clientY - r.top) / r.height)]);
  };
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onChange(hex as `#${string}`);
      onDone?.();
    }
  };
  const areaKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const d = move[e.key];
    if (!d) return enter(e);
    e.preventDefault();
    set([h, clamp01(s + d[0]), clamp01(v + d[1])]);
  };
  const hueKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (
      e.shiftKey &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")
    ) {
      e.preventDefault();
      const up = e.key === "ArrowRight" || e.key === "ArrowUp";
      set([(h + (up ? 10 : 350)) % 360, s, v]);
      return;
    }
    enter(e);
  };

  return (
    <div className="ac-color">
      <div
        className="ac-color__area"
        role="slider"
        tabIndex={0}
        aria-label={labels.area}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(s * 100)}
        aria-valuetext={`${Math.round(s * 100)}%, ${Math.round(v * 100)}%`}
        style={{ "--hue": `hsl(${h} 100% 50%)` } as CSSProperties}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e);
        }}
        onKeyDown={areaKey}
      >
        <span className="ac-color__thumb" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: hex }} />
      </div>
      <input
        className="ac-color__hue"
        type="range"
        min={0}
        max={359}
        step={1}
        value={Math.round(h)}
        aria-label={labels.hue}
        onChange={(e) => set([Number(e.target.value), s, v])}
        onKeyDown={hueKey}
      />
      <div className="ac-color__foot">
        <span className="ac-color__tile" style={{ background: `linear-gradient(170deg, ${top}, ${bottom})` }} />
        <input
          className="ac-input ac-color__hex"
          aria-label={labels.hex}
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            const raw = e.target.value.trim();
            const next = raw.startsWith("#") ? raw : `#${raw}`;
            setText(next);
            if (isHexColor(next)) {
              setHsv(hexToHsv(next));
              onChange(next.toLowerCase() as `#${string}`);
            }
          }}
          onBlur={() => setText(hex)}
          onKeyDown={enter}
        />
      </div>
    </div>
  );
}
