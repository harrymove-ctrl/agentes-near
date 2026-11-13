import { Button, Chip, Dialog, DialogBody, DialogFooter, Icon, Menu, MenuItem, Select, Switch } from "@agenteschat/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import {
  isHereServer,
  type KeepRunning,
  type LocalServerStatus,
  type ReachStage,
  type ServeProblem,
} from "../../control/local-server";
import {
  homeServer,
  type ServerKind,
  type ServerList,
  type ServerWorkspaces,
  serverKind,
  serverName,
} from "../../control/server";
import { pairedHomes } from "../../control/store";
import { useLocalServer, useOnShown, usePending, useTailnet } from "../../hooks";
import { OrgTile } from "../../ui/bits";
import { CopyDetails, ReachProblem, ReachProgress, ReachRow, ServerTile } from "../../ui/here";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { backupsFolder, clock, folderLabel, nightAt, shortPath } from "../../ui/time";

const KIND_SUB: Record<ServerKind, string> = {
  cloud: "desktop.servers.cloudSub",
  tailnet: "desktop.servers.ownTailnet",
  here: "desktop.servers.ownHere",
  own: "desktop.servers.ownSub",
};

/**
 * Preferences › Servers: where this app opens agentes.chat, each with its workspaces (ADR 0154). Each keeps its own
 * sign-in (cookies are per origin).
 */
