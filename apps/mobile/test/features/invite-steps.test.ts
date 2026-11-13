import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@agenteschat/client";
import {
  ASK_STEPS,
  type Asked,
  askAction,
  askBack,
  askedOf,
  askProgress,
  claimAnswer,
  claimFailedForNow,
  EMAIL_ACTIONS,
  emailBack,
  emailStart,
  resumesAsk,
  storedAsked,
} from "../../src/features/auth/invite-steps";

const TOKEN = "a".repeat(32);
const ASKED: Asked = {
  token: TOKEN,
  key: "request-1.secret",
  name: "Rafael Costa",
  email: "rafael@acme.com",
  org: "Acme",
  server: "https://app.agentes.chat",
};

describe("asking through a link", () => {
  test("three screens: the e-mail, its code, then the person, in that order", () => {
    expect(ASK_STEPS).toEqual(["email", "code", "you"]);
    expect(ASK_STEPS.map((step) => askProgress(step).n)).toEqual([1, 2, 3]);
    expect(askProgress("you")).toEqual({ n: 3, total: 3 });
  });

  test("Back never lands on a code already typed, and the first step leaves", () => {
    expect(askBack("email")).toBeNull();
    expect(askBack("code")).toBe("email");
    expect(askBack("you")).toBe("email");
  });

  test("only sending the code is bot-checked", () => {
    expect(ASK_STEPS.map(askAction)).toEqual(["ask-code", "ask-code", null]);
  });
});

describe("an email invitation asks only what's missing", () => {
  test("a new address gives a name, one with a password types it, the rest get their provider", () => {
    expect(emailStart({ exists: false, password: false, providers: [] })).toBe("name");
    expect(emailStart({ exists: true, password: true, providers: ["google"] })).toBe("password");
    expect(emailStart({ exists: true, password: false, providers: ["apple"] })).toBe("social");
  });

  test("a preview that doesn't say reads as a new address", () => {
    expect(emailStart(undefined)).toBe("name");
  });

  test("Back returns to the address's own first step, or leaves", () => {
    expect(emailBack("name", "name")).toBeNull();
    expect(emailBack("password", "password")).toBeNull();
    expect(emailBack("newPassword", "name")).toBe("name");
    expect(emailBack("forgot", "password")).toBe("password");
    expect(emailBack("sent", "social")).toBe("social");
  });

  test("the steps that send something carry a bot check for that action", () => {
    expect(EMAIL_ACTIONS).toEqual({
      name: "sign-up",
      newPassword: "sign-up",
      password: "sign-in",
      forgot: "password-reset",
    });
  });
});

describe("the request kept on the phone", () => {
  test("reads back what was stored", () => {
    expect(askedOf(storedAsked(ASKED))).toEqual(ASKED);
  });

  test("nothing, and anything malformed, reads as no request", () => {
    expect(askedOf(null)).toBeNull();
    expect(askedOf("")).toBeNull();
    expect(askedOf("not json")).toBeNull();
    expect(askedOf("null")).toBeNull();
    expect(askedOf("7")).toBeNull();
    expect(askedOf(storedAsked({ ...ASKED, key: "" }))).toBeNull();
    expect(askedOf(storedAsked({ ...ASKED, token: "../evil" }))).toBeNull();
    expect(askedOf(storedAsked({ ...ASKED, server: "" }))).toBeNull();
  });

  test("words that went missing don't lose the key", () => {
    const { name: _name, email: _email, org: _org, ...bare } = ASKED;
    expect(askedOf(JSON.stringify(bare))).toEqual({ ...ASKED, name: "", email: "", org: "" });
  });
});

describe("waiting for the answer", () => {
  test("a failure for a moment never ends the wait", () => {
    expect(claimFailedForNow(new TypeError("Network request failed"))).toBe(true);
    expect(claimFailedForNow(new ApiError(500, "internal", ""))).toBe(true);
    expect(claimFailedForNow(new ApiError(503, "unavailable", ""))).toBe(true);
    expect(claimFailedForNow(new ApiError(408, "timeout", ""))).toBe(true);
    expect(claimFailedForNow(new ApiError(429, "rate_limited", ""))).toBe(true);
  });

  test("any other refusal is the last word", () => {
    expect(claimFailedForNow(new ApiError(400, "invalid_request", ""))).toBe(false);
    expect(claimFailedForNow(new ApiError(403, "forbidden", ""))).toBe(false);
  });

  test("each answer", () => {
    expect(claimAnswer({ status: "pending" })).toBeNull();
    expect(claimAnswer({ status: "in", orgId: "o1", signIn: "one-time" })).toEqual({ state: "in", orgId: "o1" });
    expect(claimAnswer({ status: "denied", reason: "Vaga fechada" })).toEqual({
      state: "denied",
      reason: "Vaga fechada",
    });
    expect(claimAnswer({ status: "denied", reason: null })).toEqual({ state: "denied", reason: null });
    expect(claimAnswer({ status: "closed" })).toEqual({ state: "ended" });
    expect(claimAnswer(null)).toEqual({ state: "ended" });
  });

  test("the answer never carries the one-time sign-in", () => {
    expect(JSON.stringify(claimAnswer({ status: "in", orgId: "o1", signIn: "one-time" }))).not.toContain("one-time");
  });

  test("reopening returns to the wait only from the sign-in, never over a link the app opened with", () => {
    expect(resumesAsk("/sign-in")).toBe(true);
    expect(resumesAsk("/")).toBe(false);
    expect(resumesAsk(`/invite/${TOKEN}`)).toBe(false);
    expect(resumesAsk("/reset-password")).toBe(false);
    expect(resumesAsk("/connect")).toBe(false);
  });
});

describe("an invitation to a personal workspace (ADR 0159): never its name, who invited instead", () => {
  const src = (file: string) =>
    readFileSync(join(import.meta.dir, "..", "..", "src", "features", "auth", file), "utf8");

  test("each screen of the way in reads the invitation's mode", () => {
    const screen = src("InviteScreen.tsx");
    expect(screen).toContain('? t("invite.calledYouPersonal", { name: by })');
    expect(screen).toContain('label={personal ? t("invite.enterPersonal") : t("mobile.invite.accept", { org })}');
    expect(screen).toContain('title = t(modeKey(preview, "invite.ask.title"), { org });');
    const email = src("EmailSteps.tsx");
    expect(email).toContain('const enterLabel = t(modeKey(preview, "invite.enter"), { org });');
    expect(email).toContain('t("invite.personalName", { name: preview.invitedBy })');
    expect(src("LinkSteps.tsx")).toContain("email: isPersonal(preview)");
    expect(src("AskWaiting.tsx")).toContain('t(modeKey(words, "invite.ask.waitTitle"), { org })');
  });
});
