import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  type ContextItem,
  ensurePeriodSummary,
  loadThread,
  mergeProfileNote,
  pickDistinct,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const item = (over: Partial<ContextItem> & Pick<ContextItem, "id" | "kind" | "content">): ContextItem =>
  ({
    pinned: false,
    scopeId: null,
    subjectKey: "",
    updatedAt: new Date("2026-10-10T00:00:00Z"),
    ...over,
  }) as ContextItem;

test("an entity profile: a note that restates an older one replaces it; only the newest few stay", () => {
  let profile = "";
  profile = mergeProfileNote(
    profile,
    "Analytics tool used to check review_prompt events for loja-app; currently unavailable to theo.",
  );
  profile = mergeProfileNote(profile, "App metrics tool Theo tracks.");
  profile = mergeProfileNote(profile, "Analytics tool used to check review_prompt events for loja-app; working again.");
  expect(profile.split("\n")).toEqual([
    "- App metrics tool Theo tracks.",
    "- Analytics tool used to check review_prompt events for loja-app; working again.",
  ]);
  const topics = [
    "pricing",
    "onboarding",
    "billing",
    "android",
    "webhooks",
    "exports",
    "invoices",
    "search",
    "alerts",
    "roles",
  ];
  for (const t of topics) profile = mergeProfileNote(profile, `${t} team`);
  expect(profile.split("\n")).toHaveLength(8);
});

test("memory in the prompt: no restated claims, one period summary per channel, nothing the instructions already say", () => {
  const older = item({
    id: "f1",
    kind: "fact",
    content: "Hourly routine checks Himetrica review_prompt events and posts a one-line reply when nothing is new.",
  });
  const newer = item({
    id: "p1",
    kind: "preference",
    content: "Hourly routine checks Himetrica review_prompt events and posts only when there is news.",
    updatedAt: new Date("2026-10-18T00:00:00Z"),
  });
  const lesson = item({
    id: "l1",
    kind: "lesson",
    content: "Only report no events when the Himetrica query actually ran.",
  });
  const week1 = item({ id: "s1", kind: "period_summary", content: "week 1", scopeId: "c1:2026-10-10" });
  const week2 = item({
    id: "s2",
    kind: "period_summary",
    content: "week 2",
    scopeId: "c1",
    updatedAt: new Date("2026-10-19T00:00:00Z"),
  });
  const other = item({ id: "s3", kind: "period_summary", content: "other channel", scopeId: "c2" });
  const profile = item({
    id: "e1",
    kind: "entity_profile",
    content: "Hourly routine checks Himetrica review_prompt events.",
  });
  const instructions = "Organizes tasks.\n\n## Learned\n- Only report no events when the Himetrica query actually ran.";
  const picked = pickDistinct([older, lesson, week1, newer, week2, other, profile, older], instructions);
  expect(picked.map((i) => i.id)).toEqual(["p1", "s2", "s3", "e1"]);
  // A pinned item always stays.
  expect(pickDistinct([{ ...lesson, pinned: true }], instructions).map((i) => i.id)).toEqual(["l1"]);
  // Two holders of one access read alike and are both true.
  const holder = (id: string, who: string) =>
    item({
      id,
      kind: "fact",
      agentId: null,
      subjectKey: `whoholds ${who} store console`,
      content: `${who} is signed in to the store console in its browser.`,
    });
  expect(pickDistinct([holder("a1", "@ana"), holder("a2", "@bia")], "").map((i) => i.id)).toEqual(["a1", "a2"]);
});

test("a long thread loads its newest replies, so its summary follows the conversation", async () => {
  f = await setup();
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body,
      ...(threadId ? { threadId } : {}),
    });
  const root = await post("routine thread");
  for (let i = 1; i <= 6; i++) await post(`reply ${i}`, root.id);
  const thread = await loadThread(f.db, f.org.id, root.id, 3);
  expect(thread?.messages.map((m) => m.body)).toEqual(["routine thread", "reply 4", "reply 5", "reply 6"]);
});

test("a channel keeps one period summary: each nightly refresh replaces the last", async () => {
  f = await setup({ reply: () => ({ chunks: ["Resumo da semana."] }) });
  for (let i = 0; i < 30; i++)
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: `m${i}` });
  const now = Date.now();
  await ensurePeriodSummary(f.context, f.org.id, f.general.id, {
    from: new Date(now - 7 * 86_400_000),
    to: new Date(now + 1000),
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "one more" });
  await ensurePeriodSummary(f.context, f.org.id, f.general.id, {
    from: new Date(now - 6 * 86_400_000),
    to: new Date(now + 60_000),
  });
  const active = await f.db
    .select()
    .from(schema.contextItems)
    .where(and(eq(schema.contextItems.kind, "period_summary"), eq(schema.contextItems.status, "active")));
  expect(active).toHaveLength(1);
});
