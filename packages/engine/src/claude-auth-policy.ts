import {
  type AuthMethod,
  CLAUDE_AUTH_PROTOCOL,
  type ClaudeLoginMethod,
  claudeLoginMethodsOf,
} from "@agenteschat/adapters";
import { and, asc, count, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { ValidationError } from "./errors";

/**
 * How NEW Claude sign-ins for all agents are made on computers where each agent is its own OS user (ADR 0150),
 * set through the operator API: `claude setup-token` everywhere (no row: what runners always did), or Claude's own
 * login for the listed workspaces or for all. Anywhere else such a sign-in is always Claude's own login. A
 * connection keeps the method it started with (`machine_accounts.auth_method`), so a change here only reaches
 * sign-ins started after it.
 */

const { claudeAuthSettings, machineAccounts, machines, organizations } = schema;

/**
 * A removed computer keeps its accounts for when it comes back (ADR 0041), but nobody can use them meanwhile: counts
 * and lists leave them out. `exists`, so no join repeats an account. Here, not with the analytics: `machine-accounts`
 * imports this module, and importing the analytics from it would load `routines` before it is initialized.
 */
export const onLiveMachine = sql`exists (select 1 from ${machines} where ${machines.orgId} = ${machineAccounts.orgId}
  and ${machines.id} = ${machineAccounts.machineId} and ${machines.deletedAt} is null)`;

export const CLAUDE_AUTH_ROLLOUTS = ["selected", "all"] as const;
export type ClaudeAuthRollout = (typeof CLAUDE_AUTH_ROLLOUTS)[number];
/** Workspaces one policy may list. */
export const CLAUDE_AUTH_ORGS_MAX = 500;

export interface ClaudeAuthPolicy {
  method: ClaudeLoginMethod;
  rollout: ClaudeAuthRollout;
  orgIds: string[];
  changedAt: Date | null;
}

const ClaudeAuthPolicyInput = z.object({
  method: z.enum(["cli_login", "setup_token"]),
  rollout: z.enum(CLAUDE_AUTH_ROLLOUTS),
  orgIds: z.array(z.uuid()).max(CLAUDE_AUTH_ORGS_MAX),
});

/** The live policy; no row reads as `setup_token`, `selected`, no workspaces. */
export async function claudeAuthPolicy(db: Executor): Promise<ClaudeAuthPolicy> {
  const [row] = await db
    .select({
      method: claudeAuthSettings.method,
      rollout: claudeAuthSettings.rollout,
      orgIds: claudeAuthSettings.orgIds,
      changedAt: claudeAuthSettings.changedAt,
    })
    .from(claudeAuthSettings);
  return row ?? { method: "setup_token", rollout: "selected", orgIds: [], changedAt: null };
}

/**
 * Sets the policy: workspaces deduplicated, each new one existing (`claude_auth.unknown_org` otherwise), one
 * already listed but deleted since dropped. Setting the current one changes nothing, `changedAt` included.
 */
export async function setClaudeAuthPolicy(db: Database, input: unknown, now = new Date()) {
  const parsed = ClaudeAuthPolicyInput.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `Choose a method, a rollout and at most ${CLAUDE_AUTH_ORGS_MAX} workspaces`,
      "claude_auth.invalid",
    );
  }
  const { method, rollout } = parsed.data;
  const current = await claudeAuthPolicy(db);
  const asked = [...new Set(parsed.data.orgIds.map((id) => id.toLowerCase()))];
  const found = new Set(
    asked.length > 0
      ? (await db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.id, asked))).map(
          (o) => o.id,
        )
      : [],
  );
  // A listed workspace deleted since (no foreign key on the array) drops out; only a new id must exist.
  if (asked.some((id) => !found.has(id) && !current.orgIds.includes(id))) {
    throw new ValidationError("A workspace in the list doesn't exist", "claude_auth.unknown_org");
  }
  const orgIds = asked.filter((id) => found.has(id)).sort();
  const same =
    current.method === method &&
    current.rollout === rollout &&
    current.orgIds.length === orgIds.length &&
    [...current.orgIds].sort().every((id, i) => id === orgIds[i]);
  if (!same) {
    await db
      .insert(claudeAuthSettings)
      .values({ method, rollout, orgIds, changedAt: now })
      .onConflictDoUpdate({ target: claudeAuthSettings.id, set: { method, rollout, orgIds, changedAt: now } });
  }
  return claudeAuthPolicy(db);
}

/**
 * The method a new Claude subscription sign-in for all agents uses on a computer of `orgId`: Claude's own login
 * unless each agent is its own OS user there (`system`), where the policy says.
 */
export function claudeAuthMethodFor(
  policy: Pick<ClaudeAuthPolicy, "method" | "rollout" | "orgIds">,
  orgId: string,
  system: boolean,
): ClaudeLoginMethod {
  if (!system) return "cli_login";
  return policy.method === "cli_login" && (policy.rollout === "all" || policy.orgIds.includes(orgId))
    ? "cli_login"
    : "setup_token";
}

// ── The operator's reads ─────────────────────────────────────────────────────

/** The policy, with how the Claude subscription connections people have now sign in (`unknown`: not reported). */
export async function operatorClaudeAuth(db: Executor) {
  const [policy, rows] = await Promise.all([
    claudeAuthPolicy(db),
    db
      .select({ method: machineAccounts.authMethod, n: count() })
      .from(machineAccounts)
      .where(
        and(
          eq(machineAccounts.kind, "claude_code"),
          isNull(machineAccounts.provider),
          inArray(machineAccounts.status, ["active", "signed_out"]),
          onLiveMachine,
        ),
      )
      .groupBy(machineAccounts.authMethod),
  ]);
  const connections = { cli_login: 0, setup_token: 0, api_key: 0, unknown: 0 };
  for (const r of rows) {
    const key = r.method === "cli_login" || r.method === "setup_token" || r.method === "api_key" ? r.method : "unknown";
    connections[key] += r.n;
  }
  return { ...policy, connections };
}

/**
 * What a new Claude sign-in for all agents uses in the workspace: on its computers where each agent is its own OS
 * user (`effective`), and on each of its computers, whether that computer's runner can (`supportsSelected`). Null:
 * no such workspace.
 */
export async function operatorOrgClaudeAuth(db: Executor, orgId: string) {
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
  if (!org) return null;
  const [policy, rows] = await Promise.all([
    claudeAuthPolicy(db),
    db
      .select({ id: machines.id, name: machines.name, protocol: machines.protocol, executors: machines.executors })
      .from(machines)
      .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
      .orderBy(asc(machines.createdAt)),
  ]);
  return {
    effective: { method: claudeAuthMethodFor(policy, orgId, true) },
    policy,
    machines: rows.map((m) => {
      const system = m.executors?.mode === "system";
      const said = m.protocol >= CLAUDE_AUTH_PROTOCOL ? m.executors?.claudeLoginMethods : undefined;
      const claudeLoginMethods: AuthMethod[] = claudeLoginMethodsOf(said, system);
      const supportsSelected = claudeLoginMethods.includes(claudeAuthMethodFor(policy, orgId, system));
      // The runner keeps the reason until its next hello, which may not come after the method changes back.
      return {
        id: m.id,
        name: m.name,
        system,
        protocol: m.protocol,
        claudeLoginMethods,
        supportsSelected,
        claudeLoginBlocked: supportsSelected ? null : (m.executors?.claudeLoginBlocked ?? null),
      };
    }),
  };
}
