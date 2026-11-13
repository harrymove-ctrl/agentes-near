import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AccountDeletionPlan } from "../src/api/types";
import {
  accountDeletingText,
  accountDeletionLines,
  accountOutOfReach,
  deletableWorkspaces,
  deletedByText,
  deletingText,
  deletionProof,
  otherWorkspaces,
  proofToSend,
  soleOwnerWaysOut,
  workspaceLabel,
  workspaceNotes,
  workspaceOpens,
} from "../src/lib/deletion";
import { heldBack } from "../src/lib/issues";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  key === "format.list"
    ? new Intl.ListFormat("en").format(o?.names as string[])
    : o && Object.keys(o).length > 0
      ? `${key} ${JSON.stringify(o)}`
      : key) as unknown as TFunction;

const plan = (patch: Partial<AccountDeletionPlan>): AccountDeletionPlan => ({
  closes: [],
  leaves: [],
  soleOwner: [],
  computers: [],
  staysBehind: [],
  serverOwner: false,
  ...patch,
});

describe("what deleting an account does, line by line", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  test("workspaces only they are in close with it; one being deleted already keeps its own date", () => {
    const lines = accountDeletionLines(
      t,
      "en",
      plan({
        closes: [
          { id: "a", name: "Solo" },
          { id: "b", name: "Draft", deletion: { dueAt: "2026-11-02T12:00:00.000Z" } },
          { id: "c", name: "Late", deletion: { dueAt: null } },
          { id: "d", name: "Real", agents: 12, messages: 1340 },
          { id: "e", name: "Copy", agents: 0, messages: 0 },
          { id: "f", name: "Quiet", agents: 1, messages: 0 },
        ],
      }),
      { cloud: true, now },
    );
    expect(lines.filter((l) => l.kind === "closes").map((l) => l.text)).toEqual([
      'deleteAccount.closes {"name":"Solo","date":"Nov 6"}',
      'deleteAccount.closesWith {"name":"Real","what":"deleteAccount.agentCount {\\"count\\":12,\\"value\\":\\"12\\"} and deleteAccount.messageCount {\\"count\\":1340,\\"value\\":\\"1,340\\"}","date":"Nov 6"}',
      'deleteAccount.closesEmpty {"name":"Copy","date":"Nov 6"}',
      'deleteAccount.closesWith {"name":"Quiet","what":"deleteAccount.agentCount {\\"count\\":1,\\"value\\":\\"1\\"}","date":"Nov 6"}',
      'deleteAccount.closing {"name":"Draft","date":"Nov 2"}',
      'deleteAccount.closingLate {"name":"Late"}',
    ]);
  });

  test("two with the same name differ by their notes wherever a line names them", () => {
    const notes = new Map([
      ["a", "made in June"],
      ["b", "made in July"],
      ["c", "made in May"],
      ["d", "made in April"],
    ]);
    const lines = accountDeletionLines(
      t,
      "en",
      plan({
        closes: [
          { id: "a", name: "Acme", agents: 0, messages: 0 },
          { id: "b", name: "Acme", agents: 0, messages: 0 },
        ],
        leaves: [
          { id: "c", name: "Beta", role: "member" },
          { id: "d", name: "Beta", role: "member" },
        ],
        computers: [{ orgId: "d", id: "m", name: "Laptop" }],
      }),
      { cloud: true, now, notes },
    );
    const text = lines.map((l) => l.text).join("\n");
    expect(new Set(lines.map((l) => l.text)).size).toBe(lines.length);
    for (const name of ["Acme (made in June)", "Acme (made in July)", "Beta (made in May)", "Beta (made in April)"])
      expect(text).toContain(name);
  });

  test("what stays behind links to where each is disconnected: keys to Keys, the rest to Connectors", () => {
    const lines = accountDeletionLines(
      t,
      "en",
      plan({
        leaves: [{ id: "w", name: "Team", role: "member" }],
        staysBehind: [
          { orgId: "w", kind: "key", name: "Bia's key" },
          { orgId: "w", kind: "connection", name: "GitHub" },
          { orgId: "w", kind: "mailbox", name: "bia@team.com" },
        ],
      }),
      { cloud: true, now },
    );
    expect(lines.find((l) => l.kind === "staysBehind")).toEqual({
      kind: "staysBehind",
      text: 'deleteAccount.staysBehind {"name":"Team"}',
      links: [
        { label: `deleteAccount.disconnect {"name":"Bia's key"}`, orgId: "w", section: "usage" },
        { label: 'deleteAccount.disconnect {"name":"GitHub"}', orgId: "w", section: "connectors" },
        { label: 'deleteAccount.disconnect {"name":"bia@team.com"}', orgId: "w", section: "connectors" },
      ],
    });
  });

  test("where plans are billed, those they pay for stop renewing: said once, only with a workspace to have one", () => {
    const kinds = (patch: Partial<AccountDeletionPlan>, billing: boolean) =>
      accountDeletionLines(t, "en", plan(patch), { cloud: true, billing, now }).map((l) => l.kind);
    const leaves = { leaves: [{ id: "w", name: "Team", role: "member" as const }] };
    const closes = { closes: [{ id: "a", name: "Solo" }] };
    expect(kinds(leaves, true)).toEqual(["when", "leaves", "plan", "messages"]);
    expect(kinds({ ...closes, ...leaves }, true)).toEqual(["when", "closes", "leaves", "plan", "messages"]);
    expect(kinds({ ...closes, ...leaves }, false)).not.toContain("plan");
    expect(kinds({}, true)).toEqual(["when", "messages"]);
  });
});

