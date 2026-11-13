import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";

const SRC = join(import.meta.dir, "..", "..", "src", "features");
const src = (path: string) => readFileSync(join(SRC, path), "utf8");

const at = (tree: object, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], tree);

/** The phone's words with a personal sibling (ADR 0159): what a person alone reads in place of a team's. */
const PERSONAL = [
  "approval.leaves",
  "approval.trait.external",
  "chats.newChannelHint",
  "chats.channelPlaceholder",
  "chats.createChannel",
  "new.channelFine",
  "new.wikiHint",
  "chat.intent.roleIntro",
  "chat.intent.helloRole",
  "agents.teamSection",
  "connectors.adminsOnly",
] as const;

describe("a personal workspace's words on the phone (ADR 0159)", () => {
  test("each team-worded line has a personal sibling in both languages, with no team or company in it", () => {
    for (const key of PERSONAL) {
      const en = at(featureKeysEn, `${key}Personal`);
      const pt = at(featureKeysPtBR, `${key}Personal`);
      expect({ key, en: typeof en, pt: typeof pt }).toEqual({ key, en: "string", pt: "string" });
      expect(en).not.toBe(at(featureKeysEn, key));
      expect(String(en)).not.toMatch(/\b(team|company|admin)\b/i);
      expect(String(pt)).not.toMatch(/\b(equipe|time|empresa|admin)\b/i);
    }
    // The New sheet's row for a channel names a group conversation.
    expect(featureKeysEn.new.channelPersonal).toBe("Group conversation");
    expect(featureKeysPtBR.new.channelPersonal).toBe("Conversa em grupo");
  });

  test("an agent's first words and its empty conversation's line read the mode", () => {
    expect(src("chat/FirstDay.tsx")).toContain('t(modeKey(org, "mobile.chat.intent.helloRole"), { role: intro.role })');
    expect(src("chats/ConversationRowView.tsx")).toContain(
      't(modeKey(org, "mobile.chat.intent.roleIntro"), { role: intro.role })',
    );
  });

  test("Agents' free section and a new agent's toast: the person's agents, never a team they joined", () => {
    expect(src("agents/AgentsScreen.tsx")).toContain('t(modeKey(org, "mobile.agents.teamSection"))');
    const create = src("agents/NewAgentScreen.tsx");
    expect(create).toContain('? t("newAgent.createdTitlePersonal", { name: agent.name })');
    expect(create).toContain(': t("mobile.agents.created", { name: agent.name })');
  });

  test("a request that leaves the workspace says the person's, on the card, the sheet and the chips", () => {
    expect(src("chat/cards.tsx")).toContain('kindNote={high ? t(modeKey(org, "mobile.approval.leaves")) : undefined}');
    const parts = src("approvals/parts.tsx");
    // Only "external" has a sibling: the other traits keep their one key.
    expect(parts).toContain(
      'trait === "external" && personal ? "mobile.approval.trait.externalPersonal" : `mobile.approval.trait.',
    );
    expect(parts).toContain("label={t(traitKey(tr, personal))}");
    expect(src("approvals/ApprovalSheet.tsx")).toContain("t(traitKey(tr, isPersonal(org)))");
  });

  test("a channel is a group conversation: New, its sheet and the conversation switcher", () => {
    const form = src("new/NewChannelForm.tsx");
    expect(form).toContain(
      'isPersonal(org) ? t("shell.sidebarMenu.newChannelPersonal") : t("mobile.chats.newChannel")',
    );
    expect(form).toContain('placeholder={t(modeKey(org, "mobile.chats.channelPlaceholder"))}');
    expect(form).toContain('{t(modeKey(org, "mobile.new.channelFine"))}');
    expect(form).toContain('label={t(modeKey(org, "mobile.chats.createChannel"))}');
    const create = src("new/NewScreen.tsx");
    expect(create).toContain('label: isPersonal(org) ? t("mobile.new.channelPersonal") : t("missions.new.channel")');
    expect(create).toContain('sub: t(modeKey(org, "mobile.chats.newChannelHint"))');
    expect(create).toContain('sub: t(modeKey(org, "mobile.new.wikiHint"))');
    expect(src("chat/ConversationSwitcher.tsx")).toContain(
      'isPersonal(org) ? t("shell.channelsPersonal") : t("mobile.chat.switchChannels")',
    );
  });

  test("connectors are suggested for the person and connected by whoever runs the workspace, never by name", () => {
    expect(src("connectors/ConnectorsScreen.tsx")).toContain('? t("connectors.suggestedPersonal")');
    expect(src("connectors/ConnectSheet.tsx")).toContain(
      't(modeKey(org, "mobile.connectors.adminsOnly"), { org: org?.name ?? "" })',
    );
  });

  test("the workspace's own computer is its person's agents', where missions wait for it too", () => {
    expect(src("chat/sheets.tsx")).toContain(
      't(modeKey(org, "computerSetup.titleInSentence"), { org: org?.name ?? "" })',
    );
  });
});
