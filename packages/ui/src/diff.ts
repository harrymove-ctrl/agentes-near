export type DiffKind = "same" | "add" | "del";
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * Line diff of two texts (longest common subsequence), for before/after
 * proposals. Equal lines are kept, removed lines come before added ones.
 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        before[i] === after[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push({ kind: "same", text: before[i] as string });
      i++;
      j++;
    } else if (
      i < n &&
      (j >= m || ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
    ) {
      out.push({ kind: "del", text: before[i] as string });
      i++;
    } else {
      out.push({ kind: "add", text: after[j] as string });
      j++;
    }
  }
  return out;
}

/** A run of one kind of line, joined, or a run of unchanged lines folded away (`count` of them). */
export type DiffBlock = { kind: DiffKind; text: string } | { kind: "fold"; count: number };

/**
 * A text diff the way a reader takes it in, as GitHub shows a rendered change: each run of lines of one kind joined
 * into one block, and a run of more than `fold` unchanged lines cut to the `context` lines beside each change, the
 * rest counted. A diff with no change keeps its text whole.
 */
export function diffBlocks(lines: DiffLine[], context = 1, fold = 3): DiffBlock[] {
  const runs: { kind: DiffKind; lines: string[] }[] = [];
  for (const l of lines) {
    const last = runs.at(-1);
    if (last?.kind === l.kind) last.lines.push(l.text);
    else runs.push({ kind: l.kind, lines: [l.text] });
  }
  if (runs.every((r) => r.kind === "same")) return runs.map((r) => ({ kind: r.kind, text: r.lines.join("\n") }));
  const out: DiffBlock[] = [];
  runs.forEach((r, i) => {
    if (r.kind !== "same" || r.lines.length <= fold) {
      out.push({ kind: r.kind, text: r.lines.join("\n") });
      return;
    }
    const head = i > 0 ? r.lines.slice(0, context) : [];
    const tail = i < runs.length - 1 ? r.lines.slice(-context) : [];
    if (head.length) out.push({ kind: "same", text: head.join("\n") });
    out.push({ kind: "fold", count: r.lines.length - head.length - tail.length });
    if (tail.length) out.push({ kind: "same", text: tail.join("\n") });
  });
  return out;
}
