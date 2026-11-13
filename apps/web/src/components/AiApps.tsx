import type { AppAccess, AppsList, ConnectedApp, Me, PersonalToken, PersonalTokenInput } from "@agenteschat/client";
import { ApiError, keys, useAppActions, useApps, useMe } from "@agenteschat/client";
import { APP_CLIENT_GROUPS, APP_CLIENTS, type AppClient, type GuideStep } from "@agenteschat/client/lib/app-clients";
import { appFacts, appMark, isAppsEmpty, newlyConnected, tokenFacts } from "@agenteschat/client/lib/apps";
import { errorCode, errorText, REAUTH_SIGN_IN } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Alert,
  Button,
  Card,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  GroupHeading,
  Icon,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  OptionList,
  PixelSpinner,
  ProviderLogo,
  Select,
  SettingNote,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingList } from "@/components/Loading";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useSignInAgain } from "@/hooks/useSignInAgain";
import { TYPED_VALUES } from "@/i18n";
import { useToast } from "@/lib/toast";
import "./ai-apps.css";

/** How long the connect dialog keeps checking for the new app, and how often. */
const WATCH_MS = 10 * 60_000;
const POLL_MS = 5_000;

const CODE = { code: <code /> };

/** An app's face: its brand's mark from a verified address, the computer for a local program, or its initial. */
export function AppMark({
  app,
  size = "sm",
}: {
  app: { brand: string | null; displayKind: string; name: string };
  size?: "xs" | "sm" | "tile";
}) {
  const mark = appMark(app);
  if (mark.kind === "brand") return <ProviderLogo id={mark.id} size={size} />;
  return (
    <span className={`ac-brand ac-brand--${size} ac-brand--mono`} aria-hidden="true">
      {mark.kind === "computer" ? <Icon name="computer" /> : <span className="ac-brand__initial">{mark.letter}</span>}
    </span>
  );
}

type Confirm = { kind: "app"; item: ConnectedApp } | { kind: "token"; item: PersonalToken };

/**
 * Configurações → Apps de IA (ADR 0119): this server's address, "Conectar um app" with each app's steps, the apps
 * connected here and the personal tokens. Who manages members also sees everyone's, and disconnects any.
 */
export function AiAppsSection() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_members");
  const [view, setView] = useState<"mine" | "all">("mine");
  const list = useApps(org.id, view === "all");
  const [connecting, setConnecting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const data = list.data;
  const body = (
    <AppsBody
      list={list.data}
      loading={list.isLoading}
      error={list.isError && !list.data ? list.error : null}
      onRetry={() => void list.refetch()}
      whole={view === "all"}
      onConnect={() => setConnecting(true)}
      onCreate={() => setCreating(true)}
      onConfirm={setConfirm}
    />
  );
  return (
    <>
      <Card aria-labelledby="apps-server" className="apps-server">
        <span className="list-col apps-server__text">
          <h2 id="apps-server" className="ac-card__title">
            {t("apps.server")}
          </h2>
          <span className="small muted">{t("apps.serverHelp")}</span>
        </span>
        <div className="apps-server__address">
          {data ? <CommandBlock command={data.serverUrl} copied={t("apps.serverCopied")} /> : <LoadingList count={1} />}
        </div>
        {/* The empty list below takes over this button: one way in, in the middle of the page. */}
        {!(isAppsEmpty(data) && view === "mine") && (
          <Button className="apps-server__connect" variant="primary" icon="plus" onClick={() => setConnecting(true)}>
            {t("apps.connect")}
          </Button>
        )}
      </Card>
      {admin ? (
        <Tabs
          value={view}
          onValueChange={setView}
          label={t("apps.view.label")}
          items={[
            { value: "mine", label: t("apps.view.mine") },
            { value: "all", label: t("apps.view.all") },
          ]}
        >
          <TabPanel value="mine">{view === "mine" && body}</TabPanel>
          <TabPanel value="all">{view === "all" && body}</TabPanel>
        </Tabs>
      ) : (
        body
      )}
      <p className="page__note">
        {t("apps.footer")} <HelpLink slug="apps-de-ia">{t("apps.help")}</HelpLink>
      </p>
      {connecting && data && (
        <ConnectAppDialog
          serverUrl={data.serverUrl}
          seen={data.apps.map((a) => a.id)}
          onClose={() => setConnecting(false)}
          onToken={() => {
            setConnecting(false);
            setCreating(true);
          }}
        />
      )}
      {creating && <TokenDialog onClose={() => setCreating(false)} />}
      <ConfirmDialog confirm={confirm} whole={view === "all"} onClose={() => setConfirm(null)} />
    </>
  );
}

