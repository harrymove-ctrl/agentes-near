import { expect, test } from "bun:test";
import { HARDENED_GIT_ARGS, isGitInternalPath, unsafeRepoConfig } from "../../runner/git-guard";

const listing = (...pairs: [string, string][]) => pairs.map(([scope, key]) => `${scope}\0${key}\0`).join("");

test("a repository's own config passes only with keys that never name a program", () => {
  // What a fresh partial clone and `git.sync`'s own settings leave.
  const clean = listing(
    ["global", "core.sshcommand"],
    ["system", "filter.lfs.clean"],
    ["local", "core.repositoryformatversion"],
    ["local", "core.hookspath"],
    ["local", "remote.origin.url"],
    ["local", "remote.origin.promisor"],
    ["local", "remote.origin.partialclonefilter"],
    ["local", "remote.my.fork.fetch"],
    ["local", "branch.agentes/dev/fix.merge"],
    ["local", "credential.helper"],
    ["local", "user.email"],
    ["local", "push.autosetupremote"],
    ["local", "lfs.repositoryformatversion"],
    // Left by everyday tools: `gh repo set-default`, colors, signing on, merge and diff styles.
    ["local", "remote.origin.gh-resolved"],
    ["local", "color.diff.meta"],
    ["local", "commit.gpgsign"],
    ["local", "merge.conflictstyle"],
    ["local", "diff.algorithm"],
    ["local", "pull.rebase"],
    ["command", "core.fsmonitor"],
  );
  expect(unsafeRepoConfig(clean)).toBeNull();
  for (const key of [
    "include.path",
    "includeif.gitdir:/x.path",
    "filter.evil.clean",
    "filter.evil.process",
    "diff.x.textconv",
    "diff.external",
    "merge.x.driver",
    "gpg.program",
    "gpg.ssh.program",
    "core.sshcommand",
    "core.pager",
    "core.editor",
    "core.worktree",
    "core.gitproxy",
    "url.ext::sh.insteadof",
    "protocol.ext.allow",
    "remote.origin.uploadpack",
    "remote.origin.vcs",
    "credential.https://x.helper",
    "submodule.a.update",
    "lfs.customtransfer.x.path",
    "uploadpack.packobjectshook",
  ]) {
    expect(unsafeRepoConfig(listing(["local", "core.bare"], ["local", key]))).toBe(key);
    expect(unsafeRepoConfig(listing(["worktree", key]))).toBe(key);
  }
});

test("paths in a git dir, in every spelling the file system takes as .git", () => {
  for (const p of [
    ".git",
    ".git/config",
    "repos/a/b/.git/hooks/post-merge",
    "repos/a/.GIT/config",
    "repos/a/.git./config",
    "repos/a/.git /config",
    "repos\\a\\.git\\config",
    "repos/a/GIT~1/config",
    "/Users/ana/notes/.git",
  ]) {
    expect(isGitInternalPath(p)).toBe(true);
  }
  for (const p of [".gitignore", ".gitattributes", "repos/a/.github/ci.yml", "repos/a.git/README.md", "git"]) {
    expect(isGitInternalPath(p)).toBe(false);
  }
});

test("the runner's git turns off hooks, fsmonitor, ext:: and implicit bare repositories", () => {
  const settings = HARDENED_GIT_ARGS.filter((_, i) => i % 2 === 1);
  expect(HARDENED_GIT_ARGS.filter((_, i) => i % 2 === 0).every((a) => a === "-c")).toBe(true);
  expect(settings.some((s) => s.startsWith("core.hooksPath="))).toBe(true);
  expect(settings).toContain("core.fsmonitor=false");
  expect(settings).toContain("protocol.ext.allow=never");
  expect(settings).toContain("safe.bareRepository=explicit");
});
