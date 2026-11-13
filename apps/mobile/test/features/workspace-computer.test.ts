import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  accountOutOfReach,
  deletedByText,
  deletingText,
  restorable,
  settingsFrozen,
} from "@agenteschat/client/lib/deletion";
import { suspendedText } from "@agenteschat/client/lib/errors";
import { type OutageTargetLike, targetOptions } from "@agenteschat/client/lib/machine-outages";
import { quickReply } from "@agenteschat/client/lib/notifications";
import { computerIcon, type MachineOutage, targetText } from "../../src/features/outages/logic";
import { suspendedOf } from "../../src/lib/org-choice";
import { notification, translator } from "./fixtures";

/** The workspace's own computer (ADR 0056 §10): the server names it ("Computador da Acme"), its system never said. */
const managed: OutageTargetLike = {
  kind: "machine",
  machineId: "ws",
  name: "Computador da Acme",
  platform: "other",
  managed: true,
  online: true,
  brains: ["claude_code"],
  reasonOff: null,
};
const air: MachineOutage = {
  machineId: "air",
  name: "MacBook Air",
  platform: "darwin",
  offlineSince: "2026-10-18T20:00:00.000Z",
  waitingRuns: 0,
  agents: [{ agentId: "ada", name: "Ada", brain: "claude_code", waiting: { routines: 0, conversations: 1 } }],
};

describe("the workspace's own computer on the phone (the switch sheet's card)", () => {
  test("as a target: its name, always on, one user per agent, drawn as a server", async () => {
    const t = await translator("pt-BR");
    const [option] = targetOptions(air, [managed], ["ada"]);
    expect(option).toMatchObject({ managed: true, enabled: true });
    if (!option) throw new Error("no option");
    expect(targetText(t, option)).toEqual({
      title: "Computador da Acme",
      tag: "Sempre ligado",
      desc: "Só deste workspace · um usuário para cada agente",
    });
    expect(computerIcon(option.platform)).toBe("computerLinux");
    const en = await translator("en");
    expect(targetText(en, option)).toMatchObject({ desc: "Just for this workspace · one user per agent" });
  });
});

