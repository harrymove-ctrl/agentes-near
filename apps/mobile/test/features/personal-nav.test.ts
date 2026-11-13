import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

// A personal workspace on the phone (ADR 0159): the same screens and data, only what is in sight and its words change.
const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the tabs of a personal workspace", () => {
  test("Threads leaves the bar the system's way, and its list is pushed from You › Work", () => {
    const tabs = read("app/(app)/(tabs)/_layout.tsx");
    expect(tabs).toContain('{ name: "threads", glyph: "threads", label: "mobile.tabs.threads", teamOnly: true }');
    expect(tabs).toContain("hidden={personal && tab.teamOnly === true}");
    // A hidden tab can't be opened: the pushed list lives at /conversations/threads.
    const route = read("app/(app)/conversations/[kind].tsx");
    expect(route).toContain('if (kind === "threads" && personal) return <ThreadsScreen pushed />;');
    expect(read("src/features/chats/ThreadsScreen.tsx")).toContain("<PushedLargeTitle");
    const me = read("src/features/me/MeScreen.tsx");
    expect(me).toContain('onPress={() => open("/conversations/threads")}');
    expect(me).toContain("{...(unreadThreads > 0 ? { value: String(unreadThreads) } : {})}");
  });

  test("the bar's mark is the person's own photo, and its label names no workspace", () => {
    const header = read("src/features/shared/tabHeader.tsx");
    expect(header).toContain('<PersonAvatar name={face.name || "?"} size={ORG} photo={face.photo} />');
    expect(header).toContain("accessibilityLabel={org?.name && !personal ? ");
  });
});

describe("Conversas in a personal workspace", () => {
  test("channels are group conversations, and a quiet #general stays out while the person is alone", () => {
    const chats = read("src/features/chats/ChatsScreen.tsx");
    expect(chats).toContain("withoutQuietGeneral(pinned.rows, hideGeneral)");
    expect(chats).toContain('t("shell.channelsPersonal")');
    expect(chats).toContain("isPersonal(org) && ![...memberById.keys()].some((id) => id !== meId)");
    const list = read("src/features/chats/ConversationListScreen.tsx");
    expect(list).toContain("withoutQuietGeneral(rightHandPin(list.rows, rightHandOf(dir.agents)).rows, hideGeneral)");
    expect(list).toContain('kind === "channels" && personal');
  });
});

describe("You in a personal workspace", () => {
  const me = read("src/features/me/MeScreen.tsx");

  test("no workspace name after the handle, and its own words under the workspace", () => {
    expect(me).toContain("personal ? null : org.org?.name]");
    expect(me).toContain("t(modeKey(org.org, `mobile.me.role.");
    expect(me).toContain("<WorkspaceMark org={org.org} size={36} />");
  });

  test("Work leads with Routines and Drive and ends with Team; a team's keeps its order", () => {
    const list = (name: string) => {
      const from = me.indexOf(`const ${name}: WorkRow[] = [`);
      return me
        .slice(from, me.indexOf("];", from))
        .match(/"(\w+)"/g)
        ?.map((k) => k.replaceAll('"', ""));
    };
    expect(list("PERSONAL_WORK")).toEqual([
      "routines",
      "drive",
      "issues",
      "threads",
      "proposals",
      "wiki",
      "dashboards",
      "memory",
      "team",
    ]);
    expect(list("TEAM_WORK")).toEqual(["issues", "proposals", "routines", "wiki", "drive", "dashboards", "memory"]);
    expect(me).toContain('onPress={() => open("/team")}');
  });

  test("Agents' Team row stays a team's: a personal workspace has it in You › Work", () => {
    const agents = read("src/features/agents/AgentsScreen.tsx");
    expect(agents).toContain("{total > 0 && !isPersonal(org) ? <TeamEntry /> : null}");
  });

  test("a personal workspace in the lists wears your face and says whose it is", () => {
    const pages = read("src/features/me/WorkspacesPages.tsx");
    expect(pages).toContain('if (isPersonal(org) && org.role === "owner")');
    expect(pages).toContain("<WorkspaceMark org={o} server={g.server} />");
    expect(pages).toContain("label={mine(o) && !several && face.name ? face.name : o.name}");
    expect(pages).toContain("sub={notes.get(o.id) ?? t(modeKey(o, `mobile.me.role.");
    for (const tree of [featureKeysEn, featureKeysPtBR]) {
      expect(typeof tree.me.role.ownerPersonal).toBe("string");
      expect(typeof tree.me.role.memberPersonal).toBe("string");
    }
  });
});
