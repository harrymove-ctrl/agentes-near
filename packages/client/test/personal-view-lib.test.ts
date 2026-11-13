import { describe, expect, test } from "bun:test";
import type { OrgRole } from "../src/api/types";
import {
  isSolo,
  keeperKey,
  keeperName,
  modeSwitchLines,
  othersHere,
  PERSONAL_SETTINGS,
  personalHelperRole,
  personalRoleKey,
  personalSettingsHost,
  personalSettingsNav,
  rolePicksInSight,
  settingsSectionNameKey,
  settingsSectionTextKey,
} from "../src/lib/personal-view";

/* What a personal workspace shows (ADR 0159): only the view changes, for the web and the phone app alike. */

const personal = { mode: "personal" as const };
const team = { mode: "team" as const };
const sections = (ids: string[]) => ids.map((id) => ({ id }));

describe("a personal workspace's settings list", () => {
  test("the six first in their order, then every other section the person may open, in its usual order", () => {
    const open = sections([
      "account",
      "notifications",
      "general",
      "members",
      "roles",
      "vault",
      "connectors",
      "skills",
      "devices",
      "usage",
      "storage",
      "billing",
    ]);
    const { main, advanced } = personalSettingsNav(open);
    // The web's section is Devices; the phone's is Computers: each lists its own.
    expect(main.map((s) => s.id)).toEqual(PERSONAL_SETTINGS.filter((id) => id !== "computers"));
    expect(personalSettingsNav(sections(["account", "computers"])).main.map((s) => s.id)).toEqual([
      "account",
      "computers",
    ]);
    // Billing is on AI and usage's page, not listed again.
    expect(advanced.map((s) => s.id)).toEqual(["notifications", "members", "roles", "skills", "storage"]);
  });

  test("with other people here, People joins the short list after About you; alone or unknown, it doesn't", () => {
    const open = sections(["account", "general", "members", "roles", "vault", "usage", "connectors", "computers"]);
    expect(personalSettingsNav(open, 1).main.map((s) => s.id)).toEqual([
      "account",
      "general",
      "members",
      "usage",
      "connectors",
      "vault",
      "computers",
    ]);
    expect(personalSettingsNav(open, 1).advanced.map((s) => s.id)).toEqual(["roles"]);
    expect(personalSettingsNav(open, 0).advanced.map((s) => s.id)).toEqual(["members", "roles"]);
    expect(personalSettingsNav(open).advanced.map((s) => s.id)).toEqual(["members", "roles"]);
  });

  test("a section the person can't open is left out; a part whose page they can't open stays under Advanced", () => {
    const { main, advanced } = personalSettingsNav(sections(["account", "vault", "billing", "skills"]));
    expect(main.map((s) => s.id)).toEqual(["account", "vault"]);
    expect(advanced.map((s) => s.id)).toEqual(["billing", "skills"]);
  });

  test("a part's page: AI and usage for billing, when it opens", () => {
    const open = new Set(["connectors", "usage"]);
    expect(personalSettingsHost("billing", open)).toBe("usage");
    expect(personalSettingsHost("skills", open)).toBeNull();
    expect(personalSettingsHost("vault", open)).toBeNull();
    expect(personalSettingsHost("billing", new Set(["connectors"]))).toBeNull();
  });

  test("names and lines: a personal workspace's own for the sections it renames, the usual ones elsewhere", () => {
    expect(settingsSectionNameKey(personal, "general")).toBe("settings.section.generalPersonal");
    expect(settingsSectionNameKey(personal, "usage")).toBe("settings.section.usage");
    expect(settingsSectionTextKey(personal, "usage")).toBe("settings.sectionText.usagePersonal");
    expect(settingsSectionNameKey(personal, "vault")).toBe("settings.section.vault");
    expect(settingsSectionNameKey(team, "general")).toBe("settings.section.general");
    // An older server says no mode: a team's.
    expect(settingsSectionNameKey({}, "usage")).toBe("settings.section.usage");
    expect(settingsSectionTextKey(personal, "connectors")).toBe("settings.sectionText.connectorsPersonal");
    expect(settingsSectionNameKey(personal, "members")).toBe("settings.section.membersPersonal");
    expect(settingsSectionTextKey(personal, "roles")).toBe("settings.sectionText.rolesPersonal");
    expect(settingsSectionTextKey(personal, "audit")).toBe("settings.sectionText.audit");
    expect(settingsSectionTextKey(team, "roles")).toBe("settings.sectionText.roles");
    expect(settingsSectionTextKey(team, "connectors")).toBe("settings.sectionText.connectors");
  });
});