export function Servers() {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const [list, setList] = useState<ServerList>({ current: null, servers: [] });
  const [spaces, setSpaces] = useState<ServerWorkspaces[]>([]);
  const local = useLocalServer();
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = () => {
    void host
      .servers()
      .then(setList)
      .catch(() => {});
    void host
      .workspaces()
      .then(setSpaces)
      .catch(() => {});
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: again when the server here's address moves
  useEffect(read, [host, local.publicUrl, local.run]);
  useOnShown("prefs", read);

  const homesOf = (server: string) => pairedHomes(snap).filter((h) => homeServer(h) === server);
  // The server here has its own card, above.
  const others = list.servers.filter((server) => !isHereServer(local, server));

  const open = async (server: string) => {
    await host.chooseServer(server).catch(() => toast(t("desktop.common.error"), "alert"));
    read();
  };

  const signOut = async (server: string) => {
    try {
      await host.signOutServer(server);
      toast(t("desktop.servers.signedOutDone", { host: serverName(server) }));
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
    read();
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      // Its organizations' agents stop working here; their folders stay, as when leaving one.
      for (const h of homesOf(removing)) {
        await store.request(h.homeId, { type: "unpair" }).catch(() => {});
        await store.removeHome(h.homeId);
      }
      await host.removeServer(removing);
      toast(t("desktop.servers.removed", { host: serverName(removing) }));
      setRemoving(null);
      read();
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PrefHead title={t("desktop.servers.title")} lead={t("desktop.servers.lead")} />
      {local.run && <HereServer local={local} current={list.current} />}
      {!local.run && local.installed === "app" && local.owner && <StoppedHere local={local} />}
      {others.length > 0 && (
        <>
          {local.run && <CardTitle>{t("desktop.servers.title")}</CardTitle>}
          <PrefCard>
            {others.map((server) => {
              const kind = serverKind(server);
              const now = server === list.current;
              const known = spaces.find((s) => s.server === server);
              const offline = known?.offlineSince !== undefined;
              const signedOut = known !== undefined && !known.signedIn && !offline;
              return (
                <PrefRow
                  key={server}
                  lead={<ServerTile kind={kind} />}
                  title={serverName(server)}
                  desc={
                    <>
                      {[t(KIND_SUB[kind]), known && workspacesLine(t, known)].filter(Boolean).join(" · ")}
                      {/* Its state as words in its color, never a pill (ADR 0158). */}
                      {offline && (
                        <span className="dk-state-waiting">
                          {" · "}
                          {t("desktop.servers.offline", {
                            time: clock(new Date(known?.offlineSince ?? Date.now()).toISOString(), i18n.language),
                          })}
                        </span>
                      )}
                    </>
                  }
                  under={
                    known?.signedIn && known.orgs.length > 1 ? (
                      <WorkspaceRows orgs={known.orgs} dim={offline} />
                    ) : undefined
                  }
                  end={
                    <>
                      {signedOut ? (
                        <Button size="sm" variant="primary" onClick={() => void open(server)}>
                          {t("desktop.servers.signIn")}
                        </Button>
                      ) : now ? (
                        <Chip icon="check" tone="done">
                          {t("desktop.servers.openNow")}
                        </Chip>
                      ) : (
                        <Button size="sm" onClick={() => void open(server)}>
                          {t("desktop.servers.open")}
                        </Button>
                      )}
                      <Menu
                        align="end"
                        label={t("desktop.servers.more", { host: serverName(server) })}
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon="more"
                            aria-label={t("desktop.servers.more", { host: serverName(server) })}
                          />
                        }
                      >
                        {known?.signedIn && (
                          <MenuItem icon="arrowRight" onSelect={() => void signOut(server)}>
                            {t("desktop.servers.signOut")}
                          </MenuItem>
                        )}
                        <MenuItem icon="trash" danger onSelect={() => setRemoving(server)}>
                          {t("desktop.servers.removeFromApp")}
                        </MenuItem>
                      </Menu>
                    </>
                  }
                />
              );
            })}
          </PrefCard>
        </>
      )}
      <div className="dk-under-card">
        <Button size="sm" icon="plus" onClick={() => void host.addWorkspace().catch(() => {})}>
          {t("desktop.servers.add")}
        </Button>
      </div>

      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && !busy && setRemoving(null)}
        title={t("desktop.servers.removeTitle", { host: removing ? serverName(removing) : "" })}
        description={
          <>
            {t("desktop.servers.removeBody")}
            {removing && homesOf(removing).length > 0 && <> {t("desktop.servers.removeAgents")}</>}
          </>
        }
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setRemoving(null)} disabled={busy}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {t("desktop.servers.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/** In a server's subtitle: its one workspace by name, "3 workspaces" (named in rows under it), or not signed in. */
function workspacesLine(t: (key: string, o?: Record<string, unknown>) => string, s: ServerWorkspaces) {
  if (!s.signedIn) return t("desktop.servers.signedOut");
  const [only] = s.orgs;
  return s.orgs.length === 1 && only ? only.name : t("desktop.servers.workspaces", { count: s.orgs.length });
}

/** A server's workspaces under its row, one line each with its logo and unread count; `dim` while it doesn't answer. */
function WorkspaceRows({ orgs, dim = false }: { orgs: ServerWorkspaces["orgs"]; dim?: boolean }) {
  return (
    <ul className="dk-ws-rows" data-dim={dim || undefined}>
      {orgs.map((o) => (
        <li key={o.id}>
          <OrgTile logo={o.logo} size="sm" />
          <span className="dk-ws-name">{o.name}</span>
          {o.unread > 0 && <span className="dk-ws-count">{o.unread}</span>}
        </li>
      ))}
    </ul>
  );
}

/** agentes.chat on this computer, stopped running here ("Stop running it here…"): its data stays, Start brings it back. */
function StoppedHere({ local }: { local: LocalServerStatus }) {
  const { t } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <PrefCard>
      <PrefRow
        lead={<ServerTile kind="here" />}
        title={t("desktop.server.title")}
        desc={t("desktop.server.notHere", { path: shortPath(local.dir) })}
        end={
          <Button
            size="sm"
            icon="play"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void host
                .startLocalServer()
                .catch(() => toast(t("desktop.common.error"), "alert"))
                .finally(() => setBusy(false));
            }}
          >
            {t("desktop.server.startHere")}
          </Button>
        }
      />
    </PrefCard>
  );
}

/**
 * agentes.chat on this computer (the app runs it): its state and address, reach from the person's other
 * devices (Tailscale) and the phone's QR code with it, the usage-statistics switch, the way to Jev's key, its
 * version, data and backups, Restart and Stop, and "Stop running it here…" (its data stays).
 */
