import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrgRole, OrgRoles, Person } from "@agenteschat/client";
import { giveRole, keyState, newRoleInput, roleLock } from "@agenteschat/client/lib/roles";
import {
  areaChoices,
  COMPUTER_AREA,
  givesRole,
  roleAreaRows,
  roleCandidates,
  SETTINGS_SECTIONS,
  visibleSections,
} from "../../src/features/settings/logic";
import { translator } from "./fixtures";

const APP = join(import.meta.dir, "..", "..", "app", "(app)");

/** The server's areas (`PERMISSION_AREAS` in packages/engine/src/permissions.ts), as `GET …/roles` sends them. */
const AREAS: OrgRoles["areas"] = [
  { id: "chat", use: ["post", "create_channels"], keys: ["post", "create_channels", "manage_channels"] },
  {
    id: "tools",
    use: ["pair_computers"],
    keys: [
      "pair_computers",
      "own_browsers",
      "own_computers",
      "control_browsers",
      "control_computers",
      "manage_connectors",
      "manage_credentials",
    ],
  },
];

const role = (over: Partial<OrgRole> & { id: string }): OrgRole => ({
  kind: "custom",
  name: over.id,
  icon: "shield",
  color: "teal",
  position: 1,
  permissions: [],
  mentionable: false,
  hoist: false,
  people: 0,
  editable: true,
  givable: true,
  ...over,
});
const everyone = role({ id: "all", kind: "everyone", name: "everyone", position: 99, permissions: ["post"] });
const mods = role({ id: "mods", name: "Moderação", permissions: ["create_channels", "manage_channels"] });
const data: OrgRoles = { roles: [mods, everyone], areas: AREAS, colors: ["teal", "rose"], icons: ["shield"] };
const person = (userId: string, over: Partial<Person> = {}) =>
  ({ userId, name: userId, email: `${userId}@example.com`, role: "member", roleIds: [], ...over }) as Person;

