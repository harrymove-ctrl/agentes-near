import os from "node:os";
import path from "node:path";

/**
 * The runner's own git (`git.sync`, `mission.worktree`) runs without the
 * "commands" switch, in repositories inside the agent's folder. Its settings
 * must never come from the agent: with commands off, the agent can still
 * change files there (the `write` op), and a repository's own config can make
 * git run programs (hooks, `core.fsmonitor`, filter and diff drivers,
 * `core.sshCommand`, `url.*.insteadOf` to `ext::`, includes…). So:
 *
 * - `write` refuses any path inside a `.git` folder or onto a `.git` file
 *   (`isGitInternalPath`), so the agent can't change a repository's config,
 *   hooks or where its git dir is.
 * - Every runner git command gets `HARDENED_GIT_ARGS`: no hooks, no fsmonitor,
 *   no `ext::` transport, no bare repository found by walking up.
 * - Before working in a repository, its own config (local and worktree
 *   scopes, includes followed) may only hold keys from `SAFE_REPO_KEYS`: data
 *   git reads, never a program it runs (`unsafeRepoConfig`). The person's own
 *   global and system config stay as they are (only the person writes them).
 *
 * A task's end-of-item commit (`tasks.ts`) is not this: it runs only with the
 * "commands" switch, and the repository's hooks run there on purpose.
 */
export const HARDENED_GIT_ARGS = [
  "-c",
  `core.hooksPath=${os.devNull}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "safe.bareRepository=explicit",
];

/** Repository config keys the runner's git accepts (lower case section and key; subsections any case). */
const SAFE_REPO_KEYS: RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|longpaths|untrackedcache|checkstat|trustctime|quotepath|abbrev|compression|loosecompression|sparsecheckout|sparsecheckoutcone|commitgraph|multipackindex)$/,
  // Set by tools such as husky; `HARDENED_GIT_ARGS` overrides both on every command.
  /^core\.(hookspath|fsmonitor)$/,
  /^extensions\.(objectformat|worktreeconfig|partialclone|refstorage|preciousobjects|noop)$/,
  /^remote\..+\.(url|pushurl|fetch|push|promisor|partialclonefilter|tagopt|prune|prunetags|mirror|skipdefaultupdate|skipfetchall)$/,
  /^branch\..+\.[a-z0-9-]+$/,
  // Ours (`git.sync` sets them); the helper is reset on every command that may ask for a credential.
  /^credential\.(helper|usehttppath)$/,
  /^user\.(name|email)$/,
  /^(push\.(default|autosetupremote)|pull\.(rebase|ff)|fetch\.(prune|prunetags)|init\.defaultbranch|gc\.auto|rerere\.enabled|index\.version|feature\.manyfiles)$/,
  /^submodule\..+\.(url|active|branch)$/,
  // Git LFS's own (never `lfs.customtransfer.*` or `lfs.extension.*`, which name programs).
  /^lfs\.(repositoryformatversion|url|pushurl|locksverify|fetchinclude|fetchexclude)$/,
  /^lfs\..+\.(access|locksverify)$/,
  // Preferences that name no program: the GitHub CLI's default remote, colors, signing (with the program from
  // the person's own global config; a repository's `gpg.program` stays refused), merge and diff styles.
  /^remote\..+\.gh-resolved$/,
  /^(color|advice)\.[a-z0-9.-]+$/,
  /^(commit|tag|push)\.gpgsign$/,
  /^(rebase\.(autosquash|autostash|updaterefs)|merge\.(ff|conflictstyle)|diff\.(algorithm|renames|colormoved|mnemonicprefix))$/,
  /^(status\.(showuntrackedfiles|submodulesummary)|log\.(date|decorate)|fetch\.(writecommitgraph|parallel)|push\.followtags|maintenance\.(auto|strategy))$/,
];

const isSafeRepoKey = (key: string) => SAFE_REPO_KEYS.some((re) => re.test(key));

/** The args that list a repository's config with scopes (NUL separated, includes followed). */
export const CONFIG_LIST_ARGS = ["config", "--list", "--show-scope", "--name-only", "-z"];

/**
 * The first key of a repository's own config (scope `local` or `worktree`)
 * that the runner's git won't run with, from `git config --list --show-scope
 * --name-only -z` output; null when every key is safe.
 */
export function unsafeRepoConfig(listing: string): string | null {
  const parts = listing.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] ?? "";
    const key = (parts[i + 1] ?? "").trim();
    if (scope !== "local" && scope !== "worktree") continue;
    if (key && !isSafeRepoKey(key)) return key;
  }
  return null;
}

/** Why the runner won't run git in a repository whose config has `key`. */
export const unsafeConfigMessage = (key: string) =>
  `This repository's git config has ${key}, which can run programs; the agent's computer won't run git with it. Remove it from .git/config to sync.`;

/**
 * A request path inside a `.git` folder, or a `.git` entry itself (a folder,
 * or the file that points a worktree at its git dir), in any spelling the
 * file system takes as `.git` (case, Windows' trailing dots and spaces, its
 * short name `GIT~1`).
 */
export function isGitInternalPath(p: string): boolean {
  return p
    .split(/[\\/]+/)
    .map((part) => part.toLowerCase().replace(/[. ]+$/, ""))
    .some((part) => part === ".git" || part === "git~1");
}

/** `isGitInternalPath` for the request and the absolute path it resolved to (a link may lead into a `.git`). */
export const touchesGitInternals = (requested: string, abs: string) =>
  isGitInternalPath(requested) || isGitInternalPath(abs.split(path.sep).join("/"));
