import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type {
  GitHubRepositories,
  Skill,
  SkillAgentChange,
  SkillChoice,
  SkillDetail,
  SkillSkipped,
  SkillVia,
} from "../api/types";
import { errorText } from "./errors";
import { joinNames, relativeTime } from "./format";

/**
 * What a GitHub link holds when `skills.import` answers with skills to pick from, else null. `via`: which of the
 * workspace's GitHub connections read it (null: none was needed).
 */
export const skillPickOf = (
  result: unknown,
): { choices: SkillChoice[]; skipped: SkillSkipped[]; via: SkillVia | null } | null =>
  typeof result === "object" && result !== null && "choices" in result && Array.isArray(result.choices)
    ? {
        choices: result.choices,
        skipped: "skipped" in result && Array.isArray(result.skipped) ? result.skipped : [],
        via: "via" in result && (result.via === "github_app" || result.via === "github") ? result.via : null,
      }
    : null;

/** Why a skill a link holds can't be installed, in the person's words when the server's code is known. */
export const skippedSkillText = (t: TFunction, skipped: SkillSkipped) =>
  t("skills.pickSkipped", { reason: errorText(t, new ApiError(400, skipped.code, skipped.message, skipped.params)) });

/** The files a skill's page lists: a skill can hold thousands, and its agents read them, not the person. */
export const SKILL_FILES_SHOWN = 200;

/** The picked skills' paths after checking (`on`) or unchecking these. */
export function pickSkills(picked: ReadonlySet<string>, paths: string[], on: boolean): Set<string> {
  const next = new Set(picked);
  for (const path of paths) {
    if (on) next.add(path);
    else next.delete(path);
  }
  return next;
}

/** A repository's link on GitHub, as the import reads it. */
export const githubRepoLink = (fullName: string) => `https://github.com/${fullName}`;

