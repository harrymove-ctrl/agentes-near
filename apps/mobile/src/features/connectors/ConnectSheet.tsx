import {
  APP_OAUTH_RETURN,
  type Connection,
  type ConnectOutcome,
  type ConnectorDef,
  type CustomServer,
  type GitHubOrgAccess,
  keys,
  useCatalog,
  useCompleteOAuth,
  useConnections,
  useConnectWithKey,
  useCustomServerAction,
  useCustomServers,
  useGitHubApp,
  useGithubAccess,
  useStartOAuth,
} from "@agenteschat/client";
import { composioConnectText } from "@agenteschat/client/lib/composio";
import {
  type ConnectedItem,
  connectedItems,
  itemName,
  orgAccessChange,
  outcomeText,
} from "@agenteschat/client/lib/connected";
import { sameServer } from "@agenteschat/client/lib/custom-tools";
import { knownErrorText, oauthReturnText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorName, scopeText } from "@agenteschat/client/lib/scopes";
import { reviewDecisions, reviewToolsOf } from "@agenteschat/client/lib/tool-review";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import Animated, { Easing, FadeIn, ZoomIn } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GroupedList,
  GroupedRow,
  Icon,
  InfoHint,
  LineIcon,
  Locked,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useOrgId } from "../shared/hooks";
import { errorHaptic, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { AgentLevelList, WaitTile } from "./Access";
import { ConnectorIcon } from "./ConnectorIcon";
import { useInstallGitHubAppHere } from "./GitHubApp";
import { GithubOrgs } from "./GithubOrgs";
import {
  APP_RETURN_URL,
  type AuthAnswer,
  authAnswerOf,
  capabilityLines,
  connectHow,
  connectionOf,
  doneFinishing,
  isHttpsUrl,
  markFinishing,
  needsKeyText,
  stateOf,
} from "./logic";
import { Problem } from "./Problem";
import { ADDRESS_STEPS, CATALOG_STEPS, doneSummary, firstStep, reviewTarget, STEP_KEYS, type Step } from "./review";
import { ReviewStep } from "./ToolReview";
import { openTools } from "./ToolsScreen";

/**
 * One service in a sheet over the gallery, as on the web: what agents could do there (what always asks marked
 * "pede sua aprovação") → connect (sign in in the browser and come back, or paste a key) → a short confirmation
 * that ends it. "Ajustar" there goes on to its tools ("O que faz") and who uses it and how far. A connected one
 * opens on who uses it (its tools are a screen of their own; `item`: that connection, when the service is
 * connected more than once; `start`, back from a sign-in that finished elsewhere). `mode` starts at connecting:
 * `add`, another account of the service, or `reconnect`, a new sign-in for `item` (a toast says it, and the sheet
 * closes). `account`: GitHub's sign-in alone, without the agentes.chat app first (GitHub through the app alone
 * connecting an account).
 */
export function ConnectSheet({
  def,
  item,
  start,
  mode,
  account = false,
}: {
  def: ConnectorDef;
  item?: ConnectedItem;
  start?: Step;
  mode?: "add" | "reconnect";
  account?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const { org } = useOrg();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const admin = can(org, "manage_connectors");
  const sheet = useSheet();
  const existing =
    item ??
    connectionOf(def, connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? [def]));
  const connecting = Boolean(mode) || account;
  const [connectionId, setConnectionId] = useState<string | null>(connecting ? null : (existing?.id ?? null));
  const [step, setStep] = useState<Step>(() => (connecting ? "connect" : firstStep(existing, admin, start)));
  const service = connectorName(t, def);
  const name =
    mode === "reconnect" && item
      ? t("connectFlow.reconnectTitle", { name: itemName(t, item) })
      : mode === "add"
        ? t("connectFlow.addTitle", { name: service })
        : service;
  const tr = t as unknown as (key: string) => string;
  const lines = capabilityLines(
    tr,
    (k) => i18n.exists(k),
    def,
    (s) => scopeText(t, s).label,
  );
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={def} label={service} size={52} check={Boolean(connectionId)} />
        <View style={styles.grow}>
          <Text variant="title">{name}</Text>
          <Text variant="small" tone="muted">
            {def.via === "composio"
              ? `${t(`connectors.category.${def.category}`)} · ${t("connectors.composio.via")}`
              : t(`connectors.category.${def.category}`)}
          </Text>
        </View>
      </View>
      <Progress steps={CATALOG_STEPS} step={step} />
      {step === "about" ? (
        <>
          <Text variant="footnote" tone="faint" style={styles.label}>
            {t("mobile.connectors.canTitle")}
          </Text>
          <View style={styles.caps}>
            {lines.map((l) => (
              <View key={l.text} style={styles.cap}>
                <LineIcon name={l.asks ? "shield" : "eye"} size={18} color={l.asks ? c.warn : c.muted} />
                <Text variant="body" style={styles.grow}>
                  {l.asks && !l.said ? t("mobile.connectors.asks", { text: l.text }) : l.text}
                </Text>
              </View>
            ))}
          </View>
          {admin ? (
            <Button variant="primary" wide label={t("mobile.connectors.connect")} onPress={() => setStep("connect")} />
          ) : (
            <Text variant="small" tone="muted">
              {/* A personal workspace's are whoever runs it, never "an admin of Personal" (ADR 0159). */}
              {t(modeKey(org, "mobile.connectors.adminsOnly"), { org: org?.name ?? "" })}
            </Text>
          )}
        </>
      ) : step === "connect" ? (
        <ConnectStep
          def={def}
          name={service}
          item={mode ? item : undefined}
          reconnect={mode === "reconnect"}
          accountOnly={connecting}
          onConnected={(id) => {
            setConnectionId(id);
            setStep("done");
          }}
          onDone={sheet.close}
        />
      ) : connectionId && step === "done" ? (
        <DoneStep connectionId={connectionId} def={def} name={service} onAdjust={() => setStep("review")} />
      ) : connectionId ? (
        <ConnectedSteps
          step={step}
          onStep={setStep}
          connectionId={connectionId}
          def={def}
          name={service}
          item={mode ? undefined : existing}
        />
      ) : null}
    </View>
  );
}

