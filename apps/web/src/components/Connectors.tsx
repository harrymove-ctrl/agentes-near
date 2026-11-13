import type { Agent, DatabaseConnection, MailAccount } from "@agenteschat/client";
import {
  keys,
  useAgents,
  useCatalog,
  useComposioUsage,
  useConnections,
  useCustomServerAction,
  useCustomServers,
  useDatabases,
  useDisconnect,
  useGitHubApp,
  useMailAccounts,
  useMailAction,
  useMailProviders,
  useRenameConnection,
} from "@agenteschat/client";
import { levelIn } from "@agenteschat/client/lib/access-levels";
import { composioUsageText, nearComposioLimit } from "@agenteschat/client/lib/composio";
import {
  type ConnectedItem,
  connectedIds,
  connectedItems,
  isMcpItem,
  itemName,
  outcomeText,
  reconnectAddsText,
} from "@agenteschat/client/lib/connected";
import { sameServer } from "@agenteschat/client/lib/custom-tools";
import { errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import { appAccountsText, githubDisconnectNote } from "@agenteschat/client/lib/github-app";
import { choiceOf, newestAccount } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorBrand } from "@agenteschat/client/lib/scopes";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  AvatarStack,
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
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorCatalogDialog, ConnectorIcon } from "@/components/ConnectorCatalog";
import {
  DatabaseConnectFlow,
  DatabaseDisconnectDialog,
  type DatabaseFlowState,
  DatabaseReconnectDialog,
  DatabaseRow,
  DatabaseScopeDialog,
} from "@/components/DatabaseConnect";
import { GitHubAppPanel, GitHubAppServerCard } from "@/components/GitHubAppPanel";
import { LoadingList } from "@/components/Loading";
import {
  MailAddressesDialog,
  MailConnectFlow,
  MailDisconnectDialog,
  type MailFlowState,
  MailReconnectDialog,
  MailRow,
  mailChoices,
} from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { useAgentsAccess } from "@/hooks/useAgentsAccess";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { takesConnectorReturn } from "@/lib/desktop";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/**
 * Settings → Conectores: what the organization connected, one row per
 * service whatever its kind (state, account, who uses it), "Adicionar
 * conector" (the catalog) and the 3-step connect flow.
 *
 * Back from OAuth: `?connected=github` (or `custom:{id}`) and `?outcome` say what
 * came in; a new account reopens the flow at "O que faz" for it (a numbered one
 * asks its name there first); `?review=1` (older returns) opens the newest
 * server waiting for review. Back from Gmail/Outlook:
 * `?mail=connected&account={id}` opens "O que faz" for that mailbox (older
 * returns without `account`: the newest); `?mail=failed` says it didn't work.
 * Each flow ends on who can use it. Mailboxes (ADR 0038) are rows of the same list.
 */
