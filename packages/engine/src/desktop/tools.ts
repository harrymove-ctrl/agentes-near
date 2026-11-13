import {
  type AgentScope,
  DESKTOP_AGENT_BROWSER,
  DESKTOP_LIMITS,
  type DesktopAction,
  type DesktopLookReply,
  type PubSub,
} from "@agenteschat/adapters";
import { getAgentCached } from "../agents";
import { recordAudit } from "../audit";
import { handedBackSince, markPageRead, requirePageRead, waitIfPersonInControl } from "../browser/handoff";
import { agentFolderPath, MAX_PAGE_TEXT, MAX_PLAN_STEPS } from "../browser/tools";
import { DESKTOP_SCOPE, DESKTOP_TOOL_INFO } from "../browser/types";
import type { Judge } from "../judge";
import { callWhenBack, type MachineCaller, MachineRequestError } from "../machine-hub";
import { MachineOfflineError, MachinePausedError } from "../machines";
import { getSandboxSettings, SANDBOX_SCOPE } from "../sandbox";
import {
  actsBeforeOpening,
  createLookMemory,
  createTargetCache,
  FRESH_LOOK_MS,
  findInPage,
  formatPlanReport,
  KNOWN_LOOK_MS,
  MAX_WAIT_MS,
  type PlanReport,
  runPlan,
  type ScreenStep,
  type ScreenVerb,
  screenStepOf,
  type TargetCache,
} from "../screen";
import type { JsonSchema } from "../tools/json-schema";
import { accessWithNeeds, grantedScopeKeys, isAllowed, toolAccess } from "../tools/scopes";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import { untrustedBlock } from "../untrusted";
import { SHARE_HINT, SHARE_INPUT, shareSavedFile } from "../uploads";
import { agentDesktopUseStatus, desktopUseUnavailableText } from "./status";
import { BROWSER_HINT, type DesktopLink, desktopSurface, observationOf } from "./surface";

export {
  type AgentDesktopUseStatus,
  agentDesktopUseStatus,
  type DesktopUseUnavailable,
  desktopUseUnavailableText,
} from "./status";

export interface DesktopToolDeps {
  /** Connected machines (ADR 0025); without them the source offers nothing. */
  machines?: { hub: MachineCaller };
  /** A take over moving to the run that waits on it is told to its conversation (the card follows). */
  pubsub?: PubSub;
  /** Targets in words, checks and finds on the screen (ADR 0054), as for the browser. */
  judge?: Judge;
  /**
   * Whether the judge sees images now (Jev's vision model): a target the screen's text lacks is looked for on a
   * screenshot. Asked on each call, since the installation's Jev key can come and go.
   */
  vision?: () => boolean;
  /** Tests: the memory of targets per app (default: one per source, in memory). */
  targets?: TargetCache;
  now?: () => number;
  /** Our public base URL: a shared screenshot goes to its upload URL there, as `upload_file`'s files do. */
  publicUrl?: string;
}

/** Driving a desktop runs commands (a terminal window, "Open Terminal Here"): only for agents that may run code. */
const RUN_CODE = { name: "run_code", scope: SANDBOX_SCOPE };
/** The longest one action may take: starting an app waits for its window, long text is typed key by key. */
const ACT_MS = 240_000;
const MAX_WAIT_SECONDS = MAX_WAIT_MS / 1000;

const VERBS: readonly ScreenVerb[] = [
  "open",
  "click",
  "double_click",
  "right_click",
  "hover",
  "focus",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "press",
  "scroll",
  "drag",
  "wait",
  "read",
];

const targetProp = {
  type: "string",
  description:
    "What to act on: its number from the screen (`e7`) or plain words (`the Save button`, `the File menu`, `Documents in the file list`). For something that can't be undone (delete, discard, overwrite), give its number.",
  maxLength: 500,
} as const;

