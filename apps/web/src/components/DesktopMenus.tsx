import { useNotificationCount } from "@agenteschat/client";
import { workspaceLabel, workspaceNotes } from "@agenteschat/client/lib/deletion";
import { MenuAt, MenuHeading, MenuItem, MenuReactions, MenuSeparator } from "@agenteschat/ui";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NEW_AGENT_EVENT } from "@/components/new-agent/NewAgentDialog";
import {
  copyText,
  keepsSystemMenu,
  type MenuEntry,
  type OpenMenu,
  openContextMenu,
  selectedTextAt,
  setMenuHost,
} from "@/lib/context-menu";
import { inDesktopApp, thisMac } from "@/lib/desktop";
import { useToast } from "@/lib/toast";
import { openPalette } from "./CommandMenu";
import { useOrg } from "./org-context";
import { NEW_CHANNEL_EVENT, toggleSidebar } from "./Sidebar";

/**
 * The right click: draws our menu when a screen opens one (a message, a channel). In the desktop app links and empty
 * space get theirs too; in the browser they keep the browser's menu. Typing and selected text keep the system's menu.
 */
export function ContextMenuHost() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<OpenMenu | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    setMenuHost(setOpen);
    return () => setMenuHost(null);
  }, []);

  useEffect(() => {
    if (!inDesktopApp()) return;
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || keepsSystemMenu(e.target)) return;
      const selected = selectedTextAt(e.target);
      const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      const entries: MenuEntry[] = selected ? selectionEntries(selected) : link ? linkEntries(link) : pageEntries();
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, entries, e.target);
    };
    const selectionEntries = (text: string): MenuEntry[] => [
      {
        kind: "item",
        id: "copy",
        label: t("contextMenu.copy"),
        icon: "copy",
        run: () => void copyText(text, () => toast.show(t("contextMenu.textCopied"))),
      },
    ];
    const linkEntries = (link: HTMLAnchorElement): MenuEntry[] => {
      const url = new URL(link.href, window.location.href);
      const here = url.origin === window.location.origin;
      // What the link says on screen ("Wiki", a page's title); a site elsewhere by its name. Never a path or id.
      const name = here ? linkName(link) : url.host.replace(/^www\./, "");
      return [
        ...(name ? [{ kind: "header", label: name } satisfies MenuEntry] : []),
        here
          ? { kind: "item", id: "open", label: t("contextMenu.open"), icon: "arrowRight", run: () => link.click() }
          : {
              kind: "item",
              id: "open",
              label: t("contextMenu.openInBrowser"),
              icon: "external",
              // A new window: the app sends it to the browser (main_window.rs).
              run: () => window.open(url.href, "_blank", "noopener"),
            },
        {
          kind: "item",
          id: "copy-link",
          label: t("contextMenu.copyLink"),
          icon: "link",
          run: () => void copyText(url.href, () => toast.show(t("contextMenu.linkCopied"))),
        },
      ];
    };
    const pageEntries = (): MenuEntry[] => [
      { kind: "item", id: "back", label: t("contextMenu.back"), icon: "chevronLeft", run: () => router.history.back() },
      {
        kind: "item",
        id: "forward",
        label: t("contextMenu.forward"),
        icon: "chevronRight",
        run: () => router.history.forward(),
      },
      { kind: "item", id: "reload", label: t("contextMenu.reload"), icon: "refresh", run: () => location.reload() },
      ...(window.location.pathname.startsWith("/org/")
        ? ([
            { kind: "separator" },
            { kind: "item", id: "search", label: t("contextMenu.search"), icon: "search", run: openPalette },
          ] satisfies MenuEntry[])
        : []),
    ];
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [t, router, toast]);

  if (!open) return null;
  return (
    <MenuAt key={open.key} at={open} onClose={close} label={t("contextMenu.label")}>
      <MenuEntries entries={open.entries} onRun={close} />
    </MenuAt>
  );
}

