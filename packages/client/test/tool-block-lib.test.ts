import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { LiveRun, LiveWork } from "../src/index";
import { applyChannelEvent, emptyStreams, isQuiet, QUIET_AFTER_MS } from "../src/index";
import { type Activity, barEntries, toolActivity } from "../src/lib/activity";
import {
  callLogo,
  foldSteps,
  formatLineTime,
  oneCall,
  quietLine,
  quietWork,
  savedOneLine,
  stepPhrase,
  type ToolItem,
  toolApps,
  toolCalls,
  toolHint,
  toolItemsLive,
  toolItemsSaved,
  toolLineHint,
  toolNow,
  toolPhrase,
  toolWhy,
  workApps,
  workFromSteps,
  workMeta,
  workSteps,
} from "../src/lib/work";

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const start = (toolUseId: string, tool: string, extra: Record<string, unknown> = {}) =>
  ({ type: "agent.tool", ...base, tool, toolUseId, ...extra }) as Ev;
const end = (toolUseId?: string, failed?: boolean) =>
  ({
    type: "agent.tool",
    ...base,
    tool: null,
    ...(toolUseId ? { toolUseId } : {}),
    ...(failed ? { failed } : {}),
  }) as Ev;
const calls = (work: LiveWork[] | undefined) =>
  (work ?? []).flatMap((w) => (w.kind === "call" ? [{ id: w.id, running: w.running, failed: w.failed === true }] : []));

