import type { TFunction } from "i18next";
import type {
  Memory,
  MemoryUpdate,
  OrgRole,
  OrgSummary,
  Person,
  Proposal,
  ProposalAccessLine,
  ProposalSettingLine,
} from "../api/types";
import { formatTime, formatUsd, joinNames } from "./format";
import { agentGrammar } from "./grammar";
import { holdersOf } from "./roles";
import { scopeText } from "./scopes";
import { modeKey } from "./workspace-mode";

/**
 * The workspace a proposal is in, for its context's words: its name, or the workspace itself, whose mode says them. A
 * personal workspace's context is what its person's agents know about them (ADR 0159), never "Personal context".
 */
export type ProposalWorkspace = string | Pick<OrgSummary, "name" | "mode">;

/** The key of the context's words and the name they carry, for `ws`. */
function contextWords<K extends string>(ws: ProposalWorkspace, key: K) {
  return typeof ws === "string" ? { key, org: ws } : { key: modeKey(ws, key), org: ws.name };
}

/*
 * A card of proposed changes in the chat (`memory.updated`, `proposed`, ADR 0092): an agent asked to change its own
 * or its teammates' instructions, roles or apps, or the org context. One proposal per agent and kind of change, each
 * decided by whoever may make that change on the agent's page; the apps lay these rules out.
 */

/** The proposals on a card: every row, or the one an older server named (`proposalId`). */
export const cardProposalIds = (u: Pick<MemoryUpdate, "proposalId" | "proposalIds">): string[] =>
  u.proposalIds?.length ? u.proposalIds : u.proposalId ? [u.proposalId] : [];

/** The proposal cards a message carries: one per proposal in `meta.memoryUpdates`, else its older `meta.proposalId`. */
export function messageProposalCards(meta: Record<string, unknown> | null | undefined): string[][] {
  const updates = Array.isArray(meta?.memoryUpdates) ? (meta.memoryUpdates as Partial<MemoryUpdate>[]) : [];
  const cards = updates.flatMap((u) => (u?.action === "proposed" ? [cardProposalIds(u)] : [])).filter((c) => c.length);
  return cards.length || typeof meta?.proposalId !== "string" ? cards : [[meta.proposalId]];
}

/** What waits on an agent's page: its instructions and the skills it asked to change, both decided from there. */
export const pendingOnAgent = <P extends Pick<Proposal, "agentId" | "status" | "target">>(list: P[], agentId: string) =>
  list.filter(
    (p) =>
      p.agentId === agentId &&
      p.status === "pending" &&
      (p.target.type === "agent_instructions" || p.target.type === "skill"),
  );

/** The agent that proposed it (older servers: the agent it changes). */
export const proposerOf = (p: Pick<Proposal, "agentId" | "proposedByAgentId">) => p.proposedByAgentId || p.agentId;

/** Still waiting for a decision. */
export const isOpen = (p: Pick<Proposal, "status" | "stale">) => p.status === "pending" && !p.stale;

const place = (p: Proposal) => (isOpen(p) ? (p.canDecide ? 0 : 1) : 2);

/** What waits on me first, then what waits on someone else, then what was decided: newest first inside each. */
export function sortProposals(list: Proposal[]) {
  return [...list].sort((a, b) => place(a) - place(b) || (a.createdAt < b.createdAt ? 1 : -1));
}

export interface ChangedLine {
  kind: "add" | "del";
  text: string;
}

/** What a text proposal changes: the lines it takes out, then the ones it puts in (blank ones aside). */
export function changedLines(p: Pick<Proposal, "before" | "after">): ChangedLine[] {
  const before = p.before.split("\n");
  const after = p.after.split("\n");
  const only = (lines: string[], other: string[]) => {
    const seen = new Set(other);
    return lines.filter((l) => l.trim() && !seen.has(l));
  };
  return [
    ...only(before, after).map((text) => ({ kind: "del" as const, text })),
    ...only(after, before).map((text) => ({ kind: "add" as const, text })),
  ];
}

/**
 * The line that says what a text proposal changes, for a card's short form: the first it adds, past any heading,
 * without its list mark.
 */
export function firstChange(lines: ChangedLine[] | undefined): ChangedLine | undefined {
  const added = (lines ?? []).filter((l) => l.kind === "add");
  const line = added.find((l) => !l.text.trim().startsWith("#")) ?? added[0] ?? lines?.[0];
  return line && { ...line, text: line.text.replace(/^\s*[-*+]\s+/, "") };
}

