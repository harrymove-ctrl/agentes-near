import type {
  VaultConnectField,
  VaultConnection,
  VaultOverview,
  VaultScope,
  VaultSourceInfo,
} from "@agenteschat/client";
import { vaultConnectRefusal } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { vaultNoAgents } from "@agenteschat/client/lib/vault";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  MenuSeparator,
  Segmented,
  Select,
  SettingNote,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { OpenPage, Step, StepTitle } from "@/components/ai/AddAccountFlow";
import { ConnectedDone } from "@/components/ConnectFlow";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { useVaultConnectionActions } from "./data";
import { AccessBlock, AgentFaces, accessSentence, agentsSummary } from "./VaultAccess";
import { ScopeLine, VaultTile } from "./VaultItemDialog";
import "./vault.css";

/*
 * Settings › Vault › Connections (ADR 0144): one card per password manager the server can read. Not connected: its
 * steps and fields, from the source's own description. Connected: what it reads, how many items, when it last synced,
 * Sync now, the default access of its items, and Disconnect. A connection that fails says why in plain words and
 * offers Reconnect, which opens the fields again.
 */

/** A source's words: its own i18n key when the app has one, its English text otherwise (a module's source). */
const words = (t: TFunction, key: string, fallback: string) =>
  (t as unknown as (k: string, o: Record<string, unknown>) => string)(key, { defaultValue: fallback });

/**
 * Error codes a source may give (`VaultSourceErrorCode`), and the Vault's own `too_many_items` (full: new items wait,
 * ADR 0144 §3); anything else reads as the generic one.
 */
const ERRORS = [
  "auth_failed",
  "locked",
  "many_vaults",
  "no_vault",
  "folder_missing",
  "not_found",
  "rate_limited",
  "unreachable",
  "unsupported",
  "invalid_input",
  "too_many_items",
] as const;
type ErrorKey = (typeof ERRORS)[number] | "other";
const errorKey = (code: string | null): ErrorKey =>
  (ERRORS as readonly string[]).includes(code ?? "") ? (code as ErrorKey) : "other";

/** A field that only applies to one choice of another (a server address, for "my own server"): `<choice>Url`. */
const shownFor = (field: VaultConnectField, fields: VaultConnectField[], values: Record<string, string>) => {
  const choice = fields.find((c) => c.kind === "choice" && field.id === `${c.id}Url`);
  return !choice || values[choice.id] === "self";
};

/** What a field starts with: its default, or a choice's first value. */
const initialOf = (f: VaultConnectField) => f.initial ?? (f.kind === "choice" ? (f.choices?.[0]?.value ?? "") : "");

const INPUT_TYPE: Record<VaultConnectField["kind"], string> = {
  text: "text",
  secret: "password",
  url: "url",
  email: "email",
  choice: "text",
};

