import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  consolidateByMeaning,
  consolidateItem,
  createFakeJudge,
  createJevJudge,
  createJevKey,
  createLlmJudge,
  insertContextItem,
  isStopRequest,
  itemLabel,
  type NewContextItem,
  smallModelFor,
  withJudgeFallback,
} from "../src";
import {
  decide,
  findCandidates,
  type Judged,
  judgeRelations,
  overlap,
  planConsolidation,
} from "../src/context/judgments";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const fact = (fx: Fixture, content: string, extra: Partial<NewContextItem> = {}): NewContextItem => ({
  orgId: fx.org.id,
  kind: "fact",
  scopeType: "channel",
  scopeId: fx.general.id,
  channelIds: [fx.general.id],
  content,
  ...extra,
});

const human = (ref: string) => ({ type: "human" as const, ref, at: new Date().toISOString() });
const agentClaim = (ref: string) => ({ type: "agent" as const, ref, at: new Date().toISOString() });

describe("memory judgments: words", () => {
  test("paraphrases keep their nouns, so they become candidates", () => {
    expect(overlap("Deploy é no Railway", "Hospedamos o app no Railway")).toBeGreaterThan(0);
    expect(overlap("Deploy é no Railway", "Reunião às quintas")).toBe(0);
  });
});

describe("memory judgments: candidates", () => {
  test("same scope and kind family, ranked by shared words; other agents' lessons and unrelated items stay out", async () => {
    f = await setup();
    const railway = await insertContextItem(f.db, fact(f, "We host the app on Railway."));
    const decision = await insertContextItem(
      f.db,
      fact(f, "Decided: deploys go through Railway.", { kind: "decision" }),
    );
    await insertContextItem(f.db, fact(f, "Standup is at 10am."));
    await insertContextItem(f.db, {
      ...fact(f, "Railway deploys need the CI green."),
      kind: "lesson",
      agentId: f.agent.id,
    });
    const found = await findCandidates(f.db, fact(f, "Deploy is on Railway"));
    expect(found.map((c) => c.id).sort()).toEqual([railway.id, decision.id].sort());
  });
});

describe("memory judgments: the judge's question", () => {
  test("one Choice per candidate in one request; an answer outside the set counts as unrelated", async () => {
    f = await setup();
    const a = await insertContextItem(f.db, fact(f, "We host the app on Railway."));
    const b = await insertContextItem(f.db, fact(f, "Railway bills monthly."));
    const judge = createFakeJudge((kind, id) =>
      kind === "memory_relation" ? (id === "rel_0" ? "same" : "bogus") : undefined,
    );
    const judged = await judgeRelations(judge, fact(f, "Deploy is on Railway"), [a, b]);
    expect(judge.calls).toHaveLength(1);
    expect(Object.keys(judge.calls[0]?.questions ?? {})).toEqual(["rel_0", "rel_1"]);
    expect(judge.calls[0]?.state.existing_items).toHaveLength(2);
    expect(judged.map((j) => [j.relation, j.p])).toEqual([
      ["same", 1],
      ["unrelated", 0],
    ]);
  });

  test("when the judge fails, there is no plan (the caller falls back to words)", async () => {
    f = await setup();
    await insertContextItem(f.db, fact(f, "We host the app on Railway."));
    const failing = { name: "down", ask: async () => Promise.reject(new Error("timeout")) };
    expect(await planConsolidation(f.db, failing, fact(f, "Deploy is on Railway"))).toBeNull();
    expect(await planConsolidation(f.db, failing, fact(f, "Standup is at 10am"))).toEqual({
      action: "create",
      related: [],
    });
  });
});

