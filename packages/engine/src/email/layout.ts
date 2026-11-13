import type { InlinePart } from "@agenteschat/adapters";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { dark, light, type ThemeColors } from "@agenteschat/tokens";
import {
  type AccessoryName,
  AGENT_GRADIENTS,
  type AgentColorName,
  type EyeStyle,
  nearestPreset,
} from "@agenteschat/ui/agent/engine";
import { COMPUTER_ART, COMPUTER_ROWS } from "@agenteschat/ui/computer/portrait";
import { initialsOf } from "@agenteschat/ui/names";
import { mix, opaque } from "@agenteschat/ui/sky/math";

/** The recipient's language: every language of the app (`@agenteschat/i18n/locale`). */
export type EmailLocale = AppLocale;

/**
 * Plain text; `{ b }` is bold. `{ mail }` is an address as a mailto link: already a link, no client links it on its
 * own, so it needs none of the hair spaces that break copying typed text (`inertText`). `{ nobr }` stays on one line,
 * moving to the next one whole (a host would break at its hyphens), and breaks inside only when it is longer than a
 * line, so it never widens the email. The layout escapes every string, so the words never hold HTML.
 */
export type Inline = string | { b: string } | { mail: string } | { nobr: string };
export type Text = Inline | Inline[];
export type Block =
  | { p: Text }
  | { small: Text }
  /** A section title inside the card: a heading, so screen readers can jump to it. */
  | { h2: string }
  | { steps: [title: string, text: string][] }
  | { facts: [label: string, value: Text][] }
  | { note: Text; tone?: "warn" }
  /** A name with a line under it. `agent`: the agent's color (its face); none: a person's initials tile. */
  | { people: { name: string; detail: Text; agent?: string }[] }
  /** The primary button, and an optional second action as a link beside it. */
  | { button: string; url: string; also?: { label: string; url: string; danger?: boolean } }
  /** For emails whose link is the point: the address to copy when the button doesn't work. */
  | { fallback: string; url: string }
  /** A one-time code to type: large in a well, selectable as one word. */
  | { code: string };

/** An agent's look as the app keeps it (`appearance`): a part left out is the app's default (sky, round eyes, none). */
export interface Look {
  color?: string;
  eyes?: string;
  accessory?: string;
}

/**
 * A picture at the card's top: the agents standing on one floor, half on each side of the workspace's computer
 * (`computer`: its alt text, our words), or in a row without it. The words never depend on it, so the faces have no
 * alt text.
 */
export interface Scene {
  crew: readonly Look[];
  computer?: string;
}

export interface EmailDoc {
  lang: EmailLocale;
  subject: string;
  /** The line an inbox shows after the subject: our words only. */
  preheader: string;
  headline: string;
  scene?: Scene;
  blocks: Block[];
  /** Why this address got it, how often, who sent it. */
  footer: Text[];
}

/**
 * Where an email's pictures come from: this server's `/email/` (`base`), or attached to each message
 * (`base` null, `files` read from the web app's `email/` folder), for a server people outside can't reach.
 */
export interface EmailArt {
  /** The server's own address: the logo links there. */
  home: string;
  /** `{PUBLIC_URL}/email/`, or null when the pictures are attached. */
  base: string | null;
  /** The pictures to attach, by file name (attached mode). */
  files: Map<string, Uint8Array> | null;
}

const AGENT_FACES = Object.keys(AGENT_GRADIENTS);
/**
 * The workspace's computer as the app draws it (a server: `WORKSPACE_COMPUTER_KIND` in packages/client), online, its
 * lights on at `t`, shown at `cell` px a cell, with `margin` empty columns on each side: room for its alt text to fit
 * with the pictures off. `packages/engine/scripts/email-art.ts` draws its file.
 */