/** Entries as our menu's items: the desktop app's right click, and a message's menu on touch. */
export function MenuEntries({ entries, onRun }: { entries: MenuEntry[]; onRun?: () => void }) {
  const run = (fn: () => void) => () => {
    onRun?.();
    fn();
  };
  return entries.map((e, i) => {
    const key = e.kind === "item" ? e.id : `${e.kind}-${i}`;
    if (e.kind === "separator") return <MenuSeparator key={key} />;
    if (e.kind === "header") return <MenuHeading key={key}>{e.label}</MenuHeading>;
    if (e.kind === "reactions") {
      const { pick, more } = e;
      return (
        <MenuReactions
          key={key}
          label={e.label}
          emojis={e.emojis}
          onPick={(emoji) => run(() => pick(emoji))()}
          more={more && { label: more.label, onSelect: run(more.run) }}
        />
      );
    }
    return (
      <MenuItem key={key} icon={e.icon} danger={e.danger} disabled={e.disabled} onSelect={run(e.run)}>
        {e.label}
      </MenuItem>
    );
  });
}

/** A link's name as people see it (its label or text), short; empty when it has none. */
function linkName(link: HTMLAnchorElement): string {
  const name = (link.getAttribute("aria-label") || link.textContent || link.title || "").replace(/\s+/g, " ").trim();
  return name.length > 48 ? `${name.slice(0, 47)}…` : name;
}

/** The site's own keys for menu bar items: when both fire, the menu's echo is dropped. */
const OWN_KEYS: Record<string, string> = { k: "search", "[": "back", "]": "forward" };
const ECHO_MS = 400;

/**
 * The Mac's menu bar choices that are the site's (menus.rs `SITE_ACTIONS`): the app calls
 * `window.__agentesMenu(action)`. Mounted in the workspace, where they make sense.
 */
export function MenuBarActions({ orgId }: { orgId: string }) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  useEffect(() => {
    const keyed = new Map<string, number>();
    const onKey = (e: KeyboardEvent) => {
      const action = e.metaKey ? OWN_KEYS[e.key.toLowerCase()] : undefined;
      if (action) keyed.set(action, performance.now());
    };
    const to = (path: string) => () => router.history.push(path);
    const org = `/org/${orgId}`;
    const actions: Record<string, () => void> = {
      newChannel: () => window.dispatchEvent(new Event(NEW_CHANNEL_EVENT)),
      // The new agent's dialog, over whatever is open (ADR 0164).
      newAgent: () => window.dispatchEvent(new Event(NEW_AGENT_EVENT)),
      search: openPalette,
      back: () => router.history.back(),
      forward: () => router.history.forward(),
      toggleSidebar,
      goHome: to(org),
      goWaiting: to(`${org}/notifications`),
      goTasks: to(`${org}/issues`),
      goWiki: to(`${org}/wiki`),
      goDrive: to(`${org}/drive`),
      orgSettings: to(`${org}/settings`),
    };
    const w = window as { __agentesMenu?: (action: string, arg?: string) => void };
    w.__agentesMenu = (action, arg) => {
      // Go → an organization (⌘⌥1–9).
      if (action === "org" && arg) return router.history.push(`/org/${encodeURIComponent(arg)}`);
      if (performance.now() - (keyed.get(action) ?? -Infinity) < ECHO_MS) return;
      actions[action]?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      delete w.__agentesMenu;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [router, orgId]);

  // The Go menu lists the person's organizations.
  const { me } = useOrg();
  const notes = workspaceNotes(t, i18n.language, me.organizations);
  const orgList = me.organizations.map((o) => ({ id: o.id, name: workspaceLabel(o.name, notes.get(o.id)) }));
  const orgsKey = JSON.stringify(orgList);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is sent when its content changes
  useEffect(() => {
    void thisMac.orgs(orgList).catch(() => {});
  }, [orgsKey]);

  // The Dock's badge: what waits on the person in this organization (a dot for unread only).
  const counts = useNotificationCount(orgId).data;
  const waiting = counts?.waiting ?? 0;
  const unread = counts?.unread ?? 0;
  useEffect(() => {
    void thisMac.badge(waiting, unread).catch(() => {});
  }, [waiting, unread]);
  useEffect(() => () => void thisMac.badge(0, 0).catch(() => {}), []);
  return null;
}
