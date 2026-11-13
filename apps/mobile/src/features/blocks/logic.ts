/*
 * Live blocks on the phone (ADR 0113). Pure, so it is unit-tested. The web view itself is the sandbox here, as for any
 * native host of pages like these: nothing of the app is in it to reach, and these are the rules that keep it so.
 */

/** Frames kept running at once: each is a browser of its own in memory, and the rest wait for a tap. */
export const MAX_LIVE_BLOCKS = 3;

/**
 * In the conversation a block is always this tall, from its first frame: the list never jumps while it loads or
 * grows. A taller page is cut with a fade and "Show all" opens it in place; its own screen shows it all.
 */
export const INLINE_HEIGHT = 380;

/**
 * Where a block may go: nowhere. Its page is the first load. Anything else would be how a page sends out what it
 * holds, so it is refused here and never handed to the system to open.
 */
export function blockMayLoad(url: string) {
  return url === "about:blank" || url === "about:srcdoc";
}

/** What the app says to the page already running: a theme change, or everyone's state when it moved. */
export const hostScript = (message: object) =>
  `window.__agentesHost&&window.__agentesHost(${JSON.stringify(message)});true;`;

export const themeScript = (theme: "light" | "dark") => hostScript({ theme });

/**
 * The frames allowed to run, newest in. Whoever asks last gets a place, and the oldest one past the limit gives it
 * up: a long conversation never holds more than `MAX_LIVE_BLOCKS` browsers.
 */
export function withLiveBlock(live: readonly string[], key: string, max = MAX_LIVE_BLOCKS): string[] {
  return [...live.filter((k) => k !== key), key].slice(-max);
}

/**
 * How far a vote's voter tucks under the one before, as the web's stack (`.ac-avatar-stack`): 6 points past a photo,
 * and past initials only the 2-point rings over each other, so no letter is covered.
 */
export const faceOverlap = (afterPhoto: boolean) => ({ marginLeft: afterPhoto ? -6 : -4 });
