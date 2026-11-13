import type { IconShape } from "./types";

/**
 * Icons the app needs that don't have a file in docs/design/icons yet. Same
 * grid (20px), stroke (1.6) and rules. Move them to docs/design/icons when
 * the design files are added.
 */
/*
 * The engines an agent thinks and works with, small (the
 * 16 px form of their portraits), redrawn from the 24px grid. Our own glyphs,
 * no logos. The accent classes take each engine's color (components.css).
 */
/** Claude Code: a console with a prompt and a line written by hand, in clay. */
const BRAIN_CLAUDE_CODE: IconShape[] = [
  ["rect", { x: "2.5", y: "3.75", width: "15", height: "12.5", rx: "2.5" }],
  ["path", { d: "m5.83 7.17 2.17 1.75-2.17 1.75" }],
  [
    "path",
    {
      className: "ac-brain-cc",
      pathLength: "1",
      d: "M6 13.5c.75-.92 1.5-.92 2.25 0s1.5.92 2.25 0 1.5-.92 2.25 0 1.17-.83 1.67-.33",
    },
  ],
];
/** Codex: a terminal with a title bar and the code between braces. */
const BRAIN_CODEX: IconShape[] = [
  ["rect", { x: "2.5", y: "3.75", width: "15", height: "12.5", rx: "2.5" }],
  ["path", { d: "M2.5 7.17h15" }],
  [
    "path",
    {
      className: "ac-brain-cx",
      d: "M8.5 9c-.83 0-1.17.33-1.17 1.08v.33c0 .5-.25.75-.75.75.5 0 .75.25.75.75v.33c0 .75.33 1.08 1.17 1.08M11.5 9c.83 0 1.17.33 1.17 1.08v.33c0 .5.25.75.75.75-.5 0-.75.25-.75.75v.33c0 .75-.33 1.08-1.17 1.08",
    },
  ],
];
/** Agente: our agent's outline (the engine's body, bodyPath) with its eyes, in the agents' color. */
const BRAIN_AGENT: IconShape[] = [
  [
    "path",
    {
      className: "ac-brain-body",
      d: "M7.2 3.75H12.8A3.867 3.867 0 0 1 16.667 7.617V13.217A3.867 3.867 0 0 1 12.8 17.083H4.053A.72 .72 0 0 1 3.333 16.363V7.617A3.867 3.867 0 0 1 7.2 3.75Z",
    },
  ],
  ["rect", { className: "ac-brain-eye", x: "7.4", y: "8.15", width: "1.86", height: "3.6", rx: ".93" }],
  ["rect", { className: "ac-brain-eye", x: "10.74", y: "8.15", width: "1.86", height: "3.6", rx: ".93" }],
];

