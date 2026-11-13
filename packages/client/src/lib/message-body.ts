import type { TFunction } from "i18next";
import { toolActivity } from "./activity";
import { previewOf } from "./consultations";
import { joinNames, lowerFirst } from "./format";
import { autoUpdateText, talkerStatusText, workEndBody } from "./long-work";
import { mediaKindOf, mediaWord } from "./media";
import { RIGHT_HAND_PLAN_LINES } from "./no-ai";
import { githubLineKey } from "./notices";
import { brainName } from "./outages";
import { usageWhen } from "./plan-usage";
import { weekDay } from "./team-week";
import { closedNoteText, usageWaitOf, usageWindowText } from "./usage-pause";
import { isVoiceMeta, voiceLength, voiceWord } from "./voice";
import { stepLabel } from "./work";

/** Notes of an agent waiting on its plan's limit or its budget (`meta.usageWait`): `{{when}}` from its reset. */
const USAGE_NOTES = new Set([
  "plan_limit_cut",
  "plan_limit_cut_unknown",
  "plan_limit_wait",
  "plan_limit_wait_unknown",
  "plan_model_limit_wait",
  "plan_model_limit_wait_unknown",
  "plan_model_region_wait",
  "plan_model_off_wait",
  "plan_inactive_wait",
  "budget_wait",
  // A skipped ask's note where its run had none of its own to say it on: always `usageWait.closed`.
  "catch_up_closed",
]);

type Meta = Record<string, unknown> | undefined;

/**
 * A computer brain's wait (`meta.brainUnavailable.code`) that isn't its computer gone or busy, by the words that say
 * it: paused by whoever connected it, its CLI or commands off there, a program to update, a plan not the owner's.
 */
const WAIT_CAUSES: Record<string, string> = {
  machine_paused: "paused",
  exec_disabled: "commands_off",
  tool_off: "commands_off",
  runner_outdated: "outdated",
  codex_too_old: "outdated",
  plan_not_owner: "plan_owner",
};
const waitCauseOf = (code: unknown) =>
  typeof code === "string" && Object.hasOwn(WAIT_CAUSES, code) ? WAIT_CAUSES[code] : null;

/**
 * The text of an agent message the server wrote itself (approval and secret
 * cards, "Done.", "File saved.", memory lines, a run cut by a deploy), in the
 * person's language: `meta.bodyCode` + `meta.bodyParams` → `chat.body.*`, and
 * `meta.interrupted` / `meta.brainInterrupted` → what the agent wrote plus the notice. Anything else (the
 * model's own text) is shown as is; the server's English body is the fallback. A body that says where something ran
 * (a task's end, a mission's plan: `bodyParams.computer`) names the computer only with `namesComputer`
 * (`namesComputers`), else it reads in its code's `…NoComputer` words. `locale` formats a usage wait's reset time.
 */
