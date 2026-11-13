import { isReservedSecretName, type PubSub } from "@agenteschat/adapters";
import { and, eq, gt, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { isAbsoluteMachinePath, pathInOwnFolder } from "./machine-access";
import { type ComputerHandle, requireComputerManager } from "./sandbox";
import {
  MAX_PENDING_SECRETS,
  REQUEST_SECRET_TOOL,
  requesterOfRun,
  SECRET_TTL_MS,
  secretLabelOf,
  secretOnComputer,
  secretStillHeld,
  supersedeOlderSecretRequests,
} from "./secrets";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tools/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** A one-time code's boxes on the card (ADR 0144): one per digit. */
export const CODE_DIGITS = { min: 4, max: 12 } as const;
/** Longest username a request may carry (the Vault keeps the same). */
export const MAX_SECRET_USERNAME = 200;
/** Longest label a card shows. */
export const MAX_SECRET_LABEL = 80;

/** The agent's label as people read it; a variable-style one (`LIA_GOOGLE_PASSWORD`, `lia_google_pw`) is no label at all. */
export function friendlyLabel(raw: unknown): string | null {
  const label = str(raw).trim().slice(0, MAX_SECRET_LABEL);
  return label && !/^[A-Z0-9_-]+$/.test(label) && !/^\S*_\S*$/.test(label) ? label : null;
}

/** A `request_secret` site as its origin (`https://host[:port]`), or null when it isn't a web address. */
export function secretSite(raw: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Asking again under a held name is how a refused key gets replaced: the newest delivery wins on the computer. */
const AGAIN =
  "If a key you were given is refused (a 401, or a 403 saying the key is invalid or expired), first check you sent it as the API's docs say (header, prefix, test or live address); if you did, ask once for a new one under the same `name`, with a `purpose` that says in one line, in the person's language, what failed: it replaces the old one. If the new one is refused too, don't ask again: say what failed and stop.";

const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});

/**
 * `request_secret` (ADR 0027), shared by the computer's tools (env/file, any
 * secret) and the agent browser's (ADR 0040: a password bound to one site, for
 * an agent that may only use the browser). One definition, two shapes.
 */