/** One step of `desktop_do`. */
const STEP_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    do: { type: "string", enum: [...VERBS] },
    target: targetProp,
    to: { ...targetProp, description: "`drag`: where to drop it, as a number or in words like `target`." },
    app: {
      type: "string",
      description: "`open`: an app by its name (`Files`, `Terminal`, `Text Editor`).",
      maxLength: 200,
    },
    path: {
      type: "string",
      description: "`open`: a file or folder in your folder (`reports/q3.ods`), opened in its app.",
      maxLength: DESKTOP_LIMITS.path,
    },
    url: { type: "string", description: "Not here: web pages open in your browser (browser_do).", maxLength: 2048 },
    text: {
      type: "string",
      description:
        "`fill`: the field's whole text. `type`: what to type, into `target` or wherever the focus is. `wait`: wait until this text shows.",
      maxLength: DESKTOP_LIMITS.text,
    },
    value: { type: "string", description: "`select`: the option's visible text.", maxLength: 1000 },
    key: {
      type: "string",
      description: "`press`: key names joined by +: `Enter`, `Escape`, `ctrl+s`, `alt+F4`.",
      maxLength: DESKTOP_LIMITS.key,
    },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    pixels: { type: "integer", minimum: 50, maximum: 10_000 },
    until: {
      type: "string",
      description: "`wait`: until this is true on the screen, in words (`the download finished`).",
      maxLength: 500,
    },
    seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, description: "`wait`: at most this long." },
    find: {
      type: "string",
      description:
        "`read`: what to get from the screen (`the command's output`, `the error message`): only the lines that answer it.",
      maxLength: 500,
    },
    expect: {
      type: "string",
      description:
        "After this step the screen should show this (`a folder reports in Documents`, `the file is saved`). It is checked; the plan stops there when it isn't true.",
      maxLength: 500,
    },
  },
  required: ["do"],
  additionalProperties: false,
};