export const COMPUTER = { file: "computer.png", kind: "linux", cell: 2, t: 0.75, margin: 3 } as const;
/**
 * The onboarding's own agents, Theo, Ada, Lia and Atlas (`PRESET_LOOK` in packages/client/src/lib/onboarding.ts and
 * apps/mobile/src/features/onboarding/logic.ts), each drawn whole by `packages/engine/scripts/email-art.ts`. Any other
 * look is its colour's face.
 */
export const ONBOARDING_CREW = [
  { color: "indigo", eyes: "round", accessory: "cap" },
  { color: "green", eyes: "wide", accessory: "headphones" },
  { color: "rose", eyes: "dots", accessory: "flower" },
  { color: "amber", eyes: "round", accessory: "antenna" },
] as const satisfies readonly { color: AgentColorName; eyes: EyeStyle; accessory: AccessoryName }[];
/**
 * A look drawn whole, in px as shown: the colour face's body (`body` wide, at `x` and `y`, as far from the left and the
 * bottom as `agent-<colour>.png` has it) in a box with room above and to the right for any accessory (ACCESSORY_REACH
 * in the agent engine, and a cap's brim one cell past it).
 */
export const WHOLE = { width: 36, height: 46, x: 2, y: 16, body: 28 } as const;
export const wholeFile = (look: Required<Look>) => `agent-${look.color}-${look.eyes}-${look.accessory}.png`;
/**
 * The ink logo with its wordmark on a rounded tile of the page's colour: unseen on our light page, and the wordmark
 * still reads where a client darkens the page but not the picture (the Gmail apps, Gmail with other accounts, classic
 * Outlook), or inverts the picture too. `logo-ink.png`, without the tile, stays for the emails already sent.
 */
const LOGO_INK = "logo-ink-tile.png";
/** Every picture an email may show, as the web app serves them (`apps/web/public/email/`). */
export const EMAIL_PICTURES = [
  LOGO_INK,
  "logo-bone.png",
  COMPUTER.file,
  "sky-band.png",
  ...AGENT_FACES.map((c) => `agent-${c}.png`),
  ...ONBOARDING_CREW.map(wholeFile),
];
const FONT = "source-sans-3-latin.woff2";
const LOGO = { width: 173, height: 36, alt: "agentes.chat" } as const;
const SKY = { width: 552, height: 27 } as const;
/** An agent's face for its colour: a custom "#rrggbb" is the closest preset's, an unknown one is sky, as the app draws it. */
const faceOf = (color: string) => `agent-${nearestPreset(color)}.png`;
/** A look's picture: drawn whole when it is one of the onboarding's, else its colour's face. */
function pictureOf({ color = "sky", eyes = "round", accessory = "none" }: Look) {
  const whole = ONBOARDING_CREW.find((o) => o.color === color && o.eyes === eyes && o.accessory === accessory);
  return whole
    ? { file: wholeFile(whole), width: WHOLE.width, height: WHOLE.height }
    : { file: faceOf(color), width: 32, height: 32 };
}

/** Classic Outlook has no rgba: hairlines are the solid color they show over their surface. */
const palette = (t: ThemeColors) => ({
  page: t.bg,
  card: t.raised,
  border: opaque(t.line2, t.raised),
  well: t.sunken,
  wellHair: opaque(t.line, t.sunken),
  ink: t.ink,
  text: t.ink2,
  muted: t.muted,
  faint: t.faint,
  action: t.action,
  /** The top of the primary button's gradient, as the app's `color-mix(in srgb, var(--ink) 82%, var(--bg))`. */
  actionTop: mix(t.action, t.bg, 0.18),
  onAction: t.onAction,
  warnSoft: t.warnSoft,
  warn: t.warn,
  danger: t.danger,
});
const L = palette(light);
const D = palette(dark);

/** Japanese, Chinese and Korean fall back to each system's own fonts before the generic one. */
const SANS =
  "'Source Sans 3',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Hiragino Sans','PingFang SC','Microsoft YaHei','Apple SD Gothic Neo','Malgun Gothic',sans-serif";

