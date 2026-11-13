import type { Database } from "@agenteschat/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { ALL_SEEDED_EMAILS } from "./seed";

const ALLOWED_DEMO_EMAILS = new Set(ALL_SEEDED_EMAILS);

export function zenDemoSignIn(_deps: { db: Database }): BetterAuthPlugin {
  return {
    id: "zen-demo-sign-in",
    endpoints: {
      zenDemoLogin: createAuthEndpoint(
        "/zen-demo-login",
        {
          method: "POST",
          body: z.object({ email: z.email().max(254) }),
          use: [formCsrfMiddleware],
        },
        async (ctx) => {
          if (process.env.ZEN_DEMO_MODE === "false") {
            throw new APIError("NOT_FOUND", { message: "Demo sign-in is disabled" });
          }
          const email = ctx.body.email.trim().toLowerCase();
          if (!ALLOWED_DEMO_EMAILS.has(email)) {
            throw new APIError("FORBIDDEN", {
              message: "Only seeded Ergo ZEN demo personas can use 1-click sign-in",
            });
          }
          const found = await ctx.context.internalAdapter.findUserByEmail(email);
          const user = found?.user;
          if (!user) {
            throw new APIError("NOT_FOUND", { message: `Demo persona ${email} is not seeded yet` });
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not create demo session" });
          }
          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            ok: true,
            user: { id: user.id, name: user.name, email: user.email },
          });
        },
      ),
    },
  };
}