/**
 * "Conectar pelo endereço": any MCP server by its https address (sign in there, or a key when it asks). With an
 * `item` of a server not in the catalog: another account of it (`add`) or a new sign-in for it (`reconnect`).
 */
export function AddressSheet({
  item,
  mode,
  url,
}: {
  item?: ConnectedItem;
  mode?: "add" | "reconnect";
  url?: string;
} = {}) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const [connected, setConnected] = useState<{ id: string; name: string } | null>(null);
  const [step, setStep] = useState<Step>("connect");
  const title =
    item && mode === "reconnect"
      ? t("connectFlow.reconnectTitle", { name: itemName(t, item) })
      : item
        ? t("connectFlow.addTitle", { name: itemName(t, item) })
        : t("mobile.connectors.addressTitle");
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon
          def={item?.def ?? null}
          image={item?.image}
          label={connected?.name ?? item?.label ?? "+"}
          size={52}
          check={Boolean(connected)}
        />
        <View style={styles.grow}>
          <Text variant="title">{title}</Text>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {item?.viaComposio
              ? t("connectors.composio.via")
              : (item?.server?.serverUrl ?? t("mobile.connectors.addressHelp"))}
          </Text>
        </View>
      </View>
      <Progress steps={ADDRESS_STEPS} step={step} />
      {connected && step === "done" ? (
        <DoneStep connectionId={connected.id} def={null} name={connected.name} onAdjust={() => setStep("who")} />
      ) : connected ? (
        <ConnectedSteps step={step} onStep={setStep} connectionId={connected.id} def={null} name={connected.name} />
      ) : (
        <ConnectStep
          def={null}
          name={item ? itemName(t, item) : ""}
          item={item}
          initialUrl={url}
          reconnect={mode === "reconnect"}
          onConnected={(id, name) => {
            setConnected({ id, name });
            setStep("done");
          }}
          onDone={sheet.close}
        />
      )}
    </View>
  );
}