describe("Papéis e permissões on the phone (ADR 0085), as the web's", () => {
  test("in Configurações for who manages roles only, a screen for each of its pages in the stack", () => {
    const org = (permissions: string[]) => ({ id: "o", name: "Acme", role: "member" as const, permissions });
    expect(visibleSections(org(["read", "manage_roles"])).map((s) => s.id)).toContain("roles");
    expect(visibleSections(org(["read", "manage_members"])).map((s) => s.id)).not.toContain("roles");
    expect(SETTINGS_SECTIONS.find((s) => s.id === "roles")?.href).toBe("/settings/roles");
    const layout = readFileSync(join(APP, "_layout.tsx"), "utf8");
    for (const page of ["index", "[roleId]", "area", "add", "rename", "new"]) {
      expect(existsSync(join(APP, "settings", "roles", `${page}.tsx`))).toBe(true);
      expect(layout).toContain(`name="settings/roles/${page}"`);
    }
  });

  test("a role's areas: what it reaches and its level, the agents' computers right after Ferramentas", async () => {
    const t = await translator("pt-BR");
    const rows = roleAreaRows(t, "pt-BR", mods, data);
    expect(rows.map((r) => r.id)).toEqual(["chat", "tools", COMPUTER_AREA]);
    expect(rows[0]).toMatchObject({ label: "Conversas", value: "Gerenciar" });
    expect(rows[1]).toMatchObject({ value: "Como Todos", line: "Nada" });
    expect(rows[2]).toMatchObject({
      label: "Computadores dos agentes",
      value: "Nenhum",
      line: "Só o que Todos já podem",
    });
    // Todos' lowest is "Nada", and its computers are each person's own.
    const base = roleAreaRows(t, "pt-BR", everyone, data);
    expect(base[1]?.value).toBe("Nada");
    expect(base[2]?.line).toBe(
      "Ninguém vê nem usa os computadores ou navegadores dos agentes, nem os pedidos de login",
    );
    // An Administrador has every area: no level to pick.
    const admin = roleAreaRows(t, "pt-BR", { ...mods, permissions: ["administrator"] }, data);
    expect(admin.map((r) => r.value)).toEqual(["", "", ""]);
    expect(admin[0]?.line).toBe("Tudo, por ser Administrador");
  });

  test("an area's levels: Usar only when it gives more than Todos, Personalizado shown while it is that", () => {
    const [chat, tools] = AREAS as [OrgRoles["areas"][number], OrgRoles["areas"][number]];
    expect(areaChoices(mods, chat, everyone)).toEqual({ level: "manage", options: ["none", "use", "manage"] });
    const one = { ...mods, permissions: ["manage_channels"] };
    expect(areaChoices(one, chat, everyone)).toEqual({ level: "custom", options: ["none", "use", "manage", "custom"] });
    expect(areaChoices(everyone, tools, undefined).options).toEqual(["none", "use", "manage"]);
    // A key Todos already gives can't be turned off on another role: it says where it comes from.
    expect(keyState(mods, everyone, "post")).toEqual({ on: true, from: "everyone" });
    expect(keyState(mods, everyone, "manage_channels")).toEqual({ on: true, from: null });
    expect(keyState({ ...mods, permissions: ["administrator"] }, everyone, "configure").from).toBe("admin");
  });

  test("who changes a role and who gets it: the server's flags, said the web's way", () => {
    const manager = { role: "member", rank: 1, permissions: ["manage_roles", "manage_members"] };
    expect(roleLock(manager, mods)).toBeNull();
    expect(roleLock(manager, { ...mods, editable: false })).toBe("own");
    expect(roleLock(manager, { ...mods, editable: false, position: 0 })).toBe("above");
    expect(roleLock({ role: "member", permissions: [] }, { ...mods, editable: false })).toBe("noPermission");
    const org = { id: "o", name: "Acme", role: "member" as const, permissions: ["manage_members"] };
    expect(givesRole(org, mods)).toBe(true);
    expect(givesRole(org, everyone)).toBe(false);
    expect(givesRole(org, { ...mods, givable: false })).toBe(false);
    expect(givesRole({ ...org, permissions: [] }, mods)).toBe(false);
    // Below the viewer and without the role yet; an owner never, the viewer themselves yes.
    const viewer = { role: "member", rank: 1, userId: "me" };
    const top = role({ id: "top", position: 0 });
    const people = [
      person("me", { roleIds: ["mods"] }),
      person("ana"),
      person("bia", { roleIds: ["mods"] }),
      person("caio", { roleIds: ["top"] }),
      person("dono", { role: "owner" }),
    ];
    expect(roleCandidates(viewer, mods, people, [top, mods, everyone]).map((p) => p.userId)).toEqual(["ana"]);
    expect(
      roleCandidates({ ...viewer, userId: "x" }, mods, people, [top, mods, everyone]).map((p) => p.userId),
    ).toEqual(["ana"]);
  });

  test("adding people one by one goes on past a refusal, keeping their other roles", async () => {
    const sent: { userId: string; roleIds: string[] }[] = [];
    const people = [person("ana", { roleIds: ["top"] }), person("bia")];
    const result = await giveRole(people, ["ana", "bia", "gone"], "mods", async (v) => {
      sent.push(v);
      if (v.userId === "ana") throw new Error("above you");
    });
    expect(sent).toEqual([
      { userId: "ana", roleIds: ["top", "mods"] },
      { userId: "bia", roleIds: ["mods"] },
    ]);
    expect(result.added).toBe(1);
    expect((result.failed as Error).message).toBe("above you");
  });

  test("a new role starts from a template or from a role's keys", () => {
    expect(newRoleInput("Moderação", "mod", [])).toEqual({
      name: "Moderação",
      icon: "flag",
      color: "teal",
      permissions: ["create_channels", "manage_channels"],
    });
    expect(newRoleInput("Cópia", "copy:mods", [mods])).toMatchObject({ icon: "shield", permissions: mods.permissions });
    expect(newRoleInput("Nada", "blank", []).permissions).toEqual([]);
  });
});

describe("Adicionar pessoas to a role on the phone", () => {
  test("the ones being added keep their rows, and nobody reads as having it, until the screen is gone", () => {
    const screen = readFileSync(join(import.meta.dir, "../../src/features/settings/RolesScreen.tsx"), "utf8");
    expect(screen).toContain("const people = useHeldWhile(live, busy);");
    // Busy, so held, while it goes back too.
    expect(screen).toMatch(/stays = false;\s*goBack\(\);[\s\S]*?if \(stays\) setBusy\(false\);/);
  });
});
