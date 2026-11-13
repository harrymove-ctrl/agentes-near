import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  drainOutbox,
  insertMessage,
  listMembers,
  listNotifications,
  mentionsByName,
  postPersonMessage,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (name: string, handle: string) => ({ name, handle, person: true });
const agent = (name: string, handle: string) => ({ name, handle, person: false });
const JOAO = person("João Vitor Araújo", "joao");

test("a person's full name becomes their handle: accents, spaces, any case, the name alone", () => {
  expect(mentionsByName("O @João Vitor Araújo pode colar lá.", [JOAO])).toBe("O @joao pode colar lá.");
  expect(mentionsByName("(@joão vitor araújo)", [JOAO])).toBe("(@joao)");
  expect(mentionsByName("@João Vitor Araújo".normalize("NFD"), [JOAO])).toBe("@joao");
  expect(mentionsByName("**@João Vitor Araújo**, oi", [JOAO])).toBe("**@joao**, oi");
  expect(mentionsByName("@João Vitor Araújo\n@Bia Reis", [JOAO, person("Bia Reis", "bia")])).toBe("@joao\n@bia");
});

test("only a whole name, the longest first", () => {
  expect(mentionsByName("@João Vitor Araújos", [JOAO])).toBe("@João Vitor Araújos");
  expect(mentionsByName("@João Vitor", [JOAO])).toBe("@João Vitor");
  expect(mentionsByName("a@João Vitor Araújo", [JOAO])).toBe("a@João Vitor Araújo");
  const both = [person("Lia", "lia"), person("Lia Mota", "lia-mota")];
  expect(mentionsByName("@Lia Mota viu", both)).toBe("@lia-mota viu");
});

test("what looks like a name but isn't a member's stays as written; a shared name mentions nobody", () => {
  expect(mentionsByName("rodei o @Claude Code", [JOAO])).toBe("rodei o @Claude Code");
  const twins = [person("Ana Souza", "ana"), person("Ana Souza", "ana-2")];
  expect(mentionsByName("oi @Ana Souza", twins)).toBe("oi Ana Souza");
  // An agent of that name counts too: nothing says which one was meant.
  expect(mentionsByName("oi @Ana Souza", [twins[0] as never, agent("Ana Souza", "ana-bot")])).toBe("oi Ana Souza");
});

test("someone outside the conversation mentions nobody, not the member their name starts with", () => {
  const lia = person("Lia", "lia");
  expect(mentionsByName("@Lia Mota viu", [lia], ["Lia Mota"])).toBe("Lia Mota viu");
  expect(mentionsByName("@Lia viu", [lia], ["Lia Mota"])).toBe("@Lia viu");
  // A member of that name is who it means, and a handle stays a handle.
  expect(mentionsByName("@Lia Mota", [person("Lia Mota", "lia-m")], ["Lia Mota"])).toBe("@lia-m");
  expect(mentionsByName("oi @ana", [], ["Ana"])).toBe("oi @ana");
});

test("a member's handle stays what it is, whoever else has that name", () => {
  const members = [person("Dev", "dev-2"), agent("Dev", "dev")];
  expect(mentionsByName("@dev olha", members)).toBe("@dev olha");
  expect(mentionsByName("@Dev Lima", [person("Dev Lima", "dev-lima"), ...members])).toBe("@dev-lima");
  expect(mentionsByName("oi @ana", [person("Ana", "ana")])).toBe("oi @ana");
  expect(mentionsByName("@Dev olha", [person("Dev", "dev-2")])).toBe("@dev-2 olha");
});

test("code and links stay as written", () => {
  const code =
    "```\n@João Vitor Araújo\n```\n`@João Vitor Araújo` https://x.dev/@João [@João Vitor Araújo](https://x.dev)";
  expect(mentionsByName(code, [JOAO])).toBe(code);
  const open = "```\n@João Vitor Araújo";
  expect(mentionsByName(open, [JOAO])).toBe(open);
  expect(mentionsByName("`a` @João Vitor Araújo `b`", [JOAO])).toBe("`a` @joao `b`");
});

test("a bare address, a package and a domain aren't a one-word name", () => {
  const lia = [person("Lia", "lia-m")];
  for (const text of ["medium.com/@Lia", "bun add @Lia/kit", "@Lia.dev", "lia@Lia"]) {
    expect(mentionsByName(text, lia)).toBe(text);
  }
  expect(mentionsByName("Fala, @Lia. Depois, @Lia!", lia)).toBe("Fala, @lia-m. Depois, @lia-m!");
});

const agentMessage = (body: string) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
    body,
  });

test("an agent's message with a member's full name is that person's mention, stored with the handle, and notifies them", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Beatriz Araújo");
  await addMember(f.db, f.org.id, "member", "Cláudia Reis");
  await listMembers(f.db, f.org.id);
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const message = await agentMessage("O @Beatriz Araújo pode colar. A @Cláudia Reis não está aqui.");
  expect(message.body).toBe("O @beatriz pode colar. A Cláudia Reis não está aqui.");
  expect(message.mentionedUserIds).toEqual([bia.id]);
  await drainOutbox(f.db, f.handlers);
  const { items } = await listNotifications({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, {});
  expect(items.map((n) => n.kind)).toEqual(["mention"]);
});

test("a member's name an archived agent also had still mentions them", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Beatriz Araújo");
  await listMembers(f.db, f.org.id);
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await f.db
    .update(schema.agents)
    .set({ name: "Beatriz Araújo", archivedAt: new Date() })
    .where(eq(schema.agents.id, f.agent.id));
  expect((await agentMessage("@Beatriz Araújo olha")).mentionedUserIds).toEqual([bia.id]);
});

test("a person's own message keeps today's reading", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "Beatriz Araújo");
  await listMembers(f.db, f.org.id);
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const body = "falei com @Beatriz Araújo";
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  expect(message.body).toBe(body);
  const [row] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
  expect(row?.body).toBe(body);
});
