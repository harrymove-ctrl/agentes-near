type Tree = Record<string, unknown>;

const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep merge of string trees: `b` wins on the same leaf, nested objects merge (a language over English). Arrays and
 * functions are leaves.
 */
export function deepMerge<T extends object>(a: T, b: object): T {
  const out: Tree = { ...(a as Tree) };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isTree(v) && isTree(prev) ? deepMerge(prev, v) : v;
  }
  return out as T;
}