/**
 * A server connected by its address that isn't in the catalog: its name and address, then its tools and who
 * uses it (the same steps as connecting it), and disconnecting it.
 */
export function ServerSheet({ item, start }: { item: ConnectedItem; start?: Step }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_connectors");
  // Its tools never hold this sheet: they wait on the connection's screen.
  const [step, setStep] = useState<Step>(() => firstStep(item, admin, start === "review" ? "who" : start));
  const name = itemName(t, item);
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <ConnectorIcon def={item.def} image={item.image} label={name} size={52} check />
        <View style={styles.grow}>
          <Text variant="title" numberOfLines={1}>
            {name}
          </Text>
          {item.account ? (
            <Text variant="small" tone="muted" numberOfLines={1}>
              {item.account}
            </Text>
          ) : null}
        </View>
      </View>
      <Progress steps={ADDRESS_STEPS} step={step} />
      {step === "done" ? (
        <DoneStep connectionId={item.id} def={item.def} name={name} onAdjust={() => setStep("who")} />
      ) : (
        <ConnectedSteps step={step} onStep={setStep} connectionId={item.id} def={item.def} name={name} item={item} />
      )}
    </View>
  );
}

/**
 * The end of connecting, as on the web: a check, "<name> conectado" and who can use it with how many actions ask,
 * then "Pronto". A server whose tools no one gave a level yet says so instead, and "Continuar" saves the levels we
 * suggest: agents get none before that. "Ajustar" goes on to the detail.
 */
function DoneStep({
  connectionId,
  def,
  name,
  onAdjust,
}: {
  connectionId: string;
  def: ConnectorDef | null;
  name: string;
  onAdjust: () => void;
}) {
  const { t } = useTranslation();
  const sheet = useSheet();
  const orgId = useOrgId();
  const servers = useCustomServers(orgId);
  const { save } = useCustomServerAction(orgId);
  const [failed, setFailed] = useState<string | null>(null);
  const summary = doneSummary(t, reviewTarget(connectionId, def, servers.data, servers.isFetching));
  const waiting = summary?.waiting ?? null;
  const apply = (server: CustomServer) => {
    setFailed(null);
    save.mutate(
      { id: server.id, label: server.label, tools: reviewDecisions(reviewToolsOf(t, server), {}, new Set()) },
      {
        onSuccess: () => {
          successHaptic();
          sheet.close();
        },
        onError: () => {
          errorHaptic();
          setFailed(t("mobile.connectors.review.saveFailed", { name }));
        },
      },
    );
  };
  return (
    <>
      <ConnectedNote name={name} text={summary?.text ?? null} />
      {summary?.unreadable ? <Problem text={t("toolReview.unreadable", { reason: summary.unreadable })} /> : null}
      {failed ? <Problem key={failed} text={failed} /> : null}
      <Button
        variant="primary"
        wide
        label={
          save.isPending
            ? t("mobile.connectors.review.saving")
            : waiting
              ? t("connectFlow.next")
              : t("connectFlow.done.ok")
        }
        disabled={!summary || save.isPending}
        onPress={() => (waiting ? apply(waiting) : sheet.close())}
      />
      <Button
        variant="secondary"
        wide
        label={t("connectFlow.done.adjust")}
        disabled={!summary || save.isPending}
        onPress={onAdjust}
      />
    </>
  );
}

/**
 * The detail behind "Ajustar": a catalog service's tools ("O que faz", then Continuar), then who uses it (one row
 * per agent, the level as its value). What a server's tools need from an admin is one row there (it opens
 * Ferramentas); anyone else is told when they still wait for an admin. Ferramentas, the account and Desconectar
 * live on its screen.
 */
