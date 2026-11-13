import { useChannels, useDms, useSearch } from "@agenteschat/client";
import { hitText } from "@agenteschat/client/lib/media";
import { previewBody } from "@agenteschat/client/lib/message-body";
import { makesAgents } from "@agenteschat/client/lib/permissions";
import { searchTerms } from "@agenteschat/client/lib/search-filters";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, SectionHeader, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { previewOf } from "../shared/logic";
import { ActionList, Tile } from "../shared/parts";
import { hitHref, isEmpty, SEARCH_KINDS, type SearchAction, searchResults } from "./logic";
import { RESULT_LEAD } from "./SearchFilters";

const ACTION_ICON = { newConversation: "compose", newTask: "target", newAgent: "agent" } as const;

/**
 * Busca, under the field of the search tab (the phone's ⌘K): the actions with no words, then the results grouped
 * (Conversas, Ações do time, Mensagens, Arquivos), each group's count on its header and the words looked for lit in
 * the lines. A message opens its conversation at that message; a file opens in the app's own viewer. While the
 * results come, rows of their shape stand in.
 */
export function SearchResults({ q }: { q: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const when = useWhen();
  const createsAgents = makesAgents(useOrg().org);
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const hits = useSearch(orgId, q, SEARCH_KINDS);
  const labels: Record<SearchAction, string> = {
    newConversation: t("mobile.find.action.newConversation"),
    newTask: t("mobile.find.action.newTask"),
    newAgent: t("mobile.find.action.newAgent"),
  };
  const found = searchResults(q, {
    actionLabels: labels,
    agents: dir.agents,
    channels: (channels.data ?? []).filter((x) => x.isMember),
    dms: dms.data ?? [],
    hits: hits.data ?? [],
  });
  // "Novo agente" only for who may create one (ADR 0085).
  const r = createsAgents ? found : { ...found, actions: found.actions.filter((a) => a !== "newAgent") };
  const runAction = (a: SearchAction) => {
    if (a === "newConversation") router.push("/new-chat");
    else if (a === "newAgent") router.push("/new-agent");
    else router.navigate("/agents");
  };
  const channelName = (id: string | undefined) => (id ? channels.data?.find((x) => x.id === id)?.name : undefined);
  // The app's own viewer (a document, an image), never the browser.
  const openFile = (id: string) => router.push({ pathname: "/file/[id]", params: { id } });
  const words = Boolean(q.trim());
  const terms = searchTerms(q);

  return (
    <View>
      <View style={styles.res}>
        {r.actions.length > 0 ? (
          <Group title={t("mobile.find.actions")}>
            <ActionList
              items={r.actions.map((a) => ({
                key: a,
                icon: ACTION_ICON[a],
                label: labels[a],
                onPress: () => runAction(a),
              }))}
            />
          </Group>
        ) : null}
        {words && r.agents.length + r.channels.length + r.dms.length > 0 ? (
          <Group title={t("mobile.find.conversations")} count={r.agents.length + r.channels.length + r.dms.length}>
            <ActionList
              items={[
                ...r.agents.map((a) => ({
                  key: `a:${a.id}`,
                  leading: <AgentFace agentId={a.id} size={RESULT_LEAD} live={false} />,
                  label: a.name,
                  marks: terms,
                  oneLine: true,
                  ...(a.role ? { hint: a.role } : {}),
                  onPress: () => router.push(`/agent/${a.id}`),
                })),
                ...r.dms.map((d) => ({
                  key: `d:${d.channelId}`,
                  leading: <Face who={{ type: d.with.type, id: d.with.id }} size={RESULT_LEAD} live={false} />,
                  label: d.with.name,
                  marks: terms,
                  oneLine: true,
                  ...(d.lastMessage
                    ? {
                        hint: previewBody(
                          t,
                          previewOf(d.lastMessage.body),
                          d.lastMessage.meta ?? null,
                          d.lastMessage.mediaKind,
                        ),
                      }
                    : {}),
                  onPress: () => router.push(chatHref(d.channelId)),
                })),
                ...r.channels.map((ch) => ({
                  key: `c:${ch.id}`,
                  leading: <Tile icon="hash" size={RESULT_LEAD} />,
                  label: `#${ch.name}`,
                  marks: terms,
                  oneLine: true,
                  ...(ch.topic ? { hint: ch.topic } : {}),
                  onPress: () => router.push(chatHref(ch.id)),
                })),
              ]}
            />
          </Group>
        ) : null}
        {r.team.length > 0 ? (
          <Group title={t("searchPage.kinds.action")} count={r.team.length}>
            <ActionList
              items={r.team.map((h) => {
                const channelId = h.channelIds[0] ?? "";
                const where = channelName(channelId);
                return {
                  key: h.sourceId,
                  leading: h.author ? (
                    <AgentFace agentId={h.author.id} size={RESULT_LEAD} live={false} />
                  ) : (
                    <Tile icon="reply" size={RESULT_LEAD} />
                  ),
                  label: previewOf(h.snippet || h.title),
                  marks: terms,
                  hint: [
                    h.author?.name,
                    where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null,
                    when.short(h.createdAt),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  onPress: () => router.push(chatHref(channelId)),
                };
              })}
            />
          </Group>
        ) : null}
        {r.messages.length > 0 ? (
          <Group title={t("mobile.find.messages")} count={r.messages.length}>
            <ActionList
              items={r.messages.map((h) => {
                const where = channelName(h.channelIds[0]);
                // Who said it leads the line; where and when follow on one meta line.
                return {
                  key: h.sourceId,
                  leading: h.author ? (
                    <Face who={h.author} size={RESULT_LEAD} live={false} />
                  ) : (
                    <Tile icon="chat" size={RESULT_LEAD} />
                  ),
                  label: previewOf(hitText(t, h) || h.title),
                  marks: terms,
                  hint: [
                    h.author?.name,
                    where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null,
                    when.short(h.createdAt),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  // The conversation opens at the message itself (a reply in its thread), not at its end.
                  onPress: () => router.push(hitHref(h)),
                };
              })}
            />
          </Group>
        ) : null}
        {r.files.length > 0 ? (
          <Group title={t("mobile.find.files")} count={r.files.length}>
            <ActionList
              items={r.files.map((h) => {
                const where = channelName(h.channelIds[0]);
                return {
                  key: h.sourceId,
                  leading: <Tile icon="doc" size={RESULT_LEAD} />,
                  label: h.title || t("mobile.chat.file"),
                  marks: terms,
                  hint: [where ? t("mobile.chats.waitIn", { where: `#${where}` }) : null, when.short(h.createdAt)]
                    .filter(Boolean)
                    .join(" · "),
                  onPress: () => openFile(h.sourceId),
                };
              })}
            />
          </Group>
        ) : null}
        {words && hits.isLoading ? <SkeletonList rows={3} /> : null}
        {words && isEmpty(r) && !hits.isFetching ? (
          <EmptyState size="inline" title={t("mobile.find.nothing", { q: q.trim() })} />
        ) : null}
      </View>
    </View>
  );
}

/** A group of results under the app's section header, with how many it holds, said once; the list at the 16 margin. */
function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <View>
      <SectionHeader title={title} {...(count !== undefined ? { count } : {})} />
      <View style={styles.list}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  res: { paddingTop: 2 },
  list: { paddingHorizontal: 16 },
});
