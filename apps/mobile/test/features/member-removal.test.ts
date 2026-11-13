import { describe, expect, test } from "bun:test";
import type { OrgRole, Person, RemovalPreview } from "@agenteschat/client";
import { removalLines } from "@agenteschat/client/lib/removal";
import { leaves, removes } from "@agenteschat/client/lib/roles";
import { translator } from "./fixtures";

/** Remover do workspace on the members screen: who gets it, and what its confirmation says, in both languages. */

const roles = [
  { id: "r-admin", kind: "custom", position: 0 },
  { id: "r-devs", kind: "custom", position: 1 },
  { id: "r-everyone", kind: "everyone", position: 2 },
] as OrgRole[];
const person = (userId: string, role: "owner" | "member", roleIds: string[] = []) =>
  ({ userId, role, roleIds }) as Pick<Person, "userId" | "role" | "roleIds">;

describe("who may remove whom", () => {
  const admin = { role: "member", rank: 0, userId: "u-adm", permissions: ["manage_members"] };
  test("someone who manages members, only above them; an owner above all", () => {
    expect(removes(admin, person("u-dev", "member", ["r-devs"]), roles)).toBe(true);
    expect(removes(admin, person("u-adm2", "member", ["r-admin"]), roles)).toBe(false);
    expect(removes(admin, person("u-own", "owner"), roles)).toBe(false);
    expect(removes({ ...admin, permissions: [] }, person("u-dev", "member"), roles)).toBe(false);
    expect(removes(admin, person("u-adm", "member", ["r-admin"]), roles)).toBe(false);
    const owner = { role: "owner", rank: -1, userId: "u-own", permissions: ["manage_members"] };
    expect(removes(owner, person("u-own2", "owner"), roles)).toBe(true);
  });
  test("anyone leaves but the last owner", () => {
    expect(leaves({ role: "member" }, [person("a", "owner")])).toBe(true);
    expect(leaves({ role: "owner" }, [person("a", "owner")])).toBe(false);
    expect(leaves({ role: "owner" }, [person("a", "owner"), person("b", "owner")])).toBe(true);
  });
});

const preview: RemovalPreview = {
  heir: { userId: "u-me", name: "Rui" },
  agents: [
    { id: "a1", name: "Nina" },
    { id: "a2", name: "Otto" },
  ],
  losePlan: [{ id: "a1", name: "Nina" }],
  computers: [{ id: "m1", name: "MacBook" }],
  routines: 2,
};

test("the confirmation, fact by fact, in Portuguese and English", async () => {
  const pt = await translator("pt-BR");
  expect(removalLines(pt, preview, { name: "Lia", org: "Orbita", mine: false, meId: "u-me" })).toEqual([
    "O acesso de Lia à Orbita acaba agora, em todos os aparelhos.",
    "Os agentes de Lia passam a ter você como responsável: Nina e Otto.",
    "Nina pensava com um plano de Lia e fica sem ele. Escolha quem pensa na página do agente.",
    "O computador que Lia conectou sai do workspace: MacBook.",
    "2 rotinas criadas por Lia ficam pausadas.",
    "As mensagens de Lia ficam onde estão.",
  ]);
  const en = await translator("en");
  const leaving = { ...preview, heir: { userId: "u-own", name: "Rui" }, computers: [], routines: 0 };
  expect(removalLines(en, leaving, { name: "Lia", org: "Orbita", mine: true, meId: "u-lia" })).toEqual([
    "Your access ends now, on every device. To come back, someone has to invite you again.",
    "Your agents will answer to Rui: Nina and Otto.",
    "Nina thought with a plan of yours and loses it.",
    "Your messages stay where they are.",
  ]);
});
