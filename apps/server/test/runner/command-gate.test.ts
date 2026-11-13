import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ASK_AGAIN, DELETE_BRANCHES_POINTER } from "@agenteschat/adapters/command-policy";
import {
  allowedMerge,
  commandApproval,
  lonePush,
  pushesOwnBranches,
  pushThroughProxy,
  repoFacts,
} from "../../runner/command-gate";
import { gitRepo, hasGit, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const own = ["agentes/dev/"];
const hold = (command: string, cwd: string | null, extra: { head?: string; script?: boolean } = {}) =>
  commandApproval(command, { cwd, own, how: ASK_AGAIN, ...extra });
/** Why it waits for a person, or never runs (null: it runs). */
const gate = async (command: string, cwd: string | null, extra: { head?: string; script?: boolean } = {}) =>
  (await hold(command, cwd, extra))?.message ?? null;
/** Our git proxy's URL for acme/app (any host: the computer reads the shape). */
const PROXY =
  "https://agentes.test/api/git/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5c/acme/app.git";

test.skipIf(!hasGit)(
  "the default branch is read from git (origin/HEAD, else the remote's HEAD), never assumed; unknown waits",
  async () => {
    const { root, work, git } = gitRepo(dirs);
    expect(await gate("git push origin develop", work)).toBe(
      "This push goes to the default branch develop: a person approves it first. To ask them, make the same call again with why set to your reason: it waits for their decision in the chat. Or push to a branch of your own (agentes/dev/…) and open a pull request.",
    );
    // main isn't this repository's default branch: ordinary work.
    expect(await gate("git push origin main", work)).toBeNull();
    expect(await gate("git push origin pr-914:cursor/pap-582-fix", work)).toBeNull();
    // A bare push goes where the branch tracks: the pull request's branch here, the default one from develop.
    expect(await gate("git push", work)).toBeNull();
    git("checkout", "-q", "develop");
    expect(await gate("git push", work)).toContain("This push goes to the default branch develop");
    expect(await gate("git push -u origin HEAD", work)).toContain("This push goes to the default branch develop");
    git("checkout", "-q", "cursor/pap-582-fix");
    // Without origin/HEAD the remote itself says which branch is its default.
    git("remote", "set-head", "origin", "-d");
    expect(await gate("git push origin develop", work)).toContain("This push goes to the default branch develop");
    // A remote that can't be read: git can't tell, so the push waits (but never for the agent's own branches).
    git("remote", "set-url", "origin", path.join(root, "gone.git"));
    expect(await gate("git push origin fix", work)).toContain(
      "git can't tell this repository's default branch, so this push may go to it: a person approves it first.",
    );
    expect(await gate("git push origin agentes/dev/fix", work)).toBeNull();
    // Nowhere to read it from at all.
    expect(await gate("git push origin fix", null)).toContain("git can't tell this repository's default branch");
    expect(await gate("git push origin fix", tempDir("plain-"))).toContain(
      "git can't tell this repository's default branch",
    );
  },
  30_000,
);

test.skipIf(!hasGit)(
  "force pushes, deletes and protected branches wait; the folder each push runs in is followed",
  async () => {
    const { root, work, git } = gitRepo(dirs);
    expect(await gate("git push --force origin cursor/pap-582-fix", work)).toContain(
      "This is a force push to cursor/pap-582-fix, a branch others may share: a person approves it first.",
    );
    expect(await gate("git push --force-with-lease origin agentes/dev/fix", work)).toBeNull();
    expect(await gate("git push origin --delete cursor/pap-582-fix", work)).toContain(
      "This deletes the remote branch cursor/pap-582-fix",
    );
    // The repository says which branches are protected.
    git("config", "--add", "agentes.protectedBranch", "release/*");
    expect(await gate("git push origin release/2.1", work)).toContain(
      "This push goes to the protected branch release/2.1",
    );
    // `cd` and `git -C` lead to the repository, from a folder that isn't one.
    const above = path.relative(root, work);
    expect(await gate(`cd ${above} && git push origin develop`, root)).toContain("default branch develop");
    expect(await gate(`git -C ${work} push origin develop`, root)).toContain("default branch develop");
    expect(await gate(`git -C ${work} push origin main`, root)).toBeNull();
    // A task's new worktree: its branch, not the folder's.
    git("checkout", "-q", "develop");
    expect(await gate("git push -u origin HEAD", work, { head: "agentes/dev/tests" })).toBeNull();
    // The deny list's kinds are named too.
    expect(await gate("gh pr merge 914 --squash", work)).toContain("This is a merge: a person approves it first.");
  },
);

test.skipIf(!hasGit)(
  "a script a command runs is read too: a shell script as commands, other code by what it spells out",
  async () => {
    const { work } = gitRepo(dirs);
    mkdirSync(path.join(work, ".agentes"));
    writeFileSync(path.join(work, ".agentes", "run-1.sh"), "# ship it\nnpm test\ngit push origin develop\n");
    writeFileSync(path.join(work, ".agentes", "run-2.sh"), "git status\ngit push origin HEAD\n");
    writeFileSync(path.join(work, ".agentes", "run-3.py"), 'import subprocess\nsubprocess.run(["git", "push"])\n');
    const script = (command: string) => gate(command, work, { script: true });
    expect(await script("bash .agentes/run-1.sh")).toContain("This push goes to the default branch develop");
    expect(await script("bash .agentes/run-2.sh")).toBeNull();
    expect(await script("python3 .agentes/run-3.py")).toContain("This runs git push in a way the computer can't read");
    // Without `script` only the command line is read.
    expect(await gate("bash .agentes/run-1.sh", work)).toBeNull();
  },
);

test.skipIf(!hasGit)(
  "spellings git reads its own way reach the default branch too: they wait, and what can't be read waits",
  async () => {
    const { work } = gitRepo(dirs);
    for (const command of [
      "git push origin heads/develop",
      "git push origin HEAD:heads/develop",
      "sh -c 'git push origin develop'",
    ]) {
      expect([command, await gate(command, work)]).toEqual([
        command,
        expect.stringContaining("default branch develop"),
      ]);
    }
    expect(await gate("git push origin :", work)).toContain("This push updates every branch, the default one too");
    for (const command of [
      "git push --del origin cursor/pap-582-fix",
      "git push --dry-run --no-dry-run --mir origin",
      "git --some-new-option push origin develop",
      "git -c alias.p=push p origin develop",
      "echo develop | xargs git push origin",
      // git reads the branch checked out before the command changes it.
      "git checkout -q develop && git push",
    ]) {
      expect([command, await gate(command, work)]).toEqual([
        command,
        expect.stringContaining("This runs git push in a way the computer can't read"),
      ]);
    }
    // The pull request's own branch through a shell is still ordinary work.
    expect(await gate("bash -c 'git push origin HEAD'", work)).toBeNull();
  },
);

test("a push alone, and whether every ref it names is the agent's own", () => {
  const alone = (command: string) => lonePush(command);
  expect(alone("git push origin agentes/dev/fix")).not.toBeNull();
  expect(alone("npm test && git push origin agentes/dev/fix")).toBeNull();
  // An option that runs a program is never let through by the computer alone.
  expect(alone("git -c core.sshCommand=x push origin agentes/dev/fix")).toBeNull();
  expect(alone("git --exec-path=/tmp/x push origin agentes/dev/fix")).toBeNull();
  // Only git itself: no wrapper (an env variable can name a program), no shell around it.
  expect(alone("env GIT_SSH_COMMAND=x git push origin agentes/dev/fix")).toBeNull();
  expect(alone("sh -c 'git push origin agentes/dev/fix; rm -rf ~'")).toBeNull();
  const mine = (command: string) => {
    const push = lonePush(command);
    return push !== null && pushesOwnBranches(push, own);
  };
  expect(mine("git push -u origin agentes/dev/fix")).toBe(true);
  expect(mine("git push origin agentes/dev/a agentes/dev/b")).toBe(true);
  expect(mine("git push origin agentes/dev/a cursor/x")).toBe(false);
  expect(mine("git push")).toBe(false);
  expect(mine("git push origin HEAD")).toBe(false);
  expect(mine("git push origin --delete agentes/dev/a")).toBe(false);
});

test.skipIf(!hasGit)(
  "whether a remote pushes through our git proxy: every push URL, as git rewrites it; unknown is no",
  async () => {
    const { work, git } = gitRepo(dirs);
    const via = (remote: string) => repoFacts(work).viaProxy(remote);
    expect(await via("origin")).toBe(false);
    git("remote", "set-url", "--push", "origin", PROXY);
    expect(await via("origin")).toBe(true);
    // One more push URL elsewhere: not every push goes through it.
    git("remote", "set-url", "--add", "--push", "origin", "https://backup.example/acme/app.git");
    expect(await via("origin")).toBe(false);
    git("config", "--unset-all", "remote.origin.pushurl");
    // GitHub's address rewritten to the proxy (a cloud computer's insteadOf), and a pushInsteadOf away from it.
    const base = PROXY.slice(0, PROXY.indexOf("acme/"));
    git("remote", "add", "gh", "https://github.com/acme/app.git");
    git("config", `url.${base}.insteadOf`, "https://github.com/");
    expect(await via("gh")).toBe(true);
    expect(await via("https://github.com/acme/app.git")).toBe(true);
    expect(await via(PROXY)).toBe(true);
    expect(await via("https://example.com/acme/app.git")).toBe(false);
    git("config", "url.https://elsewhere.example/.pushInsteadOf", "https://github.com/");
    expect(await via("gh")).toBe(false);
    // A URL given as is: what pushInsteadOf makes of it isn't printed, so it is unknown.
    expect(await via("https://github.com/acme/app.git")).toBe(false);
    expect(await via("nope")).toBe(false);
    expect(await via("--upload-pack=x")).toBe(false);
  },
);

test.skipIf(!hasGit)(
  "through our git proxy the computer never runs what it refuses, and says where to go; another push goes up to it",
  async () => {
    const { work, git } = gitRepo(dirs);
    git("remote", "set-url", "--push", "origin", PROXY);
    expect(await hold("git push origin --delete cursor/pap-582-fix", work)).toEqual({
      message: `This deletes the remote branch cursor/pap-582-fix: ${DELETE_BRANCHES_POINTER}`,
      never: true,
    });
    expect(await hold("git push origin develop", work)).toMatchObject({
      never: true,
      message: expect.stringContaining("Push to a branch of your own"),
    });
    expect(await hold("git push --force origin cursor/pap-582-fix", work)).toMatchObject({ never: true });
    // A script it runs: the delete in it outranks a push a person could approve on the command line.
    mkdirSync(path.join(work, ".agentes"));
    writeFileSync(path.join(work, ".agentes", "clean.sh"), "git push origin --delete old\n");
    expect((await hold("bash .agentes/clean.sh", work, { script: true }))?.never).toBe(true);
    // Someone else's branch is ordinary work here: the proxy decides it with a person's grant.
    expect(await hold("git push origin cursor/pap-582-fix", work)).toBeNull();
    const push = lonePush("git push origin cursor/pap-582-fix");
    if (!push) throw new Error("no push");
    expect(await pushThroughProxy(push, work)).toBe(true);
    expect(await pushThroughProxy(push, null)).toBe(false);
    // Another remote: as before, a person may approve it with run_code.
    git("config", "--unset-all", "remote.origin.pushurl");
    expect(await hold("git push origin --delete cursor/pap-582-fix", work)).toMatchObject({ never: false });
    expect(await pushThroughProxy(push, work)).toBe(false);
  },
);

test.skipIf(!hasGit)(
  "allowedMerge: the repository as the command names it, else every remote of the folder; anything unknown stays held",
  async () => {
    const { work, git } = gitRepo(dirs);
    const repos = ["acme/app"];
    const merge = (command: string, cwd = work) => allowedMerge(command, { cwd, repos });
    // Named: the folder doesn't matter, and case doesn't either.
    expect(await merge("gh pr merge 12 -R ACME/App")).toEqual({ repo: "ACME/App", pr: 12, ref: null });
    expect(await merge("gh pr merge 12 -R acme/api")).toBeNull();
    // Not named: the remote here isn't GitHub, so nobody can tell.
    expect(await merge("gh pr merge 12")).toBeNull();
    git("remote", "set-url", "origin", "https://github.com/acme/app.git");
    expect(await merge("gh pr merge 12")).toEqual({ repo: "acme/app", pr: 12, ref: null });
    expect(await merge("git merge feature/x")).toEqual({ repo: "acme/app", pr: null, ref: "feature/x" });
    git("remote", "set-url", "origin", PROXY);
    expect(await merge("gh pr merge 12")).toEqual({ repo: "acme/app", pr: 12, ref: null });
    // A fork's upstream: gh may pick either, so it stays held.
    git("remote", "add", "upstream", "https://github.com/beta/app.git");
    expect(await merge("gh pr merge 12")).toBeNull();
    git("remote", "set-url", "upstream", "git@github.com:acme/app.git");
    expect(await merge("gh pr merge 12")).toEqual({ repo: "acme/app", pr: 12, ref: null });
    // gh goes by gh-resolved, whatever the remotes say.
    git("config", "remote.origin.gh-resolved", "base");
    expect(await merge("gh pr merge 12")).toEqual({ repo: "acme/app", pr: 12, ref: null });
    git("config", "remote.origin.gh-resolved", "beta/secret");
    expect(await merge("gh pr merge 12")).toBeNull();
    expect(await merge("gh pr merge 12 -R acme/app")).toEqual({ repo: "acme/app", pr: 12, ref: null });
    git("config", "--unset", "remote.origin.gh-resolved");
    // In another folder: that folder's remotes.
    const other = gitRepo(dirs);
    other.git("remote", "set-url", "origin", "https://github.com/beta/app.git");
    expect(await merge(`cd ${other.work} && gh pr merge 12`)).toBeNull();
    // The script a run_code writes is read like the command, and any other language stays held.
    mkdirSync(path.join(work, ".agentes"));
    writeFileSync(path.join(work, ".agentes", "run-1.sh"), "#!/bin/bash\nset -e\ngh pr merge 12 --squash\n");
    writeFileSync(path.join(work, ".agentes", "run-2.py"), "gh pr merge 12\n");
    writeFileSync(path.join(work, ".agentes", "run-3.sh"), "gh pr merge 12 && vercel deploy --prod\n");
    expect(await merge("bash .agentes/run-1.sh")).toEqual({ repo: "acme/app", pr: 12, ref: null });
    expect(await merge("python3 .agentes/run-2.py")).toBeNull();
    expect(await merge("bash .agentes/run-3.sh")).toBeNull();
    // Past what is read of a script, anything could follow.
    writeFileSync(
      path.join(work, ".agentes", "run-4.sh"),
      `gh pr merge 12\n#${"x".repeat(1024 * 1024)}\nvercel deploy --prod\n`,
    );
    expect(await merge("bash .agentes/run-4.sh")).toBeNull();
    // No list, no merge.
    expect(await allowedMerge("gh pr merge 12 -R acme/app", { cwd: work, repos: [] })).toBeNull();
  },
  30_000,
);