/** "key|{values}": which words, with what. */
const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key}|${JSON.stringify(o)}` : key)) as TFunction;

describe("the live calls", () => {
  test("the end names its call and says whether it failed; each ended call has its time", () => {
    let s = [start("a", "github_search_issues", { connector: "GitHub" }), start("b", "create_issue")].reduce(
      applyChannelEvent,
      emptyStreams,
    );
    // A new call ended the one before.
    expect(calls(s.runs.r1?.work)).toEqual([
      { id: "a", running: false, failed: false },
      { id: "b", running: true, failed: false },
    ]);
    s = applyChannelEvent(s, end("b", true));
    expect(calls(s.runs.r1?.work)).toEqual([
      { id: "a", running: false, failed: false },
      { id: "b", running: false, failed: true },
    ]);
    const ended = (s.runs.r1?.work ?? []).filter((w) => w.kind === "call");
    for (const w of ended) expect(typeof (w as { ms?: number }).ms).toBe("number");
  });

  test("a call that waits on a person never reads as done", () => {
    let s = [start("a", "gmail_send_email", { connector: "Gmail" })].reduce(applyChannelEvent, emptyStreams);
    s = applyChannelEvent(s, { ...end("a"), held: true } as Ev);
    const items = toolItemsLive(s.runs.r1?.work ?? []);
    expect(items.map((i) => (i.kind === "call" ? i.line.state : i.kind))).toEqual(["stop"]);
  });

  test("an end without an id still stops the last running call (older servers)", () => {
    let s = [start("a", "create_issue")].reduce(applyChannelEvent, emptyStreams);
    s = applyChannelEvent(s, end());
    expect(calls(s.runs.r1?.work)).toEqual([{ id: "a", running: false, failed: false }]);
  });
});

const call = (id: string, tool: string, extra: Partial<Extract<LiveWork, { kind: "call" }>> = {}): LiveWork => ({
  kind: "call",
  id,
  tool,
  connector: null,
  detail: null,
  code: null,
  output: [],
  running: false,
  ms: 100,
  ...extra,
});

describe("the block's lines", () => {
  test("the same kind in a row is one line counting each; a failure keeps them apart", () => {
    const items = toolItemsLive([
      call("1", "browser_open"),
      call("2", "browser_click"),
      call("3", "browser_click", { failed: true }),
      call("4", "browser_click", { running: true, ms: undefined }),
    ]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.state}×${i.line.count}` : i.kind))).toEqual([
      "done×2",
      "fail×1",
      "run×1",
    ]);
    expect(toolCalls(items)).toBe(4);
    expect(toolNow(items)?.key).toBe("4");
  });

  test("a stopped run shows its running call as stopped; messages it read are their own items", () => {
    const items = toolItemsLive(
      [call("1", "create_issue", { running: true }), { kind: "steer", messageId: "m9" }],
      true,
    );
    expect(items.map((i) => (i.kind === "call" ? i.line.state : i.kind))).toEqual(["stop", "steer"]);
  });

  test("logos: each app once, in order of first use; our tools by kind", () => {
    const items = toolItemsLive([
      call("1", "github_search_issues", { connector: "GitHub" }),
      call("2", "create_issue"),
      call("3", "github_get_issue", { connector: "GitHub" }),
    ]);
    expect(toolApps(items)).toEqual([{ kind: "consulting", app: "GitHub" }, { kind: "creatingIssue" }]);
  });

  test("a reaction shows on the message, never in the block: alone there is no call; with others, only they count", () => {
    expect(toolItemsLive([call("1", "react")])).toEqual([]);
    const items = toolItemsLive([call("1", "mcp__agentes__react"), call("2", "create_issue")]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.kind}×${i.line.count}` : i.kind))).toEqual([
      "creatingIssue×1",
    ]);
    expect(toolCalls(items)).toBe(1);
    const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, s)).toISOString();
    const saved = workFromSteps([
      { seq: 1, kind: "tool_call", data: { toolUseId: "t1", name: "react", input: { emoji: "🙌" } }, createdAt: at(0) },
      { seq: 2, kind: "tool_result", data: { toolUseId: "t1", content: "Reaction added." }, createdAt: at(1) },
      { seq: 3, kind: "tool_call", data: { toolUseId: "t2", name: "create_issue", input: {} }, createdAt: at(2) },
      { seq: 4, kind: "tool_result", data: { toolUseId: "t2", content: "ok" }, createdAt: at(3) },
    ]);
    expect(toolCalls(toolItemsSaved(saved))).toBe(1);
    expect(saved.steps.map((s) => s.kind)).toEqual(["creatingIssue"]);
  });

  test("looking a tool up is ours and never a line: alone there is no block; beside others, only they count", () => {
    // The bar above the box still says it: ours, not an app called find.
    expect(toolActivity("find_tools").kind).toBe("findingTools");
    expect(toolActivity("github_find_tools", "GitHub").kind).toBe("findingTools");
    expect(toolItemsLive([call("1", "find_tools"), call("2", "github_find_tools", { connector: "GitHub" })])).toEqual(
      [],
    );
    const items = toolItemsLive([
      call("1", "find_tools"),
      call("2", "use_tool", { failed: true }),
      call("3", "list_issues"),
    ]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.kind}×${i.line.count}` : i.kind))).toEqual([
      "readingIssues×1",
    ]);
    expect(toolCalls(items)).toBe(1);
    const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, s)).toISOString();
    const saved = workFromSteps([
      {
        seq: 1,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "find_tools", input: { query: "x" } },
        createdAt: at(0),
      },
      { seq: 2, kind: "tool_result", data: { toolUseId: "t1", content: "list_issues" }, createdAt: at(1) },
      { seq: 3, kind: "tool_call", data: { toolUseId: "t2", name: "list_issues", input: {} }, createdAt: at(2) },
      { seq: 4, kind: "tool_result", data: { toolUseId: "t2", content: "[]" }, createdAt: at(3) },
    ]);
    expect(saved.steps.map((s) => s.kind)).toEqual(["readingIssues"]);
    // A reply saved before the server left lookups out: lookups alone are no block, and never a logo.
    expect(workSteps({ steps: 2, calls: [{ name: "find_tools" }], durationMs: 900 })).toBe(0);
    expect(workSteps({ steps: 3, calls: [{ name: "find_tools" }, { name: "list_issues" }], durationMs: 900 })).toBe(3);
    expect(workApps([{ name: "find_tools" }, { name: "list_issues" }])).toEqual([{ kind: "readingIssues" }]);
    // A big connector's lookup was counted with that app's calls: it may stand for them too.
    expect(
      workSteps({ steps: 2, calls: [{ name: "tiktok_find_tools", connector: "TikTok Ads" }], durationMs: 0 }),
    ).toBe(2);
  });

  test("coming back later is ours, not apps called follow and cancel", () => {
    const items = toolItemsLive([
      call("1", "follow_up"),
      call("2", "mcp__agentes__follow_up"),
      call("3", "cancel_follow_up"),
    ]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.kind}×${i.line.count}` : i.kind))).toEqual([
      "followingUp×2",
      "cancelingFollowUp×1",
    ]);
    expect(toolApps(items)).toEqual([{ kind: "followingUp" }, { kind: "cancelingFollowUp" }]);
  });

  test("checking its own usage is ours, not a tool named get my usage", () => {
    const items = toolItemsLive([call("1", "get_my_usage"), call("2", "mcp__agentes__get_my_usage")]);
    expect(items.map((i) => (i.kind === "call" ? `${i.line.kind}×${i.line.count}` : i.kind))).toEqual([
      "checkingUsage×2",
    ]);
  });

  test("grey words: a built-in's label, or a connector tool's own name without its app; never its input", () => {
    expect(toolHint("create_issue", { kind: "creatingIssue" }, "Corrigir login")).toBe("Corrigir login");
    expect(toolHint("create_issue", { kind: "creatingIssue" })).toBeNull();
    expect(toolHint("github_search_issues", { kind: "consulting", app: "GitHub" })).toBe("search issues");
    expect(toolHint("mcp__linear__get_project", { kind: "consulting", app: "Linear" })).toBe("get project");
    // A later account's number goes with its app.
    expect(toolHint("stripe_2_list_customers", { kind: "consulting", app: "Stripe (Loja B)" })).toBe("list customers");
  });

  test("phrases: working, done, failed, stopped", () => {
    const l = { kind: "consulting" as const, app: "GitHub", tool: "github_search_issues" };
    expect(toolPhrase(t, { ...l, state: "run" })).toBe('Chat.activity.consulting|{"app":"GitHub"}…');
    expect(toolPhrase(t, { ...l, state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"GitHub","tool":"search issues"}',
    );
    expect(toolPhrase(t, { ...l, state: "fail" })).toBe(
      'chat.work.erred|{"activity":"chat.activity.consulting|{\\"app\\":\\"GitHub\\"}"}',
    );
    expect(formatLineTime("pt-BR", 1200)).toBe("1,2 s");
    expect(formatLineTime("pt-BR", 760)).toBe("760 ms");
    expect(formatLineTime("pt-BR", 59 * 60_000)).toBe("59 min");
    // Past an hour minutes stop meaning anything to a person.
    expect(formatLineTime("pt-BR", 90 * 60_000)).toBe("1,5 h");
    expect(formatLineTime("pt-BR", 1446 * 60_000)).toBe("24 h");
  });

  test("a saved run: the label it was recorded with, why it failed, what it got and gave", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, s)).toISOString();
    const work = workFromSteps([
      {
        seq: 1,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "create_issue", input: { title: "X" }, detail: "X" },
        createdAt: at(0),
      },
      {
        seq: 2,
        kind: "tool_result",
        data: { toolUseId: "t1", isError: true, content: "timed out after 5s\nstack" },
        createdAt: at(2),
      },
    ]);
    const [item] = toolItemsSaved(work);
    expect(item?.kind === "call" && item.line).toMatchObject({
      state: "fail",
      hint: "X",
      why: "timed out after 5s",
      ms: 2000,
      result: "timed out after 5s\nstack",
    });
    expect(item?.kind === "call" && item.line.input).toContain('"title": "X"');
  });
});

describe("a call refused for its arguments", () => {
  const offer = "offer_connect_app";
  const lines = (items: ToolItem[]) => items.flatMap((i) => (i.kind === "call" ? [i.line] : []));
  const states = (items: ToolItem[]) => lines(items).map((l) => l.state);
  const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 10, 0, s)).toISOString();
  /** A call's two steps: `content` is what the tool answered, an error when `isError`. */
  const steps = (seq: number, name: string, content: string, isError = false) => [
    { seq, kind: "tool_call", data: { toolUseId: `t${seq}`, name, input: {} }, createdAt: at(seq) },
    { seq: seq + 1, kind: "tool_result", data: { toolUseId: `t${seq}`, isError, content }, createdAt: at(seq + 1) },
  ];
  const slip = "Invalid input: input.why: required";

  test("live: made right by its next call, the head is that call's and the slip stays a quiet line", () => {
    const items = toolItemsLive([call("1", offer, { failed: true, slip: true }), call("2", offer, { running: true })]);
    expect(states(items)).toEqual(["stop", "run"]);
    const done = toolItemsLive([call("1", offer, { failed: true, slip: true }), call("2", offer)]);
    expect(states(done)).toEqual(["stop", "done"]);
    expect(toolNow(done)?.state).toBe("done");
  });

  test("live: right after the refusal it reads as still at it, never as an error", () => {
    const items = toolItemsLive([call("1", offer, { failed: true, slip: true })]);
    expect(toolNow(items)?.state).toBe("run");
    expect(toolPhrase(t, toolNow(items) as NonNullable<ReturnType<typeof toolNow>>)).not.toContain("erred");
  });

  test("live: never made right, it shows plainly: the run ended, or it went on to something else", () => {
    expect(states(toolItemsLive([call("1", offer, { failed: true, slip: true })], true))).toEqual(["fail"]);
    const other = toolItemsLive([call("1", offer, { failed: true, slip: true }), call("2", "create_issue")]);
    expect(states(other)).toEqual(["fail", "done"]);
    const failedAgain = toolItemsLive([
      call("1", offer, { failed: true, slip: true }),
      call("2", offer, { failed: true }),
    ]);
    expect(states(failedAgain)).toEqual(["fail", "fail"]);
  });

  test("live: refused twice in a row, no red while it is still at it; red for both if it ends there", () => {
    const twice = [call("1", offer, { failed: true, slip: true }), call("2", offer, { failed: true, slip: true })];
    expect(states(toolItemsLive(twice))).toEqual(["stop", "run"]);
    expect(states(toolItemsLive(twice, true))).toEqual(["fail", "fail"]);
    expect(states(toolItemsLive([...twice, call("3", offer)]))).toEqual(["stop", "stop", "done"]);
  });

  test("live: a retry the run's end cut short made nothing right", () => {
    const cut = [call("1", offer, { failed: true, slip: true }), call("2", offer, { running: true })];
    expect(states(toolItemsLive(cut, true))).toEqual(["fail", "stop"]);
  });

  test("live: a real failure is an error whatever came after", () => {
    expect(states(toolItemsLive([call("1", offer, { failed: true }), call("2", offer)]))).toEqual(["fail", "done"]);
  });

  test("saved: made right, a quiet line that still opens on what it was told; the summary counts both", () => {
    const items = toolItemsSaved(
      workFromSteps([...steps(1, offer, slip, true), ...steps(3, offer, "Posted the card.")]),
    );
    expect(states(items)).toEqual(["stop", "done"]);
    expect(lines(items)[0]?.result).toBe(slip);
    expect(toolNow(items)?.state).toBe("done");
    expect(toolCalls(items)).toBe(2);
  });

  test("saved: never made right, or a real failure, shows plainly", () => {
    expect(states(toolItemsSaved(workFromSteps(steps(1, offer, slip, true))))).toEqual(["fail"]);
    const other = [...steps(1, offer, slip, true), ...steps(3, "create_issue", "Created.")];
    expect(states(toolItemsSaved(workFromSteps(other)))).toEqual(["fail", "done"]);
    const real = [...steps(1, offer, "The catalog is down.", true), ...steps(3, offer, "Posted the card.")];
    expect(states(toolItemsSaved(workFromSteps(real)))).toEqual(["fail", "done"]);
  });

  test("the end says it was a slip, and the row keeps it", () => {
    let s = applyChannelEvent(emptyStreams, start("a", offer));
    s = applyChannelEvent(s, { ...end("a", true), slip: true } as Ev);
    expect(s.runs.r1?.work?.[0]).toMatchObject({ kind: "call", failed: true, slip: true });
  });
});

describe("a computer command (its permission check)", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, s)).toISOString();
  const lines = (items: ReturnType<typeof toolItemsLive>) => items.flatMap((i) => (i.kind === "call" ? [i.line] : []));
  const REFUSAL =
    "This command was refused because it changes files outside the mission folder. Do it another way; if there is none, say so.";
  const BECAUSE = "This command was refused because it changes files outside the mission folder.";

  test("live: the line says the command it checked, opens on the whole command, a refusal says why in a sentence", () => {
    let s = [
      start("a", "permission_prompt", {
        detail: "Rerun new unit tests after formatting",
        command: "npx jest a.test.ts",
      }),
      start("b", "permission_prompt", { detail: "rm /etc/agentes", command: "rm -rf /etc/agentes" }),
    ].reduce(applyChannelEvent, emptyStreams);
    s = applyChannelEvent(s, { ...end("b", true), why: REFUSAL } as Ev);
    const [ran, refused] = lines(toolItemsLive(s.runs.r1?.work ?? []));
    expect(ran).toMatchObject({ kind: "runningCommand", state: "done", hint: null, input: "npx jest a.test.ts" });
    expect(refused).toMatchObject({
      kind: "runningCommand",
      state: "fail",
      input: "rm -rf /etc/agentes",
      why: BECAUSE,
    });
    expect(ran && toolPhrase(t, ran)).toBe(
      'chat.work.step.runningCommand|{"app":"Rerun new unit tests after formatting","tool":"permission prompt"}',
    );
    expect(refused && toolPhrase(t, refused)).toBe('chat.work.refused|{"app":"rm /etc/agentes"}');
    expect(toolPhrase(t, { kind: "runningCommandAny", tool: "permission_prompt", state: "fail" })).toBe(
      "chat.work.refusedAny",
    );
  });

  test("saved: its recorded label and command; the same in a row once; asking again brings the person's answer", () => {
    const check = (seq: number, id: string, input: Record<string, unknown>, more: Record<string, unknown> = {}) => ({
      seq,
      kind: "tool_call",
      data: { toolUseId: id, name: "permission_prompt", input, ...more },
      createdAt: at(seq),
    });
    const answer = (seq: number, id: string, content: unknown) => ({
      seq,
      kind: "tool_result",
      data: { toolUseId: id, name: "permission_prompt", content: JSON.stringify(content) },
      createdAt: at(seq),
    });
    const bash = (command: string, description?: string) => ({
      tool_name: "Bash",
      input: { command, ...(description ? { description } : {}) },
    });
    const work = workFromSteps([
      check(1, "t1", bash("npm test", "Run the tests"), { detail: "Run the tests", command: "npm test" }),
      answer(2, "t1", { behavior: "allow" }),
      check(3, "t2", bash("npm test", "Run the tests"), { detail: "Run the tests", command: "npm test" }),
      answer(4, "t2", { behavior: "allow" }),
      check(5, "t3", bash("rm -rf /etc/x"), { detail: "rm /etc/x", command: "rm -rf /etc/x" }),
      answer(6, "t3", { behavior: "deny", message: REFUSAL }),
      check(7, "t4", bash("npm publish"), { detail: "npm publish", command: "npm publish" }),
      answer(8, "t4", { status: "pending", request_id: "req-1" }),
      check(9, "t5", { request_id: "req-1" }),
      answer(10, "t5", { status: "pending", request_id: "req-1" }),
      check(20, "t6", { request_id: "req-1" }),
      answer(21, "t6", { behavior: "deny", message: "A person said no. Don't try this command again." }),
    ]);
    expect(lines(toolItemsSaved(work)).map((l) => [l.app, l.count, l.state, l.hint, l.input, l.result, l.why])).toEqual(
      [
        ["Run the tests", 2, "done", null, "npm test", null, null],
        ["rm /etc/x", 1, "fail", null, "rm -rf /etc/x", null, BECAUSE],
        ["npm publish", 1, "fail", null, "npm publish", null, "A person said no."],
      ],
    );
    // From the ask to the person's answer.
    expect(work.steps[2]?.ms).toBe(14_000);
  });

  test("saved: an allowed check and a refused one of the same command are two lines; a later no refuses its own", () => {
    const check = (seq: number, id: string, input: Record<string, unknown>) => ({
      seq,
      kind: "tool_call",
      data: { toolUseId: id, name: "permission_prompt", input, detail: "npm test", command: "npm test" },
      createdAt: at(seq),
    });
    const answer = (seq: number, id: string, content: unknown) => ({
      seq,
      kind: "tool_result",
      data: { toolUseId: id, name: "permission_prompt", content: JSON.stringify(content) },
      createdAt: at(seq),
    });
    const npmTest = { tool_name: "Bash", input: { command: "npm test" } };
    const work = workFromSteps([
      check(1, "t1", npmTest),
      answer(2, "t1", { behavior: "allow" }),
      check(3, "t2", npmTest),
      answer(4, "t2", { behavior: "deny", message: "Too many commands to approve in a row.", code: "tooMany" }),
      check(5, "t3", npmTest),
      answer(6, "t3", { behavior: "allow" }),
      check(7, "t4", npmTest),
      answer(8, "t4", { status: "pending", request_id: "req-9" }),
      // Claude Code asking twice while the card is open: the same request.
      check(9, "t5", npmTest),
      answer(10, "t5", { status: "pending", request_id: "req-9" }),
      check(11, "t6", { request_id: "req-9" }),
      answer(12, "t6", { behavior: "deny", message: "A person said no.", code: "person" }),
    ]);
    expect(lines(toolItemsSaved(work)).map((l) => [l.count, l.state, l.refusal ?? null])).toEqual([
      [1, "done", null],
      [1, "fail", "tooMany"],
      [1, "done", null],
      [1, "fail", "person"],
      [1, "fail", "person"],
    ]);
  });

  test("live: a person's answer ends the line that waited for it; waiting on a person is not silence", () => {
    let s = applyChannelEvent(emptyStreams, start("a", "permission_prompt", { detail: "npm publish" }), 1000);
    s = applyChannelEvent(s, { ...end("a"), held: true, requestId: "req-1" } as Ev, 1000);
    const run = () => s.runs.r1 as LiveRun;
    expect(lines(toolItemsLive(run().work ?? []))[0]?.state).toBe("stop");
    expect(isQuiet(run(), 1000 + QUIET_AFTER_MS)).toBe(false);
    // Another run's answer, or one for no line it knows, changes nothing.
    expect(applyChannelEvent(s, { ...end(), requestId: "req-7", failed: true } as Ev, 2000)).toBe(s);
    s = applyChannelEvent(s, { ...end(), requestId: "req-1", failed: true, refusal: "person" } as Ev, 2000);
    const [line] = lines(toolItemsLive(run().work ?? []));
    expect(line).toMatchObject({ state: "fail", refusal: "person" });
    expect(isQuiet(run(), 2000 + QUIET_AFTER_MS)).toBe(true);
    // A yes reads as done.
    let yes = applyChannelEvent(emptyStreams, start("b", "permission_prompt", { detail: "npm version" }));
    yes = applyChannelEvent(yes, { ...end("b"), held: true, requestId: "req-2" } as Ev);
    yes = applyChannelEvent(yes, { ...end(), requestId: "req-2" } as Ev);
    expect(lines(toolItemsLive(yes.runs.r1?.work ?? []))[0]?.state).toBe("done");
  });

  test("a refusal's reason under its line: only a known one, in the person's words, never the text it came with", () => {
    expect(toolWhy(t, { why: "A person said no.", refusal: "person" })).toStartWith("chat.work.refusal.person");
    expect(toolWhy(t, { why: BECAUSE, refusal: null })).toBeNull();
    expect(toolWhy(t, { why: null })).toBeNull();
    // A code with no words: still nothing but the line's own phrase ("Recusado: …").
    const none = ((key: string, o?: { defaultValue?: string }) =>
      key.endsWith(".new") ? (o?.defaultValue ?? "") : key) as TFunction;
    expect(toolWhy(none, { why: BECAUSE, refusal: "new" })).toBeNull();
    // A personal workspace (ADR 0159): its own words where it has them ("This was already done"), else the team's.
    const known = (key: string) => key === "chat.work.refusal.teamPersonal" || !key.endsWith("Personal");
    const own = ((key: string, o?: { defaultValue?: string }) =>
      known(key) ? key : (o?.defaultValue ?? "")) as TFunction;
    expect(toolWhy(own, { refusal: "team" }, true)).toBe("chat.work.refusal.teamPersonal");
    expect(toolWhy(own, { refusal: "person" }, true)).toBe("chat.work.refusal.person");
    expect(toolWhy(own, { refusal: "team" })).toBe("chat.work.refusal.team");
  });

  test("a failed tool's own error never shows under its line: the gateway's refusals say why in words", () => {
    const call = (seq: number, id: string, name: string) => ({
      seq,
      kind: "tool_call",
      data: { toolUseId: id, name, input: {} },
      createdAt: at(seq),
    });
    const result = (seq: number, id: string, content: string, data?: Record<string, unknown>) => ({
      seq,
      kind: "tool_result",
      data: { toolUseId: id, isError: true, content, ...(data ? { data } : {}) },
      createdAt: at(seq),
    });
    const work = workFromSteps([
      call(1, "a", "send_dm"),
      result(2, "a", "Failed: That person isn't in this conversation"),
      call(3, "b", "github_merge_pull_request"),
      result(4, "b", "Not allowed: this agent lacks the scope github:pr.merge", { refusal: "noAccess" }),
      call(5, "c", "create_routine"),
      result(6, "c", "This is a routine's background work: …", { code: "tool.not_allowed", refusal: "policy" }),
    ]);
    const saved = lines(toolItemsSaved(work));
    expect(saved.map((l) => [l.state, toolWhy(t, l)])).toEqual([
      ["fail", null],
      ["fail", 'chat.work.refusal.noAccess|{"defaultValue":""}'],
      ["fail", 'chat.work.refusal.policy|{"defaultValue":""}'],
    ]);
    // What the tool said stays in its open view.
    expect(saved[0]?.result).toBe("Failed: That person isn't in this conversation");
    // Live: the end carries the gateway's word.
    let s = applyChannelEvent(emptyStreams, start("d", "github_merge_pull_request"));
    s = applyChannelEvent(s, { ...end("d", true), refusal: "noAccess" } as Ev);
    expect(lines(toolItemsLive(s.runs.r1?.work ?? [])).map((l) => [l.state, l.refusal])).toEqual([
      ["fail", "noAccess"],
    ]);
  });

  test("the task's card: each step in words, the same words in a row once, with the last one's time", () => {
    const steps = [
      { tool: "permission_prompt", detail: "Run the tests", at: at(1) },
      { tool: "permission_prompt", detail: "Run the tests", at: at(2) },
      { tool: "create_issue", detail: "Corrigir login", at: at(3) },
      { tool: "permission_prompt", detail: "Run the tests", at: at(4) },
      { tool: "permission_prompt", detail: "Run the tests", at: at(5), outcome: "refused" as const },
      { tool: "permission_prompt", detail: "npm publish", at: at(6), outcome: "waiting" as const },
    ];
    const ran = 'chat.work.step.runningCommand|{"app":"Run the tests","tool":"permission prompt"}';
    expect(foldSteps(steps, (s) => stepPhrase(t, s)).map((l) => [l.text, l.count, l.step.at])).toEqual([
      [ran, 2, at(2)],
      ['chat.work.step.creatingIssue|{"app":"","tool":"create issue"} · Corrigir login', 1, at(3)],
      [ran, 1, at(4)],
      // Refused, or still waiting on a person: never "Rodou".
      ['chat.work.refused|{"app":"Run the tests"}', 1, at(5)],
      ['Chat.activity.runningCommand|{"app":"npm publish"}', 1, at(6)],
    ]);
  });
});

describe("each call's service and its logo", () => {
  const catalog = [
    { id: "github", label: "GitHub", iconUrl: "/connectors/github.svg", brandColor: null },
    { id: "drive", label: "Google Drive", iconUrl: "/connectors/googledrive.svg", brandColor: "#4285F4" },
    { id: "linear", label: "Linear", iconUrl: "/connectors/linear.svg", brandColor: "#5E6AD2" },
  ];
  const icon =
    "/api/app/connector-icons/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000f1/0123456789abcdef.png";
  const lines = (items: ToolItem[]) => items.flatMap((i) => (i.kind === "call" ? [i.line] : []));
  const logo = (a: Activity | undefined) => (a ? callLogo(a, catalog) : null);

  test("a mailbox goes by its maker: Gmail's mark, 'Consultou o Gmail', which mailbox and the verb in grey", () => {
    const [gmail, sales, other, old] = lines(
      toolItemsLive([
        call("1", "mail_wnogueira_search", { connector: "Email", service: "gmail" }),
        { kind: "steer", messageId: "m1" },
        call("2", "mail_vendas_search", { connector: "Email", service: "gmail" }),
        { kind: "steer", messageId: "m2" },
        call("3", "mail_contato_read", { connector: "Email", service: "custom" }),
        { kind: "steer", messageId: "m3" },
        call("4", "mail_ana_read", { connector: "Email" }),
      ]),
    );
    expect(gmail).toMatchObject({ kind: "consulting", app: "Gmail", service: "gmail", hint: "wnogueira search" });
    // Two mailboxes of one maker: the same phrase and logo, the grey words say which.
    expect(sales).toMatchObject({ app: "Gmail", service: "gmail", hint: "vendas search" });
    expect(gmail && toolPhrase(t, { ...gmail, state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"Gmail","tool":"mail wnogueira search"}',
    );
    expect(logo(gmail)).toMatchObject({
      kind: "service",
      def: { iconUrl: "/connectors/gmail.svg", brandColor: "#EA4335" },
      image: null,
      label: "Gmail",
    });
    // A mailbox on a server of its own, or one recorded before calls named their service: our envelope, "Email".
    expect(other).toMatchObject({ app: "Email", service: "mail", hint: "contato read" });
    expect(old).toMatchObject({ app: "Email", service: "mail", hint: "ana read" });
    expect(logo(other)).toEqual({ kind: "mail" });
    // A maker's name keeps its own capitals; a connector's slug gets one.
    const [icloud] = lines(toolItemsLive([call("5", "mail_contato_read", { connector: "Email", service: "icloud" })]));
    expect(icloud && toolPhrase(t, { ...icloud, state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"iCloud","tool":"mail contato read"}',
    );
    expect(toolPhrase(t, { kind: "consulting", app: "himetrica", tool: "himetrica_get", state: "done" })).toBe(
      'chat.work.step.consulting|{"app":"Himetrica","tool":"himetrica get"}',
    );
  });

  test("a connector shows its mark, a server by address its own icon, a database Postgres's; ours keep our icons", () => {
    const [github, custom, db, issue, ownDrive, googleDrive] = lines(
      toolItemsLive([
        call("1", "github_search_issues", { connector: "GitHub", service: "github" }),
        call("2", "acme_tools_find_orders", { connector: "Acme Tools", serviceIcon: icon }),
        call("3", "pg_analytics_list_tables", { connector: "Analytics", service: "postgres" }),
        call("4", "create_issue"),
        call("5", "read_artifact"),
        call("6", "drive_search_files", { connector: "Google Drive", service: "drive" }),
      ]),
    );
    expect(logo(github)).toMatchObject({
      kind: "service",
      def: { iconUrl: "/connectors/github.svg" },
    });
    expect(github?.hint).toBe("search issues");
    // A server's whole label leaves its tools' names, however many words it has.
    expect(custom?.hint).toBe("find orders");
    expect(logo(custom)).toEqual({
      kind: "service",
      def: null,
      image: icon,
      label: "Acme Tools",
    });
    expect(db).toMatchObject({ app: "Analytics", hint: "list tables" });
    expect(logo(db)).toMatchObject({
      kind: "service",
      def: { iconUrl: "/brands/postgresql.svg" },
    });
    expect(logo(issue)).toEqual({ kind: "own" });
    // Our Drive is ours; Google Drive's calls read the same but show its mark.
    expect([ownDrive?.kind, googleDrive?.kind]).toEqual(["readingDrive", "readingDrive"]);
    expect(logo(ownDrive)).toEqual({ kind: "own" });
    expect(logo(googleDrive)).toMatchObject({
      def: { iconUrl: "/connectors/googledrive.svg" },
    });
  });

  test("another account of a service: its mark by the account's name, its tools' hint without the number", () => {
    // A run saved before calls carried their service: only the account's name says which service it is.
    const [second] = lines(toolItemsLive([call("1", "linear_2_list_issues", { connector: "Linear (Acme) 2" })]));
    expect(logo(second)).toMatchObject({ kind: "service", def: { iconUrl: "/connectors/linear.svg" } });
    expect(second?.hint).toBe("list issues");
  });

  test("the block's logos: each service once, in order of first use, four at most", () => {
    const items = toolItemsLive([
      call("1", "mail_wnogueira_search", { connector: "Email", service: "gmail" }),
      call("2", "github_get_pr", { connector: "GitHub", service: "github" }),
      call("3", "mail_wnogueira_read", { connector: "Email", service: "gmail" }),
      call("4", "create_issue"),
      call("5", "read_artifact"),
      call("6", "linear_list_issues", { connector: "Linear", service: "linear" }),
    ]);
    expect(toolApps(items)).toEqual([
      { kind: "consulting", app: "Gmail", service: "gmail" },
      { kind: "consulting", app: "GitHub", service: "github" },
      { kind: "creatingIssue" },
      { kind: "readingDrive" },
    ]);
  });

  test("a saved run reads its app and service from the step; the reply's meta gives the closed block's logos", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, s)).toISOString();
    const work = workFromSteps([
      {
        seq: 1,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "mail_wnogueira_search", input: {}, connector: "Email", service: "gmail" },
        createdAt: at(0),
      },
      { seq: 2, kind: "tool_result", data: { toolUseId: "t1", content: "2 messages" }, createdAt: at(1) },
      {
        seq: 3,
        kind: "tool_call",
        data: { toolUseId: "t2", name: "open_pull_request", input: {}, connector: "GitHub", service: "github" },
        createdAt: at(2),
      },
      { seq: 4, kind: "tool_result", data: { toolUseId: "t2", content: "opened" }, createdAt: at(3) },
    ]);
    expect(work.steps.map((s) => [s.app, s.service, s.hint])).toEqual([
      ["Gmail", "gmail", "wnogueira search"],
      // One of ours ("Abriu um pull request"): no app in its phrase, GitHub's logo by its service.
      [undefined, "github", null],
    ]);
    const meta = workMeta({
      work: {
        steps: 3,
        durationMs: 4000,
        calls: [
          { name: "mail_wnogueira_search", connector: "Email", service: "gmail" },
          { name: "create_issue" },
          { tool: "no name" },
          { name: "github_get_pr", connector: "GitHub", service: "github" },
        ],
      },
    });
    expect(meta?.calls.map((c) => c.name)).toEqual(["mail_wnogueira_search", "create_issue", "github_get_pr"]);
    expect(workApps(meta?.calls ?? [])).toEqual([
      { kind: "consulting", app: "Gmail", service: "gmail" },
      { kind: "creatingIssue" },
      { kind: "consulting", app: "GitHub", service: "github" },
    ]);
    // Older replies carry only the count: no logos until the steps load.
    expect(workMeta({ work: { steps: 2 } })?.calls).toEqual([]);
  });

  test("the bar names the mailbox's maker too", () => {
    const run = {
      runId: "r1",
      agentId: "theo",
      channelId: "c1",
      threadId: "m1",
      status: "thinking" as const,
      tool: "mail_wnogueira_search",
      connector: "Email",
      service: "gmail",
    };
    expect(
      barEntries(
        [run],
        [],
        () => "Theo",
        () => undefined,
      )[0]?.activity,
    ).toEqual({
      kind: "consulting",
      app: "Gmail",
      service: "gmail",
    });
  });
});

describe("one call is its own line (no 'Usou 1 ferramenta' to open)", () => {
  test("one call stands alone; two or more keep the block, a folded line counting each", () => {
    expect(oneCall(toolItemsLive([call("1", "create_routine")]))).toBe(true);
    // The messages it read are not calls.
    expect(oneCall(toolItemsLive([call("1", "create_routine"), { kind: "steer", messageId: "m9" }]))).toBe(true);
    // Two browser steps fold into one line ("×2"): still two calls, the block.
    expect(oneCall(toolItemsLive([call("1", "browser_open"), call("2", "browser_click")]))).toBe(false);
    expect(oneCall(toolItemsLive([call("1", "create_routine"), call("2", "create_issue")]))).toBe(false);
    expect(oneCall([])).toBe(false);
  });

  test("a saved reply's lone call is its line from meta.work: what it did, its own time, whether it failed", () => {
    const line = savedOneLine({ work: { steps: 1, calls: [{ name: "create_routine" }], durationMs: 4000, ms: 870 } });
    expect(line).toMatchObject({ kind: "creatingRoutine", tool: "create_routine", state: "done", ms: 870, count: 1 });
    expect(line && toolPhrase(t, line)).toBe('chat.work.step.creatingRoutine|{"app":"","tool":"create routine"}');
    const failed = savedOneLine({
      work: { steps: 1, calls: [{ name: "create_routine" }], durationMs: 4000, ms: 300, failed: true },
    });
    expect(failed?.state).toBe("fail");
    // A connector's call keeps its app and its own tool's name in grey.
    expect(
      savedOneLine({
        work: { steps: 1, calls: [{ name: "github_search_issues", connector: "GitHub" }], durationMs: 900, ms: 640 },
      }),
    ).toMatchObject({ kind: "consulting", app: "GitHub", hint: "search issues", ms: 640 });
    // Saved before the server wrote the call's own time: the reply's, as the block said it.
    expect(savedOneLine({ work: { steps: 1, calls: [{ name: "create_issue" }], durationMs: 4000 } })?.ms).toBe(4000);
    // Two calls, none, or no work at all: no lone line.
    expect(savedOneLine({ work: { steps: 2, calls: [{ name: "create_issue" }], durationMs: 900 } })).toBeNull();
    expect(savedOneLine({ work: { steps: 0, calls: [], durationMs: 900 } })).toBeNull();
    expect(savedOneLine({})).toBeNull();
    expect(savedOneLine(undefined)).toBeNull();
  });
});

describe("a lone quick read that only fed the answer shows no card", () => {
  test("one quick internal read, done: quiet; anything else keeps its card", () => {
    for (const tool of ["get_my_usage", "get_context", "search_context", "find_agent", "mcp__agentes__get_my_usage"])
      expect([tool, quietWork(toolItemsLive([call("1", tool, { ms: 33 })]))]).toEqual([tool, true]);
    // A teammate looked up is ours, not an app called "find".
    expect(toolActivity("find_agent").kind).toBe("findingAgent");
    const kept: [string, LiveWork[]][] = [
      ["two reads", [call("1", "get_my_usage"), call("2", "search_context")]],
      ["the same read twice", [call("1", "get_my_usage"), call("2", "get_my_usage")]],
      ["it changed something", [call("1", "create_routine")]],
      ["an app", [call("1", "github_list_issues")]],
      ["the browser", [call("1", "browser_navigate")]],
      ["another server's read", [call("1", "mcp__linear__list_issues")]],
      ["another server's calendar", [call("1", "mcp__gcal__list_events")]],
      ["a file on the PC", [call("1", "read_file")]],
      ["it failed", [call("1", "get_my_usage", { failed: true })]],
      ["still running", [call("1", "get_my_usage", { running: true })]],
      ["a long step", [call("1", "get_my_usage", { ms: 5000 })]],
    ];
    for (const [why, work] of kept) expect([why, quietWork(toolItemsLive(work))]).toEqual([why, false]);
    // Lookups aren't steps: a usage check after looking the tool up is still a lone read.
    expect(quietWork(toolItemsLive([call("1", "find_tools"), call("2", "get_my_usage")]))).toBe(true);
  });

  test("saved: the run's lone call is quiet by meta.work; calls another card shows are left out of the count", () => {
    const usage = savedOneLine({ work: { steps: 1, calls: [{ name: "get_my_usage" }], durationMs: 2000, ms: 33 } });
    expect(usage && quietLine(usage)).toBe(true);
    const browser = (name: string) => name.startsWith("browser_");
    // Three browser steps on their card: nothing left for the block.
    const trail = { steps: 3, calls: [{ name: "browser_navigate" }], durationMs: 43_000 };
    expect(workSteps(trail, browser)).toBe(0);
    expect(workSteps(trail)).toBe(3);
    // With each call's count: the browser's steps come off; the one left is its own line, time unknown.
    const mixed = {
      work: {
        steps: 4,
        calls: [
          { name: "browser_navigate", n: 3 },
          { name: "create_issue", n: 1 },
        ],
        durationMs: 9000,
      },
    };
    expect(workSteps(mixed.work, browser)).toBe(1);
    expect(savedOneLine(mixed, browser)).toMatchObject({ kind: "creatingIssue", ms: null, state: "done" });
    expect(savedOneLine(mixed)).toBeNull();
    // Beside the browser's steps, the call left carries its own time and outcome: a quick usage check is quiet, as
    // in the kept view (which leaves the browser's calls to their card); without its time it may have failed.
    const beside = (extra: Record<string, unknown>) => ({
      work: {
        steps: 4,
        calls: [
          { name: "browser_navigate", n: 3 },
          { name: "get_my_usage", n: 1, ...extra },
        ],
        durationMs: 43_000,
      },
    });
    const quick = savedOneLine(beside({ ms: 33 }), browser);
    expect(quick && quietLine(quick)).toBe(true);
    expect(savedOneLine(beside({ ms: 33, failed: true }), browser)?.state).toBe("fail");
    expect(savedOneLine(beside({}), browser)?.ms).toBeNull();
    // Saved before the calls carried their count: the total stays.
    expect(workSteps({ ...mixed.work, calls: [{ name: "browser_navigate" }, { name: "create_issue" }] }, browser)).toBe(
      4,
    );
  });
});

describe("a call a rule approved for good", () => {
  test("its line says so quietly, who approved it and whether only reads, and never folds into another", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 2, 10, 0, s)).toISOString();
    const sql = (id: string, seq: number, autoApproved?: unknown) => [
      {
        seq,
        kind: "tool_call" as const,
        data: { toolUseId: id, name: "db_execute_sql", input: {} },
        createdAt: at(seq),
      },
      {
        seq: seq + 1,
        kind: "tool_result" as const,
        data: { toolUseId: id, content: "[]", ...(autoApproved ? { autoApproved } : {}) },
        createdAt: at(seq + 1),
      },
    ];
    const work = workFromSteps([
      ...sql("t1", 1),
      ...sql("t2", 3, { by: "Ana", reads: true }),
      ...sql("t3", 5, { by: null, reads: false }),
    ]);
    const hints = toolItemsSaved(work).flatMap((i) => (i.kind === "call" ? [toolLineHint(t, i.line)] : []));
    expect(hints.slice(1)).toEqual(['chat.work.autoApprovedReads|{"name":"Ana"}', "chat.work.autoApprovedNobody"]);
    expect(hints).toHaveLength(3);
  });

  test("live too: the line says it as soon as the call ends, and stays its own line", () => {
    const sql = { connector: "Banco" };
    const s = [
      start("a", "banco_execute_sql", sql),
      end("a"),
      start("b", "banco_execute_sql", sql),
      { ...end("b"), autoApproved: { by: "Ana", reads: true } } as Ev,
    ].reduce(applyChannelEvent, emptyStreams);
    const hints = toolItemsLive(s.runs.r1?.work ?? []).flatMap((i) =>
      i.kind === "call" ? [toolLineHint(t, i.line)] : [],
    );
    expect(hints).toHaveLength(2);
    expect(hints[1]).toBe('chat.work.autoApprovedReads|{"name":"Ana"}');
  });
});