export function requestSecretTool(opts: {
  scope: string;
  /** The browser's variant: `site` required, only an env secret, typed by `browser_type_secret`. */
  browserOnly: boolean;
  /** A workspace path for `target: file` (the computer's variant). */
  toolPath?: (raw: string) => string;
  pubsub?: PubSub;
  /** The computer the key is made on (and the secret later delivered to). */
  onComputer: <T>(ctx: ToolContext, fn: (computer: ComputerHandle) => Promise<T>) => Promise<T>;
}): ToolDefinition {
  const site = {
    type: "string",
    maxLength: 300,
    description:
      "For a password your browser types (browser_type_secret): the address of the page it goes into (https://…). It will only ever be typed on that site, and it stays out of your commands; leave `site` out for a secret a command uses.",
  } as const;
  // ADR 0144: what the card shows besides the field, and what it lets the person save to the Vault.
  const username = {
    type: "string",
    maxLength: MAX_SECRET_USERNAME,
    description:
      "With `site`: the account's username or email. Always give it when you know it (the address you typed, your own mailbox's): the card shows it and keeps it with the password.",
  } as const;
  const code = {
    type: "object",
    properties: { digits: { type: "integer", minimum: CODE_DIGITS.min, maximum: CODE_DIGITS.max } },
    required: ["digits"],
    additionalProperties: false,
    description:
      "With `site`: a one-time code (sent by text message or email) instead of a password: the card shows one box per digit. Never saved; type it at once.",
  } as const;
  const label = {
    type: "string",
    maxLength: MAX_SECRET_LABEL,
    description: "What the person reads, in their language (`Senha da Conta Google`). `name` stays yours.",
  } as const;
  const purpose = {
    type: "string",
    minLength: 1,
    maxLength: 300,
    description: "Why you need it, in one sentence, shown to the person",
  } as const;
  return {
    name: REQUEST_SECRET_TOOL,
    description: [
      opts.browserOnly
        ? "Ask the person who asked you for a password or code to sign in on a site in your browser, and whenever they ask to send one privately. They type it in a private card; it goes encrypted straight to your computer, never through the chat or you, and it will only ever be typed on that one site (`site`, the login page's address). Never ask for passwords or codes in a normal message. `name` is UPPER_SNAKE_CASE. Give `label`, `username` when you know the account, and `code` for a one-time code. Your run pauses until they answer (15 minutes at most); you then get only whether it arrived. Type it with `browser_type_secret`. Not for an account you make yourself: `browser_make_password`."
        : "Ask the person who asked you for a secret your computer needs: a key no connector covers, the code that finishes a sign-in, .env values. They type it in a private card; it goes encrypted straight to your computer, never through the chat or you. Never ask for passwords, tokens or codes in a normal message. `name` is UPPER_SNAKE_CASE; `target` is `env` (an environment variable in your commands) or `file` (a path in your workspace, e.g. `.npmrc` or `.env`, written with mode 600). Give `label`. For a site your browser signs in to, give `site` (and `username` when you know it, or `code` for a one-time code). Your run pauses until they answer (15 minutes at most); you then get only whether it arrived. Use it by name, never print it. Look in the Vault first (`vault_list`) when you have it: a saved login or key needs no request. Not for a password you can make yourself: `browser_make_password`, `vault_make_password`.",
      AGAIN,
    ].join(" "),
    scope: opts.scope,
    inputSchema: opts.browserOnly
      ? {
          type: "object",
          properties: {
            name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
            label,
            purpose,
            site,
            username,
            code,
          },
          required: ["name", "purpose", "site"],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: {
            name: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
            label,
            purpose,
            target: { enum: ["env", "file"], description: "env (default) or file" },
            path: { type: "string", maxLength: 300, description: "With target file: where it goes in your workspace" },
            site,
            username,
            code,
          },
          required: ["name", "purpose"],
          additionalProperties: false,
        },
    describe: (input) => ({ title: `Ask for ${friendlyLabel(input.label) ?? "a secret"}` }),
    async execute(input, ctx) {
      try {
        const requester = await requesterOfRun(ctx);
        if (!requester) {
          return {
            content: "Only a person's own request can ask them for a secret (not a routine or another agent).",
            isError: true,
          };
        }
        const name = str(input.name);
        if (isReservedSecretName(name)) {
          return {
            content: `${name} is reserved: it would change where an AI sign-in or its requests go. Pick another name.`,
            isError: true,
          };
        }
        const file =
          !opts.browserOnly && (input.target === "file" || (input.target === undefined && Boolean(str(input.path))));
        const path = file ? pathInOwnFolder(opts.toolPath?.(str(input.path)) ?? "", ctx.agentId) : "";
        if (file && (!path || path === ".agentes" || path.startsWith(".agentes/") || isAbsoluteMachinePath(path))) {
          return { content: "With target file, give a path inside your workspace (e.g. .npmrc).", isError: true };
        }
        const rawSite = str(input.site).trim();
        const origin = rawSite ? secretSite(rawSite) : null;
        if ((rawSite || opts.browserOnly) && !origin) {
          return { content: "`site` must be a web address (https://example.com/login).", isError: true };
        }
        // A username and a code go with a site's sign-in only (ADR 0144).
        const user = str(input.username).trim().slice(0, MAX_SECRET_USERNAME);
        const digits = codeDigitsOf(input.code);
        if ((user || input.code !== undefined) && (!origin || file)) {
          return {
            content: "`username` and `code` go with `site` (the sign-in page your browser types it on).",
            isError: true,
          };
        }
        if (input.code !== undefined && digits === null) {
          return {
            content: `\`code\` takes \`digits\`, from ${CODE_DIGITS.min} to ${CODE_DIGITS.max}.`,
            isError: true,
          };
        }
        // Once per key and run: a person writing while the run waits on the card made agents ask again, a second
        // card for the same key, answered twice. The open one is waited on again; one this run was already given
        // isn't asked for until it was tried (a refused key's replacement goes on below).
        const mine = await ctx.db
          .select({
            id: schema.secretRequests.id,
            status: schema.secretRequests.status,
            replaces: schema.secretRequests.replaces,
            deliveredAt: schema.secretRequests.deliveredAt,
          })
          .from(schema.secretRequests)
          .where(
            and(
              eq(schema.secretRequests.runId, ctx.runId),
              eq(schema.secretRequests.name, name),
              sql`${schema.secretRequests.site} is not distinct from ${origin}`,
              sql`${schema.secretRequests.targetPath} is not distinct from ${file ? path : null}`,
              // Open: not past its deadline. Given: still on the computer.
              or(
                and(eq(schema.secretRequests.status, "pending"), gt(schema.secretRequests.expiresAt, sql`now()`)),
                and(
                  eq(schema.secretRequests.status, "delivered"),
                  isNull(schema.secretRequests.removedAt),
                  secretStillHeld(),
                ),
              ),
            ),
          );
        const pending = mine.find((r) => r.status === "pending");
        if (pending) {
          return {
            content: `This is the same request for ${name} that is still open: waiting for the person's answer to it.`,
            waitForSecret: { requestId: pending.id },
          };
        }
        const given = mine.find((r) => r.status === "delivered" && !r.replaces && r.deliveredAt);
        if (given?.deliveredAt && !(await triedSince(ctx, given.deliveredAt))) {
          return {
            content: `${name} was already delivered to your computer in this task: use it by name, don't ask again.`,
          };
        }
        const open = await ctx.db
          .select({ id: schema.secretRequests.id })
          .from(schema.secretRequests)
          .where(and(eq(schema.secretRequests.runId, ctx.runId), eq(schema.secretRequests.status, "pending")));
        if (open.length >= MAX_PENDING_SECRETS) {
          return { content: `At most ${MAX_PENDING_SECRETS} secret requests at a time.`, isError: true };
        }
        const row = await opts.onComputer(ctx, async (computer) => {
          const [held] = await ctx.db
            .select({
              runId: schema.secretRequests.runId,
              replaces: schema.secretRequests.replaces,
              givenBy: schema.secretRequests.requestedForUserId,
              giver: schema.users.name,
            })
            .from(schema.secretRequests)
            .leftJoin(schema.users, eq(schema.users.id, schema.secretRequests.requestedForUserId))
            .where(
              and(
                eq(schema.secretRequests.orgId, ctx.orgId),
                eq(schema.secretRequests.agentId, ctx.agentId),
                eq(schema.secretRequests.name, name),
                eq(schema.secretRequests.machineId, computer.machineId),
                eq(schema.secretRequests.status, "delivered"),
                isNull(schema.secretRequests.removedAt),
                // A site's password past the minutes its runner keeps it is gone: nothing to replace (ADR 0144 §6).
                secretStillHeld(),
              ),
            )
            .limit(1);
          // The replacement this run asked for was refused too: a second one would only loop.
          if (held?.replaces && held.runId === ctx.runId) {
            return {
              refused: `The ${name} you were just given was refused too. Don't ask for it again: say in one line what failed and stop.`,
            };
          }
          // A key is shared by every run of the agent: only its giver, the agent's owner or an admin swaps it.
          if (
            held &&
            held.givenBy !== requester &&
            !(await requireComputerManager(ctx.db, requester, ctx.orgId, ctx.agentId).then(
              () => true,
              () => false,
            ))
          ) {
            const giver = held.giver ?? "the person who gave it";
            return {
              refused: `${name} was given by ${giver}; only ${giver}, your owner or an admin can replace it. Don't ask for it: say in the conversation what failed with it and that ${giver} gave it.`,
            };
          }
          const id = Bun.randomUUIDv7();
          const { publicKey, sites } = await secretOnComputer(computer, { action: "keypair", requestId: id });
          if (!publicKey) throw new Error("the computer made no key");
          // A site's password is for the browser alone where the runner keeps it so; an older one gets a variable.
          const kind = file ? "file" : origin && sites === true ? "site" : "env";
          const label = friendlyLabel(input.label);
          // Its reason is read as written: the agent's own name for it stays out of it.
          const said = str(input.purpose)
            .trim()
            .replaceAll(name, secretLabelOf({ label, site: origin, name }));
          const [inserted] = await ctx.db
            .insert(schema.secretRequests)
            .values({
              id,
              orgId: ctx.orgId,
              runId: ctx.runId,
              agentId: ctx.agentId,
              channelId: ctx.channelId,
              toolUseId: ctx.toolUseId ?? id,
              requestedForUserId: requester,
              name,
              label,
              // The person sees the one site a browser password may be typed on.
              purpose: origin ? `${said} (${new URL(origin).host})` : said,
              site: origin,
              username: user || null,
              codeDigits: digits,
              targetKind: kind,
              targetPath: file ? path : null,
              machineId: computer.machineId,
              publicKey,
              replaces: held !== undefined,
              expiresAt: new Date(Date.now() + SECRET_TTL_MS),
            })
            .returning();
          if (!inserted) throw new Error("the request was not saved");
          await recordAudit(ctx.db, {
            orgId: ctx.orgId,
            actor: { type: "agent", id: ctx.agentId },
            action: "secret.requested",
            target: { type: "agent", id: ctx.agentId },
            details: {
              requestId: id,
              name: secretLabelOf(inserted),
              target: kind === "file" ? { kind, path } : kind === "site" && origin ? { kind, site: origin } : { kind },
              requestedFor: requester,
              ...(held ? { replaces: true } : {}),
              ...(digits ? { codeDigits: digits } : {}),
            },
          });
          return inserted;
        });
        if ("refused" in row) return { content: row.refused, isError: true };
        await supersedeOlderSecretRequests({ db: ctx.db, pubsub: opts.pubsub }, row);
        return { content: "", waitForSecret: { requestId: row.id } };
      } catch (error) {
        return failed(error);
      }
    },
  };
}

/** Whether the run called a tool other than `request_secret` after `since` (so a key given then could have been refused). */
async function triedSince(ctx: ToolContext, since: Date) {
  const steps = schema.agentRunSteps;
  const [call] = await ctx.db
    .select({ id: steps.id })
    .from(steps)
    .where(
      and(
        eq(steps.runId, ctx.runId),
        eq(steps.kind, "tool_call"),
        gt(steps.createdAt, since),
        ne(sql`${steps.data}->>'name'`, REQUEST_SECRET_TOOL),
      ),
    )
    .limit(1);
  return call !== undefined;
}

/** `code.digits` as the request keeps it, or null when it isn't a whole number of boxes the card can show. */
export function codeDigitsOf(raw: unknown): number | null {
  const digits = (raw as { digits?: unknown } | null | undefined)?.digits;
  return typeof digits === "number" &&
    Number.isInteger(digits) &&
    digits >= CODE_DIGITS.min &&
    digits <= CODE_DIGITS.max
    ? digits
    : null;
}
