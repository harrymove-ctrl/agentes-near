import type { TFunction } from "i18next";
import type {
  Agent,
  AgentBrain,
  AiAccounts,
  AiComputer,
  Credential,
  Machine,
  MachineAccount,
  MachineAccountKind,
  PlanUsage,
} from "../api/types";
import { joinNames } from "./format";
import { isPlanId, loginPerAgent, planName } from "./plans";
import { isRightHand } from "./right-hand";

/** One account as a row shows it: its logins, one per agent where its plan allows it (`LOGIN_PER_AGENT`). */
export interface PlanAccount<A extends MachineAccount> {
  /** The first login's id. */
  key: string;
  /** Oldest first. They share the account's label, kind, plan and owner. */
  logins: A[];
  /** The agents that think with any of them. */
  usedBy: string[];
  /** The newest usage any of them reported: they share the plan's limits. */
  usage: PlanUsage | null;
  /** Signed out for sure (`signInOf`). */
  signedOut: A[];
  /** The computer's last look at them said nothing for sure, and the last it knew was signed out (`signInOf`). */
  unknown: A[];
}

/**
 * Where a login's sign-in stands: signed out only when the computer said so for sure. `unknown`: its last look
 * said nothing for sure (`statusKnown` false) and the last it knew was signed out, which never reads as signed out
 * nor asks for a new sign-in: the computer looks again by itself.
 */
export const signInOf = (a: Pick<MachineAccount, "status" | "statusKnown">): "active" | "signed_out" | "unknown" =>
  a.status === "active" ? "active" : a.statusKnown === false ? "unknown" : "signed_out";

/**
 * Whether a login offers signing in to it again: whenever the server keeps it signed out, also while its last look
 * was unclear (`signInOf` unknown only changes the words), since its turns are refused until then.
 */
export const offersSignInAgain = (a: Pick<MachineAccount, "status">) => a.status === "signed_out";

const newest = (usages: (PlanUsage | null)[]) =>
  usages.reduce<PlanUsage | null>(
    (best, u) => (u && (!best || Date.parse(u.at) > Date.parse(best.at)) ? u : best),
    null,
  );

/**
 * The logins of one account together, as the server tells them apart: the same computer, owner, CLI and plan, and
 * the same email (any case) and Claude organization (one not said is any), or key's last 4. Never the label, which any rename can repeat.
 * A login whose email or key the viewer can't see (another person's) is a row of its own.
 */
export function groupPlans<A extends MachineAccount & { machineId?: string }>(
  accounts: readonly A[],
): PlanAccount<A>[] {
  const groups: { key: string; org: string | null; logins: A[] }[] = [];
  for (const a of accounts) {
    const identity = a.provider ? a.keyHint : a.email?.toLowerCase();
    const key = identity ? JSON.stringify([a.machineId ?? null, a.ownerId, a.kind, a.provider, identity]) : a.id;
    const org = a.providerOrgId ?? null;
    // Like the server's, an organization not said matches any: only two known ones tell logins apart.
    const same = groups.filter((g) => g.key === key);
    const group = org === null ? same[0] : (same.find((g) => g.org === org) ?? same.find((g) => g.org === null));
    if (!group) groups.push({ key, org, logins: [a] });
    else {
      group.logins.push(a);
      group.org ??= org;
    }
  }
  return groups.map(({ logins }) => ({
    key: logins[0]?.id ?? "",
    logins,
    usedBy: logins.flatMap((l) => l.usedBy),
    usage: newest(logins.map((l) => l.usage)),
    signedOut: logins.filter((l) => signInOf(l) === "signed_out"),
    unknown: logins.filter((l) => signInOf(l) === "unknown"),
  }));
}

/** One account in an agent's account choice: the login it offers, and the agents on any of its logins. */
export interface AccountChoice<A extends MachineAccount> {
  login: A;
  usedBy: string[];
  /**
   * Every login of it thinks for another agent, none for all of them (`shared`), and the account may have one per
   * agent (`LOGIN_PER_AGENT`): choosing it signs this agent in to it again ("Also used by Ada") instead of taking a
   * login from another agent.
   */
  also: boolean;
}

