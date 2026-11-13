import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { AppNotification, GitHubRepositories, SkillDetail } from "../src/api/types";
import { openTarget, workspaceHeadline } from "../src/lib/notifications";
import {
  changedByText,
  changesSinceLink,
  githubRepoLink,
  hiddenRepoOf,
  hiddenRepoText,
  searchRepos,
  skillPendingViews,
  skillPickOf,
  skillRefusalText,
  skillSourceViaText,
  skillUpdateWords,
  skillViaText,
  skillWaitingChip,
  waitingUpdate,
} from "../src/lib/skills";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

describe("skills from a private repository (web and phone)", () => {
  test("a pick says which of the workspace's GitHub connections read it; none when no connection was needed", () => {
    const choices = [{ path: "skills/deploy", name: "deploy", description: "x" }];
    expect(skillPickOf({ choices, via: "github_app" })).toEqual({ choices, skipped: [], via: "github_app" });
    expect(skillPickOf({ choices, via: "token" })).toEqual({ choices, skipped: [], via: null });
    expect(skillPickOf({ id: "s1", name: "deploy" })).toBeNull();
  });

  test("the lines name the connection, the app with the repository's owner", () => {
    expect(skillViaText(t, "github_app", "https://github.com/contoso/skills/tree/main/x")).toBe(
      'skills.via.github_app {"owner":"contoso"}',
    );
    expect(skillViaText(t, "github", "https://github.com/contoso/skills")).toBe(
      'skills.via.github {"owner":"contoso"}',
    );
    const fromLink = { source: "url", sourceVia: "github", sourceUrl: "https://github.com/contoso/skills" } as const;
    expect(skillSourceViaText(t, fromLink)).toBe('skills.sourceVia.github {"owner":"contoso"}');
    expect(skillSourceViaText(t, { ...fromLink, sourceVia: null })).toBeNull();
    expect(skillSourceViaText(t, { source: "url", sourceUrl: null })).toBeNull();
    // Edited by hand or replaced by an upload: no longer from the link, whatever updating would read through.
    expect(skillSourceViaText(t, { ...fromLink, source: "manual" })).toBeNull();
    expect(skillSourceViaText(t, { ...fromLink, source: "upload" })).toBeNull();
  });

  test("a repository no connection reads: how the connection fared and whether the app is installed; other refusals aren't one", () => {
    const missing = (params?: Record<string, unknown>) => new ApiError(400, "github.repo_missing", "x", params);
    expect(hiddenRepoOf(missing({ repo: "contoso/skills", connection: "refused", app: true }))).toEqual({
      repo: "contoso/skills",
      connection: "refused",
      app: true,
    });
    expect(hiddenRepoOf(missing({ repo: "contoso/skills", connection: "ok", app: false }))?.connection).toBe("ok");
    // An older server says neither: no connection, no app.
    expect(hiddenRepoOf(missing({ repo: "contoso/skills" }))).toEqual({
      repo: "contoso/skills",
      connection: "none",
      app: false,
    });
    expect(hiddenRepoOf(new ApiError(400, "github.ref_missing", "x"))).toBeNull();
    expect(hiddenRepoOf(new Error("x"))).toBeNull();
  });

  test("what the dialog says of it, and Conectar o GitHub whenever no connection works and the person may connect", () => {
    const said = (connection: "none" | "refused" | "ok", app: boolean, mayConnect: boolean) => {
      const { text, connect } = hiddenRepoText(t, { repo: "contoso/skills", connection, app }, mayConnect);
      return [text.replace('skills.hidden.lead {"repo":"contoso/skills"} ', ""), connect];
    };
    expect(said("none", false, true)).toEqual(["skills.hidden.connect", true]);
    expect(said("none", true, true)).toEqual(['skills.hidden.app {"owner":"contoso"}', true]);
    expect(said("refused", true, true)).toEqual(["skills.hidden.refused", true]);
    // A connection that works and can't see it is given access on GitHub, never replaced from a skills dialog.
    expect(said("ok", true, true)).toEqual(["skills.hidden.unreached", false]);
    // Someone who can't manage connectors is told whom to ask.
    expect(said("none", true, false)).toEqual(["skills.hidden.ask", false]);
    expect(said("refused", false, false)).toEqual(["skills.hidden.ask", false]);
    expect(said("ok", false, false)).toEqual(["skills.hidden.askAccess", false]);
  });

  test("updating from the link: a hidden repository said as the dialog says it, other refusals as errors are", () => {
    const hidden = new ApiError(400, "github.repo_missing", "x", { repo: "contoso/skills", connection: "refused" });
    expect(skillRefusalText(t, hidden, false)).toBe('skills.hidden.lead {"repo":"contoso/skills"} skills.hidden.ask');
    const gone = new ApiError(400, "skill.connection_gone", "x", { repo: "contoso/skills" });
    expect(skillRefusalText(t, gone, true)).toStartWith("errors.skill.connectionGone");
  });

  test("the connected GitHub's repositories by name, accounts left with none out; a repository's link", () => {
    const repo = (owner: string, name: string) => ({
      fullName: `${owner}/${name}`,
      owner,
      name,
      private: true,
      updatedAt: null,
    });
    const listing: GitHubRepositories = {
      connected: true,
      accounts: [
        { login: "contoso", type: "Organization", repositories: [repo("contoso", "skills"), repo("contoso", "site")] },
        { login: "walt", type: "User", repositories: [repo("walt", "notes")] },
      ],
      truncated: false,
    };
    expect(searchRepos(listing, " SK ").map((a) => [a.login, a.repositories.map((r) => r.name)])).toEqual([
      ["contoso", ["skills"]],
    ]);
    expect(searchRepos(listing, "").map((a) => a.repositories.length)).toEqual([2, 1]);
    expect(searchRepos(undefined, "x")).toEqual([]);
    expect(githubRepoLink("contoso/skills")).toBe("https://github.com/contoso/skills");
  });
});

