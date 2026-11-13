import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakeEmailSender, EmailError } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  createJobHandlers,
  defaultEmailFrom,
  drainOutbox,
  EMAIL_DARK_HEAD,
  EMAIL_PICTURES,
  type EmailArt,
  type EmailTemplate,
  emailArtAt,
  emailArtFor,
  emailCrew,
  grantScopes,
  postPersonMessage,
  queueApprovalDigests,
  queueBudgetEmail,
  queueEmail,
  queueInvitationEmail,
  renderEmail,
  sendQueuedEmail,
} from "../src";
import { BREAK } from "../src/email/inert";
import { EMAIL_SAMPLES } from "./email-samples";
import { addMember, type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const art = emailArtAt("https://x.test");
const WEB_DIR = resolve(import.meta.dir, "../../../apps/web/public");
/** Every field people type or agents write. */
const TYPED = [
  "orgName",
  "inviterName",
  "inviterEmail",
  "email",
  "title",
  "agentName",
  "name",
  "approverName",
  "reason",
  "byName",
  "appName",
];
const SENTINEL = "Zq9 evil.com";
const withoutUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "");
/** The headline as it reads: its last words keep together in a span of their own. */
const headline = (html: string) =>
  (html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? "?").replace(/<[^>]+>/g, "").replaceAll("&#39;", "'");
const buttons = (t: EmailTemplate) =>
  [...renderEmail(t, art).html.matchAll(/<a class="btn" href="([^"]*)"[^>]*>.*?<span[^>]*>([^<]*)<\/span>/g)].map(
    (m) => ({ url: (m[1] ?? "").replaceAll("&amp;", "&"), label: m[2] ?? "" }),
  );

function poisoned(t: EmailTemplate, value = SENTINEL): EmailTemplate {
  const o = structuredClone(t) as Record<string, unknown>;
  for (const k of TYPED) if (typeof o[k] === "string") o[k] = value;
  if (Array.isArray(o.items)) o.items = o.items.map((i) => ({ ...i, agentName: value, title: value }));
  if (Array.isArray(o.orgNames)) o.orgNames = o.orgNames.map(() => value);
  for (const side of ["was", "now"]) if (o[side]) o[side] = { ...(o[side] as object), names: [value] };
  for (const list of ["topStalls", "topNoise"])
    if (Array.isArray(o[list])) o[list] = (o[list] as object[]).map((w) => ({ ...w, name: value }));
  return o as EmailTemplate;
}

describe("every email, in both languages", () => {
  for (const [id, sample] of Object.entries(EMAIL_SAMPLES)) {
    for (const locale of ["en", "pt-BR"] as const) {
      const t = { ...sample, locale } as EmailTemplate;
      test(`${id} in ${locale}`, () => {
        const e = renderEmail(t, art);
        expect(e.html).toContain(`<html lang="${locale}"`);
        expect(e.preheader.length).toBeGreaterThanOrEqual(10);
        expect(e.html).toMatch(
          new RegExp(
            `<body[^>]*>\\n<div style="[^"]*">${e.preheader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#39;")}`,
          ),
        );
        expect(e.text.startsWith(headline(e.html))).toBe(true);
        for (const b of buttons(t)) expect(e.text).toContain(`${b.label}: ${b.url}`);
        expect(`${e.subject}${e.html}${e.text}`).not.toMatch(/undefined|null|\{\w+\}/);
        expect(e.html.length).toBeLessThan(60_000);
        for (const [, css = ""] of e.html.matchAll(/<style>([\s\S]*?)<\/style>/g))
          expect(css.length).toBeLessThan(8_000);
        // The other language never leaks in (a reset link holds "password").
        expect(withoutUrls(e.text)).not.toMatch(
          locale === "en" ? /você|convite|senha|e-mail/i : /\b(you|invitation|password)\b/i,
        );
        // Our words only in the subject, preheader, headline and buttons; typed words inert in the body.
        const p = renderEmail(poisoned(t), art);
        for (const s of [p.subject, p.preheader, headline(p.html)]) {
          expect(s).not.toContain("Zq9");
        }
        for (const b of buttons(poisoned(t))) expect(b.label).not.toContain("Zq9");
        expect(p.html).not.toContain("evil.com");
        expect(p.text).not.toContain("evil.com");
        // No em dashes or semicolons in our words.
        expect([e.subject, e.preheader, e.text].join("\n")).not.toMatch(/—|;/);
      });
    }
    test(`${id}: snapshot`, () => {
      expect(renderEmail(sample, art).html).toMatchSnapshot();
    });
  }

  test("every kind has a sample, so the preview and a send to a test inbox show them all", () => {
    const kinds: Record<EmailTemplate["kind"], true> = {
      verify_email: true,
      password_reset: true,
      invitation: true,
      invite_request: true,
      calendar_invite: true,
      waitlist_confirm: true,
      early_access: true,
      early_access_allowed: true,
      budget: true,
      approval_digest: true,
      computer_ready: true,
      join_request: true,
      join_answer: true,
      join_code: true,
      deletion_code: true,
      workspace_deleting: true,
      workspace_restored: true,
      account_deleted: true,
      account_deleting: true,
      app_connected: true,
      plan_opened: true,
      plan_lent: true,
      plan_waiting: true,
      autonomy_report: true,
    };
    expect(new Set<string>(Object.values(EMAIL_SAMPLES).map((t) => t.kind))).toEqual(new Set(Object.keys(kinds)));
  });
});

