import type { AgentAction, Message } from "@agenteschat/client";
import { ApiError, useApi } from "@agenteschat/client";
import { actionCardOf } from "@agenteschat/client/lib/action-cards";
import {
  actionErrorKey,
  hookToCopy,
  type ReceiptRow,
  receiptLines,
  receiptPieces,
  receiptRows,
  receiptTip,
  receiptUnder,
} from "@agenteschat/client/lib/actions";
import { relativeTime, toYmd } from "@agenteschat/client/lib/format";
import { handedTasksOf } from "@agenteschat/client/lib/issues";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { cx, HOVERLESS, Icon, type IconName, Popover, useMatchMedia } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { useChannelActions } from "@/components/channel-actions";
import { useInPlace } from "@/components/InPlace";
import { useDirectory } from "@/hooks/useDirectory";
import { copyText } from "@/lib/context-menu";
import { inPlaceClick } from "@/lib/navigate";
import { fromApiRule, ruleSentence } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import { DetailsLink } from "./details-link";
import { useOrg } from "./org-context";
import "./agent-actions.css";

/**
 * What an agent changed with this reply (ADR 0037 round 2), under the message. One change: a quiet row (A). Several:
 * "3 mudanças · há 1 min" and a row each, those of one kind said once ("Criei as tarefas #58, #59 e #60") (B). Every
 * row and every line under it is one line, cut with "…": its whole words are its tip, and on a touch screen a tap on
 * its words lists each change whole. The bold target opens the thing itself, where it is fixed or removed. One undone
 * elsewhere stays as history: struck through, "Desfeito por …".
 */
export function AgentActionReceipts({ message }: { message: Message }) {
  // The right hand's settings card says what was applied and has its own Desfazer (ADR 0137).
  const cardKind = actionCardOf(message.meta)?.kind;
  const onCard = cardKind === "settings_proposal";
  // A task the right hand handed on is its chip (`HandedTaskChips`): its agent is at work on it already.
  const handed = new Set(handedTasksOf(message.meta).map((h) => h.issueId));
  const list = (message.actions ?? []).filter(
    (a) =>
      !(onCard && a.kind === "agent.settings_changed") &&
      // A workspace change's card says what was applied and has its own Desfazer, as a settings card does.
      !(cardKind === "workspace_action" && a.kind === "workspace.changed") &&
      !(a.kind === "issue.created" && handed.has(a.target.id)),
  );
  if (message.author.type !== "agent" || list.length === 0) return null;
  return <Receipts message={message} list={list} />;
}

export const RECEIPT_ICONS: Record<AgentAction["kind"], IconName> = {
  "issue.created": "issues",
  "issue.updated": "issues",
  "issue.assigned": "person",
  "memory.saved": "book",
  "memory.updated": "book",
  "memory.forgotten": "book",
  "routine.created": "routines",
  "routine.updated": "routines",
  "routine.deleted": "routines",
  "channel.agent_added": "channel",
  "channel.created": "channel",
  "wiki.page_created": "page",
  "wiki.page_edited": "page",
  "thread.renamed": "thread",
  "thread.closed": "thread",
  "skill.created": "book",
  "skill.updated": "book",
  "agent.settings_changed": "settings",
  "pr.merged": "repo",
  "workspace.changed": "settings",
};

/** A kind a newer server sends that this build doesn't know yet gets the plain check. */
const iconOf = ({ actions: [a], refs }: ReceiptRow): IconName =>
  !refs && a?.kind === "issue.updated" && Array.isArray(a.params.fields) && a.params.fields.join() === "priority"
    ? "flag"
    : ((a && RECEIPT_ICONS[a.kind]) ?? "check");

/** A memory's words in its row, opening that memory: a link in the sentence's own weight. */
const WORDS_LINK = { className: "ag-rc__target ag-rc__target--words", plain: true } as const;

function errorMessage(t: TFunction, error: unknown) {
  const generic = t("agentActions.errors.generic");
  return error instanceof ApiError ? t(actionErrorKey(error.code), { defaultValue: generic }) : generic;
}

