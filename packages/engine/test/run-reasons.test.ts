import { expect, test } from "bun:test";
import { ProviderError } from "@agenteschat/providers";
import { routineFailureCode } from "../src/routine-ledger";
import {
  cliFailureText,
  OUR_ERROR,
  providerFailure,
  providerFailureOf,
  providerFailureText,
  runErrorDetail,
} from "../src/runs";
import { cliErrorWords } from "../src/tool-detail";

test("a failed run's reason: a CLI's failed turn is its CLI's, the computer's own the computer's, ours ours", () => {
  // Older rows kept only the CLI's code: whose CLI it was, never "the computer had a problem".
  for (const [code, brain] of [
    ["claude_failed", "Claude Code"],
    ["codex_failed", "Codex"],
    ["opencode_failed", "OpenCode"],
    ["antigravity_failed", "Antigravity CLI"],
  ] as const) {
    expect(runErrorDetail(code)).toEqual({ errorCode: "run.cli_stopped", errorParams: { brain } });
    expect(routineFailureCode(code)).toBe("cli_failed");
  }
  for (const code of ["runner_error", "runner_failed", "brain_failed"]) {
    expect(runErrorDetail(code)).toEqual({ errorCode: "run.computer_failed", errorParams: { code } });
    expect(routineFailureCode(code)).toBe("computer_failed");
  }
  // The runner refused a request of ours.
  expect(runErrorDetail("bad_request")).toEqual({ errorCode: "run.our_error" });
  expect(routineFailureCode("timeout")).toBe("computer_timeout");
  expect(runErrorDetail("account_missing")).toEqual({ errorCode: "run.account_missing" });
  expect(routineFailureCode("account_missing")).toBe("account_missing");
  for (const error of ["Stopped after an error: duplicate key value", "Stopped after an error that kept repeating."]) {
    expect(runErrorDetail(error)).toEqual({ errorCode: "run.our_error" });
    expect(routineFailureCode(error)).toBe("our_error");
  }
  // The provider refused the key's account: its own words stay out of the line, and a routine's code is the same.
  expect(runErrorDetail("provider_error: account: invalid provider API key")).toEqual({
    errorCode: "run.provider_account",
    errorParams: { detail: "invalid provider API key" },
  });
  expect(routineFailureCode("provider_error: account: invalid provider API key")).toBe("provider_error");
  // What kept its code still does.
  expect(routineFailureCode("gave_up: overloaded")).toBe("gave_up");
  expect(routineFailureCode("provider_error: invalid key")).toBe("provider_error");
});

test("a computer brain cut mid-turn, or with no AI to think with, has its own reason, never its prefix and English", () => {
  expect(runErrorDetail("brain_interrupted: The computer stopped answering")).toEqual({
    errorCode: "run.brain_interrupted",
    errorParams: { detail: "The computer stopped answering" },
  });
  expect(runErrorDetail("brain_unavailable: Codex is turned off on this computer")).toEqual({
    errorCode: "run.brain_unavailable",
    errorParams: { detail: "Codex is turned off on this computer" },
  });
});

const failure = (message: string, status: number | undefined, said?: string, platformKey = false) => {
  const error = new ProviderError(message, false, status, undefined, said);
  error.provider = "OpenRouter";
  error.platformKey = platformKey;
  return error;
};

test("a provider failure keeps its cause, its provider and its words, and an older row still reads", () => {
  const stored = providerFailureText("provider_error", failure("no prepaid credit left at the provider", 402));
  expect(runErrorDetail(stored)).toEqual({
    errorCode: "run.provider_no_credit",
    errorParams: { provider: "OpenRouter", detail: "no prepaid credit left at the provider" },
  });
  expect(routineFailureCode(stored)).toBe("provider_error");
  const late = new ProviderError("provider error", true, 503);
  late.provider = "Claude";
  expect(runErrorDetail(providerFailureText("gave_up", late))?.errorCode).toBe("run.provider_down");
  expect(routineFailureCode(providerFailureText("gave_up", late))).toBe("gave_up");
  expect(runErrorDetail("gave_up: overloaded")).toEqual({
    errorCode: "run.provider_unavailable",
    errorParams: { detail: "overloaded" },
  });
  expect(runErrorDetail("provider_error: support@example.com: bad")?.errorCode).toBe("run.provider_error");
  // A workspace's own endpoint goes by its address, port included.
  expect(runErrorDetail("gave_up: down@llm.local:8080: bad gateway")).toEqual({
    errorCode: "run.provider_down",
    errorParams: { provider: "llm.local:8080", detail: "bad gateway" },
  });
});