export type ProposalSection =
  | { kind: "text"; lines: ChangedLine[]; rows: Proposal[] }
  | { kind: "role" | "access" | "settings"; rows: Proposal[] };

/**
 * A card's rows by what they change, so each change shows once: text rows (instructions, the org context) that
 * change the same lines together under those lines, then the new roles, then the apps.
 */
export function proposalSections(rows: Proposal[]): ProposalSection[] {
  const text = new Map<string, { kind: "text"; lines: ChangedLine[]; rows: Proposal[] }>();
  const role: Proposal[] = [];
  const access: Proposal[] = [];
  const settings: Proposal[] = [];
  for (const p of rows) {
    if (p.target.type === "agent_role") role.push(p);
    else if (p.target.type === "agent_access") access.push(p);
    else if (p.target.type === "agent_settings") settings.push(p);
    else {
      const lines = changedLines(p);
      const key = JSON.stringify(lines);
      const section = text.get(key) ?? { kind: "text", lines, rows: [] };
      section.rows.push(p);
      text.set(key, section);
    }
  }
  return [
    ...text.values(),
    ...(role.length ? [{ kind: "role" as const, rows: role }] : []),
    ...(access.length ? [{ kind: "access" as const, rows: access }] : []),
    ...(settings.length ? [{ kind: "settings" as const, rows: settings }] : []),
  ];
}

/**
 * What the card's Aceitar and Recusar act on: the open rows the viewer may decide and left switched on. `all`
 * while that is every open row on the card ("Aceitar para todos"), else the button counts them ("Aceitar para 2").
 */
export function chosenRows(rows: Proposal[], off: ReadonlySet<string>) {
  const open = rows.filter(isOpen);
  const chosen = open.filter((p) => p.canDecide && !off.has(p.id));
  return { chosen, all: chosen.length === open.length };
}

/** A row's state in words: decided, stale, or whom it waits for; null while the viewer may decide it. */
export function rowStatus(t: TFunction, p: Proposal): string | null {
  if (p.stale) return t("proposals.stale");
  if (p.status === "accepted") return t("proposals.accepted");
  if (p.status === "refused") return t("proposals.refused");
  if (p.canDecide) return null;
  return p.decider.type === "user" ? t("proposals.waitingFor", { name: p.decider.name }) : t("proposals.waitingAdmin");
}

/** How a decided card ended, in a word: each row's status when they all agree, else how many were accepted. */
export function cardOutcome(t: TFunction, rows: Proposal[]): { accepted: boolean; label: string } {
  const done = rows.filter((p) => p.status === "accepted" && !p.stale).length;
  const states = [...new Set(rows.map((p) => rowStatus(t, p)))];
  const label =
    states.length === 1 && states[0] ? states[0] : t("proposals.acceptedSome", { done, total: rows.length });
  return { accepted: done > 0, label };
}

/** Rows a decision couldn't apply because what they were made against changed since (409). */
export const staleCount = (failed: { error: unknown }[]) =>
  failed.filter((f) => (f.error as { status?: unknown } | null)?.status === 409).length;

/** An app on an access row in the person's language: a built-in scope translated, a connection by its name. */
export const appLabel = (t: TFunction, line: ProposalAccessLine) =>
  line.id.startsWith("connector:")
    ? line.label
    : scopeText(t, { id: line.id, label: line.label, description: "", sensitive: false }).label;

/** What one proposal changes, after "propõe ·": "instruções da Ada", "papel do Theo", "contexto da Acme". */
export function proposalTarget(
  t: TFunction,
  p: Proposal,
  agentName: (id: string) => string,
  orgName: ProposalWorkspace,
) {
  if (p.target.type === "org_context") {
    const { key, org } = contextWords(orgName, "proposals.targetContext");
    return t(key, { org });
  }
  const g = agentGrammar(agentName(p.target.agentId));
  if (p.target.type === "agent_role") return t("proposals.targetRole", g);
  if (p.target.type === "agent_access") return t("proposals.targetAccess", g);
  if (p.target.type === "agent_settings") return t("proposals.targetSettings", g);
  if (p.target.type === "skill") return t("proposals.targetSkill", { skill: p.target.name });
  return t("proposals.targetInstructions", g);
}

/**
 * The card's head as a key and its values (`<b>` marks the proposer): one row says what it changes; several say how
 * many agents ("instruções de 3 agentes", "mudanças em 2 agentes"), or "mudanças para a Ada" when they are one's.
 */
