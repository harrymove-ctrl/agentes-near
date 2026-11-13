import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ACCESS_LIMITS, parseAccess, type RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import { allowedFor, foldersFor } from "../../runner/access";
import { lookFiles } from "../../runner/desktop-look";
import type { RunCommand } from "../../runner/service";
import {
  duGb,
  ensureSingleShared,
  ensureSystemShared,
  sharedSizeGb,
  systemShared,
  withShared,
} from "../../runner/shared-folder";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const NOTHING: RunnerAccess = { folders: [], tools: { claude: true, codex: true, commands: true } };

function fakeRun(fail: Record<string, number> = {}) {
  const calls: string[] = [];
  const run: RunCommand = (file, args) => {
    calls.push([file, ...args].join(" "));
    const code = fail[file] ?? 0;
    return { code, output: code ? `${file}: not found` : "" };
  };
  return { run, calls };
}

test("system mode: the group, the folder (root and the group, setgid) with its default ACLs, then bin/ by umask", () => {
  const { run, calls } = fakeRun();
  expect(ensureSystemShared(systemShared(), run)).toEqual([]);
  expect(calls).toEqual([
    "groupadd --system -f agentes-shared",
    "install -d -m 0755 -o root -g root /srv/agentes",
    "install -d -m 2770 -o root -g agentes-shared /srv/agentes/shared",
    "setfacl -m g:agentes-shared:rwx,d:g:agentes-shared:rwX,d:m::rwX,d:o::- /srv/agentes/shared",
    'sh -c umask 007 && mkdir -p -- "$1" sh /srv/agentes/shared/bin',
  ]);
  // Nothing inside the folder is ever chmodded or chowned: an agent may have put a link there.
  expect(calls.filter((c) => /^(chmod|chown|install)/.test(c) && c.includes("/srv/agentes/shared/"))).toEqual([]);
});

test("without setfacl the folder is still made (and said); a group that can't be made stops there", () => {
  const noAcl = fakeRun({ setfacl: 127 });
  expect(ensureSystemShared(systemShared(), noAcl.run)).toEqual(["setfacl failed (127): setfacl: not found"]);
  expect(noAcl.calls.at(-1)).toStartWith("sh -c umask 007");

  const noGroup = fakeRun({ groupadd: 10 });
  expect(ensureSystemShared(systemShared(), noGroup.run)).toHaveLength(1);
  expect(noGroup.calls).toEqual(["groupadd --system -f agentes-shared"]);
});

test("the server's own computer: a folder and a group per organization's runner", () => {
  expect(systemShared("0a1b2c3d")).toEqual({ path: "/srv/agentes/shared-0a1b2c3d", group: "agentes-sh-0a1b2c3d" });
  expect(systemShared()).toEqual({ path: "/srv/agentes/shared", group: "agentes-shared" });
});

test("single-user mode: <workspace>/shared with its bin/", () => {
  const ws = tempDir("shared-ws-");
  dirs.push(ws);
  expect(ensureSingleShared(ws)).toBe(path.join(ws, "shared"));
  expect(existsSync(path.join(ws, "shared", "bin"))).toBe(true);
  // Again: what is there stays.
  writeFileSync(path.join(ws, "shared", "notes.txt"), "kept");
  ensureSingleShared(ws);
  expect(existsSync(path.join(ws, "shared", "notes.txt"))).toBe(true);
});

test("the shared folder is granted to every agent, once; file access follows the grant", () => {
  const ws = tempDir("shared-grant-");
  dirs.push(ws);
  const shared = ensureSingleShared(ws);
  const access = withShared(
    {
      ...NOTHING,
      folders: [
        { path: "/data", agents: ["agent-1"] },
        { path: shared, agents: ["agent-1"] },
      ],
    },
    shared,
  );
  expect(access.folders).toEqual([
    { path: shared, agents: ["*"] },
    { path: "/data", agents: ["agent-1"] },
  ]);
  expect(withShared(access, shared)).toBe(access);
  expect(withShared(NOTHING, null)).toBe(NOTHING);

  expect(foldersFor(access, "agent-2")).toEqual([shared]);
  expect(foldersFor(access, "agent-1")).toEqual([shared, "/data"]);
  // First: the server keeps only the first ACCESS_LIMITS.folders of a report, so 100 folders never hide it.
  const full = withShared(
    { ...NOTHING, folders: Array.from({ length: ACCESS_LIMITS.folders }, (_, i) => ({ path: `/d${i}`, agents: [] })) },
    shared,
  );
  expect(parseAccess(full)?.folders[0]).toEqual({ path: shared, agents: ["*"] });
  expect(foldersFor(access, undefined)).toEqual([]);
  expect(allowedFor(access, "agent-2", path.join(shared, "repo", "README.md"))).toBe(true);
  expect(allowedFor(access, "agent-2", "/data/x")).toBe(false);
});

test("du's total: kilobytes to GB with one decimal, even after its complaints; nothing printed is unknown", async () => {
  expect(duGb("1048576\t/srv/agentes/shared\n")).toBe(1);
  expect(duGb("209716\t/x\n")).toBe(0.2);
  expect(duGb("")).toBeNull();
  if (process.platform === "win32") return;
  const dir = tempDir("shared-du-");
  dirs.push(dir);
  writeFileSync(path.join(dir, "a"), Buffer.alloc(4096));
  expect(await sharedSizeGb(dir)).toBe(0);
});

test("the desktop's file manager has a Shared bookmark only where there is a shared folder", () => {
  const o = {
    theme: "stock" as const,
    dock: "panel" as const,
    agent: { handle: "ada", name: "Ada" },
    shell: "/bin/bash",
    browser: ["/bin/true"],
  };
  const bookmarks = (shared?: string) =>
    lookFiles("/home/ag-01a142cb", { ...o, ...(shared ? { shared } : {}) })
      .find((f) => f.path === ".config/gtk-3.0/bookmarks")
      ?.data.toString();
  expect(bookmarks("/srv/agentes/shared")).toBe("file:///srv/agentes/shared Shared\n");
  expect(bookmarks()).toBeUndefined();
});