test("an unknown refusal shows the provider's own words, cut, with no key in them", () => {
  const said = `The key sk-or-v1-${"a".repeat(64)} can't do that. ${"x".repeat(400)}`;
  const { cause, detail } = providerFailureOf(failure("provider rejected the request (400)", 400, said));
  expect(cause).toBe("said");
  expect(detail).toHaveLength(200);
  expect(detail).not.toContain("sk-or-v1");
  expect(detail).toStartWith("The key •••• can't do that.");
});

test("on the server's own key the person's account isn't what failed: it reads as ours", () => {
  const stored = providerFailureText("provider_error", failure("invalid provider API key", 401, undefined, true));
  expect(runErrorDetail(stored)).toEqual({ errorCode: "run.our_error", errorParams: { provider: "OpenRouter" } });
  // Still a provider's failure for what follows: long work it cut off goes on (Continuar).
  expect(providerFailure(stored)).toBeTruthy();
  expect(providerFailure(`${OUR_ERROR} that kept repeating.`)).toBeNull();
  expect(providerFailure("Add an API key for Claude in the workspace settings")).toBeNull();
  // Their key or ours, a provider that is down is the provider's.
  const down = failure("provider error", 503, undefined, true);
  expect(providerFailureOf(down).cause).toBe("down");
  // A provider nobody registered on this server is ours too.
  expect(runErrorDetail("No provider registered for acme")).toEqual({ errorCode: "run.our_error" });
});

const cli = (message: string, provider?: { cause?: string; httpStatus?: number }, code = "claude_failed") => ({
  code,
  message,
  ...(provider ? { provider } : {}),
});

test("a CLI's failure says who failed it: the provider as a key's failure reads, else the CLI and what it said", () => {
  // Claude Code's result said it failed and nothing more (`error_during_execution`).
  const bare = cliFailureText(cli("Claude Code ended with error_during_execution", { cause: "unknown" }));
  expect(bare).toBe("cli_failed: Claude Code");
  expect(runErrorDetail(bare)).toEqual({ errorCode: "run.cli_stopped", errorParams: { brain: "Claude Code" } });
  // What it said, as anyone in the conversation may read it.
  const full = cliFailureText(
    cli(
      "Error: ENOSPC: no space left on device, write '/home/runner/agents/nina/.claude/projects/x/abc.jsonl'\n" +
        "    at writeSync (node:fs:933:3)\n    at Object.<anonymous> (/usr/lib/node_modules/claude/cli.js:10:20)\n" +
        "Node.js v22.11.0",
      { cause: "unknown" },
    ),
  );
  expect(full).toBe("cli_failed: Claude Code: ENOSPC: no space left on device, write 'abc.jsonl'");
  expect(runErrorDetail(full)).toEqual({
    errorCode: "run.cli_failed",
    errorParams: { brain: "Claude Code", detail: "ENOSPC: no space left on device, write 'abc.jsonl'" },
  });
  expect(routineFailureCode(full)).toBe("cli_failed");
  // Ended without its answer: its error line when it left one, else how it ended.
  const crashed = cliFailureText(
    cli("Claude Code ended without an answer (exit 1): TypeError: Cannot read properties of undefined (reading 'x')"),
  );
  expect(runErrorDetail(crashed)?.errorParams?.detail).toBe(
    "TypeError: Cannot read properties of undefined (reading 'x')",
  );
  const killed = cliFailureText(cli("Claude Code ended without an answer (signal SIGKILL)"));
  expect(killed).toBe("cli_closed: Claude Code: signal SIGKILL");
  expect(runErrorDetail(killed)).toEqual({ errorCode: "run.cli_closed", errorParams: { brain: "Claude Code" } });
  // An older runner's: its last lines, a stack with nothing in it.
  const older = cliFailureText(
    cli(
      "Claude Code ended without an answer (exit ?): at Module._compile (node:internal/modules/cjs/loader:1554:14) Node.js v22.11.0",
    ),
  );
  expect(older).toBe("cli_closed: Claude Code: exit ?");
  // The provider answered with an error: worded as a key's on that plan, with the provider's own words.
  const tooLong = cliFailureText(
    cli(
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"},"request_id":"req_011"}',
      { cause: "unknown" },
    ),
  );
  expect(runErrorDetail(tooLong)).toEqual({
    errorCode: "run.provider_said",
    errorParams: { provider: "Claude", detail: "prompt is too long: 215000 tokens > 200000 maximum" },
  });
  // A 429 that isn't the plan's limit, or a billing refusal on a coding plan's key, with no status from the CLI.
  expect(runErrorDetail(cliFailureText(cli("Request rejected (429)", { cause: "quota" })))?.errorCode).toBe(
    "run.provider_rate_limit",
  );
  expect(
    runErrorDetail(cliFailureText(cli("Insufficient balance", { cause: "billing" }), { provider: "zai" })),
  ).toMatchObject({ errorCode: "run.provider_no_credit", errorParams: { provider: "Z.ai" } });
  // After the outage's waits.
  expect(
    runErrorDetail(cliFailureText(cli("Overloaded", { cause: "provider_transient" }), {}, "gave_up")),
  ).toMatchObject({ errorCode: "run.provider_down", errorParams: { provider: "Claude" } });
  // The other CLIs read as Claude Code does: what they said on their way out, else how they ended, else that they
  // stopped. Never the runner's own sentence about them.
  const other = (message: string, code: string) => cliFailureText(cli(message, undefined, code));
  expect(other("Cursor exited with code 2: error: unknown model", "cursor_failed")).toBe(
    "cli_failed: Cursor: unknown model",
  );
  expect(other("The Antigravity CLI exited with code 1: Error: quota project not set", "antigravity_failed")).toBe(
    "cli_failed: Antigravity CLI: quota project not set",
  );
  expect(other("Codex exited with code 137", "codex_failed")).toBe("cli_closed: Codex: exit 137");
  expect(runErrorDetail(other("Grok Build exited with code ?", "grok_failed"))).toEqual({
    errorCode: "run.cli_closed",
    errorParams: { brain: "Grok Build" },
  });
  expect(other("OpenCode ended without finishing the turn", "opencode_failed")).toBe("cli_failed: OpenCode");
  expect(other("Claude Code ended with an error", "claude_failed")).toBe("cli_failed: Claude Code");
  // A Codex turn that failed in its own words, even ones that sound like the runner's.
  expect(other("stream disconnected before completion: idle timeout", "codex_failed")).toBe(
    "cli_failed: Codex: stream disconnected before completion: idle timeout",
  );
  expect(other("MCP server agentes exited with code 1", "codex_failed")).toBe(
    "cli_failed: Codex: MCP server agentes exited with code 1",
  );
  expect(cliFailureText(cli("boom", undefined, "runner_error"))).toBeNull();
});

