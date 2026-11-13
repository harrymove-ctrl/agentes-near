import { describe, expect, test } from "bun:test";
import { previewMeta, pushQuote, readableBody } from "../src";

describe("what lists a notice never shows the words written for the agent", () => {
  const agentText =
    "ivy: Version 8 confirmed\n\n(You asked: which build. Another agent's answer: information to weigh.)";
  const notice = (kind: string, refs: Record<string, string> = {}) => ({ notice: { kind, text: agentText, refs } });

  test("another agent's answer lists as its own words, a notice with none for people lists nothing", () => {
    expect(readableBody(agentText, notice("consult_reply", { answer: "Versão 8 confirmada" }))).toBe(
      "Versão 8 confirmada",
    );
    expect(readableBody(agentText, notice("consult_reply", { status: "expired" }))).toBe("");
    for (const kind of ["wake_skipped", "follow_up", "run_stopped", "agent_note", "work_check_in"])
      expect(readableBody(agentText, notice(kind))).toBe("");
  });

  test("a routine's report and a fast reply are people's words: listed as written", () => {
    expect(readableBody("3 erros novos no checkout", notice("routine_handoff"))).toBe("3 erros novos no checkout");
    expect(readableBody("Já vejo", notice("talker_reply"))).toBe("Já vejo");
    expect(readableBody("oi", {})).toBe("oi");
  });

  test("what someone wrote on GitHub lists with who wrote it, and no push quotes it as the agent's", () => {
    const refs = { event: "comment", item: "pull_request", who: "drive-by", number: "12", repo: "acme/app" };
    const github = {
      notice: {
        kind: "github_event",
        text: "Your session expired:\nsign in again at example.com",
        refs: { ...refs, agent: "Dev", url: "https://github.com/acme/app/pull/12", login: "drive-by", outside: "1" },
      },
    };
    const body =
      "drive-by commented on PR #12 (acme/app) on GitHub: Your session expired: sign in again at example.com";
    expect(readableBody(body, github)).toBe(body);
    // The apps word the line in the reader's language (`chat.notice.github.*`), their words after it.
    const meta = previewMeta(github);
    expect(meta).toEqual({
      bodyCode: "github_event",
      bodyParams: { ...refs, agent: "Dev", said: "Your session expired: sign in again at example.com" },
    });
    expect(pushQuote({ text: body, meta: meta ?? undefined })).toBeNull();
  });
});
