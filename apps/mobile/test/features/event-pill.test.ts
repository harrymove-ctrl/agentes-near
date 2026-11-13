import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stoppedRunsKey, stoppedRunsOf } from "../../src/features/chat/stopped-runs";
import { message } from "./fixtures";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

const ada = { type: "agent" as const, id: "ada" };
const notice = (id: string, runId: string, reason: string | null = null) =>
  message({
    id,
    author: ada,
    meta: {
      notice: {
        kind: "run_stopped",
        text: "stopped",
        refs: { runId, byUserId: "me", byName: "Ana", label: "Fix the CI", was: "working", reason },
      },
    },
  });
const reply = (id: string, runId: string, meta: Record<string, unknown> = { canceled: { byUserId: "me" } }) =>
  message({ id, author: ada, agentRunId: runId, meta });

describe("one stop, one pill", () => {
  test("a stop notice whose stopped reply is here goes into that reply's pill", () => {
    const runs = stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1", "wrong repo")]);
    expect([...runs.keys()]).toEqual(["r1"]);
    expect(runs.get("r1")?.notice).toMatchObject({ byUserId: "me", byName: "Ana", reason: "wrong repo" });
    expect(runs.get("r1")?.message.id).toBe("n1");
  });

  test("stopped while queued (no reply), or a reply that wasn't stopped: the notice keeps its own pill", () => {
    expect(stoppedRunsOf([notice("n1", "r1")]).size).toBe(0);
    expect(stoppedRunsOf([reply("m1", "r1", {}), notice("n1", "r1")]).size).toBe(0);
    // Media an agent posts after its reply carries the run too, but is never the reply.
    expect(stoppedRunsOf([reply("m2", "r1", { canceled: {}, mediaAfter: "m1" }), notice("n1", "r1")]).size).toBe(0);
    // A reply with no notice here has nothing to merge.
    expect(stoppedRunsOf([reply("m1", "r1")]).size).toBe(0);
  });

  test("the rows redraw when a reason is said, not on every message", () => {
    const before = stoppedRunsKey(stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1")]));
    const person = message({ id: "x", author: { type: "person", id: "me" } });
    const more = stoppedRunsKey(stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1"), person]));
    const said = stoppedRunsKey(stoppedRunsOf([reply("m1", "r1"), notice("n1", "r1", "why")]));
    expect(more).toBe(before);
    expect(said).not.toBe(before);
  });

  test("the conversation's list provides the stops; the notice draws nothing while its reply has them", () => {
    expect(src("features/chat/ChatScreen.tsx")).toContain("<StoppedRunsContext.Provider value={stoppedRuns}>");
    const line = src("features/chat/StoppedLine.tsx");
    expect(line).toContain("const inReply = useStoppedRun(notice.runId);\n  if (inReply) return null;");
    expect(line).not.toContain("taskManager.stopped.told");
    const row = src("features/chat/MessageRow.tsx");
    expect(row).toContain("const stop = useStoppedRun(limit ? null : runId);");
    expect(row).toContain("<StopPill");
  });
});

describe("the event pill", () => {
  test("a hairline frame with the cut corner, no fill; actions after hairlines; what opens text is an action", () => {
    const pill = src("ui/EventPill.tsx");
    expect(pill).toContain("borderBottomLeftRadius: CUT");
    expect(pill).not.toMatch(/frame: \{[^}]*backgroundColor/);
    expect(pill).toContain('<Icon name="right" size={12} color={c.faint} />');
    expect(pill).toContain('turned: { transform: [{ rotate: "90deg" }] }');
    expect(src("ui/index.ts")).toContain('} from "./EventPill";');
  });

  test("actions under the sentence keep the room the sentence has over it: 7 from the frame's edge (#8)", () => {
    const pill = src("ui/EventPill.tsx");
    expect(pill).toMatch(/main: \{[^}]*paddingVertical: 6,/);
    expect(pill).toMatch(/under: \{[^}]*paddingBottom: 1,/);
    expect(pill).toContain("actionUnder: { paddingHorizontal: 0, minHeight: 28,");
    // No hairline before an action under the sentence, so the frame's edge is never doubled.
    expect(pill).toContain("{stacked ? null : <View style={[styles.rule, { backgroundColor: c.line }]} />}");
  });

  test("a sentence that wraps keeps its mark and its time on its first line, not between two lines (#8)", () => {
    const pill = src("ui/EventPill.tsx");
    // The row tops its parts; the mark sits where the eye reads the words' first line, the time is one such line.
    expect(pill).toMatch(/main: \{\s*flexDirection: "row",\s*alignItems: "flex-start",/);
    // The words are the small variant with no size of their own, so they grow with the person's text size.
    expect(pill).toContain('color={markColor ?? c.faint} variant="small" />');
    expect(pill).toContain("time: { lineHeight: WORDS_LINE,");
    expect(pill).not.toContain("fontSize");
  });

  test("a sentence that takes more than a line puts its actions under it, on its column, with no rule", () => {
    const pill = src("ui/EventPill.tsx");
    expect(pill).toContain("e.nativeEvent.lines.length > 1");
    expect(pill).toContain("list.length > 0 && (wraps ||");
    expect(pill).toContain("{stacked ? null : <View style={[styles.rule");
    expect(pill).toContain("paddingLeft: 12 + MARK + 8");
  });

  test("the automatic lines use it: notices, stops, decided requests, the task taken, the speed fallback", () => {
    for (const file of [
      "features/chat/EventLine.tsx",
      "features/chat/StoppedLine.tsx",
      "features/chat/asks.tsx",
      "features/chat/issue-work.tsx",
    ])
      expect(src(file)).toContain("<EventPill");
    // No more " · " chains with the time in the notice line; "Cancel" on a follow-up still to come.
    const line = src("features/chat/EventLine.tsx");
    expect(line).toContain("time={when.time(message.createdAt)}");
    expect(line).toContain('t("chat.notice.followUpCancel")');
    expect(line).not.toContain('" · "');
  });

  test("a decided approval: outcome and title, its date in the time slot, Cancel as an action, the values under it", () => {
    const cards = src("features/chat/cards.tsx");
    const done = cards.slice(cards.indexOf("function ApprovalDone("), cards.indexOf("function ApprovalGroupAsk("));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the component's own template, read as source text
    expect(done).toContain("words={`${outcome}: ${markName(approvalHeadline(t, a, i18n.language))}`}");
    expect(done).toContain("time={a.decidedAt ? when.short(a.decidedAt) : undefined}");
    expect(done).toContain('label={t("approval.ahead.cancel")}');
    expect(done).toContain("approvalSummary(a, i18n.language)");
  });
});

describe("a request still waiting, as a pill", () => {
  test("waiting: the words in ink, the frame's hairline kept (no attention border); primary: a soft attention tint", () => {
    const pill = src("ui/EventPill.tsx");
    expect(pill).toContain('tone={waiting ? "ink" : "ink2"}');
    expect(pill).toContain("borderColor: c.line2");
    expect(pill).not.toContain("borderColor: c.amber");
    expect(pill).toContain("withAlpha(c.amber, pressed ? 0.18 : 0.1)");
    expect(pill).toContain('tone={primary ? "ink" : "ink2"}');
  });

  test("for the viewer, the breathing square the requests already use; for someone else, a quiet icon", () => {
    const asks = src("features/chat/asks.tsx");
    const start = asks.indexOf("export function AskWaiting(");
    const waiting = asks.slice(start, asks.indexOf("\nfunction ", start));
    expect(waiting).toContain("<EventPill\n        waiting");
    expect(waiting).toContain("<WaitMark />");
    expect(waiting).toMatch(/forMe \? \([\s\S]*<WaitMark \/>[\s\S]*\) : \(\s*mark\s*\)/);
  });

  test("the cards that waited in a box with a button are waiting pills now, the main action tinted", () => {
    for (const file of [
      "features/ai/NoAiCard.tsx",
      "features/ai/StretchCard.tsx",
      "features/ai/OfferCard.tsx",
      "features/ai/CostlyProposalCard.tsx",
      "features/ai/UsagePauseCard.tsx",
      "features/usage/people.tsx",
      "features/outages/WaitCard.tsx",
      "features/right-hand/Intro.tsx",
    ]) {
      const text = src(file);
      expect([file, text.includes("<AskWaiting")]).toEqual([file, true]);
      expect([file, text.includes("<AskDone")]).toEqual([file, !file.endsWith("Intro.tsx")]);
    }
    // A computer coming back waits for no one here: never the viewer's mark, never a tinted action.
    const outage = src("features/outages/WaitCard.tsx");
    expect(outage).toContain("forMe={false}");
    expect(outage).not.toContain("primary");
    // No box with a button left in them.
    for (const file of ["features/ai/StretchCard.tsx", "features/ai/CostlyProposalCard.tsx"])
      expect([file, src(file).includes("<Button")]).toEqual([file, false]);
  });
});