function AppsBody({
  list,
  loading,
  error,
  onRetry,
  whole,
  onConnect,
  onCreate,
  onConfirm,
}: {
  list: AppsList | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  whole: boolean;
  onConnect: () => void;
  onCreate: () => void;
  onConfirm: (c: Confirm) => void;
}) {
  const { t } = useTranslation();
  const myId = useMe().data?.user.id;
  const look = useRightHandLook();
  if (loading) return <LoadingList count={2} trailing />;
  if (error || !list) return <ErrorState error={error} onRetry={onRetry} />;
  // In the whole workspace's list, one's own rows say no "De …".
  const own = <T extends { person?: { id: string } }>(item: T): T =>
    item.person?.id === myId ? { ...item, person: undefined } : item;
  return (
    <>
      {isAppsEmpty(list) && !whole ? (
        <EmptyState
          size="panel"
          agent={look}
          title={t("apps.emptyTitle")}
          actions={
            <Button variant="primary" icon="plus" onClick={onConnect}>
              {t("apps.connect")}
            </Button>
          }
        >
          {t("apps.empty")}
        </EmptyState>
      ) : (
        list.apps.length > 0 && (
          <Card aria-labelledby="apps-connected">
            <h2 id="apps-connected" className="ac-card__title">
              {t("apps.connected")}
            </h2>
            <List aria-label={t("apps.connected")}>
              {list.apps.map((app) => (
                <AppRow key={app.id} app={own(app)} onDisconnect={() => onConfirm({ kind: "app", item: own(app) })} />
              ))}
            </List>
          </Card>
        )
      )}
      <Card aria-labelledby="apps-tokens">
        <div className="apps-server__head">
          <span className="list-col">
            <h2 id="apps-tokens" className="ac-card__title">
              {t("apps.tokens.title")}
            </h2>
            <span className="small muted">{t("apps.tokens.text")}</span>
          </span>
          {!whole && (
            <Button icon="key" onClick={onCreate}>
              {t("apps.tokens.create")}
            </Button>
          )}
        </div>
        {list.tokens.length > 0 ? (
          <List aria-label={t("apps.tokens.title")}>
            {list.tokens.map((token) => (
              <TokenRow
                key={token.id}
                token={own(token)}
                onRevoke={() => onConfirm({ kind: "token", item: own(token) })}
              />
            ))}
          </List>
        ) : (
          <SettingNote icon="key" quiet>
            {t("apps.tokens.empty")}
          </SettingNote>
        )}
      </Card>
    </>
  );
}

function AppRow({ app, onDisconnect }: { app: ConnectedApp; onDisconnect: () => void }) {
  const { t, i18n } = useTranslation();
  const facts = appFacts(t, i18n.language, app);
  return (
    <div className="ac-list__row app-row ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">
        <AppMark app={app} />
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <span className="app-row__name">{app.name}</span>
          <AccessChip access={app.access} />
        </span>
      </span>
      <span className="ac-mediarow__end">
        <RowMenu name={app.name} label={t("apps.disconnect")} onSelect={onDisconnect} />
      </span>
      <span className="ac-mediarow__body small muted">{facts}</span>
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: PersonalToken; onRevoke: () => void }) {
  const { t, i18n } = useTranslation();
  const facts = tokenFacts(t, i18n.language, token);
  return (
    <div className="ac-list__row app-row ac-mediarow ac-mediarow--row">
      <span className="ac-mediarow__face">
        <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
          <Icon name="key" />
        </span>
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <span className="app-row__name">{token.name}</span>
          <AccessChip access={token.access} />
        </span>
      </span>
      <span className="ac-mediarow__end">
        <RowMenu name={token.name} label={t("apps.tokens.revoke")} onSelect={onRevoke} />
      </span>
      <span className="ac-mediarow__body small muted">{facts}</span>
    </div>
  );
}

