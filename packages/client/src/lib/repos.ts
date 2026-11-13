import type { TFunction } from "i18next";
import type { GitHubRepositories } from "../api/types";
import { joinNames } from "./format";

/*
 * An agent's GitHub repositories:
 * "Todos" (no list) or "Só alguns" (an ordered list of `owner/name` and
 * `owner/*`, a whole account). The first is where the agent starts when
 * nobody names a repository.
 */

export interface RepoChoice {
  mode: "all" | "some";
  list: string[];
}

export const ALL_REPOS: RepoChoice = { mode: "all", list: [] };

/** What the server says (empty = every repository) as a choice. */
export const repoChoiceOf = (list: string[]): RepoChoice => (list.length ? { mode: "some", list } : ALL_REPOS);

/** What the server takes. */
export const repoListOf = (c: RepoChoice) => (c.mode === "all" ? [] : c.list);

/** Same mode and the same list in the same order (the order says where it starts). */
export const sameRepoChoice = (a: RepoChoice, b: RepoChoice) =>
  a.mode === b.mode && (a.mode === "all" || a.list.join("\n") === b.list.join("\n"));

export const isAccount = (entry: string) => entry.endsWith("/*");
export const ownerOf = (entry: string) => entry.split("/")[0] ?? "";

/** "acme/loja", or "Toda a conta acme". */
export const repoName = (t: TFunction, entry: string) =>
  isAccount(entry) ? t("repos.wholeAccount", { owner: ownerOf(entry) }) : entry;

/** "Todos os repositórios", "acme/loja e acme/api", "Nenhum repositório". */
export function reposText(t: TFunction, c: RepoChoice) {
  if (c.mode === "all") return t("repos.all");
  if (c.list.length === 0) return t("repos.none");
  return joinNames(
    c.list.map((e) => repoName(t, e)),
    t,
  );
}

/**
 * Whether an entry still exists in what the organization's GitHub reaches.
 * Unknown (listing not loaded, or GitHub not connected): true.
 */
export function repoExists(listing: GitHubRepositories | undefined, entry: string) {
  if (!listing?.connected) return true;
  const owner = ownerOf(entry).toLowerCase();
  const account = listing.accounts.find((a) => a.login.toLowerCase() === owner);
  if (!account) return false;
  return isAccount(entry) || account.repositories.some((r) => r.fullName.toLowerCase() === entry.toLowerCase());
}

/** What "merge without asking" picks from: the repositories GitHub reaches that the agent may use (`reach`, empty: all). */
export const mergeChoices = (listing: GitHubRepositories | undefined, reach: string[]) =>
  (listing?.accounts ?? [])
    .flatMap((a) => a.repositories.map((r) => r.fullName))
    .filter((name) => reach.length === 0 || covers(reach, name));

/** Whether the list covers a repository (itself, or its whole account). */
export const covers = (list: string[], fullName: string) => {
  const f = fullName.toLowerCase();
  return list.some((e) => e.toLowerCase() === f || e.toLowerCase() === `${ownerOf(f)}/*`);
};

/** The picker's list after checking or unchecking one entry (a whole account takes its repositories' place). */
export function toggleRepo(list: string[], entry: string, on: boolean): string[] {
  const without = list.filter((e) => e.toLowerCase() !== entry.toLowerCase());
  if (!on) return without;
  if (isAccount(entry)) {
    const owner = ownerOf(entry).toLowerCase();
    return [...without.filter((e) => ownerOf(e).toLowerCase() !== owner), entry];
  }
  return [...without, entry];
}

/**
 * The draft after "Usar estes": what was there and is still picked keeps its
 * place (the first stays first); entries that no longer exist stay until
 * someone removes them; new ones go at the end.
 */
export function applyPick(old: string[], picked: RepoChoice, exists: (entry: string) => boolean): RepoChoice {
  if (picked.mode === "all") return ALL_REPOS;
  const coveredByAccount = (e: string) =>
    !isAccount(e) && picked.list.some((p) => isAccount(p) && ownerOf(p).toLowerCase() === ownerOf(e).toLowerCase());
  const kept = old.filter(
    (e) => (picked.list.some((p) => p.toLowerCase() === e.toLowerCase()) || !exists(e)) && !coveredByAccount(e),
  );
  const added = picked.list.filter((p) => !kept.some((e) => e.toLowerCase() === p.toLowerCase()));
  return { mode: "some", list: [...kept, ...added] };
}

/** Puts an entry first (where the agent starts). */
export const makeFirst = (list: string[], entry: string) => [entry, ...list.filter((e) => e !== entry)];
