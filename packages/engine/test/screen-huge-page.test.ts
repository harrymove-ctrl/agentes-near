import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * A plan on a huge page stays bounded in time and memory. It runs in a child process with a deadline: a synchronous
 * blow-up never yields, so a test's own timeout couldn't stop it.
 */

const SCREEN = join(import.meta.dir, "../src/screen/index.ts");
const DEADLINE_MS = 30_000;

/**
 * A layout grid, as some web apps draw a whole screen: one row whose cells are panes named after everything in them,
 * each pane full of items. Every element in the row reads the row's other cells as its place.
 */
const CHILD = `
const { formatPlanReport, observeSnapshot, runPlan } = await import(${JSON.stringify(SCREEN)});
const { heapStats } = await import("bun:jsc");
const lines = ["- grid", "  - row"];
let ref = 1;
for (const pane of ["Chats", "Messages", "Details"]) {
  const items = Array.from({ length: 1600 }, (_, i) => pane + " entry " + i + " from someone, with a line of preview");
  lines.push('    - gridcell "' + items.join(" ") + '" [ref=e' + ref++ + "]");
  for (const item of items) lines.push('      - listitem "' + item + '" [ref=e' + ref++ + "]");
}
lines.push('      - textbox "Message" [ref=e' + ref++ + "]", '      - button "Send" [ref=e' + ref++ + "]");
const text = lines.join("\\n");
const look = () => observeSnapshot({ text, url: "https://chat.example.com/" });
const surface = { observe: async () => look(), perform: async () => ({ ok: true, observation: look() }) };
// Picks the first option of every Choice and says yes to every condition.
const judge = {
  name: "first",
  async ask(request) {
    const out = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === "choice") {
        const first = Object.keys(q.criteria)[0];
        out[id] = { choice: first, probabilities: { [first]: 0.9 } };
      } else out[id] = { noul: 0.9 };
    }
    return out;
  },
};
const started = performance.now();
const report = await runPlan({ judge, orgId: "o", scope: "s", surface }, [
  { do: "click", target: "Chats entry 7" },
  { do: "read", find: "the Message field and the Send button" },
]);
const ms = performance.now() - started;
formatPlanReport(report);
Bun.gc(true);
console.log(JSON.stringify({
  ms,
  chars: text.length,
  heapMb: heapStats().heapSize / 2 ** 20,
  rssMb: process.memoryUsage().rss / 2 ** 20,
  found: report.steps.map((s) => s.found?.answered ?? s.status),
  kept: report.after?.elements.length,
}));
`;

test(
  "a click and a read with find on a huge layout grid finish in bounded time and memory",
  async () => {
    const child = Bun.spawn([process.execPath, "-e", CHILD], { stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => child.kill("SIGKILL"), DEADLINE_MS);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(killer);
    expect({ code, err: err.slice(0, 2000) }).toEqual({ code: 0, err: "" });
    const r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
      ms: number;
      chars: number;
      heapMb: number;
      rssMb: number;
      found: string[];
      kept: number;
    };
    expect(r.chars).toBeGreaterThan(600_000);
    expect(r.found).toEqual(["done", "yes"]);
    expect(r.kept).toBe(4805);
    // Measured: 0.2 s and 4 MB kept. Joining a row's cells for each of its elements took 1.8 s and kept 810 MB.
    expect(r.heapMb).toBeLessThan(150);
    expect(r.rssMb).toBeLessThan(600);
    expect(r.ms).toBeLessThan(5000);
  },
  DEADLINE_MS + 10_000,
);
