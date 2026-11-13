import { describe, expect, test } from "bun:test";
import {
  createFakeJudge,
  describeElement,
  formatPlanReport,
  observeSnapshot,
  resolveTarget,
  runPlan,
  type ScreenAction,
  screenOverview,
} from "../src";
import { browserSurface } from "../src/browser/surface";
import { acted, fakeScreen, THUNAR, ticking } from "./screen-fixtures";

const ids = { orgId: "o", agentId: "a", runId: "r" };

describe("desktop verbs", () => {
  test("each one reaches the surface as its action, found by name with no judge", async () => {
    const judge = createFakeJudge();
    const surface = fakeScreen(THUNAR);
    const report = await runPlan({ judge, ...ids, surface, scope: "a" }, [
      { do: "open", app: "Files" },
      { do: "open", path: "Documents/report.pdf" },
      { do: "double_click", target: "Documents" },
      { do: "right_click", target: "report.pdf" },
      { do: "focus", target: "Terminal - agent@desktop: ~" },
      { do: "type", target: "Location", text: "/tmp\n" },
      { do: "scroll", target: "Files", direction: "down", pixels: 300 },
      { do: "scroll", direction: "up" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(acted(surface.actions)).toEqual([
      { kind: "launch", app: "Files" },
      { kind: "open_file", path: "Documents/report.pdf" },
      { kind: "double_click", at: { ref: "e32" } },
      { kind: "right_click", at: { ref: "e31" } },
      { kind: "focus", at: { ref: "e3" } },
      { kind: "type", text: "/tmp\n", at: { ref: "e29" } },
      { kind: "scroll", direction: "down", pixels: 300, at: { ref: "e30" } },
      { kind: "scroll", direction: "up", pixels: 800 },
    ]);
    expect(judge.calls).toHaveLength(0);
    const summary = formatPlanReport(report).summary;
    expect(summary).toContain("1. Opened Files.");
    expect(summary).toContain("3. Double-clicked listitem (e32).");
    expect(summary).toContain("5. Focused button (e3).");
    expect(summary).toContain("6. Typed into textbox (e29).");
    expect(summary).toContain("7. Scrolled down over list (e30).");
  });

  test("a drag finds both ends on the screen as it is, by name or by the judge", async () => {
    const judge = createFakeJudge((kind, id, state) => {
      if (kind !== "screen_target") return undefined;
      if (id === "present") return 0.9;
      return state.target === "the PDF" ? { choice: "e31", probabilities: { e31: 0.9 } } : "none";
    });
    const surface = fakeScreen(THUNAR);
    const report = await runPlan({ judge, ...ids, surface, scope: "a" }, [
      { do: "drag", target: "the PDF", to: "Documents" },
    ]);
    expect(report.stopped).toBeUndefined();
    expect(acted(surface.actions)).toEqual([{ kind: "drag", from: { ref: "e31" }, to: { ref: "e32" } }]);
    // The judge only for the end without an exact name.
    expect(judge.calls).toHaveLength(1);
    expect(report.steps[0]).toMatchObject({ via: "judge", element: { ref: "e31" } });
    expect(formatPlanReport(report).summary).toBe("Dragged listitem (e31) to listitem (e32).");
    const nowhere = await runPlan({ judge, ...ids, surface, scope: "a" }, [{ do: "drag", target: "the PDF" }]);
    expect(nowhere.stopped?.reason).toBe("say where to drop it (`to`)");
  });

  test("type needs no target, only the text", async () => {
    const surface = fakeScreen(THUNAR);
    const report = await runPlan({ judge: createFakeJudge(), ...ids, surface, scope: "a" }, [
      { do: "type", text: "ls -la\n" },
      { do: "type" },
    ]);
    expect(acted(surface.actions)).toEqual([{ kind: "type", text: "ls -la\n" }]);
    expect(report.stopped).toMatchObject({ index: 1, reason: "say what to type (`text`)" });
    expect(formatPlanReport(report).summary).toContain("1. Typed.");
  });

  test("focus is offered only windows and the panel's window buttons, never a name dressed as one", async () => {
    const judge = createFakeJudge((kind, id) =>
      kind !== "screen_target" ? undefined : id === "present" ? 0.9 : { choice: "e3", probabilities: { e3: 0.9 } },
    );
    const surface = fakeScreen(THUNAR);
    const report = await runPlan({ judge, ...ids, surface, scope: "a" }, [{ do: "focus", target: "the terminal" }]);
    expect(report.stopped).toBeUndefined();
    const which = judge.calls[0]?.questions.which as { criteria: Record<string, string> } | undefined;
    const offered = Object.keys(which?.criteria ?? {});
    expect(offered).toEqual(["e2", "e3", "e20", "none"]);
    expect(acted(surface.actions)).toEqual([{ kind: "focus", at: { ref: "e3" } }]);
    // No window on the screen: nothing else stands in for one, and the judge isn't asked.
    const bare = observeSnapshot({ text: '- toolbar "Panel"\n  - button "Applications" [ref=e1]' });
    const none = createFakeJudge();
    expect(
      await resolveTarget({ judge: none, ...ids, observation: bare, scope: "a", target: "the editor", use: "window" }),
    ).toMatchObject({ found: false, reason: "absent", candidates: [] });
    expect(none.calls).toHaveLength(0);
  });

  test("the browser refuses what only a desktop does, and sends nothing", async () => {
    const sent: unknown[] = [];
    const surface = browserSurface({
      link: {
        act: async () => ({ ok: true, data: {} }),
        batch: async (commands) => {
          sent.push(...commands);
          return [];
        },
        capture: async () => null,
      },
    });
    const desktopOnly: ScreenAction[] = [
      { kind: "launch", app: "Files" },
      { kind: "open_file", path: "a.txt" },
      { kind: "focus", at: { ref: "e1" } },
      { kind: "double_click", at: { ref: "e1" } },
      { kind: "right_click", at: { x: 10, y: 10 } },
      { kind: "drag", from: { ref: "e1" }, to: { ref: "e2" } },
      { kind: "type", text: "x" },
    ];
    for (const action of desktopOnly) {
      const out = await surface.perform(action, { settle: true });
      expect(out).toMatchObject({ ok: false });
      expect(out.ok ? "" : out.error).toContain("is not in the browser");
    }
    expect(sent).toHaveLength(0);
  });
});

describe("a desktop's plan and report", () => {
  test("say screen where the browser says page, and name the window", async () => {
    const judge = createFakeJudge((kind) => (kind === "screen_check" ? 0.05 : undefined));
    const surface = fakeScreen(THUNAR);
    const before = await surface.observe();
    const report = await runPlan({ judge, ...ids, surface, scope: "a", before, now: ticking() }, [
      { do: "click", target: "Back", expect: "the home folder shows" },
    ]);
    const text = formatPlanReport(report);
    expect(report.kind).toBe("desktop");
    expect(text.summary).toStartWith(
      "Clicked button (e25), but the screen doesn't show \"the home folder shows\". It was done: don't do it again; look at what the screen shows.",
    );
    expect(text.screen).toStartWith("Now in desktop://thunar/main — Files - Thunar\nNothing changed on the screen.");
    const lost = await runPlan({ judge, ...ids, surface, scope: "a" }, [
      { do: "click", target: "the Trash icon" },
      { do: "read" },
    ]);
    expect(formatPlanReport(lost).summary).toStartWith(
      'Stopped at step 1 of 2 (click "the Trash icon"): couldn\'t find "the Trash icon" on the screen',
    );
    const read = await runPlan({ judge, ...ids, surface, scope: "a" }, [{ do: "read" }]);
    expect(formatPlanReport(read).screen).toContain("New screen: what you can act on");
    // An app without a name or a file: the desktop asks for one, the browser for a web address.
    const open = await runPlan({ judge, ...ids, surface, scope: "a" }, [{ do: "open" }]);
    expect(open.stopped?.reason).toBe("say which app (`app`) or file (`path`)");
  });

  test("a dialog in the way stops the plan when dismissing is off, and is named; nothing is closed", async () => {
    const judge = createFakeJudge((kind) =>
      kind === "screen_dismiss" ? { choice: "e40", probabilities: { e40: 0.95 } } : undefined,
    );
    const surface = fakeScreen(THUNAR);
    // The dialog comes up as the click is sent, after the look the target was found on.
    const dialog = `${THUNAR}\n- dialog "Save changes to report.odt?" [ref=e39]\n  - button "Don't Save" [ref=e40]\n  - button "Save" [ref=e41]`;
    const perform = surface.perform.bind(surface);
    surface.perform = (action, o) => {
      surface.show(dialog);
      return perform(action, o);
    };
    surface.fail("covered by window e39");
    const report = await runPlan({ judge, ...ids, surface, scope: "a", dismiss: false }, [
      { do: "click", target: "Back" },
      { do: "click", target: "Documents" },
    ]);
    expect(report.stopped).toMatchObject({ index: 0 });
    expect(report.stopped?.reason).toContain("covered by window e39");
    expect(acted(surface.actions)).toEqual([{ kind: "click", at: { ref: "e25" } }]);
    expect(judge.calls.filter((c) => c.kind === "screen_dismiss")).toHaveLength(0);
    const formatted = formatPlanReport(report);
    expect(formatted.summary).toContain("deal with what covers it first");
    // The screen as it is then goes with the report (the dialog's title only there, as screen text).
    expect(formatted.summary).not.toContain("Save changes");
    expect(formatted.screen).toContain('dialog "Save changes to report.odt?" [ref=e39]');
  });

  test("an element in a window reads with its window, and a window without a number stays in the overview", () => {
    const o = observeSnapshot({
      text: `- window "Report.odt - Writer" [ref=e1]
  - dialog "Save As" [ref=e2]
    - button "Save" [ref=e3]
- window "agentes.chat - Chromium" [agent browser: use browser_do]`,
      url: "desktop://libreoffice-writer/dialog",
      title: "Save As",
    });
    const save = o.elements.find((e) => e.ref === "e3");
    expect(describeElement(save as NonNullable<typeof save>)).toBe(
      'button "Save" — in dialog "Save As" › window "Report.odt - Writer"',
    );
    expect(screenOverview(o).text).toContain('- window "agentes.chat - Chromium" [agent browser: use browser_do]');
    expect(o.title).toBe("Save As");
    // A browser's look has no title.
    expect("title" in observeSnapshot({ text: '- button "Go" [ref=e1]', url: "https://a.example/" })).toBe(false);
  });
});

describe("costly buttons on a desktop, in any language", () => {
  // "Don't Save" and "Move to Trash" in Portuguese, English, Japanese and German: the judge says it can't be undone.
  const names = [
    "Não salvar",
    "Don't Save",
    "保存しない",
    "Nicht speichern",
    "Mover para a lixeira",
    "Move to Trash",
    "ゴミ箱に入れる",
    "In den Papierkorb legen",
  ];
  const pick = (p: number, costly = 0) =>
    createFakeJudge((kind, id) =>
      kind !== "screen_target"
        ? undefined
        : id === "present"
          ? 0.95
          : id === "costly"
            ? costly
            : { choice: "e1", probabilities: { e1: p, e2: 1 - p } },
    );
  for (const name of names) {
    test(`"${name}" needs the surer pick`, async () => {
      const observation = observeSnapshot({
        text: `- group\n  - button "${name}" [ref=e1]\n  - button "Keep" [ref=e2]`,
      });
      const base = { ...ids, observation, scope: "a", target: "the one that gets rid of it", use: "click" as const };
      expect(await resolveTarget({ ...base, judge: pick(0.8, 0.95) })).toMatchObject({
        found: false,
        reason: "unsure",
      });
      expect(await resolveTarget({ ...base, judge: pick(0.9, 0.95) })).toMatchObject({ found: true, ref: "e1" });
    });
  }

  test("an ordinary button at the same 0.8 is taken", async () => {
    const observation = observeSnapshot({ text: '- group\n  - button "Open" [ref=e1]\n  - button "Keep" [ref=e2]' });
    expect(
      await resolveTarget({ judge: pick(0.8), ...ids, observation, scope: "a", target: "open it", use: "click" }),
    ).toMatchObject({ found: true, ref: "e1" });
  });
});