/**
 * An agent's account choice, one entry per account (`groupPlans`): the first of `ids` it has a login of (the one
 * chosen, then the one the agent thinks with), else a login of the viewer's that thinks for all of their agents
 * there or for nobody (a signed-in one first: a new sign-in of Claude can sign the account's other logins out), else
 * its first.
 */
export function accountChoices<A extends MachineAccount & { machineId?: string }>(
  accounts: readonly A[],
  ids: readonly (string | null | undefined)[],
): AccountChoice<A>[] {
  return groupPlans(accounts).flatMap(({ logins, usedBy }) => {
    const free = logins.filter((l) => l.mine && (l.shared === true || l.usedBy.length === 0));
    const own =
      ids.map((id) => logins.find((l) => l.id === id)).find(Boolean) ??
      free.find((l) => l.status === "active") ??
      free[0];
    const login = own ?? logins[0];
    if (!login) return [];
    return [{ login, usedBy, also: !own && login.mine && loginPerAgent(login.kind, login.provider) }];
  });
}

/**
 * The person's own account of this plan on that computer, before a new sign-in there: one signed out first, else one
 * signed in. Signing in to it again keeps its id, its folder and its agents, where each new sign-in leaves one more
 * account on the computer (a retry after a failed check made several). Only a login free to take (`freeDuplicate`'s
 * rule): one for all of their agents there, or one no agent thinks with. Another agent's own login can't think for a
 * second one, and signing in to it again starts its folder over. `provider`: a coding plan's (or a CLI's key); none
 * for the CLI's own sign-in.
 */
export function reusableAccount<A extends MachineAccount & { machineId: string }>(
  accounts: readonly A[] | undefined,
  { machineId, kind, provider }: { machineId: string; kind: MachineAccountKind; provider?: string },
): A | undefined {
  const theirs = (accounts ?? []).filter(
    (a) =>
      a.mine &&
      a.machineId === machineId &&
      a.kind === kind &&
      (a.provider ?? undefined) === provider &&
      (a.shared === true || a.usedBy.length === 0),
  );
  return theirs.find((a) => a.status === "signed_out") ?? theirs[0];
}

/**
 * The logins of one account (`groupPlans`) that think for no agent: what signing in again and again left behind,
 * removed in one click. One stays when none thinks for an agent (a signed-in one first), so the account is still
 * there.
 */
export function unusedCopies<A extends MachineAccount>({ logins }: Pick<PlanAccount<A>, "logins">): A[] {
  const unused = logins.filter((l) => l.mine && l.usedBy.length === 0);
  if (unused.length < logins.length) return unused;
  const keep = logins.find((l) => l.status === "active") ?? logins[0];
  return unused.filter((l) => l !== keep);
}

/**
 * "Use for…" an account that thinks for all of its owner's agents there (`shared`): the viewer's agents on its
 * computer that don't think with it yet. Never one on the workspace's API key: a plan makes an agent answer only
 * its owner, so that one moves on its own page.
 */
export function agentsToGive<A extends { id: string; ownerUserId: string | null }>({
  account,
  agents,
  machine,
  viewerId,
  onKey,
}: {
  account: Pick<MachineAccount, "shared" | "mine" | "usedByIds">;
  agents: readonly A[];
  /** The account's computer (`useMachines`): the agents on it. */
  machine: Pick<Machine, "agents"> | undefined;
  viewerId: string;
  /** The agent thinks with the workspace's API key now. */
  onKey: (agentId: string) => boolean;
}): A[] {
  if (account.shared !== true || !account.mine || !machine) return [];
  const here = new Set(machine.agents.map((a) => a.id));
  const using = new Set(account.usedByIds ?? []);
  return agents.filter((a) => here.has(a.id) && a.ownerUserId === viewerId && !using.has(a.id) && !onKey(a.id));
}

/**
 * Disconnecting ends the account's sign-in on the computer only: a Claude account made for all agents where each is
 * its own OS user is a token, which only Claude's settings revoke.
 */