describe("an organization being deleted on the phone", () => {
  const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  const deletion = {
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    requestedAt: new Date().toISOString(),
    requestedBy: { id: "u2", name: "Bia" },
  };
  const orgs = [{ id: "a", name: "Acme", role: "member" as const, deletion }];

  test("it opens as ever, its notice first on Conversas, its message boxes saying why nothing goes", () => {
    const layout = readFileSync(new URL("../../app/_layout.tsx", import.meta.url), "utf8");
    expect(layout).not.toContain("DeletingWorkspace");
    const home = read("features/chats/ChatsScreen.tsx");
    expect(home.indexOf("<DeletingNotice />")).toBeLessThan(home.indexOf("<SetupNotice />"));
    expect(read("features/chat/ChatScreen.tsx")).toContain('{t("deleting.composer")}');
  });

  test("the island takes no answer: no Responder, no choices, the line in their place; Abrir stays", () => {
    const question = notification({
      id: "n1",
      kind: "agent_question",
      waiting: true,
      source: { questionId: "q1" },
      latest: { text: "Publico agora?", suggestions: ["Sim", "Depois"] },
    });
    expect(quickReply(question, false)).toEqual({
      target: { kind: "question", questionId: "q1" },
      suggestions: ["Sim", "Depois"],
      readOnly: false,
    });
    expect(quickReply(question, true)).toEqual({ target: null, suggestions: [], readOnly: true });
    // Nothing it could answer says nothing either: an approval only opens, as ever.
    const approval = notification({ id: "n2", kind: "approval", waiting: true, source: { approvalId: "a1" } });
    expect(quickReply(approval, true)).toEqual({ target: null, suggestions: [], readOnly: false });
    // Responder and the choices come from it alone, the line from `readOnly`.
    const island = read("features/island/NoticeIsland.tsx");
    expect(island).toContain("quickReply(n, Boolean(useOrg().org?.deletion))");
    expect(island).not.toContain("replyTarget(");
    expect(island).toMatch(/\{readOnly \? \([\s\S]*?\{t\("deleting\.composer"\)\}/);
  });

  test("Settings greys out what would change it, as the web does; the person's own and what reads stay", () => {
    for (const section of ["general", "media", "members", "connectors", "apps", "devices", "storage"])
      expect(settingsFrozen(orgs[0], section)).toBe(true);
    for (const section of ["usage", "audit", "import", "vault", "roles", "skills", "access"])
      expect(settingsFrozen(orgs[0], section)).toBe(false);
    expect(settingsFrozen({ deletion: undefined }, "general")).toBe(false);
  });

  test("each settings screen greys out exactly what the shared rule freezes, by its own section", () => {
    const screens = {
      general: "settings/GeneralScreen.tsx",
      media: "settings/MediaSettingsScreen.tsx",
      members: "members/MembersPage.tsx",
      connectors: "connectors/ConnectorsScreen.tsx",
      apps: "settings/AppsScreen.tsx",
      devices: "devices/DevicesScreen.tsx",
      storage: "settings/StorageScreen.tsx",
      access: "settings/AccessScreen.tsx",
      usage: "usage/UsageScreen.tsx",
      audit: "settings/AuditScreen.tsx",
      import: "settings/ImportScreen.tsx",
      vault: "vault/VaultScreen.tsx",
      roles: "settings/RolesScreen.tsx",
      skills: "settings/SkillsScreen.tsx",
    };
    for (const [section, file] of Object.entries(screens)) {
      const greys = read(`features/${file}`).includes(`settingsFrozen(org, "${section}")`);
      expect({ section, greys }).toEqual({ section, greys: settingsFrozen(orgs[0], section) });
    }
  });

  test("when it goes and who deleted it; only owners restore it, and only before that", async () => {
    const t = await translator("pt-BR");
    expect(deletingText(t, "pt-BR", "Acme", deletion)).toMatch(/^Acme vai ser apagado em .+$/);
    expect(deletingText(t, "pt-BR", "Acme", { ...deletion, dueAt: null })).toBe("Acme está sendo apagado");
    expect(deletedByText(t, "pt-BR", deletion)).toMatch(/^Bia apagou em .+\.$/);
    expect(deletedByText(t, "pt-BR", deletion, "u2")).toMatch(/^Você apagou em .+\.$/);
    expect(deletedByText(t, "pt-BR", { ...deletion, requestedBy: null })).toMatch(/^Alguém apagou em .+\.$/);
    expect(restorable(orgs[0])).toBe(false);
    expect(restorable({ role: "owner", deletion })).toBe(true);
    expect(restorable({ role: "owner", deletion: { ...deletion, dueAt: null } })).toBe(false);
  });
});

describe("Apagar conta on the phone's closed screens and first run", () => {
  const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
  const deletion = { dueAt: new Date(Date.now() + 86_400_000).toISOString(), requestedAt: null, requestedBy: null };

  test("offered only with no workspace that opens: one being deleted opens", () => {
    const closing = { id: "a", role: "owner" as const, deletion };
    const suspended = { id: "b", role: "member" as const, standing: { state: "suspended" } };
    expect(accountOutOfReach([closing])).toBe(false);
    expect(accountOutOfReach([suspended])).toBe(true);
    expect(accountOutOfReach([])).toBe(true);
  });

  test("every entry goes through WholeAccount, which asks that, after Sair", () => {
    expect(read("ui/auth/WholeAccount.tsx")).toContain("if (!accountOutOfReach(orgs)) return null;");
    const code = read("ui/auth/SuspendedWorkspace.tsx");
    expect(code).not.toContain('label={t("deleteAccount.menu")}');
    expect(code.indexOf("<WholeAccount")).toBeGreaterThan(code.indexOf('t("mobile.org.signOut")'));
    // The first run shows nothing destructive, yet deleting the account stays reachable (App Store 5.1.1(v)): its
    // quiet Sair offers Sair and, after it, Apagar conta in red.
    const first = read("features/onboarding/OnboardingFlow.tsx");
    expect(first).not.toContain('label={t("deleteAccount.menu")}');
    expect(first.indexOf('label: t("deleteAccount.menu")')).toBeGreaterThan(
      first.indexOf('label: t("mobile.org.signOut")'),
    );
    expect(first).toContain('openWebPath("/onboarding?account=delete")');
    expect(first).not.toContain("onboarding.deleteLink");
  });

  test("the first workspace that opens is the main action", () => {
    expect(read("ui/auth/SuspendedWorkspace.tsx")).toContain(
      'variant={i === 0 && workspaceOpens(o) ? "primary" : "secondary"}',
    );
  });

  test("the lists and the deletion screen say closed and same-named apart", () => {
    // Workspaces, every server's (ADR 0154): the note first, else the role.
    expect(read("features/me/WorkspacesPages.tsx")).toContain("sub={notes.get(o.id) ?? ");
    const screen = read("features/me/DeleteAccountScreen.tsx");
    expect(screen).toContain('t("deleteAccount.title")');
    expect(screen).toContain('t("deleteAccount.intro")');
    expect(screen).toContain('t("deleteAccount.oneWorkspace")');
    expect(screen).toContain("notes,\n");
    expect(screen).toContain('t("deleteAccount.deleteOrg", { name: named(o) })');
    expect(read("features/me/AccountPage.tsx")).toContain('"deleteAccount.card.leaveWorkspace"');
  });
});

describe("a suspended organization on the phone", () => {
  const orgs = [
    { id: "a", name: "Acme", standing: { state: "suspended", reason: "uso fora dos termos" } },
    { id: "b", name: "Beta" },
    { id: "c", name: "Casa", standing: { state: "hold", reason: null } },
    { id: "d", name: "Dez", standing: { state: "suspended", reason: null } },
  ];

  test("the chosen one suspended: why (when told) and where else to go", () => {
    expect(suspendedOf(orgs, "a")).toEqual({
      reason: "uso fora dos termos",
      cloud: false,
      others: [orgs[1], orgs[2]],
    });
    expect(suspendedOf(orgs, "d")?.reason).toBeNull();
  });

  test("its line: why, and on agentes.chat Cloud how to contest it", async () => {
    const t = await translator("pt-BR");
    expect(suspendedText(t, suspendedOf(orgs, "a"))).toBe("Este workspace está suspenso: uso fora dos termos");
    const cloud = [{ id: "e", name: "Eco", standing: { state: "suspended", reason: "Termos 5: spam", cloud: true } }];
    expect(suspendedText(t, suspendedOf(cloud, "e"))).toBe(
      "Este workspace está suspenso: Termos 5: spam. Para contestar, escreva para legal@agentes.chat.",
    );
    expect(suspendedText(t, suspendedOf(orgs, "d"))).toBe(
      "As conversas e os agentes dele estão fechados por enquanto.",
    );
  });

  test("active or on hold: no suspended screen", () => {
    expect(suspendedOf(orgs, "b")).toBeNull();
    expect(suspendedOf(orgs, "c")).toBeNull();
    expect(suspendedOf(orgs, null)).toBeNull();
  });
});
