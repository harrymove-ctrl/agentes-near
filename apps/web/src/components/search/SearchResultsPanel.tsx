import type { SearchHit } from "@agenteschat/client";
import { useChannelCategories, useChannels } from "@agenteschat/client";
import { clockAt } from "@agenteschat/client/lib/format";
import { hitText } from "@agenteschat/client/lib/media";
import {
  groupHitsByPlace,
  markTerms,
  SEARCH_SORTS,
  searchChipLabel,
  searchTerms,
} from "@agenteschat/client/lib/search-filters";
import {
  Button,
  CountChip,
  EmptyState,
  Icon,
  Menu,
  MenuRadioGroup,
  Message,
  MessageText,
  Select,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useChannelActions } from "@/components/channel-actions";
import { ErrorState, LoadingList } from "@/components/Loading";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { useEscClose } from "@/hooks/useEscClose";
import { useMatchMedia } from "@/hooks/useMatchMedia";
import { groupHits, hitLink, SEARCH_PAGE, useHeaderSearch } from "@/hooks/useWorkspaceSearch";
import "./search.css";

/**
 * The header search's results in the conversation's side pane, where a thread opens: how many and for what, "Filtros"
 * back to the field, the sort; message hits by where they were said (a channel, a DM, a thread), each a message card
 * with its words marked and "Ir para". Other hits (actions, context) under their kind, while no filter is on.
 * "Ir para" on a reply opens its thread over them in the same panel (`hidden`, so they come back as they were); on a
 * message here the conversation goes to it and, once it is there, closes them (the header's field keeps the words);
 * another conversation's message closes them on the way there, its reply opens there with them.
 */
