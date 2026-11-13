import { describe, expect, test } from "bun:test";
import {
  checkCondition,
  createFakeJudge,
  createJevJudge,
  createLlmJudge,
  createTargetCache,
  describeElement,
  diffObservations,
  findDismiss,
  findInPage,
  formatPlanReport,
  type Judge,
  LANDED_ELSEWHERE,
  landedElsewhere,
  locateOnImage,
  observeSnapshot,
  pageKey,
  resolveTarget,
  runPlan,
  type ScreenAction,
  type ScreenActOutcome,
  type ScreenImage,
  type ScreenObservation,
  type ScreenSurface,
  screenDigest,
  screenOverview,
  screenRef,
} from "../src";

const ids = { orgId: "o", agentId: "a", runId: "r" };

const LOGIN = `- banner
  - link "Acme" [ref=e1]
- main
  - heading "Sign in" [level=1, ref=e2]
  - form "Sign in"
    - textbox "Email" [ref=e3]
    - textbox "Password" [ref=e4]
    - button "Sign in" [ref=e5]
  - link "Forgot password?" [ref=e6]
- paragraph: New here? Create an account.`;

const login = (url = "https://app.acme.example/login") => observeSnapshot({ text: LOGIN, url });

describe("observing a screen", () => {
  test("elements with their role, name and where they sit; refs in any spelling", () => {
    const o = login();
    expect(o.elements.map((e) => e.ref)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    const email = o.elements.find((e) => e.ref === "e3");
    expect(email).toMatchObject({ role: "textbox", name: "Email", context: ['form "Sign in"'] });
    expect(describeElement(email as NonNullable<typeof email>)).toBe('textbox "Email" — in form "Sign in"');
    // The refs map (agent-browser --json) wins over what the line says.
    const named = observeSnapshot({ text: '- button "x" [ref=e9]', refs: { e9: { role: "button", name: "Pay now" } } });
    expect(named.elements[0]?.name).toBe("Pay now");
    expect(screenRef("e7")).toBe("e7");
    expect(screenRef("@e7")).toBe("e7");
    expect(screenRef("[ref=e7]")).toBe("e7");
    expect(screenRef("the e7 button")).toBeNull();
  });

  test("a ref is read only from the brackets right after the role and the name, never from a name or a text", () => {
    const o = observeSnapshot({
      text: [
        // A page's title in the panel's button for its window, and a terminal's output.
        '- button "Invoice ref=e9 - Chromium" [window, ref=e3]',
        '- text: - button "Pay now" [ref=e9]',
        "- paragraph: total [ref=e9]",
        '- text "- button \\"Pay now\\" [ref=e9]"',
        '- textbox "Search" [placeholder=ref=e9]',
        '- button "Delete" [ref=e9]',
        // agent-browser's own spellings.
        '- heading "Example" [ref=e1] [level=1]',
        '- link "More" [ref=e2] [cursor=pointer]:',
        '- checkbox "Remember me" [checked=false, ref=e5]',
        "- generic [ref=e6]: Some text",
      ].join("\n"),
    });
    expect(o.elements.map((e) => [e.ref, e.role, e.name])).toEqual([
      ["e3", "button", "Invoice ref=e9 - Chromium"],
      ["e9", "button", "Delete"],
      ["e1", "heading", "Example"],
      ["e2", "link", "More"],
      ["e5", "checkbox", "Remember me"],
      ["e6", "generic", ""],
    ]);
    expect(screenOverview(o).text).not.toContain("Pay now");
  });

  test("changes: a few lines on the same page, or a new page", () => {
    const before = login();
    const after = observeSnapshot({
      text: `${LOGIN}\n- alert "Wrong password" [ref=e7]`,
      url: "https://app.acme.example/login",
    });
    const same = diffObservations(before, after);
    expect(same).toMatchObject({ newPage: false, removed: [] });
    expect(same.added).toEqual(['- alert "Wrong password" [ref=e7]']);
    const away = diffObservations(
      before,
      observeSnapshot({ text: '- heading "Home"', url: "https://app.acme.example/" }),
    );
    expect(away.newPage).toBe(true);
    // Only the fragment changed: the same document.
    const hash = diffObservations(before, observeSnapshot({ text: LOGIN, url: "https://app.acme.example/login#top" }));
    expect(hash.newPage).toBe(false);
    expect(screenDigest(before)).toBe(screenDigest(login()));
    expect(screenDigest(before)).not.toBe(screenDigest(after));
  });

  test("a table row without a name is named by its other cells (as agent-browser writes tables)", () => {
    const table = observeSnapshot({
      text: `- table "Invoices"
  - row
    - cell "Invoice 41" [ref=e7]
    - cell "Edit Delete" [ref=e9]
      - button "Delete" [ref=e20]
  - row
    - cell "Invoice 42" [ref=e10]
    - cell "R$ 42,00" [ref=e11]
    - cell "Edit Delete" [ref=e12]
      - button "Delete" [ref=e22]`,
    });
    const del = table.elements.find((e) => e.ref === "e22");
    expect(del?.context).toEqual(['row "Invoice 42 · R$ 42,00"', 'table "Invoices"']);
    expect(describeElement(del as NonNullable<typeof del>)).toBe(
      'button "Delete" — in row "Invoice 42 · R$ 42,00" › table "Invoices"',
    );
  });

  test("the overview keeps what can be acted on, headings and alerts; paragraphs out", () => {
    const { text, omitted } = screenOverview(login());
    expect(text).toContain('- button "Sign in" [ref=e5]');
    expect(text).toContain('- heading "Sign in"');
    expect(text).not.toContain("New here?");
    expect(omitted).toBe(0);
    expect(pageKey("https://shop.example/orders/12345/items?x=1")).toBe("shop.example/orders/:id/items");
  });
});

describe("targets in words", () => {
  test("a number or an exact name needs no judge", async () => {
    const judge = createFakeJudge();
    const o = login();
    const base = { judge, ...ids, observation: o, scope: "a" };
    expect(await resolveTarget({ ...base, target: "e5", use: "click" })).toMatchObject({
      found: true,
      ref: "e5",
      via: "ref",
    });
    expect(await resolveTarget({ ...base, target: "Email", use: "fill" })).toMatchObject({ ref: "e3", via: "exact" });
    expect(await resolveTarget({ ...base, target: 'button "Sign in"', use: "click" })).toMatchObject({ ref: "e5" });
    expect(judge.calls).toHaveLength(0);
  });

  test("the judge picks among fitting elements; a sure pick is remembered for the site", async () => {
    const judge = createFakeJudge((kind, id, _state, q) => {
      if (kind !== "screen_target") return undefined;
      if (id === "present") return 0.9;
      if (id === "costly") return 0;
      // Only fields are offered for a fill.
      expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual(["e3", "e4", "none"]);
      return { choice: "e4", probabilities: { e4: 0.88, e3: 0.1 } };
    });
    const cache = createTargetCache();
    const base = { judge, ...ids, observation: login(), scope: "a", cache };
    const r = await resolveTarget({ ...base, target: "where the secret goes", use: "fill" });
    expect(r).toMatchObject({ found: true, ref: "e4", via: "judge" });
    // Same words, same page (another id in the path): remembered.
    const again = await resolveTarget({
      ...base,
      observation: login("https://app.acme.example/login"),
      target: "Where the  secret goes",
      use: "fill",
    });
    expect(again).toMatchObject({ ref: "e4", via: "cache" });
    expect(judge.calls).toHaveLength(1);
    // Another agent's memory is its own.
    expect(await resolveTarget({ ...base, scope: "b", target: "where the secret goes", use: "fill" })).toMatchObject({
      via: "judge",
    });
  });

  test("unsure and absent: the closest candidates come back instead of a guess", async () => {
    const split = createFakeJudge((kind, id) =>
      kind !== "screen_target"
        ? undefined
        : id === "present"
          ? 0.7
          : { choice: "e5", probabilities: { e5: 0.45, e6: 0.4 } },
    );
    const base = { ...ids, observation: login(), scope: "a" };
    const unsure = await resolveTarget({ ...base, judge: split, target: "continue", use: "click" });
    expect(unsure).toMatchObject({ found: false, reason: "unsure" });
    expect(unsure.found ? [] : unsure.candidates.map((c) => c.ref)).toEqual(["e5", "e6"]);
    const none = createFakeJudge((kind, id) =>
      kind !== "screen_target" ? undefined : id === "present" ? 0.05 : { choice: "none", probabilities: { none: 0.9 } },
    );
    expect(await resolveTarget({ ...base, judge: none, target: "the checkout button", use: "click" })).toMatchObject({
      found: false,
      reason: "absent",
    });
  });

  test("two elements that read the same are never picked by the judge, however sure it is", async () => {
    const page = observeSnapshot({ text: '- list\n  - button "Remove" [ref=e1]\n  - button "Remove" [ref=e2]' });
    const sure = createFakeJudge((kind, id) =>
      kind !== "screen_target" ? undefined : id === "present" ? 0.95 : { choice: "e2", probabilities: { e2: 0.97 } },
    );
    const r = await resolveTarget({
      judge: sure,
      ...ids,
      observation: page,
      scope: "a",
      target: "the second one",
      use: "click",
    });
    expect(r).toMatchObject({ found: false, reason: "unsure" });
    expect(r.found ? [] : r.candidates.map((c) => c.ref)).toEqual(["e2", "e1"]);
  });

  test("an element the judge finds costly (delete, pay, send) needs a surer pick; else the agent picks by number", async () => {
    const page = observeSnapshot({
      text: '- row "Invoice 42"\n  - button "Edit" [ref=e1]\n  - button "Delete" [ref=e2]',
    });
    const at = (p: number) =>
      createFakeJudge((kind, id) =>
        kind !== "screen_target"
          ? undefined
          : id === "present" || id === "costly"
            ? 0.95
            : { choice: "e2", probabilities: { e2: p, e1: 1 - p } },
      );
    const base = {
      ...ids,
      observation: page,
      scope: "a",
      target: "the trash one in invoice 42",
      use: "click" as const,
    };
    expect(await resolveTarget({ ...base, judge: at(0.8) })).toMatchObject({ found: false, reason: "unsure" });
    expect(await resolveTarget({ ...base, judge: at(0.95) })).toMatchObject({ found: true, ref: "e2" });
    // An ordinary element at the same 0.8 is taken.
    const edit = createFakeJudge((kind, id) =>
      kind !== "screen_target"
        ? undefined
        : id === "present"
          ? 0.95
          : { choice: "e1", probabilities: { e1: 0.8, e2: 0.2 } },
    );
    expect(await resolveTarget({ ...base, judge: edit, target: "the pencil one" })).toMatchObject({ ref: "e1" });
  });

  test("the judge is asked whether the target can't be undone; no answer counts as costly", async () => {
    const page = observeSnapshot({
      text: '- dialog "Delete project Acme?"\n  - button "Yes" [ref=e1]\n  - button "Keep it" [ref=e2]',
    });
    const judge = createFakeJudge((kind, id) =>
      kind !== "screen_target"
        ? undefined
        : id === "present"
          ? 0.95
          : { choice: "e1", probabilities: { e1: 0.8, e2: 0.2 } },
    );
    const silent: Judge = {
      name: "silent",
      async ask(request) {
        const { costly: _costly, ...answers } = await judge.ask(request);
        return answers;
      },
    };
    const base = { ...ids, observation: page, scope: "a", target: "confirm it", use: "click" as const };
    expect(await resolveTarget({ ...base, judge })).toMatchObject({ found: true, ref: "e1" });
    expect(judge.calls[0]?.questions.costly).toMatchObject({ type: "noul" });
    expect(await resolveTarget({ ...base, judge: silent })).toMatchObject({ found: false, reason: "unsure" });
  });

  test("the site memory finds a target again only in the same place, and never a costly one", async () => {
    const rows = (first: string, second: string, action = "Edit") =>
      observeSnapshot({
        text: `- table "Invoices"\n  - row\n    - cell "${first}" [ref=e1]\n    - cell "${action}" [ref=e2]\n      - button "${action}" [ref=e3]\n  - row\n    - cell "${second}" [ref=e4]\n    - cell "${action}" [ref=e5]\n      - button "${action}" [ref=e6]`,
        url: "https://app.acme.example/invoices",
      });
    const judge = createFakeJudge((kind, id, state) =>
      kind !== "screen_target"
        ? undefined
        : id === "present"
          ? 0.95
          : id === "costly"
            ? Number(String(state.target).startsWith("delete"))
            : { choice: "e6", probabilities: { e6: 0.95 } },
    );
    const cache = createTargetCache();
    const base = { judge, ...ids, scope: "a", cache, target: "edit invoice 42", use: "click" as const };
    expect(await resolveTarget({ ...base, observation: rows("Invoice 41", "Invoice 42") })).toMatchObject({
      ref: "e6",
      via: "judge",
    });
    // Same page, same words: found again from the memory, in the row it was in.
    expect(await resolveTarget({ ...base, observation: rows("Invoice 41", "Invoice 42") })).toMatchObject({
      ref: "e6",
      via: "cache",
    });
    // Invoice 42 moved to the first row: the memory finds its Edit there, with no judge.
    const asked = judge.calls.length;
    expect(await resolveTarget({ ...base, observation: rows("Invoice 42", "Invoice 43") })).toMatchObject({
      ref: "e3",
      via: "cache",
    });
    expect(judge.calls).toHaveLength(asked);
    // Invoice 42 is gone: the remembered place isn't on the page, so the judge decides again.
    await resolveTarget({ ...base, observation: rows("Invoice 43", "Invoice 44") });
    expect(judge.calls).toHaveLength(asked + 1);
    // A Delete is never taken from memory (its place is kept only in part): the judge decides each time.
    const remove = { ...base, target: "delete invoice 42", observation: rows("Invoice 41", "Invoice 42", "Delete") };
    expect(await resolveTarget(remove)).toMatchObject({ ref: "e6", via: "judge" });
    expect(await resolveTarget(remove)).toMatchObject({ ref: "e6", via: "judge" });
    expect(judge.calls).toHaveLength(asked + 3);
  });

  test("without a calibrated judge, the closest by their words come back instead of a pick", async () => {
    const llm = createLlmJudge({
      gateway: {
        complete: async () => {
          throw new Error("not called");
        },
      } as never,
      resolveModel: async () => "m",
    });
    const r = await resolveTarget({
      judge: llm,
      ...ids,
      observation: login(),
      scope: "a",
      target: "the sign in control",
      use: "click",
    });
    expect(r).toMatchObject({ found: false, reason: "unjudged" });
    expect(r.found ? [] : r.candidates.map((c) => c.ref)).toContain("e5");
    // The agent is told what works without one: a number or the exact name.
    const plan = await runPlan({ judge: llm, ...ids, surface: fakeSurface(PAGES, "login"), scope: "a" }, [
      { do: "click", target: "the sign in control" },
    ]);
    expect(formatPlanReport(plan).summary).toStartWith(
      'Couldn\'t click "the sign in control": couldn\'t match "the sign in control" to an element by its words here: give its number or its exact name',
    );
    // And nothing is dismissed on its word.
    const banner = observeSnapshot({ text: '- dialog "Cookies"\n  - button "Reject optional" [ref=e2]' });
    expect(await findDismiss({ judge: llm, ...ids, observation: banner, covering: "covered" })).toBeNull();
  });

  test("on an image: Jev's box lands on a marked element's ref, or on a point", async () => {
    const image: ScreenImage = {
      data: "AAAA",
      width: 1280,
      height: 800,
      viewport: { width: 1280, height: 800 },
      marks: [{ ref: "e9", number: 9, role: "button", box: { x: 1180, y: 20, width: 40, height: 40 } }],
    };
    const judge = createFakeJudge((kind, id) => {
      if (kind !== "screen_locate") return undefined;
      return id === "present" ? 0.9 : { box: { top: 0.03, bottom: 0.07, left: 0.925, right: 0.95 }, confidence: 0.8 };
    });
    const hit = await locateOnImage({ judge, ...ids, target: "the gear icon", image });
    expect(hit).toMatchObject({ found: true, ref: "e9" });
    // The image goes as an asset; the placeholder stands in the state.
    const asked = judge.calls[0];
    const key = Object.keys(asked?.images ?? {})[0] as string;
    expect(asked?.state.screenshot).toBe(key);
    expect(asked?.images?.[key]).toEqual({ data: "AAAA", format: "jpeg" });
    const point = await locateOnImage({ judge, ...ids, target: "the gear icon", image: { ...image, marks: [] } });
    expect(point).toMatchObject({ found: true, ref: null, x: 1200, y: 40 });
    const huge = createFakeJudge((kind, id) =>
      kind !== "screen_locate" ? undefined : id === "present" ? 0.9 : { box: { top: 0, bottom: 1, left: 0, right: 1 } },
    );
    expect(await locateOnImage({ judge: huge, ...ids, target: "x", image })).toMatchObject({ found: false });
  });
});

describe("checks", () => {
  test("a condition: true, false or unsure by its probability", async () => {
    const at = (p: number) => createFakeJudge((kind) => (kind === "screen_check" ? p : undefined));
    const o = login();
    expect(await checkCondition({ judge: at(0.9), ...ids, condition: "signed in", observation: o })).toMatchObject({
      met: true,
    });
    expect((await checkCondition({ judge: at(0.1), ...ids, condition: "signed in", observation: o })).met).toBe(false);
    expect((await checkCondition({ judge: at(0.5), ...ids, condition: "signed in", observation: o })).met).toBeNull();
  });

  test("find: the lines that answer, with a little context; nothing when the page doesn't", async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `- paragraph: line ${i + 1}`);
    lines[300] = '- row "Total R$ 42,00"';
    const page = observeSnapshot({ text: lines.join("\n"), url: "https://shop.example/cart" });
    const judge = createFakeJudge((kind, id, _state, q) => {
      if (kind !== "screen_find") return undefined;
      if (id === "answers") return 0.95;
      const keys = Object.keys((q as { criteria: Record<string, string> }).criteria);
      return keys.includes("L301") ? { choice: "L301", probabilities: { L301: 0.9 } } : "none";
    });
    const found = await findInPage({ judge, ...ids, question: "the total", observation: page });
    // Windows of 200 lines, each its own request (Jev reads 32k tokens per question), all asked at once.
    expect(judge.calls.map((c) => Object.keys(c.questions))).toEqual([
      ["answers", "where"],
      ["answers", "where"],
      ["answers", "where"],
    ]);
    expect(found.answered).toBe("yes");
    expect(found.searched).toBeUndefined();
    expect(found.text.split("\n")).toEqual([
      "- paragraph: line 298",
      "- paragraph: line 299",
      "- paragraph: line 300",
      '- row "Total R$ 42,00"',
      "- paragraph: line 302",
      "- paragraph: line 303",
      "- paragraph: line 304",
    ]);
    const no = createFakeJudge((kind, id) => (kind === "screen_find" && id === "answers" ? 0.02 : "none"));
    expect((await findInPage({ judge: no, ...ids, question: "the total", observation: page })).answered).toBe("no");
  });

  test("find on a long page: every request small enough for Jev; past 12 windows, those with the question's words", async () => {
    const lines = Array.from(
      { length: 3000 },
      (_, i) => `- paragraph: line ${i + 1} ${"of a long report ".repeat(i % 7)}`,
    );
    lines[2900] = '- row "Total R$ 42,00"';
    const page = observeSnapshot({ text: lines.join("\n"), url: "https://shop.example/report" });
    const judge = createFakeJudge((kind, id, _state, q) => {
      if (kind !== "screen_find") return undefined;
      if (id === "answers") return 0.95;
      const keys = Object.keys((q as { criteria: Record<string, string> }).criteria);
      return keys.includes("L2901") ? { choice: "L2901", probabilities: { L2901: 0.9 } } : "none";
    });
    const found = await findInPage({ judge, ...ids, question: "the total", observation: page });
    expect(judge.calls).toHaveLength(12);
    // Jev reads at most 32k tokens per question: no request comes near it (a token is ~3 characters or more).
    for (const c of judge.calls) {
      expect(JSON.stringify(c.state).length + JSON.stringify(c.questions).length).toBeLessThan(45_000);
    }
    expect(found).toMatchObject({ answered: "yes", searched: { of: 3000 } });
    expect(found.searched?.lines).toBeLessThan(3000);
    expect(found.text).toContain('- row "Total R$ 42,00"');
  });

  test("a dismiss is taken only when the judge is sure", async () => {
    const banner = observeSnapshot({
      text: '- dialog "Cookies"\n  - button "Accept all" [ref=e1]\n  - button "Reject optional" [ref=e2]',
    });
    const sure = createFakeJudge(() => ({ choice: "e2", probabilities: { e2: 0.85 } }));
    expect((await findDismiss({ judge: sure, ...ids, observation: banner, covering: "covered by <div#c>" }))?.ref).toBe(
      "e2",
    );
    const vague = createFakeJudge(() => ({ choice: "e1", probabilities: { e1: 0.5 } }));
    expect(await findDismiss({ judge: vague, ...ids, observation: banner, covering: "covered" })).toBeNull();
  });
});

