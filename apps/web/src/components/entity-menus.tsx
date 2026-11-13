import type { Agent, Channel } from "@agenteschat/client";
import {
  keys,
  useArchiveChannel,
  useDms,
  useMarkChannelRead,
  useMuteChannel,
  usePeople,
  useRoles,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can, leavesChannel, managesChannel } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { leaves, removes } from "@agenteschat/client/lib/roles";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useSidebarPins } from "@/hooks/useSidebarPins";
import { requestChannelDetails } from "@/lib/channel-details";
import { copyText, type MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { useLiveStore } from "@/realtime/context";
import { useOpenAgentPanel } from "./agent-panel-context";
import { useChannelActions } from "./channel-actions";
import { useLeaveChannelWithUndo } from "./LeaveChannelDialog";
import { useOrg } from "./org-context";
import { useRemoveMemberDialog } from "./RemoveMember";
import { isStoppable, useStopRun } from "./StopRun";

/*
 * One list of actions per entity, for its right click (`entityMenu`, lib/entity-menu.ts) and, where it has one, its
 * "…": a channel, an agent, a person. Each lists only what the app does and what the viewer may do.
 */

const linkTo = (path: string) => `${window.location.origin}${path}`;

/** An archived channel back as it was (the archive's Desfazer, Canais arquivados' Restaurar): it opens again. */
export function useRestoreChannel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  // The call's own promise, not a mutation's callbacks: Desfazer runs after the screen that archived it closed.
  const run = (channel: Pick<Channel, "id" | "name">, onDone?: () => void) => {
    setPending(true);
    void api.chat
      .unarchive(org.id, channel.id)
      .then(async () => {
        onDone?.();
        await qc.invalidateQueries({ queryKey: keys.channels(org.id) });
        toast.show(t("channel.restored", { channel: channel.name }));
        await navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: channel.id } });
      })
      .catch((e: unknown) => toast.show(errorText(t, e), "error"))
      .finally(() => setPending(false));
  };
  return { run, pending };
}

/** "Arquivar canal" with "Desfazer" in its toast; leaves the channel's page when it was open. */
export function useArchiveChannelWithUndo() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const router = useRouter();
  const archive = useArchiveChannel(org.id);
  const restore = useRestoreChannel();
  const run = (channel: Pick<Channel, "id" | "name">, onDone?: () => void) =>
    archive.mutate(channel.id, {
      onSuccess: () => {
        onDone?.();
        if (router.state.location.pathname.includes(`/c/${channel.id}`))
          void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
        toast.show(t("channel.archived", { channel: channel.name }), "info", {
          label: t("channelCategories.undo"),
          run: () => restore.run(channel),
        });
      },
      onError: (e) => toast.show(errorText(t, e), "error"),
    });
  return { run, pending: archive.isPending };
}

/** "Marcar como lida" for a channel or DM with unread messages (nothing otherwise). */
function useMarkRead() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const mark = useMarkChannelRead(org.id);
  return (channelId: string | undefined, unread: number): MenuEntry[] =>
    channelId && unread > 0
      ? [
          {
            kind: "item",
            id: "mark-read",
            label: t("contextMenu.markRead"),
            icon: "check",
            run: () => mark.mutate(channelId),
          },
        ]
      : [];
}

/** "Copiar @handle". */
function useCopyHandle() {
  const { t } = useTranslation();
  const toast = useToast();
  return (handle: string | undefined): MenuEntry[] =>
    handle
      ? [
          {
            kind: "item",
            id: "copy-handle",
            label: t("contextMenu.copyHandle", { handle }),
            icon: "copy",
            run: () => void copyText(`@${handle}`, () => toast.show(t("contextMenu.handleCopied"))),
          },
        ]
      : [];
}

/** "Copiar ID", last in its menu, as in Discord. */
function useCopyId() {
  const { t } = useTranslation();
  const toast = useToast();
  return (id: string): MenuEntry[] => [
    { kind: "separator" },
    {
      kind: "item",
      id: "copy-id",
      label: t("contextMenu.copyId"),
      icon: "copy",
      run: () => void copyText(id, () => toast.show(t("contextMenu.idCopied"))),
    },
  ];
}