function ConnectedSteps({
  step,
  onStep,
  connectionId,
  def,
  name,
  item,
}: {
  step: Step;
  onStep: (step: Step) => void;
  connectionId: string;
  def: ConnectorDef | null;
  name: string;
  /** The connection as it was opened (the live lists win once they have it). */
  item?: ConnectedItem;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const sheet = useSheet();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const admin = can(org, "manage_connectors");
  const live =
    connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []).find(
      (i) => i.id === connectionId,
    ) ?? item;
  if (step === "review") {
    return <ReviewStep connectionId={connectionId} def={def} name={name} onNext={() => onStep("who")} />;
  }
  const waiting = admin && live ? live.pending : 0;
  return (
    <>
      <AgentLevelList connectionId={connectionId} />
      {waiting > 0 ? (
        // What the server's tools need from the person, one tap away, never in the way of finishing.
        <GroupedList>
          <GroupedRow
            leading={<WaitTile />}
            label={t("toolReview.decideTitle", { count: waiting })}
            chevron
            onPress={() => {
              sheet.close();
              openTools(connectionId);
            }}
          />
        </GroupedList>
      ) : null}
      {live?.needsReview && !admin ? (
        <Text variant="small" tone="muted">
          {t("mobile.connectors.review.waiting")}
        </Text>
      ) : null}
      <Button variant="primary" wide label={t("mobile.connectors.done")} onPress={sheet.close} />
    </>
  );
}

/** A strong ease-out: the check settles fast. */
const POP = Easing.bezier(0.23, 1, 0.32, 1);

/** Just connected: a check that pops in (the phone buzzes with it), the name and, once known, what it means. */
export function ConnectedNote({ name, text }: { name: string; text: string | null }) {
  const { t } = useTranslation();
  const { colors, reducedMotion } = useTheme();
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeIn.duration(220)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.note, styles.notice, { borderColor: colors.line }]}
    >
      <Animated.View
        // From 0.9, never from nothing; the note around it fades in with it.
        entering={
          reducedMotion
            ? undefined
            : ZoomIn.duration(240)
                .easing(POP)
                .withInitialValues({ transform: [{ scale: 0.9 }] })
        }
        style={[styles.badge, { backgroundColor: colors.ok }]}
      >
        {/* The page's own color on the green: white on dark's light green was hard to read. */}
        <Icon name="check" size={16} color={colors.bg} />
      </Animated.View>
      <View style={styles.grow}>
        <Text variant="body" style={styles.bold}>
          {t("mobile.connectors.connectedTitle", { name })}
        </Text>
        {text ? (
          <Animated.View entering={reducedMotion ? undefined : FadeIn.duration(160)}>
            <Text variant="small" tone="muted">
              {text}
            </Text>
          </Animated.View>
        ) : null}
      </View>
    </Animated.View>
  );
}

/**
 * Connecting: sign in in the system browser (the server hands the answer back to the app, which finishes
 * with its own session) and/or paste a key. A catalog service that needs its server's address asks for it.
 * `item`: an account of a server by address (its address; `reconnect`: a new sign-in for it). A new account
 * goes on (`onConnected`); a new sign-in, or the same account again, ends with a toast (`onDone`). GitHub, where
 * the server has the agentes.chat app (ADR 0156), offers the app first and an account as the other way, unless
 * `accountOnly` (a sign-in asked for as such).
 */
