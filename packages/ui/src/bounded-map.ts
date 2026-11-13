/** A Map that forgets its oldest entry past `limit`: a cache fed by unbounded keys (a live color picker) stays small. */
export class BoundedMap<K, V> extends Map<K, V> {
  readonly limit: number;

  constructor(limit: number) {
    super();
    this.limit = limit;
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    if (this.size > this.limit) this.delete(this.keys().next().value as K);
    return this;
  }
}
