import { describe, expect, test } from "bun:test";
import { insertMention, mentionOptions, mentionQuery, splitMatch } from "../../src/features/chat/mentions";
import {
  accountChanges,
  accountProblem,
  handleErrorKey,
  normalizeHandle,
  openIssuesWithMe,
  photoContentType,
} from "../../src/features/me/logic";

const agents = [
  { id: "a1", name: "Theo", handle: "theo", role: "Marketing" },
  { id: "a2", name: "Infra", handle: "infra", role: "Servidores" },
  { id: "a3", name: "Atlas", handle: "atlas", role: "Dev", canTalk: false },
];
const people = [
  { userId: "me", name: "Walter", handle: "walter", email: "w@x.com" },
  { userId: "u1", name: "Rafa", handle: "rath", email: "rafa@x.com" },
  { userId: "u2", name: "João", handle: "joao", email: "jj@x.com" },
];

describe("@ picker", () => {
  test("query right before the caret", () => {
    expect(mentionQuery("oi @ad", 6)).toEqual({ start: 3, query: "ad" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("joao@acme", 9)).toBeNull();
    expect(mentionQuery("@ada ", 5)).toBeNull();
    expect(mentionQuery("Pede pro @th e mais", 12)).toEqual({ start: 9, query: "th" });
    expect(mentionQuery("(@th", 4)).toEqual({ start: 1, query: "th" });
  });

  test("channel members first, then outside; me and agents I can't talk to are left out", () => {
    const members = new Set(["agent:a1", "person:u1"]);
    const o = mentionOptions({ query: "th", agents, people, meId: "me", members });
    expect(o.map((x) => x.key)).toEqual(["agent:a1", "person:u1"]);
    expect(o[0]?.match).toEqual({ in: "name", start: 0, end: 2 });
    expect(o[1]?.match).toEqual({ in: "handle", start: 2, end: 4 });
    const all = mentionOptions({ query: "", agents, people, meId: "me", members });
    expect(all.map((x) => x.key)).toEqual(["person:u1", "agent:a1", "agent:a2", "person:u2"]);
    expect(all.find((x) => x.id === "a2")?.inChannel).toBe(false);
    expect(all.some((x) => x.id === "me" || x.id === "a3")).toBe(false);
  });

  test("the right hand is in every channel: an @mention reaches it there, with nothing to add", () => {
    const lodi = { id: "rh", name: "Lodi", handle: "lodi", role: null, builtin: "right_hand" as const };
    const [o] = mentionOptions({ query: "lo", agents: [...agents, lodi], people, meId: "me", members: new Set() });
    expect(o).toMatchObject({ id: "rh", inChannel: true });
  });

  test("filters by name, handle or e-mail, accents folded; starts-with ranks first", () => {
    expect(mentionOptions({ query: "jo", agents, people, meId: "me", members: null }).map((x) => x.id)).toEqual(["u2"]);
    expect(mentionOptions({ query: "joã", agents, people, meId: null, members: null })[0]?.id).toBe("u2");
    expect(mentionOptions({ query: "rafa@", agents, people, meId: null, members: null })[0]?.id).toBe("u1");
    const r = mentionOptions({ query: "r", agents, people, meId: "me", members: null });
    expect(r[0]?.id).toBe("u1"); // "Rafa" starts with r; "Infra"/"Servidores" only contain it
    expect(r.every((x) => x.inChannel)).toBe(true);
  });

  test("respects the limit", () => {
    expect(mentionOptions({ query: "", agents, people, meId: null, members: null, limit: 2 })).toHaveLength(2);
  });

  test("insert @handle + space in place of the query, caret after it", () => {
    expect(insertMention("oi @ad", { start: 3, query: "ad" }, "ada")).toEqual({ text: "oi @ada ", caret: 8 });
    expect(insertMention("@th tudo bem", { start: 0, query: "th" }, "theo")).toEqual({
      text: "@theo tudo bem",
      caret: 6,
    });
  });

  test("split the label around the match", () => {
    expect(splitMatch("Theo", { start: 0, end: 2 })).toEqual(["", "Th", "eo"]);
    expect(splitMatch("Theo", null)).toEqual(["Theo", "", ""]);
  });
});

describe("Conta", () => {
  const initial = { name: "Walter", handle: "walter", zone: "America/Sao_Paulo" };

  test("handle is normalized and validated like the server", () => {
    expect(normalizeHandle("  @Ana ")).toBe("ana");
    expect(accountProblem({ ...initial, handle: "a" })).toBe("handleInvalid");
    expect(accountProblem({ ...initial, handle: "Ana_2" })).toBeNull();
    expect(accountProblem({ ...initial, handle: "-ana" })).toBe("handleInvalid");
    expect(accountProblem({ ...initial, name: "  " })).toBe("nameEmpty");
  });

  test("only what changed is saved", () => {
    expect(accountChanges(initial, initial)).toEqual({});
    expect(accountChanges(initial, { ...initial, name: " Walt " })).toEqual({ name: "Walt" });
    expect(accountChanges(initial, { ...initial, handle: "@Walter" })).toEqual({});
    expect(accountChanges(initial, { ...initial, handle: "walt", zone: null })).toEqual({
      profile: { handle: "walt", timezone: null },
    });
  });

  test("server errors for the handle", () => {
    expect(handleErrorKey("handle.taken")).toBe("handleTaken");
    expect(handleErrorKey("handle.taken_by_agent")).toBe("handleAgent");
    expect(handleErrorKey("handle.invalid")).toBe("handleInvalid");
    expect(handleErrorKey("other")).toBeNull();
  });

  test("photo type the upload accepts", () => {
    expect(photoContentType("image/png")).toBe("image/png");
    expect(photoContentType(null, "a.webp")).toBe("image/webp");
    // The bytes decide over the reported type: a cropped PNG comes back as JPEG bytes still called PNG.
    expect(photoContentType("image/png", "logo.png", "/9j/4AAQSkZJRg")).toBe("image/jpeg");
    expect(photoContentType("image/jpeg", null, "iVBORw0KGgoAAAANSUhEUg")).toBe("image/png");
    expect(photoContentType(null, null, "data:image/webp;base64,UklGRiQAAABXRUJQ")).toBe("image/webp");
    expect(photoContentType("image/heic", "a.heic")).toBe("image/jpeg");
  });

  test("open issues with me", () => {
    const issues = [
      { status: "todo", assignee: { type: "person", id: "me" } },
      { status: "done", assignee: { type: "person", id: "me" } },
      { status: "in_review", assignee: { type: "person", id: "me" } },
      { status: "todo", assignee: { type: "agent", id: "me" } },
      { status: "todo", assignee: null },
    ];
    expect(openIssuesWithMe(issues, "me")).toBe(2);
    expect(openIssuesWithMe(issues, null)).toBe(0);
  });
});
