import type { MemberPresence, OrgRole, Role } from "../api/types";
import { isRightHand } from "./right-hand";

interface GroupPerson {
  userId: string;
  name: string;
  role: Role;
  roleIds?: string[];
}

interface GroupAgent {
  id: string;
  name: string;
  builtin?: "right_hand" | null;
}

export type MemberRow<P, A> = { kind: "person"; person: P } | { kind: "agent"; agent: A };

export interface MemberGroup<P, A> {
  /** `owner`, `role:<id>`, `agents`, `online` or `offline`. */
  key: string;
  /** Set on a hoisted role's group: its name and mark. */
  role?: OrgRole;
  rows: MemberRow<P, A>[];
}

/** The color of a person's name in a conversation: the mark of their highest role; an owner's is the owners' mark. */
export function memberRoleColor(person: Pick<GroupPerson, "role" | "roleIds">, roles: OrgRole[]) {
  if (person.role === "owner") return "violet";
  const top = roles
    .filter((r) => r.kind !== "everyone" && person.roleIds?.includes(r.id))
    .sort((a, b) => a.position - b.position)[0];
  return top?.color;
}

const connected = (p: MemberPresence | undefined) => p === "online" || p === "away" || p === "busy";
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * A channel's members as the members column lists them: the owners online, each hoisted role (top first) with the
 * online people whose highest hoisted role it is, the agents (the right hand first, then busy ones), everyone else
 * online, then offline. A
 * person shows once; a hidden one reads offline (ADR 0084). Empty groups are left out.
 */
export function memberGroups<P extends GroupPerson, A extends GroupAgent>({
  people,
  agents,
  roles,
  presenceOf,
  busy,
}: {
  people: P[];
  agents: A[];
  roles: OrgRole[];
  presenceOf: (userId: string) => MemberPresence | undefined;
  busy: (agentId: string) => boolean;
}): MemberGroup<P, A>[] {
  const hoisted = roles.filter((r) => r.hoist && r.kind !== "everyone").sort((a, b) => a.position - b.position);
  const owner: P[] = [];
  const byRole = new Map<string, P[]>(hoisted.map((r) => [r.id, []]));
  const online: P[] = [];
  const offline: P[] = [];
  for (const p of [...people].sort(byName)) {
    if (!connected(presenceOf(p.userId))) offline.push(p);
    else if (p.role === "owner") owner.push(p);
    else {
      const top = hoisted.find((r) => p.roleIds?.includes(r.id));
      (top ? (byRole.get(top.id) as P[]) : online).push(p);
    }
  }
  const sortedAgents = [...agents].sort(
    (a, b) =>
      Number(isRightHand(b)) - Number(isRightHand(a)) || Number(busy(b.id)) - Number(busy(a.id)) || byName(a, b),
  );
  const person = (ps: P[]) => ps.map((p): MemberRow<P, A> => ({ kind: "person", person: p }));
  const groups: MemberGroup<P, A>[] = [
    { key: "owner", rows: person(owner) },
    ...hoisted.map((r) => ({ key: `role:${r.id}`, role: r, rows: person(byRole.get(r.id) ?? []) })),
    { key: "agents", rows: sortedAgents.map((a): MemberRow<P, A> => ({ kind: "agent", agent: a })) },
    { key: "online", rows: person(online) },
    { key: "offline", rows: person(offline) },
  ];
  return groups.filter((g) => g.rows.length > 0);
}