function AccessChip({ access }: { access: AppAccess }) {
  const { t } = useTranslation();
  return (
    <Chip icon={access === "manage" ? "agent" : access === "write" ? "send" : "eye"}>{t(`apps.access.${access}`)}</Chip>
  );
}

function RowMenu({ name, label, onSelect }: { name: string; label: string; onSelect: () => void }) {
  const { t } = useTranslation();
  const menu = t("apps.actions", { name });
  // On the name's line, risen with it, never in the middle of the name and its facts.
  return (
    <span className="ac-captail ac-captop">
      <Menu
        align="end"
        label={menu}
        trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={menu} />}
      >
        <MenuItem icon="block" danger onSelect={onSelect}>
          {label}
        </MenuItem>
      </Menu>
    </span>
  );
}

/** Desconectar an app or Revogar a token: it loses access at once. */
function ConfirmDialog({ confirm, whole, onClose }: { confirm: Confirm | null; whole: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actions = useAppActions(org.id);
  const app = confirm?.kind === "app";
  const mutation = app ? actions.disconnect : actions.revokeToken;
  const name = confirm?.item.name ?? "";
  const someoneElse = whole && !!confirm?.item.person;
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t(app ? "apps.disconnectTitle" : "apps.tokens.revokeTitle", { name })}
      description={
        <>
          {t(app ? "apps.disconnectText" : "apps.tokens.revokeText")}
          {someoneElse && ` ${t("apps.notNotified")}`}
        </>
      }
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          loading={mutation.isPending}
          disabled={mutation.isPending}
          onClick={() =>
            confirm &&
            mutation.mutate(confirm.item.id, {
              onSuccess: () => {
                toast.show(app ? t("apps.disconnected", { name }) : t("apps.tokens.revoked"));
                onClose();
              },
            })
          }
        >
          {app ? t("apps.disconnect") : t("apps.tokens.revoke")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── "Conectar um app" ─────────────────────────────────────────────────────────

/**
 * One card per app, the chat apps first, then editors and terminals, then "Outro app"; then that app's steps in the
 * same dialog with the address to paste. While the steps are open the list is asked again every few seconds: the new
 * app shows here once its sign-in is done.
 */
export function ConnectAppDialog({
  serverUrl,
  seen,
  onClose,
  onToken,
}: {
  serverUrl: string;
  seen: string[];
  onClose: () => void;
  onToken: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [client, setClient] = useState<string | null>(null);
  const [known] = useState(() => new Set(seen));
  const [since, setSince] = useState(0);
  const [watching, setWatching] = useState(false);
  const list = useApps(org.id, false, watching ? POLL_MS : false);
  const connected = client ? newlyConnected(list.data, known, since) : null;
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!client || connected || timedOut) {
      setWatching(false);
      return;
    }
    setWatching(true);
    const timer = setTimeout(() => setTimedOut(true), WATCH_MS);
    return () => clearTimeout(timer);
  }, [client, connected, timedOut]);
  const picked = APP_CLIENTS.find((c) => c.id === client);
  const nameOf = (c: AppClient) => c.name ?? t("apps.dialog.client.other");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={picked ? nameOf(picked) : t("apps.connect")}
      description={picked ? undefined : t("apps.dialog.pick")}
      leading={picked ? <ClientMark mark={picked.mark} /> : undefined}
      closeLabel={t("common.close")}
      width={560}
      className="apps-connect"
    >
      <DialogBody className="apps-connect__body">
        {!picked ? (
          APP_CLIENT_GROUPS.map((group) => {
            const clients = APP_CLIENTS.filter((c) => c.group === group);
            const heading = group && `apps-group-${group}`;
            return (
              <section key={group ?? "other"} className="apps-group" aria-labelledby={heading || undefined}>
                {group && <GroupHeading level={3} id={heading || undefined} title={t(`apps.dialog.group.${group}`)} />}
                <div className="apps-clients">
                  {clients.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className="apps-client ac-mediarow ac-mediarow--row"
                      onClick={() => {
                        setClient(c.id);
                        setSince(Date.now());
                      }}
                    >
                      <span className="ac-mediarow__face">
                        <ClientMark mark={c.mark} />
                      </span>
                      <span className="ac-mediarow__head">
                        <b className="apps-client__name">{nameOf(c)}</b>
                      </span>
                      <span className="ac-mediarow__end">
                        <Icon name="chevronRight" size={16} className="apps-client__go" />
                      </span>
                      <span className="ac-mediarow__body small muted">
                        {c.site ?? t(`apps.dialog.clientText.${c.kind ?? "other"}`)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })
        ) : connected ? (
          // The app's mark is already in the head: the body says it connected.
          <div className="apps-connected" role="status">
            <span className="list-col">
              <b className="apps-connected__title">
                <Icon name="check" size={16} />
                {t("apps.dialog.connected", { name: connected.name })}
              </b>
              <span className="small muted">{t("apps.dialog.connectedText")}</span>
            </span>
          </div>
        ) : (
          <>
            <ClientSteps client={picked} url={serverUrl} onToken={onToken} />
            {timedOut ? (
              <div className="apps-watch apps-watch--late">
                <span className="small muted">{t("apps.dialog.timeout")}</span>
                <Button
                  size="sm"
                  icon="refresh"
                  loading={list.isFetching}
                  onClick={() => {
                    setTimedOut(false);
                    void list.refetch();
                  }}
                >
                  {t("apps.dialog.check")}
                </Button>
              </div>
            ) : (
              <p className="apps-watch small muted" role="status">
                <PixelSpinner size={14} />
                {t("apps.dialog.waiting")}
              </p>
            )}
          </>
        )}
      </DialogBody>
      {picked && (
        <DialogFooter>
          {connected ? (
            <Button variant="primary" onClick={onClose}>
              {t("apps.dialog.done")}
            </Button>
          ) : (
            <Button
              icon="chevronLeft"
              onClick={() => {
                setClient(null);
                setTimedOut(false);
              }}
            >
              {t("apps.dialog.back")}
            </Button>
          )}
        </DialogFooter>
      )}
    </Dialog>
  );
}

function ClientMark({ mark }: { mark: string | null }) {
  if (mark) return <ProviderLogo id={mark} size="sm" />;
  return (
    <span className="ac-brand ac-brand--sm ac-brand--mono" aria-hidden="true">
      <Icon name="plug" />
    </span>
  );
}

function OpenLink({ href, app }: { href: string; app: string }) {
  const { t } = useTranslation();
  return (
    <Button asChild size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Icon name="external" />
        {t("apps.dialog.open", { app })}
      </a>
    </Button>
  );
}

/**
 * One app's guide from `app-clients.ts`: each step's words, then its button, address or command to copy. `children`:
 * more steps of the same list, before the guide's notes.
 */
export function ClientSteps({
  client,
  url,
  onToken,
  children,
}: {
  client: AppClient;
  url: string;
  onToken?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const guide = client.guide(url);
  const words = (s: GuideStep) => (
    <Trans
      i18nKey={`apps.dialog.${s.text}`}
      values={{ access: t("apps.consent.manage"), ...s.vars }}
      components={CODE}
      {...TYPED_VALUES}
    />
  );
  const installs = guide.steps.filter((s) => s.install);
  const steps = guide.steps.filter((s) => !s.install);
  return (
    <>
      {guide.lead && <p className="small muted apps-lead">{t(`apps.dialog.${guide.lead}`)}</p>}
      {installs.map((s) => (
        <div key={s.text} className="row">
          <Button asChild variant="primary">
            <a href={s.install}>{words(s)}</a>
          </Button>
        </div>
      ))}
      {steps.length > 0 && (
        <ol className="machine-pair__steps apps-steps small">
          {steps.map((s) => (
            <li key={`${s.text}${s.code ?? ""}`}>
              <span className="apps-step">
                <span>{words(s)}</span>
                {s.open && <OpenLink href={s.open} app={client.name ?? ""} />}
                {s.address && <CommandBlock command={url} copied={t("apps.serverCopied")} />}
                {s.code && <CommandBlock command={s.code} />}
                {s.token && onToken && (
                  <span className="row">
                    <Button size="sm" icon="key" onClick={onToken}>
                      {t("apps.dialog.other.toTokens")}
                    </Button>
                  </span>
                )}
              </span>
            </li>
          ))}
          {children}
        </ol>
      )}
      {guide.notes.map((n) => (
        <SettingNote key={n.text} icon={n.icon}>
          <Trans i18nKey={`apps.dialog.${n.text}`} components={CODE} />
        </SettingNote>
      ))}
    </>
  );
}

// ── Personal tokens ───────────────────────────────────────────────────────────

type Validity = "30" | "90" | "365" | "none";
const VALIDITIES: Validity[] = ["30", "90", "365", "none"];
const daysOf = (v: Validity): PersonalTokenInput["expiresInDays"] =>
  v === "none" ? null : (Number(v) as 30 | 90 | 365);

/** "Criar token": a name, the access and how long it lasts; then the token once, closed only after copying it. */
export function TokenDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { createToken } = useAppActions(org.id);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AppAccess>("write");
  const [validity, setValidity] = useState<Validity>("90");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const qc = useQueryClient();
  const signInAgain = useSignInAgain(qc.getQueryData<Me | null>(keys.me)?.user.email ?? "");
  if (secret) {
    return (
      <Dialog
        open
        // ×, Esc or a press outside before copying would lose the token for good: they ask first.
        onOpenChange={(o) => {
          if (o) return;
          if (copied) onClose();
          else setLeaving(true);
        }}
        title={t("apps.tokens.createdTitle")}
        closeLabel={t("common.close")}
        width={520}
      >
        <DialogBody className="apps-token">
          <Alert tone="neutral">{t("apps.tokens.once")}</Alert>
          <CommandBlock
            command={secret}
            copied={t("apps.tokens.copied")}
            copyLabel={t("apps.tokens.copy")}
            onCopied={() => setCopied(true)}
          />
          <SettingNote icon="info">{t("apps.tokens.use")}</SettingNote>
          {leaving && !copied && <Alert>{t("apps.tokens.leaveText")}</Alert>}
        </DialogBody>
        <DialogFooter>
          {leaving && !copied && (
            <Button variant="danger" onClick={onClose}>
              {t("apps.tokens.leave")}
            </Button>
          )}
          <Button variant="primary" disabled={!copied} onClick={onClose}>
            {t("apps.tokens.done")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }
  const clean = name.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("apps.tokens.create")}
      description={t("apps.tokens.text")}
      closeLabel={t("common.close")}
      width={520}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean || createToken.isPending) return;
          setError(null);
          setReauth(false);
          createToken.mutate(
            { name: clean, access, expiresInDays: daysOf(validity) },
            {
              onSuccess: (created) => setSecret(created.secret),
              onError: (err) => {
                const stale = errorCode(err) === REAUTH_SIGN_IN;
                setReauth(stale);
                setError(
                  stale
                    ? t("apps.tokens.reauth")
                    : err instanceof ApiError && err.code === "token_limit"
                      ? t("apps.tokens.limit")
                      : errorText(t, err),
                );
              },
            },
          );
        }}
      >
        <Locked when={createToken.isPending}>
          <DialogBody className="apps-token">
            <Field label={t("apps.tokens.name")} id="apps-token-name">
              <Input
                value={name}
                maxLength={60}
                placeholder={t("apps.tokens.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="apps-field" style={{ gap: 6 }}>
              <span className="newag__label" id="apps-token-access">
                {t("apps.tokens.access")}
              </span>
              <OptionList
                aria-labelledby="apps-token-access"
                value={access}
                onValueChange={setAccess}
                options={[
                  { value: "manage", title: t("apps.consent.manage"), description: t("apps.consent.manageHelp") },
                  { value: "write", title: t("apps.consent.write"), description: t("apps.consent.writeHelp") },
                  { value: "read", title: t("apps.consent.read"), description: t("apps.consent.readHelp") },
                ]}
              />
            </div>
            <Field label={t("apps.tokens.validity")} id="apps-token-validity">
              <Select
                value={validity}
                onValueChange={(v) => {
                  setValidity(v as Validity);
                  setReauth(false);
                  setError(null);
                }}
                options={VALIDITIES.map((v) => ({ value: v, label: t(`apps.tokens.days.${v}`) }))}
              />
            </Field>
            {error && <Alert>{error}</Alert>}
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {reauth ? (
            <Button type="button" variant="primary" onClick={() => void signInAgain()}>
              {t("proof.signInButton")}
            </Button>
          ) : (
            <Button type="submit" variant="primary" loading={createToken.isPending} disabled={!clean}>
              {t("apps.tokens.create")}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
