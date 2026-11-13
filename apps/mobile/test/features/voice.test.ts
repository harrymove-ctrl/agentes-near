import { describe, expect, test } from "bun:test";
import { VOICE_MAX_MS } from "@agenteschat/client/lib/voice";
import { hidesBody } from "../../src/features/chat/logic";
import {
  hasWords,
  levelOf,
  nextSpeed,
  peaksOf,
  retryDelayMs,
  secondsLeft,
  slideIntent,
  uploadVerdict,
} from "../../src/features/voice/logic";
import { joinM4a } from "../../src/features/voice/m4a";

const u32 = (...v: number[]) => {
  const out = new Uint8Array(v.length * 4);
  const d = new DataView(out.buffer);
  v.forEach((n, i) => {
    d.setUint32(i * 4, n);
  });
  return out;
};
function box(type: string, ...parts: Uint8Array[]) {
  const size = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An AAC file reduced to what the join reads: samples of `sizes` bytes filled with `fill`, 1024 ticks each. */
function m4a(sizes: number[], fill: number) {
  const ftyp = box("ftyp", new TextEncoder().encode("M4A "));
  const stsd = box("stsd", u32(0, 0));
  const tables = (at: number) =>
    box(
      "stbl",
      stsd,
      box("stts", u32(0, 1, sizes.length, 1024)),
      box("stsc", u32(0, 1, 1, sizes.length, 1)),
      box("stsz", u32(0, 0, sizes.length, ...sizes)),
      box("stco", u32(0, 1, at)),
    );
  const moov = (at: number) =>
    box(
      "moov",
      box("mvhd", u32(0, 0, 0, 1000, 0)),
      box(
        "trak",
        box("tkhd", u32(0, 0, 0, 1, 0, 0)),
        box("edts", u32(0)),
        box("mdia", box("mdhd", u32(0, 0, 0, 44_100, 0)), box("minf", tables(at))),
      ),
    );
  const dataAt = ftyp.length + moov(0).length + 8;
  const total = sizes.reduce((s, n) => s + n, 0);
  const mdat = box("mdat", new Uint8Array(total).fill(fill));
  const out = new Uint8Array(ftyp.length + moov(0).length + mdat.length);
  out.set(ftyp, 0);
  out.set(moov(dataAt), ftyp.length);
  out.set(mdat, ftyp.length + moov(0).length);
  return out;
}

const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("voice gestures and wave", () => {
  test("sliding far enough deletes or locks, and deleting wins", () => {
    expect(slideIntent(-40, -20)).toBeNull();
    expect(slideIntent(-110, 0)).toBe("cancel");
    expect(slideIntent(0, -70)).toBe("lock");
    expect(slideIntent(-120, -90)).toBe("cancel");
  });
  test("levels stay in range, and silence still draws a bar", () => {
    expect(levelOf(0)).toBe(1);
    expect(levelOf(-160)).toBe(0.04);
    expect(levelOf(undefined)).toBe(0.04);
  });
  test("peaks keep the loudest of each stretch", () => {
    const peaks = peaksOf([0.1, 0.9, 0.1, 0.1, 0.2, 0.1], 2);
    expect(peaks).toEqual([0.9, 0.2]);
    expect(peaksOf([], 4)).toEqual([]);
  });
  test("the countdown shows only near the limit", () => {
    expect(secondsLeft(0)).toBeNull();
    expect(secondsLeft(VOICE_MAX_MS - 13_000)).toBe(13);
    expect(secondsLeft(VOICE_MAX_MS + 1000)).toBe(0);
  });
  test("speed goes round", () => {
    expect([nextSpeed(1), nextSpeed(1.5), nextSpeed(2)]).toEqual([1.5, 2, 1]);
  });
});

describe("voice upload", () => {
  test("a server that took it, can't now, or never will", () => {
    expect(uploadVerdict(202)).toBe("done");
    expect(uploadVerdict(503)).toBe("retry");
    expect(uploadVerdict(422)).toBe("refused");
  });
  test("waits grow and stop growing", () => {
    expect(retryDelayMs(0)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(99)).toBe(30_000);
  });
});

describe("voice messages hold no text", () => {
  const voice = { clipId: "c", durationMs: 1200, peaks: [] };
  test("the normal body is hidden", () => {
    expect(hidesBody({ body: "palavras", meta: { voice } } as never)).toBe(true);
  });
  test("words open only when there are any", () => {
    expect(hasWords({ body: "palavras", meta: { voice } })).toBe(true);
    expect(hasWords({ body: "(sem palavras)", meta: { voice: { ...voice, noWords: true } } })).toBe(false);
    expect(hasWords({ body: "", meta: { voice }, local: "pending" })).toBe(false);
  });
});

describe("joinM4a", () => {
  test("keeps every sample, in order, and adds the durations", () => {
    const out = joinM4a(m4a([3, 4], 0xaa), m4a([5], 0xbb));
    const s = text(out);
    expect(s).not.toContain("edts");
    const mdat = s.indexOf("mdat") + 4;
    expect([...out.subarray(mdat)]).toEqual([...new Array(7).fill(0xaa), ...new Array(5).fill(0xbb)]);
    const d = new DataView(out.buffer);
    const stsz = s.indexOf("stsz") + 4;
    expect(d.getUint32(stsz + 8)).toBe(3);
    const stco = s.indexOf("stco") + 4;
    expect(d.getUint32(stco + 8)).toBe(mdat);
    const mdhd = s.indexOf("mdhd") + 4;
    expect(d.getUint32(mdhd + 16)).toBe(3072);
  });
  test("refuses what it can't read", () => {
    expect(() => joinM4a(new Uint8Array(12), m4a([1], 1))).toThrow();
  });
});
