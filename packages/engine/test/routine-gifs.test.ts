import { afterEach, expect, test } from "bun:test";
import { createFakeGifs } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, runRoutineNow } from "../src";
import { type Fixture, setup } from "./fixtures";
import { channelRoutine, messagesIn, routineDeps } from "./routine-fixtures";

// A routine's message with a GIF (ADR 0091 addendum 2026-11-09): `hand_off` takes `gif` where the agent may send
// one, the GIF goes in the same message as the text, a daily one isn't the last one posted there, and a routine's
// `post_message` takes `gif` too.

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const GREETING = "Bom dia, pessoal! Hoje o tema é café.";

const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const seen = (req: ModelRequest | undefined) => JSON.stringify(req?.messages ?? []);
const handOffOf = (req: ModelRequest | undefined) => req?.tools?.find((t) => t.name === "hand_off");
const hasGif = (req: ModelRequest | undefined) =>
  "gif" in ((handOffOf(req)?.inputSchema.properties ?? {}) as Record<string, unknown>);

/** The routine's model: calls `name` with `input` once, then writes its record. */
const calls = (name: string, input: Record<string, unknown>) => (req: ModelRequest) => {
  if (!isRoutine(req)) return { chunks: ["A conversation run should not have run."] };
  if (seen(req).includes("tool_result")) return { chunks: ["Bom dia enviado."] };
  return { chunks: [], toolUses: [{ name, input }] };
};

/** One firing of the routine, and every job it brings. */
async function fireNow(routineId: string) {
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routineId);
  await drainOutbox(f.db, f.handlers);
}

/** The routine's messages in a conversation (`meta.routine`), oldest first. */
const routinePosts = async (channelId: string) =>
  (await messagesIn(f, channelId)).filter((m) => m.meta.routine !== undefined);

const gifOf = (meta: Record<string, unknown>) => meta.media as { kind?: string; id?: string } | undefined;

test("a good-morning routine posts its greeting and the GIF as one message, kept without a URL", async () => {
  const gifs = createFakeGifs();
  f = await setup({ handOff: true, gifs, reply: calls("hand_off", { message: GREETING, gif: "good morning coffee" }) });
  const routine = await channelRoutine(f, { name: "GIF de bom dia", prompt: "Mande um bom dia com um GIF." });
  await fireNow(routine.id);

  const first = f.provider.calls[0]?.request;
  expect(hasGif(first)).toBe(true);
  expect(handOffOf(first)?.description).toContain("Never paste a link to a GIF site");
  expect(gifs.calls.search.map((s) => s.query)).toEqual(["good morning coffee"]);
  const [posted, ...more] = await routinePosts(f.general.id);
  expect(more).toEqual([]);
  expect(posted?.body).toBe(GREETING);
  expect(posted?.meta.media).toMatchObject({ kind: "gif", provider: "giphy" });
  expect(JSON.stringify(posted?.meta)).not.toContain("http");
  // Its title (outside text) never reaches the model: the result only says it went.
  const after = seen(f.provider.calls.at(-1)?.request);
  expect(after).toContain("Posted with a GIF.");
  expect(after).not.toContain("Coffee time");
  expect(after).not.toContain("Good morning sunshine");
  const [rr] = await f.db.select().from(schema.routineRuns);
  expect(rr).toMatchObject({ status: "reported", messageId: posted?.id });
});

test("a daily routine's GIF isn't the last one posted where it reports", async () => {
  f = await setup({
    handOff: true,
    gifs: createFakeGifs(),
    reply: calls("hand_off", { message: GREETING, gif: "good morning coffee" }),
  });
  const routine = await channelRoutine(f, { name: "GIF de bom dia", prompt: "Mande um bom dia com um GIF." });
  await fireNow(routine.id);
  await fireNow(routine.id);
  // The search finds two ("Coffee time", "Good morning sunshine"): the second day gets the other one.
  const ids = (await routinePosts(f.general.id)).map((m) => gifOf(m.meta)?.id);
  expect(ids).toHaveLength(2);
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(2);
});

test("with wake_me a GIF is refused before anything posts; with GIFs off hand_off has no gif", async () => {
  f = await setup({
    handOff: true,
    gifs: createFakeGifs(),
    reply: calls("hand_off", { message: "Erros novos no checkout.", gif: "oops", wake_me: true }),
  });
  const routine = await channelRoutine(f);
  await fireNow(routine.id);
  expect(seen(f.provider.calls[1]?.request)).toContain("A GIF goes only with a message posted as-is");
  expect((await messagesIn(f, f.general.id)).filter((m) => gifOf(m.meta))).toEqual([]);

  await f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, gifs: false })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { gifs: false } });
  const before = f.provider.calls.length;
  await fireNow(routine.id);
  const listed = f.provider.calls[before]?.request;
  expect(handOffOf(listed)).toBeDefined();
  expect(hasGif(listed)).toBe(false);
  expect((await messagesIn(f, f.general.id)).filter((m) => gifOf(m.meta))).toEqual([]);
});

test("a routine's post_message takes a GIF too, where its creator can post", async () => {
  f = await setup({
    handOff: true,
    chatTools: true,
    gifs: createFakeGifs(),
    reply: calls("post_message", { channel: "general", text: "Sextou, pessoal!", gif: "friday dance" }),
  });
  const routine = await channelRoutine(f, {
    name: "Sextou",
    prompt: "Toda sexta, um GIF no #general.",
    target: { type: "dm" },
  });
  await fireNow(routine.id);
  expect(seen(f.provider.calls[1]?.request)).toContain("Posted in #general with a GIF:");
  const posted = (await messagesIn(f, f.general.id)).filter((m) => m.authorType === "agent");
  expect(posted.map((m) => m.body)).toEqual(["Sextou, pessoal!"]);
  expect(gifOf(posted[0]?.meta ?? {})).toMatchObject({ kind: "gif" });
});