function Receipts({ message, list }: { message: Message; list: AgentAction[] }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);

  const byName = (a: AgentAction) =>
    a.undoneByUserId === me.user.id
      ? t("agentActions.you")
      : (dir.memberById.get(a.undoneByUserId ?? "")?.name ?? t("agentActions.someone"));
  const rows = receiptRows(list, t, me.user.id);
  const row = (r: ReceiptRow, single: boolean) => {
    const a = r.actions[0] as AgentAction;
    return <Receipt key={a.id} row={r} single={single} undoneBy={a.undoneAt ? byName(a) : null} label={label} />;
  };

  const agentName = dir.agentById.get(message.author.id ?? "")?.name ?? dir.authorName(message.author);
  const label = t("agentActions.group", { name: agentName });
  if (list.length === 1) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
      <div className="ag-rcs" role="group" aria-label={label}>
        {rows.map((r) => row(r, true))}
      </div>
    );
  }
  const first = list.reduce((min, a) => (a.createdAt < min ? a.createdAt : min), list[0]?.createdAt ?? "");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ag-rcg" role="group" aria-label={label}>
      <div className="ag-rcg__hd">
        <span>
          <b>{t("agentActions.changes", { count: list.length })}</b> · {relativeTime(t, i18n.language, first)}
        </span>
      </div>
      {rows.map((r) => row(r, false))}
    </div>
  );
}

function Receipt({
  row,
  single,
  undoneBy,
  label,
}: {
  row: ReceiptRow;
  single: boolean;
  undoneBy: string | null;
  /** The receipts' name ("Mudanças de Ada"), the list's on a touch screen. */
  label: string;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  // A screen with no hover shows no tip: a tap on the words lists each change whole instead.
  const touch = useMatchMedia(HOVERLESS);
  const [listed, setListed] = useState(false);
  const a = row.actions[0] as AgentAction;
  // A routine's schedule from its rule, in the person's language (the server's words are English).
  const words: Parameters<typeof receiptPieces>[3] = {
    schedule: (rule) => ruleSentence(t, i18n.language, fromApiRule(rule, toYmd(new Date())), new Date()),
  };
  const struck = Boolean(a.undoneAt);
  const lines = receiptUnder(row, t, undoneBy);
  const under = [lines.files, lines.own, lines.undone].filter((line): line is string => line !== null);
  const sentence = (
    <span
      className="ag-rc__sentence ag-rc__line"
      title={touch ? undefined : receiptTip(row, t, me.user.id, words)}
      // On a screen with no hover the words are the list's button: reached with Tab, opened with Enter or Space.
      {...(touch
        ? {
            role: "button",
            tabIndex: 0,
            onKeyDown: (e: KeyboardEvent) => {
              // A link inside the words keeps its own Enter.
              if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
              e.preventDefault();
              setListed(true);
            },
          }
        : {})}
    >
      {receiptPieces(row, t, me.user.id, words).map((p, i) =>
        p.opens ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one sentence, in order
          <ReceiptTarget key={i} action={p.opens} {...(p.bold ? null : WORDS_LINK)}>
            {p.text}
          </ReceiptTarget>
        ) : p.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: same
          <b key={i}>{p.text}</b>
        ) : (
          p.text
        ),
      )}
    </span>
  );
  return (
    <div className={cx(single ? "ag-rc" : "ag-rcg__it", struck && "is-undone")}>
      {single ? (
        <span className="ag-rc__ic" aria-hidden="true">
          <Icon name={iconOf(row)} size={16} />
        </span>
      ) : (
        <Icon name={iconOf(row)} size={14} className="ag-rcg__ic" />
      )}
      <span className="ag-rc__tx">
        {touch ? (
          <Popover
            label={label}
            trigger={sentence}
            side="top"
            align="start"
            className="ag-rcpop-card"
            open={listed}
            onOpenChange={setListed}
          >
            <div className="ac-popover__title">{label}</div>
            {receiptLines(row, t, me.user.id, words).map((l) => (
              // What a line opens (a task's dialog, the memory beside the conversation) takes the list's place.
              // biome-ignore lint/a11y/useKeyWithClickEvents: the link inside is the keyboard's way, this only closes the list
              // biome-ignore lint/a11y/noStaticElementInteractions: same
              <div key={l.action.id} className="ac-popover__row ag-rcpop" onClick={() => setListed(false)}>
                <ReceiptTarget
                  action={l.action}
                  className="ag-rcpop__words"
                  plain
                  cue={<Icon name="chevronRight" size={14} className="ag-rcpop__cue" />}
                >
                  <span className="ag-rcpop__text">{l.text}</span>
                </ReceiptTarget>
                {l.files && <span className="ag-rcpop__by">{l.files}</span>}
              </div>
            ))}
            {[lines.own, lines.undone]
              .flatMap((line) => (line ? [line] : []))
              .map((line) => (
                <div key={line} className="ac-popover__row ag-rcpop">
                  <span className="ag-rcpop__by">{line}</span>
                </div>
              ))}
          </Popover>
        ) : (
          sentence
        )}
        {under.map((line) => (
          <span key={line} className="ag-rc__by ag-rc__line" title={touch ? undefined : line}>
            {line}
          </span>
        ))}
        {!row.refs && <CopyHookButton action={a} />}
      </span>
    </div>
  );
}