/**
 * The bottom margin of the card's last block, by what its lowest ink is: the room under that ink then matches the
 * room over the headline's, which is the card's padding plus the 4 px of the headline's line above its ink. A line
 * of text keeps about 2 px of its line under its descenders or its link's underline, and the button's shadow shows
 * about 2 px under it in light and none on the dark card (`.end-btn`). Whole pixels: the card's cell rounds its
 * height up, so half a pixel would count as one.
 */
const END = { text: 2, box: 4, button: 6 };

/**
 * The dark design, by class. The media query reaches Apple Mail, the Outlook apps, Samsung and Thunderbird;
 * the same rules under `[data-ogsc]`/`[data-ogsb]` reach Outlook.com and new Outlook, which stamp what
 * they recolour. No rule uses #ffffff: Apple Mail ignores it in dark rules. The Gmail apps read no media query and
 * darken the light design themselves, so nothing in it may depend on a colour they leave alone (`EMAIL_DARK_HEAD`).
 */
const DARK = [
  `.bg{background:${D.page}!important}`,
  `.card{background:${D.card}!important;border-color:${D.border}!important}`,
  `.ink{color:${D.ink}!important}`,
  `.tx{color:${D.text}!important}`,
  `.mu{color:${D.muted}!important}`,
  `.fa{color:${D.faint}!important}`,
  `.well{background:${D.well}!important}`,
  `.wh{border-color:${D.wellHair}!important}`,
  `.num{background:${D.card}!important;border-color:${D.border}!important;color:${D.muted}!important}`,
  `.btn{background:${D.action}!important;color:${D.onAction}!important;border-color:${D.action}!important}`,
  `.btn span{color:${D.onAction}!important}`,
  `.ln{color:${D.ink}!important;text-decoration-color:${D.border}!important}`,
  `.avp{background:${D.well}!important;color:${D.text}!important;border-color:${D.border}!important}`,
  `.warn{background:${D.warnSoft}!important}`,
  `.warn-t{color:${D.warn}!important}`,
  `.ln-d{color:${D.danger}!important;text-decoration-color:${D.border}!important}`,
  `.ln-m{color:${D.muted}!important;text-decoration-color:${D.border}!important}`,
  `.end-btn{margin-bottom:${END.box}px!important}`,
  ".logo-ink{display:none!important}",
  ".logo-bone{display:block!important}",
];

const PHONE = [
  ".px{padding-left:16px!important;padding-right:16px!important}",
  ".card{padding:24px 20px!important}",
  ".h1{font-size:22px!important;line-height:28px!important}",
  ".sky{width:100%!important;height:auto!important}",
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** The muted house link. */
const LINK_MUTED = `color:${L.muted};text-decoration:underline;text-decoration-color:${L.border};text-underline-offset:3px`;

const inlines = (t: Text): Inline[] => (Array.isArray(t) ? t : [t]);
const nobr = (inner: string) => `<span style="display:inline-block">${inner}</span>`;

/**
 * A text's parts, split before its last two words: those move down together, so a wrapped text never ends on a word
 * alone (held whole, as `{ nobr }` does: a no-break space would still split "e-mail" at its hyphen). Bold words stay
 * bold on both sides. A text of one or two words, or one that ends in a `{ nobr }` of its own, isn't split.
 */
function closing(parts: Inline[]): [head: Inline[], tail: Inline[]] {
  const last = parts.at(-1);
  if (typeof last === "object" && "nobr" in last) return [parts, []];
  let spaces = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i] ?? "";
    // An address or a `{ nobr }` inside the text is one word.
    const text = typeof p === "string" ? p : "b" in p ? p.b : "";
    for (let at = text.lastIndexOf(" "); at >= 0; at = at > 0 ? text.lastIndexOf(" ", at - 1) : -1) {
      if (++spaces < 2) continue;
      const piece = (s: string): Inline[] => (!s ? [] : typeof p === "string" ? [s] : [{ b: s }]);
      return [
        [...parts.slice(0, i), ...piece(text.slice(0, at + 1))],
        [...piece(text.slice(at + 1)), ...parts.slice(i + 1)],
      ];
    }
  }
  return [parts, []];
}

