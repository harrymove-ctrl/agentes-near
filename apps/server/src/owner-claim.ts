import { randomUUID } from "node:crypto";
import { nameIsPassword } from "@agenteschat/client/lib/text";
import type { Config } from "@agenteschat/config";
import { type Database, schema, sql } from "@agenteschat/db";
import { onUserCreated, pinnedOwner, recordSignUp, safeEqual, sha256 } from "@agenteschat/engine";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { NAME_IS_PASSWORD, NAME_IS_PASSWORD_MESSAGE } from "./auth";
import type { Logger } from "./logger";

/**
 * The installation's first account, its owner (ADR 0060 §6), made by whoever holds the secret set for
 * it instead of by whoever signs up first:
 *
 * - a claim (`OWNER_CLAIM_SHA256`): the link `/owner#claim=<token>`, with a name, an email and a
 *   password, once;
 * - the owner key (`OWNER_KEY_SHA256`, the desktop app's, which runs the server on that computer):
 *   the owner with no password, then a one-time sign-in for them whenever the app asks. The key
 *   never reaches a web view.
 *
 * While either is set and no account exists, every other sign-up is refused (`isSignupAllowed`).
 * The account is written in one transaction holding an advisory lock, so two requests can't both
 * find the installation without accounts; after it the claim is inert.
 */

/** A token or key: 32 random bytes in base64url, or near that. */
const SECRET = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/);
const Name = z.string().trim().min(1).max(100);
const Email = z.email().max(254);

/** Whether `secret` is the one whose SHA-256 the install wrote. */
const matches = (secret: string, hash: string | undefined) => Boolean(hash) && safeEqual(sha256(secret), hash ?? "");

class OwnerExists extends Error {}

export interface OwnerSignInDeps {
  db: Database;
  config: Config;
  log: Logger;
  /** A one-time sign-in for this user (`POST /api/auth/sign-in/one-time-token`). */
  mint: (
    adapter: {
      createVerificationValue: (v: { identifier: string; value: string; expiresAt: Date }) => Promise<unknown>;
    },
    userId: string,
  ) => Promise<{ token: string; expiresIn: number }>;
}

export function ownerSignIn(deps: OwnerSignInDeps) {
  const { db, config, log } = deps;

  /** Writes the owner, with a password hash or none; throws `OwnerExists` when an account is there. */
  async function createOwner(input: { id: string; name: string; email: string; passwordHash: string | null }) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agentes.chat:first-account'))`);
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.users);
      if ((row?.n ?? 0) > 0) throw new OwnerExists();
      await tx.insert(schema.users).values({ id: input.id, name: input.name, email: input.email.toLowerCase() });
      if (input.passwordHash) {
        await tx.insert(schema.accounts).values({
          id: randomUUID(),
          accountId: input.id,
          providerId: "credential",
          userId: input.id,
          password: input.passwordHash,
        });
      }
    });
    // What the sign-up hooks do for any other first account.
    await onUserCreated(db, input.id).catch((error) =>
      log.error("post-signup setup failed", { userId: input.id, error }),
    );
    if (input.passwordHash) {
      await recordSignUp(db, { userId: input.id, providerId: "credential" }).catch((error) =>
        log.error("operator event failed", { type: "user.signed_up", error }),
      );
    }
  }

  return {
    id: "owner-sign-in",
    endpoints: {
      ownerClaim: createAuthEndpoint(
        "/owner-claim",
        {
          method: "POST",
          body: z.object({ token: SECRET, name: Name, email: Email, password: z.string().min(8).max(128) }),
          use: [formCsrfMiddleware],
        },
        async (ctx) => {
          if (!config.OWNER_CLAIM_SHA256) throw new APIError("NOT_FOUND", { message: "This server has no owner link" });
          if (!matches(ctx.body.token, config.OWNER_CLAIM_SHA256)) {
            throw new APIError("UNAUTHORIZED", { message: "This isn't this server's owner link" });
          }
          if (nameIsPassword(ctx.body.name, ctx.body.password)) {
            throw new APIError("BAD_REQUEST", { code: NAME_IS_PASSWORD, message: NAME_IS_PASSWORD_MESSAGE });
          }
          const id = ctx.context.generateId({ model: "user" }) || randomUUID();
          const passwordHash = await ctx.context.password.hash(ctx.body.password);
          try {
            await createOwner({ id, name: ctx.body.name, email: ctx.body.email, passwordHash });
          } catch (error) {
            if (error instanceof OwnerExists) {
              throw new APIError("CONFLICT", { message: "This server already has its owner: sign in instead" });
            }
            throw error;
          }
          const user = await ctx.context.internalAdapter.findUserById(id);
          const session = user ? await ctx.context.internalAdapter.createSession(id) : null;
          if (!user || !session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Couldn't sign in" });
          await setSessionCookie(ctx, { session, user });
          ctx.setStatus(201);
          return ctx.json({ user: { id: user.id, name: user.name, email: user.email } });
        },
      ),
      ownerKey: createAuthEndpoint(
        "/owner-key",
        {
          method: "POST",
          body: z.object({ key: SECRET, name: Name.optional(), email: Email.optional() }),
          use: [formCsrfMiddleware],
        },
        async (ctx) => {
          if (!config.OWNER_KEY_SHA256) throw new APIError("NOT_FOUND", { message: "This server has no owner key" });
          if (!matches(ctx.body.key, config.OWNER_KEY_SHA256)) {
            throw new APIError("UNAUTHORIZED", { message: "This isn't this server's owner key" });
          }
          let ownerId = await pinnedOwner(db);
          if (!ownerId) {
            const { name, email } = ctx.body;
            if (!name || !email)
              throw new APIError("BAD_REQUEST", { message: "The owner's name and email are needed" });
            const id = ctx.context.generateId({ model: "user" }) || randomUUID();
            try {
              await createOwner({ id, name, email, passwordHash: null });
              ownerId = id;
            } catch (error) {
              if (!(error instanceof OwnerExists)) throw error;
              // Made by a request just before this one: sign in that owner.
              ownerId = await pinnedOwner(db);
            }
          }
          if (!ownerId) throw new APIError("INTERNAL_SERVER_ERROR", { message: "No owner account" });
          // `userId`: the desktop app signs its window in as the owner after an address change only when the owner
          // was the one signed in there.
          return ctx.json({ ...(await deps.mint(ctx.context.internalAdapter, ownerId)), userId: ownerId });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