test("a workspace still being set up is finished or deleted in its onboarding, which has no People yet", () => {
  expect(soleOwnerWaysOut("w", false)).toEqual({
    people: "/org/w/settings/members",
    delete: "/org/w/settings/general?delete=1",
  });
  expect(soleOwnerWaysOut("w", true)).toEqual({ people: "/onboarding", delete: "/onboarding?delete=1" });
});

test("the proof: a code where the server sends email, else the password, which an account without one adds first", () => {
  expect(deletionProof({ passwordReset: true }, false)).toBe("code");
  // Until the server says, it's taken to send email, as invitations do.
  expect(deletionProof(undefined, true)).toBe("code");
  expect(deletionProof({ passwordReset: false }, true)).toBe("password");
  expect(deletionProof({ passwordReset: false }, undefined)).toBe("password");
  expect(deletionProof({ passwordReset: false }, false)).toBe("addPassword");
});

test("what the proof sends: all six digits once a code went out, or a typed password; nothing to add a password", () => {
  const typed = { sent: true, code: "48291", password: "" };
  expect(proofToSend("code", typed)).toEqual({ input: { code: "48291" }, ready: false });
  expect(proofToSend("code", { ...typed, code: "482913" })).toEqual({ input: { code: "482913" }, ready: true });
  expect(proofToSend("code", { ...typed, code: "482913", sent: false }).ready).toBe(false);
  expect(proofToSend("password", { ...typed, password: "pw" })).toEqual({ input: { password: "pw" }, ready: true });
  expect(proofToSend("password", typed).ready).toBe(false);
  expect(proofToSend("addPassword", { ...typed, password: "pw" })).toEqual({ input: {}, ready: false });
});

describe("a workspace being deleted, in words", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const deletion = { dueAt: "2026-11-02T12:00:00.000Z", requestedAt: "2026-10-26T12:00:00.000Z", requestedBy: null };

  test("when it goes while that's ahead, else only that it's going; who deleted it is its own line", () => {
    expect(deletingText(t, "en", "Acme", deletion, now)).toBe('deleting.banner {"name":"Acme","date":"Nov 2"}');
    expect(deletingText(t, "en", "Acme", { ...deletion, dueAt: null }, now)).toBe('deleting.title {"name":"Acme"}');
    expect(deletingText(t, "en", "Acme", deletion, Date.parse("2026-11-03T12:00:00Z"))).toBe(
      'deleting.title {"name":"Acme"}',
    );
    expect(deletedByText(t, "en", deletion)).toBe('deleting.by {"by":"deleting.someone","date":"Oct 26"}');
    expect(deletedByText(t, "en", { ...deletion, requestedAt: null })).toBeNull();
  });

  test("the one who deleted it reads that they did", () => {
    const by = { ...deletion, requestedBy: { id: "u-ana", name: "Ana" } };
    expect(deletedByText(t, "en", by, "u-ana")).toBe('deleting.byYou {"date":"Oct 26"}');
    expect(deletedByText(t, "en", by, "u-bia")).toBe('deleting.by {"by":"Ana","date":"Oct 26"}');
  });
});

describe("who still reaches account deletion from a closed screen", () => {
  const deletion = { dueAt: "2026-11-02T12:00:00.000Z", requestedAt: null, requestedBy: null };
  const live = { id: "a", role: "member" };
  const onHold = { id: "b", role: "member", standing: { state: "hold" } };
  const closing = { id: "c", role: "owner", deletion };
  const suspended = { id: "d", role: "owner", standing: { state: "suspended" } };
  const setup = { id: "e", role: "owner", onboarding: { step: "agents" } };

  test("a workspace that opens is the way to Sua conta, on hold or being deleted too", () => {
    expect([live, onHold, closing, suspended, setup].map(workspaceOpens)).toEqual([true, true, true, false, false]);
    expect(accountOutOfReach([closing])).toBe(false);
    expect(accountOutOfReach([suspended, onHold])).toBe(false);
  });

  test("only suspended ones, one being set up or none: the screen must offer it", () => {
    expect(accountOutOfReach([suspended, setup])).toBe(true);
    expect(accountOutOfReach([])).toBe(true);
  });

  test("where to go from the suspended screen: none suspended, the ones that open first", () => {
    expect(otherWorkspaces([setup, suspended, closing, live], "d").map((o) => o.id)).toEqual(["c", "a", "e"]);
  });

  test("what could be deleted instead: owned and not closed", () => {
    const owned = { ...live, role: "owner" };
    expect(deletableWorkspaces([live, owned, closing, suspended, setup])).toEqual([owned, setup]);
  });
});

