import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { titleOfSlug } from "@agenteschat/client/lib/wiki";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { createItems, mayCreate } from "../../src/features/new/logic";
import { type EmptyPlace, firstUseCopy } from "../../src/features/shared/first-use";

const source = (file: string) => readFileSync(join(import.meta.dir, "../../src/features", file), "utf8");
const places = Object.keys(featureKeysEn.empty) as EmptyPlace[];
const at = (tree: object, key: string) =>
  key
    .replace(/^mobile\./, "")
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], tree);

describe("who gets the first step", () => {
  test("a permission: only who holds it", () => {
    const gates = {
      agent: "create_agents",
      channel: "create_channels",
      task: "post",
      wiki: "edit_wiki",
      invite: "invite_people",
    } as const;
    for (const [item, permission] of Object.entries(gates) as [keyof typeof gates, string][]) {
      expect(mayCreate({ permissions: [permission] }, item)).toBe(true);
      expect(mayCreate({ permissions: ["read"] }, item)).toBe(false);
    }
  });

  test("a routine: who manages routines, or the owner of an agent", () => {
    expect(mayCreate({ permissions: ["manage_routines"] }, "routine")).toBe(true);
    expect(mayCreate({ permissions: ["read"] }, "routine", { ownsAgent: true })).toBe(true);
    expect(mayCreate({ permissions: ["read"] }, "routine")).toBe(false);
  });

  test("New offers the same as the empty states", () => {
    const org = { permissions: ["post", "edit_wiki"] };
    expect(createItems(org, { ownsAgent: true })).toEqual(["task", "routine", "wiki"]);
  });

  test.each([
    ["agents/AgentsScreen.tsx", 'place="agents"', 'acts={mayCreate(org, "agent")}'],
    ["chats/Greeting.tsx", 'place="agents"', 'if (!mayCreate(org, "agent"))'],
    ["drive/DriveScreen.tsx", 'place="drive"', 'can(useOrg().org, "upload_files")'],
    ["issues/IssuesScreen.tsx", 'place="tasks"', 'mayCreate(useOrg().org, "task")'],
    ["routines/RoutinesScreen.tsx", 'place="routines"', 'mayCreate(useOrg().org, "routine", { ownsAgent })'],
    ["wiki/WikiScreen.tsx", 'place="wiki"', 'can(org, "edit_wiki")'],
    ["chats/ConversationListScreen.tsx", '"channels" as const', 'mayCreate(org, "channel")'],
    ["chats/ConversationListScreen.tsx", '"people" as const', 'mayCreate(org, "invite")'],
    ["new/ChatTargets.tsx", 'place="people"', 'mayCreate(org, "invite")'],
    ["settings/AccessScreen.tsx", 'place="access"', "acts={addsConnectors(org)}"],
    ["devices/DevicesScreen.tsx", 'firstUseCopy("computers", pairs)', 'can(org, "pair_computers")'],
    ["connectors/ConnectorsScreen.tsx", 'firstUseCopy("connectors", acts)', "<EmptyHint acts={admin} />"],
  ])("%s gates %s on the permission", (file, place, gate) => {
    const code = source(file);
    expect(code).toContain(place);
    expect(code).toContain(gate);
  });

  test.each([
    ["dashboards/BoardScreen.tsx", "acts={board.canEdit}"],
    ["vault/VaultScreen.tsx", 'const mayAdd = tab === "personal" || data.canManageTeam;'],
    ["memory/MemoryScreen.tsx", "find((a) => a && canTalk(a))"],
    ["chat/ChatScreen.tsx", "acts={member && channel?.can?.post !== false}"],
  ])("%s takes the server's answer", (file, gate) => {
    expect(source(file)).toContain(gate);
  });

  test("the button only ever shows with `acts`, and a screen's own add buttons follow the same gate", () => {
    expect(source("shared/FirstUse.tsx")).toContain("acts && label && onPress");
    expect(source("issues/IssuesScreen.tsx")).toContain('const right = mayNew ? <IconButton icon="plus"');
    expect(source("routines/RoutinesScreen.tsx")).toContain('{...(mayNew ? { right: <IconButton icon="plus"');
  });
});

