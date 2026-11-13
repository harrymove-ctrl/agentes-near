import { afterEach, expect, test } from "bun:test";
import { userTopic } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  addChannelMember,
  ConflictError,
  handleBase,
  listMembers,
  postPersonMessage,
  updateMyProfile,
  updateOrgSettings,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

test("handles come from the name without accents, unique per org", async () => {
  expect(handleBase("Ana Souza", "a@x.com")).toBe("ana");
  expect(handleBase("João Pedro", "j@x.com")).toBe("joao");
  expect(handleBase("", "bia.costa@x.com")).toBe("biacosta");
  f = await setup();
  await addMember(f.db, f.org.id, "member", "Bia");
  await addMember(f.db, f.org.id, "member", "bia");
  const members = await listMembers(f.db, f.org.id);
  expect(members.map((m) => m.handle)).toEqual(["ana", "bia", "bia-2"]);
});

test("a person edits their handle and time zone; the org's zone is the default", async () => {
  f = await setup();
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { timezone: "America/Sao_Paulo" });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  expect((await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id)?.timezone).toBe("America/Sao_Paulo");
  await expect(updateMyProfile(f.db, bia.id, f.org.id, { handle: "B" })).rejects.toBeInstanceOf(ValidationError);
  await expect(updateMyProfile(f.db, bia.id, f.org.id, { handle: "dev" })).rejects.toBeInstanceOf(ConflictError);
  await expect(updateMyProfile(f.db, bia.id, f.org.id, { handle: "ana" })).rejects.toBeInstanceOf(ConflictError);
  const me = await updateMyProfile(f.db, bia.id, f.org.id, { handle: "@Bia_Costa", timezone: "Europe/Lisbon" });
  expect(me).toMatchObject({ handle: "bia_costa", timezone: "Europe/Lisbon" });
  await expect(updateMyProfile(f.db, bia.id, f.org.id, { timezone: "Mars/Base" })).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect((await updateMyProfile(f.db, bia.id, f.org.id, { timezone: null })).timezone).toBe("America/Sao_Paulo");
});

test("mentions of people resolve by handle, only for people in the channel, and notify them", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await listMembers(f.db, f.org.id); // assigns their handles
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const notified: string[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, bia.id), (e) => notified.push(e.type));
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@bia e @caio, olhem isso",
  });
  expect(message.mentionedUserIds).toEqual([bia.id]); // caio isn't in #general
  expect(message.mentionedAgentIds).toEqual([]);
  expect(notified).toContain("mention");
  expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
  expect(caio.id).toBeTruthy();
});