describe("the look", () => {
  const verify = EMAIL_SAMPLES["verify_email.en"] as EmailTemplate;

  test("dark: every email declares both schemes and carries our dark design, nothing keeps a client light", () => {
    for (const [id, t] of Object.entries(EMAIL_SAMPLES)) {
      const { html } = renderEmail(t, art);
      expect(html, id).toContain(EMAIL_DARK_HEAD);
      expect(html, id).not.toContain("light only");
      // The Gmail apps darken fills and text but leave a gradient as drawn: none inline, only the head's.
      expect(html, id).not.toMatch(/style="[^"]*linear-gradient/);
    }
  });

  test("dark: our design where clients apply an email's own, the bone logo hidden from classic Outlook", () => {
    const { html } = renderEmail(verify, art);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(":root{color-scheme:light dark;");
    expect(html).toContain("@media (prefers-color-scheme:dark){.bg{background:#0f0f0e!important}");
    expect(html).toContain("[data-ogsb] .logo-ink{display:none!important}");
    expect(html).toContain('<!--[if !mso]><!--><img class="logo-bone"');
  });

  test("the button is the app's primary at its large size, in layers a client can drop one by one", () => {
    const { html } = renderEmail(EMAIL_SAMPLES["join_request.en"] as EmailTemplate, art);
    const lift =
      "inset 0 1px 0 rgba(255,255,255,.18),inset 0 -1px 0 rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.18),0 6px 14px -6px rgba(0,0,0,.45)";
    // The flat fill and the lift inline; the gradient only where a client reads the colour scheme.
    expect(html).toContain(`background-color:#151514;border:1px solid #151514;border-radius:14px;box-shadow:${lift}`);
    expect(html).toContain(
      "@media (prefers-color-scheme:light){.btn{background-image:linear-gradient(180deg,#3e3e3d 0%,#151514 100%)!important}}",
    );
    expect(html).not.toMatch(/style="[^"]*background-image/);
    expect(html).toContain("font-size:15px;line-height:20px;font-weight:600;text-decoration:none;padding:13px 15px");
    // Dark: the flat bone wherever our dark applies, and the bone gradient in a block of its own after Outlook's hooks.
    expect(html).toContain(".btn{background:#efefec!important;color:#0f0f0e!important;border-color:#efefec!important}");
    const gradient =
      "<style>\n@media (prefers-color-scheme:dark){.btn{background-image:linear-gradient(180deg,#c7c7c4 0%,#efefec 100%)!important}}\n</style>";
    expect(html.indexOf(gradient)).toBeGreaterThan(html.lastIndexOf("[data-ogsb] "));
    // Classic Outlook: its spacers in em at the 15 px label, both labels raised alike, no exact line height on a link.
    expect(html).toContain('<i style="mso-font-width:107%;mso-text-raise:187%" hidden>&emsp;</i>');
    expect(html).toContain('<i style="mso-font-width:107%" hidden>&emsp;&#8203;</i>');
    expect(html).toContain('<span style="mso-text-raise:93%;color:#fbfbfa">Approve</span>');
    expect(html).toContain('<span style="mso-text-raise:93%">Deny</span>');
    expect(html).not.toMatch(/<a [^>]*mso-line-height-rule:exactly/);
    // Deny 16 px after the button, as the app spaces its actions. Four spaces where the width is ignored.
    expect(html).toContain(
      '<span style="display:inline-block;width:16px;font-size:15px;line-height:20px">&nbsp;&nbsp;&nbsp;&nbsp;</span><a class="ln-d"',
    );
  });

  test("the app's primary button is still the one the emails copy", () => {
    const styles = resolve(import.meta.dir, "../../ui/src/styles");
    const css = readFileSync(`${styles}/components.css`, "utf8");
    const at = css.lastIndexOf(".ac-btn--primary {");
    const primary = css.slice(at, css.indexOf("}", at));
    expect(primary).toContain(
      "linear-gradient(180deg, color-mix(in srgb, var(--ink) 82%, var(--bg)) 0%, var(--ink) 100%)",
    );
    for (const layer of [
      "inset 0 1px 0 var(--b1-light)",
      "inset 0 -1px 0 rgba(0, 0, 0, 0.3)",
      "0 1px 2px rgba(0, 0, 0, 0.18)",
      "0 6px 14px -6px rgba(0, 0, 0, 0.45)",
    ])
      expect(primary).toContain(layer);
    expect(css).toMatch(/\[data-theme="light"\] \{[^}]*--b1-light: rgba\(255, 255, 255, 0\.18\);/);
    const tokens = readFileSync(`${styles}/tokens.css`, "utf8");
    for (const lg of ["--control-h-lg: 48px", "--control-r-lg: 14px", "--control-px-lg: 16px", "--control-fs-lg: 15px"])
      expect(tokens).toContain(lg);
  });

  test("the preheader is hidden by display alone, never coloured like the page", () => {
    expect(renderEmail(verify, art).html).toContain(
      '<div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all">One click to confirm',
    );
  });

  test("typed text is escaped and can't link, in both parts", () => {
    const e = renderEmail(
      {
        kind: "invitation",
        locale: "en",
        orgName: "Acme <script>",
        inviterName: "evil.com",
        url: "https://x/i",
        role: "member",
      },
      art,
    );
    expect(e.html).toContain("Acme &lt;script&gt;");
    expect(e.html).not.toContain("<script>");
    expect(e.text).toContain("Acme <script>");
    for (const part of [e.html, e.text]) {
      expect(part).not.toContain("evil.com");
      expect(part).toContain(`evil.${BREAK}com`);
    }
  });

  test("a long token in a typed title breaks, so it can't widen the card on a phone", () => {
    const { text } = renderEmail(EMAIL_SAMPLES["approval_digest-many.en"] as EmailTemplate, art);
    const line = text.split("\n").find((l) => l.startsWith("Atlas")) ?? "";
    expect(line).toContain("3f2a9c1e");
    expect(line).not.toMatch(/\S{31}/u);
    // "4 h ago" stays on one line.
    expect(line).toEndWith(" · 4\u00a0h\u00a0ago");
  });

  test("a long typed word wraps where it lands instead of widening the card, and never breaks a label", () => {
    const word = "W".repeat(30);
    const holders = new Set<string>();
    for (const sample of Object.values(EMAIL_SAMPLES)) {
      const { html } = renderEmail(poisoned(sample as EmailTemplate, word), art);
      for (const { index } of html.matchAll(new RegExp(word, "g"))) {
        const before = html.slice(0, index);
        const start = Math.max(before.lastIndexOf("<p "), before.lastIndexOf("<td "));
        const tag = html.slice(start, html.indexOf(">", start) + 1);
        expect(tag).toContain("word-break:break-word");
        holders.add(tag.slice(0, tag.indexOf(" style=")));
      }
      // With it, the table could squeeze a fact's label mid-word to make room for a long value.
      expect(html).not.toMatch(/<td class="mu[^>]*word-break/);
    }
    // Paragraphs, facts (first row and the rest), people's names and details, a note (a denial's reason), and the
    // footer.
    expect(holders.size).toBe(7);
  });

  test("an expired invitation link's request names nobody and still reads", () => {
    const { text } = renderEmail(EMAIL_SAMPLES["invite_request-link.en"] as EmailTemplate, art);
    expect(text).toContain("Someone with an expired invitation link to Souza Bakery asked for a new one.");
  });

  test("the join code: first in the subject, large in a well, alone on its line, and no button", () => {
    const sample = EMAIL_SAMPLES["join_code.en"] as Extract<EmailTemplate, { kind: "join_code" }>;
    for (const [locale, subject, body] of [
      ["en", "482913 is your agentes.chat code", "Type this code on the page to ask to join"],
      ["pt-BR", "482913 é seu código do agentes.chat", "Digite este código na página para pedir para entrar na"],
    ] as const) {
      const e = renderEmail({ ...sample, locale, orgName: "Acme evil.com" }, art);
      expect(e.subject).toBe(subject);
      expect(e.text).toContain(`\n\n${body} Acme evil.${BREAK}com.\n\n482913\n\n`);
      expect(e.html).toContain(
        'letter-spacing:8px;font-variant-numeric:tabular-nums;color:#151514;text-align:center">482913</td>',
      );
      expect(e.html).toContain('<table width="100%" class="well"');
      expect(e.html).not.toContain('class="btn"');
      expect(e.html).not.toContain("evil.com");
    }
  });

  test("without EMAIL_FROM, the sender is agentes.chat at this server's host", () => {
    expect(defaultEmailFrom("https://agentes.chat")).toBe("agentes.chat <ping@agentes.chat>");
    expect(defaultEmailFrom("https://chat.acme.com:8443/")).toBe("agentes.chat <ping@chat.acme.com>");
  });

  test("the footer says who sent it: agentes.chat, or a self-hosted server by its host", () => {
    expect(renderEmail(verify, emailArtAt("https://agentes.chat")).text).toContain("\nSent by agentes.chat.\n");
    expect(renderEmail(verify, emailArtAt("https://chat.acme.com/")).text).toContain(
      "\nSent by the agentes.chat server at chat.acme.com.\n",
    );
    expect(renderEmail({ ...verify, locale: "pt-BR" }, emailArtAt("https://chat.acme.com")).text).toContain(
      "Enviado pelo servidor do agentes.chat em chat.acme.com.",
    );
  });

  test("on a narrow screen the host moves to the next line whole, with the word before it, never split at a hyphen", () => {
    const box = emailArtAt("https://161-97-103-35.sslip.io");
    expect(renderEmail(verify, box).html).toContain(
      'Sent by the agentes.chat server <span style="display:inline-block">at 161-97-103-35.sslip.io.</span></p>',
    );
    expect(renderEmail({ ...verify, locale: "pt-BR" }, box).html).toContain(
      'Enviado pelo servidor do agentes.chat <span style="display:inline-block">em 161-97-103-35.sslip.io.</span></p>',
    );
    expect(renderEmail(verify, box).text).toContain("\nSent by the agentes.chat server at 161-97-103-35.sslip.io.\n");
    // Too long to share a 320 px line with the word before it, which would split it again or leave the word alone on
    // a line: it moves down alone.
    for (const host of ["ec2-203-0-113-25.compute-1.amazonaws.com", "agentes.consultoriaempresarialpaulista.com.br"]) {
      const far = emailArtAt(`https://${host}`);
      expect(renderEmail(verify, far).html).toContain(
        `Sent by the agentes.chat server at <span style="display:inline-block">${host}.</span></p>`,
      );
      expect(renderEmail({ ...verify, locale: "pt-BR" }, far).html).toContain(
        `Enviado pelo servidor do agentes.chat em <span style="display:inline-block">${host}.</span></p>`,
      );
      expect(renderEmail(verify, far).text).toContain(`\nSent by the agentes.chat server at ${host}.\n`);
    }
  });

  test("a closing line's last words move down together: no word alone on the last line, no e-mail split at its hyphen", () => {
    const code = EMAIL_SAMPLES["join_code.en"] as EmailTemplate;
    expect(renderEmail(code, art).html).toContain(
      'ask, <span style="display:inline-block">ignore this email.</span></p>',
    );
    expect(renderEmail({ ...code, locale: "pt-BR" }, art).html).toContain(
      'você, <span style="display:inline-block">ignore este e-mail.</span></p>',
    );
    expect(renderEmail(EMAIL_SAMPLES["join_request.pt-BR"] as EmailTemplate, art).html).toContain(
      'Todos os pedidos <span style="display:inline-block">em espera estão em Membros.</span></p>',
    );
    expect(renderEmail({ ...code, locale: "pt-BR" }, art).text).toContain(
      "\n\nVale por 10 minutos. Se não foi você, ignore este e-mail.\n\n",
    );
  });

  test("every text keeps its last two words together, in every email: none ends on a word alone", () => {
    const nobr = '<span style="display:inline-block">';
    const html = (id: string) => renderEmail(EMAIL_SAMPLES[id] as EmailTemplate, art).html;
    expect(html("verify_email.pt-BR")).toContain(`pode ignorar ${nobr}este e-mail.</span></p>`);
    expect(html("join_request.pt-BR")).toContain(`e pediu ${nobr}para entrar.</span></p>`);
    expect(html("join_code.en")).toContain(`Souza Bakery ${nobr}on agentes.chat.</span></p>`);
    // A name in bold moves down with its period, still bold.
    expect(html("join_code.en")).toContain(
      `to ask to join ${nobr}<b class="ink" style="font-weight:600;color:#151514">Souza Bakery</b>.</span></p>`,
    );
    expect(html("computer_ready-ai.pt-BR")).toContain(`dos seus agentes ${nobr}está pronto</span></h1>`);
    // Headlines and paragraphs of every kind, the fallback's words before its address (which breaks anywhere); the
    // plain text is as written.
    for (const id of Object.keys(EMAIL_SAMPLES)) {
      const texts = [...html(id).matchAll(/<(h1|p) class="(?:h1 ink|tx|mu|fa)"[^>]*>(.*?)<\/\1>/g)]
        .map(([, , inner = ""]) => inner.split("<br>")[0] ?? "")
        .filter((inner) => inner.replace(/<[^>]+>/g, "").split(" ").length > 2);
      expect(texts.length).toBeGreaterThan(2);
      const loose = texts.filter((inner) => {
        const tail = new RegExp(`${nobr}((?:(?!</?span)[^])*)</span>$`).exec(inner)?.[1];
        return !tail || tail.replace(/<[^>]+>/g, "").split(" ").length < 2;
      });
      expect({ id, loose }).toEqual({ id, loose: [] });
    }
    expect(renderEmail(EMAIL_SAMPLES["verify_email.pt-BR"] as EmailTemplate, art).text).toContain(
      "Se não foi você que se cadastrou, pode ignorar este e-mail.\n",
    );
  });

  test("the card's last block keeps only the room its ink needs: as much under the content as over the headline", () => {
    for (const [id, sample] of Object.entries(EMAIL_SAMPLES)) {
      const { html } = renderEmail(sample, art);
      const card = html.slice(
        html.indexOf('<td class="card"'),
        html.indexOf('\n</td></tr>\n<tr><td style="padding:24px 0 0">'),
      );
      const last = card.slice(card.lastIndexOf("\n") + 1);
      // 2 px under a line of text; 6 px under the button for its shadow, 4 in dark, where the shadow doesn't show.
      expect({ id, last }).toEqual({
        id,
        last: expect.stringMatching(
          /^<p class="mu" style="margin:0 0 2px;|^<table class="end-btn" [^>]*"margin:8px 0 6px">/,
        ),
      });
    }
    expect(renderEmail(verify, art).html).toContain(".end-btn{margin-bottom:4px!important}");
    // Between blocks the room stays as it was.
    expect(renderEmail(EMAIL_SAMPLES["join_request.en"] as EmailTemplate, art).html).toContain(
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px">',
    );
  });
});

