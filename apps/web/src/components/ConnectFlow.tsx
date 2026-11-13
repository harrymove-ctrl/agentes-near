import type { ConnectOutcome, ConnectorDef, CustomConnectStart, CustomServer } from "@agenteschat/client";
import {
  keys,
  useAgents,
  useCatalog,
  useConnections,
  useConnectWithKey,
  useCustomServerAction,
  useCustomServers,
  useGitHubApp,
  useGithubAccess,
  useInstallGitHubApp,
  useRenameConnection,
  useStartOAuth,
} from "@agenteschat/client";
import {
  catalogToolClass,
  LEVELS,
  type Level,
  type LevelState,
  levelIn,
  saveLevels,
  sharedLevel,
} from "@agenteschat/client/lib/access-levels";
import { composioConnectText } from "@agenteschat/client/lib/composio";
import {
  accountUnchecked,
  asksCount,
  type ConnectedItem,
  connectedSummary,
  fromConnection,
  fromServer,
  itemName,
  orgAccessChange,
  outcomeText,
} from "@agenteschat/client/lib/connected";
import { humanize, isHttpsUrl, sameServer } from "@agenteschat/client/lib/custom-tools";
import { errorText } from "@agenteschat/client/lib/errors";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { connectorBrand, connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import {
  partsOf,
  type ReviewTool,
  reviewDecisions,
  reviewToolsOf,
  toolName,
} from "@agenteschat/client/lib/tool-review";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Locked,
  OptionList,
  Segmented,
  Skeleton,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { FlowTitle } from "@/components/FlowTitle";
import { LoadingList, useStepText } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useAgentsAccess } from "@/hooks/useAgentsAccess";
import { oauthReturnPath } from "@/lib/desktop";
import { forgetGithubOrgs, keepGithubOrgs, readGithubOrgs } from "@/lib/github-orgs";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";
import { reviewNote, ToolLevelsView, ToolReview, type ToolReviewState } from "./ToolReview";

/**
 * Connecting a service, in one dialog: connect (OAuth or an API key), then a short confirmation ("done": every agent
 * can use it, so many actions ask) that ends the flow. "Ajustar" there, and the rows of "Conectados", open the two
 * steps of detail: what it does (each tool reads, writes or always asks for approval; off = never offered) and who can
 * use it (one level per agent).
 */
export type FlowState =
  /**
   * Step 1: a catalog entry, or `null` for any MCP server by address. `add`: another account of `item`'s server
   * (an MCP server takes several); `reconnect`: a new sign-in for `item`, whose name, tools and agents stay. `url`: the
   * address already typed in (an agent's card). `account`: GitHub's sign-in alone, without the agentes.chat app first.
   */
  | {
      step: 0;
      def: ConnectorDef | null;
      mode?: "add" | "reconnect";
      item?: ConnectedItem;
      url?: string;
      account?: boolean;
    }
  /** `naming`: a new account the provider didn't name ("Stripe 2"): its name comes first, above its tools. */
  | { step: "done" | 1 | 2; item: ConnectedItem; naming?: boolean };

/** Back from OAuth the app lands here; the server adds `?connected=…`. In the desktop app, through its window. */
const returnPath = (orgId: string) => oauthReturnPath(`/org/${orgId}/settings/connectors`);

