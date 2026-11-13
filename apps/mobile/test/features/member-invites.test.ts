import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BatchInviteResult, InvitationWithStatus, OrgRole } from "@agenteschat/client";
import {
  addressesLeft,
  addressState,
  batchNews,
  focusedFirst,
  invitationLine,
  invitationRoles,
  invitationSender,
  invitersOf,
  joinRoleWord,
  memberLine,
  offeredChannels,
  pendingInvitations,
  readTyped,
  requestChips,
  sentWords,
  suggestRefusal,
  waitingLine,
  whenWords,
  withAddresses,
} from "../../src/features/members/logic";
import { translator } from "./fixtures";

const NOW = new Date("2026-10-31T12:00:00Z");
const DAY = 86_400_000;
const later = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

const role = (over: Partial<OrgRole> & { id: string; name: string }) =>
  ({ kind: "custom", position: 1, permissions: [], givable: true, ...over }) as OrgRole;
const ADMIN = role({ id: "r-admin", name: "Admin", position: 0, permissions: ["administrator"] });
const SALES = role({ id: "r-sales", name: "Vendas", permissions: ["post"] });
const ROLES = [ADMIN, SALES];

const invitation = (over: Partial<InvitationWithStatus> & { id: string }): InvitationWithStatus => ({
  email: "rafael@acme.com",
  role: "member",
  roleIds: [],
  status: "pending",
  expiresAt: later(6),
  createdAt: later(-1),
  ...over,
});

