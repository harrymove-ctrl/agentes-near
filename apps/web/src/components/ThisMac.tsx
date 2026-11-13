import { useConfirmDevice, useMe } from "@agenteschat/client";
import { Button, SettingNote } from "@agenteschat/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { desktopRevealsFiles, inDesktopApp, thisMac } from "@/lib/desktop";
import { useToast } from "@/lib/toast";

/**
 * This computer, in the agentes.chat desktop app (ADR 0036, ADR 0066): the site knows which of its
 * organizations the computer it runs on works for, pairs it in one click (the app asks the person in its
 * own dialog, then hands the runner's code to the site, which confirms it with the person's session; no code
 * to read) and opens the app's Preferences where access is granted. agentes.chat included (ADR 0165). Outside the
 * app, and where this computer is set up with a server of its own (a loopback address, the server the app runs
 * here), nothing.
 */
const THIS_MAC_KEY = ["desktop", "thisMac"] as const;
/** Ask again this often while the runner picks up its token after the site confirmed. */
const CONNECTING_POLL_MS = 2000;

/** This Mac in `orgId`: its machine there, or null when it isn't connected to it. Off outside the app. */
export function useThisMac(orgId: string, connecting = false) {
  return useQuery({
    queryKey: THIS_MAC_KEY,
    queryFn: thisMac.status,
    enabled: inDesktopApp(),
    refetchInterval: connecting ? CONNECTING_POLL_MS : false,
    refetchOnWindowFocus: true,
    select: (s) => s.orgs.find((o) => o.orgId === orgId && o.connection !== "refused") ?? null,
    meta: { quiet: true },
  });
}

/** Is `machineId` the Mac this app runs on? */
export function useIsThisMac(orgId: string, machineId: string) {
  return useThisMac(orgId).data?.machineId === machineId;
}

/**
 * Whether agents may work on this computer for this server, agentes.chat included; false until the app says so
 * (apps from before it said nothing, and allowed it everywhere).
 */
export function useAgentsHere(): boolean {
  const here = useQuery({
    queryKey: THIS_MAC_KEY,
    queryFn: thisMac.status,
    enabled: inDesktopApp(),
    select: (s) => s.agentsHere !== false,
    meta: { quiet: true },
  });
  return inDesktopApp() && here.data === true;
}

/** "Show the folder": in an app that opens it (`desktopRevealsFiles`), on the server it runs on this computer. */
export function useRevealsFiles(): boolean {
  const local = useQuery({
    queryKey: THIS_MAC_KEY,
    queryFn: thisMac.status,
    enabled: desktopRevealsFiles(),
    select: (s) => s.local === true,
    meta: { quiet: true },
  });
  return desktopRevealsFiles() && local.data === true;
}

/** An organization's name, for the app's own dialog before it pairs this computer. */
export function useOrgName(orgId: string): string | undefined {
  return useMe().data?.organizations.find((o) => o.id === orgId)?.name;
}

/**
 * "Usar este Mac" (one click), or, once connected, "Pastas deste Mac" (`folders: false` hides it).
 * `canPair`: may connect a computer. `onConnected`: the new machine, e.g. to pick it right away.
 */
export function ThisMacButton({
  orgId,
  canPair,
  primary = false,
  folders = true,
  onConnected,
}: {
  orgId: string;
  canPair: boolean;
  primary?: boolean;
  folders?: boolean;
  onConnected?: (machineId: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirmDevice();
  const [connecting, setConnecting] = useState(false);
  const mine = useThisMac(orgId, connecting);
  const agentsHere = useAgentsHere();
  const orgName = useOrgName(orgId);
  const connected = Boolean(mine.data);

  const machineId = mine.data?.machineId ?? null;
  useEffect(() => {
    if (!connecting || !connected) return;
    setConnecting(false);
    toast.show(t("machines.thisMac.connected"));
    if (machineId) onConnected?.(machineId);
  }, [connecting, connected, machineId, onConnected, toast, t]);

  if (!agentsHere || mine.isLoading) return null;
  if (connected) {
    if (!folders) return null;
    return (
      <Button size="sm" icon="drive" onClick={() => void thisMac.openPrefs("folders").catch(() => {})}>
        {t("machines.thisMac.folders")}
      </Button>
    );
  }
  if (!canPair) return null;

  const start = async () => {
    setConnecting(true);
    try {
      const { userCode } = await thisMac.connect(orgId, orgName);
      if (userCode) await confirm.mutateAsync({ orgId, userCode });
      void qc.invalidateQueries({ queryKey: THIS_MAC_KEY });
    } catch {
      setConnecting(false);
      toast.show(t("machines.thisMac.failed"), "error");
    }
  };
  return (
    <Button
      size="sm"
      variant={primary ? "primary" : "default"}
      icon="computer"
      loading={connecting}
      onClick={() => void start()}
    >
      {t("machines.thisMac.connect")}
    </Button>
  );
}

/** "Abrir no app": Preferences on `tab`, for what is decided on this Mac itself (folders, tools, updates). */
export function OpenPrefsButton({ tab, children }: { tab: "folders" | "tools" | "updates"; children: string }) {
  return (
    <Button
      size="sm"
      icon={tab === "updates" ? "download" : "settings"}
      onClick={() => void thisMac.openPrefs(tab).catch(() => {})}
    >
      {children}
    </Button>
  );
}

/** A tool switched off in this very Mac's Preferences, and the way there to turn it on. */
export function ToolsOffHereNote() {
  const { t } = useTranslation();
  return (
    <SettingNote icon="settings">
      {t("machines.thisMac.toolsOff")}
      <span style={{ display: "block", marginTop: "var(--space-2)" }}>
        <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
      </span>
    </SettingNote>
  );
}

/** "Reconectar": this Mac's connection to `orgId` again (the menu bar's "Reconectar"). */
export function ReconnectThisMacButton({ orgId, primary = false }: { orgId: string; primary?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const reconnect = async () => {
    setBusy(true);
    try {
      await thisMac.reconnect(orgId);
      toast.show(t("machines.thisMac.reconnecting"));
      void qc.invalidateQueries({ queryKey: THIS_MAC_KEY });
    } catch {
      toast.show(t("machines.thisMac.failed"), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant={primary ? "primary" : "default"}
      icon="refresh"
      loading={busy}
      onClick={() => void reconnect()}
    >
      {t("machines.thisMac.reconnect")}
    </Button>
  );
}

/** "Ver no app": the menu bar's popover, where this Mac answers access requests. */
export function ShowRequestsButton() {
  const { t } = useTranslation();
  return (
    <Button size="sm" icon="computer" onClick={() => void thisMac.showRequests().catch(() => {})}>
      {t("machines.thisMac.seeRequest")}
    </Button>
  );
}