const html = (t: Text, bold = `font-weight:600;color:${L.ink}`) => {
  const part = (i: Inline) =>
    typeof i === "string"
      ? esc(i)
      : "b" in i
        ? `<b class="ink" style="${bold}">${esc(i.b)}</b>`
        : "mail" in i
          ? `<a class="ln-m" href="mailto:${esc(i.mail)}" style="${LINK_MUTED}">${esc(i.mail)}</a>`
          : nobr(esc(i.nobr));
  const [head, tail] = closing(inlines(t));
  return head.map(part).join("") + (tail.length ? nobr(tail.map(part).join("")) : "");
};
const plain = (t: Text) =>
  inlines(t)
    .map((i) => (typeof i === "string" ? i : "b" in i ? i.b : "mail" in i ? i.mail : i.nobr))
    .join("");

const T = (style: string) =>
  `role="presentation" cellpadding="0" cellspacing="0" border="0"${style ? ` style="${style}"` : ""}`;
const P = `font-family:${SANS};mso-line-height-rule:exactly`;
/**
 * `P` where typed text goes: a word too long for the line breaks instead of widening the card, since a
 * table cell grows to its longest word. Not on the facts' labels: there it would let a long value squeeze
 * a label mid-word.
 */
const PW = `${P};word-break:break-word`;
/** `P` for a link button: classic Outlook clips a button whose line height is exact. */
const PB = `font-family:${SANS};mso-line-height-rule:at-least`;
/**
 * The app's primary button (`.ac-btn--primary` in `packages/ui/src/styles/components.css`): its highlight, bottom
 * edge and shadows. Every client that draws box-shadow reads rgba(). The app's dark highlight is .12, too close to
 * matter on a 1 px line, so one value serves both themes.
 */
const LIFT =
  "inset 0 1px 0 rgba(255,255,255,.18),inset 0 -1px 0 rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.18),0 6px 14px -6px rgba(0,0,0,.45)";

const cidOf = (file: string) => `${file.replace(/\.png$/, "")}@agentes.chat`;

/** The pictures one email shows: linked, or attached (only those its HTML names). */
function pictures(art: EmailArt) {
  const used = new Set<string>();
  const src = (file: string) => {
    used.add(file);
    return art.base ? `${art.base}${file}` : `cid:${cidOf(file)}`;
  };
  const inline = (): InlinePart[] =>
    EMAIL_PICTURES.flatMap((file) => {
      const content = art.base || !used.has(file) ? undefined : art.files?.get(file);
      return content ? [{ cid: cidOf(file), filename: file, contentType: "image/png", content }] : [];
    });
  return { src, inline };
}