/** A screen that is a list of pages: each action may move it to the next one. */
/** `redirects`: a page an `open` of another one lands on instead (a deep link the site doesn't take). */
function fakeSurface(pages: Record<string, string>, start: string, redirects: Record<string, string> = {}) {
  let at = start;
  const actions: ScreenAction[] = [];
  let failNext: string | null = null;
  const look = (): ScreenObservation =>
    observeSnapshot({ text: pages[at] ?? "", url: `https://app.acme.example/${at}` });
  const surface: ScreenSurface & { actions: ScreenAction[]; go(page: string): void; fail(error: string): void } = {
    actions,
    go(page) {
      at = page;
    },
    fail(error) {
      failNext = error;
    },
    async observe() {
      return look();
    },
    async perform(action): Promise<ScreenActOutcome> {
      actions.push(action);
      if (failNext) {
        const error = failNext;
        failNext = null;
        return { ok: false, error };
      }
      if (action.kind === "open") {
        const asked = new URL(action.url).pathname.slice(1);
        at = redirects[asked] ?? asked;
      }
      if (action.kind === "click" && "ref" in action.at && action.at.ref === "e5") at = "home";
      return { ok: true, observation: look() };
    },
  };
  return surface;
}

const PAGES = {
  login: LOGIN,
  home: '- heading "Dashboard" [level=1]\n- link "Orders" [ref=e20]\n- button "Export" [ref=e21]',
};