/** "Mencionar": `@handle` in the composer, inside a conversation only. */
function useMention() {
  const { t } = useTranslation();
  const actions = useChannelActions();
  return (handle: string | undefined): MenuEntry[] =>
    actions && handle
      ? [
          {
            kind: "item",
            id: "mention",
            label: t("contextMenu.mention"),
            icon: "reply",
            run: () => actions.insertMention(handle),
          },
        ]
      : [];
}

/**
 * A channel (sidebar row, channel header): mark read, its details (edit for who manages it), `extra` (the sidebar's
 * Mover para… and Nova categoria), copy link, archive.
 */
export function useChannelMenu() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const markRead = useMarkRead();
  const mute = useMuteChannel(org.id);
  const archive = useArchiveChannelWithUndo();
  const leave = useLeaveChannelWithUndo();
  const pins = useSidebarPins();
  return (c: Channel, extra: MenuEntry[] = []): MenuEntry[] => {
    const manages = managesChannel(c, me.user.id, org);
    return [
      { kind: "header", label: `#${c.name}` },
      ...markRead(c.id, c.unreadCount ?? 0),
      // Muted, it never looks unread to me (a mention of me still counts).
      ...(c.isMember
        ? [
            {
              kind: "item" as const,
              id: "mute",
              label: c.muted ? t("contextMenu.unmuteChannel") : t("contextMenu.muteChannel"),
              icon: c.muted ? ("eye" as const) : ("eyeOff" as const),
              run: () =>
                mute.mutate(
                  { channelId: c.id, muted: !c.muted },
                  { onError: (e) => toast.show(errorText(t, e), "error") },
                ),
            },
          ]
        : []),
      {
        kind: "item",
        id: "edit",
        label: manages ? t("channelCategories.editChannel") : t("channel.details"),
        icon: manages ? "edit" : "info",
        run: () => {
          requestChannelDetails(c.id);
          void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId: c.id } });
        },
      },
      ...(c.isMember ? [pins.entry("channels", c.id)] : []),
      ...extra,
      { kind: "separator" },
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () => void copyText(linkTo(`/org/${org.id}/c/${c.id}`), () => toast.show(t("contextMenu.linkCopied"))),
      },
      ...(leavesChannel(c) || (manages && c.name !== "general") ? ([{ kind: "separator" }] satisfies MenuEntry[]) : []),
      ...(leavesChannel(c)
        ? ([
            { kind: "item", id: "leave", label: t("channel.leave"), icon: "arrowRight", run: () => leave.run(c) },
          ] satisfies MenuEntry[])
        : []),
      ...(manages && c.name !== "general"
        ? ([
            {
              kind: "item",
              id: "archive",
              label: t("channel.archive"),
              icon: "archive",
              danger: true,
              run: () => archive.run(c),
            },
          ] satisfies MenuEntry[])
        : []),
    ];
  };
}

/**
 * An agent (sidebar row, its face or name in a message, its card's ⋯): talk, its profile, its computer (`openComputer`,
 * where the caller knows this person may open it), mention, copy @, mark its DM read, edit (its owner and admins), its
 * link, stop while it works, its id.
 */
