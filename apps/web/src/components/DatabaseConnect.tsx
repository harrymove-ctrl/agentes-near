import type {
  Agent,
  DatabaseConnectError,
  DatabaseConnection,
  DatabasePolicy,
  DatabaseProvider,
} from "@agenteschat/client";
import { keys, useAgentDatabases, useAgents, useDatabaseAction, useServerDatabases } from "@agenteschat/client";
import type { Level } from "@agenteschat/client/lib/access-levels";
import {
  activeGrantCount,
  DATABASE_PROVIDER_URLS,
  DATABASE_PROVIDERS,
  databaseErrorOf,
  databaseNameOf,
  databaseOffActions,
  databaseReviewTools,
  defaultDatabasePolicy,
  isDatabaseUrl,
  POSTGRES_MARK,
  readOnlyRoleSql,
  widensDatabaseScope,
} from "@agenteschat/client/lib/databases";
import { relativeTime } from "@agenteschat/client/lib/format";
import {
  Alert,
  AvatarStack,
  Button,
  CheckboxPill,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Locked,
  Segmented,
  Select,
  useUnsavedInDialog,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DatabaseRulesPanel } from "@/components/DatabaseRules";
import { FlowTitle } from "@/components/FlowTitle";
import { LoadingList, useStepText } from "@/components/Loading";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { reviewNote, ToolReview, type ToolReviewState } from "@/components/ToolReview";
import { useEdited } from "@/hooks/useEdited";
import { useToast } from "@/lib/toast";

/**
 * People's Postgres databases for agents (ADR 0039), in the connectors' own
 * shapes: a catalog card, the same connect flow as email (conectar → o que
 * faz → quem pode usar → regras), a connected row, "Reconectar" and
 * "Desconectar". Agents only read.
 */

/** Read-only for now: "Sem acesso" or "Ler". */
const DB_LEVELS: Level[] = ["none", "read"];

export function DatabaseIcon({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={`connector-icon${size === "lg" ? " connector-icon--lg" : ""} connector-icon--brand`}
      aria-hidden="true"
    >
      <img className="connector-icon__img" src={POSTGRES_MARK} alt="" />
    </span>
  );
}

export type DatabaseFlowState =
  | { step: 0 }
  | { step: 1 | 2; connection: DatabaseConnection }
  | { step: 3; connection: DatabaseConnection; agentIds: string[] };