export function SearchResultsPanel({
  channelId,
  hidden,
  jumping,
  onClose,
  onOpenThread,
}: {
  channelId: string;
  hidden?: boolean;
  /** The message the conversation is still paging back to. */
  jumping?: string | undefined;
  onClose: () => void;
  onOpenThread: (threadId: string, focusMessageId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const ws = useHeaderSearch();
  const actions = useChannelActions();
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const categories = useChannelCategories(org.id);
  const phone = useMatchMedia(COMPACT_QUERY);
  const jumpedFrom = useRef<HTMLElement | null>(null);
  useEscClose(onClose);
  // Back from the thread a hit opened: where the person was, its back button gone.
  useEffect(() => {
    if (!hidden && document.activeElement === document.body) jumpedFrom.current?.focus({ preventScroll: true });
  }, [hidden]);
  const setShown = ws?.setShown;
  useEffect(() => {
    if (!setShown) return;
    setShown(true);
    return () => setShown(false);
  }, [setShown]);
  if (!ws) return null;
  const { hits, search, chips } = ws;
  const sorts = SEARCH_SORTS.map((s) => ({ value: s, label: t(`searchPage.sort.${s}`) }));
  const terms = searchTerms(ws.q);
  const categoryOf = (id: string) => {
    const category = channels.data?.find((c) => c.id === id)?.categoryId;
    return categories.data?.find((c) => c.id === category)?.name;
  };
  const placeName = (id: string) => {
    const place = ws.placeOf(id);
    return place ? (place.dm ? t("searchPage.dm", { name: place.name }) : place.name) : "";
  };
  const jump = (hit: SearchHit) => {
    const place = hit.channelIds[0];
    const m = hit.messageId;
    const reply = m && hit.threadId && hit.threadId !== m ? { id: hit.threadId, focus: m } : undefined;
    if (place === channelId && reply) {
      onOpenThread(reply.id, reply.focus);
      return;
    }
    if (place === channelId && m) {
      // Found, the conversation closes the results over it (a missing one says so, and they stay).
      actions?.jumpTo?.(m);
      return;
    }
    const link = hitLink(
      org.id,
      reply ? { ...hit, messageId: null, threadId: null } : hit,
      ws.placeOf(place) ? place : undefined,
      ws.dmWith(place),
    );
    if (!link) return;
    if (place && reply) ws.carry.current = { channelId: place, ...(reply ? { thread: reply.id } : {}) };
    else onClose();
    void navigate(reply ? { ...link, search: { thread: reply.id, tm: reply.focus } } : link);
  };
  const card = (hit: SearchHit) => {
    const author = hit.kind === "message" || hit.kind === "action" ? hit.author : null;
    const name = author?.name || hit.title;
    return (
      <div key={`${hit.kind}-${hit.sourceId}`} className="search-result">
        <Message
          agent={author?.type === "agent"}
          avatar={author ? <ActorAvatar actor={author} name={author.name} /> : undefined}
          author={<b>{name}</b>}
          time={<time dateTime={hit.createdAt}>{clockAt(i18n.language, hit.createdAt)}</time>}
        >
          <MessageText>
            {markTerms(hitText(t, hit), terms).map((s, i) =>
              s.mark ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed text
                <mark key={i} className="search-hit__mark">
                  {s.text}
                </mark>
              ) : (
                s.text
              ),
            )}
          </MessageText>
        </Message>
        {ws.placeOf(hit.channelIds[0]) && (hit.messageId || hit.channelIds[0] !== channelId) && (
          <Button
            size="sm"
            className="search-result__jump"
            aria-label={t("searchPage.panel.jumpLabel", { name })}
            disabled={Boolean(jumping)}
            loading={Boolean(jumping) && jumping === hit.messageId}
            onClick={(e) => {
              jumpedFrom.current = e.currentTarget;
              ws.remember();
              jump(hit);
            }}
          >
            {t("searchPage.panel.jump")}
          </Button>
        )}
      </div>
    );
  };
  const what = [...chips.map((c) => searchChipLabel(t, i18n.language, c)), ws.q.trim()].filter(Boolean).join(" · ");
  const count =
    hits.length >= SEARCH_PAGE
      ? t("searchPage.countMore", { count: SEARCH_PAGE })
      : t("searchPage.panel.count", { count: hits.length });
  return (
    <section className="shell__main shell__main--chat thread-panel__chat" hidden={hidden}>
      <header className="channel__header thread-head thread-head--panel search-panel__head">
        <span className="thread-head__who" aria-hidden="true">
          <Icon name="search" size={18} />
        </span>
        <div className="thread-head__text">
          <h1 className="channel__title thread-title" aria-live="polite">
            {search.isSuccess || hits.length ? count : t("searchPage.panel.label")}
          </h1>
          {what && (
            <span className="channel__topic thread-head__meta">
              <span className="thread-head__where">{what}</span>
            </span>
          )}
        </div>
        <Button
          size="sm"
          icon="filter"
          iconOnly={phone}
          className="search-panel__filters"
          aria-label={t("searchPage.panel.filtersCount", { count: chips.length })}
          onClick={() => {
            onClose();
            ws.field.current?.focus();
          }}
        >
          {!phone && <span className="search-panel__words">{t("searchPage.panel.filters")}</span>}
          {!phone && chips.length > 0 && <CountChip size="sm">{chips.length}</CountChip>}
        </Button>
        {phone ? (
          <Menu
            align="end"
            label={t("searchPage.sort.label")}
            trigger={<Button size="sm" icon="swap" iconOnly aria-label={t("searchPage.sort.label")} />}
          >
            <MenuRadioGroup
              label={t("searchPage.sort.label")}
              value={ws.sort}
              onValueChange={(v) => ws.setSort(v as typeof ws.sort)}
              options={sorts}
            />
          </Menu>
        ) : (
          <Select
            size="sm"
            aria-label={t("searchPage.sort.label")}
            value={ws.sort}
            onValueChange={ws.setSort}
            options={sorts}
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={onClose}
        />
      </header>
      <div className="search-panel__list">
        {!ws.active && (
          <EmptyState size="panel" icon="search">
            {t("searchPage.hint")}
          </EmptyState>
        )}
        {ws.active && search.isLoading && <LoadingList count={4} avatar={false} />}
        {ws.active && search.isError && !search.data && (
          <ErrorState error={search.error} onRetry={() => void search.refetch()} />
        )}
        {ws.active && search.isSuccess && hits.length === 0 && (
          <EmptyState size="panel" actions={<Button onClick={ws.clear}>{t("filters.clearSearch")}</Button>}>
            {t("searchPage.empty", { q: what })}
          </EmptyState>
        )}
        {groupHits(hits).map(([kind, list]) =>
          kind === "message" ? (
            groupHitsByPlace(list).map((g) => {
              const where = g.thread ? g.thread.title : placeName(g.channelId);
              return (
                <section key={g.key} className="search-panel__group" aria-label={where}>
                  <h2 className="search-panel__where">
                    <Icon name={g.thread ? "thread" : ws.placeOf(g.channelId)?.dm ? "message" : "channel"} size={16} />
                    <span className="search-panel__name">{where}</span>
                    <span className="search-panel__cat">
                      {g.thread
                        ? t("searchPage.panel.threadIn", { channel: placeName(g.channelId) })
                        : categoryOf(g.channelId)}
                    </span>
                  </h2>
                  {g.hits.map(card)}
                </section>
              );
            })
          ) : (
            <section key={kind} className="search-panel__group" aria-label={t(`searchPage.kinds.${kind as "message"}`)}>
              <h2 className="search-panel__where">{t(`searchPage.kinds.${kind as "message"}`)}</h2>
              {list.map(card)}
            </section>
          ),
        )}
      </div>
    </section>
  );
}