describe("the computer ready email's button: its first step", () => {
  const base = EMAIL_SAMPLES["computer_ready-ai.en"] as Extract<EmailTemplate, { kind: "computer_ready" }>;
  const button = (needsAi: boolean, hasAgents: boolean, url = base.url) => {
    const [b] = buttons({ ...base, needsAi, hasAgents, url });
    return `${b?.label} ${b?.url}`;
  };

  test("connect the AI, give a first task, or create an agent first, from the workspace's URL of any job", () => {
    expect(button(true, true)).toBe(`Connect your AI ${base.url}?connect=ai`);
    expect(button(false, true)).toBe(`Give a first task ${base.url}`);
    expect(button(true, false)).toBe(`Create an agent ${base.url}/agents/new`);
    expect(button(false, false)).toBe(`Create an agent ${base.url}/agents/new`);
    expect(button(true, true, `${base.url}?connect=ai`)).toBe(`Connect your AI ${base.url}?connect=ai`);
    expect(button(true, true, `${base.url}/`)).toBe(`Connect your AI ${base.url}?connect=ai`);
  });

  test("the steps count only those shown, in both parts", () => {
    const steps = (t: Partial<typeof base>) => renderEmail({ ...base, ...t }, art).text;
    expect(steps({})).toContain(
      "Next steps\n\n1. Connect your AI. Sign in with your Claude or ChatGPT plan, another AI's coding plan, or an API key. Your agents think with it.\n2. Give a first task.",
    );
    expect(steps({ needsAi: false })).toContain("Next steps\n\n1. Give a first task.");
    expect(steps({ needsAi: false })).toContain("\n2. Watch them work.");
    expect(steps({ hasAgents: false })).toContain(
      "\n1. Create an agent. It works on this computer from the start.\n2. Connect your AI.",
    );
    expect(steps({ hasAgents: false, needsAi: false })).not.toContain("Connect your AI");
    expect(steps({ locale: "pt-BR", specs: { cpus: 1, memoryGb: 7.8, diskGb: 100 } })).toContain(
      "CPUs: 1\nMemória: 7,8 GB\nDisco: 100 GB",
    );
    const html = renderEmail(base, art).html;
    expect(html.match(/<td class="num"/g)).toHaveLength(3);
    expect(html).toContain('<h2 class="ink"');
  });
});