function ConnectStep({
  def,
  name,
  item,
  initialUrl,
  reconnect = false,
  accountOnly = false,
  onConnected,
  onDone,
}: {
  def: ConnectorDef | null;
  name: string;
  item?: ConnectedItem;
  /** The address already typed in (an agent's card in the chat). */
  initialUrl?: string;
  reconnect?: boolean;
  accountOnly?: boolean;
  onConnected: (connectionId: string, name: string) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const qc = useQueryClient();
  const toast = useToast();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const servers = useCustomServers(orgId);
  const start = useStartOAuth(orgId);
  const complete = useCompleteOAuth(orgId);
  const withKey = useConnectWithKey(orgId);
  const { connect } = useCustomServerAction(orgId);
  const fixed = item?.server?.serverUrl;
  const byAddress = fixed !== undefined || def === null || def.kind === "remote_mcp";
  const askUrl = fixed === undefined && def === null;
  // Composio's page signs in: no key field of ours.
  const viaComposio = item ? item.viaComposio : def?.via === "composio";
  const connectionId = reconnect && item?.custom ? item.id : undefined;
  const githubOrgs = reconnect && def?.id === "github" && !viaComposio && !item?.viaGithubApp;
  const access = useGithubAccess(orgId, githubOrgs);
  const githubApp = useGitHubApp(orgId);
  const installer = useInstallGitHubAppHere();
  const appOffered = def?.id === "github" && !viaComposio && !accountOnly && githubApp.data?.installable === true;
  const [via, setVia] = useState<"app" | "account">("app");
  const how = def ? connectHow(def) : "either";
  const [mode, setMode] = useState<"signIn" | "key">(how === "key" ? "key" : "signIn");
  const [url, setUrl] = useState(initialUrl ?? "");
  // By address: the address first (Continuar checks it), then how to get in, once the host is known.
  const [phase, setPhase] = useState<"address" | "enter">(() =>
    askUrl && !isHttpsUrl(initialUrl ?? "") ? "address" : "enter",
  );
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = start.isPending || complete.isPending || withKey.isPending || connect.isPending || installer.busy;
  const serverUrl = fixed ?? (def?.kind === "remote_mcp" ? def.serverUrl : url.trim());
  const shownName = name || serverUrl.replace(/^https:\/\//, "").split("/")[0] || "";
  const keyLabel = t("mobile.connectors.keyLabel", { name: shownName });
  // The service's name: the server names another account after it ("Stripe 2"). A catalog entry's goes in English,
  // so each viewer reads a name nobody changed in their own language.
  const first = fixed ? (servers.data ?? []).find((s) => sameServer(s.serverUrl, fixed)) : undefined;
  const label = def ? def.label : first?.label || item?.label || name;

  // Every ending is felt as well as seen: a success buzz with the sheet moving on, an error buzz with the
  // reason in the sheet.
  const connected = async (id: string, shown: string, outcome: ConnectOutcome = "connected") => {
    successHaptic();
    if (outcome === "connected") return onConnected(id, shown || shownName);
    const orgsBefore = githubOrgs ? qc.getQueryData<GitHubOrgAccess>(keys.githubAccess(orgId))?.orgs : null;
    const orgsNow = orgsBefore ? await access.refetch().then((r) => r.data?.orgs) : null;
    // The lists were read again on the way back: the account's own name and whether its provider named it.
    const now = connectedItems(
      qc.getQueryData<Connection[]>(keys.connections(orgId)) ?? [],
      qc.getQueryData<CustomServer[]>(keys.customServers(orgId)) ?? [],
      catalog.data?.connectors ?? [],
    ).find((i) => i.id === id);
    const said = now ? outcomeText(t, outcome, now) : t("mobile.connectors.connectedDone");
    toast({
      title:
        orgsBefore && orgsNow
          ? t("common.joinSentences", { a: said, b: orgAccessChange(t, orgsBefore, orgsNow) })
          : said,
    });
    onDone();
    // Landed on another connection (a catalog connector's new sign-in is a new one): the screen behind follows it.
    if (item && id !== item.id) router.replace(`/connectors/${id}`);
  };
  const oops = (text: string) => {
    errorHaptic();
    setError(text);
  };
  const fail = (error?: unknown) => oops(knownErrorText(t, error) ?? t("mobile.connectors.failed"));
  /** The browser round trip: open, wait for the answer, finish with the app's session. */
  const signInWith = async (authorizeUrl: string) => {
    const state = stateOf(authorizeUrl);
    if (state) markFinishing(state);
    try {
      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, APP_RETURN_URL);
      if (result.type !== "success") return;
      const answer: AuthAnswer | null = authAnswerOf(result.url);
      if (!answer) return fail();
      if (answer.kind === "error") {
        // A connector's own refusal (Composio's unfinished sign-in) comes as its full code.
        const own = answer.error.startsWith("connector.") ? oauthReturnText(t, answer.error) : null;
        return oops(own ?? t("mobile.connectors.refused", { name: shownName }));
      }
      const done = await complete.mutateAsync({ state: answer.state, code: answer.code });
      await connected(done.connectionId, name, done.outcome);
    } catch (error) {
      fail(error);
    } finally {
      if (state) doneFinishing(state);
    }
  };

  const signIn = async () => {
    setError(null);
    if (askUrl && !isHttpsUrl(url)) return oops(t("mobile.connectors.addressInvalid"));
    try {
      if (byAddress) {
        const res = await connect.mutateAsync({
          serverUrl,
          returnTo: APP_OAUTH_RETURN,
          ...(label ? { label } : {}),
          ...(connectionId ? { connectionId } : {}),
        });
        if (res.status === "oauth") return void (await signInWith(res.authorizeUrl));
        if (res.status === "needs_key") {
          setMode("key");
          return oops(needsKeyText(t, res, shownName));
        }
        return await connected(res.server.id, res.server.label, res.outcome);
      }
      if (!def) return;
      const authorizeUrl = await start.mutateAsync({ connector: def.id, returnTo: APP_OAUTH_RETURN });
      await signInWith(authorizeUrl);
    } catch (error) {
      fail(error);
    }
  };

  const submitKey = async () => {
    setError(null);
    if (askUrl && !isHttpsUrl(url)) return oops(t("mobile.connectors.addressInvalid"));
    if (key.trim().length < 8) return oops(t("mobile.connectors.keyShort"));
    try {
      if (byAddress) {
        const res = await connect.mutateAsync({
          serverUrl,
          apiKey: key.trim(),
          returnTo: APP_OAUTH_RETURN,
          ...(label ? { label } : {}),
          ...(connectionId ? { connectionId } : {}),
        });
        if (res.status === "connected") return await connected(res.server.id, res.server.label, res.outcome);
        return fail();
      }
      if (!def) return;
      const conn = await withKey.mutateAsync({ connector: def.id, apiKey: key.trim() });
      // One account per catalog connector: connecting it again is its new sign-in.
      await connected(conn.id, name, reconnect ? "reconnected" : "connected");
    } catch (error) {
      fail(error);
    }
  };

  const installApp = async () => {
    setError(null);
    const done = await installer.run();
    if (done.installed) onDone();
    else if (done.error) oops(done.error);
  };
  const field = [styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  const toEnter = () => {
    if (!isHttpsUrl(url.trim())) return oops(t("mobile.connectors.addressInvalid"));
    setError(null);
    setPhase("enter");
  };
  if (appOffered && via === "app") {
    return (
      <>
        <Text variant="small" tone="muted">
          {t("connectFlow.github.appText")}
        </Text>
        <Button
          variant="primary"
          wide
          label={busy ? t("mobile.connectors.working") : t("githubApp.install")}
          disabled={busy}
          onPress={() => void installApp()}
        />
        <Button
          variant="text"
          size="sm"
          label={t("mobile.connectors.githubApp.useAccount")}
          disabled={busy}
          onPress={() => {
            setError(null);
            setVia("account");
          }}
        />
        {error ? <Problem key={error} text={error} /> : null}
      </>
    );
  }
  return (
    <>
      {viaComposio && def ? (
        <Text variant="small" tone="muted">
          {composioConnectText(t, def)}
        </Text>
      ) : appOffered ? (
        <Text variant="small" tone="muted">
          {t("connectFlow.github.accountText")}
        </Text>
      ) : null}
      {askUrl && phase === "address" ? (
        <>
          <Locked when={busy} style={styles.fieldBox}>
            <Text variant="footnote" tone="faint">
              {t("mobile.connectors.addressLabel")}
            </Text>
            <TextInput
              value={url}
              onChangeText={(v) => {
                setUrl(v);
                setError(null);
              }}
              placeholder="https://"
              placeholderTextColor={c.faint}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType="url"
              returnKeyType="next"
              onSubmitEditing={toEnter}
              accessibilityLabel={t("mobile.connectors.addressLabel")}
              style={field}
            />
          </Locked>
          <Button variant="primary" wide label={t("connectFlow.next")} disabled={busy} onPress={toEnter} />
          {error ? <Problem key={error} text={error} /> : null}
        </>
      ) : (
        <>
          {askUrl ? (
            // The address it will enter, and a way back to change it.
            <View style={styles.keyRow}>
              <Text variant="footnote" tone="faint" numberOfLines={1} style={styles.grow}>
                {serverUrl}
              </Text>
              <Button
                variant="text"
                size="sm"
                label={t("common.back")}
                disabled={busy}
                onPress={() => setPhase("address")}
              />
            </View>
          ) : null}
          {githubOrgs ? <GithubOrgs /> : null}
          {mode === "signIn" ? (
            <Button
              variant="primary"
              wide
              label={
                busy
                  ? t("mobile.connectors.working")
                  : viaComposio
                    ? t("connectFlow.continueInComposio")
                    : t("mobile.connectors.signIn", { name: shownName })
              }
              disabled={busy}
              onPress={() => void signIn()}
            />
          ) : (
            <>
              <Locked when={busy} style={styles.fieldBox}>
                <InfoHint
                  name={t("common.about", { label: keyLabel })}
                  text={t("mobile.connectors.keyHelp")}
                  variant="footnote"
                >
                  <Text variant="footnote" tone="faint">
                    {keyLabel}
                  </Text>
                </InfoHint>
                <View style={styles.keyRow}>
                  <TextInput
                    value={key}
                    onChangeText={setKey}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabel={keyLabel}
                    style={[field, styles.grow]}
                  />
                  <Pressable
                    onPress={() => void Clipboard.getStringAsync().then((v) => setKey(v.trim()))}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.connectors.paste")}
                    // 40 tall beside the field: 44 to the finger.
                    hitSlop={4}
                    style={({ pressed }) => [
                      styles.paste,
                      { borderColor: c.line },
                      pressed ? { backgroundColor: c.sunken } : null,
                    ]}
                  >
                    <Text variant="small" style={styles.bold}>
                      {t("mobile.connectors.paste")}
                    </Text>
                  </Pressable>
                </View>
              </Locked>
              <Button
                variant="primary"
                wide
                label={busy ? t("mobile.connectors.working") : t("mobile.connectors.connect")}
                disabled={busy}
                onPress={() => void submitKey()}
              />
            </>
          )}
          {/* The other way in, as words under the button, only where both exist (a server asked for a key). */}
          {!viaComposio && (how === "either" || (byAddress && mode === "key")) ? (
            <Button
              variant="text"
              size="sm"
              label={mode === "signIn" ? t("mobile.connectors.useKey") : t("mobile.connectors.useSignIn")}
              disabled={busy}
              onPress={() => setMode(mode === "signIn" ? "key" : "signIn")}
            />
          ) : null}
          {appOffered ? (
            <Button
              variant="text"
              size="sm"
              label={t("mobile.connectors.githubApp.useApp")}
              disabled={busy}
              onPress={() => {
                setError(null);
                setVia("app");
              }}
            />
          ) : null}
          {error ? <Problem key={error} text={error} /> : null}
        </>
      )}
    </>
  );
}

/** One dash per step, the ones done and the current in ink, and the step said under them ("Passo 2 de 2: …"). */
export function Progress({ steps, step }: { steps: Step[]; step: Step }) {
  const { t } = useTranslation();
  const c = useColors();
  if (step === "done") return null;
  const index = steps.indexOf(step);
  const said = t("mobile.connectors.step", { n: index + 1, total: steps.length, label: t(STEP_KEYS[step]) });
  return (
    <View accessible accessibilityLabel={said} style={styles.steps}>
      <View style={styles.progress}>
        {steps.map((s, i) => (
          <View key={s} style={[styles.dash, { backgroundColor: i <= index ? c.ink : c.line2 }]} />
        ))}
      </View>
      <Text variant="footnote" tone="faint" style={styles.bold}>
        {said}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  label: { letterSpacing: 0.3 },
  caps: { gap: 10 },
  cap: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  steps: { gap: 8 },
  progress: { flexDirection: "row", gap: 6 },
  dash: { flex: 1, height: 3, borderRadius: 999 },
  fieldBox: { gap: 6 },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...fieldText("body"),
  },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  paste: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  // A neutral card with a colored badge: the outcome of connecting (`Problem` draws what went wrong the same).
  notice: {
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
});