export const extraIcons = {
  /** Sidebar: Issues (closed shape keeps the cut corner). */
  issues: [
    ["path", { d: "M7 3h6a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H3V7a4 4 0 0 1 4-4z" }],
    ["path", { d: "M7 8h6M7 12h4" }],
  ],
  /** Sidebar: Início, the workspace's home. */
  home: [
    ["path", { d: "M3.5 9 10 3.5 16.5 9" }],
    ["path", { d: "M5 7.8v6.7A1.5 1.5 0 0 0 6.5 16h2v-4h3v4h2a1.5 1.5 0 0 0 1.5-1.5V7.8" }],
  ],
  /** Sidebar: Drive. */
  drive: [["path", { d: "M3 6.5A2.5 2.5 0 0 1 5.5 4H8l2 2h4.5A2.5 2.5 0 0 1 17 8.5v5a2.5 2.5 0 0 1-2.5 2.5H3z" }]],
  /** Sidebar: Membros. */
  members: [
    ["circle", { cx: "8", cy: "7", r: "2.8" }],
    ["path", { d: "M3 16c.6-2.6 2.5-4 5-4s4.4 1.4 5 4M13.5 4.5a2.6 2.6 0 0 1 0 5M15 12.3c1.1.6 1.8 1.9 2 3.7" }],
  ],
  /** Sidebar: Criar agente. */
  plus: [["path", { d: "M10 4.5v11M4.5 10h11" }]],
  /** The stages of a task, a circle that fills as the work goes (to do, doing, review, done). */
  stageTodo: [["circle", { cx: "10", cy: "10", r: "6.75" }]],
  stageProgress: [
    ["circle", { cx: "10", cy: "10", r: "6.75" }],
    ["path", { d: "M10 3.25a6.75 6.75 0 0 1 0 13.5z", fill: "currentColor" }],
  ],
  stageReview: [
    ["circle", { cx: "10", cy: "10", r: "6.75" }],
    ["path", { d: "M10 3.25a6.75 6.75 0 1 1-6.75 6.75H10z", fill: "currentColor" }],
  ],
  stageDone: [
    ["circle", { cx: "10", cy: "10", r: "6.75", fill: "currentColor" }],
    ["path", { d: "m7.2 10.2 2 2 3.6-3.9", stroke: "var(--bg)", strokeWidth: "1.8" }],
  ],
  /** Onboarding / Agente dialogs: remove, close. */
  close: [["path", { d: "m6 6 8 8M14 6l-8 8" }]],
  /** Select: trigger chevron. */
  chevronDown: [["path", { d: "m6 8 4 4 4-4" }]],
  /** Channel: approved chip; select: selected option. */
  check: [["path", { d: "m5.5 10.5 3 3 6-7" }]],
  /** Sign-in: error alert. */
  alert: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M10 6.5v4M10 13.5v.01" }],
  ],
  /** A pull request of a code host, beside its number: two branches, the way code hosts draw it. */
  gitPull: [
    ["circle", { cx: "5.5", cy: "4.5", r: "1.9" }],
    ["circle", { cx: "5.5", cy: "15.5", r: "1.9" }],
    ["circle", { cx: "14.5", cy: "15.5", r: "1.9" }],
    ["path", { d: "M5.5 6.4v7.2M14.5 13.6V8A2.5 2.5 0 0 0 12 5.5H9.5m2-2-2 2 2 2" }],
  ],
  /** An issue of a code host, beside its number. */
  issue: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["circle", { cx: "10", cy: "10", r: "1.8", fill: "currentColor" }],
  ],
  /** Channel: pull request attachment. */
  pullRequest: [["path", { d: "M6 3v14M14 9v8M6 7a3 3 0 0 0 3 3h2a3 3 0 0 1 3 3" }]],
  /** Organization settings (sliders). Not in the screens yet; drawn on the same grid. */
  settings: [
    ["path", { d: "M3.5 6h7M15.5 6h1M3.5 14h1M9.5 14h7" }],
    ["circle", { cx: "13", cy: "6", r: "2" }],
    ["circle", { cx: "7", cy: "14", r: "2" }],
  ],
  /** A channel's settings (the header and the open channel's row, like Discord's): a cog with its hole. */
  cog: [
    [
      "path",
      {
        d: "M15.26 8.39L17.31 8.84L17.31 11.16L15.26 11.61L14.86 12.58L15.99 14.35L14.35 15.99L12.58 14.86L11.61 15.26L11.16 17.31L8.84 17.31L8.39 15.26L7.42 14.86L5.65 15.99L4.01 14.35L5.14 12.58L4.74 11.61L2.69 11.16L2.69 8.84L4.74 8.39L5.14 7.42L4.01 5.65L5.65 4.01L7.42 5.14L8.39 4.74L8.84 2.69L11.16 2.69L11.61 4.74L12.58 5.14L14.35 4.01L15.99 5.65L14.86 7.42z",
      },
    ],
    ["circle", { cx: "10", cy: "10", r: "2.4" }],
  ],
  /** The workspace's owner beside their name (the members column). */
  crown: [["path", { d: "M4.5 14.5h11M4.8 12.5 3.6 6.4l3.7 2.8L10 4.8l2.7 4.4 3.7-2.8-1.2 6.1z" }]],
  /** Memory: fact. */
  info: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M10 9v4.5M10 6.5v.01" }],
  ],
  /** Memory: preference. */
  preference: [
    ["circle", { cx: "8", cy: "7", r: "2.8" }],
    ["path", { d: "M3 16c.6-2.6 2.5-4 5-4s4.4 1.4 5 4" }],
  ],
  /** "Adicionar pessoas ou agentes" (a channel row's hover): a person and a plus. */
  personAdd: [
    ["circle", { cx: "8", cy: "7", r: "2.8" }],
    ["path", { d: "M3 16c.6-2.6 2.5-4 5-4s4.4 1.4 5 4M15 7.5v5M12.5 10h5" }],
  ],
  /** Memory: "Sempre no contexto". */
  pin: [["path", { d: "M7 3h6l-1 5 3 3H5l3-3zM10 11v6" }]],
  /** Memory, proposals: back link. */
  chevronLeft: [["path", { d: "M12 5 7 10l5 5" }]],
  /** Receipts: an agent answered (two checks, same stroke as `check`). */
  checks: [["path", { d: "m2 10.5 3 3 6-7M10 12.5l1 1 7-8" }]],
  /** Feedback on an agent reply: helpful. Not in the screens yet; drawn on the same grid. */
  thumbUp: [["path", { d: "M7 9v8H4V9zM7 9l3-6a2 2 0 0 1 2 2v3h4a1.6 1.6 0 0 1 1.6 1.9l-1.2 6A2 2 0 0 1 14.4 17H7" }]],
  /** Feedback on an agent reply: not helpful. */
  thumbDown: [
    ["path", { d: "M7 11V3H4v8zM7 11l3 6a2 2 0 0 0 2-2v-3h4a1.6 1.6 0 0 0 1.6-1.9l-1.2-6A2 2 0 0 0 14.4 3H7" }],
  ],
  /** "Corrigir resposta". */
  edit: [["path", { d: "M4 16l1-4 8-8 3 3-8 8zM12 5l3 3" }]],
  /** Artifacts (the Drive's icons, redrawn on the 20px grid): document. */
  document: [["path", { d: "M6 3h6l3.5 3.5V17H6zM12 3v3.5h3.5M8.5 10h4M8.5 12.5h4M8.5 15h2.5" }]],
  /** Artifacts: table. */
  table: [
    ["rect", { x: "3.5", y: "4.5", width: "13", height: "11", rx: "1.5" }],
    ["path", { d: "M3.5 8.5h13M3.5 12h13M8 4.5v11" }],
  ],
  /** Artifacts: code change (diff). */
  code: [["path", { d: "M7.5 6.5 4 10l3.5 3.5M12.5 6.5 16 10l-3.5 3.5" }]],
  /** Artifacts: diagram. */
  diagram: [
    ["rect", { x: "7.5", y: "2.5", width: "5", height: "3.5", rx: "1" }],
    ["rect", { x: "2.5", y: "13.5", width: "5", height: "3.5", rx: "1" }],
    ["rect", { x: "12.5", y: "13.5", width: "5", height: "3.5", rx: "1" }],
    ["path", { d: "M10 6v3M5 13.5V11h10v2.5" }],
  ],
  /** Artifacts: HTML page. */
  page: [
    ["rect", { x: "3", y: "4", width: "14", height: "12", rx: "2" }],
    ["path", { d: "M3 7.5h14" }],
  ],
  /** Sidebar: Rotinas (clock with a refresh arrow). */
  routines: [
    ["path", { d: "M16 10a6 6 0 1 1-1.8-4.3" }],
    ["path", { d: "M16 4v3h-3" }],
    ["path", { d: "M10 7v3l2 1.5" }],
  ],
  /** Sidebar: Calendário. */
  calendar: [
    ["path", { d: "M6 3.5h8a3 3 0 0 1 3 3V14a3 3 0 0 1-3 3H3V6.5a3 3 0 0 1 3-3z" }],
    ["path", { d: "M3 8h14M7 2v3M13 2v3" }],
  ],
  /** Routines: event trigger. */
  bolt: [["path", { d: "M11 3 5 11h5l-1 6 6-8h-5z" }]],
  /** Issues: high priority. */
  arrowUp: [["path", { d: "M10 15V5M5.5 9.5 10 5l4.5 4.5" }]],
  /** Conversation: back to the latest messages. */
  arrowDown: [["path", { d: "M10 5v10M5.5 10.5 10 15l4.5-4.5" }]],
  /** Calendar: next week. */
  chevronRight: [["path", { d: "m8 5 5 5-5 5" }]],
  /** "…" menu (more actions). */
  more: [
    ["circle", { cx: "5", cy: "10", r: "1.1" }],
    ["circle", { cx: "10", cy: "10", r: "1.1" }],
    ["circle", { cx: "15", cy: "10", r: "1.1" }],
  ],
  /** Access matrix: off (not granted). */
  dash: [["path", { d: "M6 10h8" }]],
  /** "Bloquear" (deny a tool). */
  block: [
    ["circle", { cx: "10", cy: "10", r: "6.5" }],
    ["path", { d: "m5.5 14.5 9-9" }],
  ],
  /** "Baixar". */
  download: [["path", { d: "M10 3.5v9M6 9l4 4 4-4M4.5 16.5h11" }]],
  /** "Copiar link". */
  link: [
    [
      "path",
      {
        d: "M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8A3 3 0 0 0 9.2 15l1-1",
      },
    ],
  ],
  /** "Parar" (stop an agent's run). */
  stop: [["rect", { x: "5.5", y: "5.5", width: "9", height: "9", rx: "2" }]],
  /** The agent's browser closed (a power button). */
  power: [
    ["path", { d: "M10 3.5v6" }],
    ["path", { d: "M6.25 6a5.75 5.75 0 1 0 7.5 0" }],
  ],
  /** "Wiki" (the org's knowledge base). */
  book: [
    [
      "path",
      { d: "M4 4.5h4.5A2.5 2.5 0 0 1 10 6v10a2 2 0 0 0-2-2H4zM16 4.5h-4.5A2.5 2.5 0 0 0 10 6v10a2 2 0 0 1 2-2h4z" },
    ],
  ],
  /** "Sons": a speaker and its waves. */
  sound: [
    ["path", { d: "M3.5 8v4h3l4 3.5v-11L6.5 8z" }],
    ["path", { d: "M13.5 7.5a3.5 3.5 0 0 1 0 5M15.75 5.25a6.75 6.75 0 0 1 0 9.5" }],
  ],
  /** "Lembrete" (a reminder routine). */
  bell: [["path", { d: "M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.2 1.5H4.3zM8.5 17h3" }]],
  /** Something is in progress (spins unless reduced motion). */
  spinner: [["path", { d: "M10 3.5a6.5 6.5 0 1 1-6.5 6.5" }]],
  /** "Quem pode falar": restricted agent. */
  lock: [
    ["rect", { x: "4.5", y: "9", width: "11", height: "8", rx: "2" }],
    ["path", { d: "M7 9V6.5a3 3 0 0 1 6 0V9" }],
  ],
  /** "Duplicar", "Copiar". */
  copy: [
    ["rect", { x: "7", y: "7", width: "9.5", height: "9.5", rx: "2" }],
    ["path", { d: "M13 7V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V11a2 2 0 0 0 2 2H7" }],
  ],
  /** "Tela cheia": two corners pulled apart. */
  expand: [["path", { d: "M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5 11.25 8.75M3.5 16.5l5.25-5.25" }]],
  /** "Sair da tela cheia": the same two corners pushed together. */
  shrink: [["path", { d: "M11.5 4v4.5H16M8.5 16v-4.5H4M16.5 3.5l-5 5M3.5 16.5l5-5" }]],
  /** "Apagar". */
  trash: [
    [
      "path",
      { d: "M4 6h12M8 6V4.5h4V6M5.5 6l.8 9.5a1.5 1.5 0 0 0 1.5 1.5h4.4a1.5 1.5 0 0 0 1.5-1.5L14.5 6M8.5 9v5M11.5 9v5" },
    ],
  ],
  /** A recurring event or routine. */
  repeat: [
    [
      "path",
      { d: "M4 9.5V8a3 3 0 0 1 3-3h8.5M13 2.5 15.5 5 13 7.5M16 10.5V12a3 3 0 0 1-3 3H4.5M7 17.5 4.5 15 7 12.5" },
    ],
  ],
  /** "Filtros". */
  filter: [["path", { d: "M3.5 5h13M6 10h8M8.5 15h3" }]],
  /** Opens the workspace navigation on narrow screens (the last line is shorter). */
  menu: [["path", { d: "M3.5 5.5h13M3.5 10h13M3.5 14.5h8" }]],
  /** Side panel toggle. */
  sidebar: [
    ["rect", { x: "3", y: "4", width: "14", height: "12", rx: "2.5" }],
    ["path", { d: "M12.5 4v12" }],
  ],
  /** "Ativa", "Rodar agora". */
  play: [["path", { d: "M7 4.8v10.4a.6.6 0 0 0 .9.5l8-5.2a.6.6 0 0 0 0-1L7.9 4.3a.6.6 0 0 0-.9.5z" }]],
  /** "Pausada". */
  pause: [
    ["rect", { x: "5.5", y: "4.5", width: "3", height: "11", rx: "1" }],
    ["rect", { x: "11.5", y: "4.5", width: "3", height: "11", rx: "1" }],
  ],
  /** Voice messages: record. */
  mic: [
    ["rect", { x: "7.5", y: "3", width: "5", height: "9", rx: "2.5" }],
    ["path", { d: "M4.8 9.8a5.2 5.2 0 0 0 10.4 0M10 15v2.5" }],
  ],
  /** A voice message's words, opened on demand. */
  note: [["path", { d: "M4.5 6h11M4.5 10h11M4.5 14h6.5" }]],
  /** "Ver de novo": a video that ended. */
  replay: [["path", { d: "M4.5 10a5.5 5.5 0 1 0 1.7-4M5.5 3v3.5H9" }]],
  /** "Tirar o som": a speaker with its sound. */
  volume: [["path", { d: "M3.5 8v4h3l4 3.5v-11l-4 3.5zM13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.3 6.3 0 0 1 0 9" }]],
  /** "Ligar o som": the speaker crossed. */
  mute: [["path", { d: "M3.5 8v4h3l4 3.5v-11l-4 3.5zM13.5 8l4 4M17.5 8l-4 4" }]],
  /** "Tela cheia": four corners pointing out. */
  fullscreen: [["path", { d: "M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" }]],
  /** "Sair da tela cheia": four corners pointing in. */
  fullscreenExit: [["path", { d: "M7.5 3.5v4h-4M16.5 7.5h-4v-4M12.5 16.5v-4h4M3.5 12.5h4v4" }]],
  /** A video file: a frame with a play mark. */
  video: [
    ["rect", { x: "3", y: "4.5", width: "14", height: "11", rx: "2.5" }],
    ["path", { d: "m8.5 7.8 3.7 2.2-3.7 2.2z" }],
  ],
  /** An uploaded file of any type (Drive). */
  file: [["path", { d: "M6 3h6l3.5 3.5V17H6zM12 3v3.5h3.5" }]],
  /** An image file. */
  image: [
    ["rect", { x: "3.5", y: "4.5", width: "13", height: "11", rx: "2" }],
    ["circle", { cx: "8", cy: "8.5", r: "1.3" }],
    ["path", { d: "m4 14 4-3.5 3 2.5 2.5-2 3 2.5" }],
  ],
  /** A zip or other archive. */
  archive: [
    ["path", { d: "M6 3h6l3.5 3.5V17H6zM12 3v3.5h3.5" }],
    ["path", { d: "M9 5v1.5M9 8v1.5M8 11.5h2V14H8z" }],
  ],
  /** "Enviar arquivo". */
  upload: [["path", { d: "M10 13V4M6 7.5 10 3.5l4 4M4.5 16.5h11" }]],
  /** A connected computer. */
  computer: [
    ["rect", { x: "3", y: "4", width: "14", height: "9.5", rx: "2" }],
    ["path", { d: "M7.5 16.5h5M10 13.5v3" }],
  ],
  /** A cloud (agentes.chat Cloud, status). */
  cloud: [["path", { d: "M6 15.5a3.5 3.5 0 0 1-.4-7 4.5 4.5 0 0 1 8.7-.9A3.5 3.5 0 0 1 14 15.5z" }]],
  /** "Abrir no celular". */
  phone: [
    ["rect", { x: "5.5", y: "2.5", width: "9", height: "15", rx: "2" }],
    ["path", { d: "M9 14.5h2" }],
  ],
  /**
   * Computers: each computer's line icon (the small form of its
   * portrait, `ComputerIcon`), redrawn from the 24px grid. A laptop with the notch.
   */
  computerMac: [
    ["rect", { x: "3.33", y: "3.75", width: "13.33", height: "9.17", rx: "1.67" }],
    ["path", { d: "M8.67 3.75h2.67v.58a.75 .75 0 0 1-.75 .75h-1.17a.75 .75 0 0 1-.75-.75Z" }],
    ["path", { d: "M2.08 15.17h15.83l-.75 .92a1.33 1.33 0 0 1-1 .5H3.83a1.33 1.33 0 0 1-1-.5Z" }],
  ],
  /** Computers: a monitor on a stand with four tiles. */
  computerWindows: [
    ["rect", { x: "2.5", y: "3.17", width: "15", height: "10.58", rx: "1.67" }],
    ["path", { d: "M7.5 16.83h5M10 13.75v3.08" }],
    ["rect", { x: "6.83", y: "6", width: "2.75", height: "2.17", rx: ".33" }],
    ["rect", { x: "10.42", y: "6", width: "2.75", height: "2.17", rx: ".33" }],
    ["rect", { x: "6.83", y: "8.83", width: "2.75", height: "2.17", rx: ".33" }],
    ["rect", { x: "10.42", y: "8.83", width: "2.75", height: "2.17", rx: ".33" }],
  ],
  /** Computers: a terminal window (Linux's face). */
  computerLinux: [
    ["rect", { x: "2.5", y: "3.75", width: "15", height: "12.5", rx: "2.08" }],
    ["path", { d: "M2.5 7.17h15" }],
    ["path", { d: "m6 10 2.17 1.75-2.17 1.75M10 13.58h3.83" }],
  ],
  /** "Reagir" and the composer's emoji button (our face, never an emoji glyph). */
  smile: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M7.2 11.8c.7.9 1.7 1.4 2.8 1.4s2.1-.5 2.8-1.4M7.6 8.2v.01M12.4 8.2v.01" }],
  ],
  /** GIFs and stickers (ADR 0091): a sticker with its corner peeled. */
  sticker: [
    ["path", { d: "M16.5 10.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v8A2.5 2.5 0 0 0 6 16.5h4.5z" }],
    ["path", { d: "M16.5 10.5H13a2.5 2.5 0 0 0-2.5 2.5v3.5" }],
  ],
  /** "Responder" (quote reply). */
  reply: [["path", { d: "M8 5 4 9l4 4M4 9h7a5 5 0 0 1 5 5v1.5" }]],
  /** Composer formatting: bold. */
  bold: [["path", { d: "M6 4h4.8a3 3 0 0 1 0 6H6zM6 10h5.6a3 3 0 0 1 0 6H6z" }]],
  /** Composer formatting: italic. */
  italic: [["path", { d: "M9 4h6M5 16h6M12 4 8 16" }]],
  /** Composer formatting: strikethrough. */
  strike: [
    [
      "path",
      {
        d: "M4 10h12M13.4 6.3C12.9 5 11.6 4 9.9 4 8 4 6.6 5.1 6.6 6.7c0 .7.3 1.3.9 1.8M6.6 13.5c.5 1.5 1.8 2.5 3.6 2.5 2 0 3.4-1.1 3.4-2.7 0-.5-.1-.9-.4-1.3",
      },
    ],
  ],
  /** Composer formatting: code block. */
  codeBlock: [
    ["rect", { x: "3", y: "4", width: "14", height: "12", rx: "3" }],
    ["path", { d: "M8.2 8.2 6.4 10l1.8 1.8M11.8 8.2l1.8 1.8-1.8 1.8" }],
  ],
  /** Composer formatting: bulleted list. */
  bulletList: [["path", { d: "M8.5 6H16M8.5 10H16M8.5 14H16M4.5 6v.01M4.5 10v.01M4.5 14v.01" }]],
  /** Composer formatting: numbered list. */
  numberedList: [
    [
      "path",
      { d: "M9 6h7M9 10h7M9 14h7M4 4.8l1-.6v3.6M3.8 12.2c.2-.4.6-.7 1.1-.7.6 0 1 .4 1 .9 0 .8-2.1 1.3-2.1 2.4h2.1" },
    ],
  ],
  /** Composer formatting: quote. */
  quote: [["path", { d: "M4.5 4.5v11M8.5 6.5H16M8.5 10H16M8.5 13.5h5" }]],
  /** Criar agente: the model key. */
  key: [
    ["circle", { cx: "7", cy: "12.5", r: "3.2" }],
    ["path", { d: "m9.3 10.2 7-7M14 5.5l2.3 2.3M12.3 7.2l1.7 1.7" }],
  ],
  /** Criar agente: the monthly budget. */
  wallet: [
    ["path", { d: "M3.5 6.5a2 2 0 0 1 2-2H15v3" }],
    ["rect", { x: "3.5", y: "7.5", width: "13", height: "9", rx: "2" }],
    ["path", { d: "M13.5 12h.01" }],
  ],
  /** Criar agente: "Sortear" (a random look). */
  shuffle: [
    ["rect", { x: "3.5", y: "3.5", width: "13", height: "13", rx: "3.5" }],
    ["path", { d: "M7.5 7.5h.01M12.5 12.5h.01M12.5 7.5h.01M7.5 12.5h.01" }],
  ],
  /** The engines' line icons (`BrainIcon`); missions keep the executor names. */
  executorClaude: BRAIN_CLAUDE_CODE,
  executorCodex: BRAIN_CODEX,
  brainClaudeCode: BRAIN_CLAUDE_CODE,
  brainCodex: BRAIN_CODEX,
  brainAgent: BRAIN_AGENT,
  /** Who can talk to an agent: everyone in the workspace (a small crowd). */
  audienceEveryone: [
    ["circle", { cx: "10", cy: "7.25", r: "2.5" }],
    ["path", { d: "M5.5 16c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4" }],
    ["circle", { cx: "4.75", cy: "8.75", r: "1.75" }],
    ["path", { d: "M1.75 15c.3-1.55 1.25-2.55 2.5-2.85" }],
    ["circle", { cx: "15.25", cy: "8.75", r: "1.75" }],
    ["path", { d: "M18.25 15c-.3-1.55-1.25-2.55-2.5-2.85" }],
  ],
  /** Who can talk to an agent: only the people you pick (a person and a check). */
  audiencePeople: [
    ["circle", { cx: "8", cy: "7", r: "2.75" }],
    ["path", { d: "M3 16.25c.65-2.85 2.5-4.4 5-4.4 1.2 0 2.25.35 3.1 1" }],
    ["path", { d: "m12.5 14.75 1.75 1.75 3.5-3.75" }],
  ],
  /** Who can talk to an agent: only the person responsible (a person and a lock). */
  audienceOwner: [
    ["circle", { cx: "8", cy: "7", r: "2.75" }],
    ["path", { d: "M3 16.25c.65-2.85 2.5-4.4 5-4.4 1 0 1.9.25 2.65.7" }],
    ["rect", { x: "12.25", y: "12.75", width: "5.5", height: "4.25", rx: "1" }],
    ["path", { d: "M13.5 12.75v-1.1a1.5 1.5 0 0 1 3 0v1.1" }],
  ],
  /** Criar agente: sensitive actions always ask for approval. */
  shield: [["path", { d: "M10 3 4 5.5v4.5c0 3.6 2.6 6.4 6 7 3.4-.6 6-3.4 6-7V5.5z" }]],
  /** Criar agente: "Conectar outro app". */
  plug: [["path", { d: "M7.5 3v4M12.5 3v4M5 7h10v2.5a5 5 0 0 1-10 0zM10 14.5V17" }]],
  /** Criar agente: "Voltar ao original". */
  undo: [["path", { d: "M7.5 11.5 3.5 7.5l4-4M3.5 7.5h8a5 5 0 0 1 0 10H9" }]],
  /** Criar agente: go somewhere (a channel). */
  arrowRight: [["path", { d: "M4 10h12M11 5l5 5-5 5" }]],
  /** Drive: grid view. */
  grid: [
    ["rect", { x: "3.5", y: "3.5", width: "5.5", height: "5.5", rx: "1.6" }],
    ["rect", { x: "11", y: "3.5", width: "5.5", height: "5.5", rx: "1.6" }],
    ["rect", { x: "3.5", y: "11", width: "5.5", height: "5.5", rx: "1.6" }],
    ["rect", { x: "11", y: "11", width: "5.5", height: "5.5", rx: "1.6" }],
  ],
  /** Drive: list view. */
  list: [["path", { d: "M7.5 5h9M7.5 10h9M7.5 15h9M3.8 5h.01M3.8 10h.01M3.8 15h.01" }]],
  /** Drive: group and sort ("Organizar"). */
  layers: [
    ["path", { d: "m10 2.8 7 3.9-7 3.9-7-3.9z" }],
    ["path", { d: "m3 10.6 7 3.9 7-3.9" }],
  ],
  /** Drive: time left in the trash, group by date. */
  clock: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M10 6.5V10l2.5 1.7" }],
  ],
  /** Drive: open (in the viewer). */
  external: [
    ["path", { d: "M11.5 3.5h5v5M16.5 3.5 9.5 10.5M15 11.5v4a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" }],
  ],
  /** Threads: a thread (a speech box with a line). */
  thread: [
    ["path", { d: "M3.5 4h13v7.5H9l-3.5 3v-3h-2z" }],
    ["path", { d: "M7.5 7.75h5" }],
  ],
  /** Threads: "Tirar do canal" (out of the conversation, into the thread). */
  move: [["path", { d: "M3.5 10h9M9 6l4 4-4 4M16.5 4v12" }]],
  /** Two agents talking to each other ("Theo ⇄ Iris"): one arrow each way. */
  swap: [["path", { d: "M4 7h11.5M13 4.5 15.5 7 13 9.5M16 13H4.5M7 10.5 4.5 13 7 15.5" }]],
  /** Threads: the drag handle on a range's start and end caps. */
  grip: [
    ["circle", { cx: "7.5", cy: "5", r: "0.6" }],
    ["circle", { cx: "12.5", cy: "5", r: "0.6" }],
    ["circle", { cx: "7.5", cy: "10", r: "0.6" }],
    ["circle", { cx: "12.5", cy: "10", r: "0.6" }],
    ["circle", { cx: "7.5", cy: "15", r: "0.6" }],
    ["circle", { cx: "12.5", cy: "15", r: "0.6" }],
  ],
  /** Threads: "Reabrir". */
  refresh: [["path", { d: "M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3.8h-3.8" }]],
  /** Threads: "Arquivar" a thread (a box; `archive` is a zip file). */
  archiveBox: [
    ["rect", { x: "3", y: "3.75", width: "14", height: "3.3", rx: "1" }],
    ["path", { d: "M4.2 7v8.2a.8.8 0 0 0 .8.8h10a.8.8 0 0 0 .8-.8V7M8.3 10.4h3.4" }],
  ],
  /** Threads: "Desarquivar". */
  unarchive: [
    ["rect", { x: "3", y: "3.75", width: "14", height: "3.3", rx: "1" }],
    ["path", { d: "M4.2 7v8.2a.8.8 0 0 0 .8.8h10a.8.8 0 0 0 .8-.8V7M10 14v-4.2M7.9 11.9 10 9.8l2.1 2.1" }],
  ],
  /** Threads: Missões (a flag on a pole). */
  flag: [["path", { d: "M5 17V3.5M5 3.5h9l-1.7 3.3L14 10H5" }]],
  /** Numbers a mission's investigation found (analytics, logs, errors). */
  chart: [["path", { d: "M3.5 16.5h13M6.5 13.5v-3M10 13.5v-7.5M13.5 13.5v-5" }]],
  /** An idea: memory and context. */
  bulb: [["path", { d: "M7.5 15h5M8.3 17.5h3.4M10 2.5a5 5 0 0 0-2.9 9.1v1.7h5.8v-1.7A5 5 0 0 0 10 2.5z" }]],
  /** A question: an agent asks, a decision to make. */
  question: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M8 7.9a2.1 2.1 0 1 1 2.8 1.9c-.5.3-.8.7-.8 1.3v.3M10 14v.01" }],
  ],
  /** Money: a plan, a budget, sales. */
  coin: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    [
      "path",
      {
        d: "M12 7.9c-.3-.8-1.2-1.3-2.1-1.3-1.2 0-2.1.7-2.1 1.7s.8 1.4 2.1 1.7 2.1.7 2.1 1.7-.8 1.7-2.1 1.7c-.9 0-1.8-.5-2.1-1.3M10 5.4v1.2M10 13.4v1.2",
      },
    ],
  ],
  /** Move up in a list. */
  chevronUp: [["path", { d: "m6 12 4-4 4 4" }]],
  /** Repositories: a GitHub repository. */
  repo: [
    ["path", { d: "M5 4.3A1.3 1.3 0 0 1 6.3 3H15v11.5H6.3A1.3 1.3 0 0 0 5 15.8Z" }],
    ["path", { d: "M5 15.8A1.3 1.3 0 0 0 6.3 17H15v-2.5M8 6.5h4" }],
  ],
  /** Repositories: every repository; a public one. */
  globe: [
    ["circle", { cx: "10", cy: "10", r: "7" }],
    ["path", { d: "M3 10h14M10 3a10.5 10.5 0 0 1 0 14M10 3a10.5 10.5 0 0 0 0 14" }],
  ],
  /** The special keys (Tab, Enter, Apagar, Esc) of the agent's browser. */
  keyboard: [
    ["rect", { x: "2.5", y: "5", width: "15", height: "10", rx: "2" }],
    ["path", { d: "M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M5.5 11h.01M14.5 11h.01M8 11.5h4" }],
  ],
  /** The agent's browser: where the typed text goes (the field clicked on the page). */
  pointer: [
    ["path", { d: "m5 4 10 4.17-4.17 1.66L9.17 14 5 4Z" }],
    ["path", { d: "m11 11 3.5 3.5" }],
  ],
  /** Entrar: show the password. */
  eye: [
    [
      "path",
      { d: "M2.5 10c.42-2.08 3.33-5.83 7.5-5.83s7.08 3.75 7.5 5.83c-.42 2.08-3.33 5.83-7.5 5.83S2.92 12.08 2.5 10Z" },
    ],
    ["circle", { cx: "10", cy: "10", r: "2.4" }],
  ],
  /** Consultations: a talk only between two agents (the consultation card's footer). */
  eyeOff: [
    ["path", { d: "M3.3 3.3 16.7 16.7" }],
    [
      "path",
      {
        d: "M8.25 4.33A8 8 0 0 1 10 4.17c4.17 0 7.08 3.75 7.5 5.83a9 9 0 0 1-2 3M5.33 5.5C3.58 6.67 2.67 8.42 2.5 10c.42 2.08 3.33 5.83 7.5 5.83a7.75 7.75 0 0 0 3.5-.83",
      },
    ],
    ["path", { d: "M8.33 8.5a2.17 2.17 0 0 0 3.08 3.08" }],
  ],
  /** Email (ADR 0038): an envelope, for "Outro email" and routines started by an email. */
  mail: [
    ["rect", { x: "2.75", y: "4.5", width: "14.5", height: "11", rx: "2.25" }],
    ["path", { d: "m3.5 6 6.5 5 6.5-5" }],
  ],
  /** A database (ADR 0039): the Postgres connector's card, row and steps. */
  database: [
    ["path", { d: "M4 5c0-1.24 2.69-2.25 6-2.25S16 3.76 16 5s-2.69 2.25-6 2.25S4 6.24 4 5Z" }],
    ["path", { d: "M4 5v10c0 1.24 2.69 2.25 6 2.25s6-1.01 6-2.25V5" }],
    ["path", { d: "M4 10c0 1.24 2.69 2.25 6 2.25s6-1.01 6-2.25" }],
  ],
} satisfies Record<string, IconShape[]>;