describe("Membros e convites (ADR 0090)", () => {
  test("a request says how it came; only an unproven ask through the link reads as unverified", async () => {
    const pt = await translator("pt-BR");
    const asked = { email: "rui@acme.com", createdAt: later(-5), verified: false, confirmed: false };
    expect(waitingLine(pt, "pt-BR", asked, NOW)).toStartWith("Pediu pelo link em ");
    expect(waitingLine(pt, "pt-BR", asked, NOW)).toContain("rui@acme.com · não verificado");
    const suggested = { ...asked, suggestedBy: "Ana" };
    expect(waitingLine(pt, "pt-BR", suggested, NOW)).toStartWith("Ana sugeriu ");
    expect(waitingLine(pt, "pt-BR", suggested, NOW)).not.toContain("verificado");
  });

  test("a suggestion's chips name who suggested it: nobody at that address asked", async () => {
    const en = await translator("en");
    const chips = requestChips(
      en,
      "en",
      { createdAt: later(-5), verified: false, confirmed: false, suggestedBy: "Ana" },
      NOW,
    );
    expect(chips.unverified).toBeNull();
    expect(chips.asked).toContain("Ana");
  });

  test("the tapped request comes first, the others in their order", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(focusedFirst(list, "c").map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(focusedFirst(list, undefined).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("when something happened: words up to yesterday, then the date", async () => {
    const pt = await translator("pt-BR");
    expect(whenWords(pt, "pt-BR", later(-5), NOW)).toStartWith("em ");
    expect(whenWords(pt, "pt-BR", NOW.toISOString(), NOW)).not.toStartWith("em ");
  });

  test("only invitations that still work are listed, the newest first", () => {
    const list = [
      invitation({ id: "old", createdAt: later(-3) }),
      invitation({ id: "new", createdAt: later(-1) }),
      invitation({ id: "expired", status: "expired" }),
      // Past its date, whatever the list said when it loaded.
      invitation({ id: "past", expiresAt: later(-1) }),
    ];
    expect(pendingInvitations(list, NOW).map((i) => i.id)).toEqual(["new", "old"]);
  });

  test("an invitation's roles and line", async () => {
    const pt = await translator("pt-BR");
    const inv = invitation({ id: "i", roleIds: [ADMIN.id] });
    expect(invitationRoles(pt, invitation({ id: "m" }), ROLES)).toBe("Membro");
    expect(invitationRoles(pt, invitation({ id: "o", role: "owner" }), ROLES)).toBe("Dono");
    expect(invitationRoles(pt, invitation({ id: "t", roleIds: [ADMIN.id, SALES.id] }), ROLES)).toBe("Admin, Vendas");
    expect(invitationLine(pt, "pt-BR", inv, ROLES, {}, NOW)).toBe("Admin · expira em 6 dias");
    const sender = invitationSender(pt, { invitedBy: "Ana" }, "Ana");
    expect(invitationLine(pt, "pt-BR", inv, ROLES, { sender }, NOW)).toBe("Admin · convite seu · expira em 6 dias");
    const resent = invitationLine(pt, "pt-BR", inv, ROLES, { resentUntil: later(7) }, NOW);
    expect(resent).toStartWith("Admin · mandado de novo · vale até ");
  });

  test("who sent an invitation", async () => {
    const pt = await translator("pt-BR");
    expect(invitationSender(pt, { invitedBy: "Ana" }, "Rui")).toBe("convite de Ana");
    expect(invitationSender(pt, { invitedBy: null }, "Rui")).toBeNull();
  });

  test("a server without email has nothing to send again: its words say so", async () => {
    const pt = await translator("pt-BR");
    const date = "7 nov";
    const email = "rafael@acme.com";
    expect(pt(`members.invitations.${sentWords(true).resent}`, { email, date })).toContain("O link é o mesmo");
    expect(pt(`members.invitations.${sentWords(false).resent}`, { email, date })).not.toContain("Mandei");
    expect(sentWords(true).newLink).toBe("newLink");
    expect(sentWords(false).copied).toBe("copiedNoEmail");
  });

  test("a person's line: their @handle, their role, or Membro, then when they were here", async () => {
    const pt = await translator("pt-BR");
    const joinedAt = later(-30);
    const person = { role: "member" as const, roleIds: [], online: true, lastSeenAt: null, joinedAt };
    expect(memberLine(pt, "pt-BR", person, ROLES, NOW)).toBe("Membro · ativo agora");
    const admin = { ...person, roleIds: [ADMIN.id], online: false, lastSeenAt: later(-5) };
    expect(memberLine(pt, "pt-BR", admin, ROLES, NOW)).toStartWith("Admin · ativo ");
    const fresh = { ...person, online: false };
    expect(memberLine(pt, "pt-BR", fresh, ROLES, NOW)).toStartWith("Membro · entrou ");
    expect(memberLine(pt, "pt-BR", { ...person, handle: "bia" }, ROLES, NOW)).toBe("@bia · Membro · ativo agora");
  });

  test("who invites: owners and whoever holds a role that gives it, administrators included", () => {
    const inviter = role({ id: "r-hr", name: "RH", permissions: ["invite_people"] });
    const people = [
      { name: "Ana", role: "owner" as const, roleIds: [] },
      { name: "Marina", role: "member" as const, roleIds: [ADMIN.id] },
      { name: "Bia", role: "member" as const, roleIds: [inviter.id] },
      { name: "João", role: "member" as const, roleIds: [SALES.id] },
    ];
    expect(invitersOf(people, [...ROLES, inviter])).toEqual(["Ana", "Marina", "Bia"]);
  });

  test("a suggestion's refusals are about the person suggested; anything else is the app's", () => {
    expect(suggestRefusal("join.member")).toBe("member");
    expect(suggestRefusal("join.invalid_email")).toBe("invalid");
    expect(suggestRefusal("rate_limited")).toBeUndefined();
    expect(suggestRefusal(null)).toBeUndefined();
  });
});

describe("Convidar pessoas (ADR 0090 §5)", () => {
  test("addresses are read the way they're pasted, once each, each with no role yet", () => {
    const list = withAddresses([], 'Ana Silva <ana@acme.com>, "rui@acme.com"; mailto:bia@acme.com');
    expect(list.map((a) => a.email)).toEqual(["ana@acme.com", "rui@acme.com", "bia@acme.com"]);
    expect(list.every((a) => a.valid && a.roleId === null)).toBe(true);
    const picked = [{ email: "ana@acme.com", valid: true, roleId: ADMIN.id }];
    expect(withAddresses(picked, "ANA@acme.com lia@acme.com")).toEqual([
      ...picked,
      { email: "lia@acme.com", valid: true, roleId: null },
    ]);
    expect(withAddresses([], "ana@")).toEqual([{ email: "ana@", valid: false, roleId: null }]);
  });

  test("typing stays in the field until a separator; a pasted list goes at once", () => {
    expect(readTyped("an", "ana")).toEqual({ add: "", keep: "ana" });
    expect(readTyped("ana@acme.com", "ana@acme.com,")).toEqual({ add: "ana@acme.com,", keep: "" });
    expect(readTyped("ana@acme.com", "ana@acme.com ")).toEqual({ add: "ana@acme.com ", keep: "" });
    expect(readTyped("", "a@acme.com, b@acme.com")).toEqual({ add: "a@acme.com, b@acme.com", keep: "" });
    expect(readTyped("", "Ana <a@acme.com>")).toEqual({ add: "Ana <a@acme.com>", keep: "" });
    // One address pasted stays to be finished or fixed; only separators leave nothing.
    expect(readTyped("", "ana@acme.com")).toEqual({ add: "", keep: "ana@acme.com" });
    expect(readTyped("", ",")).toEqual({ add: "", keep: "" });
    expect(readTyped("a", "")).toEqual({ add: "", keep: "" });
  });

  test("someone in or invited already is said and left out of the send", () => {
    const members = new Set(["joao@acme.com"]);
    const invited = new Set(["bia@acme.com"]);
    expect(addressState({ email: "joao@acme.com", valid: true }, members, invited)).toBe("member");
    expect(addressState({ email: "bia@acme.com", valid: true }, members, invited)).toBe("invited");
    expect(addressState({ email: "rui@acme.com", valid: true }, members, invited)).toBe("ok");
    expect(addressState({ email: "rui@", valid: false }, members, invited)).toBe("bad");
  });

  test("only addresses to fix stay after sending", () => {
    const addresses = [
      { email: "ana@acme.com", valid: true, roleId: null },
      { email: "rui@acme.com", valid: true, roleId: null },
      { email: "x@bad", valid: true, roleId: null },
      { email: "nope", valid: false, roleId: null },
    ];
    const results: BatchInviteResult[] = [
      { email: "ana@acme.com", status: "invited" },
      { email: "rui@acme.com", status: "already_member" },
      { email: "x@bad", status: "invalid_email" },
    ];
    expect(addressesLeft(addresses, results).map((a) => a.email)).toEqual(["x@bad", "nope"]);
  });

  test("one toast says the whole batch", async () => {
    const pt = await translator("pt-BR");
    const one: BatchInviteResult = { email: "ana@acme.com", status: "invited" };
    const two: BatchInviteResult = { email: "rui@acme.com", status: "invited" };
    const refused: BatchInviteResult = { email: "joao@acme.com", status: "already_member" };
    expect(batchNews(pt, [one], [])).toEqual({ title: "Convite enviado para ana@acme.com.", failed: false });
    const many = batchNews(pt, [one, two, refused], ["#produto", "#vendas"]);
    expect(many?.title).toBe("2 convites enviados.");
    expect(many?.subtitle).toContain("#produto");
    expect(many?.subtitle).toContain("#vendas");
    expect(many?.subtitle).toContain("joao@acme.com");
    expect(many?.failed).toBe(false);
    const none = batchNews(pt, [refused], ["#produto"]);
    expect(none?.title).toContain("joao@acme.com");
    expect(none?.subtitle).toBeUndefined();
    expect(none?.failed).toBe(true);
    expect(batchNews(pt, [], [])).toBeNull();
  });

  test("channels: the public ones and the private ones I'm in; #general goes without choosing", () => {
    const channel = (id: string, name: string, visibility: "public" | "private", isMember: boolean) => ({
      id,
      name,
      visibility,
      isMember,
    });
    const { general, others } = offeredChannels([
      channel("c1", "general", "public", true),
      channel("c2", "produto", "public", false),
      channel("c3", "diretoria", "private", true),
      channel("c4", "folha", "private", false),
    ]);
    expect(general?.id).toBe("c1");
    expect(others.map((c) => c.name)).toEqual(["produto", "diretoria"]);
  });
});

describe("Invite people in a personal workspace (ADR 0159 §4)", () => {
  const src = (file: string) =>
    readFileSync(join(import.meta.dir, "..", "..", "src", "features", "members", file), "utf8");

  test("each address's role in plain words: uses the agents, helps run it, any other role by its name", async () => {
    const pt = await translator("pt-BR");
    expect(joinRoleWord(pt, ROLES, null, true)).toBe("Usa os agentes");
    expect(joinRoleWord(pt, ROLES, ADMIN.id, true)).toBe("Ajuda a cuidar daqui");
    expect(joinRoleWord(pt, ROLES, SALES.id, true)).toBe("Vendas");
    // A role no longer there reads as no role.
    expect(joinRoleWord(pt, ROLES, "r-gone", true)).toBe("Usa os agentes");
    // A team's workspace: Membro, or the role's own name.
    expect(joinRoleWord(pt, ROLES, null, false)).toBe("Membro");
    expect(joinRoleWord(pt, ROLES, ADMIN.id, false)).toBe("Admin");
  });

  test("it asks first who they are: family goes on, work switches it on the mode screen, locked for the rest", () => {
    const invite = src("InvitePeople.tsx");
    expect(invite).toContain("if (personal && !family) return <WhoQuestion onFamily={() => setFamily(true)} />;");
    expect(invite).toContain('router.push("/settings/mode")');
    expect(invite).toContain('t(switches ? "personalMode.invite.workText" : "personalMode.invite.workLocked")');
    expect(invite).toContain("joinRoleWord(t, roles, a.roleId, personal)");
  });

  test("the role sheet offers the two plain choices first, then every other role this person may give", () => {
    const sheets = src("InviteSheets.tsx");
    expect(sheets).toContain('label: personal ? t("members.dialog.role.uses") : t("roles.member"),');
    expect(sheets).toContain("...givable.filter((r) => r.key !== helper.id),");
  });
});

describe("Convidar pessoas while it sends", () => {
  test("whoever is being invited never reads as invited already: the rows keep the lists from before Convidar", () => {
    const invite = readFileSync(join(import.meta.dir, "../../src/features/members/InvitePeople.tsx"), "utf8");
    expect(invite).toContain(
      "const members = useHeldWhile(new Set(people.map((m) => m.email.toLowerCase())), inviteMany.isPending);",
    );
    expect(invite).toMatch(
      /const invited = useHeldWhile\(\s*new Set\(pendingInvitations\(invitations\)[^;]*\),\s*inviteMany\.isPending,\s*\);/,
    );
  });
});
