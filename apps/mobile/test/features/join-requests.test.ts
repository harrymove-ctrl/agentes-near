import { describe, expect, test } from "bun:test";
import { ApiError } from "@agenteschat/client";
import { invitedErrorText } from "@agenteschat/client/lib/errors";
import { joinRequestLine, subtitleOf } from "../../src/features/activity/logic";
import { afterSignIn, boldParts, signInPurpose, storedInvite, storedInviteOf } from "../../src/features/auth/links";
import { membersByName, requestChips, roleLine } from "../../src/features/members/logic";
import { notification, translator } from "./fixtures";

const TOKEN = "k3J8sQ2xY7pL0vB4nM6cD1eF9gH5jK2a";

test("someone who accepted an invitation isn't named twice: the title says who (ADR 0090)", () => {
  const accepted = notification({ id: "a1", kind: "invitation_accepted", latest: { title: "Rui" } });
  expect(subtitleOf(accepted, () => "")).toBe("");
});

describe("an invitation remembered before signing in", () => {
  test("a link's page opens again, for the account to ask; an email invitation is accepted", () => {
    expect(afterSignIn(storedInvite(TOKEN, "link"))).toEqual({ open: `/invite/${TOKEN}` });
    expect(afterSignIn(storedInvite(TOKEN, "email"))).toEqual({ accept: TOKEN });
  });

  test("a bare token from an older build is an email invitation; nothing or garbage does nothing", () => {
    expect(afterSignIn(TOKEN)).toEqual({ accept: TOKEN });
    expect(afterSignIn(null)).toBeNull();
    expect(afterSignIn("link:../../etc")).toBeNull();
    expect(afterSignIn("link:")).toBeNull();
  });

  test("an email invitation opened from its email keeps the proof until it's accepted (ADR 0090)", () => {
    const mail = "p".repeat(43);
    expect(afterSignIn(storedInvite(TOKEN, "email", mail))).toEqual({ accept: TOKEN, mail });
    expect(storedInviteOf(storedInvite(TOKEN, "email", mail))).toEqual({ token: TOKEN, kind: "email", mail });
    // A link only asks, and a proof of any other shape confirms nothing: the invitation itself still works.
    expect(storedInvite(TOKEN, "link", mail)).toBe(`link:${TOKEN}`);
    expect(afterSignIn(`${TOKEN}.short`)).toEqual({ accept: TOKEN });
  });

  test("read back with its kind, so the sign-in can say where it leads", () => {
    expect(storedInviteOf(storedInvite(TOKEN, "link"))).toEqual({ token: TOKEN, kind: "link" });
    expect(storedInviteOf(storedInvite(TOKEN, "email"))).toEqual({ token: TOKEN, kind: "email" });
    expect(storedInviteOf("link:../../etc")).toBeNull();
    expect(storedInviteOf(null)).toBeNull();
  });
});

describe("a sign-in that says where it leads", () => {
  test("asking to join through a link, joining by an invitation; nothing for a link that no longer works", async () => {
    expect(signInPurpose({ orgName: "Acme", kind: "link" })).toEqual({ key: "auth.flow.toAsk", org: "Acme" });
    expect(signInPurpose({ orgName: "Acme", kind: "email" })).toEqual({ key: "auth.flow.toJoin", org: "Acme" });
    // A preview from before invitations said their kind is an email invitation.
    expect(signInPurpose({ orgName: "Acme" })?.key).toBe("auth.flow.toJoin");
    expect(signInPurpose({ orgName: "Acme", kind: "link", closed: true })).toBeNull();
    expect(signInPurpose(undefined)).toBeNull();
    const en = await translator("en");
    const goal = signInPurpose({ orgName: "Acme", kind: "link" });
    expect(goal && en(goal.key, { org: goal.org })).toBe("To ask to join Acme.");
  });
});

describe("a denied request's note", () => {
  test("the label bold, the rest plain; markup only from the sentence, never from the person's words", async () => {
    const en = await translator("en");
    const stand = "\u2063";
    const parts = boldParts(en("invite.ask.reasonSaid", { reason: stand }));
    expect(parts).toEqual([
      { text: "Their note:", bold: true },
      { text: ` “${stand}”`, bold: false },
    ]);
    expect(boldParts("no markup")).toEqual([{ text: "no markup", bold: false }]);
  });
});

