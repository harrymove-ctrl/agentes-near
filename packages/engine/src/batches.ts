/** `fn` over `items`, at most `size` at a time, the results in order. */
export async function mapInBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}