export function ConnectFlow({
  flow,
  onChange,
  onClose,
  returnTo,
}: {
  flow: FlowState | null;
  onChange: (flow: FlowState) => void;
  onClose: () => void;
  /** Where signing in elsewhere comes back to (a path on the site); Conectores by default. */
  returnTo?: string;
}) {
  const { t } = useTranslation();
  if (!flow) return null;
  const name =
    flow.step === 0
      ? flow.def
        ? connectorName(t, flow.def)
        : flow.item
          ? itemName(t, flow.item)
          : null
      : itemName(t, flow.item);
  const icon = flow.step === 0 ? (flow.def ?? flow.item?.def ?? null) : flow.item.def;
  const title =
    flow.step === 0
      ? flow.mode === "reconnect" && flow.item
        ? t("connectFlow.reconnectTitle", { name: itemName(t, flow.item) })
        : name
          ? t(flow.mode === "add" ? "connectFlow.addTitle" : "connectFlow.connectTitle", { name })
          : t("connectFlow.customTitle")
      : flow.step === "done"
        ? t("connectFlow.done.title", { name })
        : flow.step === 1
          ? flow.item.server
            ? t("toolReview.title")
            : t("connectFlow.toolsTitle", { name })
          : t("connectFlow.whoTitle", { name });
  // The confirmation is no step of the dots.
  const at = flow.step === "done" ? null : flow.step;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        <FlowTitle
          tile={
            name ? (
              <ConnectorIcon def={icon} image={flow.item?.image ?? null} label={name} size="lg" />
            ) : (
              <span className="connector-icon connector-icon--lg connector-icon--mono" aria-hidden="true">
                <Icon name="plus" />
              </span>
            )
          }
        >
          {title}
        </FlowTitle>
      }
      closeLabel={t("common.close")}
      width={620}
      className="cflow"
    >
      {at !== null && (
        <ol className="cflow__steps" aria-label={t("connectFlow.steps")}>
          {([0, 1, 2] as const).map((i) => (
            <li key={i} data-on={i <= at || undefined} aria-current={i === at ? "step" : undefined}>
              <span className="ac-visually-hidden">{t(`connectFlow.step.${i}`)}</span>
            </li>
          ))}
        </ol>
      )}
      {flow.step === 0 && (
        <ConnectStep
          def={flow.def}
          returnTo={returnTo}
          mode={flow.mode}
          item={flow.item}
          initialUrl={flow.url}
          accountOnly={flow.account === true}
          onConnected={(item, naming) => onChange({ step: "done", item, naming })}
          onClose={onClose}
        />
      )}
      {flow.step === "done" && (
        <DoneStep
          key={flow.item.id}
          item={flow.item}
          onAdjust={() => onChange({ step: 1, item: flow.item, naming: flow.naming })}
          onClose={onClose}
        />
      )}
      {flow.step === 1 && (
        <ToolsStep
          key={flow.item.id}
          item={flow.item}
          naming={flow.naming === true}
          onNext={(item) => onChange({ step: 2, item })}
          onClose={onClose}
        />
      )}
      {flow.step === 2 && (
        <WhoStep
          key={flow.item.id}
          item={flow.item}
          onBack={() => onChange({ step: 1, item: flow.item })}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

/**
 * Step 1: OAuth ("Continuar no Linear"), or an API key. A service through Composio signs in on Composio's page
 * ("Continuar na Composio"): no key field of ours. A new account goes on to its confirmation; a new sign-in for an account,
 * or the same account again, ends here with a toast saying which. GitHub, where the server has the agentes.chat app
 * (ADR 0156), offers the app first (installed on GitHub's page, which comes back to Conectores) and an account second.
 */
function ConnectStep({
  def,
  returnTo,
  mode,
  item,
  initialUrl,
  accountOnly,
  onConnected,
  onClose,
}: {
  def: ConnectorDef | null;
  returnTo?: string;
  mode?: "add" | "reconnect";
  item?: ConnectedItem;
  initialUrl?: string;
  accountOnly?: boolean;
  /** `naming`: another account of a server the provider didn't name ("Stripe 2"). */
  onConnected: (item: ConnectedItem, naming: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
  const { connect } = useCustomServerAction(org.id);
  const withKey = useConnectWithKey(org.id);
  const oauth = useStartOAuth(org.id);
  const githubApp = useGitHubApp(org.id);
  const installApp = useInstallGitHubApp(org.id);
  const [how, setHow] = useState<"app" | "account">("app");
  const [url, setUrl] = useState(initialUrl ?? "");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyOpen, setKeyOpen] = useState(false);
  const [needsKey, setNeedsKey] = useState<Extract<CustomConnectStart, { status: "needs_key" }> | null>(null);
  const [touched, setTouched] = useState<"oauth" | "key" | null>(null);

  // An account of a server by address: its own address, whatever the catalog says.
  const fixed = item?.server?.serverUrl ?? null;
  // A server by address (any, or a vendor's official one) or our catalog connector.
  const byAddress = fixed !== null || def === null || def.kind === "remote_mcp";
  const askUrl = fixed === null && def === null;
  const viaComposio = item ? item.viaComposio : def?.via === "composio";
  const canOAuth = byAddress || Boolean(def?.oauthConfigured && def.auth.includes("oauth"));
  // A one-click server the catalog lists without a key (Intercom on the Cloud) offers none, unless it answers that it
  // needs one; a service through Composio signs in there.
  // An account by address follows its catalog entry's rule too, so Reconectar doesn't bring the key back.
  const listed =
    fixed === null
      ? def
      : (catalog.data?.connectors.find((c) => c.kind === "remote_mcp" && sameServer(c.serverUrl, fixed)) ?? null);
  const canKey = !viaComposio && (listed === null || listed.auth.includes("api_key") || needsKey !== null);
  const serverUrl = fixed ?? (def?.kind === "remote_mcp" ? def.serverUrl : url.trim());
  const appOffered =
    def?.id === "github" && !viaComposio && !mode && !accountOnly && githubApp.data?.installable === true;
  const viaApp = appOffered && how === "app";
  const busy = connect.isPending || withKey.isPending || oauth.isPending || installApp.isPending;
  const sent = busy || withKey.isSuccess || connect.data?.status === "connected";
  // As the server does: a server by address takes another account, a catalog connector a new sign-in.
  const accounts = useHeldWhile(
    (servers.data ?? []).filter((s) => sameServer(s.serverUrl, serverUrl)),
    sent,
  );
  const again = useHeldWhile(
    byAddress ? accounts.length > 0 : (connections.data ?? []).some((c) => c.connector === def?.id && !c.revokedAt),
    sent,
  );
  const replacing = mode === "reconnect" || (!byAddress && again);
  const connectionId = mode === "reconnect" && item?.custom ? item.id : undefined;
  const unchecked = byAddress && accountUnchecked(accounts);
  const steps = useStepText(connect.isPending, [
    t("connectFlow.reaching"),
    t("connectFlow.listing"),
    t("connectFlow.almost"),
  ]);

  const urlError = touched && askUrl && !isHttpsUrl(url) ? t("connectors.serverUrlInvalid") : undefined;
  const keyError = touched === "key" && apiKey.trim().length < 8 ? t("connectors.apiKeyInvalid") : undefined;

  const done = (next: ConnectedItem, outcome: ConnectOutcome) => {
    // A new account's confirmation says it connected; any other ending is a toast.
    if (outcome === "connected") return onConnected(next, byAddress && again && !next.server?.accountLabel);
    toast.show(outcomeText(t, outcome, next));
    onClose();
  };
  const byAddressResult = (result: Awaited<ReturnType<typeof connect.mutateAsync>>) => {
    if (result.status === "oauth") navigateAway(result.authorizeUrl);
    else if (result.status === "needs_key") {
      setNeedsKey(result);
      setKeyOpen(true);
      setTouched(null);
    } else done(fromServer(result.server, catalog.data?.connectors ?? []), result.outcome ?? "connected");
  };
  // The service's name: the server names another account after it ("Stripe 2"). A catalog entry's goes in English,
  // so each viewer reads a name nobody changed in their own language.
  const name = (def ? def.label : fixed ? (accounts[0]?.label ?? item?.label) : label.trim()) || undefined;
  const back = returnTo ? oauthReturnPath(returnTo) : returnPath(org.id);

  const githubOrgs = mode === "reconnect" && def?.id === "github" && !viaComposio && !item?.viaGithubApp;
  const access = useGithubAccess(org.id, githubOrgs);
  const startOAuth = () => {
    setTouched("oauth");
    if (askUrl && !isHttpsUrl(url)) return;
    if (githubOrgs && access.data?.orgs) keepGithubOrgs(access.data.orgs);
    if (byAddress) {
      connect.mutate({ serverUrl, label: name, returnTo: back, connectionId }, { onSuccess: byAddressResult });
    } else if (def) {
      oauth.mutate({ connector: def.id, returnTo: back }, { onSuccess: (to) => navigateAway(to) });
    }
  };
  const startApp = () => installApp.mutate(back, { onSuccess: (to) => navigateAway(to) });
  const submitKey = () => {
    setTouched("key");
    if ((askUrl && !isHttpsUrl(url)) || apiKey.trim().length < 8) return;
    if (byAddress) {
      connect.mutate(
        { serverUrl, label: name, apiKey: apiKey.trim(), returnTo: back, connectionId },
        { onSuccess: byAddressResult },
      );
    } else if (def) {
      withKey.mutate(
        { connector: def.id, apiKey: apiKey.trim() },
        {
          onSuccess: (c) =>
            done(fromConnection(c, catalog.data?.connectors ?? []), again ? "reconnected" : "connected"),
        },
      );
    }
  };

  const keyForm = (
    <form
      className="cflow__key"
      onSubmit={(e) => {
        e.preventDefault();
        submitKey();
      }}
    >
      {needsKey && (
        <Alert tone="neutral">
          {needsKey.reason === "not_approved" ? (
            <>
              {t("connectFlow.notApproved", { name: name ?? new URL(serverUrl).hostname })}
              {needsKey.detail && (
                <span className="cflow__said small muted">
                  {t("connectFlow.serverSaid", { detail: needsKey.detail })}
                </span>
              )}
            </>
          ) : (
            t("connectFlow.needsKey")
          )}
        </Alert>
      )}
      <Field
        label={t("connectors.apiKey")}
        id="cflow-key"
        hint={{ name: t("common.about", { label: t("connectors.apiKey") }), text: t("connectors.apiKeyHelp") }}
        error={keyError}
      >
        <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
    </form>
  );

  return (
    <>
      <Locked when={busy}>
        <DialogBody className="cflow__body">
          {def && viaComposio ? (
            <p className="muted cflow__text">
              {connectorDescription(t, def)} {composioConnectText(t, def)}
            </p>
          ) : def && appOffered ? (
            <p className="muted cflow__text">{connectorDescription(t, def)}</p>
          ) : def ? (
            <p className="muted cflow__text">
              {connectorDescription(t, def)} {canOAuth && t("connectFlow.oauthHelp", { name: connectorBrand(def) })}
            </p>
          ) : viaComposio ? (
            <p className="muted cflow__text">{t("connectors.composio.via")}</p>
          ) : fixed ? (
            <p className="muted cflow__text">{fixed}</p>
          ) : (
            <p className="muted cflow__text">{t("connectFlow.customText")}</p>
          )}
          {askUrl && (
            <Field label={t("connectors.serverUrl")} id="cflow-url" example={t("connectFlow.urlHelp")} error={urlError}>
              <Input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setNeedsKey(null);
                }}
                placeholder="https://"
                inputMode="url"
              />
            </Field>
          )}
          {def === null && fixed === null && (
            <Field label={t("connectFlow.name")} id="cflow-name">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("connectFlow.namePlaceholder")}
              />
            </Field>
          )}
          {githubOrgs && <GithubOrgs />}
          {appOffered && (
            <OptionList
              aria-label={t("connectFlow.github.how")}
              value={how}
              onValueChange={setHow}
              options={[
                {
                  value: "app",
                  title: t("connectFlow.github.app"),
                  tag: t("connectFlow.github.recommended"),
                  description: t("connectFlow.github.appText"),
                },
                {
                  value: "account",
                  title: t("connectFlow.github.account"),
                  description: t("connectFlow.github.accountText"),
                },
              ]}
            />
          )}
          {!viaApp && canOAuth && canKey && (
            <details
              className="cflow__more"
              open={keyOpen}
              onToggle={(e) => setKeyOpen((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary>{t("connectFlow.withKey")}</summary>
              {keyForm}
            </details>
          )}
          {!viaApp && !canOAuth && canKey && keyForm}
        </DialogBody>
      </Locked>
      <DialogFooter
        bar
        note={
          connect.isPending
            ? steps
            : viaApp
              ? t("connectFlow.github.appNote")
              : replacing
                ? t(unchecked ? "connectFlow.replaceUnchecked" : "connectFlow.replace")
                : again && unchecked
                  ? t("connectFlow.newAccountUnchecked")
                  : t("connectFlow.allCanUse")
        }
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        {viaApp ? (
          <Button variant="primary" disabled={busy} loading={installApp.isPending} onClick={startApp}>
            {t("githubApp.install")}
          </Button>
        ) : canKey && (keyOpen || !canOAuth) ? (
          <Button
            variant="primary"
            disabled={busy}
            loading={(withKey.isPending || connect.isPending) && touched === "key"}
            onClick={submitKey}
          >
            {t("connectors.saveKey")}
          </Button>
        ) : (
          canOAuth && (
            <Button
              variant="primary"
              disabled={busy}
              loading={(connect.isPending || oauth.isPending) && touched === "oauth"}
              onClick={startOAuth}
            >
              {viaComposio
                ? t("connectFlow.continueInComposio")
                : def
                  ? t("connectFlow.continueIn", { name: connectorBrand(def) })
                  : t("connectors.connect")}
            </Button>
          )
        )}
      </DialogFooter>
    </>
  );
}

/**
 * The organizations GitHub lets us reach, on Reconectar: GitHub's sign-in asks about them only the first time, so it
 * comes straight back and more of them are granted on its own page. Coming back from either, this says what changed.
 */
function GithubOrgs() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const access = useGithubAccess(org.id);
  const [kept] = useState(readGithubOrgs);
  useEffect(forgetGithubOrgs, []);
  const orgs = access.data?.orgs ?? null;
  const manageUrl = access.data?.manageUrl;
  const [opened, setOpened] = useState<readonly string[] | null>(null);
  const before = kept ?? opened;
  const change = before && orgs && !access.isFetching ? orgAccessChange(t, before, orgs) : null;
  return (
    <section className="cflow__orgs" aria-label={t("connectFlow.githubOrgs.title")}>
      <h3 className="cflow__orgs-title">{t("connectFlow.githubOrgs.title")}</h3>
      {access.isPending ? (
        <Skeleton height={24} />
      ) : orgs === null ? (
        <>
          <p className="small muted">{t("connectFlow.githubOrgs.failed")}</p>
          <Button size="sm" loading={access.isFetching} onClick={() => void access.refetch()}>
            {t("common.retry")}
          </Button>
        </>
      ) : orgs.length > 0 ? (
        <ul className="cflow__orgs-list">
          {orgs.map((o) => (
            <li key={o}>
              <Chip>{o}</Chip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{t("connectFlow.githubOrgs.none")}</p>
      )}
      {change && (
        <p className="small" aria-live="polite">
          {change}
        </p>
      )}
      {manageUrl && (
        <>
          <p className="small muted">{t("connectFlow.githubOrgs.lead")}</p>
          <Button
            asChild
            size="sm"
            onClick={() => {
              if (orgs) setOpened(orgs);
            }}
          >
            <a href={manageUrl} target="_blank" rel="noreferrer">
              {t("connectFlow.githubOrgs.open")}
            </a>
          </Button>
        </>
      )}
    </section>
  );
}

/**
 * The end of connecting: who can use it and how many actions ask, in a sentence, with "Pronto". A server whose tools
 * no one gave a level yet says so instead, and "Continuar" saves the levels we suggest: agents get none before that.
 * Tools that couldn't be read are said too, as their step under "Ajustar" says them.
 */
function DoneStep({ item, onAdjust, onClose }: { item: ConnectedItem; onAdjust: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { save } = useCustomServerAction(org.id);
  const waiting = item.pending > 0 ? item.server : null;
  return (
    <ConnectedDone
      text={connectedSummary(t, item)}
      busy={save.isPending}
      onAdjust={onAdjust}
      onClose={onClose}
      primary={
        waiting && (
          <Button
            variant="primary"
            disabled={save.isPending}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: waiting.id,
                  label: waiting.label,
                  tools: reviewDecisions(reviewToolsOf(t, waiting), {}, new Set()),
                },
                { onSuccess: onClose },
              )
            }
          >
            {t("connectFlow.next")}
          </Button>
        )
      }
    >
      {item.toolsError && <Alert>{t("toolReview.unreadable", { reason: item.toolsError })}</Alert>}
    </ConnectedDone>
  );
}

/**
 * How connecting anything ends, inside its dialog: one sentence on who can use it, then "Ajustar" (the detail) and
 * "Pronto", or `primary` in its place.
 */
export function ConnectedDone({
  text,
  children,
  busy,
  primary,
  onAdjust,
  onClose,
}: {
  text: string;
  children?: ReactNode;
  busy?: boolean;
  primary?: ReactNode;
  onAdjust: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DialogBody className="cflow__body">
        <p className="cflow__text">{text}</p>
        {children}
      </DialogBody>
      <DialogFooter bar>
        <Button disabled={busy} onClick={onAdjust}>
          {t("connectFlow.done.adjust")}
        </Button>
        {primary || (
          <Button variant="primary" onClick={onClose}>
            {t("connectFlow.done.ok")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/** A catalog connector's tools for the read-only review (classified by our scopes). */
function catalogReviewTools(t: TFunction, item: ConnectedItem): ReviewTool[] {
  const prefix = item.def ? item.def.id : null;
  return (item.def?.tools ?? []).map((tool) => {
    const parts = partsOf(tool.name, prefix);
    const level = catalogToolClass(tool);
    return {
      name: tool.name,
      label: toolName(t, parts, tool.name),
      description: "",
      subject: parts.subject,
      level,
      suggested: level,
      reason: null,
      sensitive: tool.sensitive,
      pending: false,
      savedLabel: humanize(tool.name),
    };
  });
}

/**
 * Step 2: "Revise o que o agente pode fazer sozinho".
 * Servers by address: every tool comes classified; the person settles the
 * ones the name can't decide and changes what they want. Ours: read-only, by scope.
 */
function ToolsStep({
  item,
  naming,
  onNext,
  onClose,
}: {
  item: ConnectedItem;
  /** A new account the provider didn't name: its name, editable, above its tools. */
  naming: boolean;
  onNext: (item: ConnectedItem) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const catalog = useCatalog();
  const { save, refresh } = useCustomServerAction(org.id);
  const rename = useRenameConnection(org.id);
  const [server, setServer] = useState(item.server);
  const [label, setLabel] = useState(item.label);
  const [labelError, setLabelError] = useState<string | null>(null);
  const tools = server ? reviewToolsOf(t, server) : [];
  const [state, setState] = useState<ToolReviewState>({ levels: {}, decided: new Set() });
  const next = (saved?: CustomServer) => onNext(saved ? fromServer(saved, catalog.data?.connectors ?? []) : item);
  const name = itemName(t, item);

  if (!server) {
    const list = catalogReviewTools(t, item);
    return (
      <>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("toolReview.catalogLead", { name })}</p>
          {list.length === 0 ? <p className="muted">{t("toolReview.noTools")}</p> : <ToolLevelsView tools={list} />}
        </DialogBody>
        <DialogFooter bar>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => next()}>
            {t("connectFlow.next")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const saveAll = async () => {
    const wanted = label.trim();
    let named = server.label;
    if (naming && wanted && wanted !== server.label) {
      try {
        named = (await rename.mutateAsync({ id: server.id, label: wanted })).label;
      } catch (error) {
        setLabelError(errorText(t, error, i18n.language));
        return;
      }
    }
    save.mutate(
      { id: server.id, label: named, tools: reviewDecisions(tools, state.levels, state.decided) },
      { onSuccess: (saved) => next(saved) },
    );
  };

  return (
    <>
      <Locked when={save.isPending || rename.isPending}>
        <DialogBody className="cflow__body tr-body">
          {naming && (
            <Field
              label={t("connectFlow.accountName")}
              id="cflow-account"
              hint={{
                name: t("common.about", { label: t("connectFlow.accountName") }),
                text: t("connectFlow.accountNameHelp"),
              }}
              error={labelError ?? undefined}
            >
              <Input
                value={label}
                maxLength={80}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setLabelError(null);
                }}
              />
            </Field>
          )}
          <div className="cflow__lead">
            {server.toolsError ? (
              <Alert>{t("toolReview.unreadable", { reason: server.toolsError })}</Alert>
            ) : (
              <p className="muted cflow__text">{t("toolReview.lead", { count: tools.length, name })}</p>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon="repeat"
              disabled={refresh.isPending}
              loading={refresh.isPending}
              onClick={() => refresh.mutate(server.id, { onSuccess: (fresh) => setServer(fresh) })}
            >
              {server.toolsError ? t("common.retry") : t("toolReview.refresh")}
            </Button>
          </div>
          {tools.length === 0 ? (
            server.toolsError ? null : (
              <p className="muted">{t("toolReview.noTools")}</p>
            )
          ) : (
            <ToolReview name={name} tools={tools} state={state} onChange={setState} onMoved={(m) => toast.show(m)} />
          )}
        </DialogBody>
      </Locked>
      <DialogFooter bar note={reviewNote(t, tools, state)}>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={save.isPending || rename.isPending}
          loading={save.isPending || rename.isPending}
          onClick={() => void saveAll()}
        >
          {t("connectFlow.next")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Step 3: "Todos os agentes" on top (the main choice: it sets every agent), then one level per agent; "Liberar"
 * merges them into each agent's grants.
 */
function WhoStep({ item, onBack, onClose }: { item: ConnectedItem; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const agents = useAgents(org.id);
  const list = agents.data ?? [];
  const access = useAgentsAccess(list);
  const resourceId = `connector:${item.id}`;
  const current = (agentId: string) => levelIn(access.byAgent.get(agentId), resourceId);
  const [who, setWho] = useState<Record<string, LevelState> | null>(null);
  const loaded = agents.isSuccess && !access.loading && !access.fetching;
  // Starts once from each agent's level, read fresh: a connection made a moment ago is already every agent's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the fresh trees arrive
  useEffect(() => {
    if (loaded && who === null) setWho(Object.fromEntries(list.map((a) => [a.id, current(a.id)])));
  }, [loaded]);
  const ready = who !== null;
  const picked = (agentId: string) => who?.[agentId] ?? "none";
  const levelLabel = (l: LevelState) => t(`access.level.${l}`);
  const options = (agentId: string) => [
    ...LEVELS.map((l) => ({ value: l as LevelState, label: levelLabel(l) })),
    // Granted tool by tool before: shown as is until a level is picked.
    ...(current(agentId) === "custom" ? [{ value: "custom" as LevelState, label: levelLabel("custom") }] : []),
  ];
  const asks = asksCount(t, item);

  const grant = useMutation({
    mutationFn: async () => {
      const changed = list.filter((a) => {
        const level = picked(a.id);
        return level !== "custom" && level !== current(a.id);
      });
      for (const a of changed) {
        const saved = await saveLevels(api, org.id, a.id, { [resourceId]: picked(a.id) as Level });
        qc.setQueryData(keys.agentAccess(org.id, a.id), saved);
      }
      return changed.length;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.access(org.id) });
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "org" && q.queryKey[4] === "scopes" });
      const count = list.filter((a) => picked(a.id) !== "none").length;
      toast.show(t("connectFlow.saved", { count, name: itemName(t, item) }));
      onClose();
    },
  });

  return (
    <>
      <Locked when={grant.isPending}>
        <DialogBody className="cflow__body">
          {!ready ? (
            <LoadingList count={3} />
          ) : list.length === 0 ? (
            <p className="muted">{t("connectFlow.noAgents")}</p>
          ) : (
            <>
              {list.length > 1 && (
                <div className="cflow-agent cflow-agent--all">
                  <span className="cflow-agent__all-icon" aria-hidden="true">
                    <Icon name="members" size={16} />
                  </span>
                  <span className="cflow-agent__name">
                    <span>{t("connectFlow.everyone")}</span>
                    <span className="small muted">{t("connectFlow.everyoneCount", { count: list.length })}</span>
                  </span>
                  <Segmented<LevelState | "">
                    size="sm"
                    label={t("connectFlow.everyoneLevel")}
                    value={sharedLevel(list.map((a) => picked(a.id))) ?? ""}
                    onValueChange={(l) => {
                      if (l) setWho(Object.fromEntries(list.map((a) => [a.id, l])));
                    }}
                    options={LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))}
                  />
                </div>
              )}
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
                      value={picked(a.id)}
                      onValueChange={(l) => setWho((w) => ({ ...w, [a.id]: l }))}
                      options={options(a.id)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="small muted cflow__asks">
            <Icon name="lock" />
            {asks > 0 ? t("connectFlow.asksCount", { count: asks }) : t("connectFlow.asksDefault")}
          </p>
        </DialogBody>
      </Locked>
      <DialogFooter bar>
        <Button disabled={grant.isPending} onClick={onBack}>
          {t("connectFlow.back")}
        </Button>
        <Button
          variant="primary"
          disabled={!ready || grant.isPending}
          loading={grant.isPending}
          onClick={() => grant.mutate()}
        >
          {t("connectFlow.grant")}
        </Button>
      </DialogFooter>
    </>
  );
}