describe("plans", () => {
  test("a sign-in across two pages in one call; each target found on the page as it is then", async () => {
    const judge = createFakeJudge((kind, _id, state) => {
      if (kind !== "screen_check") return undefined;
      return String((state.screen as { text: string }).text).includes("Dashboard") ? 0.95 : 0.05;
    });
    const surface = fakeSurface(PAGES, "blank");
    const report = await runPlan({ judge, ...ids, surface, scope: "a" }, [
      { do: "open", url: "https://app.acme.example/login" },
      { do: "fill", target: "Email", text: "ana@acme.example" },
      { do: "click", target: "Sign in", expect: "the dashboard shows" },
      { do: "click", target: "Export" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(surface.actions.map((a) => a.kind)).toEqual(["open", "fill", "click", "click"]);
    expect(surface.actions[3]).toMatchObject({ at: { ref: "e21" } });
    expect(report.after?.url).toBe("https://app.acme.example/home");
    const text = formatPlanReport(report);
    expect(text.summary).toContain("Done: all 4 steps.");
    expect(text.summary).toContain('Clicked button (e5) (✓ "the dashboard shows").');
    expect(text.screen).toContain("Now at https://app.acme.example/home");
  });

  test("a deep link the site sends elsewhere says so, and to use the site's own way there", async () => {
    const judge = createFakeJudge(() => undefined);
    const surface = fakeSurface(PAGES, "blank", { "app/signing": "home" });
    const sent = await runPlan({ judge, ...ids, surface, scope: "a" }, [
      { do: "open", url: "https://app.acme.example/app/signing" },
    ]);
    expect(sent.steps[0]?.landedElsewhere).toBe(true);
    expect(formatPlanReport(sent).summary).toBe(`Opened https://app.acme.example/app/signing. ${LANDED_ELSEWHERE}`);
    const direct = await runPlan({ judge, ...ids, surface, scope: "a" }, [
      { do: "open", url: "https://www.app.acme.example/home/?tab=1#top" },
    ]);
    expect(formatPlanReport(direct).summary).toBe("Opened https://www.app.acme.example/home/?tab=1#top.");
    expect(landedElsewhere("https://acme.example", "https://acme.example/pt-BR/")).toBe(false);
    expect(landedElsewhere("https://acme.example/a", "https://login.acme.example/a")).toBe(true);
    expect(landedElsewhere("https://acme.example/docs/a", "https://acme.example/en/docs/a")).toBe(false);
  });

  test("stops at an expectation the page doesn't show, and the rest never runs", async () => {
    const judge = createFakeJudge((kind) => (kind === "screen_check" ? 0.05 : undefined));
    const surface = fakeSurface(PAGES, "login");
    let t = 0;
    const now = () => {
      t += 500;
      return t;
    };
    const report = await runPlan({ judge, ...ids, surface, scope: "a", now }, [
      { do: "click", target: "Sign in", expect: "an error says the password is wrong" },
      { do: "click", target: "Export" },
    ]);
    expect(report.stopped).toMatchObject({ index: 0 });
    expect(report.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    // The click, then short pauses while it waited for the page to show it; no second click.
    expect(surface.actions.filter((a) => a.kind !== "pause").map((a) => a.kind)).toEqual(["click"]);
    // The page never changed while it waited: the judge was asked once.
    expect(judge.calls.filter((c) => c.kind === "screen_check")).toHaveLength(1);
    expect(formatPlanReport(report).summary).toStartWith(
      'Stopped after step 1 of 2 (click "Sign in"): Clicked button (e5), but the page doesn\'t show "an error says the password is wrong". It was done',
    );
  });

  test("an expectation that becomes true a moment later (a submit that navigates late) still passes", async () => {
    const judge = createFakeJudge((kind, _id, state) =>
      kind === "screen_check" && String((state.screen as { text: string }).text).includes("Dashboard") ? 0.9 : 0.05,
    );
    const surface = fakeSurface(PAGES, "login");
    let clicked = false;
    let looksAfter = 0;
    const observe = surface.observe.bind(surface);
    surface.observe = async () => {
      // The first look after the click still sees the login page; the next one, the dashboard.
      if (clicked && ++looksAfter === 2) surface.go("home");
      return observe();
    };
    const original = surface.perform.bind(surface);
    surface.perform = async (action, options) => {
      const out = await original(action, options);
      if (action.kind !== "click") return out;
      // The click itself leaves the page where it was: the navigation comes later.
      clicked = true;
      surface.go("login");
      return { ok: true, observation: null };
    };
    let t = 0;
    const now = () => {
      t += 100;
      return t;
    };
    const report = await runPlan({ judge, ...ids, surface, scope: "a", now }, [
      { do: "click", target: "Sign in", expect: "the dashboard shows" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(report.steps[0]?.expected).toMatchObject({ met: true });
  });

  test("an expectation outlives a look that fails once while the page navigates", async () => {
    const judge = createFakeJudge((kind, _id, state) =>
      kind === "screen_check" && String((state.screen as { text: string }).text).includes("Dashboard") ? 0.9 : 0.05,
    );
    const surface = fakeSurface(PAGES, "login");
    let clicked = false;
    let looksAfter = 0;
    const observe = surface.observe.bind(surface);
    surface.observe = async () => {
      if (clicked) {
        // After the click: the login page still, then a look in the middle of the navigation, then the dashboard.
        looksAfter++;
        if (looksAfter === 2) throw new Error("Execution context was destroyed");
        if (looksAfter > 2) surface.go("home");
      }
      return observe();
    };
    const original = surface.perform.bind(surface);
    surface.perform = async (action, options) => {
      const out = await original(action, options);
      if (action.kind !== "click") return out;
      clicked = true;
      surface.go("login");
      return { ok: true, observation: null };
    };
    let t = 0;
    const now = () => {
      t += 100;
      return t;
    };
    const report = await runPlan({ judge, ...ids, surface, scope: "a", now }, [
      { do: "click", target: "Sign in", expect: "the dashboard shows" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(report.steps[0]?.expected).toMatchObject({ met: true });
    expect(looksAfter).toBe(3);
  });

  test("a banner in the way is closed once, then the step goes through", async () => {
    const judge = createFakeJudge((kind) =>
      kind === "screen_dismiss" ? { choice: "e30", probabilities: { e30: 0.9 } } : undefined,
    );
    const surface = fakeSurface(
      { ...PAGES, login: `${LOGIN}\n- dialog "Cookies"\n  - button "Reject optional" [ref=e30]` },
      "login",
    );
    surface.fail("covered by <div#consent>");
    const report = await runPlan({ judge, ...ids, surface, scope: "a" }, [{ do: "click", target: "Sign in" }]);
    expect(report.stopped).toBeUndefined();
    expect(surface.actions.map((a) => ("at" in a && "ref" in a.at ? a.at.ref : a.kind))).toEqual(["e5", "e30", "e5"]);
    expect(report.steps[0]?.dismissed).toBe("button (e30)");
  });

  test("a wait in words: the judge looks only when the page changed", async () => {
    let checks = 0;
    let ticks = 0;
    const judge = createFakeJudge((kind) => {
      if (kind !== "screen_check") return undefined;
      checks++;
      return ticks >= 3 ? 0.9 : 0.1;
    });
    const surface = fakeSurface({ ...PAGES, done: '- status "Export ready"' }, "home");
    const original = surface.perform.bind(surface);
    surface.perform = async (action, options) => {
      if (action.kind === "pause") {
        ticks++;
        // The page stays the same for two ticks, then the export finishes.
        if (ticks === 3) surface.go("done");
      }
      return original(action, options);
    };
    let t = 0;
    const report = await runPlan(
      {
        judge,
        ...ids,
        surface,
        scope: "a",
        now: () => {
          t += 100;
          return t;
        },
      },
      [{ do: "wait", until: "the export is ready", seconds: 60 }],
    );
    expect(report.stopped).toBeUndefined();
    expect(ticks).toBe(3);
    // First look, then only the change: two judgments for four looks.
    expect(checks).toBe(2);
  });

  test("a read step at the end brings what the page says, with the page text kept apart", async () => {
    const judge = createFakeJudge((kind, id, _state, q) => {
      if (kind !== "screen_find") return undefined;
      if (id === "answers") return 0.9;
      const keys = Object.keys((q as { criteria: Record<string, string> }).criteria);
      const line = keys.find((k) => (q as { criteria: Record<string, string> }).criteria[k]?.includes("Export"));
      return line ? { choice: line, probabilities: { [line]: 0.9 } } : "none";
    });
    const surface = fakeSurface(PAGES, "home");
    const report = await runPlan({ judge, ...ids, surface, scope: "a" }, [
      { do: "click", target: "Export" },
      { do: "read", find: "the export button" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(report.steps[1]?.found).toMatchObject({ question: "the export button", answered: "yes" });
    const text = formatPlanReport(report);
    expect(text.summary).toContain('2. Read "the export button".');
    // What it found is page text: it goes with the screen (the caller wraps it as untrusted), not the summary.
    expect(text.screen).toContain('Where the page answers "the export button":');
    expect(text.screen).toContain('- button "Export" [ref=e21]');
    expect(text.summary).not.toContain("[ref=e21]");
  });

  test("a person taking over stops the plan before the next step", async () => {
    const surface = fakeSurface(PAGES, "login");
    let steps = 0;
    // The person takes the browser after the first step.
    const hold = async () => (steps++ >= 1 ? "a person took over" : null);
    const report = await runPlan({ judge: createFakeJudge(), ...ids, surface, scope: "a", hold }, [
      { do: "fill", target: "Email", text: "x" },
      { do: "click", target: "Sign in" },
    ]);
    expect(report.steps.map((s) => s.status)).toEqual(["done", "failed"]);
    expect(report.stopped?.reason).toBe("a person took over");
    expect(surface.actions.map((a) => a.kind)).toEqual(["fill"]);
  });

  test("a target the text lacks is looked for on the screen image", async () => {
    const judge = createFakeJudge((kind, id) => {
      if (kind === "screen_target") return id === "present" ? 0.05 : { choice: "none", probabilities: { none: 0.9 } };
      if (kind === "screen_locate")
        return id === "present" ? 0.9 : { box: { top: 0.1, bottom: 0.2, left: 0.1, right: 0.2 } };
      return undefined;
    });
    const surface = fakeSurface(PAGES, "home");
    const withImage = {
      ...surface,
      capture: async (): Promise<ScreenImage> => ({
        data: "AAAA",
        width: 1000,
        height: 500,
        viewport: { width: 1000, height: 500 },
      }),
    };
    const report = await runPlan({ judge, ...ids, surface: withImage, scope: "a", vision: true }, [
      { do: "click", target: "the chart's settings gear" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(surface.actions[0]).toMatchObject({ kind: "click", at: { x: 150, y: 75 } });
    expect(report.steps[0]?.via).toBe("image");
    // Without vision, the agent hears it isn't on the page.
    const blind = await runPlan({ judge, ...ids, surface: withImage, scope: "a" }, [
      { do: "click", target: "the chart's settings gear" },
    ]);
    expect(blind.stopped?.reason).toContain("couldn't find");
  });

  test("a target missing from a look kept from before is looked for again on the page as it is now", async () => {
    const judge = createFakeJudge();
    const surface = fakeSurface(PAGES, "home");
    // What the agent saw a few seconds ago: the login page (the dashboard has loaded since).
    const report = await runPlan({ judge, ...ids, surface, scope: "a", last: login() }, [
      { do: "click", target: "Export" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(surface.actions[0]).toMatchObject({ kind: "click", at: { ref: "e21" } });
  });

  test("a wait outlives a look that fails once", async () => {
    const judge = createFakeJudge((kind) => (kind === "screen_check" ? 0.9 : undefined));
    const surface = fakeSurface(PAGES, "home");
    let looks = 0;
    const observe = surface.observe.bind(surface);
    surface.observe = async () => {
      if (++looks === 1) throw new Error("the page is loading");
      return observe();
    };
    let t = 0;
    const now = () => {
      t += 100;
      return t;
    };
    const report = await runPlan({ judge, ...ids, surface, scope: "a", now }, [
      { do: "wait", until: "the dashboard shows", seconds: 10 },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(looks).toBe(2);
  });
});

describe("the judge with images", () => {
  test("Jev: the vision model, the images header, assets and boxes", async () => {
    const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const judge = createJevJudge({
      key: "tk",
      gateway: { recordExternalUsage: async () => null },
      visionModel: "jev-vision-test",
      fetch: (async (_url: string, init?: RequestInit) => {
        sent.push({
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({
          model: "jev-vision-test",
          answers: { where: { type: "box", box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 }, confidence: 0.7 } },
          usage: { input_tokens: 900 },
        });
      }) as unknown as typeof fetch,
    });
    const answers = await judge.ask({
      ...ids,
      kind: "screen_locate",
      state: { screenshot: "img1" },
      images: { img1: { data: "QUJD", format: "jpeg" } },
      questions: { where: { type: "box", instructions: "Box the button in `screenshot`." } },
    });
    expect(answers.where).toEqual({ box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 }, confidence: 0.7 });
    expect(sent[0]?.headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
    expect(sent[0]?.body).toMatchObject({
      model: "jev-vision-test",
      assets: { img1: { data_base64: "QUJD", format: "jpeg" } },
    });
    // Text only: the usual model, no header, no assets.
    await judge
      .ask({
        ...ids,
        kind: "x",
        state: {},
        questions: { q: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } },
      })
      .catch(() => null);
    expect(sent[1]?.headers["TypeSafe-Danger-Zone-Images"]).toBeUndefined();
    expect(sent[1]?.body.model).toBe("jev-latest");
    expect(sent[1]?.body.assets).toBeUndefined();
  });

  test("the cheap model refuses images and boxes (the caller falls back to text)", async () => {
    const judge = createLlmJudge({
      gateway: {
        complete: async () => {
          throw new Error("not called");
        },
      } as never,
      resolveModel: async () => "m",
    });
    await expect(
      judge.ask({ ...ids, kind: "screen_locate", state: {}, questions: { where: { type: "box", instructions: "x" } } }),
    ).rejects.toThrow("images and boxes need Jev");
  });
});