describe("the words", () => {
  test("who can act reads what the place gives, who can't reads who does it", () => {
    expect(firstUseCopy("routines", true)).toEqual({
      title: "mobile.empty.routines.title",
      text: "mobile.empty.routines.text",
    });
    expect(firstUseCopy("routines", false)).toEqual({
      title: "mobile.empty.routines.viewerTitle",
      text: "mobile.empty.routines.viewerText",
    });
  });

  test("a place anyone can act on has one set of words", () => {
    expect(firstUseCopy("memory", false).title).toBe("mobile.empty.memory.title");
  });

  test("every place has its words in both languages, in pairs, leading with what it gives", () => {
    for (const place of places)
      for (const acts of [true, false]) {
        const { title, text } = firstUseCopy(place, acts);
        for (const tree of [featureKeysEn, featureKeysPtBR]) {
          expect(typeof at(tree, title)).toBe("string");
          expect(typeof at(tree, text)).toBe("string");
          expect(at(tree, title)).not.toMatch(/^(No |Nenhum|Nada ainda|Sem )/);
        }
      }
  });

  test("a personal workspace reads its own words where the place has them, the usual ones otherwise (ADR 0159)", () => {
    expect(firstUseCopy("agents", true, true)).toEqual({
      title: "mobile.empty.agents.titlePersonal",
      text: "mobile.empty.agents.textPersonal",
    });
    expect(firstUseCopy("people", false, true)).toEqual({
      title: "mobile.empty.people.viewerTitlePersonal",
      text: "mobile.empty.people.viewerTextPersonal",
    });
    // A word with no personal sibling keeps the team's (Tasks' viewer line fits both).
    expect(firstUseCopy("tasks", false, true)).toEqual({
      title: "mobile.empty.tasks.viewerTitlePersonal",
      text: "mobile.empty.tasks.viewerText",
    });
    expect(firstUseCopy("routines", true, true)).toEqual(firstUseCopy("routines", true));
    // A team's workspace never reads them.
    expect(firstUseCopy("agents", true)).toEqual({
      title: "mobile.empty.agents.title",
      text: "mobile.empty.agents.text",
    });
    expect(source("shared/FirstUse.tsx")).toContain("firstUseCopy(place, acts, isPersonal(");
  });

  test("every personal word is in both languages", () => {
    for (const place of places)
      for (const acts of [true, false]) {
        const { title, text } = firstUseCopy(place, acts, true);
        for (const tree of [featureKeysEn, featureKeysPtBR]) {
          expect({ key: title, has: typeof at(tree, title) }).toEqual({ key: title, has: "string" });
          expect({ key: text, has: typeof at(tree, text) }).toEqual({ key: text, has: "string" });
        }
      }
  });

  test("no semicolons or long dashes, and nothing about a support team", () => {
    for (const tree of [featureKeysEn.empty, featureKeysPtBR.empty])
      expect(JSON.stringify(tree)).not.toMatch(/;|—|suporte|support/i);
  });
});

describe("no results keep a way out", () => {
  test.each([
    ["drive/DriveScreen.tsx", 'label={t("filters.clearAll")} onPress={clear}'],
    ["routines/RoutinesScreen.tsx", 'label={t("filters.clearAll")} onPress={clear}'],
    ["wiki/WikiScreen.tsx", 'label={t("filters.clearSearch")} onPress={() => setQ("")}'],
    ["memory/MemoryScreen.tsx", 'label={t("filters.clearSearch")} onPress={() => setQ("")}'],
    ["settings/SkillsScreen.tsx", 'label={t("filters.clearSearch")} onPress={() => setQ("")}'],
  ])("%s", (file, clear) => {
    expect(source(file)).toContain(clear);
  });
});

test("a link to a page that doesn't exist names it from its slug", () => {
  expect(titleOfSlug("processos/deploy-final")).toBe("deploy final");
  expect(titleOfSlug("onboarding")).toBe("onboarding");
});

describe("a list that didn't load is not an empty one", () => {
  test("each says so before its first use or all clear", () => {
    const before = (file: string, guard: string, empty: string) => {
      const code = source(file);
      expect(code.indexOf(guard)).toBeGreaterThan(-1);
      expect(code.indexOf(guard)).toBeLessThan(code.indexOf(empty));
    };
    before("chats/ThreadsScreen.tsx", "list.failed", "<TeamSkyEmpty");
    before("chats/ConversationListScreen.tsx", "list.failed", "<FirstUse {...firstStep}");
    before("activity/ActivityScreen.tsx", "list.isError && !list.data", "<AllClear />");
    before("team/TeamScreen.tsx", "!groups.data ? null", "title={t(noSectors.title)}");
  });
});
