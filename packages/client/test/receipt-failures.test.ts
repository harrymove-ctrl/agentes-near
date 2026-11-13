import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { Message } from "../src/api/types";
import { failedRunFix, runFailureLine } from "../src/lib/errors";
import { serverBody } from "../src/lib/message-body";
import { applyReceiptEvent, seedReceipt } from "../src/realtime/receipts";

const handled = {
  type: "message.handled" as const,
  channelId: "c1",
  messageId: "m1",
  agentId: "ada",
  runId: "r1",
  status: "failed" as const,
};

test("a failed run's reason stays on the receipt, from the event and from the list", () => {
  const heard = applyReceiptEvent({}, { ...handled, errorCode: "run.computer_failed", errorParams: { code: "x" } });
  expect(heard.m1?.failures).toEqual({ ada: { code: "run.computer_failed", params: { code: "x" } } });
  const message = {
    id: "m1",
    author: { type: "person", id: "u1" },
    mentionedAgentIds: [],
    receipts: {
      seenBy: [],
      pickedBy: ["ada"],
      handled: [{ agentId: "ada", runId: "r1", status: "failed", errorCode: "run.our_error" }],
      blocked: [],
    },
  } as unknown as Message;
  expect(seedReceipt({}, message).m1?.failures).toEqual({ ada: { code: "run.our_error" } });
});

test("a run that failed for want of an AI, or didn't fail, keeps no reason", () => {
  expect(applyReceiptEvent({}, { ...handled, reason: "no_ai" }).m1?.failures).toBeUndefined();
  expect(applyReceiptEvent({}, { ...handled, status: "done" }).m1?.failures).toBeUndefined();
});

test("a failed run's one fix: a key for a missing, revoked or wrong one, another model for one gone, else none", () => {
  const everyone = { keys: true, admin: true, owner: true };
  for (const code of ["run.missing_credential", "run.credential_revoked", "run.credential_wrong_provider"])
    expect(failedRunFix(code, everyone)).toBe("useKey");
  for (const code of ["account", "no_credit", "invalid_key", "no_access"])
    expect(failedRunFix(`run.provider_${code}`, everyone)).toBe("useKey");
  expect(failedRunFix("run.provider_model_unavailable", everyone)).toBe("changeModel");
  for (const code of ["rate_limit", "down", "timeout", "unreachable", "said"])
    expect(failedRunFix(`run.provider_${code}`, everyone)).toBeNull();
  expect(failedRunFix("run.model_unlisted", everyone)).toBe("changeModel");
  expect(failedRunFix("run.computer_failed", everyone)).toBeNull();
  expect(failedRunFix(undefined, everyone)).toBeNull();
  // Only for who can do it: a key is who manages them, a model the agent's owner or who manages agents.
  const nobody = { keys: false, admin: false, owner: false };
  expect(failedRunFix("run.missing_credential", nobody)).toBeNull();
  expect(failedRunFix("run.missing_credential", { ...nobody, owner: true })).toBeNull();
  expect(failedRunFix("run.model_unlisted", nobody)).toBeNull();
  expect(failedRunFix("run.model_unlisted", { ...nobody, owner: true })).toBe("changeModel");
});

describe("a failed run as one line (runFailureLine)", () => {
  const instance = i18next.createInstance();
  void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
  const real = instance.t.bind(instance) as TFunction;

  test("says the reason as part of the sentence, on the phone and the web alike", () => {
    expect(
      runFailureLine(real, "Ada", { code: "run.computer_failed", params: { code: "codex_failed" } }, "pt-BR"),
    ).toBe("Ada não conseguiu responder: o computador teve um problema e parou");
    expect(runFailureLine(real, "Ada", { code: "run.our_error" }, "pt-BR")).toBe(
      "Ada não conseguiu responder: algo deu errado do nosso lado e a tarefa parou. Peça de novo daqui a pouco",
    );
    expect(runFailureLine(real, "Ada", { code: "run.account_missing" }, "pt-BR")).toContain(
      "a conta escolhida para este agente não está mais no computador dele",
    );
  });

  test("a CLI's own failure names the CLI and what it said, never the computer that ran it", () => {
    const cli = (code: string, params: Record<string, string>) =>
      runFailureLine(real, "Nick", { code, params }, "pt-BR");
    expect(cli("run.cli_failed", { brain: "Claude Code", detail: "prompt is too long: 215000 tokens" })).toBe(
      "Nick não conseguiu responder: o Claude Code parou com um erro: prompt is too long: 215000 tokens",
    );
    expect(cli("run.cli_stopped", { brain: "Claude Code" })).toBe(
      "Nick não conseguiu responder: o Claude Code parou com um erro",
    );
    expect(cli("run.cli_closed", { brain: "Codex" })).toBe("Nick não conseguiu responder: o Codex fechou de repente");
    for (const code of ["run.cli_failed", "run.cli_stopped", "run.cli_closed"])
      expect(cli(code, { brain: "Claude Code", detail: "x" })).not.toContain("computador");
    // The computer's own failure still says so.
    expect(cli("run.computer_failed", { code: "runner_error" })).toContain("o computador teve um problema");
    // English keeps the CLI's capitals, though the reason goes on as part of the sentence.
    const en = i18next.createInstance();
    void en.init({ lng: "en", resources, initAsync: false });
    expect(
      runFailureLine(
        en.t.bind(en) as TFunction,
        "Nick",
        { code: "run.cli_stopped", params: { brain: "Claude Code" } },
        "en",
      ),
    ).toBe("Nick couldn't answer: the Claude Code program stopped with an error");
  });

  test("a provider's failure names it and keeps its name's capitals; a wait note says the same in the chat", () => {
    const params = { provider: "OpenRouter", detail: "Insufficient credits" };
    expect(runFailureLine(real, "Ada", { code: "run.provider_no_credit", params }, "pt-BR")).toBe(
      "Ada não conseguiu responder: sem crédito no OpenRouter. Adicione crédito lá ou use outra chave",
    );
    expect(runFailureLine(real, "Ada", { code: "run.provider_said", params }, "pt-BR")).toBe(
      "Ada não conseguiu responder: a resposta de OpenRouter: Insufficient credits",
    );
    const note = { bodyCode: "provider_wait_rate_limit", bodyParams: params };
    expect(serverBody(real, "fallback", note)).toBe(
      "OpenRouter está limitando os pedidos desta chave agora. Respondo assim que liberar.",
    );
    expect(serverBody(real, "fallback", { ...note, bodyCode: "provider_back" })).toBe("Minha IA voltou.");
  });

  test("a restriction in its own words, a busy computer, and nothing when no reason has words", () => {
    expect(runFailureLine(real, "Ada", { code: "run.agent_paused" })).toContain("Ada não respondeu.");
    expect(runFailureLine(real, "Ada", { code: "run.computer_busy" })).toContain("Ada");
    expect(runFailureLine(real, "Ada", { code: "run.failed", params: { detail: "x" } })).toBeNull();
    expect(runFailureLine(real, "Ada", {})).toBeNull();
  });
});
