/**
 * The phone app's line icons: 24×24, stroke 1.7, round caps and joins.
 * Pure data (react-native-svg draws it in ./Icon.tsx); `fill` marks the few filled dots and pixels
 * (`opacity` fades a pixel), `sw` a different stroke width.
 */
export type IconShape =
  | { t: "path"; d: string; sw?: number }
  | { t: "circle"; cx: number; cy: number; r: number; fill?: boolean }
  | { t: "rect"; x: number; y: number; w: number; h: number; rx: number; fill?: boolean; opacity?: number };

const p = (d: string, sw?: number): IconShape => (sw ? { t: "path", d, sw } : { t: "path", d });
const c = (cx: number, cy: number, r: number, fill?: boolean): IconShape =>
  fill ? { t: "circle", cx, cy, r, fill } : { t: "circle", cx, cy, r };
const r = (x: number, y: number, w: number, h: number, rx: number): IconShape => ({ t: "rect", x, y, w, h, rx });
/** A filled square pixel, faded to `opacity`. */
const px = (x: number, y: number, s: number, opacity: number): IconShape => ({
  t: "rect",
  x,
  y,
  w: s,
  h: s,
  rx: 0,
  fill: true,
  opacity,
});

export const ICONS = {
  home: [p("M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1Z")],
  chat: [
    p(
      "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h0A1.5 1.5 0 0 1 4 15.5Z",
    ),
  ],
  agent: [p("M7 4h7l5 5v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"), p("M9.5 11v2.5M14.5 11v2.5")],
  bell: [p("M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"), p("M10 20.5a2 2 0 0 0 4 0")],
  search: [c(11, 11, 6.5), p("m16 16 4 4")],
  plus: [p("M12 5v14M5 12h14")],
  send: [p("M12 19V5M6 11l6-6 6 6")],
  back: [p("m15 5-7 7 7 7")],
  more: [c(6, 12, 1.3, true), c(12, 12, 1.3, true), c(18, 12, 1.3, true)],
  check: [p("m5 12.5 4.5 4.5L19 7.5")],
  checks: [p("m2.5 12.5 3.5 3.5 7-8.5M12 15l1 1 8.5-9.5")],
  x: [p("M6 6l12 12M18 6 6 18")],
  clock: [c(12, 12, 8.5), p("M12 7.5V12l3 2")],
  /** Waits on you: three pixels burning out, the request's fuse in small (no shield). */
  wait: [px(2, 9.5, 5, 1), px(9.5, 9.5, 5, 0.6), px(17, 9.5, 5, 0.3)],
  shield: [p("M12 3.5 5 6.5v5c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9v-5Z"), p("m9 12 2 2 4-4")],
  hash: [p("M5 9h14M5 15h14M10 4 8 20M16 4l-2 16")],
  chev: [p("m6 9 6 6 6-6")],
  right: [p("m9 6 6 6-6 6")],
  /** `right` mirrored (not `back`, which is a size larger): ‹ beside › matches it. */
  left: [p("m15 6-6 6 6 6")],
  image: [r(3.5, 5, 17, 14, 3), c(9, 10, 1.6), p("m4 17 5-4.5 4 3.5 3-2.5 4 3.5")],
  file: [p("M7 3.5h7l4.5 4.5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"), p("M14 3.5V8h4.5")],
  camera: [
    p(
      "M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z",
    ),
    c(12, 12.5, 3.5),
  ],
  mic: [r(9, 3.5, 6, 11, 3), p("M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5")],
  sound: [p("M4 9.5v5h3.5l5 4.5V5L7.5 9.5Z"), p("M16 9a4.2 4.2 0 0 1 0 6M18.6 6.4a7.8 7.8 0 0 1 0 11.2")],
  target: [c(12, 12, 8), c(12, 12, 4), c(12, 12, 0.8, true)],
  list: [p("M9 6.5h11M9 12h11M9 17.5h11"), p("M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01", 2.6)],
  reply: [p("M4 5h16v9H11l-4 3.5V14H4Z"), p("M9 9h6")],
  copy: [r(8, 8, 11.5, 11.5, 2.5), p("M5 15.5V6.5A1.5 1.5 0 0 1 6.5 5h9")],
  link: [
    p(
      "M10.2 13.8a3.6 3.6 0 0 0 5.04 0l2.76-2.76a3.6 3.6 0 0 0-5.04-5.04l-1.2 1.2M13.8 10.2a3.6 3.6 0 0 0-5.04 0L6 12.96A3.6 3.6 0 0 0 11.04 18l1.2-1.2",
    ),
  ],
  expand: [p("M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5")],
  pin: [p("M9 4h6l-1 5 3.5 3.5h-11L10 9Z"), p("M12 12.5V20")],
  eyeoff: [
    p("M4 4l16 16"),
    p(
      "M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 8.5 4.5 9 7a10.8 10.8 0 0 1-2.4 3.6M6.4 6.6C4.3 8 3.2 10.1 3 12c.5 2.5 4 7 9 7a9.3 9.3 0 0 0 4.2-1",
    ),
    p("M10 10.2a2.6 2.6 0 0 0 3.7 3.7"),
  ],
  moon: [p("M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z")],
  sun: [c(12, 12, 4), p("M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4")],
  globe: [
    c(12, 12, 8.5),
    p("M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z"),
  ],
  out: [p("M14 4.5h3.5A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5H14"), p("M10 16l-4-4 4-4M6 12h9")],
  code: [p("m8.5 8-4 4 4 4M15.5 8l4 4-4 4")],
  // The composer's formatting, the web's glyphs on this grid.
  bold: [p("M7.5 5h5.5a3.5 3.5 0 0 1 0 7H7.5zM7.5 12h6.5a3.5 3.5 0 0 1 0 7H7.5z")],
  italic: [p("M10.5 5h7M6.5 19h7M14 5l-4 14")],
  strike: [
    p(
      "M5 12h14M16 8c-.4-1.8-1.9-3-4-3-2.3 0-4 1.3-4 3.2 0 .7.2 1.3.6 1.8M8 16c.4 1.8 1.9 3 4 3 2.3 0 4-1.3 4-3.2 0-.3 0-.5-.1-.8",
    ),
  ],
  codeBlock: [r(3.5, 4.5, 17, 15, 3), p("m10 9.5-2.5 2.5 2.5 2.5M14 9.5l2.5 2.5-2.5 2.5")],
  bulletList: [p("M10 7h9M10 12h9M10 17h9"), p("M5.5 7h.01M5.5 12h.01M5.5 17h.01", 2.6)],
  numberedList: [
    p(
      "M11 7h8M11 12h8M11 17h8M4.8 6l1.4-1v4.5M4.6 14.3c.3-.5.8-.8 1.4-.8.7 0 1.3.5 1.3 1.2 0 .5-.3.9-.8 1.3l-1.9 1.5h2.8",
    ),
  ],
  quote: [p("M5.5 5.5v13M10 8h9M10 12h9M10 16h6")],
  server: [r(4, 4.5, 16, 6, 2), r(4, 13.5, 16, 6, 2), p("M7.5 7.5h.01M7.5 16.5h.01", 2.6)],
  mail: [r(3.5, 5.5, 17, 13, 2.5), p("m4.5 7 7.5 6 7.5-6")],
  chart: [p("M5 19.5V11M10 19.5V5M15 19.5v-6M20 19.5V8")],
  pen: [p("M4.5 19.5 5.5 15 15.5 5a2.1 2.1 0 0 1 3 3l-10 10Z"), p("m13.5 7 3 3")],
  doc: [p("M7 3.5h7l4.5 4.5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z"), p("M8.5 12.5h7M8.5 16h5")],
  sparkle: [
    p("M12 4c.6 3.8 2.2 5.4 6 6-3.8.6-5.4 2.2-6 6-.6-3.8-2.2-5.4-6-6 3.8-.6 5.4-2.2 6-6Z"),
    p("M18.5 15.5c.3 1.5.9 2.1 2.4 2.4-1.5.3-2.1.9-2.4 2.4-.3-1.5-.9-2.1-2.4-2.4 1.5-.3 2.1-.9 2.4-2.4Z"),
  ],
  smile: [c(12, 12, 8.5), p("M8.5 14c.8 1.4 2 2 3.5 2s2.7-.6 3.5-2M9 9.5h.01M15 9.5h.01", 2)],
  // The web's sticker on this grid: its corner peeled (ADR 0091).
  sticker: [
    p("M19.8 12.6V7.2a3 3 0 0 0-3-3H7.2a3 3 0 0 0-3 3v9.6a3 3 0 0 0 3 3h5.4Z"),
    p("M19.8 12.6h-4.2a3 3 0 0 0-3 3v4.2"),
  ],
  laptop: [r(5, 5, 14, 10, 1.8), p("M3 18.5h18")],
  phone: [r(7, 3, 10, 18, 2.4), p("M10.5 17.5h3")],
  // Each computer's line icon (the small form of its portrait, `ComputerIcon`).
  computerMac: [
    r(4, 4.5, 16, 11, 2),
    p("M10.4 4.5h3.2v.7a.9.9 0 0 1-.9.9h-1.4a.9.9 0 0 1-.9-.9Z"),
    p("M2.5 18.2h19l-.9 1.1a1.6 1.6 0 0 1-1.2.6H4.6a1.6 1.6 0 0 1-1.2-.6Z"),
  ],
  computerWindows: [
    r(3, 3.8, 18, 12.7, 2),
    p("M9 20.2h6M12 16.5v3.7"),
    r(8.2, 7.2, 3.3, 2.6, 0.4),
    r(12.5, 7.2, 3.3, 2.6, 0.4),
    r(8.2, 10.6, 3.3, 2.6, 0.4),
    r(12.5, 10.6, 3.3, 2.6, 0.4),
  ],
  computerLinux: [r(3, 4.5, 18, 15, 2.5), p("M3 8.6h18"), p("m7.2 12 2.6 2.1-2.6 2.1M12 16.3h4.6")],
  archive: [r(3.5, 5, 17, 4, 1.2), p("M5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9M10 13h4")],
  circle: [c(12, 12, 7)],
  pause: [p("M9 6v12M15 6v12")],
  // The agent's browser card (Senha, the keys, Parar).
  lock: [r(5, 11, 14, 9.5, 2.5), p("M8.5 11V8a3.5 3.5 0 0 1 7 0v3")],
  // The Vault's keys (ADR 0144): the web's key on this grid, a round bow and a shaft with two teeth.
  key: [c(8.4, 15.6, 3.8), p("m11.1 12.9 8.4-8.4M16.8 7.2l2.6 2.6M14.6 9.4l2 2")],
  keyboard: [r(3, 6, 18, 12, 2.5), p("M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7 14h.01M17 14h.01M10 14.5h4", 2)],
  stop: [r(7, 7, 10, 10, 2)],
  flag: [p("M6 21V4M6 4h11l-2 4 2 4H6")],
  // The question card, "Conversa com…" and "Livre".
  help: [c(12, 12, 8.5), p("M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01", 2)],
  // The ⓘ beside a label that shows its explanation (`InfoHint`).
  info: [c(12, 12, 8.5), p("M12 11v5M12 8h.01", 2)],
  compose: [
    p("M12 5H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"),
    p("M16.5 4.5a2 2 0 0 1 3 3L12 15l-3.5.5L9 12Z"),
  ],
  checkc: [c(12, 12, 8.5), p("m8.5 12 2.5 2.5 4.5-5")],
  // The file viewer's actions.
  share: [
    p("M12 3.5v11M8 7.5l4-4 4 4"),
    p("M6.5 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-.5"),
  ],
  photos: [r(3.5, 5, 17, 14, 3), c(9, 10, 1.6), p("m4 17 5-4.5 4 3.5 3-2.5 4 3.5")],
  drive: [p("M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z")],
  // The receipts of what an agent did (Desfazer, issue, memory).
  undo: [p("M9 7 4.5 11.5 9 16"), p("M5 11.5h9.5a5 5 0 0 1 0 10H11")],
  issue: [c(12, 12, 8.5), c(12, 12, 2.2, true)],
  // The web's `gitPull` on this grid.
  gitPull: [
    c(6.6, 5.4, 2.3),
    c(6.6, 18.6, 2.3),
    c(17.4, 18.6, 2.3),
    p("M6.6 7.7v8.6M17.4 16.3V9.6a3 3 0 0 0-3-3h-3m2.4-2.4-2.4 2.4 2.4 2.4"),
  ],
  brain: [
    p(
      "M9 5.5a3 3 0 0 0-3 3v.5a3 3 0 0 0-1.5 5.3A3 3 0 0 0 9 18.5h1V5.5ZM15 5.5a3 3 0 0 1 3 3v.5a3 3 0 0 1 1.5 5.3A3 3 0 0 1 15 18.5h-1V5.5Z",
    ),
  ],
  // Talking to an agent while it works, the "↓ novas" pill and the connection banner.
  bolt: [p("M13 3 5 13.5h6L10 21l8-10.5h-6Z")],
  join: [p("M5 12h11M12 7l5 5-5 5"), p("M19 5v14")],
  play: [p("M8 5.5v13l10.5-6.5Z")],
  // The video player: a video that ended, the sound off, full screen.
  replay: [p("M5.5 12a6.5 6.5 0 1 0 2-4.7M6.5 3.5v4.5H11")],
  mute: [p("M4 9.5v5h3.5l5 4.5V5L7.5 9.5Z"), p("M16 9.5l5 5M21 9.5l-5 5")],
  fullscreen: [p("M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5")],
  trash: [p("M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5")],
  text: [p("M5 7h14M5 12h14M5 17h9")],
  eye: [p("M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"), c(12, 12, 2.6)],
  down: [p("M12 5v14M6 13l6 6 6-6")],
  wifi: [p("M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"), p("M12 19h.01")],
  // The web's Membros icon on this grid: someone asking to join.
  members: [
    c(9.6, 8.4, 3.4),
    p("M3.6 19.2c.7-3.1 3-4.8 6-4.8s5.3 1.7 6 4.8M16.2 5.4a3.1 3.1 0 0 1 0 6M18 14.8c1.3.7 2.2 2.3 2.4 4.4"),
  ],
  // The web's person on this grid: the one person in a channel with an agent.
  person: [c(12, 8.4, 3.8), p("M5 20.4c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5")],
  // The web's reply arrow on this grid. `reply` here is the web's thread drawing.
  replyTo: [p("M9.6 6 4.8 10.8l4.8 4.8M4.8 10.8h8.4a6 6 0 0 1 6 6v1.8")],
  // The web's swap arrows on this grid: one agent asking another, between their faces.
  swap: [p("M4.8 8.4h13.8M15.6 5.4l3 3-3 3M19.2 15.6H5.4M8.4 12.6l-3 3 3 3")],
} satisfies Record<string, IconShape[]>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
