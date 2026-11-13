import { and, asc, type Database, eq, schema } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import { getAgentCached } from "../agents";
import { accountablePerson, runAuthorityById } from "../authority";
import { emailLocale } from "../email";
import { getMembership } from "../organizations";
import type { GitHubHttp } from "./github-app";

const { accounts, organizationMembers, users } = schema;

/**
 * What an agent writes on GitHub says whose agent it is (ADR 0156): every body ends with one line naming the agent and
 * the person it works for ("Theo, agente de Ana no agentes.chat", in the workspace owner's language), and commits
 * credit that person (`Co-authored-by`) when they linked GitHub to sign in, never with their email.
 */

/** Where the line starts in a body, so an edit can replace it. */
export const SIGNATURE_MARK = "<!-- agentes.chat -->";

/**
 * A line of ours left in a body the agent sends again (an edit): the mark on a line of its own, then the line. One
 * quoted from another comment (`> `) is the agent's text, and so is everything around it.
 */
const OWN_LINE = /[\r\n]*^[ \t]*<!-- agentes\.chat -->[ \t]*\r?\n<sub>[^<\r\n]*<\/sub>[ \t]*$/gm;

/** A name as GitHub shows it: one line, no markup, no @mention, no link. */
const escapeLine = (s: string) => s.replace(/\s+/g, " ").replace(/[&<>@#*_`~|\\[\]]/g, (c) => `&#${c.charCodeAt(0)};`);

/** `body` with the agent's line at its end, once (an old line of ours is taken out, nothing else). */
export function signedBody(body: string, line: string) {
  const text = body
    .replace(OWN_LINE, "")
    .replace(/^[\r\n]+/, "")
    .trimEnd();
  return `${text ? `${text}\n\n` : ""}${SIGNATURE_MARK}\n<sub>${escapeLine(line)}</sub>`;
}

/** One of our agents wrote this body (its line ends it): through an account's connection it isn't the app's bot. */
export const signedByAgent = (body: string) =>
  /(?:^|\n)[ \t]*<!-- agentes\.chat -->[ \t]*\r?\n<sub>[^<\r\n]*<\/sub>$/.test(body.trimEnd());

/** `message` with the trailer on its last line, inside its trailer block when it ends with one; once. */
export function creditedMessage(message: string, trailer: string) {
  if (message.includes(trailer)) return message;
  const text = message.trimEnd();
  const paragraphs = text.split(/\n[ \t]*\n/);
  const last = paragraphs.at(-1) ?? "";
  const block = paragraphs.length > 1 && last.split("\n").every((l) => /^[A-Za-z][A-Za-z-]*: \S/.test(l));
  return `${text}${block ? "\n" : "\n\n"}${trailer}`;
}

/** The person behind a call: who asked (or a routine's creator), else the agent's responsável; members only. */
async function personBehind(db: Database, ctx: { orgId: string; runId?: string }, ownerUserId: string | null) {
  const asked = ctx.runId ? accountablePerson(await runAuthorityById(db, ctx.orgId, ctx.runId)) : null;
  for (const id of new Set([asked, ownerUserId])) {
    if (id && (await getMembership(db, id, ctx.orgId))) return id;
  }
  return null;
}

/** The workspace's language for what agents sign: its first owner's, as the workspace's computer is named. */
async function workspaceLocale(db: Database, orgId: string) {
  const [owner] = await db
    .select({ locale: users.locale })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")))
    .orderBy(asc(organizationMembers.createdAt))
    .limit(1);
  return emailLocale(owner?.locale);
}

const logins = new Map<string, { login: string | null; at: number }>();
const LOGIN_TTL_MS = 24 * 3600_000;
const MISS_TTL_MS = 10 * 60_000;

/** A GitHub account's login by its id (`GET /user/{id}`), cached for a day; null when GitHub didn't say. */
async function githubLogin(http: GitHubHttp, id: string, token?: string | null) {
  const known = logins.get(id);
  if (known && Date.now() - known.at < (known.login ? LOGIN_TTL_MS : MISS_TTL_MS)) return known.login;
  const res = await http
    .fetch(`${http.apiUrl}/user/${id}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "agentes.chat",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    .catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { login?: unknown } | null) : null;
  const login = typeof body?.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(body.login) ? body.login : null;
  logins.set(id, { login, at: Date.now() });
  return login;
}

/**
 * `Co-authored-by: Ana <123+ana@users.noreply.github.com>` for a person who linked GitHub to sign in (their GitHub id
 * from that sign-in, the login GitHub has for it now). Null otherwise: no address is guessed.
 */
export async function coAuthorOf(
  deps: { db: Database; http: GitHubHttp; token?: string | null },
  personId: string,
): Promise<string | null> {
  const [row] = await deps.db
    .select({ githubId: accounts.accountId, name: users.name })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(and(eq(accounts.userId, personId), eq(accounts.providerId, "github")))
    .limit(1);
  if (!row || !/^\d{1,20}$/.test(row.githubId)) return null;
  const login = await githubLogin(deps.http, row.githubId, deps.token);
  if (!login) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters would break the trailer
  const name = row.name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim() || login;
  return `Co-authored-by: ${name} <${row.githubId}+${login}@users.noreply.github.com>`;
}

/** The line under what this agent writes on GitHub in this run. */
export async function signatureLine(db: Database, ctx: { orgId: string; agentId: string; runId?: string }) {
  const agent = await getAgentCached(db, ctx.orgId, ctx.agentId);
  const personId = await personBehind(db, ctx, agent?.ownerUserId ?? null);
  const [person] = personId ? await db.select({ name: users.name }).from(users).where(eq(users.id, personId)) : [];
  const vars = { agent: agent?.name ?? "agent", person: person?.name ?? "" };
  const key = person ? "githubApp.signature.forPerson" : "githubApp.signature.alone";
  return serverText(await workspaceLocale(db, ctx.orgId), key, vars);
}

/** The credit for this run's commits through GitHub's API: the person behind it (as `signatureLine` names them). */
export async function runCoAuthor(
  deps: { db: Database; http: GitHubHttp; token?: string | null },
  ctx: { orgId: string; agentId: string; runId?: string },
) {
  const agent = await getAgentCached(deps.db, ctx.orgId, ctx.agentId);
  const personId = await personBehind(deps.db, ctx, agent?.ownerUserId ?? null);
  return personId ? coAuthorOf(deps, personId) : null;
}
