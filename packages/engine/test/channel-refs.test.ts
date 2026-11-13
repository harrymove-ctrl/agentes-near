import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  archiveChannel,
  channelCard,
  createChannel,
  insertMessage,
  listMessages,
  NotFoundError,
  parseChannelNames,
  postPersonMessage,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const post = (userId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, { body });

test("#names: lower case, once each, never in code, links, words or HTML entities", () => {
  expect(parseChannelNames("veja #Eng e #eng, depois #vendas-2025.")).toEqual(["eng", "vendas-2025"]);
  expect(
    parseChannelNames("`#codigo` ```\n#bloco\n``` https://x.dev/#frag [ver](https://x.dev/#a) a#b &#39; ##dois"),
  ).toEqual([]);
  expect(parseChannelNames("# Título\n(#infra)")).toEqual(["infra"]);
  expect(parseChannelNames("fixed in PR #2025, see #42 and #1-2")).toEqual([]);
  expect(parseChannelNames("#2025-plan #fff")).toEqual(["2025-plan", "fff"]);
});

test("a message stores the channel each #name means, so a renamed channel still links", async () => {
  const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng" });
  const m = await post(f.owner.id, "Leva para #ENG ou #nada, não `#eng`");
  expect(m.meta.channelRefs).toEqual({ eng: eng.id });

  await f.db.update(schema.channels).set({ name: "engenharia" }).where(eq(schema.channels.id, eng.id));
  const [row] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, m.id));
  expect(row?.meta.channelRefs).toEqual({ eng: eng.id });

  // No #name of a channel: no key at all.
  expect((await post(f.owner.id, "sem canal #nada")).meta.channelRefs).toBeUndefined();
});

test("a private channel is stored only in a message posted in it; archived ones are stored", async () => {
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
  const old = await createChannel(f.db, f.owner.id, f.org.id, { name: "antigo" });
  await archiveChannel(f.db, f.owner.id, f.org.id, old.id);
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: ana.id });

  // Its member writes it in #general: Ana reads that message and learns no private id.
  const inGeneral = await post(f.owner.id, "#diretoria #antigo");
  expect(inGeneral.meta.channelRefs).toEqual({ antigo: old.id });
  const read = await listMessages(f.db, ana.id, f.org.id, f.general.id);
  expect(JSON.stringify(read)).not.toContain(secret.id);

  // Posted in the private channel itself: every reader is a member.
  const inside = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, secret.id, {
    body: "fica em #diretoria",
  });
  expect(inside.meta.channelRefs).toEqual({ diretoria: secret.id });

  // An agent in the private channel: the same rule.
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
  const reply = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "Entregue em #diretoria e #general",
  });
  expect(reply.meta.channelRefs).toEqual({ general: f.general.id });
});

test("a channel's card: counts and membership; archived shows; a private one not mine is not found", async () => {
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
  const ana = await addMember(f.db, f.org.id, "member", "ana");

  const card = await channelCard(f.db, f.owner.id, f.org.id, secret.id);
  expect(card).toEqual({
    id: secret.id,
    name: "diretoria",
    topic: "",
    visibility: "private",
    audienceRoleIds: [],
    isMember: true,
    archived: false,
    people: 1,
    agents: 1,
  });
  await expect(channelCard(f.db, ana.id, f.org.id, secret.id)).rejects.toBeInstanceOf(NotFoundError);

  const old = await createChannel(f.db, f.owner.id, f.org.id, { name: "antigo", topic: "o de antes" });
  await archiveChannel(f.db, f.owner.id, f.org.id, old.id);
  const archived = await channelCard(f.db, ana.id, f.org.id, old.id);
  expect([archived.archived, archived.isMember, archived.topic]).toEqual([true, false, "o de antes"]);
});
