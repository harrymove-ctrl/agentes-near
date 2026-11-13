import { describe, expect, test } from "bun:test";
import { renderSound, SAMPLE_RATE, SOUND_STYLES, SOUNDS, wavBytes } from "../src/sfx/synth";

describe("synthesized sounds", () => {
  for (const style of SOUND_STYLES)
    test(`${style}: every sound is short, finite, below full scale, and silent at both ends`, () => {
      for (const name of SOUNDS) {
        const x = renderSound(style, name);
        const seconds = x.length / SAMPLE_RATE;
        expect(seconds).toBeGreaterThan(0.03);
        expect(seconds).toBeLessThan(1.6);
        let peak = 0;
        for (const v of x) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
        expect(peak).toBeGreaterThan(0.3);
        expect(peak).toBeLessThan(0.9);
        expect(Math.abs(x[0] as number)).toBeLessThan(1e-3);
        expect(Math.abs(x[x.length - 1] as number)).toBeLessThan(1e-3);
      }
    });

  test("the same sound renders the same samples every time (every device hears the same)", () => {
    expect(renderSound("tactile", "attention")).toEqual(renderSound("tactile", "attention"));
  });

  test("the styles sound different", () => {
    const a = renderSound("tactile", "reply");
    const b = renderSound("sky", "reply");
    expect(a.length === b.length && a.every((v, i) => v === b[i])).toBe(false);
  });

  test("a WAV: 16-bit mono PCM at the sample rate, the samples after a 44-byte header", () => {
    const samples = new Float32Array([0, 0.5, -1, 1]);
    const bytes = wavBytes(samples);
    const view = new DataView(bytes.buffer);
    const ascii = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint32(40, true)).toBe(8);
    expect(bytes.length).toBe(52);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 16384, -32767, 32767]);
  });
});