/**
 * A webhook routine the agent just made: its address, a secret kept out of the message text, is copied from here by
 * who may manage the routine (the person who asked, admins; the server checks again).
 */
function CopyHookButton({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const routineId = hookToCopy(a, { userId: me.user.id, managesRoutines: can(org, "manage_routines") });
  if (!routineId) return null;
  const copy = async () => {
    setBusy(true);
    try {
      const hook = await api.routines.hook(org.id, routineId);
      await copyText(hook.url, () => toast.show(t("routines.webhookCopied")));
    } catch (error) {
      toast.show(errorMessage(t, error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ag-rc__extra">
      <button type="button" className="ag-rc__btn" disabled={busy} onClick={() => void copy()}>
        <Icon name="copy" size={14} />
        {t("agentActions.copyWebhook")}
      </button>
    </span>
  );
}

/**
 * The bold target in the sentence opens the thing itself, where it is fixed or removed: the issue, the routine, the
 * wiki page, the channel, the thread, the memory, the skill. In a conversation the task and the routine open in their
 * dialog over it, the thread and the memory in the panel beside it; the link still goes to their page (a new tab, a
 * middle click).
 */
function ReceiptTarget({
  action: a,
  children,
  className = "ag-rc__target",
  plain = false,
  cue,
}: {
  action: AgentAction;
  children?: ReactNode;
  className?: string;
  /** With nothing to open, the words as they are (a change's whole sentence), not in bold. */
  plain?: boolean;
  /** After the words, only when they open something (the list's chevron). */
  cue?: ReactNode;
}) {
  const { org } = useOrg();
  const orgId = org.id;
  const managesAgents = can(org, "manage_agents");
  const inPlace = useInPlace();
  // The right hand's page has no Memória: its memory opens as its own page.
  const rightHand = isRightHand(useDirectory(orgId).agentById.get(a.agentId));
  const openPanel = useOpenAgentPanel();
  const openThread = useChannelActions()?.openThread;
  const tg = a.target;
  if (tg.type === "issue" && tg.number != null) {
    const number = tg.number;
    return (
      <Link
        to="/org/$orgId/issues/$number"
        params={{ orgId, number: String(number) }}
        className={className}
        onClick={inPlace ? (e) => inPlaceClick(e, () => inPlace.issue(number)) : undefined}
      >
        {children}
        {cue}
      </Link>
    );
  }
  if (tg.type === "routine")
    return (
      <DetailsLink item={{ kind: "routine", id: tg.id }} className={className}>
        {children}
        {cue}
      </DetailsLink>
    );
  if (tg.type === "wiki_page" && (tg.slug || typeof a.params.slug === "string"))
    return (
      <Link
        to="/org/$orgId/wiki/$slug"
        params={{ orgId, slug: tg.slug ?? String(a.params.slug) }}
        className={className}
      >
        {children}
        {cue}
      </Link>
    );
  if (tg.type === "channel")
    return (
      <Link to="/org/$orgId/c/$channelId" params={{ orgId, channelId: tg.id }} className={className}>
        {children}
        {cue}
      </Link>
    );
  if (tg.type === "thread")
    return (
      <Link
        to="/org/$orgId/threads/$threadId"
        params={{ orgId, threadId: tg.id }}
        className={className}
        onClick={openThread ? (e) => inPlaceClick(e, () => openThread(tg.id)) : undefined}
      >
        {children}
        {cue}
      </Link>
    );
  // A skill has its own view in Skills, for who manages agents; anyone else finds it in the agent's Memória.
  if (tg.type === "skill" && managesAgents)
    return (
      <Link
        to="/org/$orgId/settings/$section"
        params={{ orgId, section: "skills" }}
        search={{ skill: tg.id }}
        className={className}
      >
        {children}
        {cue}
      </Link>
    );
  if (tg.type === "memory" || tg.type === "skill")
    return (
      <Link
        to="/org/$orgId/agents/$agentId/memory"
        params={{ orgId, agentId: a.agentId }}
        search={{ item: tg.id }}
        className={className}
        onClick={
          openPanel && !rightHand ? (e) => inPlaceClick(e, () => openPanel(a.agentId, "memory", tg.id)) : undefined
        }
      >
        {children}
        {cue}
      </Link>
    );
  return plain ? <span className={className}>{children}</span> : <b>{children}</b>;
}