describe("memory judgments: policy", () => {
  test("merge, supersede, or just link when confidence is low", async () => {
    f = await setup();
    const old = await insertContextItem(f.db, fact(f, "We host the app on Railway."));
    const j = (relation: Judged["relation"], p: number): Judged[] => [{ candidate: old, relation, p }];
    const next = fact(f, "Deploy is on Railway");
    expect(decide(next, j("same", 0.9))).toMatchObject({ action: "merge", target: { id: old.id } });
    expect(decide(next, j("updates", 0.8))).toMatchObject({ action: "supersede", relation: "updates" });
    expect(decide(next, j("refines", 0.8))).toMatchObject({ action: "supersede", relation: "refines" });
    // Low confidence never merges or archives: both stay, linked.
    expect(decide(next, j("same", 0.6))).toEqual({ action: "create", related: [old.id] });
    expect(decide(next, j("related", 0.7))).toEqual({ action: "create", related: [old.id] });
    expect(decide(next, j("unrelated", 0.99))).toEqual({ action: "create", related: [] });
  });

  test("a contradiction resolves itself: stronger evidence wins, and on a tie the newer word", async () => {
    f = await setup();
    const personSaid = await insertContextItem(f.db, fact(f, "Deploys are on Fridays.", { evidence: [human("m1")] }));
    const j: Judged[] = [{ candidate: personSaid, relation: "contradicts", p: 0.9 }];
    // A person again, later: the latest word is how things are now.
    expect(decide(fact(f, "Never deploy on Fridays.", { evidence: [human("m2")] }), j)).toMatchObject({
      action: "resolve",
      winner: "new",
    });
    // An agent's claim against a person's word: the person's word stays.
    expect(decide(fact(f, "Never deploy on Fridays.", { evidence: [agentClaim("m3")] }), j)).toMatchObject({
      action: "resolve",
      winner: "old",
    });
    // Untrusted text (from outside the team) never overrules the team.
    expect(decide(fact(f, "Never deploy on Fridays.", { evidence: [human("m4")], trust: "low" }), j)).toMatchObject({
      action: "resolve",
      winner: "old",
    });
    const claim = await insertContextItem(f.db, fact(f, "Deploys are on Mondays.", { evidence: [agentClaim("m5")] }));
    expect(
      decide(fact(f, "Deploys are on Tuesdays.", { evidence: [human("m6")] }), [
        { candidate: claim, relation: "contradicts", p: 0.9 },
      ]),
    ).toMatchObject({ action: "resolve", winner: "new" });
    // Low confidence in the contradiction: nothing is archived, they're only linked.
    expect(
      decide(fact(f, "Never deploy on Fridays.", { evidence: [human("m7")] }), [{ ...j[0], p: 0.5 } as Judged]),
    ).toEqual({ action: "create", related: [personSaid.id] });
  });

  test("across channels nothing merges or archives: items are only linked", async () => {
    f = await setup();
    const publicItem = await insertContextItem(f.db, fact(f, "We host the app on Railway.", { channelIds: [] }));
    const judged: Judged[] = [{ candidate: publicItem, relation: "same", p: 0.95 }];
    expect(decide(fact(f, "Deploy is on Railway"), judged)).toEqual({ action: "create", related: [publicItem.id] });
    expect(decide(fact(f, "Deploy is on Railway"), [{ candidate: publicItem, relation: "updates", p: 0.95 }])).toEqual({
      action: "create",
      related: [publicItem.id],
    });
  });

  test("the strongest answer wins among several candidates", async () => {
    f = await setup();
    const a = await insertContextItem(f.db, fact(f, "We host on Railway."));
    const b = await insertContextItem(f.db, fact(f, "The app runs on Railway."));
    const plan = decide(fact(f, "Deploy is on Railway"), [
      { candidate: a, relation: "same", p: 0.8 },
      { candidate: b, relation: "same", p: 0.95 },
    ]);
    expect(plan).toMatchObject({ action: "merge", target: { id: b.id } });
  });
});