export function cardHead(
  t: TFunction,
  rows: Proposal[],
  proposer: string,
  agentName: (id: string) => string,
  orgName: ProposalWorkspace,
): {
  key: "proposals.proposes" | "proposals.proposesMany" | "proposals.proposesManyChanges";
  values: Record<string, string | number>;
} {
  const agents = [...new Set(rows.flatMap((p) => (p.target.type === "org_context" ? [] : [p.target.agentId])))];
  const [first] = rows;
  if (rows.length === 1 && first)
    return {
      key: "proposals.proposes",
      values: { agent: proposer, target: proposalTarget(t, first, agentName, orgName) },
    };
  if (agents.length > 1) {
    const key = rows.every((p) => p.target.type === "agent_instructions")
      ? "proposals.proposesMany"
      : "proposals.proposesManyChanges";
    return { key, values: { agent: proposer, count: agents.length } };
  }
  const target = t("proposals.targetChanges", agentGrammar(agentName(agents[0] ?? "")));
  return { key: "proposals.proposes", values: { agent: proposer, target } };
}

/** Why it is proposed, in the person's language: the server's own reasons are codes, an agent's are its words. */
export function proposalWhy(t: TFunction, p: Pick<Proposal, "why" | "whyCode">): string {
  switch (p.whyCode) {
    case "refused":
      return t("proposals.whyCode.refused", { text: p.why });
    case "corrected":
      return t("proposals.whyCode.corrected", { text: p.why });
    case "seen":
      return t("proposals.whyCode.seen");
    case "skill":
      return t("proposals.whyCode.skill");
    case "asked":
      return t("proposals.whyCode.asked");
    case "budget":
      return t("proposals.whyCode.budget");
    case "no_channel":
      return t("proposals.whyCode.noChannel");
    default:
      return p.why;
  }
}

/** A memory's line: a lesson from a refusal or a correction says so, in the person's language. */
export function memoryLine(t: TFunction, m: Pick<Memory, "text" | "how">): string {
  if (m.how === "refused") return t("memory.fromRefusal", { text: m.text });
  if (m.how === "corrected") return t("memory.fromCorrection", { text: m.text });
  return m.text;
}

const TITLE_KEY = {
  agent_instructions: "proposals.titleInstructions",
  agent_role: "proposals.titleRole",
  agent_access: "proposals.titleAccess",
  agent_settings: "proposals.titleSettings",
  skill: "proposals.titleSkill",
} as const;

/** Its title in the person's language (the server's is English). */
export function proposalTitle(
  t: TFunction,
  p: Proposal,
  orgName: ProposalWorkspace,
  agentName: (id: string) => string,
) {
  const tt = t as unknown as (key: string, options: Record<string, string | undefined>) => string;
  if (p.target.type === "org_context") {
    const { key, org } = contextWords(orgName, "proposals.titleContext");
    return tt(key, { org, defaultValue: p.title });
  }
  return tt(TITLE_KEY[p.target.type], {
    ...agentGrammar(agentName(p.target.agentId)),
    skill: p.target.type === "skill" ? p.target.name : "",
    defaultValue: p.title,
  });
}

const NANO_PER_USD = 1_000_000_000;

/** What a settings card's names come from: the viewer's directory and model list. */
export interface SettingNames {
  model: (id: string) => string;
  person: (userId: string) => string | undefined;
  channel: (channelId: string) => string | undefined;
  role: (roleId: string) => string | undefined;
}

/** A look in words, in the person's language; a custom color reads as its code. */
function lookWords(t: TFunction, value: unknown) {
  const v = (value ?? {}) as { color?: string; eyes?: string; accessory?: string };
  if (!v.color) return t("rightHand.value.lookDefault");
  const tt = t as unknown as (key: string) => string;
  const color = v.color.startsWith("#") ? v.color : tt(`look.colors.${v.color}`);
  const accessory = v.accessory && v.accessory !== "none" ? tt(`look.accessories.${v.accessory}`) : null;
  return [color, tt(`look.eyesNames.${v.eyes}`), accessory].filter(Boolean).join(" · ");
}

/**
 * One line of the right hand's settings card (ADR 0137) in the person's language: what it changes ("Modelo",
 * "#suporte", "Skill excel") and the value then and proposed ("Haiku 4.5" → "Sonnet 4.5"). A seat in a channel reads
 * as how the agent answers there, or that it isn't in it.
 */
