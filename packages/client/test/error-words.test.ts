import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { en as enStrings, ptBR, resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { ApiError, createFileRequester, createRequester, invitationQuery, NetworkError } from "../src/index";
import {
  authErrorText,
  errorText,
  hasWordsFor,
  noAnswer,
  oauthReturnText,
  sendWaits,
  signInRefusalText,
  vaultConnectRefusal,
} from "../src/lib/errors";

const failure = new TypeError("Failed to fetch");
const unreachable = async () => {
  throw failure;
};

describe("a request that got no answer", () => {
  test("is a NetworkError with fetch's words and fetch's error as its cause, still a TypeError", async () => {
    const request = createRequester({ fetch: unreachable });
    const error = await request("/api/app/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as NetworkError).message).toBe("Failed to fetch");
    expect((error as NetworkError).cause).toBe(failure);
    // A message that waits for the connection still does.
    expect(sendWaits(error)).toBe(true);
    const files = createFileRequester({ fetch: unreachable });
    expect(await files.upload("/x", new FormData()).catch((e: unknown) => e)).toBeInstanceOf(NetworkError);
    expect(await files.blob("/x").catch((e: unknown) => e)).toBeInstanceOf(NetworkError);
  });

  test("a request the app stopped stays what it was", async () => {
    const stopped = new DOMException("The operation was aborted.", "AbortError");
    const request = createRequester({
      fetch: async () => {
        throw stopped;
      },
    });
    expect(await request("/x").catch((e: unknown) => e)).toBe(stopped);
  });

  test("noAnswer: none at all, or only the proxy's; never the server's own refusal or a bug", () => {
    expect(noAnswer(new NetworkError(new TypeError("Load failed")))).toBe(true);
    for (const status of [502, 503, 504, 520, 522, 524]) {
      expect(noAnswer(new ApiError(status, `http_${status}`, "Bad Gateway"))).toBe(true);
    }
    // The server's own 503 says why (a computer that can't take it now).
    expect(noAnswer(new ApiError(503, "machine.target_offline", "That computer is offline"))).toBe(false);
    expect(noAnswer(new ApiError(500, "internal_error", "Something went wrong on our side"))).toBe(false);
    expect(noAnswer(new ApiError(404, "not_found", "Not found"))).toBe(false);
    expect(noAnswer(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(noAnswer(undefined)).toBe(false);
  });
});

/** `useTranslation`'s `t` in `lng`: the key itself, for the words to check. */
const tIn = (lng: string) => Object.assign((key: string) => key, { lng }) as unknown as TFunction;
const pt = tIn("pt-BR");
const en = tIn("en");

/** The browser offline while `run` runs (React Native says nothing: never offline). */
function offline<T>(run: () => T): T {
  const own = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  try {
    return run();
  } finally {
    if (own) Object.defineProperty(globalThis, "navigator", own);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

describe("a failed request in the person's words (errorText)", () => {
  test("no answer: offline, else the server out of reach; never fetch's or the proxy's own words", () => {
    const network = new NetworkError(new TypeError("Failed to fetch"));
    const proxy = new ApiError(502, "http_502", "Bad Gateway");
    for (const t of [pt, en]) {
      expect(errorText(t, network)).toBe("common.unreachable");
      expect(errorText(t, proxy)).toBe("common.unreachable");
      expect(errorText(t, new ApiError(530, "http_530", ""))).toBe("common.unreachable");
      expect(offline(() => errorText(t, network))).toBe("common.offline");
      expect(offline(() => errorText(t, proxy))).toBe("common.offline");
    }
  });

  test("a 500 says it failed on our side in both languages, never the server's own line", () => {
    const error = new ApiError(500, "internal_error", "Something went wrong on our side");
    expect(errorText(pt, error)).toBe("common.ourSide");
    expect(errorText(en, error)).toBe("common.ourSide");
  });

  test("a computer that can't take it: offline, paused, too slow or commands off in words; its own refusal as said", () => {
    expect(errorText(pt, new ApiError(409, "machine.offline", "Mac is offline", { name: "Mac" }))).toBe(
      "errors.machine.offline",
    );
    expect(errorText(pt, new ApiError(409, "machine.paused", "Mac is paused", { name: "Mac" }))).toBe(
      "errors.machine.paused",
    );
    expect(errorText(pt, new ApiError(503, "machine.timeout", "the computer Mac did not answer in time"))).toBe(
      "errors.machine.timeout",
    );
    expect(errorText(pt, new ApiError(503, "machine.exec_disabled", "Commands are off"))).toBe(
      "errors.mission.execDisabled",
    );
    const own = "This folder is outside the folders this agent may use.";
    expect(errorText(pt, new ApiError(503, "machine.not_allowed", own))).toBe(own);
  });

  test("a workspace on hold says so and where to bring it back, never a plain 'not now'", () => {
    expect(errorText(pt, new ApiError(409, "workspace_paused", "This workspace is paused"))).toBe("errors.org.paused");
    // The phone has no hold banner, so the line itself says who brings it back.
    expect(ptBR.errors.org.paused).toContain("Quem administra o workspace pode reativá-lo");
    expect(ptBR.errors.org.paused).not.toMatch(/aviso|banner|suporte|[;"“”]/);
  });

  test("a budget or a missing key in the person's words, naming the provider when the server does", () => {
    expect(errorText(pt, new ApiError(402, "budget_exceeded", "This agent has used its monthly budget"))).toBe(
      "agentPage.activity.errors.budget_exceeded",
    );
    const missing = "Add an API key for OpenAI in the workspace settings";
    expect(errorText(pt, new ApiError(400, "missing_credential", missing, { provider: "OpenAI" }))).toBe(
      "agentPage.activity.errors.missing_credential",
    );
    expect(errorText(pt, new ApiError(400, "missing_credential", missing))).toBe(missing);
  });

  test("a 403: a code's own line, else that they can't; never the server's words or an 'ask an admin' guess", () => {
    const why = "Only the channel's creator or an admin can add members";
    expect(errorText(pt, new ApiError(403, "channel.members_forbidden", why))).toBe("errors.channel.membersForbidden");
    expect(errorText(pt, new ApiError(403, "account.not_owner", "Only the account's owner can rename it"))).toBe(
      "errors.account.notOwner",
    );
    expect(errorText(pt, new ApiError(403, "run.cancel_forbidden", "x"))).toBe("errors.run.cancelForbidden");
    expect(errorText(pt, new ApiError(403, "channel.post_denied", "x"))).toBe("channel.perms.readOnlyComposer");
    expect(errorText(pt, new ApiError(403, "forbidden", why))).toBe("common.notAllowed");
    expect(errorText(pt, new ApiError(403, "agent.no_words_yet", "This agent can't be added to a channel"))).toBe(
      "common.notAllowed",
    );
    expect(errorText(pt, new ApiError(403, "bad_origin", "Cross-origin request refused"))).toBe("common.notAllowed");
  });

  test("a runner's internal failure is for the log: the person reads it's on our side", () => {
    expect(errorText(pt, new ApiError(503, "machine.internal", "ENOENT: no such file"))).toBe("common.ourSide");
  });

  test("a 4xx the app doesn't know: the server's own words in English, a plain line in any other language", () => {
    const error = new ApiError(409, "thing.busy", "That thing is busy right now.");
    expect(errorText(en, error)).toBe("That thing is busy right now.");
    const lang = (lng: string) => {
      const instance = i18next.createInstance();
      void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
      return instance.t;
    };
    expect(errorText(lang("en"), error)).toBe("That thing is busy right now.");
    expect(errorText(lang("pt-BR"), error)).toBe(ptBR.errors.said.conflict);
    expect(errorText(lang("pt-BR"), new ApiError(400, "thing.bad", "Bad thing"))).toBe(ptBR.errors.said.input);
    expect(errorText(lang("pt-BR"), new ApiError(404, "thing.gone", "No thing"))).toBe(ptBR.errors.said.gone);
    expect(errorText(lang("pt-BR"), new ApiError(503, "machine.busy", "Busy computer"))).toBe(
      ptBR.errors.said.computer,
    );
    // Codes the app knows, 413 and 403 say what they always said.
    expect(errorText(pt, new ApiError(403, "forbidden", ""))).toBe("common.notAllowed");
    expect(errorText(pt, new ApiError(429, "rate_limited", "Slow down"))).toBe("common.tooMany");
  });

  test("a field the server's validator refused reads by its kind in every language, never the validator's English", () => {
    const lang = (lng: string) => {
      const instance = i18next.createInstance();
      void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
      return instance.t;
    };
    const refused = (message: string, params?: Record<string, unknown>) =>
      new ApiError(400, "invalid_request", message, params);
    const long = refused("context: Too big: expected string to have <=20000 characters", {
      field: "context",
      issue: "too_long",
      max: 20000,
    });
    expect(errorText(lang("en"), long)).toBe(enStrings.errors.said.tooLong);
    expect(errorText(lang("pt-BR"), long)).toBe(ptBR.errors.said.tooLong);
    expect(errorText(lang("en"), refused("name: Too small", { field: "name", issue: "missing" }))).toBe(
      enStrings.errors.said.fillIn,
    );
    expect(errorText(lang("en"), refused("ids: Too big", { field: "ids", issue: "too_many", max: 50 }))).toBe(
      enStrings.errors.said.tooMany,
    );
    expect(errorText(lang("en"), refused("x: Invalid input", { field: "x", issue: "invalid" }))).toBe(
      enStrings.errors.said.input,
    );
    // A refusal the server wrote for people, with no field named, keeps its words in English.
    expect(errorText(lang("en"), refused("That column does not exist"))).toBe("That column does not exist");
    // Something gone says so plainly in English too: the server's "Agent not found" says nothing to do.
    expect(errorText(lang("en"), new ApiError(404, "not_found", "Agent not found"))).toBe(enStrings.errors.said.gone);
  });

  test("Better Auth's refusals a person meets on sign-up say what happened, never the plain line", () => {
    const instance = i18next.createInstance();
    void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
    const said = (status: number, code: string) => authErrorText(instance.t, { status, code, message: code });
    expect(said(422, "USER_ALREADY_EXISTS")).toBe(ptBR.auth.refused.linked);
    expect(said(422, "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL")).toBe(ptBR.auth.refused.linked);
    expect(said(400, "PASSWORD_TOO_SHORT")).toBe(ptBR.auth.passwordHelp);
    expect(said(400, "INVALID_PASSWORD")).toBe(ptBR.errors.reauth.password);
  });

  test("anything that isn't the server's answer: common.unknownError, never its own message", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
    expect(errorText(en, bug)).toBe("common.unknownError");
    expect(errorText(en, new Error("Load failed"))).toBe("common.unknownError");
    expect(errorText(en, "boom")).toBe("common.unknownError");
  });

  test("a sign-in that got no answer (status 0, or only the proxy's) says so; another refusal as errorText does", () => {
    const none = { status: 0, code: "network", message: "" };
    expect(authErrorText(pt, none)).toBe("common.unreachable");
    expect(offline(() => authErrorText(pt, none))).toBe("common.offline");
    expect(authErrorText(pt, { status: 503, message: "Service Unavailable" })).toBe("common.unreachable");
    expect(authErrorText(en, { status: 403, code: "INVALID_ORIGIN", message: "Invalid origin" })).toBe(
      "Invalid origin",
    );
    expect(authErrorText(pt, { status: 403, code: "INVALID_ORIGIN", message: "Invalid origin" })).toBe(
      "Invalid origin",
    );
    expect(authErrorText(en, { status: 500, message: "Internal Server Error" })).toBe("common.ourSide");
    expect(authErrorText(pt, { status: 429, message: "Too many" })).toBe("auth.tooManyTries");
  });

  test("an invitation that got no answer is asked twice more; an expired one never", () => {
    const retry = invitationQuery({} as never, "tok").retry as (count: number, error: unknown) => boolean;
    const network = new NetworkError(new TypeError("Failed to fetch"));
    expect([0, 1, 2].map((count) => retry(count, network))).toEqual([true, true, false]);
    expect(retry(0, new ApiError(503, "http_503", "Service Unavailable"))).toBe(true);
    expect(retry(0, new ApiError(404, "not_found", "Invitation not found"))).toBe(false);
  });
});

test("a provider's sign-in that didn't finish, by Better Auth's code: what the person can do", () => {
  const said = (code: string) => signInRefusalText(pt, code, true);
  expect(said("access_denied")).toBe("auth.refused.cancelled");
  // An unconfirmed password account's is the app's own words.
  expect(said("account_not_linked")).toBe("auth.unconfirmed");
  for (const code of ["unable_to_link_account", "account_already_linked_to_different_user"])
    expect(said(code)).toBe("auth.refused.linked");
  expect(said("email_does_not_match")).toBe("auth.refused.linked");
  expect([said("email_not_found"), said("email_not_verified")]).toEqual([
    "auth.refused.noEmail",
    "auth.refused.noEmail",
  ]);
  for (const code of [
    "state_mismatch",
    "state_not_found",
    "invalid_code",
    "no_code",
    "please_restart_the_process",
    "invalid_callback_request",
    "nonce_binding_missing",
    "issuer_mismatch",
    "issuer_missing",
  ])
    expect(said(code)).toBe("auth.refused.expired");
  for (const code of [
    "server_error",
    "internal_server_error",
    "unable_to_get_user_info",
    "oauth_provider_not_found",
    "no_callback_url",
  ])
    expect(said(code)).toBe("auth.refused.server");
  for (const code of ["UNKNOWN", "constructor", "__proto__", ""]) expect(said(code)).toBe("auth.refused.other");
  // The codes the app says itself never read Object's own names either.
  expect(errorText(pt, new ApiError(403, "toString", ""))).toBe("common.notAllowed");
});

test("a computer that can't connect Claude this way is said in the person's language, not the server's English", () => {
  const said = ((key: string) => key) as unknown as TFunction;
  const refusal = new ApiError(409, "account.method_unsupported", "This computer can't connect Claude this way yet.");
  expect(errorText(said, refusal)).toBe("errors.machine.accountMethodUnsupported");
});

test("an agent that doesn't answer this person says whom it answers, in the person's words", () => {
  const instance = i18next.createInstance();
  void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  const only = new ApiError(403, "audience.only", "Ada only replies to Walter and Ana.", {
    agentName: "Ada",
    names: ["Walter", "Ana"],
  });
  expect(errorText(instance.t, only)).toBe("A Ada só responde a Walter e Ana.");
  const nobody = new ApiError(403, "audience.nobody", "Theo isn't replying to anyone right now.", {
    agentName: "Theo",
    names: [],
  });
  expect(errorText(instance.t, nobody)).toBe("O Theo não está respondendo a ninguém agora.");
});

test("a password manager's refusal to connect: in its own words when the app has them, else as any refusal", () => {
  const instance = i18next.createInstance();
  void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  const refusal = (code: string) => new ApiError(400, `vault.source.${code}`, "The password manager refused this.");
  const own = ptBR.vault.source.onepassword.error;
  expect(vaultConnectRefusal(instance.t, "onepassword", refusal("invalid_input"))).toBe(own.invalid_input);
  expect(vaultConnectRefusal(instance.t, "onepassword", refusal("many_vaults"))).toBe(own.many_vaults);
  expect(vaultConnectRefusal(instance.t, "onepassword", refusal("rate_limited"))).toBe(
    ptBR.errors.vault.source.rateLimited,
  );
  const bitwarden = vaultConnectRefusal(instance.t, "bitwarden", refusal("auth_failed"));
  expect(bitwarden).toBe(ptBR.errors.vault.source.authFailed);
  const ours = new ApiError(500, "internal_error", "Something went wrong on our side");
  expect(vaultConnectRefusal(instance.t, "onepassword", ours)).toBe(errorText(instance.t, ours));
});

test("the right hand refused a place: its own line, never ask an admin", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const refused = new ApiError(403, "agent.right_hand_permanent", "The team's right hand can't be added to a channel");
  expect(errorText(t, refused)).toBe("errors.rightHand.permanent");
});

test("a provider refused this server's own OAuth app: what's wrong and who fixes it, never 'try again'", () => {
  const said = (lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
    const t = instance.t;
    const app = new ApiError(500, "github_app.misconfigured", "GitHub refused this server's GitHub App");
    const linear = { provider: "Linear" };
    const connector = new ApiError(500, "connector.misconfigured", "Linear refused this server's OAuth app", linear);
    // The phone says what finishing answered; the desktop window, by its code and what it names.
    const texts = [errorText(t, app), errorText(t, connector)];
    expect([
      oauthReturnText(t, "github_app.misconfigured"),
      oauthReturnText(t, "connector.misconfigured", linear),
    ]).toEqual(texts);
    return texts;
  };
  expect(said("pt-BR")).toEqual([
    "O app do GitHub está com a chave secreta errada no servidor, então a instalação não conclui. Quem cuida do servidor precisa trocar a chave nas configurações do app.",
    "A conexão com Linear está mal configurada no servidor, então ela não conclui. Quem cuida do servidor precisa trocar a chave nas configurações do app.",
  ]);
  expect(said("en")).toEqual([
    "The GitHub app has the wrong secret key on the server, so the install can't finish. Whoever runs the server needs to replace the key in the app's settings.",
    "The connection to Linear is set up wrong on the server, so it can't finish. Whoever runs the server needs to replace the key in the app's settings.",
  ]);
});

/**
 * Codes that keep the plain line (`untranslatedText`) on purpose: what only an agent or an API client meets, what the
 * form already prevents, or what `restrictionLine` and `limitRefusalText` say before `KNOWN`. A new code a person can
 * hit goes in `KNOWN` instead.
 */
const PLAIN_LINE = new Set([
  // A portrait's recipe is written by the builder, never typed: a malformed one is a fault of the app, not a choice
  // the person can fix.
  "avatar.portrait",
  // The feedback form says a file's type and size itself before any toast, and takes no more files than it may send
  // (FeedbackDialog).
  "feedback.file_too_large",
  "feedback.file_type",
  "feedback.files_many",
  // A phone that follows its computer's rule shows the computer's, with no control of its own; only the installer
  // meets a bad connect code.
  "device.follows_host",
  "machine.link_invalid",
  "account.invalid_code",
  "account.invalid_kind",
  "account.invalid_label",
  "account.invalid_plan",
  // A workspace change's card offers Apply, Dismiss and Send on only to whom may (`mayApplyCard`).
  "action_card.not_allowed",
  "action_card.not_requester",
  "action_card.unknown",
  "action_card.yours",
  // Every "Responde a" picker and drag offers only what `mayReportTo` allows, the server's own rules.
  "agent.reports_to",
  "agent_proposal.yours",
  "analytics.connector",
  "analytics.range",
  "approval_cover.self",
  "auth",
  "brain.invalid",
  "brain.invalid_context",
  "brain.invalid_effort",
  "brain.invalid_model",
  "brain.invalid_speed",
  "brain.right_hand_account",
  "browser.not_allowed",
  "browser_profile.machine",
  "browser_profile.system_mode",
  "canceled",
  "channel.invalid_name",
  "channel.leave_kind",
  "channel.mute_dm",
  "claude_auth.invalid",
  "claude_auth.unknown_org",
  "connector.key_too_short",
  "connector.oauth_only",
  "connector.sensitive_tool",
  "context.changes_permissions",
  "database.action",
  "database.daily_cap",
  "database.invalid_column",
  "database.invalid_table",
  "database.timeout",
  "early_access.used",
  "endpoint.model_id",
  "endpoint.prices",
  "endpoint.style",
  // The GitHub App: installing is offered only where the server has it, and the manifest's failure comes back as
  // `github_app_error=failed` on the page it returns to.
  "github_app.manifest_failed",
  "github_app.not_configured",
  "import.file_path",
  "import.secret_file",
  "import.too_many_items",
  "invalid_cursor",
  "invalid_request",
  "invitation.channel",
  "machine.access_nothing",
  "machine.device_not_found",
  "machine.host_none",
  "machine.move_no_agents",
  "mail.action",
  "mail.daily_send_cap",
  "mail.no_password",
  "mail.not_reconnectable",
  "mail.preset",
  "mail.window_days",
  "message.attachment_not_found",
  "mission.bad_path",
  "mission.invalid_command_approval",
  "mission.invalid_decision",
  "mission.invalid_delivery",
  "mission.invalid_executor",
  "mission.invalid_findings",
  "mission.invalid_plan",
  "mission.invalid_review",
  "mission.not_started",
  "mission.rate_limited",
  "mission.too_many_decisions",
  "mission.worktree_not_failed",
  "not_member",
  "notifications.bad_cursor",
  "org.members_full",
  "proposal.yours",
  "provisioning.ready",
  "query",
  "request_expired",
  "request_unknown",
  "request_used",
  "right_hand.missing",
  "right_hand_approvals.budget",
  "routine.action_always_asks",
  "routine.action_invalid",
  "routine.connector_hook",
  "routine.unknown_event",
  "routine.webhook_rate_limited",
  "schedule.invalid_count",
  "schedule.invalid_interval",
  "schedule.invalid_month",
  "schedule.invalid_month_day",
  "schedule.invalid_position",
  "schedule.invalid_weekday",
  "schedule.position_needs_month",
  "schedule.unknown_freq",
  "schedule.unknown_timezone",
  "setup.invalid",
  "skill.auto_update_owner_gone",
  "skill.duplicate_path",
  "skill.no_dismissed_update",
  "skill.nothing_to_undo",
  "speech_key_invalid",
  "stale_cursor",
  "start.channel_unknown",
  "storage.daily_full",
  "storage.full",
  "storage.invalid_bucket",
  "team_week.own_path",
  "timeout",
  "tls",
  "too_many",
  "unknown",
  "unreachable",
  "upload.wrong_machine",
  "voice.bad_type",
  "voice.client_id_required",
  "widget.already_updated",
  "widget.failed_why",
  "widget.not_this_run",
  "wiki.no_free_slug",
]);

/** Every code the server refuses with: `new XError(message, "code")`. */
function serverCodes() {
  const root = join(import.meta.dir, "../..");
  const roots = [join(root, "engine/src"), join(root, "adapters/src"), join(root, "../apps/server/src")];
  const coded =
    /new\s+\w*Error\(\s*(?:"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|[\w.]+(?:\([^)]*\))?)\s*,\s*"([a-z_][a-z_0-9.-]*)"/g;
  const codes = new Set<string>();
  for (const dir of roots)
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts")) continue;
      for (const m of readFileSync(join(dir, file), "utf8").matchAll(coded)) codes.add(m[1] ?? "");
    }
  return [...codes].sort();
}

describe("every refusal has words", () => {
  const codes = serverCodes();

  test("the scan finds the server's codes", () => {
    expect(codes.length).toBeGreaterThan(300);
    expect(codes).toContain("mission.tasks_live");
  });

  test("a new code needs a line in KNOWN, or a place on the plain-line list", () => {
    expect(codes.filter((code) => !hasWordsFor(code) && !PLAIN_LINE.has(code))).toEqual([]);
  });

  test("the plain-line list holds nothing gone or worded since", () => {
    expect([...PLAIN_LINE].filter((code) => !codes.includes(code) || hasWordsFor(code))).toEqual([]);
  });
});