export const endsOnClaude = (
  account: Pick<MachineAccount, "shared" | "kind" | "provider">,
  machine: Pick<Machine, "mode"> | undefined,
) => account.shared === true && account.kind === "claude_code" && !account.provider && machine?.mode === "system";

/**
 * The viewer's own account that can't say which Claude account it is: a token made for all agents (`endsOnClaude`)
 * comes with no email, so where its email would show, the apps say it isn't known.
 */
export const identityUnknown = (
  account: Pick<MachineAccount, "shared" | "kind" | "provider" | "mine" | "email">,
  machine: Pick<Machine, "mode"> | undefined,
) => account.mine && !account.email && endsOnClaude(account, machine);

/**
 * An account by its name with its plan once ("Claude · Max", "Trabalho · Ultra"); a key account by its name. A name
 * that already says the plan stays as it is: servers before ADR 0059's 2026-10-30 amendment name accounts after it
 * ("Claude Max 2"), and the phone talks to those too.
 */
export const accountTitle = (a: Pick<MachineAccount, "label" | "plan">) =>
  a.plan && !a.label.toLowerCase().split(/\s+/).includes(a.plan.toLowerCase())
    ? `${a.label} · ${planName(a.plan)}`
    : a.label;

/** Whether the accounts sit on more than one computer: only then does a row say on which ("no MacBook"). */
export const onSeveralComputers = (accounts: readonly { machineId: string }[]) =>
  new Set(accounts.map((a) => a.machineId)).size > 1;

/**
 * The line under an account in an agent's account choice (Quem pensa and Connect an AI, web and phone): whose it is
 * when it isn't the viewer's, the agents on it where choosing it signs this agent in to it too, signed out, the
 * agents it would be taken from (or those it thinks for too, made for all of its owner's agents), else its key's end
 * or its email. One the computer couldn't check says so, never signed out.
 */
export function accountAbout(
  t: TFunction,
  { login: a, usedBy, also }: AccountChoice<MachineAccount>,
  agentName: string,
): string | undefined {
  if (!a.mine) return t("agentPage.work.brain.accountOf", { name: a.ownerName?.split(" ")[0] ?? "" });
  if (also) return t("agentPage.work.brain.accountAlso", { agents: joinNames(usedBy, t) });
  if (signInOf(a) === "unknown") return t("agentPage.work.brain.accountUnknown");
  // A coding plan's key never signs out: it reads signed out once its endpoint refused it.
  if (a.status === "signed_out") {
    return t(isPlanId(a.provider) ? "aiAccounts.page.keyRefused" : "agentPage.work.brain.accountSignedOut");
  }
  const others = a.usedBy.filter((n) => n !== agentName);
  // One made for all of its owner's agents there thinks for this one too: nothing moves.
  if (others.length && a.shared === true) {
    return t("agentPage.work.brain.accountAlso", { agents: joinNames(others, t) });
  }
  if (others.length) return t("agentPage.work.brain.accountMove", { agents: others.join(", ") });
  return a.keyHint ? t("aiAccounts.page.keyEnds", { hint: a.keyHint }) : (a.email ?? undefined);
}

/**
 * Someone else's plan that a person who may use other people's plans (`use_others_plans`, ADR 0059 §3) can give the
 * agent named `agentName`: signed in, and thinking for nobody else or for all of its owner's agents there. It is
 * never taken from an agent that has it.
 */
export const lendable = (a: Pick<MachineAccount, "status" | "shared" | "usedBy">, agentName: string) =>
  a.status !== "signed_out" && (a.shared === true || a.usedBy.every((n) => n === agentName));

/**
 * What a row of what the person already has does for the agent: `use` it at once; `also` signs the agent in to that
 * account once more (one login per agent); `again` signs a free login of it back in; `move` takes it from the agent
 * on it; `locked`: someone else's, which only its owner picks (ADR 0041 §4, ADR 0059), unless the viewer may use
 * other people's plans and it is `lendable`.
 */
export type ExistingAct = "use" | "also" | "again" | "move" | "locked";

