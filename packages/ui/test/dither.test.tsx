import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { Avatar, ditherCells, ditherSvg, ditherTones, ditherUrl, Logo } from "../src";
import { liveAgentCount } from "../src/agent/live";
import { avatarSky, avatarSkyCell, avatarSkyCells, avatarSkyTones } from "../src/sky/avatar";

describe("agent dither", () => {
  test("covers the whole grid, light on top and deep at the bottom", () => {
    const svg = ditherSvg("violet", 8);
    const tones = ditherTones("violet");
    const rows = new Map<number, { width: number; fill: string }[]>();
    for (const m of svg.matchAll(/<rect x="\d+" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"\/>/g)) {
      const y = Number(m[1]);
      rows.set(y, [...(rows.get(y) ?? []), { width: Number(m[2]), fill: m[3] ?? "" }]);
    }
    expect(rows.size).toBe(8);
    for (const runs of rows.values()) expect(runs.reduce((s, r) => s + r.width, 0)).toBe(8);
    const level = (y: number) => {
      const runs = rows.get(y) ?? [];
      return runs.reduce((s, r) => s + tones.indexOf(r.fill) * r.width, 0) / 8;
    };
    expect(level(0)).toBeGreaterThan(level(7));
  });

  test("the grid follows the size and the data URL is cached", () => {
    expect(ditherCells(18)).toBeLessThan(ditherCells(112));
    expect(ditherUrl("sky", 10)).toBe(ditherUrl("sky", 10));
    expect(ditherUrl("sky", 10).startsWith("data:image/svg+xml,")).toBe(true);
  });

  test("agents are drawn by the engine; people are not; the logo carries the dither", () => {
    const before = liveAgentCount();
    const { container } = render(
      <>
        <Avatar kind="agent" name="Bia" appearance={{ color: "rose" }} />
        <Avatar name="Ana Lima" />
        <Logo />
        <Logo mono />
      </>,
    );
    const [agent, person] = [...container.querySelectorAll<HTMLElement>(".ac-avatar")];
    // Agents are drawn by the engine on a canvas, registered in the live loop; people are not.
    expect(liveAgentCount()).toBe(before + 1);
    expect(agent?.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
    expect(person?.querySelector("canvas")).toBeNull();
    expect(container.querySelectorAll(".ac-logo__dither")).toHaveLength(2);
  });
});

describe("avatar tile sky", () => {
  test("soft on top, deeper below, per theme", () => {
    const [top, bottom] = avatarSkyTones("violet", false);
    const [dTop, dBottom] = avatarSkyTones("violet", true);
    const lum = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
    };
    expect(lum(top)).toBeGreaterThan(lum(bottom));
    expect(lum(dTop)).toBeLessThan(lum(dBottom));
    expect(lum(dBottom)).toBeLessThan(lum(bottom));
    expect(avatarSkyTones("unknown", false)).toEqual(avatarSkyTones("sky", false));
  });

  test("the dither runs from the top tone to the bottom one", () => {
    const n = avatarSkyCells(72);
    expect(n).toBe(18);
    expect(avatarSkyCells(10)).toBe(8);
    const row = (y: number) =>
      Array.from({ length: n }, (_, x) => avatarSkyCell(x, y, n)).reduce<number>((s, v) => s + v, 0);
    expect(row(0)).toBe(0);
    expect(row(n - 1)).toBe(n);
    expect(row(Math.floor(n / 2))).toBeGreaterThan(0);
    expect(row(Math.floor(n / 2))).toBeLessThan(n);
  });

  test("the tile sky cache stays small while a picker's live preview asks for a new color every move", () => {
    const make = document.createElement.bind(document);
    let drawn = 0;
    document.createElement = ((tag: string) => {
      if (tag === "canvas") drawn++;
      return make(tag);
    }) as typeof document.createElement;
    try {
      avatarSky("violet", 33, false);
      avatarSky("violet", 33, false);
      expect(drawn).toBe(1);
      const hex = (i: number) => `#${i.toString(16).padStart(6, "0")}`;
      for (let i = 0; i < 400; i++) avatarSky(hex(i * 40000), 33, false);
      drawn = 0;
      avatarSky(hex(0), 33, false);
      // The first color was forgotten (drawn again), so the caches never grew past their bound.
      expect(drawn).toBe(1);
    } finally {
      document.createElement = make;
    }
  });
});
