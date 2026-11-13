import { describe, expect, test } from "bun:test";
import { COMPUTER_KINDS, COMPUTER_STATES } from "@agenteschat/ui/computer/portrait";
import { CellRecorder, cellsToSvg, portraitFrame } from "../src/computer/cells";

describe("computer portraits on the phone (cells for Skia)", () => {
  test("every kind and state comes out as cell runs inside the 48 grid", () => {
    for (const kind of COMPUTER_KINDS)
      for (const state of COMPUTER_STATES) {
        const runs = portraitFrame(kind, state, false, 1.2);
        const cells = runs.reduce((n, r) => n + r.cells.length / 2, 0);
        expect(cells).toBeGreaterThan(200);
        for (const r of runs) for (const v of r.cells) expect(v >= 0 && v < 48).toBe(true);
      }
  });

  test("an opaque color covers what was below; a translucent one stacks on a later layer", () => {
    const rec = new CellRecorder();
    rec.fillStyle = "#111111";
    rec.fillRect(2, 3, 1, 1);
    rec.fillStyle = "rgba(0,0,0,.5)";
    rec.fillRect(2, 3, 1, 1);
    rec.fillStyle = "#222222";
    rec.fillRect(5, 5, 1, 1);
    rec.fillStyle = "#333333";
    rec.fillRect(5, 5, 1, 1);
    expect(rec.runs()).toEqual([
      { color: "#111111", cells: [2, 3] },
      { color: "#333333", cells: [5, 5] },
      { color: "rgba(0,0,0,.5)", cells: [2, 3] },
    ]);
    rec.clearRect(0, 0, 48, 48);
    expect(rec.runs()).toEqual([]);
  });

  test("offline: no sky on the screen; cells become unit squares", () => {
    const sky = (state: "online" | "offline") =>
      portraitFrame("mac", state, false, 0).some((r) => r.color === "#0063d1" || r.color === "#2f80e0");
    expect(sky("online")).toBe(true);
    expect(sky("offline")).toBe(false);
    expect(cellsToSvg([1, 2, 3, 4])).toBe("M1 2h1v1h-1ZM3 4h1v1h-1Z");
  });
});
