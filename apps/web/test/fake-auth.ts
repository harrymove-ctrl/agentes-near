import type { AuthClient, AuthResult } from "@/auth/client";

/** A call's arguments, with the bot check's token only when one was sent. */
const withToken = (input: unknown, humanCheck: string | undefined) =>
  humanCheck === undefined ? [input] : [input, humanCheck];

export function createFakeAuth(
  options: {
    signIn?: AuthResult;
    signUp?: AuthResult;
    reset?: AuthResult;
    redeem?: boolean;
    open?: { requestId: string; code: string } | null;
    requestCode?: string | null;
    oneTime?: AuthResult;
    claim?: AuthResult;
    verification?: AuthResult;
    updateName?: AuthResult;
    onSignIn?: () => void;
  } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const auth: AuthClient = {
    signIn: async (input, humanCheck) => {
      calls.push({ method: "signIn", args: withToken(input, humanCheck) });
      const result = options.signIn ?? { ok: true };
      if (result.ok) options.onSignIn?.();
      return result;
    },
    signUp: async (input, humanCheck) => {
      calls.push({ method: "signUp", args: withToken(input, humanCheck) });
      return options.signUp ?? { ok: true };
    },
    updateName: async (name) => {
      calls.push({ method: "updateName", args: [name] });
      return options.updateName ?? { ok: true };
    },
    sendVerificationEmail: async (email) => {
      calls.push({ method: "sendVerificationEmail", args: [email] });
      return options.verification ?? { ok: true };
    },
    signInSocial: async (provider, callbackURL, earlyAccess, errorCallbackURL) => {
      calls.push({
        method: "signInSocial",
        args: errorCallbackURL
          ? [provider, callbackURL, earlyAccess, errorCallbackURL]
          : earlyAccess
            ? [provider, callbackURL, earlyAccess]
            : [provider, callbackURL],
      });
      return { ok: true };
    },
    requestPasswordReset: async (input, humanCheck) => {
      calls.push({ method: "requestPasswordReset", args: withToken(input, humanCheck) });
      return { ok: true };
    },
    resetPassword: async (input) => {
      calls.push({ method: "resetPassword", args: [input] });
      return options.reset ?? { ok: true };
    },
    signOut: async () => {
      calls.push({ method: "signOut", args: [] });
    },
    desktopOpen: async (challenge) => {
      calls.push({ method: "desktopOpen", args: [challenge] });
      return options.open === undefined ? { requestId: "r".repeat(43), code: "KQ7M-3XPF" } : options.open;
    },
    desktopRequestCode: async (requestId) => {
      calls.push({ method: "desktopRequestCode", args: [requestId] });
      return options.requestCode === undefined ? "KQ7M-3XPF" : options.requestCode;
    },
    desktopHandoff: async (requestId) => {
      calls.push({ method: "desktopHandoff", args: [requestId] });
      return { ok: true };
    },
    desktopRedeem: async (verifier) => {
      calls.push({ method: "desktopRedeem", args: [verifier] });
      return options.redeem ?? false;
    },
    signInOneTime: async (token) => {
      calls.push({ method: "signInOneTime", args: [token] });
      return options.oneTime ?? { ok: true };
    },
    ownerClaim: async (input) => {
      calls.push({ method: "ownerClaim", args: [input] });
      return options.claim ?? { ok: true };
    },
  };
  return { auth, calls };
}