function block(b: Block, src: (file: string) => string, last: boolean): string {
  const gap = (between: number, ink: keyof typeof END = "text") => (last ? END[ink] : between);
  // In a block of rows, the last block's last row keeps no room of its own: the block's margin is the room under it.
  const under = (i: number, rows: unknown[], between: number) => (last && i === rows.length - 1 ? 0 : between);
  if ("p" in b)
    return `<p class="tx" style="margin:0 0 ${gap(16)}px;${PW};font-size:16px;line-height:24px;color:${L.text}">${html(b.p)}</p>`;
  if ("small" in b)
    return `<p class="mu" style="margin:0 0 ${gap(12)}px;${P};font-size:14px;line-height:20px;color:${L.muted}">${html(b.small)}</p>`;
  if ("h2" in b)
    return `<h2 class="ink" style="margin:24px 0 12px;${P};font-size:16px;line-height:22px;font-weight:600;color:${L.ink}">${esc(b.h2)}</h2>`;
  if ("steps" in b)
    return `<table width="100%" ${T(`margin:0 0 ${gap(4)}px`)}>${b.steps
      .map(
        ([title, text], i) => `<tr>
<td width="36" valign="top" style="width:36px;padding:0 0 ${under(i, b.steps, 14)}px"><table ${T("")}><tr><td class="num" width="22" height="22" align="center" valign="middle" style="width:22px;height:22px;border:1px solid ${L.border};border-radius:7px;background:${L.card};${P};font-size:13px;line-height:22px;font-weight:600;color:${L.muted}">${i + 1}</td></tr></table></td>
<td valign="top" class="tx" style="padding:0 0 ${under(i, b.steps, 14)}px;${P};font-size:16px;line-height:24px;color:${L.text}"><b class="ink" style="font-weight:600;color:${L.ink}">${esc(title)}</b> ${html(text)}</td>
</tr>`,
      )
      .join("")}</table>`;
  if ("facts" in b)
    return `<table width="100%" class="well" ${T(`background:${L.well};border-radius:12px;margin:0 0 ${gap(20, "box")}px`)}><tr><td style="padding:4px 16px">
<table width="100%" ${T("")}>${b.facts
      .map(
        ([label, value], i) => `<tr>
<td class="mu${i ? " wh" : ""}" valign="top" style="padding:10px 12px 10px 0;${i ? `border-top:1px solid ${L.wellHair};` : ""}${P};font-size:14px;line-height:20px;color:${L.muted}">${esc(label)}</td>
<td class="ink${i ? " wh" : ""}" valign="top" align="right" style="padding:10px 0;${i ? `border-top:1px solid ${L.wellHair};` : ""}${PW};font-size:14px;line-height:20px;font-weight:600;color:${L.ink};text-align:right">${html(value)}</td>
</tr>`,
      )
      .join("")}</table></td></tr></table>`;
  if ("note" in b) {
    const warn = b.tone === "warn";
    return `<table width="100%" class="${warn ? "warn" : "well"}" ${T(`background:${warn ? L.warnSoft : L.well};border-radius:12px;margin:0 0 ${gap(16, "box")}px`)}><tr>
<td class="${warn ? "warn-t" : "tx"}" style="padding:14px 16px;${PW};font-size:15px;line-height:22px;color:${warn ? L.warn : L.text}">${html(b.note, warn ? "font-weight:700" : `font-weight:600;color:${L.ink}`)}</td></tr></table>`;
  }
  if ("people" in b)
    // The face starts 5 px down, where the name's capitals start on its 15/20 px line (4.5 to 5.7 px across Source
    // Sans 3 and the system fonts): beside a name with a line under it, as the app's `.ac-captop`. Padding, not a
    // negative margin, which classic Outlook ignores.
    return `<table width="100%" ${T(`margin:0 0 ${gap(8)}px`)}>${b.people
      .map(
        (p, i) => `<tr>
<td width="44" valign="top" style="width:44px;padding:5px 0 ${under(i, b.people, 12)}px">${
          p.agent
            ? `<img src="${esc(src(faceOf(p.agent)))}" width="32" height="32" alt="" style="display:block;border:0;outline:none;width:32px;height:32px">`
            : `<table ${T("")}><tr><td class="avp" width="30" height="30" align="center" valign="middle" style="width:30px;height:30px;border:1px solid ${L.border};border-radius:10px;background:${L.well};color:${L.text};${P};font-size:13px;line-height:30px;font-weight:700">${esc(initialsOf(p.name))}</td></tr></table>`
        }</td>
<td valign="top" style="padding:0 0 ${under(i, b.people, 12)}px">
<p class="ink" style="margin:0;${PW};font-size:15px;line-height:20px;font-weight:600;color:${L.ink}">${esc(p.name)}</p><p class="mu" style="margin:0;${PW};font-size:14px;line-height:20px;color:${L.muted}">${html(p.detail)}</p></td>
</tr>`,
      )
      .join("")}</table>`;
  if ("code" in b)
    // Letter spacing trails the last digit too: 8 px more on the left keeps the digits centred.
    return `<table width="100%" class="well" ${T(`background:${L.well};border-radius:12px;margin:0 0 ${gap(20, "box")}px`)}><tr>
<td class="ink" align="center" style="padding:16px 16px 16px 24px;${P};font-size:32px;line-height:40px;font-weight:700;letter-spacing:8px;font-variant-numeric:tabular-nums;color:${L.ink};text-align:center">${esc(b.code)}</td></tr></table>`;
  if ("button" in b) {
    // A link button, clickable everywhere; classic Outlook gets its own spacers, in em at the 15 px label, and draws
    // it square and flat. Its gradient comes only from the colour-scheme blocks in the head: the Gmail apps darken a
    // fill and its label but leave a gradient as drawn, which would put a darkened label on the light design's ink.
    // The border in the fill's colour is unseen in light; Gmail for Android lightens it as a line, so the button keeps
    // an edge on its darkened card. It takes 1 px of the padding: still 48 tall.
    const btn = `<a class="btn" href="${esc(b.url)}" target="_blank" style="display:inline-block;background-color:${L.action};border:1px solid ${L.action};border-radius:14px;box-shadow:${LIFT};color:${L.onAction};${PB};font-size:15px;line-height:20px;font-weight:600;text-decoration:none;padding:13px 15px;mso-padding-alt:0;text-underline-color:${L.action}"><!--[if mso]><i style="mso-font-width:107%;mso-text-raise:187%" hidden>&emsp;</i><![endif]--><span style="mso-text-raise:93%;color:${L.onAction}">${esc(b.button)}</span><!--[if mso]><i style="mso-font-width:107%" hidden>&emsp;&#8203;</i><![endif]--></a>`;
    // Four spaces too: classic Outlook ignores the span's width. The second label has no colour of its own, so the
    // dark rules reach it through the link, and classic Outlook raises it like the button's.
    const also = b.also
      ? `<span style="display:inline-block;width:16px;font-size:15px;line-height:20px">&nbsp;&nbsp;&nbsp;&nbsp;</span><a class="${b.also.danger ? "ln-d" : "ln"}" href="${esc(b.also.url)}" target="_blank" style="display:inline-block;padding:14px 0;color:${b.also.danger ? L.danger : L.ink};${PB};font-size:15px;line-height:20px;font-weight:600;text-decoration:underline;text-decoration-color:${L.border};text-underline-offset:3px;text-underline-color:${L.border}"><span style="mso-text-raise:93%">${esc(b.also.label)}</span></a>`
      : "";
    return `<table${last ? ' class="end-btn"' : ""} ${T(`margin:8px 0 ${gap(20, "button")}px`)}><tr><td>${btn}${also}</td></tr></table>`;
  }
  return `<p class="mu" style="margin:0 0 ${gap(12)}px;${P};font-size:13px;line-height:19px;color:${L.muted}">${html(b.fallback)}<br><a class="ln-m" href="${esc(b.url)}" target="_blank" style="${LINK_MUTED};word-break:break-all">${esc(b.url)}</a></p>`;
}

