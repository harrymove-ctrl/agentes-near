import { describe, expect, test } from "bun:test";
import type { Message } from "../src/index";
import {
  connectionReader,
  hookCurl,
  isRefusedHookCall,
  isRoutineCall,
  mailboxReader,
  platformZoneName,
  routineHookUrl,
  routineReplyOf,
  timezoneName,
  triggerChoices,
  zoneDisplayName,
} from "../src/lib/routines";
import { buildTimeline } from "../src/lib/timeline";

const walter = { type: "person" as const, id: "walter" };
const msg = (id: string, minute: number, meta?: Record<string, unknown>): Message => ({
  id,
  channelId: "c",
  threadId: null,
  author: walter,
  body: id,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date(Date.UTC(2026, 9, 14, 10, minute)).toISOString(),
  ...(meta ? { meta } : {}),
});

describe("routine messages", () => {
  test("the agent's message tagged with the routine it answers; a call written as its creator never shows", () => {
    const routine = { routine: { id: "r1", name: "Relatório semanal", runId: "rr1", noticeId: "n1" } };
    const answer = { ...msg("answer", 3, routine), author: { type: "agent" as const, id: "atlas" } };
    expect(routineReplyOf(answer)).toEqual({ id: "r1", name: "Relatório semanal", runId: "rr1", noticeId: "n1" });
    // Only an agent's message answers a routine; a reminder is the agent's own message.
    expect(routineReplyOf(msg("typed", 1, routine))).toBeNull();
    expect(routineReplyOf({ ...answer, meta: { ...routine, reminder: true } })).toBeNull();
    expect(routineReplyOf({ ...answer, meta: { routineId: "r1" } })).toBeNull();
    expect(routineReplyOf({ ...answer, meta: { routine: { id: "r1", name: "x" } } })).toEqual({
      id: "r1",
      name: "x",
      runId: null,
      noticeId: null,
    });
    expect(isRoutineCall(msg("by-routine", 2, routine))).toBe(true);
    expect(isRoutineCall(answer)).toBe(false);
    const inThread = { ...msg("in-thread", 4, routine), threadId: "root" };
    const rows = buildTimeline([msg("typed", 1), msg("by-routine", 2, routine), answer, inThread], [], []);
    const shown = rows.flatMap((r) => (r.kind === "message" ? [r.message.id] : []));
    expect(shown).toEqual(["typed", "answer"]);
  });
});

describe("time zones", () => {
  test("a zone said in words: ours, else the platform's in the person's language, not its IANA id", () => {
    expect(timezoneName("America/Sao_Paulo", "pt-BR")).toBe("horário de Brasília");
    expect(timezoneName("America/Sao_Paulo", "en")).toBe("Brasília time");
    expect(timezoneName("Etc/UTC", "pt-BR")).toBe("UTC");
    expect(timezoneName("Asia/Kathmandu", "pt-BR")).toBe("Horário do Nepal");
    expect(timezoneName("Asia/Kathmandu", "en")).toBe("Nepal Time");
    // Languages without names of our own get the platform's; no language means English.
    expect(timezoneName("Asia/Tokyo", "fr")).toBe(platformZoneName("Asia/Tokyo", "fr") ?? "");
    expect(timezoneName("Asia/Tokyo", "fr")).not.toContain("Asia/");
    expect(timezoneName("America/Sao_Paulo")).toBe("Brasília time");
    expect(zoneDisplayName("America/Sao_Paulo")).toBe("Brasília time");
    // Only a zone the platform doesn't know keeps what it was given.
    expect(timezoneName("Not/A_Zone", "en")).toBe("Not/A_Zone");
  });

  test("an English reader never gets the Portuguese name", () => {
    expect(timezoneName("Asia/Singapore", "pt-BR")).toBe("Singapura");
    expect(timezoneName("Asia/Singapore", "en")).toBe("Singapore");
    expect(zoneDisplayName("Asia/Singapore", "en")).toBe("Singapore");
    expect(zoneDisplayName("Europe/Lisbon", "pt-BR")).toBe("Lisboa");
  });

  test("the platform's name is never a city's bare offset, which an engine without zone names gives", () => {
    expect(platformZoneName("Asia/Kathmandu", "en")).toBe("Nepal Time");
    const real = Intl.DateTimeFormat.prototype.formatToParts;
    Intl.DateTimeFormat.prototype.formatToParts = () => [{ type: "timeZoneName", value: "GMT-03:00" }];
    try {
      expect(platformZoneName("America/Sao_Paulo", "pt-BR")).toBeUndefined();
      // A zone that is only an offset keeps it: its id's sign reads the other way round.
      expect(platformZoneName("Etc/GMT+3", "pt-BR")).toBe("GMT-03:00");
    } finally {
      Intl.DateTimeFormat.prototype.formatToParts = real;
    }
  });
});

