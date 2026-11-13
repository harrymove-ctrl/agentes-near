/**
 * Browser microbenchmarks (ADR 0054) against a real Chrome and the real Jev: what one action
 * costs on the runner (action, settling, look), targets in words (time and whether the right
 * element was found), Jev's Box on a screenshot, checks, `find`, and a whole sign-in plan on
 * protocol 12 against 17.
 *
 *   bun run eval:browser:micro
 *
 * Needs TYPESAFE_API_KEY and `agent-browser` with its Chrome (`AGENT_BROWSER_BIN`).
 */
import { browserSurface, LOOK, observationOf } from "../../src/browser/surface";
import {
  checkCondition,
  createTargetCache,
  findInPage,
  locateOnImage,
  resolveTarget,
  runPlan,
  type ScreenObservation,
  type TargetUse,
} from "../../src/screen";
import { capture, cli, cliLink, jevJudge, newJudgeLog, newMeter, p50, servePages, sum, writeReport } from "./harness";

const site = servePages();
const ids = { orgId: "eval", agentId: "eval-agent", runId: "eval-run" };
const report: Record<string, unknown> = {};

async function look(): Promise<ScreenObservation> {
  const r = await cli([LOOK.command, ...LOOK.args]);
  const o = observationOf(r.data);
  if (!o) throw new Error(`no snapshot: ${r.error ?? "empty"}`);
  return o;
}

