import type { Machine, MachineAccessReduce, MachinePause, MachineToolName } from "@agenteschat/client";
import {
  profilesApply,
  useAgents,
  useAuthConfig,
  useDesktopStatus,
  useHostComputer,
  useHostComputerOn,
  useMachineAction,
  useMachines,
  useReduceMachineAccess,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt, joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  allowedFolders,
  allowsInApp,
  canReduceAccess,
  computerKind,
  computerState,
  folderName,
  hostDescKey,
  isPaused,
  MACHINE_TOOLS,
  machineTitle,
  sharedFolderFacts,
  sharedFolderOf,
} from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import {
  AvatarStack,
  Button,
  Card,
  CardHeader,
  Chip,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  InfoHint,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  MenuSeparator,
  ProviderLogo,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOpenComputer } from "@/components/computer/open";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { OpenPrefsButton, ToolsOffHereNote, useIsThisMac } from "@/components/ThisMac";
import { useToast } from "@/lib/toast";
import { BrowserProfilesCard } from "./browser/BrowserProfiles";
import { MachineBrowserCard } from "./browser/MachineBrowserCard";
import { Egress } from "./computer/Egress";
import { MachineDesktopUseCard } from "./desktop/MachineDesktopUseCard";
import { CommandBlock, MachineChip, osOf } from "./machine-bits";
import { ComputerTitle, SetupFacts, useSetupView } from "./WorkspaceComputer";

/** "Pausado até 16:24" (another day: "Pausado até 18 out 09:00"), "Pausado"; null when not paused now. */
export function pauseText(t: TFunction, locale: string, paused: MachinePause | null | undefined, now = new Date()) {
  if (!isPaused({ paused }, now.getTime())) return null;
  const until = paused?.until;
  if (!until) return t("machines.paused");
  return t("machines.pausedUntil", { time: clockAt(locale, until, now) });
}

/** The pause the owner set on the machine (ADR 0036 §6), as a chip with an icon. */
export function PausedChip({ paused }: { paused: MachinePause | null | undefined }) {
  const { t, i18n } = useTranslation();
  const text = pauseText(t, i18n.language, paused);
  if (!text) return null;
  return (
    <Chip icon="pause" className="machine-chip">
      {text}
    </Chip>
  );
}

function seenText(t: TFunction, locale: string, m: Machine) {
  return m.online
    ? t("machines.seenNow")
    : m.lastSeenAt
      ? t("machines.seen", { when: relativeTime(t, locale, m.lastSeenAt) })
      : t("machines.neverSeen");
}