describe("a webhook routine's address", () => {
  const url = "https://app.agentes.test/api/hooks/abc";
  test("only a webhook routine's, as the server gave it (null for who doesn't manage it)", () => {
    expect(routineHookUrl({ trigger: { type: "webhook", url, signed: false, methods: ["POST"] } })).toBe(url);
    expect(routineHookUrl({ trigger: { type: "webhook", url: null, signed: true, methods: ["POST"] } })).toBeNull();
    expect(routineHookUrl({ trigger: { type: "event", event: "issue.created" } })).toBeNull();
  });

  test("the example call: plain, or signed the way a sending service signs its body", () => {
    expect(hookCurl(url, null)).toBe(
      `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text":"hello"}'`,
    );
    const signed = hookCurl(url, "s3cret").split("\n");
    expect(signed.slice(0, 3)).toEqual([
      "SECRET='s3cret'",
      `BODY='{"text":"hello"}'`,
      `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`,
    ]);
    expect(signed).toContain(`  -H "X-Agentes-Signature: sha256=$SIG" \\`);
    expect(signed.at(-1)).toBe('  -d "$BODY"');
  });

  test("the example call uses a method the address answers: POST when it can, else another; GET sends a query", () => {
    expect(hookCurl(url, null, ["GET", "PUT"]).split("\n")[0]).toBe(`curl -X PUT '${url}' \\`);
    expect(hookCurl(url, null, ["GET"])).toBe(`curl '${url}?text=hello'`);
    expect(hookCurl(url, "s3cret", ["GET"]).split("\n")).toEqual([
      "SECRET='s3cret'",
      `SIG=$(printf '%s' 'text=hello' | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`,
      `curl '${url}?text=hello' \\`,
      `  -H "X-Agentes-Signature: sha256=$SIG"`,
    ]);
  });

  test("a call the address refused never reached the routine; a repeat did, with the first one's run", () => {
    expect((["bad_signature", "too_large", "rate_limited"] as const).every(isRefusedHookCall)).toBe(true);
    expect(isRefusedHookCall("accepted")).toBe(false);
    expect(isRefusedHookCall("duplicate")).toBe(false);
  });
});

describe("what a routine's email trigger offers for its agent", () => {
  const a = { id: "a", address: "vendas@loja.com" };
  const b = { id: "b", address: "ana@loja.com" };
  const reads =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id);

  test("only the mailboxes the agent reads; every one until that is known", () => {
    expect(triggerChoices([a, b], reads("b"), "")).toEqual({ options: [b], cantRead: false });
    expect(triggerChoices([a, b], undefined, "")).toEqual({ options: [a, b], cantRead: false });
  });

  test("the one already picked stays, said as one the agent can't read; none read is said too", () => {
    expect(triggerChoices([a, b], reads("b"), "a")).toEqual({ options: [a, b], cantRead: true });
    expect(triggerChoices([a, b], reads(), "")).toEqual({ options: [], cantRead: true });
    expect(triggerChoices([a, b], reads("a", "b"), "a")).toEqual({ options: [a, b], cantRead: false });
  });

  test("a mailbox read from its level, a connection from its read grant", () => {
    const mail = mailboxReader([
      { accountId: "a", level: "none", canDelete: false, policy: {} as never },
      { accountId: "b", level: "read", canDelete: false, policy: {} as never },
    ]);
    expect([mail("a"), mail("b"), mail("c")]).toEqual([false, true, false]);
    const grants = connectionReader([{ connectionId: "c1", scope: "custom:c1:read" }]);
    expect([grants("c1"), grants("c2")]).toEqual([true, false]);
  });
});