/** The connect flow for a database: the same dialog, steps and footer as the other connectors. */
export function DatabaseConnectFlow({
  flow,
  onChange,
  onClose,
}: {
  flow: DatabaseFlowState | null;
  onChange: (flow: DatabaseFlowState) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  if (!flow) return null;
  const name = flow.step === 0 ? t("database.name") : flow.connection.label;
  const title =
    flow.step === 0
      ? t("connectFlow.connectTitle", { name })
      : flow.step === 1
        ? t("connectFlow.toolsTitle", { name })
        : flow.step === 2
          ? t("connectFlow.whoTitle", { name })
          : t("database.rulesTitle", { name });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={<FlowTitle tile={<DatabaseIcon size="lg" />}>{title}</FlowTitle>}
      closeLabel={t("common.close")}
      width={620}
      className="cflow"
    >
      <ol className="cflow__steps" aria-label={t("connectFlow.steps")}>
        {([0, 1, 2, 3] as const).map((i) => (
          <li key={i} data-on={i <= flow.step || undefined} aria-current={i === flow.step ? "step" : undefined}>
            <span className="ac-visually-hidden">{i === 3 ? t("database.rulesStep") : t(`connectFlow.step.${i}`)}</span>
          </li>
        ))}
      </ol>
      {flow.step === 0 && (
        <ConnectStep onConnected={(connection) => onChange({ step: 1, connection })} onClose={onClose} />
      )}
      {flow.step === 1 && (
        <ActionsStep
          connection={flow.connection}
          onNext={() => onChange({ step: 2, connection: flow.connection })}
          onClose={onClose}
        />
      )}
      {flow.step === 2 && (
        <WhoStep
          key={flow.connection.id}
          connection={flow.connection}
          onBack={() => onChange({ step: 1, connection: flow.connection })}
          onRules={(agentIds) => onChange({ step: 3, connection: flow.connection, agentIds })}
          onClose={onClose}
        />
      )}
      {flow.step === 3 && (
        <RulesStep
          connection={flow.connection}
          agentIds={flow.agentIds}
          onBack={() => onChange({ step: 2, connection: flow.connection })}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/** "Como criar um usuário só de leitura?": where the address is, three steps, the SQL to paste and the provider's page. */
export function ReadOnlyUserHelp({
  provider,
  database,
  wholeServer,
}: {
  provider: DatabaseProvider;
  database: string;
  wholeServer?: boolean;
}) {
  const { t } = useTranslation();
  const url = DATABASE_PROVIDER_URLS[provider];
  return (
    <div className="mail-howto">
      <b>{t("database.howTitle")}</b>
      <span className="small muted">{t("database.howText")}</span>
      <ol className="mail-howto__steps small">
        {(["1", "2", "3"] as const).map((n) => (
          <li key={n}>{t(`database.how.${provider}.${n}`)}</li>
        ))}
      </ol>
      <CommandBlock command={readOnlyRoleSql(database || "postgres", { wholeServer })} />
      {wholeServer && <span className="small muted">{t("database.howAll")}</span>}
      {url && (
        <a className="ac-link small mail-howto__link" href={url} target="_blank" rel="noreferrer noopener">
          <Icon name="external" size={14} />
          {t("database.openPage", { name: t(`database.provider.${provider}`) })}
        </a>
      )}
    </div>
  );
}

/**
 * Step 1: where the database lives, a name and its address (or the fields
 * under "Avançado"), with how to make a read-only user; "Conectar" tests it
 * (server reachable and public, secure connection, login, what the user can do).
 */
function ConnectStep({
  onConnected,
  onClose,
}: {
  onConnected: (connection: DatabaseConnection) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { connect } = useDatabaseAction(org.id);
  const [provider, setProvider] = useState<DatabaseProvider>("supabase");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sslmode, setSslmode] = useState<"require" | "disable">("require");
  /** "Quais bancos"; null = follows whether a database name was given. */
  const [scope, setScope] = useState<"one" | "all" | null>(null);
  const [prefix, setPrefix] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<DatabaseConnectError | null>(null);
  useUnsavedInDialog(useEdited(true, [label, url, host, port, database, username, password, prefix]));
  const fields = host.trim() !== "" && username.trim() !== "" && password !== "";
  const urlError = touched && !fields && !isDatabaseUrl(url) ? t("database.urlInvalid") : undefined;
  const dbName = database.trim() || databaseNameOf(url);
  const whole = (scope ?? (dbName ? "one" : "all")) === "all";
  const testing = useStepText(connect.isPending, [
    t("database.testing.reach"),
    ...(whole ? [t("database.testing.databases")] : []),
    t("database.testing.tables"),
    t("connectFlow.almost"),
  ]);

  const submit = () => {
    setTouched(true);
    setError(null);
    if (!fields && !isDatabaseUrl(url)) return;
    const n = Number.parseInt(port, 10);
    connect.mutate(
      {
        provider,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(host.trim() ? { host: host.trim() } : {}),
        ...(host.trim() && Number.isFinite(n) && n > 0 && n < 65536 ? { port: n } : {}),
        ...(database.trim() ? { database: database.trim() } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(password ? { password } : {}),
        ...(sslmode === "disable" ? { sslmode } : {}),
        ...(whole ? { wholeServer: true, ...(prefix.trim() ? { databasePrefix: prefix.trim() } : {}) } : {}),
      },
      {
        onSuccess: (connection) => {
          toast.show(
            connection.wholeServer && connection.databaseCount !== null
              ? t("database.connectedToastAll", { name: connection.label, count: connection.databaseCount })
              : t("database.connectedToast", { name: connection.label }),
          );
          onConnected(connection);
        },
        onError: (e) => setError(databaseErrorOf(e)),
      },
    );
  };

  return (
    <form
      style={{ display: "contents" }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Locked when={connect.isPending}>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("database.connectText")}</p>
          <Field label={t("database.providerLabel")} id="db-provider">
            <Select
              value={provider}
              onValueChange={(v) => setProvider(v as DatabaseProvider)}
              options={DATABASE_PROVIDERS.map((p) => ({ value: p, label: t(`database.provider.${p}`) }))}
            />
          </Field>
          <Field
            label={t("connectFlow.name")}
            id="db-label"
            hint={{ name: t("common.about", { label: t("connectFlow.name") }), text: t("database.nameHelp") }}
          >
            <Input
              value={label}
              placeholder={t("database.namePlaceholder")}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <Field label={t("database.url")} id="db-url" example={t("database.urlHelp")} error={urlError}>
            <Input
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              value={url}
              placeholder={t("database.urlPlaceholder")}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
            />
          </Field>
          <ScopeFields
            whole={whole}
            prefix={prefix}
            onScope={(v) => {
              setScope(v);
              setError(null);
            }}
            onPrefix={setPrefix}
          />
          <ReadOnlyUserHelp provider={provider} database={dbName} wholeServer={whole} />
          <p className="small muted mail-hint">
            <Icon name="info" size={14} />
            <span>{t("database.dedicated")}</span>
          </p>
          <details
            className="cflow__more"
            open={advanced}
            onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>{t("mail.advanced")}</summary>
            <div className="cflow__key">
              <p className="small muted">{t("database.advancedText")}</p>
              <div className="mail-host">
                <Field label={t("database.host")} id="db-host">
                  <Input autoComplete="off" value={host} onChange={(e) => setHost(e.target.value)} />
                </Field>
                <Field label={t("mail.port")} id="db-port">
                  <Input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
                </Field>
              </div>
              <Field
                label={t("database.database")}
                id="db-database"
                hint={
                  whole
                    ? {
                        name: t("common.about", { label: t("database.database") }),
                        text: t("database.databaseOptional"),
                      }
                    : undefined
                }
              >
                <Input autoComplete="off" value={database} onChange={(e) => setDatabase(e.target.value)} />
              </Field>
              <Field label={t("mail.username")} id="db-username">
                <Input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field
                label={t("database.password")}
                id="db-password"
                hint={{ name: t("common.about", { label: t("database.password") }), text: t("mail.passwordHelp") }}
              >
                <Input
                  type="password"
                  // "new-password": the browser must not fill a saved login into this form (it put the
                  // person's email in the address field).
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field
                label={t("database.ssl")}
                id="db-ssl"
                example={sslmode === "disable" ? t("database.sslOffHelp") : undefined}
              >
                <Select
                  value={sslmode}
                  onValueChange={(v) => setSslmode(v === "disable" ? "disable" : "require")}
                  options={[
                    { value: "require", label: t("database.sslRequire") },
                    { value: "disable", label: t("database.sslDisable") },
                  ]}
                />
              </Field>
            </div>
          </details>
          {error && <Alert>{t(`database.error.${error}`)}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={testing ?? t("connectFlow.nothingYet")}>
        <Button type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={connect.isPending} loading={connect.isPending}>
          {t("database.connect")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Quais bancos" and, for every database, "Só os que começam com". */
function ScopeFields({
  whole,
  prefix,
  onScope,
  onPrefix,
}: {
  whole: boolean;
  prefix: string;
  onScope: (scope: "one" | "all") => void;
  onPrefix: (prefix: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field
        label={t("database.scope")}
        group
        hint={
          whole
            ? { name: t("common.about", { label: t("database.scope") }), text: t("database.scopeAllHelp") }
            : undefined
        }
      >
        <Segmented
          label={t("database.scope")}
          value={whole ? "all" : "one"}
          onValueChange={onScope}
          options={[
            { value: "one", label: t("database.scopeOne") },
            { value: "all", label: t("database.scopeAll") },
          ]}
        />
      </Field>
      {whole && (
        <Field
          label={t("database.prefix")}
          id="db-prefix"
          hint={{ name: t("common.about", { label: t("database.prefix") }), text: t("database.prefixHelp") }}
        >
          <Input
            autoComplete="off"
            spellCheck={false}
            maxLength={63}
            value={prefix}
            placeholder={t("database.prefixPlaceholder")}
            onChange={(e) => onPrefix(e.target.value)}
          />
        </Field>
      )}
    </>
  );
}

/** Step 2: which of the database's tools agents get, in the standard tool review (Consulta · Desligada). */
function ActionsStep({
  connection,
  onNext,
  onClose,
}: {
  connection: DatabaseConnection;
  onNext: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { update } = useDatabaseAction(org.id);
  const tools = databaseReviewTools(t, connection);
  const [state, setState] = useState<ToolReviewState>({ levels: {}, decided: new Set() });
  const next = () => {
    const off = databaseOffActions(tools, state.levels);
    const same = off.length === connection.offActions.length && off.every((a) => connection.offActions.includes(a));
    if (same) return onNext();
    update.mutate({ connectionId: connection.id, offActions: off }, { onSuccess: onNext });
  };
  return (
    <>
      <Locked when={update.isPending}>
        <DialogBody className="cflow__body tr-body">
          {connection.canWrite && <Alert tone="neutral">{t("database.canWrite")}</Alert>}
          <p className="muted cflow__text">{t("database.toolsLead", { name: connection.label })}</p>
          <ToolReview
            name={connection.label}
            tools={tools}
            state={state}
            onChange={setState}
            onMoved={(m) => toast.show(m)}
          />
          {update.isError && <Alert>{t("mail.actionsError")}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={reviewNote(t, tools, state)}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={update.isPending} loading={update.isPending} onClick={next}>
          {t("connectFlow.next")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Step 3: "Sem acesso" or "Ler" per agent; each keeps its rules for this database. Then the rules. */
function WhoStep({
  connection,
  onBack,
  onRules,
  onClose,
}: {
  connection: DatabaseConnection;
  onBack: () => void;
  onRules: (agentIds: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const current = (agentId: string): Level => (connection.agents.some((a) => a.agentId === agentId) ? "read" : "none");
  const [who, setWho] = useState<Record<string, Level>>({});
  const levelOf = (agentId: string) => who[agentId] ?? current(agentId);
  const levelLabel = (l: Level) => t(`access.level.${l}`);
  const granted = list.filter((a) => levelOf(a.id) !== "none");

  const grant = useMutation({
    mutationFn: async () => {
      const changed = list.filter((a) => levelOf(a.id) !== current(a.id));
      for (const a of changed) {
        // Keep the agent's rules for this database; only the access changes here.
        const saved = (await api.databases.agent(org.id, a.id)).find((d) => d.connectionId === connection.id);
        await api.databases.setAgent(org.id, a.id, connection.id, {
          level: levelOf(a.id) === "none" ? "none" : "read",
          policy: saved?.policy ?? defaultDatabasePolicy(connection),
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.databases(org.id) });
      toast.show(t("connectFlow.saved", { count: granted.length, name: connection.label }));
      if (granted.length > 0) onRules(granted.map((a) => a.id));
      else onClose();
    },
  });

  return (
    <>
      <Locked when={grant.isPending}>
        <DialogBody className="cflow__body">
          {agents.isLoading ? (
            <LoadingList count={3} />
          ) : list.length === 0 ? (
            <p className="muted">{t("connectFlow.noAgents")}</p>
          ) : (
            <>
              <div className="cflow__all">
                <span className="small muted">{t("connectFlow.all")}</span>
                {DB_LEVELS.map((l) => (
                  <Button
                    key={l}
                    size="sm"
                    variant="ghost"
                    aria-label={t("connectFlow.allLevel", { level: levelLabel(l) })}
                    onClick={() => setWho(Object.fromEntries(list.map((a) => [a.id, l])))}
                  >
                    {levelLabel(l)}
                  </Button>
                ))}
              </div>
              <ul className="cflow-agents">
                {list.map((a) => (
                  <li key={a.id} className="cflow-agent">
                    <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                    <span className="cflow-agent__name">
                      <span>{a.name}</span>
                      {a.role && <span className="small muted">{a.role}</span>}
                    </span>
                    <Segmented
                      size="sm"
                      label={t("connectFlow.levelOf", { name: a.name })}
                      value={levelOf(a.id)}
                      onValueChange={(l) => setWho((w) => ({ ...w, [a.id]: l }))}
                      options={DB_LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="small muted cflow__asks">
            <Icon name="lock" />
            {t("database.readOnly")}
          </p>
          <p className="small muted cflow__text">{t("database.whoLead")}</p>
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button disabled={grant.isPending} onClick={onBack}>
          {t("connectFlow.back")}
        </Button>
        <Button
          variant="primary"
          disabled={!agents.isSuccess || grant.isPending}
          loading={grant.isPending}
          onClick={() => grant.mutate()}
        >
          {granted.length > 0 ? t("connectFlow.next") : t("connectFlow.grant")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Step 4: the rules of each agent with access (which tables, hidden columns,
 * limits), one agent at a time. Optional: without rules an agent reads every
 * table except the columns found sensitive.
 */
function RulesStep({
  connection,
  agentIds,
  onBack,
  onClose,
}: {
  connection: DatabaseConnection;
  agentIds: string[];
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = (useAgents(org.id).data ?? []).filter((a) => agentIds.includes(a.id));
  const [agentId, setAgentId] = useState(agentIds[0] ?? "");
  const [edits, setEdits] = useState<Record<string, DatabasePolicy>>({});
  const save = useMutation({
    mutationFn: async () => {
      for (const [id, policy] of Object.entries(edits)) {
        await api.databases.setAgent(org.id, id, connection.id, { level: "read", policy });
      }
    },
    onSuccess: () => {
      for (const id of Object.keys(edits)) void qc.invalidateQueries({ queryKey: keys.agentDatabases(org.id, id) });
      if (Object.keys(edits).length > 0) toast.show(t("mail.rulesSaved"));
      onClose();
    },
  });
  const agent = agents.find((a) => a.id === agentId);
  return (
    <>
      <Locked when={save.isPending}>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("database.rulesLead", { name: connection.label })}</p>
          {agents.length > 1 && (
            <Segmented
              size="sm"
              label={t("mail.rulesAgent")}
              value={agentId}
              onValueChange={setAgentId}
              options={agents.map((a) => ({ value: a.id, label: a.name }))}
            />
          )}
          {agent && (
            <AgentRules
              key={agent.id}
              agent={agent}
              connection={connection}
              policy={edits[agent.id]}
              onChange={(policy) => setEdits((e) => ({ ...e, [agent.id]: policy }))}
              others={agents.filter((a) => a.id !== agent.id)}
              onCopy={(ids, policy) => {
                const before = edits;
                setEdits((e) => ({ ...e, ...Object.fromEntries(ids.map((id) => [id, policy])) }));
                return () =>
                  setEdits((e) => {
                    const next = { ...e };
                    for (const id of ids) {
                      const was = before[id];
                      if (was) next[id] = was;
                      else delete next[id];
                    }
                    return next;
                  });
              }}
            />
          )}
          {save.isError && <Alert>{t("mail.agent.saveError.unknown")}</Alert>}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={t("mail.rulesLater")}>
        <Button disabled={save.isPending} onClick={onBack}>
          {t("connectFlow.back")}
        </Button>
        <Button variant="primary" disabled={save.isPending} loading={save.isPending} onClick={() => save.mutate()}>
          {Object.keys(edits).length > 0 ? t("mail.rulesSave") : t("mail.rulesSkip")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * One agent's rules in step 4, starting from what it has. "Usar as mesmas
 * regras em" copies them to other agents in the step; each is still saved and
 * checked on its own.
 */
function AgentRules({
  agent,
  connection,
  policy,
  onChange,
  others,
  onCopy,
}: {
  agent: Agent;
  connection: DatabaseConnection;
  policy: DatabasePolicy | undefined;
  onChange: (policy: DatabasePolicy) => void;
  others: Agent[];
  /** Returns the undo: the targets' entries as they were before the copy. */
  onCopy: (agentIds: string[], policy: DatabasePolicy) => () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const saved = useAgentDatabases(org.id, agent.id);
  const [copyTo, setCopyTo] = useState<string[]>([]);
  const [copied, setCopied] = useState<{ ids: string[]; undo: () => void } | null>(null);
  if (saved.isLoading) return <LoadingList count={2} />;
  const mine = saved.data?.find((d) => d.connectionId === connection.id);
  const shown = policy ?? mine?.policy ?? defaultDatabasePolicy(connection);
  return (
    <div className="mail-rules-step">
      <span className="mail-rules-step__who">
        <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
        <b>{agent.name}</b>
      </span>
      <DatabaseRulesPanel
        connection={connection}
        policy={shown}
        onChange={(next) => {
          setCopied(null);
          onChange(next);
        }}
      />
      {others.length > 0 && (
        <div className="mail-rules-copy">
          <fieldset className="mail-rules__group">
            <legend className="ac-field__label">{t("database.copy.label", { name: agent.name })}</legend>
            <div className="newag__pills">
              {others.map((a) => (
                <CheckboxPill
                  key={a.id}
                  id={`db-copy-${a.id}-${connection.id}`}
                  checked={copyTo.includes(a.id)}
                  onCheckedChange={(on) => setCopyTo((ids) => (on ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                >
                  {a.name}
                </CheckboxPill>
              ))}
            </div>
            <span className="mail-list__clear">
              <Button
                size="sm"
                disabled={copyTo.length === 0}
                onClick={() => {
                  setCopied({ ids: copyTo, undo: onCopy(copyTo, shown) });
                  setCopyTo([]);
                }}
              >
                {t("database.copy.apply")}
              </Button>
              <span className="mail-list__status" role="status">
                {copied && (
                  <span className="mail-list__clear small muted">
                    {t("database.copy.done", {
                      names: others
                        .filter((a) => copied.ids.includes(a.id))
                        .map((a) => a.name)
                        .join(", "),
                    })}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        copied.undo();
                        setCopied(null);
                      }}
                    >
                      {t("mail.list.undo")}
                    </Button>
                  </span>
                )}
              </span>
            </span>
          </fieldset>
        </div>
      )}
    </div>
  );
}

/** One connected database in "Conectados": the same row as the other connectors. */
export function DatabaseRow({
  connection,
  agents,
  admin,
  onTools,
  onWho,
  onReconnect,
  onScope,
  onDisconnect,
}: {
  connection: DatabaseConnection;
  agents: Agent[];
  admin: boolean;
  onTools: () => void;
  onWho: () => void;
  onReconnect: () => void;
  onScope: () => void;
  onDisconnect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const servers = useServerDatabases(org.id, connection.id, connection.wholeServer);
  const using = agents.filter((a) => connection.agents.some((x) => x.agentId === a.id));
  const name = connection.label;
  const count = servers.data?.length ?? connection.databaseCount;
  const meta = connection.wholeServer
    ? [
        t("connectors.connectedAs", { account: `${connection.username}@${connection.host}` }),
        ...(count !== null ? [t("database.count", { count })] : []),
        ...(connection.databasePrefix ? [t("database.prefixRow", { prefix: connection.databasePrefix })] : []),
        relativeTime(t, i18n.language, connection.createdAt),
      ]
    : [
        t("connectors.connectedAs", { account: `${connection.username}@${connection.host}/${connection.database}` }),
        relativeTime(t, i18n.language, connection.createdAt),
      ];
  return (
    <div className="ac-list__row connected-row ac-mediarow">
      <span className="ac-mediarow__face">
        <DatabaseIcon />
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <span>{name}</span>
          {connection.status === "needs_reconnect" ? (
            <Chip icon="alert" tone="waiting">
              {t("mail.status.needs_reconnect")}
            </Chip>
          ) : (
            <Chip icon="check" tone="done">
              {t("mail.status.active")}
            </Chip>
          )}
          <Chip icon="eyeOff">{t("database.readOnlyChip")}</Chip>
        </span>
      </span>
      <div className="ac-mediarow__body">
        <span className="small muted">{meta.join(" · ")}</span>
        <span className="connected-row__who small muted">
          {using.length > 0 && (
            <AvatarStack>
              {using.slice(0, 5).map((a) => (
                <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="xs" />
              ))}
            </AvatarStack>
          )}
          {using.length > 0
            ? t("connectors.usedBy", { count: using.length, total: agents.length })
            : t("connectors.usedByNone")}
        </span>
        {admin && (
          <div className="connected-row__actions">
            {connection.status === "needs_reconnect" && (
              <Button size="sm" variant="primary" aria-label={t("mail.reconnectName", { name })} onClick={onReconnect}>
                {t("mail.reconnect")}
              </Button>
            )}
            {connection.wholeServer && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("database.refreshName", { name })}
                disabled={servers.refresh.isPending}
                loading={servers.refresh.isPending}
                onClick={() => servers.refresh.mutate()}
              >
                {t("database.refresh")}
              </Button>
            )}
            <Button size="sm" aria-label={t("connectors.whoName", { name })} onClick={onWho}>
              {t("connectors.who")}
            </Button>
            <Button size="sm" variant="ghost" aria-label={t("database.scopeEditName", { name })} onClick={onScope}>
              {t("database.scopeEdit")}
            </Button>
            <Button size="sm" variant="ghost" aria-label={t("connectors.toolsName", { name })} onClick={onTools}>
              {t("connectors.tools")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("connectors.disconnectName", { name })}
              onClick={onDisconnect}
            >
              {t("connectors.disconnect")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * "Quais bancos" of a connected database (tested first, like a reconnect). Letting agents that already read it
 * see more databases asks once, in place: "Abrir o servidor inteiro?".
 */
export function DatabaseScopeDialog({
  connection,
  onClose,
}: {
  connection: DatabaseConnection | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { update } = useDatabaseAction(org.id);
  const [scope, setScope] = useState<"one" | "all" | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<DatabaseConnectError | null>(null);
  const whole = (scope ?? (connection?.wholeServer ? "all" : "one")) === "all";
  const nextPrefix = (prefix ?? connection?.databasePrefix ?? "").trim();
  const name = connection?.label ?? "";
  const using = activeGrantCount(connection, useAgents(org.id).data);
  const close = () => {
    setScope(null);
    setPrefix(null);
    setConfirming(false);
    setError(null);
    onClose();
  };
  const save = () => {
    if (!connection) return;
    setConfirming(false);
    setError(null);
    if (whole === connection.wholeServer && (!whole || nextPrefix === (connection.databasePrefix ?? "")))
      return close();
    update.mutate(
      { connectionId: connection.id, wholeServer: whole, ...(whole ? { databasePrefix: nextPrefix } : {}) },
      {
        onSuccess: (saved) => {
          toast.show(
            saved.wholeServer && saved.databaseCount !== null
              ? t("database.connectedToastAll", { name: saved.label, count: saved.databaseCount })
              : t("database.scopeSaved", { name: saved.label }),
          );
          close();
        },
        onError: (e) => setError(databaseErrorOf(e)),
      },
    );
  };
  const submit = () =>
    connection && using > 0 && widensDatabaseScope(connection, { wholeServer: whole, databasePrefix: nextPrefix })
      ? setConfirming(true)
      : save();
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(o) => !o && close()}
      title={
        confirming
          ? nextPrefix
            ? t("database.widenTitlePrefix")
            : t("database.widenTitle")
          : t("database.scopeEditName", { name })
      }
      description={
        confirming
          ? nextPrefix
            ? t("database.widenTextPrefix", { count: using, prefix: nextPrefix })
            : t("database.widenText", { count: using })
          : undefined
      }
      closeLabel={t("common.close")}
      width={confirming ? 440 : 520}
    >
      {confirming ? (
        <DialogFooter>
          <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save}>
            {t("common.continue")}
          </Button>
        </DialogFooter>
      ) : (
        <form
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Locked when={update.isPending}>
            <DialogBody className="cflow__body">
              <ScopeFields
                whole={whole}
                prefix={prefix ?? connection?.databasePrefix ?? ""}
                onScope={(v) => {
                  setScope(v);
                  setError(null);
                }}
                onPrefix={setPrefix}
              />
              {error && <Alert>{t(`database.error.${error}`)}</Alert>}
            </DialogBody>
          </Locked>
          <DialogFooter>
            <Button type="button" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={update.isPending} loading={update.isPending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

/** "Reconectar": a new password for the same user (tested first). */
export function DatabaseReconnectDialog({
  connection,
  onClose,
}: {
  connection: DatabaseConnection | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { update } = useDatabaseAction(org.id);
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<DatabaseConnectError | null>(null);
  const close = () => {
    setPassword("");
    setTouched(false);
    setError(null);
    onClose();
  };
  const submit = () => {
    setTouched(true);
    setError(null);
    if (!connection || !password) return;
    update.mutate(
      { connectionId: connection.id, password },
      {
        onSuccess: (saved) => {
          toast.show(t("database.reconnected", { name: saved.label }));
          close();
        },
        onError: (e) => setError(databaseErrorOf(e)),
      },
    );
  };
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(o) => !o && close()}
      title={t("database.reconnectTitle", { name: connection?.label ?? "" })}
      description={t("database.reconnectText", { user: connection?.username ?? "" })}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={update.isPending}>
          <DialogBody className="cflow__body">
            <Field
              label={t("database.password")}
              id="db-reconnect-password"
              hint={{ name: t("common.about", { label: t("database.password") }), text: t("mail.passwordHelp") }}
              error={touched && !password ? t("database.passwordInvalid") : undefined}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && <Alert>{t(`database.error.${error}`)}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={update.isPending} loading={update.isPending}>
            {t("mail.reconnect")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Desconectar Produção?": always confirmed. */
export function DatabaseDisconnectDialog({
  connection,
  onClose,
}: {
  connection: DatabaseConnection | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const { disconnect } = useDatabaseAction(org.id);
  const name = connection?.label ?? "";
  const using = activeGrantCount(connection, useAgents(org.id).data);
  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.disconnectTitle", { name })}
      description={using > 0 ? t("connectors.disconnectText", { count: using }) : t("connectors.disconnectTextNone")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={disconnect.isPending}
          loading={disconnect.isPending}
          onClick={() =>
            connection &&
            disconnect.mutate(connection.id, {
              onSuccess: () => {
                toast.show(t("connectors.disconnected", { name }));
                onClose();
              },
            })
          }
        >
          {t("connectors.disconnect")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