describe("the picture over the headline", () => {
  const ready = EMAIL_SAMPLES["computer_ready-ai.en"] as Extract<EmailTemplate, { kind: "computer_ready" }>;
  // The onboarding's own (`PRESET_LOOK` in the web and phone apps).
  const theo = { color: "indigo", eyes: "round", accessory: "cap" };
  const ada = { color: "green", eyes: "wide", accessory: "headphones" };
  const lia = { color: "rose", eyes: "dots", accessory: "flower" };
  const atlas = { color: "amber", eyes: "round", accessory: "antenna" };
  const ONBOARDING = [
    "agent-indigo-round-cap.png 36×46",
    "agent-green-wide-headphones.png 36×46",
    "agent-rose-dots-flower.png 36×46",
    "agent-amber-round-antenna.png 36×46",
  ];
  const plain = (...colors: string[]) => colors.map((color) => ({ color, eyes: "round", accessory: "none" }));
  /** The pictures between the card's top and the headline, in order: file, size and alt text. */
  const scene = (t: EmailTemplate) => {
    const { html } = renderEmail(t, art);
    const top = html.slice(html.indexOf('<td class="card"'), html.indexOf("<h1 "));
    return [
      ...top.matchAll(/<img src="https:\/\/x\.test\/email\/([^"]+)" width="(\d+)" height="(\d+)" alt="([^"]*)"/g),
    ].map(([, file, width, height, alt = ""]) => `${file} ${width}×${height} ${alt.replaceAll("&#39;", "'")}`.trim());
  };
  const faces = (...colors: string[]) => colors.map((c) => `agent-${c}.png 32×32`);
  const shown = (crew: typeof ready.crew) => scene({ ...ready, crew }).filter((p) => p.startsWith("agent-"));

  test("the computer ready email: its computer in a well, the workspace's agents half on each side, oldest first", () => {
    const [teal, sky, computer, violet] = scene({ ...ready, crew: plain("teal", "sky", "violet") });
    expect([teal, sky, violet]).toEqual(faces("teal", "sky", "violet"));
    expect(computer).toBe("computer.png 62×84 Your agents' computer");
    expect(scene({ ...ready, locale: "pt-BR" })).toContain("computer.png 62×84 O computador dos seus agentes");
    const { html } = renderEmail({ ...ready, crew: plain("teal") }, art);
    expect(html).toContain('<td width="50%" align="right" valign="bottom"><table');
    expect(html).toContain('<td width="50%" align="left" valign="bottom"></td>');
    expect(html.indexOf('class="well"')).toBeLessThan(html.indexOf("<h1 "));
  });

  test("at most four agents; none, or a job queued before pictures: the onboarding's own; an unknown colour is sky", () => {
    expect(shown(plain("sky", "teal", "rose", "green", "amber", "violet"))).toEqual(
      faces("sky", "teal", "rose", "green"),
    );
    expect(shown([])).toEqual(ONBOARDING);
    expect(shown(undefined)).toEqual(ONBOARDING);
    expect(shown([{ color: "mauve" }, {}])).toEqual(faces("sky", "sky"));
    expect(shown([{ color: "#e0457b" }, { color: "#808080" }])).toEqual(faces("rose", "graphite"));
  });

  test("an onboarding agent's look is drawn whole, eyes and accessory; any other look is its colour's face", () => {
    expect(shown([theo, ada, lia, atlas])).toEqual(ONBOARDING);
    // Eyes left out are round, as the app draws them.
    expect(shown([{ color: "indigo", accessory: "cap" }, { ...ada, eyes: "round" }, ...plain("rose")])).toEqual([
      "agent-indigo-round-cap.png 36×46",
      ...faces("green", "rose"),
    ]);
    // A whole look's room for its accessory comes out of the gap after it: the bodies keep their spacing.
    const stage = renderEmail({ ...ready, crew: [theo, ...plain("indigo")] }, art).html;
    expect(stage).toContain(
      '<td valign="bottom" style="padding:0 0px 2px 4px"><img src="https://x.test/email/agent-indigo-round-cap.png" width="36" height="46"',
    );
    expect(stage).toContain(
      '<td valign="bottom" style="padding:0 4px 2px 4px"><img src="https://x.test/email/agent-indigo.png" width="32" height="32"',
    );
    const invitation = EMAIL_SAMPLES["invitation.en"] as Extract<EmailTemplate, { kind: "invitation" }>;
    const row = renderEmail({ ...invitation, crew: [lia] }, art).html;
    expect(row).toContain(
      '<td valign="bottom" style="padding:0 4px 0px 0px"><img src="https://x.test/email/agent-rose-dots-flower.png"',
    );
  });

  test("the welcome emails show the workspace's agents in a row, with no computer; the others show none", () => {
    const withCrew: Record<string, string[]> = {
      "invitation.en": faces("sky", "violet", "teal"),
      "invitation.pt-BR": ONBOARDING,
      "early_access.en": ONBOARDING,
      "early_access_allowed.en": ONBOARDING,
      "join_answer-joined.en": [...faces("graphite"), "agent-rose-dots-flower.png 36×46"],
      "join_answer-invited.en": ONBOARDING,
      "plan_waiting.pt-BR": ONBOARDING,
    };
    for (const [id, sample] of Object.entries(EMAIL_SAMPLES)) {
      const expected = id.startsWith("computer_ready")
        ? expect.arrayContaining([expect.stringMatching(/^computer\.png/)])
        : (withCrew[id] ?? (id.startsWith("early_access") ? ONBOARDING : []));
      expect({ id, pictures: scene(sample) }).toEqual({ id, pictures: expected });
    }
    // A row on the card itself; only the computer stands in a well.
    const top = (id: string) => {
      const { html } = renderEmail(EMAIL_SAMPLES[id] as EmailTemplate, art);
      return html.slice(html.indexOf('<td class="card"'), html.indexOf("<h1 "));
    };
    expect(top("invitation.en")).not.toContain('class="well"');
    expect(top("computer_ready-ai.en")).toContain('class="well"');
  });

  test("the plain-text part is the same words, with no picture in it", () => {
    const { text } = renderEmail(ready, art);
    expect(text.startsWith("Your agents' computer is ready\n\n")).toBe(true);
    expect(text).not.toContain(".png");
  });

  test("a picture's agents are the workspace's oldest four, each with its look, the archived left out", async () => {
    f = await setup();
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));
    // The fixture's agent has no look: its face is sky.
    await f.db
      .update(schema.agents)
      .set({ createdAt: at(5) })
      .where(eq(schema.agents.id, f.agent.id));
    const agent = (name: string, minute: number, appearance: typeof theo, archived = false) => ({
      orgId: f.org.id,
      name,
      handle: name.toLowerCase(),
      model: "claude-sonnet-5-5",
      appearance,
      createdAt: at(minute),
      archivedAt: archived ? at(30) : null,
    });
    await f.db
      .insert(schema.agents)
      .values([
        agent("Lia", 3, lia),
        agent("Theo", 1, theo),
        agent("Gone", 0, atlas, true),
        agent("Ada", 2, ada),
        agent("Atlas", 9, atlas),
      ]);
    expect(await emailCrew(f.db, f.org.id)).toEqual([theo, ada, lia, {}]);
  });
});