/**
 * The scene at the card's top. With the computer, a stage in a well, as the app's onboarding scene: the computer in
 * the middle whatever the crew's size (two cells split the rest), the faces standing 2 px up so their bodies end where
 * the tower's does, above its shadow. Without it, the faces in a row over the headline, the first at the text's edge.
 * With the pictures off, the computer's alt says what is missing, set as a caption.
 */
function scene(s: Scene, src: (file: string) => string): string {
  const img = (file: string, width: number, height: number, alt: string) =>
    `<img src="${esc(src(file))}" width="${width}" height="${height}" alt="${esc(alt)}" style="display:block;border:0;outline:none;width:${width}px;height:${height}px;${P};font-size:11px;line-height:14px;color:${L.muted}">`;
  // A look drawn whole is wider on the right, for its accessory: that much less room after it keeps the bodies' spacing.
  const faces = (crew: readonly Look[], left: number, right: number, bottom: number) =>
    crew
      .map((look) => {
        const p = pictureOf(look);
        return `<td valign="bottom" style="padding:0 ${right - (p.width - 32)}px ${bottom}px ${left}px">${img(p.file, p.width, p.height, "")}</td>`;
      })
      .join("");
  if (s.computer === undefined) return `<table ${T("margin:0 0 20px")}><tr>${faces(s.crew, 0, 8, 0)}</tr></table>`;
  const side = (crew: readonly Look[]) =>
    crew.length ? `<table ${T("")}><tr>${faces(crew, 4, 4, 2)}</tr></table>` : "";
  const half = Math.ceil(s.crew.length / 2);
  const width = (COMPUTER_ART[COMPUTER.kind][1] + 2 * COMPUTER.margin) * COMPUTER.cell;
  const height = COMPUTER_ROWS[COMPUTER.kind][1] * COMPUTER.cell;
  return `<table width="100%" class="well" ${T(`background:${L.well};border-radius:14px 14px 14px 3px;margin:0 0 24px`)}><tr><td style="padding:20px 8px 16px">
<table width="100%" ${T("")}><tr>
<td width="50%" align="right" valign="bottom">${side(s.crew.slice(0, half))}</td>
<td valign="bottom" style="padding:0 2px">${img(COMPUTER.file, width, height, s.computer)}</td>
<td width="50%" align="left" valign="bottom">${side(s.crew.slice(half))}</td>
</tr></table></td></tr></table>`;
}