export function serverBody(t: TFunction, body: string, meta: Meta, locale?: string, namesComputer = false): string {
  const m = meta ?? {};
  const interrupted = m.interrupted as { text?: unknown } | undefined;
  if (interrupted && typeof interrupted === "object" && typeof interrupted.text === "string") {
    const note = `_${t("chat.body.interrupted", { defaultValue: "Interrupted by a server restart. Ask again to continue." })}_`;
    return interrupted.text ? `${interrupted.text}\n\n${note}` : note;
  }
  // A computer brain stopped mid-turn after its tools ran: what it wrote, then what its tools did, in words.
  const cut = m.brainInterrupted as { brain?: unknown; text?: unknown; tools?: unknown } | undefined;
  if (cut && typeof cut === "object" && typeof cut.text === "string") {
    const brain = brainName(typeof cut.brain === "string" ? cut.brain : null);
    const names = Array.isArray(cut.tools) ? cut.tools.filter((x): x is string => typeof x === "string") : [];
    const done = names.map((tool) => lowerFirst(stepLabel(t, { ...toolActivity(tool), tool }), locale));
    const tools = joinNames([...new Set(done)], t);
    const note = `_${t("chat.body.brain_interrupted", {
      brain,
      tools,
      defaultValue: `${brain} stopped before finishing. Already done, not repeated: ${tools}.`,
    })}_`;
    return cut.text ? `${cut.text}\n\n${note}` : note;
  }
  const code = typeof m.bodyCode === "string" ? m.bodyCode : null;
  if (!code) return body;
  if (code === "memory") {
    const updates = Array.isArray(m.memoryUpdates) ? (m.memoryUpdates as { action?: unknown; text?: unknown }[]) : [];
    const lines = updates.flatMap((u) =>
      u && typeof u.action === "string" && typeof u.text === "string"
        ? [t(`chat.body.memory.${u.action}`, { text: u.text, defaultValue: "" })]
        : [],
    );
    return lines.some(Boolean) ? lines.filter(Boolean).join("\n") : body;
  }
  const params =
    m.bodyParams && typeof m.bodyParams === "object" ? (m.bodyParams as Record<string, unknown>) : ({} as const);
  // Waiting for room on a busy computer, not for one that went away; no AI because its sign-in ended, or because the
  // computer's own sign-in of that CLI isn't there (`own`), not none at all.
  const waitNote =
    code === "brain_unavailable" ? (m.brainUnavailable as { code?: unknown; long?: unknown } | undefined) : undefined;
  const busy = waitNote?.code === "busy";
  const noAi =
    code === "no_ai"
      ? (m.noAi as { reason?: unknown; own?: unknown; model?: unknown; why?: unknown } | undefined)
      : undefined;
  const signedOut = noAi?.reason === "not_signed_in";
  // The team's right hand on a plan (ADR 0137 §7): why its plan can't think now (`RIGHT_HAND_PLAN_LINES`); any agent's
  // computer with no such CLI, or no computer at all.
  const planLine =
    typeof noAi?.reason === "string" &&
    (RIGHT_HAND_PLAN_LINES.has(noAi.reason) ||
      noAi.reason === "cli_missing" ||
      noAi.reason === "no_computer" ||
      noAi.reason === "plan_hold")
      ? `no_ai_${noAi.reason}`
      : null;
  // The plan's CLI failed: the line says what it said.
  const cliSaid = noAi?.reason === "cli_failed" && typeof noAi.why === "string" && noAi.why ? noAi.why : null;
  const own =
    signedOut &&
    (noAi?.own === "codex" ||
      noAi?.own === "claude_code" ||
      noAi?.own === "cursor" ||
      noAi?.own === "opencode" ||
      noAi?.own === "grok" ||
      noAi?.own === "antigravity")
      ? noAi.own
      : null;
  if (own) {
    const brain = brainName(own);
    return t("chat.body.no_ai_not_signed_in", { brain, defaultValue: body });
  }
  if (USAGE_NOTES.has(code)) {
    // Skipped as already handled (ADR 0136): why, in place of the promise, and who asked for an answer anyway.
    const skipped = usageWaitOf(m)?.closed;
    if (skipped) {
      const line = closedNoteText(t, skipped);
      const by = (m.usageWait as { continuedByName?: unknown }).continuedByName;
      return typeof by === "string" && by
        ? `${line}\n\n_${t("chat.body.usage_wait_anyway", { name: by, defaultValue: "" })}_`
        : line;
    }
    const resetsAt = (m.usageWait as { resetsAt?: unknown } | undefined)?.resetsAt;
    const when = typeof resetsAt === "string" ? usageWhen(t, locale, resetsAt) : "";
    const text = t(`chat.body.${code}`, { ...params, when, defaultValue: body });
    // Someone said not to run it, or its agent was archived: the promise above no longer holds.
    const wait = m.usageWait as { canceled?: unknown; reason?: unknown } | undefined;
    if (wait?.canceled !== true) return text;
    const why =
      wait.reason === "archived"
        ? t("chat.body.usage_wait_archived", { defaultValue: "It won't run: the agent was archived." })
        : t("chat.body.usage_wait_canceled", { defaultValue: "Canceled. It won't run when the limit is back." });
    return `${text}\n\n_${why}_`;
  }
  // Long work paused near a limit (ADR 0118): its window in the reader's words.
  if (code === "usage_paused" || code === "usage_paused_budget") {
    const window = typeof params.window === "string" && params.window ? usageWindowText(t, params.window) : "";
    return t(`chat.body.${code}`, { ...params, window, defaultValue: body });
  }
  // Lodi's weekly card (ADR 0137 §9): its week in the reader's words; a list without the locale keeps the body, which
  // the server wrote in the person's language.
  if (code === "team_week")
    return locale && typeof params.from === "string" && typeof params.to === "string"
      ? params.period === "day"
        ? t("chat.body.team_day", { day: weekDay(locale, params.to), defaultValue: body })
        : t("chat.body.team_week", {
            from: weekDay(locale, params.from),
            to: weekDay(locale, params.to),
            defaultValue: body,
          })
      : body;
  // Long work's own update of a silent work (ADR 0121): what it does now, in the reader's words.
  if (code === "work_auto_update") return autoUpdateText(t, params);
  // The autonomy brakes (ADR 0131): a working agent's status line, a proposal of costly work, the noise digest.
  if (code === "talker_status") return talkerStatusText(t, params, locale);
  if (code === "autonomy_proposal")
    return t(
      `chat.body.autonomy_proposal.${params.cost === "install" || params.cost === "long" ? params.cost : "pr"}`,
      {
        defaultValue: body,
      },
    );
  if (code === "autonomy_digest")
    return `${t("chat.body.autonomy_digest", { count: Number(params.count) || 0, defaultValue: body })}\n${typeof params.lines === "string" ? params.lines : ""}`;
  // A work that didn't finish or was stopped: why or by whom, and its last update.
  if (code === "work_end_failed" || code === "work_end_canceled") return workEndBody(t, code, params, m.workEnd, body);
  // An older note about a plan's limit (sent as the computer brain being unavailable): the plan's words.
  if (code === "brain_unavailable" && waitNote?.code === "plan_limit") {
    const plan = params.brain === "Codex" ? "ChatGPT" : "Claude";
    return t("chat.body.plan_limit_wait_unknown", { plan, defaultValue: body });
  }
  // Waiting on something that doesn't pass by itself: its cause and who fixes it, not "until it's back".
  const waitCause = code === "brain_unavailable" ? waitCauseOf(waitNote?.code) : null;
  if (waitCause) return t(`chat.body.brain_unavailable_${waitCause}`, { ...params, defaultValue: body });
  // A secret request posted before the body named its agent.
  const anon = code === "secret_request" && typeof params.agent !== "string";
  // Still in line after a long while (the only busy note posted now); older notes keep their words.
  const shown = busy
    ? waitNote?.long
      ? "brain_queued"
      : "brain_busy"
    : signedOut
      ? "no_ai_signed_out"
      : planLine
        ? `${planLine}${cliSaid ? "Why" : ""}`
        : anon
          ? "secret_requestAnon"
          : code;
  const key = `chat.body.${shown}`;
  const model = typeof noAi?.model === "string" ? { model: noAi.model } : {};
  // i18next takes the first key that exists: a body with no `…NoComputer` words keeps its own.
  return t(params.computer && !namesComputer ? [`${key}NoComputer`, key] : key, {
    ...params,
    ...model,
    ...(cliSaid ? { why: cliSaid } : {}),
    defaultValue: body,
  });
}

