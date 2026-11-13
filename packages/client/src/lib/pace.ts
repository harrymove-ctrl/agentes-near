/** Per key: `run` at once, then at most once per `gapMs`; calls inside a gap are one more run when it ends. */
export function pacer(gapMs: number) {
  const gaps = new Map<string, { again: boolean }>();
  return function pace(key: string, run: () => void) {
    const open = gaps.get(key);
    if (open) {
      open.again = true;
      return;
    }
    run();
    const gap = { again: false };
    gaps.set(key, gap);
    setTimeout(() => {
      gaps.delete(key);
      if (gap.again) pace(key, run);
    }, gapMs);
  };
}