/** The source's steps, its warning, its fields and Connect (or Reconnect, for a connection that stopped working). */
function ConnectForm({
  source,
  connection,
  canManageTeam,
  onDone,
}: {
  source: VaultSourceInfo;
  /** Reconnecting this one: new credentials, same scope. */
  connection?: VaultConnection;
  canManageTeam: boolean;
  /** Closed, or just connected (`made`): reconnecting ends with a toast, connecting with its confirmation. */
  onDone: (made?: VaultConnection) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const kind = source.kind;
  // The password manager's refusal (a token that isn't one, a vault too many), until a field changes.
  const [refusal, setRefusal] = useState<string | null>(null);
  const actions = useVaultConnectionActions(org.id, (error) =>
    setRefusal(vaultConnectRefusal(t, kind, error, i18n.language)),
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(source.fields.map((f) => [f.id, initialOf(f)])),
  );
  const [scope, setScope] = useState<VaultScope>(canManageTeam ? "team" : "personal");
  const [tried, setTried] = useState(false);
  const shown = source.fields.filter((f) => shownFor(f, source.fields, values));
  const missing = shown.filter((f) => f.required && !values[f.id]?.trim());
  const busy = actions.connecting || actions.updating;
  const label = (f: VaultConnectField) => words(t, `vault.source.${kind}.field.${f.id}`, f.label);
  const set = (id: string, value: string) => {
    setValues((s) => ({ ...s, [id]: value }));
    setRefusal(null);
  };

  const submit = async () => {
    setTried(true);
    if (missing.length > 0) return;
    setRefusal(null);
    // Secrets go as typed (a password may start or end with a space); the rest trimmed.
    const input = Object.fromEntries(
      shown.map((f) => [f.id, f.kind === "secret" ? (values[f.id] ?? "") : (values[f.id] ?? "").trim()]),
    );
    const done = connection
      ? await actions.update(connection.id, { input })
      : await actions.connect({ kind, scope, input });
    if (!done) return;
    if (connection) toast.show(t("vault.connections.connected", { name: source.name, count: done.itemCount }));
    onDone(connection ? undefined : done);
  };

  return (
    <form
      className="agp-addacct vlt-connect"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Locked when={busy}>
        {source.warning && <Alert tone="neutral">{words(t, `vault.source.${kind}.warning`, source.warning)}</Alert>}
        {source.steps.map((step, i) => (
          <Step
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps are fixed and numbered by their place
            key={i}
            n={i + 1}
            side={
              i === 0 && source.helpUrl ? (
                <OpenPage href={source.helpUrl}>{t("vault.connections.open", { name: source.name })}</OpenPage>
              ) : undefined
            }
          >
            <StepTitle title={words(t, `vault.source.${kind}.step.${i + 1}`, step)} />
          </Step>
        ))}
        <div className="vlt-connect__fields">
          {shown.map((f) => (
            <Field
              key={f.id}
              label={label(f)}
              error={tried && f.required && !values[f.id]?.trim() ? t("vault.connections.required") : undefined}
            >
              {f.kind === "choice" ? (
                <Select
                  value={values[f.id]}
                  onValueChange={(v) => set(f.id, v)}
                  options={(f.choices ?? []).map((c) => ({
                    value: c.value,
                    // A value that is a domain is its own name; a word (`self`) has a translation.
                    label: /^\w+$/.test(c.value)
                      ? words(t, `vault.source.${kind}.choice.${f.id}.${c.value}`, c.label)
                      : c.label,
                  }))}
                />
              ) : (
                <Input
                  type={INPUT_TYPE[f.kind]}
                  value={values[f.id] ?? ""}
                  placeholder={f.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => set(f.id, e.target.value)}
                  data-1p-ignore
                />
              )}
            </Field>
          ))}
          {refusal && <Alert>{refusal}</Alert>}
          {!connection && (
            <div className="ac-field">
              <span className="ac-field__label">{t("vault.connections.for")}</span>
              <Segmented<VaultScope>
                label={t("vault.connections.for")}
                value={scope}
                disabled={!canManageTeam}
                onValueChange={setScope}
                options={[
                  { value: "team", label: t(modeKey(org, "vault.scope.team")) },
                  { value: "personal", label: t("vault.scope.personal") },
                ]}
              />
              <span className="ac-field__example">
                {canManageTeam
                  ? t(scope === "team" ? modeKey(org, "vault.connections.forTeam") : "vault.connections.forPersonal")
                  : t(modeKey(org, "vault.connections.teamLocked"))}
              </span>
            </div>
          )}
        </div>
      </Locked>
      <span className="vlt-connect__acts">
        <Button type="submit" variant="primary" loading={busy} disabled={busy}>
          {connection ? t("vault.connections.reconnect") : t("vault.connections.connect")}
        </Button>
        <Button variant="ghost" onClick={() => onDone()}>
          {t("common.cancel")}
        </Button>
      </span>
      <SettingNote icon="lock">{t("vault.connections.sealed")}</SettingNote>
    </form>
  );
}

/** The connection's state as a chip: connected, syncing, or what went wrong. */
function StateChip({ connection: c }: { connection: VaultConnection }) {
  const { t } = useTranslation();
  if (c.status === "error")
    return (
      <Chip icon="alert" tone="waiting">
        {t(`vault.connections.error.${errorKey(c.errorCode)}`)}
      </Chip>
    );
  if (c.status === "syncing") return <Chip icon="refresh">{t("vault.connections.syncing")}</Chip>;
  return (
    <Chip icon="check" tone="done">
      {t("vault.connections.ready")}
    </Chip>
  );
}

/** One connection: what it reads, its state, who uses its items, and what can be done with it. */
function ConnectionRow({
  connection: c,
  onReconnect,
  onAccess,
  onDisconnect,
}: {
  connection: VaultConnection;
  onReconnect: () => void;
  onAccess: () => void;
  onDisconnect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const actions = useVaultConnectionActions(org.id);
  const line = [
    t("vault.connections.reads", { label: c.label }),
    // Its credential can't save new logins: agents keep theirs in the Vault until it is reconnected with one that can.
    c.readOnly ? t("vault.connections.readOnly") : null,
    t("vault.connections.items", { count: c.itemCount }),
    c.syncedAt ? t("vault.connections.synced", { when: relativeTime(t, i18n.language, c.syncedAt) }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const sync = async () => {
    await actions.sync(c.id);
  };
  return (
    <div className="ac-list__row connected-row ac-mediarow vlt-conn">
      <span className="ac-mediarow__face">
        <VaultTile icon="lock" />
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <span>{c.label}</span>
          <StateChip connection={c} />
        </span>
      </span>
      <div className="ac-mediarow__body">
        <span className="small muted" title={line}>
          {line}
        </span>
        {c.status === "error" && (
          <span className="small vlt-conn__fix">{t(`vault.connections.fix.${errorKey(c.errorCode)}`)}</span>
        )}
        {vaultNoAgents(c.access) ? (
          <span className="connected-row__who vlt-conn__none small muted">
            {t("vault.connections.noAgents")}
            {c.can.edit && (
              <button type="button" className="ac-link" onClick={onAccess}>
                {t("vault.connections.giveAccess")}
              </button>
            )}
          </span>
        ) : (
          <span className="connected-row__who small muted">
            <AgentFaces access={c.access} />
            {agentsSummary(t, i18n.language, dir, c.access)}
          </span>
        )}
        {c.can.edit && (
          <div className="connected-row__actions">
            {/* A full Vault isn't fixed by reconnecting: it syncs again once items are removed. */}
            {c.status === "error" && c.errorCode !== "too_many_items" ? (
              <Button
                size="sm"
                variant="primary"
                aria-label={t("vault.connections.reconnectName", { name: c.name })}
                onClick={onReconnect}
              >
                {t("vault.connections.reconnect")}
              </Button>
            ) : (
              <Button
                size="sm"
                icon="refresh"
                loading={actions.syncing}
                disabled={actions.syncing || c.status === "syncing"}
                onClick={() => void sync()}
              >
                {t("vault.connections.syncNow")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("vault.connections.accessTitle", { label: c.label })}
              onClick={onAccess}
            >
              {t("vault.connections.access")}
            </Button>
            <Menu
              align="end"
              label={t("vault.connections.actionsName", { name: c.name })}
              trigger={
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="more"
                  aria-label={t("vault.connections.actionsName", { name: c.name })}
                />
              }
            >
              <MenuItem icon="refresh" onSelect={onReconnect}>
                {t("vault.connections.reconnect")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon="power" danger onSelect={onDisconnect}>
                {t("vault.connections.disconnect")}
              </MenuItem>
            </Menu>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Default access": who the connection's items reach until someone changes one of them. Each change saves. */
function ConnectionAccessDialog({ connection: c, onClose }: { connection: VaultConnection; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useVaultConnectionActions(org.id);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("vault.connections.accessTitle", { label: c.label })}
      description={t("vault.connections.accessText")}
      closeLabel={t("common.close")}
      width={480}
    >
      <DialogBody>
        <ScopeLine scope={c.scope} />
        <AccessBlock
          scope={c.scope}
          access={c.access}
          editable={c.can.edit}
          saving={actions.updating}
          onChange={async (access) => {
            const saved = await actions.update(c.id, { access });
            if (saved) toast.show(t("vault.access.saved"));
            return saved !== null;
          }}
        />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** One password manager: Connect and its steps, or its connections. */
function SourceCard({
  source,
  connections,
  canManageTeam,
}: {
  source: VaultSourceInfo;
  connections: VaultConnection[];
  canManageTeam: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useVaultConnectionActions(org.id);
  const [form, setForm] = useState<null | { connection?: VaultConnection }>(null);
  const [access, setAccess] = useState<VaultConnection | null>(null);
  const [made, setMade] = useState<VaultConnection | null>(null);
  const dir = useDirectory(org.id);
  const [removing, setRemoving] = useState<VaultConnection | null>(null);
  const id = `vlt-src-${source.kind}`;
  const kinds = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(
    source.kinds.map((k) => t(`vault.kindPlural.${k}`)),
  );
  const disconnect = async () => {
    if (!removing) return;
    if (!(await actions.remove(removing.id))) return;
    toast.show(t("vault.connections.removed", { name: source.name }));
    setRemoving(null);
  };
  return (
    <Card aria-labelledby={id}>
      <CardHeader
        id={id}
        icon="plug"
        title={source.name}
        subtitle={t("vault.connections.lead", { name: source.name, kinds })}
        action={
          // Secondary: the page's primary is New item, and every password manager has this button.
          connections.length === 0 &&
          !form && (
            <Button size="sm" onClick={() => setForm({})}>
              {t("vault.connections.connect")}
            </Button>
          )
        }
      />
      {connections.length > 0 && (
        <List className="connected-list" aria-label={t("vault.connections.listOf", { name: source.name })}>
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              onReconnect={() => setForm({ connection: c })}
              onAccess={() => setAccess(c)}
              onDisconnect={() => setRemoving(c)}
            />
          ))}
        </List>
      )}
      {form && (
        <ConnectForm
          key={form.connection?.id ?? "new"}
          source={source}
          connection={form.connection}
          canManageTeam={canManageTeam}
          onDone={(connected) => {
            setForm(null);
            if (connected) setMade(connected);
          }}
        />
      )}
      {made && (
        <Dialog
          open
          onOpenChange={(o) => !o && setMade(null)}
          title={t("connectFlow.done.title", { name: source.name })}
          closeLabel={t("common.close")}
          width={440}
        >
          <ConnectedDone
            text={accessSentence(t, i18n.language, dir, made.scope, made.access)}
            onAdjust={() => {
              setAccess(made);
              setMade(null);
            }}
            onClose={() => setMade(null)}
          />
        </Dialog>
      )}
      {access && <ConnectionAccessDialog connection={access} onClose={() => setAccess(null)} />}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("vault.connections.removeTitle", { name: source.name })}
        description={t("vault.connections.removeText", { count: removing?.itemCount ?? 0, name: source.name })}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(null)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={actions.removing}
            disabled={actions.removing}
            onClick={() => void disconnect()}
          >
            {t("vault.connections.disconnect")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

/** The Connections tab: a card per password manager this server can read. */
export function VaultConnections({ overview }: { overview: VaultOverview }) {
  const { t } = useTranslation();
  if (overview.sources.length === 0) return <EmptyState icon="plug">{t("vault.connections.none")}</EmptyState>;
  return (
    <div className="vlt-sources">
      {overview.sources.map((s) => (
        <SourceCard
          key={s.kind}
          source={s}
          connections={overview.connections.filter((c) => c.kind === s.kind)}
          canManageTeam={overview.canManageTeam}
        />
      ))}
      <p className="small muted vlt-sources__note">{t("vault.connections.note")}</p>
    </div>
  );
}
