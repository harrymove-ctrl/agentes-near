/** Only one thing plays at a time (a voice message or a video): starting one stops the one before. */
let current: (() => void) | null = null;

/** `stop` is about to play: stops whatever else was playing. */
export function claimPlayback(stop: () => void) {
  if (current && current !== stop) current();
  current = stop;
}

/** `stop` stopped by itself (paused, ended, gone): nothing to stop anymore. */
export function releasePlayback(stop: () => void) {
  if (current === stop) current = null;
}

/** Stops whatever plays: called by anything else about to make sound (listening back to a recording). */
export function stopPlayback() {
  const stop = current;
  current = null;
  stop?.();
}
