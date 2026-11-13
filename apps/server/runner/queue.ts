/** Runs each key's jobs one after another (one that fails doesn't stop the next); other keys' run alongside. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, number>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    // The count drops before whoever awaits the job resumes.
    const run = (this.tails.get(key) ?? Promise.resolve()).then(fn).finally(() => {
      const left = (this.waiting.get(key) ?? 1) - 1;
      if (left > 0) this.waiting.set(key, left);
      else this.waiting.delete(key);
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }

  /** A job for `key` is queued or running. */
  busy(key: string): boolean {
    return this.waiting.has(key);
  }
}