const ownerOf = (url: string) => /^https:\/\/github\.com\/([^/?#]+)/.exec(url.trim())?.[1] ?? "";

/** "Lido pelo app do GitHub em acme.": which of the workspace's GitHub connections read a private link. */
export const skillViaText = (t: TFunction, via: SkillVia, url: string) =>
  t(`skills.via.${via}`, { owner: ownerOf(url) });

/**
 * "Do repositório privado, pelo app do GitHub em acme.": the line of a skill still from its link; null when no
 * connection read it, or once edited or replaced by an upload (the server keeps how to update it all the same).
 */
export const skillSourceViaText = (t: TFunction, skill: Pick<Skill, "source" | "sourceVia" | "sourceUrl">) =>
  skill.source === "url" && skill.sourceVia
    ? t(`skills.sourceVia.${skill.sourceVia}`, { owner: ownerOf(skill.sourceUrl ?? "") })
    : null;

/**
 * A link none of the workspace's GitHub reads (`github.repo_missing`): its GitHub connection (`none`, `refused` when
 * GitHub no longer takes its token, `ok` when it works and can't see the repository) and whether the GitHub App is
 * installed on some account (`app`). An older server says neither: none.
 */
export interface HiddenRepo {
  repo: string;
  connection: "none" | "refused" | "ok";
  app: boolean;
}

export function hiddenRepoOf(error: unknown): HiddenRepo | null {
  if (!(error instanceof ApiError) || error.code !== "github.repo_missing") return null;
  const connection = error.params?.connection;
  return {
    repo: String(error.params?.repo ?? ""),
    connection: connection === "refused" || connection === "ok" ? connection : "none",
    app: error.params?.app === true,
  };
}

/**
 * What to say of a link none of the workspace's GitHub reads, and whether to offer "Conectar o GitHub": whenever no
 * connection works (none, or one GitHub refuses) and the person may connect it. A connection that works but can't
 * see the repository is given access on GitHub, never replaced from here (every agent uses its token).
 */
export function hiddenRepoText(t: TFunction, hidden: HiddenRepo, mayConnect: boolean) {
  const owner = hidden.repo.split("/")[0] ?? "";
  const next = !mayConnect
    ? t(hidden.connection === "ok" ? "skills.hidden.askAccess" : "skills.hidden.ask")
    : hidden.connection === "ok"
      ? t("skills.hidden.unreached")
      : hidden.connection === "refused"
        ? t("skills.hidden.refused")
        : hidden.app
          ? t("skills.hidden.app", { owner })
          : t("skills.hidden.connect");
  return {
    text: `${t("skills.hidden.lead", { repo: hidden.repo })} ${next}`,
    connect: mayConnect && hidden.connection !== "ok",
  };
}

/** Why updating a skill from its link failed, in the person's words (a hidden repository as `hiddenRepoText`). */
export function skillRefusalText(t: TFunction, error: unknown, mayConnect: boolean) {
  const hidden = hiddenRepoOf(error);
  return hidden ? hiddenRepoText(t, hidden, mayConnect).text : errorText(t, error);
}

/** The repositories the workspace's GitHub reaches whose name has the query, by account (those left with none out). */
export function searchRepos(listing: GitHubRepositories | undefined, query: string) {
  const q = query.trim().toLowerCase();
  return (listing?.accounts ?? [])
    .map((a) => ({ ...a, repositories: a.repositories.filter((r) => !q || r.fullName.toLowerCase().includes(q)) }))
    .filter((a) => a.repositories.length > 0);
}

/** What "Atualizar do link" says, by what it did (`SkillSourceUpdate.status`). */
export const SKILL_UPDATE_TOAST = {
  updated: "skills.refreshed",
  unchanged: "skills.upToDate",
  waiting: "skills.waitingToast",
} as const;

/** Why a skill's last update from its link failed (`updateError`), in the reader's words. */
export function skillUpdateErrorText(t: TFunction, code: string) {
  const key = code.replace(/^skill\./, "");
  if (key === "no_skill_md" || key === "connection_gone" || key === "link_holds_several" || key === "link_renamed")
    return t(`skills.updateFailed.${key}`);
  if (key === "auto_update_owner_gone" || code === "forbidden") return t("skills.updateFailed.owner_gone");
  return t("skills.updateFailed.other");
}

/** The update from its link that waits for a person (not kept out), or null. */
export const waitingUpdate = (s: Pick<Skill, "pendingUpdate">) =>
  s.pendingUpdate && !s.pendingUpdate.dismissed ? s.pendingUpdate : null;

/** The list's word for a waiting update: the link and the agents both changed it, or files that run to review. */
export const skillWaitingChip = (pending: NonNullable<Skill["pendingUpdate"]>) =>
  pending.edited ? "skills.waitingChipEdited" : "skills.waitingChip";

/** A skill's text: what it is for and its SKILL.md. */
export interface SkillText {
  body: string;
  description: string;
}

/**
 * One way to read a waiting update on the skill's page (`skills.diff.{id}`): what the agents changed since its link
 * last wrote it, what its link changed since, and the skill now against its link's version. Without what its link
 * last wrote (`pending.base`), only the last. An update the agents didn't change has one: what it changes.
 */
export interface SkillPendingView {
  id: "agents" | "link" | "compare";
  before: SkillText;
  after: SkillText;
}

export function skillPendingViews(s: SkillDetail): SkillPendingView[] {
  const p = s.pending;
  if (!p) return [];
  const now = { body: s.body, description: s.description };
  const link = { body: p.body, description: p.description };
  if (!s.pendingUpdate?.edited) return [{ id: "link", before: now, after: link }];
  if (!p.base) return [{ id: "compare", before: now, after: link }];
  return [
    { id: "agents", before: p.base, after: now },
    { id: "link", before: p.base, after: link },
    { id: "compare", before: now, after: link },
  ];
}

/** The agents' changes since its link last wrote it, newest first: none when that isn't known. */
export const changesSinceLink = (s: SkillDetail): SkillAgentChange[] => {
  const since = s.pending?.base?.at;
  return since ? (s.changes ?? []).filter((c) => !c.undone && c.at > since) : [];
};

/** "Ada e Bia mudaram esta skill, a última vez há 2 dias": who changed it since its link (`changesSinceLink`). */
export function changedByText(
  t: TFunction,
  lang: string,
  changes: SkillAgentChange[],
  nameOf: (agentId: string) => string,
): string | null {
  const [latest] = changes;
  if (!latest) return null;
  const names = [...new Set(changes.map((c) => nameOf(c.agentId)))];
  return t("skills.pending.byAgents", {
    count: names.length,
    names: joinNames(names, t),
    when: relativeTime(t, lang, latest.at),
  });
}

/**
 * What a skill's page says about its update from its link (web and phone): the waiting one with its choice, the line
 * left after keeping the skill as it is (Desfazer makes it wait again), and the last update applied with its Desfazer.
 */
export function skillUpdateWords(t: TFunction, lang: string, s: SkillDetail) {
  const pending = waitingUpdate(s);
  const when = (at: string) => relativeTime(t, lang, at);
  const kept = s.pendingUpdate?.dismissed && s.pendingUpdate.dismissedAt ? s.pendingUpdate : null;
  const last = s.lastUpdate && !s.lastUpdate.agentId ? s.lastUpdate : null;
  return {
    waiting: pending
      ? {
          title: pending.edited
            ? t("skills.pending.edited")
            : t("skills.pending.title", { files: pending.scripts.join(", ") }),
          since: t("skills.pending.linkSince", { when: when(pending.at) }),
          lead: [
            ...(pending.edited ? [t("skills.pending.editedLead")] : []),
            ...(pending.scripts.length > 0 ? [t("skills.pending.lead")] : []),
          ].join(" "),
          apply: t(pending.edited ? "skills.pending.useLink" : "skills.pending.apply"),
          keep: t(pending.edited ? "skills.pending.keepAgents" : "skills.pending.dismiss"),
          /** The toasts' words (with `{{name}}`) after either choice. */
          applied: pending.edited ? ("skills.pending.usedLink" as const) : ("skills.pending.applied" as const),
          kept: pending.edited ? ("skills.pending.keptAgents" as const) : ("skills.pending.dismissed" as const),
        }
      : null,
    kept: kept
      ? t(kept.edited ? "skills.pending.keptLine" : "skills.pending.notAppliedLine", {
          when: when(kept.dismissedAt ?? kept.at),
        })
      : null,
    last: last
      ? {
          line: t(last.waited ? "skills.chosenLink" : "skills.lastUpdate", { when: when(last.at) }),
          undo: t(last.waited ? "skills.undo" : "skills.undoUpdate"),
        }
      : null,
  };
}

/** What removing a skill does: who loses it, that it leaves the workspace, and that there's no way back in the apps. */
export function skillRemovalText(t: TFunction, users: readonly { name: string }[]) {
  const who =
    users.length > 0
      ? t("skills.removeAgents", {
          count: users.length,
          names: joinNames(
            users.map((a) => a.name),
            t,
          ),
        })
      : t("skills.removeNone");
  return t("common.joinSentences", { a: who, b: t("skills.removeGone") });
}
