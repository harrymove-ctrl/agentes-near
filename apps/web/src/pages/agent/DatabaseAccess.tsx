import type { AgentDatabase, DatabaseConnection, DatabasePolicy } from "@agenteschat/client";
import { useAgentDatabases, useDatabases, useSetAgentDatabase } from "@agenteschat/client";
import type { Level } from "@agenteschat/client/lib/access-levels";
import { databaseRulesCount, defaultDatabasePolicy } from "@agenteschat/client/lib/databases";
import { Alert, Button, Card, CountChip, Icon } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LevelRow } from "@/components/AccessLevels";
import { DatabaseIcon } from "@/components/DatabaseConnect";
import { DatabaseRulesPanel } from "@/components/DatabaseRules";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";

/**
 * Ferramentas e acesso → Bancos de dados (ADR 0039): one row per database of
 * the organization, "Sem acesso" or "Ler", and the rules. Each database
 * saves on its own ("Salvar"), outside the page's save bar, like email.
 */
export function DatabaseAccessCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, can } = useAgentEdit();
  const connections = useDatabases(org.id);
  const saved = useAgentDatabases(org.id, agent.id, (connections.data?.length ?? 0) > 0);
  const list = connections.data ?? [];
  if (list.length === 0) return null;
  return (
    <Card as="section" className="agp-card" aria-labelledby="ac-databases">
      <CardHead
        id="ac-databases"
        icon="database"
        title={t("database.agent.title")}
        action={<span className="small muted">{t("database.agent.help", { org: org.name })}</span>}
      />
      <ul className="level-list" aria-label={t("database.agent.title")}>
        {list.map((connection) => (
          <DatabaseRowAccess
            key={connection.id}
            connection={connection}
            saved={saved.data?.find((d) => d.connectionId === connection.id) ?? null}
            loading={saved.isLoading}
            editable={can("levels")}
          />
        ))}
      </ul>
    </Card>
  );
}

interface Draft {
  level: Level;
  policy: DatabasePolicy;
}

const draftOf = (connection: DatabaseConnection, saved: AgentDatabase | null): Draft => ({
  level: saved?.level === "read" ? "read" : "none",
  policy: saved?.policy ?? defaultDatabasePolicy(connection),
});

function DatabaseRowAccess({
  connection,
  saved,
  loading,
  editable,
}: {
  connection: DatabaseConnection;
  saved: AgentDatabase | null;
  loading: boolean;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const toast = useToast();
  const set = useSetAgentDatabase(org.id);
  const base = JSON.stringify(draftOf(connection, saved));
  const [edit, setEdit] = useState<{ from: string; draft: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const reset = () => {
    setEdit(null);
    setError(null);
    setRound((n) => n + 1);
  };
  const draft = edit && edit.from === base ? edit.draft : draftOf(connection, saved);
  const change = (next: Partial<Draft>) => {
    setError(null);
    setEdit({ from: base, draft: { ...draft, ...next } });
  };
  const dirty = JSON.stringify(draft) !== base;
  const save = () =>
    set.mutate(
      {
        agentId: agent.id,
        connectionId: connection.id,
        input: { level: draft.level === "none" ? "none" : "read", policy: draft.policy },
      },
      {
        onSuccess: () => {
          reset();
          toast.show(t("database.agent.saved", { name: agent.name }));
        },
        onError: () => setError(t("mail.agent.saveError.unknown")),
      },
    );
  const count = databaseRulesCount(draft.policy);
  return (
    <LevelRow
      icon={<DatabaseIcon />}
      name={connection.label}
      description={
        draft.level === "none"
          ? t("access.noneText")
          : connection.wholeServer
            ? draft.policy.databases?.length
              ? t("database.agent.someDatabases", { count: draft.policy.databases.length, name: connection.label })
              : t("database.agent.allDatabases", { name: connection.label })
            : t("database.agent.levelText")
      }
      levels={["none", "read"]}
      value={draft.level}
      onChange={editable && !loading ? (level) => change({ level }) : undefined}
      changed={dirty}
      below={
        draft.level !== "none" || dirty ? (
          <div className="mail-agent">
            {draft.level !== "none" && (
              <details className="mail-rules">
                <summary aria-label={t("database.agent.rulesOf", { name: connection.label })}>
                  <Icon name="filter" size={14} />
                  <span>{t("mail.agent.rules")}</span>
                  {count > 0 ? (
                    <CountChip size="sm">{count}</CountChip>
                  ) : (
                    <span className="small muted">{t("mail.agent.noRules")}</span>
                  )}
                </summary>
                <DatabaseRulesPanel
                  key={round}
                  connection={connection}
                  policy={draft.policy}
                  onChange={(policy) => change({ policy })}
                  disabled={!editable}
                />
              </details>
            )}
            {error && <Alert>{error}</Alert>}
            {dirty && editable && (
              <div className="mail-agent__save">
                <span className="small muted">{t("mail.agent.unsaved")}</span>
                <Button size="sm" onClick={reset}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="primary" disabled={set.isPending} loading={set.isPending} onClick={save}>
                  {t("mail.agent.save")}
                </Button>
              </div>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