export function settingLineText(
  t: TFunction,
  locale: string,
  line: ProposalSettingLine,
  names: SettingNames,
): { field: string; from: string; to: string } {
  const value = (v: unknown, side: "from" | "to"): string => {
    const label = line.label?.[side];
    switch (line.field) {
      case "model":
        return typeof v === "string" && v ? names.model(v) : t("rightHand.value.none");
      case "budget":
        return typeof v === "number" ? formatUsd(locale, v / NANO_PER_USD) : t("rightHand.value.budgetDefault");
      case "owner":
        return (typeof v === "string" ? names.person(v) : undefined) ?? label ?? t("rightHand.value.none");
      case "ai_account":
        return label ?? (v ? t("rightHand.value.anAccount") : t("rightHand.value.none"));
      case "audience": {
        const a = (v ?? {}) as { mode?: string; userIds?: string[]; roleIds?: string[] };
        if (!a.mode || a.mode === "everyone") return t("rightHand.value.everyone");
        if (a.mode === "owner") return t("rightHand.value.ownerOnly");
        const roles = (a.roleIds ?? []).map((id) => names.role(id)).filter((r): r is string => Boolean(r));
        return roles.length ? roles.join(", ") : (label ?? t("rightHand.value.somePeople"));
      }
      case "name":
        return typeof v === "string" ? v : t("rightHand.value.none");
      case "look":
        return lookWords(t, v);
      case "reports_to":
        return typeof v === "string" ? (label ?? t("rightHand.value.anAgent")) : t("rightHand.value.none");
      case "archive":
        return v === true ? t("rightHand.value.archived") : t("rightHand.value.active");
      case "delete":
        return v === true ? t("rightHand.value.deleted") : t("rightHand.value.active");
      case "skill":
        return v === true ? t("rightHand.value.skillOn") : t("rightHand.value.skillOff");
      default:
        return v === null || v === undefined
          ? t("rightHand.value.notIn")
          : t(v === true ? "rightHand.value.withoutMention" : "rightHand.value.mentionOnly");
    }
  };
  const channel = line.channelId ? names.channel(line.channelId) : undefined;
  const field =
    line.field === "channel_add" || line.field === "channel_remove" || line.field === "reply_mode"
      ? channel
        ? `#${channel}`
        : (line.label?.to ?? t("rightHand.field.channel"))
      : line.field === "skill"
        ? t("rightHand.field.skill", { name: line.label?.to ?? "" })
        : (t as unknown as (key: string) => string)(
            `rightHand.field.${line.field === "delete" ? "archive" : line.field}`,
          );
  return { field, from: value(line.from, "from"), to: value(line.to, "to") };
}

/**
 * A removal card (`propose_remove_agents`): every row archives, or every row deletes, one agent. Null for any other
 * settings card.
 */
export function removalOf(rows: Pick<Proposal, "settings">[]): "archive" | "delete" | null {
  const fields = new Set(rows.map((p) => (p.settings?.length === 1 ? p.settings[0]?.field : undefined)));
  const [field] = fields;
  return fields.size === 1 && (field === "archive" || field === "delete") ? field : null;
}

/** Which "Só admins …" line a row the viewer can't decide reads, by what it changes. */
export function onlyKey(p: Pick<Proposal, "settings">) {
  const kinds = new Set(
    (p.settings ?? []).map((l) =>
      l.field === "channel_add" || l.field === "channel_remove" || l.field === "reply_mode" ? "channels" : l.field,
    ),
  );
  const [only] = kinds;
  return `rightHand.card.only.${kinds.size === 1 && only ? only : "many"}` as const;
}

/**
 * The people a row sent with "Pedir a um admin" went to, as the server picks them: who manages agents, with the agent's
 * owner where its owner decides too; an AI account's row only its owner (who owns the agent).
 */
export function decidersOf<P extends Pick<Person, "userId" | "name" | "role" | "roleIds">>(
  p: Pick<Proposal, "decider">,
  people: readonly P[],
  roles: readonly OrgRole[],
  agentOwnerId: string | null | undefined,
): string[] {
  if (p.decider.type === "account_owner") return people.filter((m) => m.userId === agentOwnerId).map((m) => m.name);
  const admins = holdersOf(people, roles, "manage_agents").map((m) => m.name);
  return p.decider.type === "user" ? [...new Set([p.decider.name, ...admins])] : admins;
}

/** "Enviado para Ana e Bruno · 14:02" under a card someone sent on with "Pedir a um admin" (ADR 0137). */
export function sentToText(t: TFunction, locale: string, names: readonly string[], askedAt: string): string {
  const when = formatTime(locale, askedAt);
  return names.length
    ? t("rightHand.card.sentTo", { names: joinNames(names, t), when })
    : t("rightHand.card.sentToAny", { when });
}