export type ExistingAi<A extends MachineAccount = MachineAccount> =
  | { kind: "account"; choice: AccountChoice<A>; act: ExistingAct }
  | { kind: "key"; key: Credential };

const EXISTING_RANK: Record<ExistingAct | "key", number> = { use: 0, also: 1, again: 1, move: 1, key: 2, locked: 3 };

/**
 * What an account's row does (`ExistingAct`); null for a signed-out login another agent thinks with. Someone else's is
 * `use` where the viewer may use other people's plans (`others`) and it is `lendable`.
 */
function existingAct({ login: a, also }: AccountChoice<MachineAccount>, others: boolean): ExistingAct | null {
  if (!a.mine) return others && lendable(a, "") ? "use" : "locked";
  if (also) return "also";
  // One made for all of its owner's agents there is never taken from the others.
  const used = a.usedBy.length > 0 && a.shared !== true;
  if (a.status === "signed_out") return used ? null : "again";
  return used ? "move" : "use";
}

/**
 * What a person already has for an agent with no AI (Connect an AI, before its new sign-ins): the accounts on the
 * agent's computer but the one it thinks with now, one row per account (`accountChoices`), the workspace's API keys
 * the person may use (`keys`: none for someone who may not), then someone else's accounts. The free ones first. A
 * signed-out login another agent thinks with stays out: it thinks for nobody until its owner signs it in again.
 */
export function existingAi<A extends MachineAccount>(
  view: { accounts: readonly A[]; account: string | null; canUseOthersPlans?: boolean },
  keys: readonly Credential[],
): ExistingAi<A>[] {
  const accounts = accountChoices(
    view.accounts.filter((a) => a.id !== view.account),
    [],
  ).flatMap((choice): ExistingAi<A>[] => {
    const act = existingAct(choice, view.canUseOthersPlans === true);
    return act ? [{ kind: "account", choice, act }] : [];
  });
  const live = keys.filter((k) => !k.revokedAt).map((key): ExistingAi<A> => ({ kind: "key", key }));
  const rank = (r: ExistingAi<A>) => EXISTING_RANK[r.kind === "key" ? "key" : r.act];
  return [...accounts, ...live].sort((x, y) => rank(x) - rank(y));
}

/**
 * Whether Connect an AI starts with what the person already has for the agent (`existingAi`): while it has no AI, and
 * always for the right hand, whose plan may be one it can't think with now.
 */
export const listsExisting = (agent: Pick<Agent, "builtin"> | undefined, noAi: boolean) => noAi || isRightHand(agent);

export const ACCOUNT_KINDS = ["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"] as const;

/** A computer's own sign-in as "Seus planos" lists it ("Conta deste computador"). */
export interface OwnSignInRow {
  key: string;
  machineId: string;
  computer: string;
  kind: MachineAccountKind;
  /** The plan the CLI reported (`max`, `pro`…), as it said it. */
  plan: string | null;
  usage: PlanUsage | null;
}

/** The viewer's computers' own sign-ins, Claude Code first on each computer (the computers' order kept). */
export function ownSignIns(view: Pick<AiAccounts, "computers"> | null | undefined): OwnSignInRow[] {
  const out: OwnSignInRow[] = [];
  for (const c of view?.computers ?? []) {
    for (const kind of ["claude_code", "codex", "cursor"] as const) {
      const own = c.own?.[kind];
      if (!own) continue;
      out.push({
        key: `${c.machineId}:${kind}`,
        machineId: c.machineId,
        computer: c.name,
        kind,
        plan: own.plan ?? null,
        usage: own.usage ?? null,
      });
    }
  }
  return out;
}

/** The plan's name as people know it ("Max", "Ultra", "Pro"): the runner's word with a capital, or nothing. */
export const planWordOf = (plan: string | null) =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase() : null;

/** A computer's own sign-in as "Seus planos" titles it: its CLI's maker and its plan ("Claude · Max"). */
export const ownSignInTitle = (t: TFunction, o: Pick<OwnSignInRow, "kind" | "plan">) =>
  accountTitle({ label: t(`aiAccounts.connect.${o.kind}`), plan: o.plan });