describe("memory judgments: consolidateItem carries out the plan", () => {
  /** The judge hears the answer for each existing item by its content. */
  const judgeBy = (byContent: Record<string, string>) =>
    createFakeJudge((kind, id, state) => {
      if (kind !== "memory_relation") return undefined;
      const existing = (state.existing_items as { content: string }[])[Number(id.slice(4))];
      return byContent[existing?.content ?? ""] ?? "unrelated";
    });

  test("a paraphrase in another language merges when the org is on; with the org off, words keep both", async () => {
    f = await setup();
    const old = await consolidateItem(f.db, fact(f, "We host the app on Railway."));
    const judge = judgeBy({ "We host the app on Railway.": "same" });
    const off = await consolidateItem(f.db, fact(f, "O deploy é no Railway."), { judge, semantic: false });
    expect(off.action).toBe("created");
    const on = await consolidateItem(f.db, fact(f, "Hospedamos a aplicação no Railway."), { judge, semantic: true });
    expect(on).toMatchObject({ action: "merged", item: { id: old.item.id, recurrence: 2 } });
  });

  test("a judge that is sure of nothing leaves it to words: the same item again still merges", async () => {
    f = await setup();
    const old = await consolidateItem(f.db, fact(f, "We host the app on Railway."));
    const silent = createFakeJudge(() => undefined);
    const again = await consolidateItem(f.db, fact(f, "We host the app on Railway."), {
      judge: silent,
      semantic: true,
    });
    expect(again).toMatchObject({ action: "merged", item: { id: old.item.id, recurrence: 2 } });
  });

  test("an update supersedes the old item (kept as history)", async () => {
    f = await setup();
    const old = await consolidateItem(f.db, fact(f, "Standup is at 10am."));
    const judge = judgeBy({ "Standup is at 10am.": "updates" });
    const next = await consolidateItem(f.db, fact(f, "From now on standup is at 9:30."), { judge, semantic: true });
    expect(next).toMatchObject({ action: "superseded", previous: { id: old.item.id } });
    const [archived] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, old.item.id));
    expect(archived).toMatchObject({ status: "archived", supersededBy: next.item.id });
  });

  test("contradictions resolve themselves; the loser stays as history, linked", async () => {
    f = await setup();
    const old = await consolidateItem(f.db, fact(f, "Deploys are on Fridays.", { evidence: [human("m1")] }));
    const judge = judgeBy({ "Deploys are on Fridays.": "contradicts" });
    // A person's newer word wins.
    const won = await consolidateItem(f.db, fact(f, "Never deploy on Fridays.", { evidence: [human("m2")] }), {
      judge,
      semantic: true,
    });
    expect(won).toMatchObject({ action: "superseded", previous: { id: old.item.id } });
    // An agent's claim against it loses: the person's word stays current, the claim is history.
    const judge2 = judgeBy({ "Never deploy on Fridays.": "contradicts" });
    const lost = await consolidateItem(
      f.db,
      fact(f, "Fridays are fine for deploys.", { evidence: [agentClaim("m3")] }),
      {
        judge: judge2,
        semantic: true,
      },
    );
    expect(lost).toMatchObject({ action: "outweighed", item: { id: won.item.id } });
    const [history] = await f.db
      .select()
      .from(schema.contextItems)
      .where(eq(schema.contextItems.id, lost.previous?.id ?? ""));
    expect(history).toMatchObject({ status: "archived", supersededBy: won.item.id, relatedIds: [won.item.id] });
    const [current] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, won.item.id));
    expect(current).toMatchObject({ status: "active", relatedIds: [lost.previous?.id] });
    expect(itemLabel({ kind: "fact", verified: true, trust: "high" })).toBe("[fact]");
    expect(itemLabel({ kind: "fact", verified: true, trust: "high", disputed: true })).toContain("disputed");
  });

  test("related items are linked; a failing judge falls back to words", async () => {
    f = await setup();
    const old = await consolidateItem(f.db, fact(f, "Railway bills us monthly."));
    const related = await consolidateItem(f.db, fact(f, "We host the app on Railway."), {
      judge: judgeBy({ "Railway bills us monthly.": "related" }),
      semantic: true,
    });
    expect(related).toMatchObject({ action: "created", item: { relatedIds: [old.item.id] } });
    const failing = { name: "down", ask: async () => Promise.reject(new Error("timeout")) };
    const fallback = await consolidateItem(f.db, fact(f, "We host the app on Railway."), {
      judge: failing,
      semantic: true,
    });
    expect(fallback).toMatchObject({ action: "merged", item: { id: related.item.id } });
  });
});

test("memory never takes the LLM fallback's word: without Jev, words decide", async () => {
  f = await setup();
  const old = await consolidateItem(f.db, fact(f, "We host the app on Railway."));
  const llmOnly = createLlmJudge({
    gateway: { complete: async () => Promise.reject(new Error("must not be called")) },
    resolveModel: async () => "claude-haiku-5-5",
  });
  const jevDown = withJudgeFallback({ name: "jev", ask: async () => Promise.reject(new Error("timeout")) }, llmOnly);
  for (const judge of [llmOnly, jevDown]) {
    const res = await consolidateItem(f.db, fact(f, "We host the app on Railway."), { judge, semantic: true });
    expect(res).toMatchObject({ action: "merged", item: { id: old.item.id } }); // by words, as today
  }
});

test("without Jev the judge asks the workspace's small model with the least thinking it allows; with none it fails", async () => {
  f = await setup({ reply: () => ({ chunks: ['{"stop":0.9}'] }) });
  const judge = createLlmJudge({ gateway: f.gateway, resolveModel: (orgId) => smallModelFor(f, orgId) });
  const stop = { orgId: f.org.id, text: "para", agentName: "Dev" };
  expect(await isStopRequest(judge, stop)).toBe(true);
  expect(f.provider.calls[0]?.request).toMatchObject({ model: "claude-haiku-5-5", effort: "none", maxTokens: 512 });
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  await expect(isStopRequest(judge, stop)).rejects.toThrow("no small model");
  expect(f.provider.calls).toHaveLength(1);
});