export function useAgentMenu() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const openPanel = useOpenAgentPanel();
  const live = useLiveStore();
  const runs = useStopRun();
  const dms = useDms(org.id).data;
  const markRead = useMarkRead();
  const copyHandle = useCopyHandle();
  const copyId = useCopyId();
  const mention = useMention();
  const pins = useSidebarPins();
  /** `extra`: the sidebar row's own items (Mudar de grupo), after Fixar no topo. */
  return (
    a: Pick<Agent, "id" | "name" | "handle" | "ownerUserId" | "builtin">,
    extra: MenuEntry[] = [],
    openComputer?: () => void,
  ): MenuEntry[] => {
    const dm = dms?.find((d) => d.with.id === a.id);
    const edits = can(org, "manage_agents") || a.ownerUserId === me.user.id;
    const working = Object.values(live.get().streams.runs).filter(
      (r) => r.agentId === a.id && isStoppable(r) && runs.canStop(r),
    );
    const page = (tab?: "settings") =>
      void navigate({
        to: "/org/$orgId/agents/$agentId",
        params: { orgId: org.id, agentId: a.id },
        search: tab ? { tab } : {},
      });
    return [
      { kind: "header", label: a.name },
      {
        kind: "item",
        id: "dm",
        label: t("profile.dm"),
        icon: "message",
        run: () => void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: a.id } }),
      },
      {
        kind: "item",
        id: "profile",
        label: t("profile.viewProfile"),
        icon: "agent",
        run: () => (openPanel ? openPanel(a.id) : page()),
      },
      ...(openComputer
        ? ([
            {
              kind: "item",
              id: "computer",
              label: t("contextMenu.openComputer"),
              icon: "computer",
              run: openComputer,
            },
          ] satisfies MenuEntry[])
        : []),
      // The right hand has its own row on top of the sidebar.
      ...(isRightHand(a) ? [] : [pins.entry("agents", a.id)]),
      ...mention(a.handle),
      ...copyHandle(a.handle),
      ...markRead(dm?.channelId, dm?.unread ?? 0),
      ...extra,
      { kind: "separator" },
      ...(edits
        ? ([
            { kind: "item", id: "edit", label: t("contextMenu.editAgent"), icon: "edit", run: () => page("settings") },
          ] satisfies MenuEntry[])
        : []),
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () =>
          void copyText(linkTo(`/org/${org.id}/dm/agent/${a.id}`), () => toast.show(t("contextMenu.linkCopied"))),
      },
      ...(working.length
        ? ([
            { kind: "separator" },
            {
              kind: "item",
              id: "stop",
              label: t("run.stopAgent", agentGrammar(a.name)),
              icon: "stop",
              danger: true,
              run: () => {
                for (const r of working) runs.stop(r);
              },
            },
          ] satisfies MenuEntry[])
        : []),
      ...copyId(a.id),
    ];
  };
}

/**
 * A person (sidebar row, Members, their face or name in a message, their card's ⋯): DM, their card (`openCard`),
 * mention, copy @, mark read, Remover do workspace for who may (Sair do workspace on one's own), their id.
 */
export function usePersonMenu() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const dms = useDms(org.id).data;
  const people = usePeople(org.id).data ?? [];
  const roles = useRoles(org.id).data?.roles ?? [];
  const remove = useRemoveMemberDialog();
  const markRead = useMarkRead();
  const copyHandle = useCopyHandle();
  const copyId = useCopyId();
  const mention = useMention();
  const pins = useSidebarPins();
  const viewer = { role: org.role, rank: org.rank, userId: me.user.id, permissions: org.permissions };
  return (p: { userId: string; name: string; handle?: string | null }, openCard?: () => void): MenuEntry[] => {
    const dm = dms?.find((d) => d.with.id === p.userId);
    const handle = p.handle ?? undefined;
    const mine = p.userId === me.user.id;
    const person = people.find((x) => x.userId === p.userId);
    const out = remove && person && (mine ? leaves(org, people) : removes(viewer, person, roles));
    return [
      { kind: "header", label: p.name },
      ...(p.userId !== me.user.id
        ? ([
            {
              kind: "item",
              id: "dm",
              label: t("profile.dm"),
              icon: "message",
              run: () =>
                void navigate({ to: "/org/$orgId/dm/person/$userId", params: { orgId: org.id, userId: p.userId } }),
            },
          ] satisfies MenuEntry[])
        : []),
      ...(openCard
        ? ([
            { kind: "item", id: "profile", label: t("profile.viewProfile"), icon: "person", run: openCard },
          ] satisfies MenuEntry[])
        : []),
      ...(mine ? [] : [pins.entry("people", p.userId)]),
      ...mention(handle),
      ...copyHandle(handle),
      ...markRead(dm?.channelId, dm?.unread ?? 0),
      ...(out
        ? ([
            { kind: "separator" },
            {
              kind: "item",
              id: "remove",
              label: mine ? t("members.remove.leave") : t("members.remove.item"),
              icon: mine ? "arrowRight" : "trash",
              danger: true,
              run: () => remove(p),
            },
          ] satisfies MenuEntry[])
        : []),
      ...copyId(p.userId),
    ];
  };
}