function MachineMenu({
  machine: m,
  onRename,
  onRemove,
}: {
  machine: Machine;
  onRename: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = t("machines.actions", { name: m.name });
  return (
    <Menu
      align="end"
      label={label}
      trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} />}
    >
      <MenuItem icon="edit" onSelect={onRename}>
        {t("machines.rename")}
      </MenuItem>
      {/* The workspace's own computer stays: people rename it, never remove it. */}
      {m.kind !== "managed" && (
        <>
          <MenuSeparator />
          <MenuItem icon={m.kind === "host" ? "block" : "trash"} danger onSelect={onRemove}>
            {m.kind === "host" ? t("machines.host.stop") : t("machines.remove")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function MachineRow({
  machine: m,
  onRename,
  onRemove,
}: {
  machine: Machine;
  onRename: () => void;
  onRemove: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const facts = [
    t(`machines.os.${osOf(m.os)}`),
    m.runnerVersion ? t("machines.versionShort", { version: m.runnerVersion }) : null,
    seenText(t, i18n.language, m),
    m.pairedBy ? t("machines.pairedBy", { name: m.pairedBy.name }) : null,
  ].filter(Boolean);
  return (
    <div className="ac-list__row machine-row ac-mediarow">
      <span className="machine-row__pic ac-mediarow__face">
        <ComputerPortrait kind={computerKind(m.os)} state={computerState(m)} />
      </span>
      <span className="ac-mediarow__head">
        <span className="list-title">
          <Link
            to="/org/$orgId/settings/devices/$deviceId"
            params={{ orgId: org.id, deviceId: m.id }}
            className="machine-row__name"
            aria-label={t("machines.open", { name: machineTitle(m, t("machines.host.label")) })}
          >
            {machineTitle(m, t("machines.host.label"))}
          </Link>
          {m.kind === "host" && m.name && <Chip icon="computer">{t("machines.host.label")}</Chip>}
          <MachineChip online={m.online} />
          <PausedChip paused={m.paused} />
          {!m.execAllowed && <Chip icon="block">{t("machines.execOff")}</Chip>}
        </span>
      </span>
      <span className="ac-mediarow__body small muted">
        {m.kind === "host" ? t(`machines.host.${hostDescKey(m.os)}`) : facts.join(" · ")}
      </span>
      <span className="ac-mediarow__end">
        <span className="machine-row__agents">
          {m.agents.length > 0 ? (
            <span
              className="row"
              style={{ gap: 4 }}
              title={t("machines.usedBy", {
                names: joinNames(
                  m.agents.map((a) => a.name),
                  t,
                ),
              })}
            >
              {m.agents.slice(0, 4).map((a) => (
                <AgentAvatar key={a.id} agentId={a.id} size="sm" name={a.name} />
              ))}
            </span>
          ) : (
            <span className="small muted">{t("machines.noAgents")}</span>
          )}
        </span>
        {m.canManage && <MachineMenu machine={m} onRename={onRename} onRemove={onRemove} />}
      </span>
    </div>
  );
}

/** The server's computer an admin stopped in this organization, and the way back. */
function HostOffRow() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const turnOn = useHostComputerOn(org.id);
  return (
    <div className="ac-list__row machine-row ac-mediarow">
      <span className="machine-row__pic ac-mediarow__face">
        <ComputerPortrait kind="linux" state="offline" />
      </span>
      <span className="ac-mediarow__head">
        <b className="list-title machine-row__name">{t("machines.host.label")}</b>
      </span>
      <span className="ac-mediarow__body small muted">{t("machines.host.offText")}</span>
      {can(org, "configure") && (
        <span className="ac-mediarow__end ac-mediarow__end--wrap">
          <Button
            size="sm"
            loading={turnOn.isPending}
            disabled={turnOn.isPending}
            onClick={() =>
              turnOn.mutate(undefined, {
                onSuccess: () => toast.show(t("machines.host.used")),
                onError: (err) => toast.show(errorText(t, err), "error"),
              })
            }
          >
            {t("machines.host.use")}
          </Button>
        </span>
      )}
    </div>
  );
}

function RenameDialog({ machine, onClose }: { machine: Machine | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useMachineAction(org.id);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(machine?.name ?? "");
    setError(null);
  }, [machine]);
  const clean = name.trim();
  return (
    <Dialog
      open={machine !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("machines.renameTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!machine || !clean) return;
          action.mutate(
            { machineId: machine.id, action: "rename", name: clean },
            {
              onSuccess: () => {
                toast.show(t("machines.renamed", { name: clean }));
                onClose();
              },
              onError: (err) => setError(errorText(t, err)),
            },
          );
        }}
      >
        <Locked when={action.isPending}>
          <DialogBody>
            <Field label={t("machines.name")} id="machine-rename" error={error ?? undefined}>
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!clean || action.isPending} loading={action.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  machine,
  onClose,
  onRemoved,
}: {
  machine: Machine | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useMachineAction(org.id);
  const host = machine?.kind === "host";
  return (
    <Dialog
      open={machine !== null}
      onOpenChange={(o) => !o && onClose()}
      title={host ? t("machines.host.stopTitle") : t("machines.removeTitle", { name: machine?.name ?? "" })}
      description={host ? t("machines.host.stopText") : t("machines.removeText")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          loading={action.isPending}
          disabled={action.isPending}
          onClick={() => {
            if (!machine) return;
            const name = machine.name;
            action.mutate(
              { machineId: machine.id, action: "remove" },
              {
                onSuccess: () => {
                  toast.show(host ? t("machines.host.stopped") : t("machines.removed", { name }));
                  onClose();
                  onRemoved?.();
                },
                onError: (err) => toast.show(errorText(t, err), "error"),
              },
            );
          }}
        >
          {host ? t("machines.host.stop") : t("machines.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * Configurações → Computadores, first: this server's computer (`HOST_COMPUTER_TOKEN`), the machine agentes.chat
 * is installed on. An admin who stopped it here can use it again; with none, admins read how to make it one,
 * but only while sign-up is closed (with open sign-up the server refuses one).
 */
export function HostComputerCard({ onlyOff = false }: { onlyOff?: boolean } = {}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const machines = useMachines(org.id);
  const host = useHostComputer(org.id);
  const auth = useAuthConfig();
  const [renaming, setRenaming] = useState<Machine | null>(null);
  const [removing, setRemoving] = useState<Machine | null>(null);
  const m = (machines.data ?? []).find((x) => x.kind === "host");
  const off = host.data?.on === false;
  const missing = host.isSuccess && host.data === null && can(org, "configure") && auth.data?.signupOpen === false;
  // The Devices list shows it when it's there: this card says only that it was stopped, or how to make one.
  if ((!m && !off && !missing) || (onlyOff && m)) return null;
  return (
    <Card aria-labelledby="sec-host-computer">
      <h2 id="sec-host-computer" className="ac-visually-hidden">
        {t("machines.host.label")}
      </h2>
      {m ? (
        <List className="machine-list" aria-label={t("machines.host.label")}>
          <MachineRow machine={m} onRename={() => setRenaming(m)} onRemove={() => setRemoving(m)} />
        </List>
      ) : off ? (
        <List className="machine-list" aria-label={t("machines.host.label")}>
          <HostOffRow />
        </List>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          <Trans
            i18nKey="computers.hostMissing"
            components={{ guide: <HelpLink slug="install-on-a-server" section="computers" /> }}
          />
        </p>
      )}
      <RenameDialog machine={renaming} onClose={() => setRenaming(null)} />
      <RemoveDialog machine={removing} onClose={() => setRemoving(null)} />
    </Card>
  );
}

// ── The computer page (Configurações → Computadores → one computer) ──────────

type Reduce =
  | { kind: "folder"; path: string; agent?: { id: string; name: string } }
  | { kind: "tool"; tool: MachineToolName | "browser" };

/** Confirm before taking something away; granting it back only happens on the machine. */
function ReduceDialog({ machine, reduce, onClose }: { machine: Machine; reduce: Reduce | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const mutation = useReduceMachineAccess(org.id);
  let title = "";
  let text = "";
  let done = "";
  let input: MachineAccessReduce = {};
  if (reduce?.kind === "folder") {
    const folder = folderName(reduce.path);
    if (reduce.agent) {
      const values = { folder, name: reduce.agent.name };
      [title, text, done] = [
        t("machines.access.removeAgentTitle", values),
        t("machines.access.removeAgentText", values),
        t("machines.access.removedAgent", values),
      ];
      input = { removeFolder: { path: reduce.path, agentId: reduce.agent.id } };
    } else {
      [title, text, done] = [
        t("machines.access.removeTitle", { folder }),
        t("machines.access.removeText"),
        t("machines.access.removed", { folder }),
      ];
      input = { removeFolder: { path: reduce.path } };
    }
  } else if (reduce?.kind === "tool") {
    const tool = t(`machines.access.tool.${reduce.tool}`);
    [title, text, done] = [
      t("machines.access.disableTitle", { tool }),
      t("machines.access.disableText", { tool }),
      t("machines.access.disabled", { tool }),
    ];
    input = { disableTool: reduce.tool };
  }
  return (
    <Dialog
      open={reduce !== null}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={text}
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
            mutation.mutate(
              { machineId: machine.id, ...input },
              {
                onSuccess: () => {
                  toast.show(done);
                  onClose();
                },
                onError: (err) => toast.show(errorText(t, err), "error"),
              },
            )
          }
        >
          {reduce?.kind === "tool" ? t("machines.access.disable") : t("machines.access.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Pastas liberadas: each folder, which agents use it, and (for the owner) Remover. */
function FoldersCard({ machine: m, onReduce }: { machine: Machine; onReduce: (r: Reduce) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const agents = useAgents(org.id);
  const nameOf = (id: string) =>
    agents.data?.find((a) => a.id === id)?.name ?? m.agents.find((a) => a.id === id)?.name ?? "";
  const access = m.access;
  const shared = sharedFolderOf(access);
  const folders = allowedFolders(access);
  // This very Mac with an app too old to report: update it from here (agentes for Mac, ADR 0036).
  const here = useIsThisMac(org.id, m.id);
  return (
    <Card aria-labelledby="sec-machine-folders">
      <CardHeader id="sec-machine-folders" icon="drive" title={t("machines.access.folders")} />
      {!access && m.canManage && here ? (
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <p className="small muted" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            {t("machines.thisMac.noReport")}
          </p>
          <OpenPrefsButton tab="updates">{t("machines.thisMac.update")}</OpenPrefsButton>
        </div>
      ) : !access ? (
        // The server only shows the folders to admins and whoever connected it.
        <p className="small muted" style={{ margin: 0 }}>
          {m.canManage ? t("machines.access.noReport") : t("machines.access.hidden")}
        </p>
      ) : (
        <List aria-label={t("machines.access.folders")}>
          <div className="ac-list__row machine-folder">
            <span className="machine-row__icon">
              <Icon name="lock" />
            </span>
            <span className="list-col" style={{ flex: "1 1 220px", minWidth: 0 }}>
              <span className="machine-folder__name">{t("machines.access.ownFolder")}</span>
              <span className="small muted">{t("machines.access.ownFolderText")}</span>
            </span>
          </div>
          {shared && (
            <div className="ac-list__row machine-folder" data-shared-folder>
              <span className="machine-row__icon">
                <Icon name="members" />
              </span>
              <span className="list-col" style={{ flex: "1 1 220px", minWidth: 0 }}>
                <span className="machine-folder__name">{t("machines.shared.title")}</span>
                <span className="small muted">{t("machines.shared.text")}</span>
                <code className="machine-folder__path">{shared}</code>
                <span className="small muted">{sharedFolderFacts(t, i18n.language, m.disk)}</span>
              </span>
            </div>
          )}
          {folders.length === 0 && (
            <div className="ac-list__row machine-folder">
              <span className="small muted">{t("machines.access.noFolders")}</span>
            </div>
          )}
          {folders.map((f) => {
            const folder = folderName(f.path);
            const label = t("machines.access.folderActions", { folder });
            return (
              <div key={f.path} className="ac-list__row machine-folder" data-folder={f.path}>
                <span className="machine-row__icon">
                  <Icon name="drive" />
                </span>
                <span className="list-col" style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <span className="machine-folder__name">{folder}</span>
                  <code className="machine-folder__path">{f.path}</code>
                </span>
                <span className="machine-folder__tail ac-captail">
                  {f.agents.length > 0 ? (
                    <span className="machine-folder__agents">
                      <span className="ac-visually-hidden">
                        {t("machines.access.usedBy", { folder })}: {joinNames(f.agents.map(nameOf), t)}
                      </span>
                      <AvatarStack aria-hidden="true">
                        {f.agents.map((id) => (
                          <AgentAvatar key={id} agentId={id} size="sm" name={nameOf(id)} />
                        ))}
                      </AvatarStack>
                    </span>
                  ) : (
                    <span className="small muted">{t("machines.access.nobody")}</span>
                  )}
                  {canReduceAccess(m) && (
                    <Menu
                      align="end"
                      label={label}
                      trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} />}
                    >
                      <MenuItem icon="trash" danger onSelect={() => onReduce({ kind: "folder", path: f.path })}>
                        {t("machines.access.removeAll")}
                      </MenuItem>
                      {f.agents.length > 0 && <MenuSeparator />}
                      {f.agents.map((id) => (
                        <MenuItem
                          key={id}
                          icon="close"
                          onSelect={() => onReduce({ kind: "folder", path: f.path, agent: { id, name: nameOf(id) } })}
                        >
                          {t("machines.access.removeAgent", { name: nameOf(id) })}
                        </MenuItem>
                      ))}
                    </Menu>
                  )}
                </span>
              </div>
            );
          })}
        </List>
      )}
    </Card>
  );
}

/** Ferramentas: on/off chips; the owner can turn one off (never on), except on the workspace's own computer. */
function ToolsCard({ machine: m, onReduce }: { machine: Machine; onReduce: (r: Reduce) => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // The site only turns a tool off. Turning one on happens in this Mac's app (ADR 0036).
  const here = useIsThisMac(org.id, m.id);
  const access = m.access;
  if (!access) return null;
  const isOn = (tool: (typeof MACHINE_TOOLS)[number]) =>
    tool === "cursor" || tool === "opencode" || tool === "grok" || tool === "antigravity"
      ? (access.tools[tool] ?? access.tools.codex)
      : access.tools[tool];
  return (
    <Card aria-labelledby="sec-machine-tools">
      <CardHeader id="sec-machine-tools" icon="cog" title={t("machines.access.tools")} />
      <List className="machine-list" aria-label={t("machines.access.tools")}>
        {MACHINE_TOOLS.map((tool) => {
          const on = isOn(tool);
          const name = t(`machines.access.tool.${tool}`);
          // Commands, on, has a line under its name: the name rises to its tile's top and its state stays on the
          // name's line. A name alone centres on the tile, its state with it.
          const warn = tool === "commands" && on;
          return (
            <div key={tool} className="ac-list__row machine-tool ac-mediarow ac-mediarow--row" data-tool={tool}>
              <span className="ac-mediarow__face">
                {tool === "commands" ? (
                  <span className="newag__ib">
                    <Icon name="code" size={16} />
                  </span>
                ) : (
                  <ProviderLogo id={tool} size="sm" off={!on} />
                )}
              </span>
              <span className="ac-mediarow__head">
                <span className="ac-hintline">
                  <span className="machine-folder__name">{name}</span>
                  <InfoHint name={t("common.about", { label: name })}>{t(`machines.access.toolText.${tool}`)}</InfoHint>
                </span>
              </span>
              {warn && <span className="ac-mediarow__body small muted">{t("machines.access.commandsWarn")}</span>}
              <span className="machine-tool__tail ac-mediarow__end ac-mediarow__end--wrap">
                <Chip icon={on ? "check" : "dash"}>{on ? t("machines.access.on") : t("machines.access.off")}</Chip>
                {on && canReduceAccess(m) && (
                  <Button
                    size="sm"
                    aria-label={t("machines.access.disableLabel", { tool: name })}
                    onClick={() => onReduce({ kind: "tool", tool })}
                  >
                    {t("machines.access.disable")}
                  </Button>
                )}
              </span>
            </div>
          );
        })}
      </List>
      {here && !MACHINE_TOOLS.every(isOn) && <ToolsOffHereNote />}
    </Card>
  );
}

/** Never a grant button: granting happens on the machine (the app, or the command as a fallback). */
function GrantCard({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // In the app, on this very Mac: straight to Preferences → Pastas (ADR 0036).
  const here = useIsThisMac(org.id, m.id);
  const path = t("machines.access.pathPlaceholder");
  const agent = t("machines.access.agentPlaceholder");
  // In system mode the runner's settings are root's (ADR 0057): allowing takes the computer's administrator.
  const system = m.mode === "system";
  const allowExample = `${system ? "sudo " : ""}agentes-runner folders allow ${path} --agent ${agent}`;
  const app = allowsInApp(m.os);
  return (
    <Card aria-labelledby="sec-machine-grant">
      <CardHeader id="sec-machine-grant" icon="lock" title={t("machines.access.grantTitle")} />
      {m.canManage && here ? (
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <p className="small" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            {t("machines.thisMac.grantHere")}
          </p>
          <OpenPrefsButton tab="folders">{t("machines.thisMac.openFolders")}</OpenPrefsButton>
        </div>
      ) : m.canManage ? (
        <>
          <p className="small" style={{ margin: 0 }}>
            {app
              ? t("machines.access.grantText")
              : system
                ? t("machines.access.grantTextAdmin")
                : t("machines.access.grantTextTerminal")}
          </p>
          {app && <span className="small muted">{t("machines.access.grantTerminal")}</span>}
          <CommandBlock command={allowExample} />
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          {m.pairedBy
            ? t("machines.access.grantOnlyOwner", { name: m.pairedBy.name })
            : t("machines.page.readOnlyNobody")}
        </p>
      )}
    </Card>
  );
}

/**
 * Open beside each agent on a computer's page: the agent's computer in its dialog, in place. Only for whoever may
 * watch it (its screen's state answers them; anyone else gets a 403), as on the agent's page.
 */
function OpenComputerButton({ agentId, name }: { agentId: string; name: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const openComputer = useOpenComputer();
  if (!useDesktopStatus(org.id, agentId).isSuccess) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="computer"
      className="machine-page__screen"
      aria-label={`${t("agentComputer.open")}: ${t("agentComputer.title", agentGrammar(name))}`}
      onClick={() => openComputer(agentId)}
    >
      {t("agentComputer.open")}
    </Button>
  );
}

/**
 * The agents working on a computer: each to its page, what it may use there beyond its own folder, and Open beside it
 * for whoever may watch its computer. Nothing while none works there.
 */
export function MachineAgents({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const managed = m.kind === "managed";
  if (m.agents.length === 0) return null;
  return (
    <div className="stack-4" style={{ gap: 6 }}>
      <span className="newag__label">{t("machines.page.agents")}</span>
      <div className="machine-page__agents">
        {m.agents.map((a) => {
          // What this agent may use here, beyond its own folder (only who may see the access knows).
          const folders = m.access?.folders.filter((f) => f.agents.includes(a.id)).map((f) => folderName(f.path));
          return (
            <div key={a.id} className="machine-page__agent-row">
              <Link
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId: a.id }}
                className="machine-page__agent ac-mediarow"
              >
                <span className="ac-mediarow__face">
                  <AgentAvatar agentId={a.id} size="md" name={a.name} />
                </span>
                <span className="ac-mediarow__head machine-page__agent-name">
                  <b>{a.name}</b>
                  <span className="ac-mediarow__meta">@{a.handle}</span>
                </span>
                <span className="ac-mediarow__end">
                  <Icon name="chevronRight" />
                </span>
                {/* On the workspace's own computer, each agent's own folder is its name's ⓘ. */}
                {folders && (folders.length > 0 || !managed) && (
                  <span className="ac-mediarow__body small muted">
                    {folders.length > 0
                      ? t("machines.page.agentFolders", {
                          ...agentGrammar(a.name),
                          folders: joinNames(folders, t),
                        })
                      : t("machines.page.agentOwnFolder", agentGrammar(a.name))}
                  </span>
                )}
              </Link>
              <OpenComputerButton agentId={a.id} name={a.name} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What a connected computer's own page adds under its facts: its egress, and the folder it was connected from. */
export function MachineFactsExtra({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  return (
    <>
      <Egress machine={m} />
      {m.workspace && m.mode !== "system" && (
        <span className="small muted machine-row__workspace">
          {t("machines.workspace")} <code>{m.workspace}</code>
        </span>
      )}
    </>
  );
}

/**
 * What a connected computer allows (its folders and which agents use each, its tools, its browser and desktop use)
 * and how to grant more, with the confirmation before taking anything away. Under its device page's own cards.
 */
export function MachineAccessCards({ machine: m }: { machine: Machine }) {
  const [reduce, setReduce] = useState<Reduce | null>(null);
  return (
    <>
      <FoldersCard machine={m} onReduce={setReduce} />
      <ToolsCard machine={m} onReduce={setReduce} />
      <MachineBrowserCard machine={m} onTurnOff={() => setReduce({ kind: "tool", tool: "browser" })} />
      {profilesApply(m) && <BrowserProfilesCard machine={m} />}
      <MachineDesktopUseCard machine={m} />
      <GrantCard machine={m} />
      <ReduceDialog machine={m} reduce={reduce} onClose={() => setReduce(null)} />
    </>
  );
}

/**
 * One connected computer: its state (online, paused), the folders it allows and which
 * agents use each, its tools. The site only shows and reduces; the admins and
 * whoever connected it reduce, everyone else reads.
 */
export function MachinePage({ machineId }: { machineId: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const machines = useMachines(org.id);
  const [renaming, setRenaming] = useState<Machine | null>(null);
  const [removing, setRemoving] = useState<Machine | null>(null);
  const setup = useSetupView(org.id);
  const m = machines.data?.find((x) => x.id === machineId);
  const back = (
    <Button asChild size="sm" variant="ghost" className="machine-page__back">
      <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "devices" }} search={{}}>
        <Icon name="chevronLeft" />
        {t("devices.back")}
      </Link>
    </Button>
  );
  if (machines.isLoading) return <LoadingList count={2} trailing />;
  if (machines.isError && !machines.data)
    return <ErrorState error={machines.error} onRetry={() => void machines.refetch()} />;
  if (!m) {
    return (
      <>
        {back}
        <Card>
          <EmptyState icon="computer" title={t("machines.page.notFound")}>
            {t("machines.page.notFoundText")}
          </EmptyState>
        </Card>
      </>
    );
  }
  const paused = isPaused(m);
  // The workspace's own computer (ADR 0056 §10): its size and one user per agent, never its system or folder.
  const managed = m.kind === "managed";
  const title = machineTitle(m, t("machines.host.label"));
  const heading = (
    <h2 id="sec-machine" className="ac-card__title">
      {title}
    </h2>
  );
  return (
    <>
      {back}
      <Card aria-labelledby="sec-machine">
        <div className="row machine-page__head">
          <ComputerPortrait
            className="machine-page__icon"
            kind={computerKind(m.os)}
            state={computerState(m)}
            size={96}
          />
          <span className="list-col machine-page__title">
            {managed ? <ComputerTitle name={title}>{heading}</ComputerTitle> : heading}
            <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {m.kind === "host" && m.name && <Chip icon="computer">{t("machines.host.label")}</Chip>}
              <MachineChip online={m.online} />
              <PausedChip paused={m.paused} />
              {m.pairedBy && <Chip icon="person">{t("machines.pairedBy", { name: m.pairedBy.name })}</Chip>}
            </span>
          </span>
          {m.canManage && <MachineMenu machine={m} onRename={() => setRenaming(m)} onRemove={() => setRemoving(m)} />}
        </div>
        <div className="machine-page__facts">
          {m.kind === "host" && <span className="small">{t(`machines.host.${hostDescKey(m.os)}`)}</span>}
          {managed ? (
            <>
              {setup && <SetupFacts view={setup} />}
              {!m.online && <span className="small muted">{seenText(t, i18n.language, m)}</span>}
            </>
          ) : (
            <span className="small muted">
              {t("machines.details", {
                os: t(`machines.os.${osOf(m.os)}`),
                arch: m.arch,
                version: m.runnerVersion,
                seen: seenText(t, i18n.language, m),
              })}
            </span>
          )}
          <Egress machine={m} />
          {paused && <span className="small muted">{t("machines.pausedHint")}</span>}
          {/* System mode: each agent works in its own home, never in the folder the computer was connected from. */}
          {m.mode === "system" && !managed && m.kind !== "host" && (
            <span className="small muted">{t("machines.agentUsers")}</span>
          )}
          {m.workspace && m.mode !== "system" && (
            <span className="small muted machine-row__workspace">
              {t("machines.workspace")} <code>{m.workspace}</code>
            </span>
          )}
        </div>
        <MachineAgents machine={m} />
      </Card>
      {/* Nobody in the workspace changes what its own computer allows, admins included. */}
      {!m.canManage && !managed && (
        <p className="page__note">
          {m.pairedBy ? t("machines.page.readOnly", { name: m.pairedBy.name }) : t("machines.page.readOnlyNobody")}
        </p>
      )}
      {managed ? (
        <p className="page__note">
          <HelpLink slug="workspace-computer">{t("computers.about")}</HelpLink>
        </p>
      ) : (
        <MachineAccessCards machine={m} />
      )}
      <RenameDialog machine={renaming} onClose={() => setRenaming(null)} />
      <RemoveDialog
        machine={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() =>
          void navigate({
            to: "/org/$orgId/settings/$section",
            params: { orgId: org.id, section: "devices" },
            search: {},
          })
        }
      />
    </>
  );
}