/**
 * A computer's own sign-in by name: on a computer the viewer connected, the account their agents there share; on
 * someone else's, that computer's ("MacBook's account"). OpenCode with no account is nobody's: its free models.
 */
export const ownSignInName = (t: TFunction, mine: boolean, computer: string, kind?: MachineAccountKind) =>
  kind === "opencode"
    ? t("connectAi.own.free")
    : mine
      ? t("connectAi.own.shared")
      : t("agentPage.work.brain.thisComputer", { computer });

/** `ownSignInName` inside a sentence ("Ada pensa com a conta que os seus agentes dividem"). */
export const ownSignInLower = (t: TFunction, kind: string | null) =>
  t(kind === "opencode" ? "connectAi.own.freeLower" : "connectAi.own.sharedLower");

/**
 * The computer's own sign-in of `kind` can think for the agent (ADR 0041, ADR 0059 §3): whoever connected that
 * computer owns the agent, and its runner reported that CLI signed in there (`own`, the computer's `/ai-accounts`
 * row). On a computer nobody connected (the workspace's own) it never can. OpenCode signs in nowhere: its free tier
 * is a choice wherever its CLI runs, for the agents of whoever connected that computer and, on a computer nobody
 * connected (`canAdd` without `mine`), for anyone's (ADR 0132 §6). It is never listed as the person's AI.
 */
export const ownSignInReady = (
  brain: Pick<AgentBrain, "ownSignIn"> | undefined,
  row: (Pick<AiComputer, "own"> & Partial<Pick<AiComputer, "mine" | "brains" | "canAdd">>) | undefined,
  kind: MachineAccountKind,
) =>
  kind === "opencode"
    ? row?.brains?.opencode === true &&
      row.canAdd === true &&
      (brain?.ownSignIn === true || (brain !== undefined && row.mine === false))
    : brain?.ownSignIn === true && row?.own?.[kind] !== undefined;

/**
 * An agent's account choice lists the computer's own sign-in where it is ready (`ownSignInReady`), and while the
 * agent thinks with it: on a computer its owner connected, whatever that computer reported, and to an admin who
 * doesn't own the agent wherever it is (what it thinks with). To that admin also wherever its owner connected the
 * computer: only the person who connected it sees whether that CLI is signed in there.
 */
export const ownSignInListed = (
  brain: Pick<AgentBrain, "ownSignIn" | "brain" | "account" | "canUsePlans">,
  row: Parameters<typeof ownSignInReady>[1],
  kind: MachineAccountKind,
) =>
  ownSignInReady(brain, row, kind) ||
  (brain.ownSignIn && !brain.canUsePlans) ||
  (brain.brain === kind && brain.account === null && (brain.ownSignIn || !brain.canUsePlans));

/**
 * The plan an agent's sign-in is on, as the CLI said it (`team`, `max`…): its account's, or with none (`account`
 * null) its computer's own sign-in's, from that computer's row of `GET …/ai-accounts`. A seat has its own words
 * under "Atende outras pessoas".
 */
export function signInPlan(
  view: { account: string | null; accounts: readonly Pick<MachineAccount, "id" | "plan">[] },
  row: Pick<AiComputer, "own"> | undefined,
  kind: MachineAccountKind,
): string | null {
  if (view.account === null) return row?.own?.[kind]?.plan ?? null;
  return view.accounts.find((a) => a.id === view.account)?.plan ?? null;
}

/**
 * What removing a key changes, said before the person goes on (web and phone): the agents that think with it move to
 * another key, or stop answering where nothing else is left.
 */
export function keyRemovalText(
  t: TFunction,
  key: Pick<Credential, "id" | "usedBy">,
  live: readonly Pick<Credential, "id">[],
  platform: boolean,
) {
  const used = key.usedBy ?? [];
  if (used.length === 0) return t("settings.removeUnused");
  const others = platform || live.some((k) => k.id !== key.id);
  return t(others ? "settings.removeUsedOther" : "settings.removeUsedNone", {
    count: used.length,
    agents: joinNames(
      used.map((a) => a.name),
      t,
    ),
  });
}
