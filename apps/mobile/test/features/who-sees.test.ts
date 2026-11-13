import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audienceKind, audienceOfKind, pickedOf, wikiAudienceOf } from "@agenteschat/client/lib/who-sees";
import { buildConversations } from "../../src/features/chats/logic";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("Quem vê on the phone", () => {
  test("a new task and the task's sheet reach the same options; the task shows when it's limited", () => {
    expect(src("features/issues/NewIssueForm.tsx")).toContain("audience: sees.choice");
    const screen = src("features/issues/IssueScreen.tsx");
    expect(screen).toContain('pathname: "/who-sees"');
    expect(screen).toContain('i.audience?.mode === "people"');
    expect(audienceOfKind("me", [], "me")).toEqual({ mode: "people", userIds: ["me"] });
    expect(audienceKind({ mode: "people", userIds: ["me", "ana"] }, "me")).toBe("people");
  });

  test("a wiki page's menu opens it; an agent's receipt says nothing of it (the task's screen does)", () => {
    expect(src("features/wiki/WikiScreen.tsx")).toContain('pathname: "/who-sees", params: { slug: p.slug }');
    expect(src("features/chat/Receipts.tsx")).not.toContain("/who-sees");
    expect(src("features/chat/Receipts.tsx")).not.toContain("whoSees.");
  });
});

describe("an administrator's channels on the phone", () => {
  test("a channel they aren't in stays off the conversations and waits at the end of the home", () => {
    const rows = buildConversations({
      channels: [{ id: "c", name: "diretoria", isMember: false, seenAsAdmin: true }] as never,
      dms: [],
      threads: [],
    });
    expect(rows).toEqual([]);
    expect(src("features/chats/ChatsScreen.tsx")).toContain("c.seenAsAdmin");
  });

  test("they read it before joining, and Entrar stays where the composer goes", () => {
    const chat = src("features/chat/ChatScreen.tsx");
    expect(chat).toContain("const readable = member || admin;");
    expect(chat).toContain('t("channel.adminReading")');
  });
});

test("a list starts as it is, and only me on a page leaves its roles out", () => {
  expect([...pickedOf({ mode: "people", userIds: ["ana"] }, "me")]).toEqual(["ana"]);
  expect([...pickedOf({ mode: "everyone" }, "me")]).toEqual(["me"]);
  expect(wikiAudienceOf({ mode: "everyone" }, ["r"], "everyone")).toBeNull();
  expect(wikiAudienceOf({ mode: "people", userIds: ["me"] }, ["r"], "me")).toEqual({ roleIds: [], userIds: ["me"] });
  expect(wikiAudienceOf({ mode: "people", userIds: ["me"] }, ["r"], "people")).toEqual({
    roleIds: ["r"],
    userIds: ["me"],
  });
});
