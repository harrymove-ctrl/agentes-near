import { useTranslation } from "react-i18next";
import { RefreshControl } from "react-native";
import { STORED } from "@/lib/storage";
import { Button, LargeTitleScreen, PULL_TINT, PullOrbit, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useConversations } from "../shared/queries";
import { RetryLine, TeamSkyEmpty } from "../shared/TeamSkyEmpty";
import { useTabHeader } from "../shared/tabHeader";
import { ConversationRowView } from "./ConversationRowView";
import { CollapsibleSection, useCollapsedSections } from "./HomeSection";
import { THREAD_SECTIONS, threadRows, threadSections } from "./logic";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Threads, the second tab, named as its tab is: like the home, under the native large title with Você and "+" in
 * the bar, the sections Missões and Threads (collapsible, remembered) in Conversas' rows, each with its faint line
 * ("Missão · #produto") over the name and its state as words (amber for what waits on you, the orbit for who
 * works); what is closed sits at the end of its section. What waits on you is on Conversas' strip and in Atividade,
 * not repeated here. Loading: rows of its own shape. Empty: the sky with the team, and the way to the conversations.
 * `pushed`: the same list pushed from You › Work, with the back button in its bar, where a personal workspace
 * (ADR 0159) keeps it instead of a tab.
 */
export function ThreadsScreen({ pushed = false }: { pushed?: boolean }) {
  const { t } = useTranslation();
  const header = useTabHeader();
  const list = useConversations();
  const { collapsed, toggle } = useCollapsedSections(STORED.threadsCollapsed, THREAD_SECTIONS);
  const rows = threadRows(list.rows);
  const sections = threadSections(rows);
  const pull = usePullRefresh(() => list.refetch());
  let live = 0;
  const body = (
    <>
      {list.loading ? (
        <>
          <CollapsibleSection
            title={t("mobile.threads.section.missions")}
            count={0}
            collapsed={false}
            onToggle={() => {}}
          >
            <SkeletonList rows={2} />
          </CollapsibleSection>
          <CollapsibleSection
            title={t("mobile.threads.section.threads")}
            count={0}
            collapsed={false}
            onToggle={() => {}}
          >
            <SkeletonList rows={3} />
          </CollapsibleSection>
        </>
      ) : list.failed && rows.length === 0 ? (
        <RetryLine onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <TeamSkyEmpty
          title={t("mobile.empty.threads.title")}
          text={t("mobile.empty.threads.text")}
          action={
            <Button
              variant="secondary"
              size="sm"
              label={t("mobile.empty.threads.action")}
              onPress={() => router.navigate("/")}
            />
          }
        />
      ) : (
        sections.map((s) => {
          const off = collapsed.includes(s.key);
          return (
            <CollapsibleSection
              key={s.key}
              title={t(`mobile.threads.section.${s.key}`)}
              count={s.rows.length}
              collapsed={off}
              onToggle={() => toggle(s.key)}
            >
              {s.rows.map((r, i) => (
                <ConversationRowView key={r.key} row={r} divider={i > 0} live={!off && live++ < LIVE_ROWS} />
              ))}
            </CollapsibleSection>
          );
        })
      )}
    </>
  );
  if (pushed)
    return (
      <PushedLargeTitle
        title={t("mobile.threads.title")}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {body}
      </PushedLargeTitle>
    );
  return (
    <LargeTitleScreen
      title={t("mobile.threads.title")}
      {...header}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={PULL_TINT} />}
      pullMark={<PullOrbit refreshing={pull.refreshing} />}
    >
      {body}
    </LargeTitleScreen>
  );
}