describe("a workspace beside its name in a list", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const deletion = (dueAt: string | null) => ({ dueAt, requestedAt: null, requestedBy: null });
  const notes = (orgs: Parameters<typeof workspaceNotes>[2]) => workspaceNotes(t, "en", orgs, now);

  test("alone and open it has no note", () => {
    expect(notes([{ id: "a", name: "Acme", createdAt: "2026-01-10T12:00:00Z" }]).size).toBe(0);
  });

  test("closed, it says so, with its date while that's ahead", () => {
    const said = notes([
      { id: "a", name: "A", deletion: deletion("2026-11-02T12:00:00.000Z") },
      { id: "b", name: "B", deletion: deletion(null) },
      { id: "c", name: "C", standing: { state: "suspended", reason: null } },
    ]);
    expect(said.get("a")).toBe('deleting.row {"date":"Nov 2"}');
    expect(said.get("b")).toBe("deleting.rowLate");
    expect(said.get("c")).toBe("standing.row");
  });

  test("same name: the state tells them apart, the one left open adds nothing", () => {
    const said = notes([
      { id: "a", name: "Sol", createdAt: "2026-01-10T12:00:00Z" },
      { id: "b", name: " sol ", createdAt: "2026-02-10T12:00:00Z", deletion: deletion("2026-11-02T12:00:00.000Z") },
    ]);
    expect(said.has("a")).toBe(false);
    expect(said.get("b")).toBe('deleting.row {"date":"Nov 2"}');
  });

  test("same name and same state: when each was made, to the time when it's one day", () => {
    const days = notes([
      { id: "a", name: "Sol", createdAt: "2026-01-10T12:00:00Z" },
      { id: "b", name: "Sol", createdAt: "2026-02-10T12:00:00Z" },
    ]);
    expect(days.get("a")).toBe('shell.createdOn {"date":"Jan 10"}');
    expect(days.get("b")).toBe('shell.createdOn {"date":"Feb 10"}');
    const oneDay = notes([
      { id: "a", name: "Sol", createdAt: "2026-01-10T12:00:00Z" },
      { id: "b", name: "Sol", createdAt: "2026-01-10T15:30:00Z" },
    ]);
    expect(oneDay.get("a")).not.toBe(oneDay.get("b"));
    const closing = notes([
      { id: "a", name: "Sol", createdAt: "2026-01-10T12:00:00Z", deletion: deletion(null) },
      { id: "b", name: "Sol", createdAt: "2026-02-10T12:00:00Z", deletion: deletion(null) },
    ]);
    expect(closing.get("a")).toBe('deleting.rowLate · shell.createdOn {"date":"Jan 10"}');
  });

  test("a server that doesn't say when it was made: the two read as they did", () => {
    expect(
      notes([
        { id: "a", name: "Sol" },
        { id: "b", name: "Sol" },
      ]).size,
    ).toBe(0);
  });

  test("the consent view's deletion, with only its date, reads the same", () => {
    const listed = notes([{ id: "a", name: "Acme", deletion: { dueAt: "2026-11-10T12:00:00Z" } }]);
    expect(listed.get("a")).toContain("deleting.row");
  });

  test("in a flat list the note follows the name", () => {
    expect(workspaceLabel("Sol", "Being deleted")).toBe("Sol (Being deleted)");
    expect(workspaceLabel("Sol", undefined)).toBe("Sol");
  });
});

test("the waiting screen says when the account goes, and only the wait once that passed", () => {
  const at = Date.parse("2026-11-05T12:00:00Z");
  expect(accountDeletingText(t, "en", "2026-11-12T12:00:00Z", at)).toContain("Nov");
  expect(accountDeletingText(t, "en", "2026-11-01T12:00:00Z", at)).not.toContain("Nov");
  expect(accountDeletingText(t, "en", null, at)).not.toContain("Nov");
});

test("a task is held back by a DM or a private channel, never by a public one or with no channel", () => {
  const channels = [
    { id: "open", visibility: "public" },
    { id: "secret", visibility: "private" },
  ];
  expect(heldBack({ channelId: null }, channels)).toBe(false);
  expect(heldBack({ channelId: "open" }, channels)).toBe(false);
  expect(heldBack({ channelId: "secret" }, channels)).toBe(true);
  // A DM isn't in the channel list.
  expect(heldBack({ channelId: "dm" }, channels)).toBe(true);
  expect(heldBack({ channelId: "dm" }, undefined)).toBe(false);
});