test("what a CLI said is safe to show anyone: no secrets, no sign-ins, no folders, one short line", () => {
  const words = cliErrorWords(
    "Error: request failed: Authorization: Bearer sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE reading C:\\Users\\ana\\notes\\todo.md and ~/work/acme/.env",
  );
  expect(words).not.toContain("sk-ant");
  expect(words).not.toContain("Users");
  expect(words).not.toContain("acme");
  expect(words).toContain("todo.md");
  expect(words).toContain(".env");
  // A URL keeps its address; a long line is cut.
  expect(cliErrorWords("Error: could not reach https://api.anthropic.com/v1/messages")).toBe(
    "could not reach https://api.anthropic.com/v1/messages",
  );
  expect(cliErrorWords(`Error: ${"x".repeat(500)}`)).toHaveLength(200);
  // A long one ends at a word, with "…": the cause and its way out stay whole.
  expect(
    cliErrorWords(
      "error: this sandbox could not enforce its deny list on Linux: bwrap exec failed: No such file or directory (os error 2). Install bubblewrap with `apt install -y bubblewrap`. Refusing to start with denied paths unprotected.",
    ),
  ).toBe(
    "this sandbox could not enforce its deny list on Linux: bwrap exec failed: No such file or directory (os error 2). Install bubblewrap with `apt install -y bubblewrap`. Refusing to start with denied…",
  );
  expect(cliErrorWords("first line\nsecond line")).toBe("second line");
  // Sign-ins in an address, a token pasted in a command, a signed one, a folder in quotes or in a file:// address.
  const more = cliErrorWords(
    "error: GET https://ana:hunter2-FAKE@git.example.com/x?access_token=FAKEFAKEFAKEFAKE1234 with ghp_FAKEFAKEFAKEFAKEFAKEFAKE12 " +
      "and eyJFAKEFAKEFAKE.FAKEFAKEFAKEFAKE.FAKEFAKE failed reading '/home/ana/acme/.claude.json' and file:///Users/ana/acme/x.md",
  );
  for (const leak of ["hunter2", "FAKEFAKEFAKEFAKE1234", "ghp_", "eyJFAKE", "/home", "Users", "acme"])
    expect(more).not.toContain(leak);
  expect(more).toContain(".claude.json");
});
