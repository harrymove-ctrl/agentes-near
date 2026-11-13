import type { Artifact, ArtifactKind } from "@agenteschat/client";
import { useArtifacts, useChannels } from "@agenteschat/client";
import { mayAsk } from "@agenteschat/client/lib/audience";
import { relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Card, EmptyState, Icon, SearchField, Segmented, Toolbar } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskAgentButton } from "@/components/AskAgentButton";
import { useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { DrivePreview } from "@/components/drive/DrivePreview";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { lookOf } from "@/lib/look";
import { CardHead, useAgentEdit } from "./context";

const KINDS: ArtifactKind[] = ["document", "table", "file", "diagram", "html", "diff"];

/**
 * Arquivos: the Drive files this agent made or changed, newest first,
 * each with where it came from and how many versions; opening one opens it as the Drive does. Only
 * files of conversations the viewer sees (the Drive's own visibility).
 */
export function FilesTab() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const g = agentGrammar(agent.name);
  const [kind, setKind] = useState<ArtifactKind | "all">("all");
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  // The kind and the words go to the server: they look at every file of the agent, not the pages loaded.
  const files = useArtifacts(org.id, {
    author: { type: "agent", id: agent.id },
    changed: true,
    ...(kind === "all" ? {} : { kind }),
    ...(search ? { q: search } : {}),
  });
  const channels = useChannels(org.id);
  const viewer = useArtifactViewer();
  const authorName = useAuthorName();
  const shown = files.artifacts ?? [];
  const count = (k: ArtifactKind) => files.counts?.[k] ?? 0;
  const all = KINDS.reduce((n, k) => n + count(k), 0);
  // The agent has files at all, whatever the search: the toolbar stays.
  const any = all > 0 || shown.length > 0 || Boolean(search) || kind !== "all";
  const channelName = (id: string | null) => {
    const c = id ? channels.data?.find((x) => x.id === id) : undefined;
    return c ? `#${c.name}` : t("artifacts.noChannel");
  };
  const sub = (a: Artifact) =>
    [
      t(`artifacts.kind.${a.kind}`),
      a.version > 1 ? t("artifacts.version", { version: a.version }) : null,
      a.createdBy.type === "agent" && a.createdBy.id === agent.id
        ? null
        : t("agentPage.files.changedOther", { ...g, owner: authorName(a.createdBy) }),
      channelName(a.channelId),
      relativeTime(t, i18n.language, a.updatedAt),
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Card as="section" className="agp-card" aria-labelledby="agent-files">
      <CardHead
        id="agent-files"
        icon="drive"
        title={t("agentPage.files.title", g)}
        subtitle={t("agentPage.files.subtitle", g)}
        action={
          <Link className="agp-more" to="/org/$orgId/drive" params={{ orgId: org.id }}>
            {t("agentPage.files.drive")}
            <Icon name="arrowRight" size={14} />
          </Link>
        }
      />
      {any && (
        <Toolbar
          size="sm"
          search={
            <SearchField
              size="sm"
              aria-label={t("drive.search")}
              placeholder={t("agentPage.files.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
            />
          }
        >
          <Segmented
            size="sm"
            label={t("drive.kind")}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "all" as const, label: t("agentPage.files.all"), count: all },
              ...KINDS.filter((k) => count(k) > 0).map((k) => ({
                value: k,
                label: t(`drive.kindMany.${k}`),
                count: count(k),
              })),
            ]}
          />
        </Toolbar>
      )}
      {files.isLoading ? (
        <LoadingLine width={260} />
      ) : files.isError && !files.data ? (
        <ErrorState error={files.error} onRetry={() => void files.refetch()} />
      ) : !any ? (
        <EmptyState
          size="panel"
          agent={lookOf(agent) ?? true}
          title={mayAsk(org, agent) ? t("agentPage.files.empty") : undefined}
          actions={
            <AskAgentButton
              agent={agent}
              variant="primary"
              label={t("agentPage.files.ask")}
              draft={t("agentPage.files.askText")}
            />
          }
        >
          {t("agentPage.files.emptyText", g)}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState
          size="inline"
          actions={
            <Button
              size="sm"
              onClick={() => {
                setKind("all");
                setQ("");
              }}
            >
              {t("drive.clear")}
            </Button>
          }
        >
          {t("drive.noResults")}
        </EmptyState>
      ) : (
        <ul className="agp-list agp-files">
          {shown.map((a) => (
            <li key={a.id} className="agp-file">
              <DrivePreview artifact={a} size="sm" />
              <span className="agp-file__text">
                <button type="button" className="agp-file__title" onClick={() => viewer.open(a.id)}>
                  {a.title}
                </button>
                <span className="small muted">{sub(a)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => viewer.open(a.id)}>
                {t("artifacts.openFile")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {files.hasNextPage && shown.length > 0 && (
        <div className="agp-files__more">
          <Button size="sm" loading={files.isFetchingNextPage} onClick={() => void files.fetchNextPage()}>
            {t("drive.loadMore")}
          </Button>
        </div>
      )}
      {any && (
        <p className="agp-files__note small muted ac-iconline">
          <Icon name="info" size={14} />
          {t("agentPage.files.note")}
        </p>
      )}
    </Card>
  );
}