describe("memory judgments: the daily pass", () => {
  const relation = (answer: string) => createFakeJudge((kind) => (kind === "memory_relation" ? answer : undefined));
  /** Makes `id` the older item (writes in one test can share a timestamp). */
  const ageOf = (id: string, days = 1) =>
    f.db
      .update(schema.contextItems)
      .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
      .where(eq(schema.contextItems.id, id));

  test("settles what writes missed: a twin merges into the older item, which keeps both", async () => {
    f = await setup();
    const older = await insertContextItem(f.db, fact(f, "We host the app on Railway.", { evidence: [human("m1")] }));
    const twin = await insertContextItem(
      f.db,
      fact(f, "Hospedamos a aplicação no Railway.", { evidence: [human("m2")] }),
    );
    await ageOf(older.id);
    const deps = { ...f.context, judge: relation("same") };
    expect(await consolidateByMeaning(deps, f.org.id)).toEqual({ moved: 1, linked: 0 });
    const rows = await f.db.select().from(schema.contextItems);
    expect(rows.find((r) => r.id === twin.id)).toMatchObject({ status: "archived", supersededBy: older.id });
    expect(rows.find((r) => r.id === older.id)?.evidence).toHaveLength(2);
    // Nothing left to settle on the next run.
    expect(await consolidateByMeaning(deps, f.org.id)).toEqual({ moved: 0, linked: 0 });
  });

  test("a contradiction resolves by evidence; related items are linked once", async () => {
    f = await setup();
    const personSaid = await insertContextItem(f.db, fact(f, "Deploys are on Fridays.", { evidence: [human("m1")] }));
    const claim = await insertContextItem(
      f.db,
      fact(f, "Fridays are bad for deploys.", { evidence: [agentClaim("m2")] }),
    );
    await ageOf(personSaid.id, 2);
    await consolidateByMeaning({ ...f.context, judge: relation("contradicts") }, f.org.id);
    const [lost] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, claim.id));
    expect(lost).toMatchObject({ status: "archived", supersededBy: personSaid.id });

    const a = await insertContextItem(f.db, fact(f, "Railway bills us monthly."));
    await insertContextItem(f.db, fact(f, "We pay Railway with the company card."));
    await ageOf(a.id);
    const linking = { ...f.context, judge: relation("related") };
    expect((await consolidateByMeaning(linking, f.org.id)).linked).toBeGreaterThan(0);
    const [linked] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, a.id));
    expect(linked?.relatedIds.length).toBeGreaterThan(0);
    expect(await consolidateByMeaning(linking, f.org.id)).toEqual({ moved: 0, linked: 0 });
  });

  test("without Jev nothing moves", async () => {
    f = await setup();
    await insertContextItem(f.db, fact(f, "We host the app on Railway."));
    const twin = await insertContextItem(f.db, fact(f, "Hospedamos a aplicação no Railway."));
    const llmOnly = createLlmJudge({
      gateway: { complete: async () => Promise.reject(new Error("must not be called")) },
      resolveModel: async () => "claude-haiku-5-5",
    });
    expect(await consolidateByMeaning({ ...f.context, judge: llmOnly }, f.org.id)).toEqual({
      moved: 0,
      linked: 0,
    });
    const [still] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, twin.id));
    expect(still?.status).toBe("active");
  });

  test("with no Jev key nothing moves, and once its owner saves one the next pass does, with no restart", async () => {
    f = await setup();
    const older = await insertContextItem(f.db, fact(f, "We host the app on Railway."));
    const twin = await insertContextItem(f.db, fact(f, "Hospedamos a aplicação no Railway."));
    await ageOf(older.id);
    // TypeSafe hears every pair as the same fact, and accepts the key.
    const typesafe = (async (_url: string, init: RequestInit) => {
      const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const same = { choice: "same", probabilities: { same: 0.95 } };
      return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, same])) });
    }) as unknown as typeof fetch;
    const key = createJevKey({ db: f.db, keyWrapper: f.keyWrapper, keyWrappers: [f.keyWrapper], fetch: typesafe });
    const llmOnly = createLlmJudge({
      gateway: { complete: async () => Promise.reject(new Error("must not be called")) },
      resolveModel: async () => "claude-haiku-5-5",
    });
    const deps = {
      ...f.context,
      judge: withJudgeFallback(createJevJudge({ key, gateway: f.gateway, fetch: typesafe }), llmOnly),
    };
    expect(await consolidateByMeaning(deps, f.org.id)).toEqual({ moved: 0, linked: 0 });
    await key.save("ts_memory_key_1", f.owner.id);
    expect(await consolidateByMeaning(deps, f.org.id)).toEqual({ moved: 1, linked: 0 });
    const [merged] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, twin.id));
    expect(merged).toMatchObject({ status: "archived", supersededBy: older.id });
  });
});