try {
  const cold = await cli(["open", `${site.url}/login.html`]);
  if (!cold.success) throw new Error(`open failed: ${cold.error}`);
  report.coldOpenMs = Math.round(cold.ms);

  // ── One action on the runner: alone, and with its settling and the look after it ──
  await cli(["open", `${site.url}/dashboard.html`]);
  const board = await look();
  const exportRef = board.elements.find((e) => e.role === "button" && e.name === "Export")?.ref;
  if (!exportRef) throw new Error("no Export button on the dashboard");
  const snapshots: number[] = [];
  const clicks: number[] = [];
  const settled: number[] = [];
  for (let i = 0; i < 5; i++) snapshots.push((await cli([LOOK.command, ...LOOK.args])).ms);
  for (let i = 0; i < 5; i++) clicks.push((await cli(["click", `@${exportRef}`])).ms);
  const surface = browserSurface({ link: cliLink({ rttMs: 0, fast: true, meter: newMeter() }) });
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const r = await surface.perform({ kind: "click", at: { ref: exportRef } }, { settle: true });
    if (!r.ok) throw new Error(r.error);
    settled.push(performance.now() - t0);
  }
  report.runner = {
    lookMs: Math.round(p50(snapshots)),
    clickMs: Math.round(p50(clicks)),
    clickSettledAndLookedMs: Math.round(p50(settled)),
  };

  // ── Targets in words with the real Jev, then again from the site memory ──
  const log = newJudgeLog();
  const judge = jevJudge(log);
  await cli(["open", `${site.url}/login.html`]);
  const login = await look();
  const gearRef = board.elements.find((e) => e.role === "button" && e.name === "")?.ref ?? null;
  const is = (role: string, name: string) => (o: ScreenObservation, ref: string) =>
    o.elements.some((e) => e.ref === ref && e.role === role && e.name === name);
  const inRow = (name: string, row: string) => (o: ScreenObservation, ref: string) =>
    o.elements.some(
      (e) => e.ref === ref && e.role === "button" && e.name === name && e.context.join(" ").includes(row),
    );
  const cases: {
    page: ScreenObservation;
    words: string;
    use: TargetUse;
    right: (o: ScreenObservation, ref: string) => boolean;
  }[] = [
    { page: login, words: "the email field", use: "fill", right: is("textbox", "Email") },
    { page: login, words: "where the password goes", use: "fill", right: is("textbox", "Password") },
    { page: login, words: "the button that logs me in", use: "click", right: is("button", "Sign in") },
    { page: login, words: "the link to recover my password", use: "click", right: is("link", "Forgot password?") },
    { page: login, words: "refuse the optional cookies", use: "click", right: is("button", "Reject optional") },
    { page: board, words: "Edit in the row for invoice 43", use: "click", right: inRow("Edit", "Invoice 43") },
    { page: board, words: "delete invoice 42", use: "click", right: inRow("Delete", "Invoice 42") },
    { page: board, words: "the Orders section", use: "click", right: is("link", "Orders") },
    { page: board, words: "download the invoices as a file", use: "click", right: is("button", "Export") },
  ];
  const cache = createTargetCache();
  const targets: Record<string, unknown>[] = [];
  for (const pass of ["first", "again"]) {
    for (const c of cases) {
      const t0 = performance.now();
      const r = await resolveTarget({
        judge,
        ...ids,
        target: c.words,
        use: c.use,
        observation: c.page,
        cache,
        scope: "eval",
      });
      targets.push({
        pass,
        words: c.words,
        ms: Math.round(performance.now() - t0),
        found: r.found ? `${r.via} ${r.ref}` : r.reason,
        right: r.found ? c.right(c.page, r.ref) : false,
      });
    }
  }
  const first = targets.filter((t) => t.pass === "first");
  report.targets = {
    right: `${first.filter((t) => t.right).length}/${first.length}`,
    p50Ms: p50(first.map((t) => t.ms as number)),
    againMs: p50(targets.filter((t) => t.pass === "again").map((t) => t.ms as number)),
    cases: targets,
  };

  // ── Jev's Box on a screenshot: the gear icon without a name ──
  await cli(["open", `${site.url}/dashboard.html`]);
  const shot = await capture();
  if (shot) {
    const t0 = performance.now();
    const spot = await locateOnImage({
      judge,
      ...ids,
      target: "the gear-shaped settings icon",
      image: shot,
      url: board.url,
    });
    report.vision = {
      ms: Math.round(performance.now() - t0),
      image: `${shot.width}×${shot.height}`,
      spot,
      right: spot.found && spot.ref === gearRef,
    };
  }

  // ── Checks and find ──
  const checks: Record<string, unknown>[] = [];
  for (const [o, condition, want] of [
    [board, "Ana is signed in and sees her dashboard", true],
    [login, "the user is signed in", false],
  ] as const) {
    const t0 = performance.now();
    const r = await checkCondition({ judge, ...ids, condition, observation: o });
    checks.push({ condition, ms: Math.round(performance.now() - t0), met: r.met, right: r.met === want });
  }
  report.checks = checks;
  await cli(["open", `${site.url}/cart.html`]);
  const cart = await look();
  {
    const t0 = performance.now();
    const found = await findInPage({ judge, ...ids, question: "the order total", observation: cart });
    report.find = {
      pageChars: cart.lines.join("\n").length,
      answerChars: found.text.length,
      ms: Math.round(performance.now() - t0),
      right: found.text.includes("Total R$ 42,00"),
    };
  }

  // ── A whole sign-in: protocol 12 against 17, with a 100 ms server↔runner trip ──
  const plans: Record<string, unknown> = {};
  for (const fast of [false, true]) {
    await cli(["open", "about:blank"]);
    const meter = newMeter();
    const planLog = newJudgeLog();
    const t0 = performance.now();
    const r = await runPlan(
      {
        judge: jevJudge(planLog),
        ...ids,
        surface: browserSurface({ link: cliLink({ rttMs: 100, fast, meter, vision: fast }) }),
        scope: `plan-${fast}`,
        cache: createTargetCache(),
        vision: fast,
      },
      [
        { do: "open", url: `${site.url}/login.html` },
        { do: "fill", target: "Email", text: "ana@acme.example" },
        { do: "fill", target: "where the password goes", text: "test-1234" },
        { do: "click", target: "the Sign in button", expect: "the dashboard shows" },
        { do: "click", target: "Export" },
        { do: "wait", until: "the export is ready", seconds: 30 },
      ],
    );
    plans[fast ? "protocol 17" : "protocol 12"] = {
      ms: Math.round(performance.now() - t0),
      stopped: r.stopped?.reason ?? null,
      steps: r.steps.map((s) => ({ do: s.step.do, status: s.status, via: s.via, ms: s.ms })),
      roundTrips: meter.roundTrips,
      judgeCalls: planLog.calls.length,
      judgeMs: sum(planLog.calls.map((c) => c.ms)),
    };
  }
  report.plans = plans;
  report.judge = {
    calls: log.calls.length,
    p50Ms: p50(log.calls.map((c) => c.ms)),
    maxMs: Math.max(0, ...log.calls.map((c) => c.ms)),
    failed: log.calls.filter((c) => !c.ok).length,
    inputTokens: sum(log.usage.map((u) => u.inputTokens)),
    costUsd: sum(log.usage.map((u) => u.costNanoUsd)) / 1e9,
  };
} finally {
  await cli(["close"]).catch(() => undefined);
  site.stop();
}
console.log(JSON.stringify(report, null, 2));
console.log(`report: ${await writeReport("browser-micro", report)}`);