describe("switching the mode", () => {
  test("to a team's: what comes into sight", () => {
    expect(modeSwitchLines("team", 3).map((l) => l.key)).toEqual([
      "personalMode.toTeam.channels",
      "personalMode.toTeam.roles",
      "personalMode.toTeam.admin",
    ]);
  });

  test("to personal: what changes, and that the others see it too only when there are others", () => {
    expect(modeSwitchLines("personal", 0).map((l) => l.key)).not.toContain("personalMode.toPersonal.others");
    const lines = modeSwitchLines("personal", 2);
    expect(lines.at(-1)).toEqual({ icon: "members", key: "personalMode.toPersonal.others", count: 2 });
    expect(lines).toHaveLength(5);
  });
});

describe("inviting in a personal workspace", () => {
  const role = (over: Partial<OrgRole>): OrgRole => ({
    id: "r",
    kind: "custom",
    name: "Role",
    icon: "shield",
    color: "indigo",
    position: 0,
    permissions: [],
    mentionable: false,
    hoist: false,
    people: 0,
    editable: true,
    givable: true,
    ...over,
  });

  test("helps run it: the highest role the inviter may give that holds administrator", () => {
    const roles = [
      role({ id: "everyone", kind: "everyone", position: 9, permissions: ["post"] }),
      role({ id: "editor", position: 1, permissions: ["edit_wiki"] }),
      role({ id: "admin-2", position: 2, permissions: ["administrator"] }),
      role({ id: "admin", position: 0, permissions: ["administrator"] }),
    ];
    expect(personalHelperRole(roles)?.id).toBe("admin");
  });

  test("none to give (an Admin above the inviter's own): no second choice", () => {
    expect(personalHelperRole([role({ permissions: ["administrator"], givable: false })])).toBeNull();
    expect(personalHelperRole([role({ permissions: ["edit_wiki"] })])).toBeNull();
  });

  test("a role's plain words: no role uses the agents, the helper helps run it, any other has its name", () => {
    const roles = [
      role({ id: "everyone", kind: "everyone", position: 9 }),
      role({ id: "admin", position: 0, permissions: ["administrator"] }),
      role({ id: "editor", position: 1, permissions: ["edit_wiki"] }),
    ];
    expect(personalRoleKey(roles, null)).toBe("members.dialog.role.uses");
    expect(personalRoleKey(roles, "admin")).toBe("members.dialog.role.helps");
    expect(personalRoleKey(roles, "editor")).toBeNull();
    expect(personalRoleKey([], "admin")).toBeNull();
  });

  test("a Roles group: always in a team's; personal, only with a role besides Everyone and Admin, or one picked", () => {
    const seeded = [
      role({ id: "everyone", kind: "everyone", position: 9 }),
      role({ id: "admin", position: 0, permissions: ["administrator"] }),
    ];
    expect(rolePicksInSight(team, seeded)).toBe(true);
    expect(rolePicksInSight({}, seeded)).toBe(true);
    expect(rolePicksInSight(personal, seeded)).toBe(false);
    expect(rolePicksInSight(personal, seeded, ["admin"])).toBe(true);
    expect(rolePicksInSight(personal, [...seeded, role({ id: "kids", permissions: ["post"] })])).toBe(true);
  });
});

describe("alone in a personal workspace", () => {
  const people = [
    { userId: "me", name: "Walter White", role: "owner" as const },
    { userId: "ana", name: "Ana Souza", role: "member" as const, roleIds: ["admin"] },
    { userId: "bia", name: "Bia", role: "member" as const },
  ];

  test("the others count leaves the viewer out; alone only once it is known to be 0", () => {
    expect(othersHere(people, "me")).toBe(2);
    expect(othersHere(people.slice(0, 1), "me")).toBe(0);
    expect(isSolo(personal, 0)).toBe(true);
    expect(isSolo(personal, undefined)).toBe(false);
    expect(isSolo(personal, 1)).toBe(false);
    expect(isSolo(team, 0)).toBe(false);
  });

  test("who runs it besides me, by first name: the one owner or administrator; none or several, no name", () => {
    const admin = [{ id: "admin", permissions: ["administrator"] }];
    expect(keeperName(people, "bia")).toBe("Walter");
    expect(keeperName(people, "bia", admin)).toBeNull();
    expect(keeperName(people, "ana", admin)).toBe("Walter");
    expect(keeperName(people, "me", admin)).toBe("Ana");
    expect(keeperName(people.slice(0, 1), "me")).toBeNull();
  });

  test("a note on who may change it: a team's key; personal, naming who runs it, or without a name", () => {
    expect(keeperKey(team, "Walter", "agentPage.lock.admins")).toBe("agentPage.lock.admins");
    expect(keeperKey({}, "Walter", "agentPage.lock.admins")).toBe("agentPage.lock.admins");
    expect(keeperKey(personal, "Walter", "agentPage.lock.admins")).toBe("agentPage.lock.adminsKeeper");
    expect(keeperKey(personal, null, "agentPage.lock.admins")).toBe("agentPage.lock.adminsPersonal");
  });
});