/** A step that opens a web address: the browser's work, refused before anything runs. */
const opensWebPage = (s: ScreenStep) =>
  s.do === "open" &&
  !s.app?.trim() &&
  !s.path?.trim() &&
  (s.url !== undefined || /^\s*[a-z][\w+.-]*:\/\//i.test(s.target ?? ""));

/** Without a judge, words can't be matched: only numbers and exact names work. */
const NO_JUDGE: Judge = {
  name: "none",
  ask() {
    return Promise.reject(new Error("name it by its number from desktop_read: this server can't match words"));
  },
};

/** Screen text is untrusted: any app or web page can put words on the screen (window titles included). */
const screenBlock = (text: string) => untrustedBlock("desktop screen", text, MAX_PAGE_TEXT);

/** Said when a plan stopped with the agent's browser on the screen: what is in its window is the browser's. */
const BROWSER_WINDOW = "Your browser's window is on this screen: what is in it is for browser_do, not the desktop.";

/** Runner refusals → what the agent reads. A step's own failure (a stale element, what covers it) stays as said. */
function explain(error: unknown, machineName: string): string {
  if (error instanceof MachineOfflineError || error instanceof MachinePausedError) return error.message;
  if (!(error instanceof MachineRequestError)) return error instanceof Error ? error.message : String(error);
  switch (error.code) {
    case "not_allowed":
      return `The desktop or commands are turned off on the computer ${machineName}. Only the person at that computer can turn them on; tell the people.`;
    case "desktop_unavailable":
      return `Your desktop isn't available on the computer ${machineName}: ${error.message}`;
    case "desktop_busy":
      return `The computer ${machineName} runs as many desktops as its memory allows; try again later, or tell the people.`;
    case "paused":
      return `The owner paused the computer ${machineName}: nothing new can start there until they resume it. Tell the people.`;
    case "timeout":
      return `The desktop took too long (${error.message}). Look at it again (desktop_read) before going on.`;
    default:
      return error.message;
  }
}

/** Verbs the message's trail tells as another: a hover is pointing, unchecking is checking. */
const TRAIL_AS: Partial<Record<ScreenVerb, ScreenVerb>> = { hover: "click", uncheck: "check" };

/**
 * The steps for the message's trail of the desktop (`desktopTrail`, then `meta.desktop.steps`): each
 * as `desktop_<verb>`, a file opened as `desktop_open_file`, and the app an `open` started in the
 * agent's words; never what was typed or read.
 */
function trailOf(report: PlanReport) {
  return report.steps
    .filter((s) => s.status !== "skipped")
    .map(({ step, status, ran }) => {
      const app = step.do === "open" ? step.app?.trim() : undefined;
      const verb = step.do === "open" && !app && step.path?.trim() ? "open_file" : (TRAIL_AS[step.do] ?? step.do);
      return {
        tool: `desktop_${verb}`,
        ...(app ? { detail: app.slice(0, 100) } : {}),
        ...(status === "failed" && !ran ? { failed: true as const } : {}),
      };
    });
}

/**
 * What a plan started on the computer, in the org's audit log: an app (its desktop entry) or a file
 * in the agent's folder, for whoever watches what agents run.
 */
async function auditOpened(ctx: ToolContext, machineId: string, opened: DesktopAction[]) {
  for (const a of opened) {
    if (a.kind !== "launch" && a.kind !== "open_file") continue;
    await recordAudit(ctx.db, {
      orgId: ctx.orgId,
      actor: { type: "agent", id: ctx.agentId },
      action: a.kind === "launch" ? "desktop.app_opened" : "desktop.file_opened",
      target: { type: "machine", id: machineId },
      details: {
        ...(a.kind === "launch" ? { app: a.app } : { path: a.path }),
        ...(ctx.runId ? { runId: ctx.runId } : {}),
      },
    }).catch(() => {});
  }
}

/**
 * The agent's own desktop as tools (ADR 0062): `desktop_do` (plans on the
 * screen layer, ADR 0054), `desktop_read` and `desktop_screenshot`, under
 * `desktop:use`; `desktop_ask_person` is the handoff's own source. Driving a
 * desktop runs commands as the agent, on any site, so the tools are offered,
 * and allowed on each call, only while the agent may also run code, the
 * organization's code environment is on and its computer serves desktop use
 * with its desktop and commands switches on. Screen text reaches the model only
 * as untrusted content; a dialog in the way is never closed on a guess; a
 * person in control of the screen makes the agent wait.
 */
export function createDesktopToolSource(deps: DesktopToolDeps): ToolSource {
  const hub = deps.machines?.hub;
  const judge = deps.judge ?? NO_JUDGE;
  const targets = deps.targets ?? createTargetCache();
  const now = deps.now ?? Date.now;
  /** The screen each agent last saw: what changes are counted from, and the first target found on. */
  const seen = createLookMemory(now);
  const seenKey = (ctx: ToolContext) => `${ctx.orgId}:${ctx.agentId}`;

  /** Whether this agent may drive its desktop now, and whether driving it asks a person first, as code does. */
  async function gateOf(
    ctx: ToolContext,
    granted?: Set<string>,
  ): Promise<{ refused: string } | { approvals: boolean }> {
    const keys = granted ?? (await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId));
    if (!isAllowed(toolAccess(keys, RUN_CODE))) {
      return {
        refused:
          "Using your desktop runs commands on your computer, and you may not run code. An admin or your owner can give you Run code; say so.",
      };
    }
    const settings = await getSandboxSettings(ctx.db, ctx.orgId);
    if (!settings.enabled) {
      return {
        refused:
          "Using your desktop runs commands on your computer, and running code is turned off for this organization. Tell the people.",
      };
    }
    return { approvals: settings.requireApproval };
  }

  /** The agent's desktop for this call (its computer and agent bound), or why it can't be used. */
  async function linkFor(
    ctx: ToolContext,
  ): Promise<
    | { ok: true; link: DesktopLink; machineId: string; write(path: string, base64: string): Promise<unknown> }
    | { ok: false; text: string }
  > {
    const gate = await gateOf(ctx);
    if ("refused" in gate) return { ok: false, text: gate.refused };
    const status = await agentDesktopUseStatus(ctx.db, hub, ctx.orgId, ctx.agentId);
    if (!status.available) return { ok: false, text: desktopUseUnavailableText(status) };
    if (!hub) return { ok: false, text: "Connected computers are not available on this server." };
    const caller = hub;
    const row = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
    const agent: AgentScope = {
      id: ctx.agentId,
      handle: row?.handle ?? "agent",
      ...(row?.name ? { name: row.name } : {}),
    };
    const { machineId, machineName } = status;
    const options = { signal: ctx.signal };
    // A computer just gone or asleep in standby is waited for, as the browser's and the sandbox's calls do (ADR 0161).
    const told = async <T>(call: () => Promise<T>) => {
      try {
        return await callWhenBack(caller, machineId, call, ctx.signal);
      } catch (error) {
        throw new Error(explain(error, machineName));
      }
    };
    return {
      ok: true,
      machineId,
      link: {
        look: () => told(() => caller.call<"desktop.look">(machineId, { op: "desktop.look", agent }, options)),
        act: (action, settle) =>
          told(() =>
            caller.call<"desktop.act">(
              machineId,
              { op: "desktop.act", agent, action, settle },
              { ...options, timeoutMs: ACT_MS },
            ),
          ),
        capture: (region) =>
          told(() =>
            caller.call<"desktop.capture">(
              machineId,
              { op: "desktop.capture", agent, ...(region ? { region } : {}) },
              options,
            ),
          ),
        apps: async () =>
          (await told(() => caller.call<"desktop.apps">(machineId, { op: "desktop.apps", agent }, options))).apps,
      },
      write: (path, base64) =>
        told(() => caller.call<"write">(machineId, { op: "write", agent, path, base64 }, options)),
    };
  }

  /** Runs steps on the agent's desktop (`runPlan`) and answers with the report and the screen at the end. */
  async function plan(ctx: ToolContext, steps: ScreenStep[]): Promise<ToolOutput> {
    const linked = await linkFor(ctx);
    if (!linked.ok) return { content: linked.text, isError: true };
    const key = seenKey(ctx);
    let paused: ToolOutput | null = null;
    // A take over that begins and ends within one step leaves no open handoff to see: it is checked too.
    const started = new Date();
    let handedBack = false;
    const acted: DesktopAction[] = [];
    const report = await runPlan(
      {
        judge,
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        runId: ctx.runId,
        surface: desktopSurface({
          link: linked.link,
          signal: ctx.signal,
          onLook: (o) => seen.remember(key, o),
          onAct: (a) => acted.push(a),
        }),
        cache: targets,
        scope: key,
        signal: ctx.signal,
        // A person taking the desktop stops the plan at the next step; the run waits on them.
        hold: async () => {
          const wait = await waitIfPersonInControl(ctx.db, ctx, deps.pubsub, "desktop");
          if (wait) {
            paused = wait;
            return "a person took over the desktop";
          }
          if (await handedBackSince(ctx.db, ctx, started, "desktop")) {
            handedBack = true;
            return "a person had the desktop meanwhile and changed it: read it (desktop_read) before acting again";
          }
          return null;
        },
        last: seen.within(key, FRESH_LOOK_MS),
        before: seen.within(key, KNOWN_LOOK_MS),
        vision: deps.vision?.() === true,
        // What covers a target on a desktop is usually a real dialog ("Save changes?"): never closed on a guess.
        dismiss: false,
        now,
      },
      steps,
    );
    await auditOpened(ctx, linked.machineId, acted);
    // The agent has seen the screen (the report shows it); not when a person changed it meanwhile.
    if (!handedBack && report.after) await markPageRead(ctx.db, ctx, "desktop");
    const f = formatPlanReport(report);
    const steer =
      report.stopped && report.after?.lines.some((l) => l.includes(DESKTOP_AGENT_BROWSER)) ? `\n${BROWSER_WINDOW}` : "";
    const content = `${f.summary}${steer}${f.screen ? `\n${screenBlock(f.screen)}` : ""}`;
    const data: Record<string, unknown> = {
      desktopTrail: trailOf(report),
      timing: { ms: report.ms, steps: report.steps.map((s) => s.ms) },
    };
    const waiting = paused as ToolOutput | null;
    if (waiting) {
      return {
        content: `${content}\n${waiting.content}`,
        ...(waiting.isError ? { isError: true } : {}),
        data: { ...data, ...(waiting.data ?? {}) },
      };
    }
    // A step that ran and only failed its check was done: not an error (it must not be done again).
    const nothingDone = report.steps.every((s) => s.status !== "done" && !s.ran);
    return { content, ...(f.failed && nothingDone ? { isError: true } : {}), data };
  }

  /** A desktop tool: a person in control of the screen, or asked to take it, makes the agent wait first. */
  const tool = (
    name: "desktop_do" | "desktop_read" | "desktop_screenshot",
    description: string,
    inputSchema: JsonSchema,
    execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>,
  ): ToolDefinition => ({
    name,
    description,
    inputSchema,
    scope: DESKTOP_SCOPE,
    needs: RUN_CODE,
    readsOutside: true,
    execute: async (input, ctx) =>
      (await waitIfPersonInControl(ctx.db, ctx, deps.pubsub, "desktop")) ?? execute(input, ctx),
  });

  const changes =
    "Each step waits for the screen to settle, and the answer says what changed on it (or, in another app or dialog, what you can act on there), so you rarely need to read the screen again.";

  const definitions: ToolDefinition[] = [
    tool(
      "desktop_do",
      `${DESKTOP_TOOL_INFO.desktop_do.description} For apps with no API or web version (native apps, file and system dialogs, a terminal window); web pages go to browser_do, and commands to run_code. Write the whole task as \`steps\` in one call, from the \`open\` (an app by its name, or a file) to the last click, the way you'd do it by hand: name each target in words (\`the File menu\`, \`Save\`) or by its number, and it is found on the screen as it is at that step. Give \`expect\` on steps whose result matters: it's checked, and the plan stops at the first step that fails or doesn't show it, saying why and what's on the screen then. A dialog in the way is never closed for you: the plan stops and names it, and you decide. ${changes}`,
      {
        type: "object",
        properties: { steps: { type: "array", minItems: 1, maxItems: MAX_PLAN_STEPS, items: STEP_SCHEMA } },
        required: ["steps"],
        additionalProperties: false,
      },
      async (input, ctx) => {
        const raw = Array.isArray(input.steps) ? input.steps : [];
        const steps = raw.map((s) => screenStepOf(s, VERBS));
        if (steps.length === 0 || steps.some((s) => s === null)) {
          return { content: "Give `steps`, each with a known `do`.", isError: true };
        }
        const valid = steps as ScreenStep[];
        if (valid.some(opensWebPage)) return { content: `Nothing was done: ${BROWSER_HINT}.`, isError: true };
        if (actsBeforeOpening(valid)) {
          const stale = await requirePageRead(ctx.db, ctx, "desktop");
          if (stale) return stale;
        }
        return plan(ctx, valid);
      },
    ),
    tool(
      "desktop_read",
      `${DESKTOP_TOOL_INFO.desktop_read.description} The windows in front, their menus, buttons and fields, and the text of terminals and fields; windows behind are one line each. Act on an element by its number (\`e7\`) or name it in words. To get one thing (a command's output, a status, an error), say it in \`find\`: you get just the lines that answer it.`,
      {
        type: "object",
        properties: {
          find: {
            type: "string",
            description: "What you're looking for (`the last command's output`, `whether the export finished`).",
            maxLength: 500,
          },
        },
        additionalProperties: false,
      },
      async (input, ctx) => {
        const linked = await linkFor(ctx);
        if (!linked.ok) return { content: linked.text, isError: true };
        let look: DesktopLookReply;
        try {
          look = await linked.link.look();
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
        const screen = observationOf(look);
        seen.remember(seenKey(ctx), screen);
        await markPageRead(ctx.db, ctx, "desktop");
        const question = typeof input.find === "string" ? input.find.trim() : "";
        if (question && deps.judge) {
          const found = await findInPage({
            judge,
            orgId: ctx.orgId,
            agentId: ctx.agentId,
            runId: ctx.runId,
            question,
            observation: screen,
          }).catch(() => null);
          const part = found?.searched
            ? ` (searched ${found.searched.lines} of the screen's ${found.searched.of} lines)`
            : "";
          if (found && found.answered !== "no") {
            const partly = found.answered === "partly" ? " (it may only partly answer it)" : "";
            return { content: `Where the screen answers "${question}"${partly}${part}:\n${screenBlock(found.text)}` };
          }
          if (found) {
            return {
              content: `Nothing on the screen answers "${question}"${part}. Read the whole screen (no \`find\`) to look yourself, or open where it would be.`,
            };
          }
        }
        const head = `Now in ${look.address}${look.title ? ` — ${look.title}` : ""}`;
        return { content: screenBlock(`${head}\n${look.snapshot.trim() || "(nothing on the screen)"}`) };
      },
    ),
    tool(
      "desktop_screenshot",
      `${DESKTOP_TOOL_INFO.desktop_screenshot.description} A JPEG of the whole screen, for how something looks or to show it to people; to know what the screen says, desktop_read is faster and exact. When people want to see it (a screenshot here, in the chat), give \`share\`: in the same call it goes to the Drive and shows in this conversation with your reply.`,
      {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Where in your folder (a .jpg; default `screenshots/<time>.jpg`).",
            maxLength: 1000,
          },
          share: SHARE_INPUT,
        },
        additionalProperties: false,
      },
      async (input, ctx) => {
        const given = typeof input.path === "string" ? input.path : "";
        const chosen = given
          ? agentFolderPath(given)
          : `screenshots/${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
        if (!chosen) return { content: "Give a path inside your own folder (relative, without `..`).", isError: true };
        // The image is a JPEG, whatever the name asked for.
        const path = /\.jpe?g$/i.test(chosen) ? chosen : `${chosen.replace(/\.[^./]*$/, "")}.jpg`;
        const linked = await linkFor(ctx);
        if (!linked.ok) return { content: linked.text, isError: true };
        try {
          const shot = await linked.link.capture();
          await linked.write(path, shot.data);
          const saved = {
            content: `Saved ${path} in your folder: the whole screen as a JPEG (${shot.width}×${shot.height}). ${
              // A computer brain (Claude Code, Codex) sees pictures with its own Read; read_file gives text only.
              ctx.bridge
                ? "Open it with your own Read tool to look at it."
                : "You can't see pictures from here: desktop_read tells what the screen says."
            }`,
            data: { path },
          };
          if (input.share !== true) return { ...saved, content: `${saved.content} ${SHARE_HINT}` };
          return shareSavedFile(deps, ctx, linked.machineId, path, saved);
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      },
    ),
  ];

  return {
    name: "desktop",
    async tools(ctx) {
      if (!hub) return [];
      // Most agents have no desktop: the cached grants decide before any lookup. Without them (its own, or
      // Run code's) the gateway keeps these from the agent, and `find_tools` names them as not allowed yet.
      const granted = await grantedScopeKeys(ctx.db, ctx.orgId, ctx.agentId);
      if (!definitions.some((t) => isAllowed(accessWithNeeds(granted, t).state))) return definitions;
      const gate = await gateOf(ctx, granted);
      if ("refused" in gate) return [];
      if (!(await agentDesktopUseStatus(ctx.db, hub, ctx.orgId, ctx.agentId)).available) return [];
      // Where every command asks a person first, so does driving the desktop.
      return gate.approvals
        ? definitions.map((t) => (t.name === "desktop_do" ? { ...t, sensitive: true } : t))
        : definitions;
    },
  };
}
