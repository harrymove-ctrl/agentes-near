import { errorCode, errorText, isGone, knownErrorText } from "@agenteschat/client/lib/errors";
import {
  Button,
  EmptyState,
  Skeleton,
  SkeletonCard,
  SkeletonConversation,
  SkeletonGroup,
  SkeletonList,
  TopProgress,
  useDelayed,
} from "@agenteschat/ui";
import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** Placeholder rows for a list (members, routines, PCs, search results…). */
export function LoadingList({
  count = 4,
  avatar = true,
  trailing,
  className,
}: {
  count?: number;
  avatar?: boolean;
  trailing?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <SkeletonList
      label={t("common.loadingList")}
      count={count}
      avatar={avatar}
      trailing={trailing}
      className={className}
    />
  );
}

/** One text line still loading (a summary row, a count): sized at once, shown after 150 ms. */
export function LoadingLine({ width = 180 }: { width?: number | string }) {
  const { t } = useTranslation();
  const shown = useDelayed(true);
  return (
    <span className="loading-line" role="status" aria-label={t("common.loading")}>
      <Skeleton width={width} style={{ visibility: shown ? "visible" : "hidden" }} />
    </span>
  );
}

/** A conversation loading: messages shaped like the real ones (`count`: a thread's replies still on their way). */
export function LoadingConversation({ count }: { count?: number }) {
  const { t } = useTranslation();
  return <SkeletonConversation label={t("common.loadingMessages")} count={count} />;
}

/** Cards (Issues board, Drive, Calendário). */
export function LoadingCards({ count = 3, className }: { count?: number; className?: string }) {
  const { t } = useTranslation();
  return (
    <SkeletonGroup label={t("common.loadingList")} className={className ?? "loading-cards"}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
        <SkeletonCard key={i} seed={i} lines={2} />
      ))}
    </SkeletonGroup>
  );
}

/** A page loading: a title bar and a few rows (keeps the page layout). */
export function LoadingPage({ rows = 4 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <SkeletonGroup label={t("common.loadingPage")} className="loading-page">
      <Skeleton width={220} height={24} />
      <Skeleton width="50%" />
      <div className="loading-page__rows">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
          <SkeletonCard key={i} seed={i} lines={1} />
        ))}
      </div>
    </SkeletonGroup>
  );
}

/** Next step after this long (a long action: install, connect). */
export const STEP_EVERY_MS = 2500;

/** Which step of a long action to show, by time since it started (pure; tests pass a fake clock). */
export const stepAt = (sinceMs: number, nowMs: number, steps: number, everyMs = STEP_EVERY_MS) =>
  Math.min(steps - 1, Math.max(0, Math.floor((nowMs - sinceMs) / everyMs)));

/** The step text of a long action while `active` ("Baixando a skill" → "Lendo os arquivos"…). */
export function useStepText(active: boolean, steps: string[]) {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setSince(null);
      return;
    }
    const start = Date.now();
    setSince(start);
    setNow(start);
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  if (!active || since === null || steps.length === 0) return undefined;
  return steps[stepAt(since, now, steps.length)];
}

/**
 * A friendly line and one action: "Tentar de novo", unless what it loads is gone or its workspace is being deleted,
 * which no try changes.
 */
export function ErrorState({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  const { t, i18n } = useTranslation();
  const gone = isGone(error);
  const final = gone || errorCode(error) === "org.deleting";
  // A query's `error` is null when it holds none: nothing to read, so the load just failed.
  const message =
    error == null
      ? t("common.loadFailed")
      : gone
        ? (knownErrorText(t, error, i18n.language) ?? t("common.gone"))
        : errorText(t, error, i18n.language);
  return (
    <EmptyState
      icon="alert"
      actions={
        onRetry && !final ? (
          <Button size="sm" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        ) : undefined
      }
    >
      {message}
    </EmptyState>
  );
}

/**
 * A thin bar at the top of the page while cached data refreshes (queries
 * that already have data; polling and background queries opt out with
 * `meta: { quiet: true }`).
 */
export function RefetchBar() {
  const { t } = useTranslation();
  const refreshing = useIsFetching({
    predicate: (q) => q.state.data !== undefined && q.meta?.quiet !== true,
  });
  return <TopProgress active={refreshing > 0} label={t("common.refreshing")} />;
}
