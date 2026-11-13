import type { SearchHit } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { hitText } from "@agenteschat/client/lib/media";
import { formatSearch, groupByChannel, SEARCH_SORTS } from "@agenteschat/client/lib/search-filters";
import { Button, EmptyState, List, PageHeader, Select, TabPanel, Tabs } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { SearchBox } from "@/components/search/SearchBox";
import { groupHits, hitLink, SEARCH_PAGE, useWorkspaceSearch } from "@/hooks/useWorkspaceSearch";

/**
 * "Buscar no workspace" (`GET …/search`, ADR 0123): words and filter chips (`from:`, `in:`, `has:`, `mentions:`,
 * dates, author type, pinned), recent searches, results by channel with a sort, each opening at its message.
 * Without chips it also finds the team's actions and context items, by kind. `scope`: opened from a channel or DM,
 * which starts as an `in:` chip.
 */
export function SearchPage({ scope }: { scope?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const ws = useWorkspaceSearch();
  const { chips, setChips, q, filter, setFilter, search, hits, active, filtered, placeOf, dmWith, remember } = ws;
  const { places } = ws;
  // The channel or DM it was opened from, once its name is known; only once, so removing the chip sticks
  // when the channel list refetches.
  const scoped = useRef(false);
  useEffect(() => {
    const place = scope && !scoped.current ? places.find((p) => p.id === scope) : undefined;
    if (!place) return;
    scoped.current = true;
    setChips((cs) => (cs.some((c) => c.op === "in") ? cs : [{ op: "in", place }, ...cs]));
  }, [scope, places, setChips]);

  const results = (
    <>
      {!active && (
        <EmptyState size="panel" icon="search">
          {t("searchPage.hint")}
        </EmptyState>
      )}
      {active && search.isLoading && <LoadingList count={4} avatar={false} />}
      {active && search.isError && !search.data && (
        <ErrorState error={search.error} onRetry={() => void search.refetch()} />
      )}
      {active && search.isSuccess && hits.length === 0 && (
        <EmptyState size="panel" actions={<Button onClick={ws.clear}>{t("filters.clearSearch")}</Button>}>
          {t("searchPage.empty", { q: formatSearch(chips, q) })}
        </EmptyState>
      )}
      {active && hits.length > 0 && (
        <div className="search-results__bar">
          <p className="small muted" style={{ margin: 0 }} role="status">
            {hits.length >= SEARCH_PAGE
              ? t("searchPage.countMore", { count: SEARCH_PAGE })
              : t("searchPage.count", { count: hits.length })}
          </p>
          {filtered && (
            <Button size="sm" variant="ghost" icon="close" onClick={() => setChips([])}>
              {t("searchPage.filtersApplied", { count: chips.length })}
            </Button>
          )}
          <Select
            size="sm"
            aria-label={t("searchPage.sort.label")}
            value={ws.sort}
            onValueChange={ws.setSort}
            options={SEARCH_SORTS.map((s) => ({ value: s, label: t(`searchPage.sort.${s}`) }))}
          />
        </div>
      )}
      {groupHits(hits).map(([kind, list]) =>
        kind === "message" ? (
          groupByChannel(list).map(([channelId, inChannel]) => {
            const place = placeOf(channelId);
            const heading = place ? (place.dm ? t("searchPage.dm", { name: place.name }) : `#${place.name}`) : "";
            return (
              <section key={`message-${channelId}`} className="section section--tight" aria-label={heading}>
                <h2 className="ac-eyebrow" style={{ margin: 0 }}>
                  {heading}
                </h2>
                <List>
                  {inChannel.map((h) => (
                    <HitRow
                      key={h.sourceId}
                      orgId={org.id}
                      hit={h}
                      channelId={place ? channelId : undefined}
                      dm={dmWith(channelId)}
                      onOpen={remember}
                    />
                  ))}
                </List>
              </section>
            );
          })
        ) : (
          <section
            key={kind}
            className="section section--tight"
            aria-label={t(`searchPage.kinds.${kind as "message"}`)}
          >
            <h2 className="ac-eyebrow" style={{ margin: 0 }}>
              {t(`searchPage.kinds.${kind as "message"}`)}
            </h2>
            <List>
              {list.map((h) => {
                const c = placeOf(h.channelIds[0]);
                return (
                  <HitRow
                    key={`${h.kind}-${h.sourceId}`}
                    orgId={org.id}
                    hit={h}
                    channelId={c?.id}
                    dm={dmWith(c?.id)}
                    channel={c?.name}
                    onOpen={remember}
                  />
                );
              })}
            </List>
          </section>
        ),
      )}
    </>
  );

  return (
    <div className="page page--full">
      <PageHeader title={t("searchPage.title")} meta={t("searchPage.subtitle")} />
      <SearchBox
        chips={chips}
        onChipsChange={setChips}
        text={ws.input}
        onTextChange={ws.setInput}
        onSubmit={remember}
        directory={ws.directory}
        words={ws.words}
        recent={ws.recent}
        onPickRecent={ws.pickRecent}
        onClearRecent={() => ws.saveRecent([])}
      />
      {filtered ? (
        results
      ) : (
        <Tabs
          value={filter}
          onValueChange={setFilter}
          label={t("searchPage.filter")}
          items={[
            { value: "all", label: t("searchPage.all") },
            { value: "action", label: t("searchPage.kinds.action") },
            { value: "message", label: t("searchPage.kinds.message") },
            { value: "context_item", label: t("searchPage.kinds.context_item") },
          ]}
        >
          <TabPanel value={filter}>{results}</TabPanel>
        </Tabs>
      )}
    </div>
  );
}

/**
 * One hit: its author's face and name, when, the text. A message opens at itself: a reply in its thread, a DM's
 * message in the DM (the channel route only knows channels).
 */
function HitRow({
  orgId,
  hit,
  channelId,
  dm,
  channel,
  onOpen,
}: {
  orgId: string;
  hit: SearchHit;
  channelId?: string;
  /** Who the DM is with, when the hit's place is a DM. */
  dm?: { type: "person" | "agent"; id: string };
  /** Shown in the line (hits not grouped by channel). */
  channel?: string;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  // An action's title is the tool's id: people see who did it instead.
  const meta = [
    hit.kind === "message" || hit.kind === "action" ? (hit.author?.name ?? null) : hit.title,
    channel ? t("searchPage.inChannel", { channel }) : null,
    relativeTime(t, i18n.language, hit.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  // A message is a MediaRow: its face and who, where and when on one line, the words under them; other hits start
  // with their text.
  const body =
    hit.kind === "message" && hit.author ? (
      <span className="search-hit ac-mediarow ac-mediarow--row">
        <span className="ac-mediarow__face">
          <ActorAvatar actor={hit.author} name={hit.author.name} size="sm" />
        </span>
        <span className="ac-mediarow__head small muted">{meta}</span>
        <span className="ac-mediarow__body">{hitText(t, hit)}</span>
      </span>
    ) : (
      <span className="search-hit">
        <span className="list-col">
          <span className="small muted">{meta}</span>
          <span>{hitText(t, hit)}</span>
        </span>
      </span>
    );
  const link = hitLink(orgId, hit, channelId, dm);
  if (!link) return <div className="ac-list__row">{body}</div>;
  return (
    <Link {...link} onClick={onOpen} className="ac-list__row">
      {body}
    </Link>
  );
}