describe("where the pictures come from", () => {
  test("every picture an email names is listed, and the web app has each one", () => {
    expect(EMAIL_PICTURES).toContain("computer.png");
    for (const file of EMAIL_PICTURES)
      expect({ file, there: existsSync(join(WEB_DIR, "email", file)) }).toEqual({ file, there: true });
    for (const sample of Object.values(EMAIL_SAMPLES))
      for (const [, file = ""] of renderEmail(sample, art).html.matchAll(/src="https:\/\/x\.test\/email\/([^"]+)"/g))
        expect(EMAIL_PICTURES).toContain(file);
  });

  test("attached: the computer ready email carries its computer and each face it shows once", async () => {
    const attached = await emailArtFor("http://localhost:3000", WEB_DIR, "auto");
    const ready = EMAIL_SAMPLES["computer_ready-ai.en"] as Extract<EmailTemplate, { kind: "computer_ready" }>;
    const lia = { color: "rose", eyes: "dots", accessory: "flower" };
    const teal = { color: "teal", eyes: "round", accessory: "none" };
    const { html, inline } = renderEmail({ ...ready, crew: [lia, lia, teal, { color: "rose" }] }, attached);
    expect(html).toContain('src="cid:computer@agentes.chat"');
    expect(html).toContain('src="cid:agent-rose-dots-flower@agentes.chat"');
    expect(inline.map((p) => p.filename)).toEqual([
      "logo-ink-tile.png",
      "logo-bone.png",
      "computer.png",
      "sky-band.png",
      "agent-rose.png",
      "agent-teal.png",
      "agent-rose-dots-flower.png",
    ]);
  });

  test("linked from this server's /email/, with the web font", () => {
    const { html, inline } = renderEmail(EMAIL_SAMPLES["verify_email.en"] as EmailTemplate, art);
    expect(html).toContain('src="https://x.test/email/logo-ink-tile.png"');
    expect(html).toContain("src:url('https://x.test/email/source-sans-3-latin.woff2')");
    expect(html).toContain('<a href="https://x.test" target="_blank"');
    expect(inline).toEqual([]);
  });

  test("every email loads the app's face from this server alone, in a rule classic Outlook never reads", async () => {
    const attached = await emailArtFor("http://localhost:3000", WEB_DIR, "auto");
    // With the pictures attached nothing is fetched, the face included: no reader could reach that address.
    for (const [from, a] of [
      ["https://x.test", art],
      [null, attached],
    ] as const) {
      const { html } = renderEmail(EMAIL_SAMPLES["verify_email.en"] as EmailTemplate, a);
      const faces = [...html.matchAll(/@font-face\{[^}]*\}/g)].map((m) => m[0]);
      expect(faces).toEqual(
        from
          ? [
              `@font-face{font-family:'Source Sans 3';font-style:normal;font-weight:200 900;font-display:swap;size-adjust:107%;src:url('${from}/email/source-sans-3-latin.woff2') format('woff2')}`,
            ]
          : [],
      );
      // Every URL a mail app may fetch is this server's: no font host, no other company.
      const fetched = [...html.matchAll(/(?:src="|url\(')(https?:\/\/[^"')]+)/g)].map(
        (m) => new URL(m[1] ?? "").origin,
      );
      expect(new Set(fetched)).toEqual(new Set(from ? [from] : []));
      // Its own style block, inside the comment classic Outlook skips. The face is the stack's first font, and
      // classic Outlook is told its own.
      if (from) expect(html).toContain(`<!--[if !mso]><!--><style>${faces[0]}</style><!--<![endif]-->`);
      expect(html).toContain(
        "font-family:'Source Sans 3',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Hiragino Sans','PingFang SC','Microsoft YaHei','Apple SD Gothic Neo','Malgun Gothic',sans-serif",
      );
      expect(html).toContain("<!--[if mso]>");
      expect(html).toMatch(/<!--\[if mso\]>.*font-family:'Segoe UI',Arial,sans-serif!important.*<!\[endif\]-->/);
    }
  });

  test("attached: each message carries only the pictures its HTML names", async () => {
    const attached = await emailArtFor("http://localhost:3000", WEB_DIR, "auto");
    expect(attached.base).toBeNull();
    const { html, inline } = renderEmail(
      {
        kind: "approval_digest",
        locale: "en",
        orgName: "Acme",
        items: [{ agentName: "Lia", agentColor: "rose", title: "Deploy", ageHours: 5 }],
        url: "http://localhost:3000/org/o/approvals?open=a",
      },
      attached,
    );
    expect(html).toContain('src="cid:logo-ink-tile@agentes.chat"');
    expect(inline.map((p) => p.filename)).toEqual([
      "logo-ink-tile.png",
      "logo-bone.png",
      "sky-band.png",
      "agent-rose.png",
    ]);
    expect(inline[0]).toMatchObject({ cid: "logo-ink-tile@agentes.chat", contentType: "image/png" });
    expect([...(inline[0]?.content ?? []).slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  });

  test("EMAIL_ART=attach on a public host; auto attaches for a private, CGNAT or privately resolving one", async () => {
    const publicDns = async () => ["93.184.216.34"];
    const at = (url: string, mode: "auto" | "attach", resolveTo = publicDns) =>
      emailArtFor(url, WEB_DIR, mode, resolveTo).then((a) => a.base);
    expect(await at("https://chat.acme.com", "auto")).toBe("https://chat.acme.com/email/");
    expect(await at("https://chat.acme.com", "attach")).toBeNull();
    expect(await at("http://localhost:3000", "auto")).toBeNull();
    expect(await at("https://100.101.102.103", "auto")).toBeNull();
    expect(await at("https://agentes.tail1234.ts.net", "auto", async () => ["100.64.1.2"])).toBeNull();
    expect(await at("https://chat.acme.internal", "auto")).toBeNull();
    expect(await at("https://10-0-0-5.sslip.io", "auto", async () => ["10.0.0.5"])).toBeNull();
    // A server without the web app's pictures keeps them linked.
    expect((await emailArtFor("http://localhost:3000", "/nonexistent", "auto")).base).toBe(
      "http://localhost:3000/email/",
    );
  });

  test("says why they're attached: asked, a private host, or a host that didn't resolve", async () => {
    const why = (url: string, mode: "auto" | "attach", resolveTo: () => Promise<string[]>) =>
      emailArtFor(url, WEB_DIR, mode, resolveTo).then((a) => a.attached);
    const publicDns = async () => ["93.184.216.34"];
    expect(await why("https://chat.acme.com", "auto", publicDns)).toBeUndefined();
    expect(await why("https://chat.acme.com", "attach", publicDns)).toBe("attach");
    expect(await why("http://localhost:3000", "auto", publicDns)).toBe("blocked");
    expect(await why("https://chat.acme.com", "auto", () => Promise.reject(new Error("ENOTFOUND")))).toBe(
      "unreachable",
    );
  });
});

describe("jobs queued before this look", () => {
  test("old payloads, with no language or new fields, still render (in English, every language's fallback)", () => {
    const e = renderEmail({ kind: "verify_email", url: "u" });
    expect(e.subject).toBe("Confirm your email for agentes.chat");
    expect(e.html).toContain('<html lang="en"');
    const old: EmailTemplate[] = [
      { kind: "invitation", orgName: "Acme", inviterName: "", url: "https://x/invite/t", role: "member" },
      { kind: "budget", level: "warning", agentName: "Ada", orgName: "Acme", percent: 80.4, url: "u" },
      {
        kind: "approval_digest",
        orgName: "Acme",
        items: [
          { agentName: "Ada", title: "Merge PR #42", ageHours: 5 },
          { agentName: "", title: "Deploy", ageHours: 0.2 },
        ],
        url: "u",
      },
      { kind: "invite_request", orgName: "Acme", email: "", url: "u" },
    ];
    for (const t of old) {
      const r = renderEmail(t, art);
      expect(`${r.subject}${r.html}${r.text}`).not.toMatch(/undefined|null|\{\w+\}/);
    }
    const [invitation, budget, digest] = old.map((t) => renderEmail(t, art).text);
    expect(invitation).toContain("You're invited to join Acme as a member.");
    // A percentage only: owners who aren't admins never see money.
    expect(budget).toContain("Used 80% of this month's budget · Acme");
    expect(budget).not.toContain("$");
    expect(digest).toContain(`Ada · Merge PR #42 · 5\u00a0h\u00a0ago`);
    expect(digest).toContain(`An agent · Deploy · 1\u00a0h\u00a0ago`);
    // No `afterHours`: the footer stops after its first sentence.
    expect(digest).toContain("You got this email because you can approve these requests in Acme.\n");
  });
});

describe("outbox delivery", () => {
  test("queued once per key, sent by the job with the key as idempotency key; permanent errors don't retry", async () => {
    f = await setup();
    const sender = createFakeEmailSender();
    const handlers = createJobHandlers({ ...f.jobDeps, email: sender });
    const input = {
      orgId: f.org.id,
      key: "k1",
      to: ["a@example.com"],
      template: { kind: "verify_email" as const, url: "u" },
    };
    await queueEmail(f.db, input);
    await queueEmail(f.db, input);
    await queueEmail(f.db, { ...input, orgId: null, key: "k2" });
    await drainOutbox(f.db, handlers);
    expect(sender.sent.map((m) => m.idempotencyKey).sort()).toEqual(["k1", "k2"]);
    const failing = { id: "x", delivers: true, send: async () => Promise.reject(new EmailError("bad", false, 422)) };
    await expect(sendQueuedEmail(failing, { key: "k", to: ["a@b.c"], template: input.template })).rejects.toThrow(
      "bad",
    );
  });

  test("attached pictures go with the message as inline parts", async () => {
    const sender = createFakeEmailSender();
    const attached: EmailArt = await emailArtFor("http://localhost:3000", WEB_DIR, "attach");
    await sendQueuedEmail(sender, { key: "k", to: ["a@b.c"], template: EMAIL_SAMPLES["verify_email.en"] }, attached);
    expect(sender.sent[0]?.inline?.map((p) => p.cid)).toEqual([
      "logo-ink-tile@agentes.chat",
      "logo-bone@agentes.chat",
      "sky-band@agentes.chat",
    ]);
    await sendQueuedEmail(sender, { key: "k2", to: ["a@b.c"], template: EMAIL_SAMPLES["verify_email.en"] }, art);
    expect(sender.sent[1]).not.toHaveProperty("inline");
  });

  test("budget email once per agent, month and level, with the agent's face and its budget's address", async () => {
    f = await setup();
    await f.db
      .update(schema.agents)
      .set({ appearance: { color: "rose", eyes: "round", accessory: "none" } })
      .where(eq(schema.agents.id, f.agent.id));
    const e = { agent: { ...f.agent }, level: "warning" as const, spentNanoUsd: 8e9, budgetNanoUsd: 10e9 };
    await queueBudgetEmail(f.db, "https://chat.example.com", e);
    await queueBudgetEmail(f.db, "https://chat.example.com", e);
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      template: {
        kind: "budget",
        agentColor: "rose",
        url: `https://chat.example.com/org/${f.org.id}/agents/${f.agent.id}?tab=settings&sec=budget`,
      },
    });
  });

  test("approval digest: one email per person told for requests waiting too long, never twice, opening a lone request", async () => {
    const gh = fakeGithub();
    f = await setup({
      toolSources: [gh.source],
      reply: () => ({
        chunks: [],
        toolUses: [
          {
            name: "github_merge_pr",
            input: { repo: "a/b", pr: 1, why: "CI passed and the review is done: merging ships the fix today." },
          },
        ],
      }),
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    await addMember(f.db, f.org.id, "admin", "bia");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev merge" });
    await drainOutbox(f.db, f.handlers);
    const later = new Date(Date.now() + 5 * 3600_000);
    expect(await queueApprovalDigests(f.db, "https://x", 4)).toBe(0);
    // The agent's responsável (the owner), not every admin (`notifiedIds`).
    expect(await queueApprovalDigests(f.db, "https://x", 4, later)).toBe(1);
    expect(await queueApprovalDigests(f.db, "https://x", 4, later)).toBe(0);
    const [approval] = await f.db.select().from(schema.approvals);
    const digests = (await f.db.select().from(schema.outbox)).filter(
      (j) => j.kind === "email.send" && JSON.stringify(j.payload).includes("approval_digest"),
    );
    expect(digests).toHaveLength(1);
    for (const d of digests) {
      expect(d.payload).toMatchObject({
        template: { url: `https://x/org/${f.org.id}/approvals?open=${approval?.id}`, afterHours: 4 },
      });
    }
  });

  test("invitation: the inviter's address goes in the body, so the invitee can judge who sent it", async () => {
    f = await setup();
    // The fixture's addresses end in a random hex suffix, which typed-text masking hides whenever it has 7 digits in a row.
    const inviterEmail = "ana.lima@example.com";
    await f.db.update(schema.users).set({ email: inviterEmail }).where(eq(schema.users.id, f.owner.id));
    await queueInvitationEmail(f.db, {
      orgId: f.org.id,
      // An id, as the function reads the invitation's note and expiry (none here: no note, keyed by the link).
      invitationId: crypto.randomUUID(),
      email: "new@example.com",
      role: "member",
      url: "https://x/invite/abcdefghijklmnop",
      inviterId: f.owner.id,
      secret: "test-secret",
    });
    const [job] = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    // The workspace's agents for its picture: the fixture's one, with no look (its face is sky).
    expect(job?.payload).toMatchObject({ template: { kind: "invitation", inviterEmail, crew: [{}] } });
    const payload = job?.payload as { template: EmailTemplate } | undefined;
    const text = payload ? renderEmail(payload.template, art).text : "";
    expect(text).toContain(`(${inviterEmail.replace(/([.@])/g, `$1${BREAK}`)}) convidou você para entrar na`);
  });
});