/** The plain-text part of a block: the same words, a button as `Label: url`. */
function text(b: Block): string {
  if ("p" in b) return plain(b.p);
  if ("small" in b) return plain(b.small);
  if ("h2" in b) return b.h2;
  if ("steps" in b) return b.steps.map(([title, x], i) => `${i + 1}. ${title} ${x}`).join("\n");
  if ("facts" in b) return b.facts.map(([label, v]) => `${label}: ${plain(v)}`).join("\n");
  if ("note" in b) return plain(b.note);
  // "Theo, Merge pull request #42" would read as an order to Theo.
  if ("people" in b) return b.people.map((p) => `${p.name} · ${plain(p.detail)}`).join("\n");
  if ("code" in b) return b.code;
  if ("button" in b) return [`${b.button}: ${b.url}`, ...(b.also ? [`${b.also.label}: ${b.also.url}`] : [])].join("\n");
  // The address is already in the button's line.
  return "";
}

/**
 * Light and dark, in every email: both schemes declared, our dark design by media query and again under Outlook.com's
 * hooks, and the button's gradients. Declaring dark lets the Gmail apps darken the light design themselves, the only
 * dark they draw (`light only` would keep them light inside their dark UI). Risky rules sit in blocks of their own, so a
 * client that drops one keeps the rest. Each gradient comes after the flat fill it paints over: a client that rejects
 * it keeps the flat fill, and Outlook.com's hooks outrank the light one.
 */
export const EMAIL_DARK_HEAD = `<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
</style>
<style>
@media (prefers-color-scheme:dark){${DARK.join("")}}
</style>
<style>
${DARK.map((r) => `[data-ogsc] ${r}[data-ogsb] ${r}`).join("\n")}
</style>
<style>
@media (prefers-color-scheme:light){.btn{background-image:linear-gradient(180deg,${L.actionTop} 0%,${L.action} 100%)!important}}
</style>
<style>
@media (prefers-color-scheme:dark){.btn{background-image:linear-gradient(180deg,${D.actionTop} 0%,${D.action} 100%)!important}}
</style>`;

/** After the preheader, so the body's first words don't trail into the inbox preview (iOS and Yahoo need the last two). */
const FILLER = "&#847;&zwnj;&nbsp;&#8199;&shy;".repeat(60);

