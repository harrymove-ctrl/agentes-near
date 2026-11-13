import type { ChannelMember } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { everyoneSuggestion } from "@agenteschat/client/lib/everyone";
import { mentionReaches } from "@agenteschat/client/lib/right-hand";
import { Avatar, type ComposerSuggestion, Icon } from "@agenteschat/ui";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "./useDirectory";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const LIMIT = 8;

type Row = ComposerSuggestion & { inChannel: boolean; rank: number; hay: string };

/**
 * "@" suggestions: the channel's members first (people and agents), then the
 * rest of the workspace. Agents outside the channel say so (`note`).
 * Without `members` (an issue), everyone is one list. `kind`: a channel's or a DM's (`mentionReaches`).
 * `everyone`: the person may mention everyone here (`offersEveryone`), so `@todos`, in their language, comes first.
 */
export function useMentionSearch(members?: ChannelMember[], kind: "channel" | "dm" = "channel", everyone = false) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  return useCallback(
    (query: string): ComposerSuggestion[] => {
      const q = fold(query);
      const inChannel = (type: "person" | "agent", id: string) =>
        !members || members.some((m) => m.type === type && m.id === id);
      const rows: Row[] = [
        // Agents that don't answer me aren't offered (the server would skip them anyway).
        ...dir.agents.filter(canTalk).map((a) => {
          const here = inChannel("agent", a.id) || mentionReaches(a, kind);
          return {
            key: `agent:${a.id}`,
            insert: a.handle,
            label: a.name,
            description: [`@${a.handle}`, a.role ? t("issues.agentRole", { role: a.role }) : null]
              .filter(Boolean)
              .join(" · "),
            leading: <AgentAvatar agentId={a.id} size="sm" name={a.name} />,
            note: here ? undefined : t("mentions.notInChannel"),
            inChannel: here,
            rank: fold(a.name).startsWith(q) || fold(a.handle).startsWith(q) ? 0 : 1,
            hay: `${fold(a.name)} ${fold(a.handle)}`,
          };
        }),
        ...dir.members
          .filter((m) => m.userId !== me.user.id)
          .map((m) => {
            const handle = m.handle;
            return {
              key: `person:${m.userId}`,
              insert: handle,
              label: m.name,
              description: `@${handle}`,
              leading: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
              inChannel: inChannel("person", m.userId),
              rank: fold(m.name).startsWith(q) || fold(handle).startsWith(q) ? 0 : 1,
              hay: `${fold(m.name)} ${fold(handle)} ${fold(m.email)}`,
            };
          }),
      ];
      const all = rows.filter((s) => !q || s.hay.includes(q));
      const here = t("mentions.inChannel");
      const rest = t("mentions.inWorkspace");
      const sorted = all.sort(
        (a, b) => Number(b.inChannel) - Number(a.inChannel) || a.rank - b.rank || a.label.localeCompare(b.label),
      );
      const listed = sorted.slice(0, LIMIT).map(({ inChannel: on, rank: _r, hay: _h, ...s }) => ({
        ...s,
        group: members ? (on ? here : rest) : undefined,
      }));
      const word = everyone ? everyoneSuggestion(query, i18n.language) : null;
      if (!word) return listed;
      const everyoneRow: ComposerSuggestion = {
        key: "everyone",
        insert: word,
        label: `@${word}`,
        description: t("mentions.everyone"),
        leading: <Icon name="members" size={16} />,
        group: members ? here : undefined,
      };
      return [everyoneRow, ...listed];
    },
    [dir, members, kind, me.user.id, t, everyone, i18n.language],
  );
}