describe("skill notices", () => {
  test("each state of a skill's notice has its headline, and every one opens the skill", () => {
    const notice = (statusTo: string) =>
      ({ kind: "skill_update", source: { skillId: "s1", label: "deploy" }, latest: { statusTo } }) as AppNotification;
    expect(["updated", "waiting", "failed", "edited"].map((s) => workspaceHeadline(notice(s)))).toEqual([
      "skills.notice.updated",
      "skills.notice.waiting",
      "skills.notice.failed",
      "skills.notice.edited",
    ]);
    // Waiting only because it would replace the agents' change (no script in it).
    const replaces = { ...notice("waiting"), latest: { statusTo: "waiting", reason: "edited" } } as AppNotification;
    expect(workspaceHeadline(replaces)).toBe("skills.notice.waitingEdited");
    expect(openTarget(notice("edited"))).toEqual({
      to: "/org/$orgId/settings/$section",
      params: { section: "skills" },
      search: { skill: "s1" },
    });
  });
});

describe("a skill's waiting update (web and phone)", () => {
  const base = { body: "# v1", description: "Antes do deploy.", at: "2026-11-01T10:00:00.000Z" };
  const change = (id: string, agentId: string, at: string, undone = false) => ({
    id,
    agentId,
    at,
    before: "# v1",
    after: "# v1\nCache.",
    undone,
  });
  const skill = (over: Partial<SkillDetail> = {}): SkillDetail =>
    ({
      id: "s1",
      name: "deploy",
      description: "Antes do deploy.",
      version: 3,
      source: "url",
      sourceUrl: "https://github.com/acme/skills",
      defaultForNewAgents: false,
      metadata: {},
      createdAt: base.at,
      updatedAt: base.at,
      body: "# v1\nCache.",
      files: [],
      pendingUpdate: { scripts: [], at: "2026-11-03T10:00:00.000Z", dismissed: false, edited: true },
      pending: { body: "# v2", description: "Antes do deploy.", base, files: [] },
      changes: [
        change("c3", "bia", "2026-11-02T12:00:00.000Z"),
        change("c2", "ada", "2026-11-02T10:00:00.000Z", true),
        change("c1", "ada", "2026-11-01T11:00:00.000Z"),
        change("c0", "caio", "2026-10-20T11:00:00.000Z"),
      ],
      ...over,
    }) as SkillDetail;

  test("the link and the agents both changed it: what each changed and the skill against the link", () => {
    expect(skillPendingViews(skill()).map((v) => [v.id, v.before.body, v.after.body])).toEqual([
      ["agents", "# v1", "# v1\nCache."],
      ["link", "# v1", "# v2"],
      ["compare", "# v1\nCache.", "# v2"],
    ]);
    // What its link last wrote isn't known: only the skill against the link.
    const unknown = { body: "# v2", description: "Antes do deploy.", base: null, files: [] };
    expect(skillPendingViews(skill({ pending: unknown })).map((v) => v.id)).toEqual(["compare"]);
    // Files that run only: what the update changes.
    const scripts = skill({ pendingUpdate: { scripts: ["run.sh"], at: base.at, dismissed: false, edited: false } });
    expect(skillPendingViews(scripts).map((v) => v.id)).toEqual(["link"]);
    expect(skillPendingViews(skill({ pending: null }))).toEqual([]);
  });

  test("the page's words: the choice while it waits, a line with Desfazer after either", () => {
    const words = skillUpdateWords(t, "pt-BR", skill());
    expect(words.waiting).toMatchObject({
      title: "skills.pending.edited",
      lead: "skills.pending.editedLead",
      apply: "skills.pending.useLink",
      keep: "skills.pending.keepAgents",
      applied: "skills.pending.usedLink",
      kept: "skills.pending.keptAgents",
    });
    expect([words.kept, words.last]).toEqual([null, null]);
    // Files that run only: applied or not, and why it waits.
    const scripts = skillUpdateWords(
      t,
      "pt-BR",
      skill({ pendingUpdate: { scripts: ["run.sh"], at: base.at, dismissed: false, edited: false } }),
    );
    expect(scripts.waiting).toMatchObject({
      title: 'skills.pending.title {"files":"run.sh"}',
      lead: "skills.pending.lead",
      apply: "skills.pending.apply",
      keep: "skills.pending.dismiss",
    });
    // Kept as it is: no choice, a line (its Desfazer makes it wait again).
    const kept = skillUpdateWords(
      t,
      "pt-BR",
      skill({ pendingUpdate: { scripts: [], at: base.at, dismissed: true, dismissedAt: base.at, edited: true } }),
    );
    expect(kept.waiting).toBeNull();
    expect(kept.kept?.startsWith("skills.pending.keptLine")).toBe(true);
    // The link's version chosen: its line and Desfazer; an update applied by itself keeps its own words.
    const chosen = { fromVersion: 2, at: base.at, agentId: null, waited: true };
    expect(skillUpdateWords(t, "pt-BR", skill({ pendingUpdate: null, lastUpdate: chosen })).last).toMatchObject({
      undo: "skills.undo",
    });
    const plain = skillUpdateWords(
      t,
      "pt-BR",
      skill({ pendingUpdate: null, lastUpdate: { ...chosen, waited: false } }),
    );
    expect(plain.last?.undo).toBe("skills.undoUpdate");
    expect(
      skillUpdateWords(t, "pt-BR", skill({ pendingUpdate: null, lastUpdate: { ...chosen, agentId: "ada" } })).last,
    ).toBeNull();
  });

  test("who changed it since the link, the undone ones and the older ones left out; the list's word", () => {
    expect(changesSinceLink(skill()).map((c) => c.id)).toEqual(["c3", "c1"]);
    expect(changesSinceLink(skill({ pending: null }))).toEqual([]);
    const names: Record<string, string> = { ada: "Ada", bia: "Bia" };
    const line = changedByText(t, "pt-BR", changesSinceLink(skill()), (id) => names[id] ?? "?") ?? "";
    expect(line.startsWith('skills.pending.byAgents {"count":2,"names":"format.list')).toBe(true);
    expect(changedByText(t, "pt-BR", [], () => "")).toBeNull();

    expect(waitingUpdate(skill())).toMatchObject({ edited: true });
    expect(waitingUpdate(skill({ pendingUpdate: { scripts: [], at: base.at, dismissed: true } }))).toBeNull();
    expect(skillWaitingChip({ scripts: [], at: base.at, dismissed: false, edited: true })).toBe(
      "skills.waitingChipEdited",
    );
    expect(skillWaitingChip({ scripts: ["run.sh"], at: base.at, dismissed: false })).toBe("skills.waitingChip");
  });
});