/**
 * One email in our look: the light design inline, our dark design for the clients that apply an email's
 * own (`EMAIL_DARK_HEAD`), and a plain-text part with the same words.
 */
export function renderDoc(doc: EmailDoc, art: EmailArt): { html: string; text: string; inline: InlinePart[] } {
  const { src, inline } = pictures(art);
  // The app's face from this server's own `/email/`, beside the pictures. A mail app that can't load it shows the stack
  // after it at once (`swap`). With the pictures attached the email fetches nothing, the face included: an address no
  // reader can reach would only bring remote-content warnings. Classic Outlook never sees the rule, and Gmail, which
  // loads no web font, drops this block alone.
  const fonts = art.base;
  const lang = doc.lang;
  const body = doc.blocks.map((b, i) => block(b, src, i === doc.blocks.length - 1)).join("\n");
  const logo = (file: string, cls: string, display: string, color: string) =>
    `<img class="${cls}" src="${esc(src(file))}" width="${LOGO.width}" height="${LOGO.height}" alt="${LOGO.alt}" style="display:${display};border:0;outline:none;width:${LOGO.width}px;height:${LOGO.height}px;font-family:${SANS};font-size:20px;font-weight:600;line-height:${LOGO.height}px;color:${color}">`;
  const page = `<!doctype html>
<html lang="${lang}" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
${EMAIL_DARK_HEAD}
<title>${esc(doc.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>body,table,td,p,a,span,b,h1,h2{font-family:'Segoe UI',Arial,sans-serif!important}</style><![endif]-->
<style>
body{margin:0!important;padding:0!important;width:100%!important}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
@media (max-width:620px){${PHONE.join("")}}
</style>
${fonts ? `<!--[if !mso]><!--><style>@font-face{font-family:'Source Sans 3';font-style:normal;font-weight:200 900;font-display:swap;size-adjust:107%;src:url('${esc(`${fonts}${FONT}`)}') format('woff2')}</style><!--<![endif]-->` : ""}
</head>
<body class="body bg" style="margin:0;padding:0;width:100%;background:${L.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${esc(doc.preheader)}${FILLER}</div>
<div role="article" aria-roledescription="email" aria-label="${esc(doc.subject)}" lang="${lang}" dir="ltr">
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${L.page}">
<tr><td align="center" class="px" style="padding:0 24px">
<!--[if mso]><table role="presentation" width="552" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:552px;margin:0 auto">
<tr><td style="padding:32px 0 20px">
<a href="${esc(art.home)}" target="_blank" style="display:inline-block;text-decoration:none">
${logo(LOGO_INK, "logo-ink", "block", L.ink)}
<!--[if !mso]><!-->${logo("logo-bone.png", "logo-bone", "none", D.ink)}<!--<![endif]-->
</a>
</td></tr>
<tr><td class="card" style="background:${L.card};border:1px solid ${L.border};border-radius:16px;padding:32px">
${doc.scene ? scene(doc.scene, src) : ""}<h1 class="h1 ink" style="margin:0 0 16px;${P};font-size:24px;line-height:30px;font-weight:600;letter-spacing:-0.01em;color:${L.ink}">${html(doc.headline)}</h1>
${body}
</td></tr>
<tr><td style="padding:24px 0 0"><img class="sky" src="${esc(src("sky-band.png"))}" width="${SKY.width}" height="${SKY.height}" alt="" style="display:block;border:0;outline:none;width:${SKY.width}px;max-width:100%;height:auto"></td></tr>
<tr><td style="padding:16px 0 40px">
${doc.footer.map((f) => `<p class="fa" style="margin:0 0 6px;${PW};font-size:13px;line-height:19px;color:${L.faint}">${html(f)}</p>`).join("\n")}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>`;
  const parts = [doc.headline, ...doc.blocks.map(text).filter(Boolean), doc.footer.map(plain).join("\n")];
  return { html: page, text: `${parts.join("\n\n")}\n`, inline: inline() };
}
