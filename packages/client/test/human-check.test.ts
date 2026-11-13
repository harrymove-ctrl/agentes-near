import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import { authErrorText, errorText, knownErrorText } from "../src/lib/errors";
import { createHumanCheck, humanCheckHeaders, isHumanCheckRefusal, withHumanCheck } from "../src/lib/human-check";

const t = ((key: string) => key) as unknown as TFunction;

describe("createHumanCheck: one widget's tokens", () => {
  test("the current token at once, else the next one the widget gives", async () => {
    const check = createHumanCheck();
    const next = check.token();
    check.give("tok-1");
    expect(await next).toBe("tok-1");
    expect(await check.token()).toBe("tok-1");
    // Spent by a call: the next one waits for a new token. An expired one isn't given out either.
    check.reset();
    const after = check.token();
    check.give("tok-2");
    expect(await after).toBe("tok-2");
    check.expire();
    const fresh = check.token();
    check.give("tok-3");
    expect(await fresh).toBe("tok-3");
  });

  test("unavailable when the script or the widget fails (with Turnstile's code), or after the wait", async () => {
    const failing = createHumanCheck();
    const waiting = failing.token();
    failing.fail();
    expect(await waiting).toBe("unavailable");
    expect(await failing.token()).toBe("unavailable");
    failing.fail(110100);
    expect(await failing.token()).toBe("unavailable:110100");
    // The widget recovers on its own: its token replaces the failure.
    failing.give("tok");
    expect(await failing.token()).toBe("tok");

    const slow = createHumanCheck(20);
    const started = Date.now();
    expect(await slow.token()).toBe("unavailable");
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("while the widget asks the person to click, a call waits for them past the 30 s", async () => {
    const check = createHumanCheck(20);
    const before = check.token();
    check.hold();
    const during = check.token();
    await Bun.sleep(60);
    let settled = false;
    void Promise.all([before, during]).then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    check.give("clicked");
    expect(await Promise.all([before, during])).toEqual(["clicked", "clicked"]);
  });
});

describe("withHumanCheck", () => {
  /** A widget handing out tok-1, tok-2… and counting its resets. */
  function widget() {
    let n = 0;
    const log: string[] = [];
    return {
      log,
      check: {
        token: async () => {
          const token = `tok-${++n}`;
          log.push(`token ${token}`);
          return token;
        },
        reset: () => log.push("reset"),
      },
    };
  }

  test("no check on the server: the call goes once, without a token", async () => {
    const sent: (string | undefined)[] = [];
    const send = async (token: string | undefined) => {
      sent.push(token);
      return "ok";
    };
    expect(await withHumanCheck(null, send)).toBe("ok");
    expect(sent).toEqual([undefined]);
    expect(humanCheckHeaders(undefined)).toBeUndefined();
    expect(humanCheckHeaders("tok")).toEqual({ "x-captcha-response": "tok" });
  });

  test("a token per call and a reset after it, answered or refused", async () => {
    const { check, log } = widget();
    expect(await withHumanCheck(check, async (token) => token)).toBe("tok-1");
    await expect(
      withHumanCheck(check, async () => {
        throw new ApiError(429, "rate_limited", "Too many requests. Try again later.");
      }),
    ).rejects.toThrow("Too many requests");
    expect(log).toEqual(["token tok-1", "reset", "token tok-2", "reset"]);
  });

  test("human_check once: sent again with a fresh token; twice: the refusal stands", async () => {
    const { check, log } = widget();
    let calls = 0;
    const refuseFirst = async (token: string | undefined) => {
      if (++calls === 1) throw new ApiError(403, "human_check", "Couldn't confirm a person is asking. Try again.");
      return token;
    };
    expect(await withHumanCheck(check, refuseFirst)).toBe("tok-2");
    expect(log).toEqual(["token tok-1", "reset", "token tok-2", "reset"]);

    // Better Auth answers with a result rather than throwing.
    const refused = { ok: false as const, status: 403, code: "human_check", message: "Couldn't confirm" };
    let tries = 0;
    const refuse = async () => {
      tries++;
      return refused;
    };
    expect(await withHumanCheck(widget().check, refuse)).toEqual(refused);
    expect(tries).toBe(2);
  });

  test("never again on human_check_blocked: another try can't load the check", async () => {
    let tries = 0;
    const blocked = new ApiError(403, "human_check_blocked", "The bot check didn't load.");
    await expect(
      withHumanCheck(widget().check, async () => {
        tries++;
        throw blocked;
      }),
    ).rejects.toBe(blocked);
    expect(tries).toBe(1);
    expect(isHumanCheckRefusal("human_check_blocked")).toBe(true);
    expect(isHumanCheckRefusal("human_check")).toBe(true);
    expect(isHumanCheckRefusal("FORBIDDEN")).toBe(false);
  });
});

test("the words: the check's refusals, and Better Auth's by status and code before its own message", () => {
  expect(errorText(t, new ApiError(403, "human_check", "x"))).toBe("errors.humanCheck");
  expect(errorText(t, new ApiError(403, "human_check_blocked", "x"))).toBe("errors.humanCheckBlocked");
  expect(authErrorText(t, { status: 403, code: "human_check", message: "x" })).toBe("errors.humanCheck");
  expect(authErrorText(t, { status: 403, code: "human_check_blocked", message: "x" })).toBe("errors.humanCheckBlocked");
  expect(authErrorText(t, { status: 429, message: "Too many requests" })).toBe("auth.tooManyTries");
  expect(authErrorText(t, { status: 403, code: "ACCOUNT_BLOCKED", message: "x" })).toBe("auth.accountBlocked");
  // Its own words (English, every language's fallback), never a 5xx's.
  const tEn = Object.assign((key: string) => key, { lng: "en" }) as unknown as typeof t;
  expect(authErrorText(tEn, { status: 400, message: "Password too short" })).toBe("Password too short");
  expect(authErrorText(t, { status: 400, message: "Password too short" })).toBe("Password too short");
  expect(authErrorText(tEn, { status: 500, message: "Internal Server Error" })).toBe("common.ourSide");
});

test("a limit with no words of its own reads as too many tries, never the server's English", () => {
  expect(errorText(t, new ApiError(429, "rate_limited", "Too many photo changes. Try again later."))).toBe(
    "common.tooMany",
  );
  expect(errorText(t, new ApiError(429, "http_429", "Too Many Requests"))).toBe("common.tooMany");
  expect(knownErrorText(t, new ApiError(409, "rate_limited", "Slow down"))).toBe("common.tooMany");
  expect(errorText(t, new ApiError(429, "join.code_limit", "x"))).toBe("errors.code.limit");
  expect(knownErrorText(t, new ApiError(409, "conflict", "Reload and try again."))).toBeNull();
});