describe("someone asking to join, in Atividade", () => {
  test("the names of who asked, the first two and how many more, with their faces", async () => {
    const en = await translator("en");
    const one = notification({ id: "j1", kind: "join_request", actors: [], count: 1, latest: { names: ["Ana"] } });
    expect(joinRequestLine(en, one)).toEqual({ text: "Ana asks to join", faces: ["Ana"] });
    const two = notification({
      id: "j2",
      kind: "join_request",
      actors: [],
      count: 2,
      latest: { names: ["Ana", "Bia"] },
    });
    expect(joinRequestLine(en, two).text).toBe("Ana and Bia ask to join");
    const four = notification({
      id: "j4",
      kind: "join_request",
      actors: [],
      count: 4,
      latest: { names: ["Ana", "Bia", "Caio"] },
    });
    expect(joinRequestLine(en, four)).toEqual({ text: "Ana, Bia, and 2 more ask to join", faces: ["Ana", "Bia"] });
    // A notice from before it kept the names: the newest one's, and the others counted.
    const old = notification({ id: "j0", kind: "join_request", actors: [], count: 3, latest: { title: "Rui" } });
    expect(joinRequestLine(en, old).text).toBe("Rui and 2 more ask to join");
  });
});

describe("Membros", () => {
  test("people by name, whatever the case or accents", () => {
    const people = [{ name: "bruno" }, { name: "Álvaro" }, { name: "Ana" }];
    expect(membersByName(people, "pt-BR").map((p) => p.name)).toEqual(["Álvaro", "Ana", "bruno"]);
  });

  test("each person's roles: Dono first for an owner, then theirs top first; nothing for no role", async () => {
    const pt = await translator("pt-BR");
    const role = (id: string, name: string, position: number, kind: "custom" | "everyone" = "custom") => ({
      id,
      kind,
      name,
      icon: "shield",
      color: "indigo",
      position,
      permissions: [],
      mentionable: false,
      hoist: false,
      people: 1,
      editable: true,
    });
    const roles = [role("r2", "Financeiro", 1), role("r1", "Dev", 0), role("all", "Todos", 2, "everyone")];
    expect(roleLine(pt, { role: "owner", roleIds: ["r2", "r1"] }, roles)).toBe("Dono · Dev · Financeiro");
    expect(roleLine(pt, { role: "owner" }, roles)).toBe("Dono");
    expect(roleLine(pt, { role: "member", roleIds: ["r2", "all", "gone"] }, roles)).toBe("Financeiro");
    expect(roleLine(pt, { role: "member", roleIds: [] }, roles)).toBeUndefined();
  });
});

describe("a request to join, in the Requests sheet", () => {
  const now = new Date("2026-10-26T15:00:00.000Z");
  const createdAt = "2026-10-26T13:00:00.000Z";

  test("'Not verified' only where nobody proved the address, beside when it was asked", async () => {
    const en = await translator("en");
    const proven = requestChips(en, "en", { createdAt, verified: true, confirmed: false }, now);
    expect(proven.unverified).toBeNull();
    expect(proven.asked).toStartWith("Asked ");
    // A server without email, or a request typed before codes.
    const typed = { createdAt, verified: false, confirmed: false };
    expect(requestChips(en, "en", typed, now).unverified).toBe("Not verified");
    const pt = await translator("pt-BR");
    expect(requestChips(pt, "pt-BR", typed, now).unverified).toBe("Não verificado");
    expect(requestChips(pt, "pt-BR", typed, now).asked).toStartWith("Pediu ");
  });

  test("a server from before codes sends only `confirmed`: a confirmed account asking proved the address", async () => {
    const en = await translator("en");
    const old = (confirmed: boolean) =>
      ({ createdAt, confirmed }) as { createdAt: string; confirmed: boolean; verified: boolean };
    expect(requestChips(en, "en", old(true), now).unverified).toBeNull();
    expect(requestChips(en, "en", old(false), now).unverified).toBe("Not verified");
  });
});

test("invited to a full workspace: whom to tell, never its numbers", async () => {
  const full = new ApiError(409, "org.members_full", "This workspace is full", { members: 10, limit: 10 });
  for (const lng of ["pt-BR", "en"] as const) {
    const t = await translator(lng);
    expect(invitedErrorText(t, full)).toBe(t("errors.org.membersFull"));
    expect(invitedErrorText(t, full)).not.toMatch(/\d/);
  }
});
