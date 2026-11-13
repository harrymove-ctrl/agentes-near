import { afterEach, beforeEach, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  ConflictError,
  createChannel,
  createChannelCategory,
  deleteChannelCategory,
  ForbiddenError,
  listChannelCategories,
  listChannels,
  NotFoundError,
  placeChannel,
  placeChannelCategory,
  renameChannelCategory,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

/** The sidebar as people see it: [category or null, channel names in order]. */
async function sidebar(userId = f.owner.id) {
  const categories = await listChannelCategories(f.db, userId, f.org.id);
  const channels = await listChannels(f.db, userId, f.org.id);
  return [
    [null, channels.filter((c) => !c.categoryId).map((c) => c.name)],
    ...categories.map((cat) => [cat.name, channels.filter((c) => c.categoryId === cat.id).map((c) => c.name)]),
  ];
}

test("a category takes channels along in order, and the sidebar reads loose ones first", async () => {
  const tech = await createChannel(f.db, f.owner.id, f.org.id, { name: "tech" });
  const bugs = await createChannel(f.db, f.owner.id, f.org.id, { name: "bugs" });
  await createChannel(f.db, f.owner.id, f.org.id, { name: "avisos" });
  await createChannelCategory(f.db, f.owner.id, f.org.id, { name: " Engenharia ", channelIds: [tech.id, bugs.id] });
  await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Vendas" });
  expect(await sidebar()).toEqual([
    [null, ["avisos", "general"]],
    ["Engenharia", ["tech", "bugs"]],
    ["Vendas", []],
  ]);
});

test("names are unique ignoring case, trimmed, and at most 40 characters", async () => {
  await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Marketing" });
  await expect(createChannelCategory(f.db, f.owner.id, f.org.id, { name: "marketing" })).rejects.toBeInstanceOf(
    ConflictError,
  );
  await expect(createChannelCategory(f.db, f.owner.id, f.org.id, { name: "   " })).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(createChannelCategory(f.db, f.owner.id, f.org.id, { name: "x".repeat(41) })).rejects.toBeInstanceOf(
    ValidationError,
  );
  const sales = await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Sales" });
  await expect(
    renameChannelCategory(f.db, f.owner.id, f.org.id, sales.id, { name: "MARKETING" }),
  ).rejects.toBeInstanceOf(ConflictError);
  expect((await renameChannelCategory(f.db, f.owner.id, f.org.id, sales.id, { name: "Vendas" })).name).toBe("Vendas");
});

test("only admins arrange categories; a channel's creator may place it", async () => {
  const member = await addMember(f.db, f.org.id, "member");
  await expect(createChannelCategory(f.db, member.id, f.org.id, { name: "Mine" })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  const cat = await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Produto" });
  // A member creates a channel straight into the category, and may move their own channel.
  const roadmap = await createChannel(f.db, member.id, f.org.id, { name: "roadmap", categoryId: cat.id });
  expect(roadmap.categoryId).toBe(cat.id);
  await placeChannel(f.db, member.id, f.org.id, roadmap.id, { categoryId: null });
  // …but not someone else's.
  await expect(placeChannel(f.db, member.id, f.org.id, f.general.id, { categoryId: cat.id })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  await expect(deleteChannelCategory(f.db, member.id, f.org.id, cat.id)).rejects.toBeInstanceOf(ForbiddenError);
});

test("placing a channel puts it before another one, or at the end, and renumbers", async () => {
  const cat = await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Marketing" });
  const a = await createChannel(f.db, f.owner.id, f.org.id, { name: "marketing", categoryId: cat.id });
  const b = await createChannel(f.db, f.owner.id, f.org.id, { name: "campanhas", categoryId: cat.id });
  const c = await createChannel(f.db, f.owner.id, f.org.id, { name: "conteudo" });
  // Nobody arranged it yet: by name.
  expect((await sidebar())[1]).toEqual(["Marketing", ["campanhas", "marketing"]]);
  await placeChannel(f.db, f.owner.id, f.org.id, a.id, { categoryId: cat.id, beforeChannelId: b.id });
  expect((await sidebar())[1]).toEqual(["Marketing", ["marketing", "campanhas"]]);
  await placeChannel(f.db, f.owner.id, f.org.id, c.id, { categoryId: cat.id, beforeChannelId: b.id });
  expect((await sidebar())[1]).toEqual(["Marketing", ["marketing", "conteudo", "campanhas"]]);
  // Arranged by hand: a new channel goes to the end.
  await createChannel(f.db, f.owner.id, f.org.id, { name: "anuncios", categoryId: cat.id });
  expect((await sidebar())[1]).toEqual(["Marketing", ["marketing", "conteudo", "campanhas", "anuncios"]]);
});

test("categories reorder, and deleting one sends its channels to the top in their order", async () => {
  const x = await createChannel(f.db, f.owner.id, f.org.id, { name: "x-one" });
  const y = await createChannel(f.db, f.owner.id, f.org.id, { name: "a-two" });
  const eng = await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Engenharia", channelIds: [x.id, y.id] });
  const mkt = await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Marketing" });
  await placeChannelCategory(f.db, f.owner.id, f.org.id, mkt.id, { beforeCategoryId: eng.id });
  expect((await listChannelCategories(f.db, f.owner.id, f.org.id)).map((c) => c.name)).toEqual([
    "Marketing",
    "Engenharia",
  ]);
  await placeChannelCategory(f.db, f.owner.id, f.org.id, mkt.id, { beforeCategoryId: null });
  expect((await listChannelCategories(f.db, f.owner.id, f.org.id)).map((c) => c.name)).toEqual([
    "Engenharia",
    "Marketing",
  ]);
  await deleteChannelCategory(f.db, f.owner.id, f.org.id, eng.id);
  expect(await sidebar()).toEqual([
    [null, ["general", "x-one", "a-two"]],
    ["Marketing", []],
  ]);
});

test("another org's category or channel is not found; every change tells the org to refetch", async () => {
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  const [foreign] = await f.db
    .insert(schema.channelCategories)
    .values({ orgId: other?.id ?? "", name: "Theirs" })
    .returning();
  await expect(
    createChannel(f.db, f.owner.id, f.org.id, { name: "leak", categoryId: foreign?.id ?? "" }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    placeChannel(f.db, f.owner.id, f.org.id, f.general.id, { categoryId: foreign?.id ?? "" }),
  ).rejects.toBeInstanceOf(NotFoundError);

  const seen: unknown[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => seen.push(e));
  await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Suporte" }, { pubsub: f.pubsub });
  expect(seen).toEqual([{ type: "org.broadcast", orgId: f.org.id, event: { type: "channels.layout" } }]);
});