function HereServer({ local, current }: { local: LocalServerStatus; current: string | null }) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const tailnet = useTailnet();
  const [reaching, setReaching] = useState(false);
  // What turning reach on or off is doing, said while it takes (Tailscale, its HTTPS page, the restart).
  const [stage, setStage] = useState<ReachStage | null>(null);
  const [reachProblem, setReachProblem] = useState<ServeProblem | null>(null);
  const [busy, run] = usePending<"restart" | "stop" | "start" | "usage" | "backup" | "restore">();
  const [stopping, setStopping] = useState(false);
  // Stop asks first (the phone and the team lose access), and how long; turning reach off asks too (ADR 0158).
  const [stopAsk, setStopAsk] = useState(false);
  const [reachOffAsk, setReachOffAsk] = useState(false);
  // The backup "Restore…" goes back to, while its sheet is open.
  const [restoring, setRestoring] = useState<string | null>(null);
  const [noPassword, setNoPassword] = useState(false);
  const address = local.publicUrl ?? local.url ?? "";
  const running = local.phase === "running";
  const up = running || local.phase === "starting" || local.phase === "updating";
  const { backups } = local;
  const backupTime = (at: number) => clock(new Date(at).toISOString(), i18n.language);
  const lastBackup = backups.files[0];
  const nightlyAt = clock(nightAt().toISOString(), i18n.language, nightAt());

  // The owner signs in on this computer without one (the app's one-time sign-in): elsewhere they need a password.
  useEffect(() => {
    if (!running || !address) return;
    let live = true;
    void host
      .siteFetch(address, "GET", "/api/app/me")
      .then((a) => {
        const me = a.status === 200 ? (JSON.parse(a.body) as { user?: { hasPassword?: boolean } }) : null;
        if (live) setNoPassword(me?.user?.hasPassword === false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host, address, running]);

  const setBackups = (nightly: boolean, copyTo: string | null) =>
    void host.setLocalBackups(nightly, copyTo).catch(() => toast(t("desktop.common.error"), "alert"));
  const chooseCopyTo = async () => {
    const dir = await host.pickFolder().catch(() => null);
    if (dir) setBackups(backups.nightly, dir);
  };
  const restore = (file: string) =>
    run("restore", async () => {
      try {
        await host.restoreLocalServer(file);
        const at = backups.files.find((f) => f.path === file)?.at;
        toast(t("desktop.server.restored", { time: at ? backupTime(at) : "" }), "check");
      } catch (e) {
        toast(t(e === "start" ? "desktop.server.restoreFailed" : "desktop.server.restoreUnreadable"), "alert");
      } finally {
        setRestoring(null);
      }
    });

  const act = (what: NonNullable<typeof busy>, action: () => Promise<unknown>) =>
    run(what, () => action().catch(() => toast(t("desktop.common.error"), "alert")));
  useEffect(() => host.onLocalReach(setStage), [host]);
  const reach = async (on: boolean) => {
    setReaching(true);
    setStage(null);
    setReachProblem(null);
    try {
      const result = await host.setLocalReach(on);
      // Stopped waiting by the person: nothing went wrong to say.
      if (!result.ok && result.problem.reason !== "stopped") setReachProblem(result.problem);
    } catch {
      toast(t("desktop.common.error"), "alert");
    } finally {
      setReaching(false);
    }
  };
  const chip =
    local.phase === "running" ? (
      <Chip icon="check" tone="done">
        {t("desktop.server.running")}
      </Chip>
    ) : (
      <Chip icon={local.phase === "failing" || local.phase === "stopped" ? "alert" : undefined} tone="waiting">
        {local.held
          ? local.heldUntil
            ? t("desktop.server.stoppedUntil", {
                time: clock(new Date(local.heldUntil).toISOString(), i18n.language),
              })
            : t("desktop.server.stoppedHeld")
          : t(`desktop.server.${local.phase === "off" ? "stopped" : local.phase}`)}
      </Chip>
    );

  return (
    <>
      <PrefCard>
        <PrefRow
          lead={<ServerTile kind="here" />}
          title={t("desktop.server.title")}
          desc={t(local.reach ? "desktop.servers.hereTailnet" : "desktop.servers.hereOnly")}
          end={chip}
        />
        <PrefRow
          title={t("desktop.server.address")}
          desc={<span className="dk-path">{address}</span>}
          end={
            current === address ? (
              <Chip icon="check" tone="done">
                {t("desktop.servers.openNow")}
              </Chip>
            ) : (
              <Button size="sm" disabled={!address} onClick={() => void host.chooseServer(address).catch(() => {})}>
                {t("desktop.servers.open")}
              </Button>
            )
          }
        />
        {noPassword && (
          <PrefRow
            desc={
              <span className="dk-honest ac-iconline">
                <Icon name="key" size={14} />
                {t("desktop.server.noPassword")}
              </span>
            }
            end={
              <Button size="sm" onClick={() => void host.openExternal(`${address}/?open=password`).catch(() => {})}>
                {t("desktop.server.addPassword")}
              </Button>
            }
          />
        )}
        {local.phase === "failing" && (
          <PrefRow
            desc={t("desktop.server.failingWhy")}
            end={
              <>
                <CopyDetails />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void host.revealFolder(logsFolder(local.dir)).catch(() => {})}
                >
                  {t("desktop.server.showLogs")}
                </Button>
              </>
            }
          />
        )}
        <ReachRow
          tailnet={tailnet}
          on={local.reach}
          busy={reaching || !running}
          onChange={(on) => (on ? void reach(true) : setReachOffAsk(true))}
        />
        {reaching && stage && <PrefRow desc={<ReachProgress stage={stage} />} />}
        {reachProblem && <PrefRow desc={<ReachProblem problem={reachProblem} text="prefs" />} />}
        <PrefRow
          title={t("desktop.server.phone")}
          desc={local.reach ? undefined : t("desktop.server.phoneOff")}
          end={
            <Button
              size="sm"
              icon="phone"
              disabled={!local.reach || !running}
              onClick={() => void host.openExternal(`${address}/?open=phone`).catch(() => {})}
            >
              {t("desktop.server.showQr")}
            </Button>
          }
        />
        <PrefRow
          title={t("desktop.here.usage")}
          hint={hintFor(
            t,
            t("desktop.here.usage"),
            t("common.joinSentences", { a: t("desktop.here.usageText"), b: t("desktop.server.usageRestart") }),
          )}
          htmlFor="here-usage-prefs"
          end={
            <Switch
              id="here-usage-prefs"
              aria-describedby="here-usage-prefs-hint"
              checked={local.usage}
              disabled={busy !== null}
              onCheckedChange={(on) => void act("usage", () => host.setLocalUsage(on))}
            />
          }
        />
        {/* Only the way there, no state: Jev's key is the server's, its owner sets it on the web, and the app has no
            session there to read it with. */}
        <PrefRow
          title={t("desktop.server.jev")}
          hint={hintFor(
            t,
            t("desktop.server.jev"),
            t("common.joinSentences", { a: t("desktop.server.jevText"), b: t("desktop.server.jevWhere") }),
          )}
          end={
            <Button
              size="sm"
              disabled={!running}
              onClick={() => void host.openExternal(`${address}/?open=jev`).catch(() => {})}
            >
              {t("desktop.servers.open")}
            </Button>
          }
        />
        {local.version && <PrefRow desc={t("desktop.server.version", { version: local.version })} />}
      </PrefCard>
      <CardTitle>{t("desktop.server.backups")}</CardTitle>
      <PrefCard>
        <PrefRow
          title={t("desktop.server.nightly")}
          htmlFor="here-nightly"
          desc={
            backups.problem === "backup" ? (
              <span className="dk-state-waiting">{t("desktop.server.backupFailed")}</span>
            ) : lastBackup ? (
              t(backups.nightly ? "desktop.server.nightlyLast" : "desktop.server.lastBackup", {
                at: nightlyAt,
                time: backupTime(lastBackup.at),
              })
            ) : backups.nightly ? (
              t("desktop.server.nightlyNone", { at: nightlyAt })
            ) : (
              t("desktop.server.noBackup")
            )
          }
          end={
            <Switch
              id="here-nightly"
              checked={backups.nightly}
              onCheckedChange={(on) => setBackups(on, backups.copyTo)}
            />
          }
        />
        <PrefRow
          title={t("desktop.server.copyTo")}
          hint={hintFor(t, t("desktop.server.copyTo"), t("desktop.server.copyToText"))}
          desc={
            backups.problem === "copy" ? (
              <span className="dk-state-waiting">{t("desktop.server.copyFailed")}</span>
            ) : backups.copyTo ? (
              <span className="dk-path">{folderLabel(backups.copyTo)}</span>
            ) : (
              t("desktop.server.copyToNone")
            )
          }
          end={
            <>
              {backups.copyTo && (
                <Button size="sm" variant="ghost" onClick={() => setBackups(backups.nightly, null)}>
                  {t("desktop.server.copyToStop")}
                </Button>
              )}
              <Button size="sm" icon="drive" onClick={() => void chooseCopyTo()}>
                {t(backups.copyTo ? "desktop.server.change" : "desktop.server.choose")}
              </Button>
            </>
          }
        />
        <PrefRow
          end={
            <>
              <Button
                size="sm"
                loading={busy === "backup"}
                disabled={!up || busy !== null}
                onClick={() =>
                  void act("backup", async () => {
                    const file = await host.backupLocalServer();
                    toast(t("desktop.server.backedUp", { file: shortPath(file) }), "check");
                  })
                }
              >
                {t("desktop.server.backup")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!lastBackup || busy !== null}
                onClick={() => setRestoring(lastBackup?.path ?? null)}
              >
                {t("desktop.server.restore")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void host.revealFolder(lastBackup ? backupsFolder(local.dir) : local.dir).catch(() => {})
                }
              >
                {host.platform === "mac" ? t("desktop.server.reveal") : t("desktop.server.revealFiles")}
              </Button>
            </>
          }
        />
      </PrefCard>
      <div className="dk-under-card dk-here__acts">
        {up ? (
          <>
            <Button
              size="sm"
              icon="refresh"
              loading={busy === "restart"}
              disabled={busy !== null}
              onClick={() => void act("restart", () => host.restartLocalServer())}
            >
              {t("desktop.server.restart")}
            </Button>
            <Button
              size="sm"
              icon="stop"
              loading={busy === "stop"}
              disabled={busy !== null}
              onClick={() => setStopAsk(true)}
            >
              {t("desktop.server.stop")}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon="play"
            loading={busy === "start"}
            onClick={() => void act("start", () => host.startLocalServer())}
          >
            {t("desktop.server.start")}
          </Button>
        )}
        <span className="dk-here__end">
          <Button size="sm" variant="ghost" className="dk-danger-text" onClick={() => setStopping(true)}>
            {t("desktop.server.stopHere")}
          </Button>
        </span>
      </div>
      <KeepItRunning awake={local.awake} />
      <Dialog
        open={restoring !== null}
        onOpenChange={(o) => !o && busy !== "restore" && setRestoring(null)}
        title={t("desktop.server.restoreTitle")}
        description={t("desktop.server.restoreBody")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogBody>
          <Select
            aria-label={t("desktop.server.restoreWhich")}
            value={restoring ?? undefined}
            onValueChange={setRestoring}
            disabled={busy === "restore"}
            options={backups.files.map((f) => ({
              value: f.path,
              label: t("desktop.server.backupOf", { time: backupTime(f.at) }),
            }))}
          />
        </DialogBody>
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setRestoring(null)} disabled={busy === "restore"}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="danger" loading={busy === "restore"} onClick={() => restoring && void restore(restoring)}>
            {t("desktop.server.restoreConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={stopAsk}
        onOpenChange={(o) => !o && busy !== "stop" && setStopAsk(false)}
        title={t("desktop.server.stopTitle")}
        description={t("desktop.server.stopBody")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setStopAsk(false)} disabled={busy === "stop"}>
            {t("desktop.common.cancel")}
          </Button>
          <Button
            disabled={busy === "stop"}
            onClick={() =>
              void act("stop", async () => {
                await host.stopLocalServer(false, 60);
                setStopAsk(false);
              })
            }
          >
            {t("desktop.server.stopFor1h")}
          </Button>
          <Button
            variant="danger"
            loading={busy === "stop"}
            onClick={() =>
              void act("stop", async () => {
                await host.stopLocalServer(false);
                setStopAsk(false);
              })
            }
          >
            {t("desktop.server.stopUntilStart")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={reachOffAsk}
        onOpenChange={(o) => !o && setReachOffAsk(false)}
        title={t("desktop.server.reachOffTitle")}
        description={t("common.joinSentences", {
          a: t("desktop.server.reachOffBody"),
          b: t("desktop.server.reachRestart"),
        })}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setReachOffAsk(false)}>
            {t("desktop.common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setReachOffAsk(false);
              void reach(false);
            }}
          >
            {t("desktop.server.reachOffConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={stopping}
        onOpenChange={(o) => !o && busy !== "stop" && setStopping(false)}
        title={t("desktop.server.stopHereTitle")}
        description={t("desktop.server.stopHereBody", { path: shortPath(local.dir) })}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" onClick={() => setStopping(false)} disabled={busy === "stop"}>
            {t("desktop.common.cancel")}
          </Button>
          <Button
            variant="danger"
            loading={busy === "stop"}
            onClick={() =>
              void act("stop", async () => {
                await host.stopLocalServer(true);
                setStopping(false);
              })
            }
          >
            {t("desktop.server.stopHereConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/**
 * What keeps the server here up while nobody is at this computer, each a green check or an amber dot with its way
 * there: the app opens at login, the Mac signs in by itself after a restart and starts after a power failure, and it
 * doesn't sleep while serving. Read again whenever the window comes back to the front (the person went to change one).
 * A row this system can't check isn't shown.
 */
function KeepItRunning({ awake }: { awake: boolean }) {
  const { t } = useTranslation();
  const host = useHost();
  const toast = useToast();
  const [login, setLogin] = useState<boolean | null>(null);
  const [keep, setKeep] = useState<KeepRunning>({ autoLogin: null, autoRestart: null });
  const read = useCallback(() => {
    void host
      .autostart()
      .then(setLogin)
      .catch(() => {});
    void host
      .keepRunning()
      .then(setKeep)
      .catch(() => {});
  }, [host]);
  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);
  useOnShown("prefs", read);
  const rows: { key: string; ok: boolean | null; title: string; hint?: string; fix?: ReactNode }[] = [
    {
      key: "login",
      ok: login,
      title: t("desktop.server.keepLogin"),
      fix: (
        <Button
          size="sm"
          onClick={() =>
            void host
              .setAutostart(true)
              .then(read)
              .catch(() => toast(t("desktop.common.error"), "alert"))
          }
        >
          {t("desktop.server.keepLoginOn")}
        </Button>
      ),
    },
    {
      key: "autoLogin",
      ok: keep.autoLogin,
      title: t("desktop.server.keepAutoLogin"),
      hint: t("desktop.server.keepAutoLoginText"),
      fix: (
        <Button size="sm" onClick={() => void host.openSystemSettings("users").catch(() => {})}>
          {t("desktop.server.keepAutoLoginOpen")}
        </Button>
      ),
    },
    {
      key: "power",
      ok: keep.autoRestart,
      title: t("desktop.server.keepPower"),
      hint: t("desktop.server.keepPowerText"),
      fix: (
        <Button size="sm" onClick={() => void host.openSystemSettings("energy").catch(() => {})}>
          {t("desktop.server.keepPowerOpen")}
        </Button>
      ),
    },
    {
      key: "awake",
      ok: host.platform === "mac" ? awake : null,
      title: t("desktop.server.keepAwake"),
      hint: t("desktop.server.keepAwakeText"),
    },
  ];
  const shown = rows.filter((r) => r.ok !== null);
  if (shown.length === 0) return null;
  return (
    <>
      <CardTitle>{t("desktop.server.keep")}</CardTitle>
      <PrefCard>
        {shown.map((r) => (
          <PrefRow
            key={r.key}
            lead={
              <span className="dk-keep" data-ok={r.ok || undefined}>
                {r.ok ? <Icon name="check" size={16} /> : <span className="dk-keep__dot" />}
                <span className="ac-visually-hidden">
                  {t(r.ok ? "desktop.server.keepOn" : "desktop.server.keepOff")}
                </span>
              </span>
            }
            title={r.title}
            hint={r.hint && !r.ok ? hintFor(t, r.title, r.hint) : undefined}
            end={r.ok ? undefined : r.fix}
          />
        ))}
      </PrefCard>
    </>
  );
}

/** Where the server here writes its log (`logs/server.log` in its folder), with the folder's own separator. */
const logsFolder = (dir: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}logs`;