export function ConnectorsSection({
  connected,
  outcome,
  review,
  mail,
  account,
}: {
  connected?: string;
  /** What the OAuth return did: `connected` (a new account), `reconnected` or `same_account`. */
  outcome?: string;
  review?: boolean;
  mail?: string;
  /** The mailbox Gmail/Outlook came back with. */
  account?: string;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_connectors");
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
  const agents = useAgents(org.id);
  const composio = useComposioUsage(org.id);
  const [adding, setAdding] = useState(false);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [removing, setRemoving] = useState<ConnectedItem | null>(null);
  const [renaming, setRenaming] = useState<ConnectedItem | null>(null);
  const toast = useToast();
  const mailProviders = useMailProviders(org.id);
  const mailAccounts = useMailAccounts(org.id);
  const { connectComposio } = useMailAction(org.id);
  const accounts = mailAccounts.data ?? [];
  const [mailFlow, setMailFlow] = useState<MailFlowState | null>(null);
  const [reconnecting, setReconnecting] = useState<MailAccount | null>(null);
  const [addressesOf, setAddressesOf] = useState<MailAccount | null>(null);
  const [removingMail, setRemovingMail] = useState<MailAccount | null>(null);
  // People's Postgres databases (ADR 0039): rows of the same list, the same kind of flow.
  const databases = useDatabases(org.id);
  const dbList = databases.data ?? [];
  const [dbFlow, setDbFlow] = useState<DatabaseFlowState | null>(null);
  const [reconnectingDb, setReconnectingDb] = useState<DatabaseConnection | null>(null);
  const [scopingDb, setScopingDb] = useState<DatabaseConnection | null>(null);
  const [removingDb, setRemovingDb] = useState<DatabaseConnection | null>(null);
  const reconnect = (account: MailAccount) => {
    // Gmail/Outlook sign in again on the provider's page; the rest take a new app password or API key.
    if (account.via === "composio" && (account.provider === "gmail" || account.provider === "outlook")) {
      connectComposio.mutate(
        { provider: account.provider, accountId: account.id, desktop: takesConnectorReturn() },
        { onSuccess: (started) => navigateAway(started.redirectUrl) },
      );
    } else setReconnecting(account);
  };
  // Back from Gmail/Outlook: "O que faz" for the mailbox that came in, or why it didn't.
  const mailReturned = useRef(false);
  useEffect(() => {
    if (mailReturned.current || !mail) return;
    if (mail === "connected" && !mailAccounts.data && !mailAccounts.isError) return;
    mailReturned.current = true;
    const list = mailAccounts.data ?? [];
    // Another mailbox may be newer (one started and left on the provider's page): the one that came back, by its id.
    const came = mail !== "connected" ? null : account ? list.find((a) => a.id === account) : newestAccount(list);
    if (came && admin) {
      toast.show(t("mail.returned"));
      setMailFlow({ step: 1, account: came });
    } else if (mail !== "connected") toast.show(t("mail.failed"), "error");
    window.history.replaceState(null, "", window.location.pathname);
  }, [mail, account, mailAccounts.data, mailAccounts.isError, admin, t, toast]);
  const defs = catalog.data?.connectors ?? [];
  const items = connectedItems(connections.data ?? [], servers.data ?? [], defs);
  const apps = items.filter((i) => !isMcpItem(i));
  const mcps = items.filter(isMcpItem);
  const agentList = agents.data ?? [];
  const access = useAgentsAccess(agentList, items.length > 0);
  const using = (item: ConnectedItem) =>
    agentList.filter((a) => levelIn(access.byAgent.get(a.id), `connector:${item.id}`) !== "none");

  // Back from OAuth: the confirmation for the connection that just came in.
  const returned = useRef(false);
  const listsFetching = connections.isFetching || servers.isFetching;
  useEffect(() => {
    if (returned.current || (!connected && !review) || !connections.data || !servers.data || !catalog.data) return;
    // The desktop app's window comes back without a reload: the lists cached from before the sign-in don't have
    // the new connection until they are read again.
    if (listsFetching) return;
    returned.current = true;
    const all = connectedItems(connections.data, servers.data, catalog.data.connectors);
    const latest = (list: ConnectedItem[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const item = connected?.startsWith("custom:")
      ? all.find((i) => i.custom && i.id === connected.slice("custom:".length))
      : connected
        ? latest(all.filter((i) => !i.custom && i.def?.id === connected))
        : latest(all.filter((i) => i.custom && i.needsReview));
    const done = outcome === "reconnected" || outcome === "same_account" ? outcome : "connected";
    // Signing in elsewhere ends here: say what happened, as connecting with a key does (a toast, or the confirmation).
    const confirms = admin && done === "connected";
    if (item && connected && !confirms) toast.show(outcomeText(t, done, item));
    // Only a new account gets the confirmation; "Ajustar" there names another account its provider didn't name.
    const url = item?.server?.serverUrl;
    const naming =
      Boolean(url && !item?.server?.accountLabel) &&
      all.filter((i) => i.server && url && sameServer(i.server.serverUrl, url)).length > 1;
    if (item && confirms) setFlow({ step: "done", item, naming });
    // GitHub comes straight back when nothing is left to ask: the dialog says what it reaches now and where to add more.
    if (item?.def?.id === "github" && admin && done === "reconnected")
      setFlow({ step: 0, def: item.def, mode: "reconnect", item });
    window.history.replaceState(null, "", window.location.pathname);
  }, [connected, outcome, review, connections.data, servers.data, catalog.data, listsFetching, admin, t, toast]);

  const row = (item: ConnectedItem) => (
    <ConnectedRow
      key={item.id}
      item={item}
      using={using(item)}
      total={agentList.length}
      admin={admin}
      onTools={() => setFlow({ step: 1, item })}
      onWho={() => setFlow({ step: 2, item })}
      onRename={() => setRenaming(item)}
      onReconnect={() => setFlow({ step: 0, def: item.def, mode: "reconnect", item })}
      onAddAccount={() => setFlow({ step: 0, def: item.def, mode: "add", item })}
      onDisconnect={() => setRemoving(item)}
    />
  );
  const loaded = connections.isSuccess && servers.isSuccess;
  const noneYet =
    loaded &&
    !mailAccounts.isLoading &&
    !databases.isLoading &&
    apps.length === 0 &&
    accounts.length === 0 &&
    dbList.length === 0;
  const look = useRightHandLook();

  return (
    <>
      <Card aria-labelledby="sec-conn">
        <CardHeader
          id="sec-conn"
          icon="plug"
          title={t("connectors.title")}
          action={
            // The empty state takes over this button: one way in, in the middle of the card.
            admin &&
            !noneYet && (
              <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
                {t("connectors.add")}
              </Button>
            )
          }
        />
        {composio.data && nearComposioLimit(composio.data) && (
          <p className="small muted">{composioUsageText(t, i18n.language, composio.data)}</p>
        )}
        {(connections.isLoading || servers.isLoading) && <LoadingList count={2} trailing />}
        {noneYet && (
          <EmptyState
            size="panel"
            agent={look}
            title={t(admin ? modeKey(org, "connectors.noneTitle") : "access.noConnectorsViewerTitle")}
            actions={
              admin && (
                <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
                  {t("connectors.add")}
                </Button>
              )
            }
          >
            {t(admin ? "connectors.none" : "access.noConnectorsViewer")}
          </EmptyState>
        )}
        {apps.length + accounts.length + dbList.length > 0 && (
          <List className="connected-list" aria-label={t("connectors.connectedList")}>
            {accounts.map((account) => (
              <MailRow
                key={`mail-${account.id}`}
                account={account}
                agents={agentList}
                admin={admin}
                onTools={() => setMailFlow({ step: 1, account })}
                onWho={() => setMailFlow({ step: 2, account })}
                onAddresses={() => setAddressesOf(account)}
                onReconnect={() => reconnect(account)}
                onDisconnect={() => setRemovingMail(account)}
              />
            ))}
            {dbList.map((connection) => (
              <DatabaseRow
                key={`db-${connection.id}`}
                connection={connection}
                agents={agentList}
                admin={admin}
                onTools={() => setDbFlow({ step: 1, connection })}
                onWho={() => setDbFlow({ step: 2, connection })}
                onReconnect={() => setReconnectingDb(connection)}
                onScope={() => setScopingDb(connection)}
                onDisconnect={() => setRemovingDb(connection)}
              />
            ))}
            {apps.map(row)}
          </List>
        )}
        <GitHubAppPanel
          onConnectAccount={() => {
            const github = defs.find((d) => d.id === "github");
            if (github) setFlow({ step: 0, def: github, account: true });
          }}
        />
      </Card>
      <GitHubAppServerCard />
      <Card aria-labelledby="sec-mcp">
        <CardHeader
          id="sec-mcp"
          icon="code"
          title={t("connectors.mcp.title")}
          action={
            // The page's one primary is Add connector above; a server by address is the second way in.
            admin && (
              <Button size="sm" icon="plus" onClick={() => setFlow({ step: 0, def: null })}>
                {t("connectors.mcp.add")}
              </Button>
            )
          }
        />
        {loaded && mcps.length === 0 && <p className="small muted">{t("connectors.mcp.none")}</p>}
        {mcps.length > 0 && (
          <List className="connected-list" aria-label={t("connectors.mcp.list")}>
            {mcps.map(row)}
          </List>
        )}

        <ConnectorCatalogDialog
          open={adding}
          onOpenChange={setAdding}
          connectors={defs}
          connected={connectedIds(items)}
          loading={catalog.isLoading}
          onPick={(def) => {
            setAdding(false);
            // Connected already: a server by address takes another account, a catalog connector a new sign-in. GitHub
            // through the agentes.chat app alone has no sign-in: it offers the app on another account, or an account.
            const item = items.find((i) => i.def?.id === def.id);
            setFlow(
              item && !item.viaGithubApp
                ? { step: 0, def, mode: item.custom ? "add" : "reconnect", item }
                : { step: 0, def },
            );
          }}
          onOther={() => {
            setAdding(false);
            setFlow({ step: 0, def: null });
          }}
          mail={{
            choices: mailChoices(mailProviders.data),
            connected: new Set(accounts.map(choiceOf)),
            onPick: (choice) => {
              setAdding(false);
              setMailFlow({ step: 0, choice });
            },
          }}
          database={{
            connected: dbList.length > 0,
            onPick: () => {
              setAdding(false);
              setDbFlow({ step: 0 });
            },
          }}
        />
        <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
        <MailConnectFlow flow={mailFlow} onChange={setMailFlow} onClose={() => setMailFlow(null)} />
        <MailReconnectDialog account={reconnecting} onClose={() => setReconnecting(null)} />
        <MailAddressesDialog account={addressesOf} onClose={() => setAddressesOf(null)} />
        <MailDisconnectDialog account={removingMail} onClose={() => setRemovingMail(null)} />
        <DatabaseConnectFlow flow={dbFlow} onChange={setDbFlow} onClose={() => setDbFlow(null)} />
        <DatabaseReconnectDialog connection={reconnectingDb} onClose={() => setReconnectingDb(null)} />
        <DatabaseScopeDialog connection={scopingDb} onClose={() => setScopingDb(null)} />
        <DatabaseDisconnectDialog connection={removingDb} onClose={() => setRemovingDb(null)} />
        <DisconnectDialog
          item={removing}
          using={removing ? using(removing).length : 0}
          onClose={() => setRemoving(null)}
        />
        <RenameDialog item={renaming} onClose={() => setRenaming(null)} />
      </Card>
    </>
  );
}

/**
 * One connected account: icon, name, state, account, who uses it, and what you can do (Quem usa, Ferramentas, and
 * in ⋯ Renomear, Reconectar, another account of an MCP server, Desconectar).
 */
function ConnectedRow({
  item,
  using,
  total,
  admin,
  onTools,
  onWho,
  onRename,
  onReconnect,
  onAddAccount,
  onDisconnect,
}: {
  item: ConnectedItem;
  using: Agent[];
  total: number;
  admin: boolean;
  onTools: () => void;
  onWho: () => void;
  onRename: () => void;
  onReconnect: () => void;
  onAddAccount: () => void;
  onDisconnect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const meta = [
    item.viaGithubApp && item.account
      ? appAccountsText(t, item.account)
      : item.account
        ? t("connectors.connectedAs", { account: item.account })
        : null,
    relativeTime(t, i18n.language, item.createdAt),
    t("connectors.toolsCount", { count: item.tools }),
  ].filter(Boolean);
  const adds = reconnectAddsText(t, item);
  return (
    <div className="ac-list__row connected-row ac-mediarow">
      <span className="ac-mediarow__face">
        <ConnectorIcon def={item.def} image={item.image} label={itemName(t, item)} />
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <span>{itemName(t, item)}</span>
          {item.needsReconnect ? (
            <Chip icon="alert" tone="waiting">
              {t("connectors.composio.needsReconnect")}
            </Chip>
          ) : item.toolsError ? (
            <Chip icon="alert" tone="waiting">
              {t("connectors.noToolsNow")}
            </Chip>
          ) : item.pending > 0 && item.server?.reviewedAt ? (
            <Chip icon="waiting" tone="waiting">
              {t("connectors.toReview", { count: item.pending })}
            </Chip>
          ) : item.needsReview ? (
            <Chip icon="waiting" tone="waiting">
              {t("connectors.notReviewed")}
            </Chip>
          ) : (
            <Chip icon="check" tone="done">
              {t("connectors.active")}
            </Chip>
          )}
        </span>
      </span>
      <div className="ac-mediarow__body">
        <span className="small muted">{meta.join(" · ")}</span>
        {adds && !item.needsReconnect && <span className="small muted">{adds}</span>}
        <span className="connected-row__who small muted">
          {using.length > 0 && (
            <AvatarStack>
              {using.slice(0, 5).map((a) => (
                <AgentAvatar key={a.id} agentId={a.id} name={a.name} size="xs" />
              ))}
            </AvatarStack>
          )}
          {using.length > 0 ? t("connectors.usedBy", { count: using.length, total }) : t("connectors.usedByNone")}
        </span>
        {admin && (
          <div className="connected-row__actions">
            {(item.needsReconnect || adds) && (
              <Button
                size="sm"
                variant="primary"
                aria-label={t("connectors.reconnectName", { name: itemName(t, item) })}
                onClick={onReconnect}
              >
                {t("connectors.detail.reconnect")}
              </Button>
            )}
            {item.needsReview && !item.needsReconnect && !adds && (
              <Button
                size="sm"
                variant="primary"
                aria-label={t("connectors.reviewName", { name: itemName(t, item) })}
                onClick={onTools}
              >
                {t("connectors.review")}
              </Button>
            )}
            <Button size="sm" aria-label={t("connectors.whoName", { name: itemName(t, item) })} onClick={onWho}>
              {t("connectors.who")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("connectors.toolsName", { name: itemName(t, item) })}
              onClick={onTools}
            >
              {t("connectors.tools")}
            </Button>
            <Menu
              align="end"
              label={t("connectors.actionsName", { name: itemName(t, item) })}
              trigger={
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="more"
                  aria-label={t("connectors.actionsName", { name: itemName(t, item) })}
                />
              }
            >
              <MenuItem icon="edit" onSelect={onRename}>
                {t("connectors.rename")}
              </MenuItem>
              {/* GitHub through the app alone has no sign-in to renew: its accounts are on GitHub's side. */}
              {!item.viaGithubApp && (
                <MenuItem icon="refresh" onSelect={onReconnect}>
                  {t("connectors.detail.reconnect")}
                </MenuItem>
              )}
              {item.custom && (
                <MenuItem icon="plus" onSelect={onAddAccount}>
                  {t("connectors.detail.addAccount")}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem icon="power" danger onSelect={onDisconnect}>
                {t("connectors.disconnect")}
              </MenuItem>
            </Menu>
          </div>
        )}
      </div>
    </div>
  );
}

/** "Renomear": the account's name, which people and agents tell it apart by (its tools keep their names). */
function RenameDialog({ item, onClose }: { item: ConnectedItem | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const rename = useRenameConnection(org.id);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const name = item ? itemName(t, item) : "";
  useEffect(() => {
    setLabel(item?.label ?? "");
    setError(null);
  }, [item]);
  const submit = () => {
    if (!item) return;
    const wanted = label.trim();
    if (!wanted || wanted === item.label) return onClose();
    rename.mutate(
      { id: item.id, label: wanted },
      {
        onSuccess: (saved) => {
          toast.show(t("connectors.renamed", { name: saved.label }));
          onClose();
        },
        onError: (failed) => setError(errorText(t, failed, i18n.language)),
      },
    );
  };
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.renameTitle", { name })}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={rename.isPending}>
          <DialogBody>
            <Field
              label={t("connectFlow.name")}
              id="connector-rename"
              hint={{ name: t("common.about", { label: t("connectFlow.name") }), text: t("connectors.renameHelp") }}
              error={error ?? undefined}
            >
              <Input
                value={label}
                maxLength={80}
                autoFocus
                onChange={(e) => {
                  setLabel(e.target.value);
                  setError(null);
                }}
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={rename.isPending} loading={rename.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Desconectar Linear?": always confirmed, whatever the kind. */
function DisconnectDialog({
  item,
  using,
  onClose,
}: {
  item: ConnectedItem | null;
  using: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const catalogDisconnect = useDisconnect(org.id);
  const { disconnect: customDisconnect } = useCustomServerAction(org.id);
  const pending = catalogDisconnect.isPending || customDisconnect.isPending;
  const name = item ? itemName(t, item) : "";
  // GitHub and the agentes.chat app: the app alone is uninstalled with it, an account goes and the app stays.
  const installations = useGitHubApp(org.id, item?.def?.id === "github").data?.installations ?? [];
  const githubNote = item ? githubDisconnectNote(t, item, installations) : null;
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("connectors.disconnectTitle", { name })}
      description={using > 0 ? t("connectors.disconnectText", { count: using }) : t("connectors.disconnectTextNone")}
      closeLabel={t("common.close")}
      width={440}
    >
      {item?.viaComposio && (
        <DialogBody>
          <p className="small muted">
            {t("connectors.composio.disconnectNote", { name: item.def ? connectorBrand(item.def) : name })}
          </p>
        </DialogBody>
      )}
      {githubNote && (
        <DialogBody>
          <p className="small muted">{githubNote}</p>
        </DialogBody>
      )}
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={pending}
          loading={pending}
          onClick={() => {
            if (!item) return;
            const done = {
              onSuccess: () => {
                // Agents lose the connection's grants.
                void qc.invalidateQueries({ queryKey: keys.access(org.id) });
                toast.show(
                  githubNote && !item.viaGithubApp ? t("githubApp.keptApp") : t("connectors.disconnected", { name }),
                );
                onClose();
              },
            };
            if (item.custom) customDisconnect.mutate(item.id, done);
            else catalogDisconnect.mutate(item.id, done);
          }}
        >
          {t("connectors.disconnect")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