/**
 * A conversation list's last-message line: a body the server wrote (`meta` from the list, same keys as
 * the message's) in the reader's language, as the chat shows it, on one plain line, never naming a computer; a GIF
 * or a sticker with no text as its word (ADR 0091: the list's `mediaKind`, or a kind its meta carries).
 */
export function previewBody(t: TFunction, text: string, meta: Meta | null, mediaKind?: unknown): string {
  // Never a voice message's words, even from a server that sent them (ADR 0100).
  if (isVoiceMeta(meta) || mediaKindOf(mediaKind) === "voice") return voiceWord(t, voiceLength(meta));
  // What happened on GitHub, as the chat's line says it: someone's words alone, under the agent's name, would read as
  // the agent's.
  if (meta?.bodyCode === "github_event") {
    const p = (meta.bodyParams ?? {}) as Record<string, string>;
    const line = t(p.answerFor ? "chat.notice.github.asked" : githubLineKey(p), { ...p, name: p.agent ?? "" });
    return previewOf(p.said ? `${line}: ${p.said}` : line);
  }
  if (!text.trim()) {
    const kind = mediaKindOf(mediaKind) ?? mediaKindOf(meta?.mediaKind) ?? mediaKindOf(meta?.media);
    if (kind) return mediaWord(t, kind);
  }
  return previewOf(meta ? serverBody(t, text, meta) : text);
}

/** A message notification's snippet: a body the server wrote in the reader's language, else its text as it came. */
export const latestText = (t: TFunction, l: { text?: string; meta?: Meta | null }) =>
  l.text && l.meta ? previewBody(t, l.text, l.meta) : l.text;
