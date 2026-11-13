/**
 * The computer brains' accounts on one organization home (ADR 0041): which ones there are and the
 * "Adicionar conta" sign-in. The runner starts the CLI's own sign-in, which opens this computer's
 * browser and finishes by itself; the app only polls `account.status` until it is done.
 *
 * Pure TypeScript (no React, no DOM): the request function and the timers are injected, so tests use it.
 */
import type { AccountKind, RunnerAccountInfo } from "@agenteschat/adapters/machine-protocol";
import type { ControlReplies, ControlRequest } from "@agenteschat/adapters/runner-control";
import { type ClientErrorCode, ControlError } from "./client";

export type AccountsRequest = <R extends ControlRequest>(req: R) => Promise<ControlReplies[R["type"]]>;

/** How often the app asks where a sign-in is. */
export const ACCOUNT_POLL_MS = 2_000;

/** A runner from before accounts answers `bad_request` to the new requests: the cards stay hidden. */
export const isUnsupported = (err: unknown) => err instanceof ControlError && err.code === "bad_request";

/** The accounts of one CLI, the signed-in ones first, then by email. */
export function accountsOf(list: readonly RunnerAccountInfo[], kind: AccountKind): RunnerAccountInfo[] {
  return list
    .filter((a) => a.kind === kind)
    .sort(
      (a, b) =>
        Number(b.loggedIn) - Number(a.loggedIn) ||
        (a.email ?? "￿").localeCompare(b.email ?? "￿") ||
        a.id.localeCompare(b.id),
    );
}

/** `max` → `Max`, `team` → `Team`: the plan as a short word (null when the CLI didn't say). */
export function planLabel(plan: string | undefined): string | null {
  const p = plan?.trim();
  if (!p) return null;
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/** A status error that won't get better by asking again: the sign-in is gone or can't be done here. */
const GONE = new Set<ClientErrorCode>(["not_found", "bad_request", "closed"]);

/** Where "Adicionar conta" is, as the dialog shows it. */
export type LoginView =
  | { phase: "starting" }
  | { phase: "waiting"; loginId: string; url: string; userCode?: string }
  | { phase: "done"; account: RunnerAccountInfo | null }
  | { phase: "failed"; reason: "failed" | "expired" | "error" };

export interface AccountLoginOptions {
  request: AccountsRequest;
  kind: AccountKind;
  onChange: (view: LoginView) => void;
  intervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface AccountLogin {
  /** Stops polling and tells the runner to stop the sign-in (when it is still waiting). */
  cancel(): void;
}

/**
 * Starts one sign-in and polls it until done, failed or expired. A status request that fails
 * (a slow answer) is asked again on the next tick; the runner expires the sign-in on its own.
 */
export function startAccountLogin(options: AccountLoginOptions): AccountLogin {
  const { request, kind, onChange } = options;
  const interval = options.intervalMs ?? ACCOUNT_POLL_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let stopped = false;
  let finished = false;
  let loginId: string | null = null;
  let timer: unknown = null;

  const finish = (view: LoginView) => {
    if (stopped) return;
    finished = true;
    onChange(view);
  };

  const poll = async () => {
    timer = null;
    if (stopped || !loginId) return;
    try {
      const reply = await request({ type: "account.status", loginId });
      if (stopped) return;
      if (reply.state === "done") return finish({ phase: "done", account: reply.account ?? null });
      if (reply.state === "failed" || reply.state === "expired") {
        return finish({ phase: "failed", reason: reply.state });
      }
    } catch (err) {
      if (stopped) return;
      // The sign-in is gone (the runner restarted) or the runner can't do it: no use asking again.
      if (err instanceof ControlError && GONE.has(err.code)) return finish({ phase: "failed", reason: "error" });
    }
    timer = setTimer(() => void poll(), interval);
  };

  onChange({ phase: "starting" });
  request({ type: "account.begin", kind })
    .then((reply) => {
      loginId = reply.loginId;
      if (stopped) {
        // Canceled while the CLI was starting: stop it too.
        void request({ type: "account.cancel", loginId: reply.loginId }).catch(() => {});
        return;
      }
      onChange({
        phase: "waiting",
        loginId: reply.loginId,
        url: reply.url,
        ...(reply.userCode ? { userCode: reply.userCode } : {}),
      });
      timer = setTimer(() => void poll(), interval);
    })
    .catch(() => finish({ phase: "failed", reason: "error" }));

  return {
    cancel() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (loginId && !finished) void request({ type: "account.cancel", loginId }).catch(() => {});
    },
  };
}
