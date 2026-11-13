import {
  earlyAccessHeaders,
  earlyAccessState,
  INVITATION_MAIL_HEADER,
  INVITATION_TOKEN_HEADER,
} from "@agenteschat/client/lib/guards";
import { humanCheckHeaders } from "@agenteschat/client/lib/human-check";
import { createAuthClient } from "better-auth/client";
import type { AuthClient, AuthResult } from "./client";

type Refusal = { status?: number; message?: string; code?: string; kind?: unknown; cloud?: unknown } | null;

/** No answer at all (the fetch threw): status 0, which `authErrorText` says as offline or out of reach. */
const NO_ANSWER: AuthResult = { ok: false, status: 0, code: "network", message: "" };

/** A call's refusal as the pages read it; one that got no answer settles as `NO_ANSWER`, so no page spins forever. */
async function toResult(call: Promise<{ error?: Refusal }>): Promise<AuthResult> {
  let error: Refusal | undefined;
  try {
    ({ error } = await call);
  } catch {
    return NO_ANSWER;
  }
  return error
    ? {
        ok: false,
        status: error.status ?? 500,
        message: error.message ?? "",
        ...(error.code ? { code: error.code } : {}),
        ...(typeof error.kind === "string" ? { kind: error.kind } : {}),
        ...(error.cloud === true ? { cloud: true } : {}),
      }
    : { ok: true };
}

/** A call's data, or `fallback` when it got none (no answer included). */
const dataOr = async <T, F>(call: Promise<{ data?: T | null }>, fallback: F): Promise<T | F> =>
  call.then(
    (res) => res.data ?? fallback,
    () => fallback,
  );

/**
 * Better Auth client for the web app (same origin, `/api/auth`). Every request says the app's language
 * (`language`) in `Accept-Language`: an account made here keeps it, and its first emails come in it.
 */
export function createBetterAuthClient(origin = window.location.origin, language?: () => string): AuthClient {
  const client = createAuthClient({
    baseURL: origin,
    basePath: "/api/auth",
    fetchOptions: {
      onRequest: (request) => {
        if (language) request.headers.set("accept-language", language());
      },
    },
  });
  return {
    signIn: ({ email, password }, humanCheck) =>
      toResult(client.signIn.email({ email, password, fetchOptions: { headers: humanCheckHeaders(humanCheck) } })),
    signUp: ({ name, email, password, access, invitation }, humanCheck) =>
      toResult(
        client.signUp.email({
          name,
          email,
          password,
          fetchOptions: {
            headers: {
              ...humanCheckHeaders(humanCheck),
              ...earlyAccessHeaders(access),
              ...(invitation ? { [INVITATION_TOKEN_HEADER]: invitation.token } : {}),
              ...(invitation?.mail ? { [INVITATION_MAIL_HEADER]: invitation.mail } : {}),
            },
          },
        }),
      ),
    updateName: (name) => toResult(client.updateUser({ name })),
    sendVerificationEmail: (email) => toResult(client.sendVerificationEmail({ email })),
    signInSocial: (provider, callbackURL, earlyAccess, errorCallbackURL = "/login") =>
      toResult(
        client.signIn.social({
          provider,
          callbackURL,
          errorCallbackURL,
          ...earlyAccessState(earlyAccess),
        }),
      ),
    requestPasswordReset: ({ email, redirectTo }, humanCheck) =>
      toResult(
        client.requestPasswordReset({ email, redirectTo, fetchOptions: { headers: humanCheckHeaders(humanCheck) } }),
      ),
    resetPassword: ({ token, newPassword }) => toResult(client.resetPassword({ token, newPassword })),
    signOut: async () => {
      await client.signOut();
    },
    desktopOpen: (challenge) =>
      dataOr(
        client.$fetch<{ requestId: string; code: string }>("/desktop/open", { method: "POST", body: { challenge } }),
        null,
      ),
    desktopRequestCode: async (requestId) =>
      (
        await dataOr(
          client.$fetch<{ code: string | null }>("/desktop/request", { method: "POST", body: { requestId } }),
          null,
        )
      )?.code ?? null,
    desktopHandoff: (requestId) => toResult(client.$fetch("/desktop/handoff", { method: "POST", body: { requestId } })),
    signInOneTime: (token) => toResult(client.$fetch("/sign-in/one-time-token", { method: "POST", body: { token } })),
    desktopRedeem: async (verifier) =>
      (
        await dataOr(
          client.$fetch<{ signedIn: boolean }>("/desktop/redeem", { method: "POST", body: { verifier } }),
          null,
        )
      )?.signedIn === true,
    ownerClaim: (input) => toResult(client.$fetch("/owner-claim", { method: "POST", body: input })),
  };
}
