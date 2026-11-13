import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_UPLOAD_BYTES } from "@agenteschat/client/lib/files";
import { CP850_HIGH, readZip } from "@agenteschat/client/lib/zip";
import { ImportError, parseImport, parsePackage, readImportFiles } from "@/lib/import";
import { ARCHIVE_LIMITS } from "@/lib/import/archive";
import { paxPath, type TarEntry, tar, zip } from "./archives";

/** Archives built here from the fixture folders (fixtures/agent-import/NOTICE.md). */
const DIR = join(import.meta.dir, "fixtures", "agent-import");
const folderFiles = (name: string): Record<string, string> =>
  Object.fromEntries(
    (readdirSync(join(DIR, name), { recursive: true }) as string[])
      .filter((p) => statSync(join(DIR, name, p)).isFile())
      .sort()
      .map((p) => [p.replace(/\\/g, "/"), readFileSync(join(DIR, name, p), "utf8")]),
  );

const archive = (bytes: Uint8Array, name: string) => new File([bytes.slice()], name);
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    return err instanceof ImportError ? err.code : String(err);
  }
  return null;
};
/** Runs with lower limits, then puts them back. */
async function withLimits<T>(limits: Partial<typeof ARCHIVE_LIMITS>, run: () => Promise<T>): Promise<T> {
  const saved = { ...ARCHIVE_LIMITS };
  Object.assign(ARCHIVE_LIMITS, limits);
  try {
    return await run();
  } finally {
    Object.assign(ARCHIVE_LIMITS, saved);
  }
}

describe("archives", () => {
  test("a Hermes profile export (.tar.gz): the root folder names the profile; links are listed, never followed", async () => {
    const profile = folderFiles("hermes-profile");
    const longPath = `skills/${"deep/".repeat(22)}notes.md`;
    const entries: TarEntry[] = [
      { name: "research-bot/", type: "5" },
      ...Object.entries(profile).map(([name, data]) => ({ name: `research-bot/${name}`, data })),
      { name: "research-bot/.env", data: "OPENAI_API_KEY=archive-dotenv-value" },
      { name: "research-bot/state.db", data: new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0, 1, 2, 3]) },
      { name: "research-bot/escape.md", type: "2", link: "../../.ssh/id_rsa" },
      paxPath(`research-bot/${longPath}`),
      { name: "research-bot/placeholder", data: "Read later." },
    ];
    const { files, root } = await readImportFiles([archive(Bun.gzipSync(tar(entries)), "research-bot.tar.gz")]);
    expect(root).toBe("research-bot");
    const text = Object.fromEntries(files.map((f) => [f.name, f.text]));
    expect(text["SOUL.md"]).toBe(profile["SOUL.md"]);
    expect(text[longPath]).toBe("Read later.");
    // Never read: a credential store, a database, a link.
    expect(text[".env"]).toBe("");
    expect(text["state.db"]).toBe("");
    expect(text["escape.md"]).toBe("");

    const bundle = parseImport(files, { root });
    expect(bundle.source.app).toBe("hermes");
    expect(bundle.agents.map((a) => [a.key, a.name])).toEqual([["research-bot", "Research Bot"]]);
    expect(bundle.leftOut).toContainEqual({ kind: "secret", label: ".env" });
    expect(bundle.leftOut).toContainEqual({ kind: "file", label: "escape.md" });
    expect(JSON.stringify(bundle)).not.toContain("archive-dotenv-value");
  });

  test("a .zip with its folder inside: macOS leftovers skipped, binaries and credential files not read", async () => {
    const files = {
      "openbot-export/openbot-import.json": readFileSync(join(DIR, "openbot-run/openbot-import.json"), "utf8"),
      "openbot-export/agents/scout/skills/price-watch/SKILL.md": readFileSync(
        join(DIR, "openbot-run/agents/scout/skills/price-watch/SKILL.md"),
        "utf8",
      ),
      "openbot-export/agents/scout/avatar.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      "openbot-export/agents/scout/files/auth.json": '{"token":"zip-auth-value"}',
      "openbot-export/.DS_Store": "junk",
      "__MACOSX/openbot-export/._openbot-import.json": "junk",
    };
    const read = await readImportFiles([archive(zip(files), "openbot-export-2026-10-18.zip")]);
    expect(read.root).toBe("openbot-export");
    expect(read.files.map((f) => [f.name, f.text.length > 0])).toEqual([
      ["openbot-import.json", true],
      ["agents/scout/skills/price-watch/SKILL.md", true],
      ["agents/scout/avatar.png", false],
      ["agents/scout/files/auth.json", false],
    ]);
    const bundle = parseImport(read.files, { root: read.root });
    expect(bundle.agents.map((a) => a.key)).toEqual(["scout", "closer"]);
    expect(bundle.leftOut).toContainEqual({ kind: "secret", label: "agents/scout/files/auth.json" });
    expect(JSON.stringify(bundle)).not.toContain("zip-auth-value");
  });

  test("an archive whose top folder is part of the format keeps it", async () => {
    const files = folderFiles("paperclip-company");
    const agentsOnly = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith("agents/")));
    const read = await readImportFiles([archive(zip(agentsOnly), "agents.zip")]);
    expect(read.root).toBeNull();
    expect(read.files.map((f) => f.name)).toEqual(Object.keys(agentsOnly));
    expect(parseImport(read.files).source.app).toBe("paperclip");
  });

  test("paths that leave the archive, or are absolute, refuse it", async () => {
    const climb = tar([{ name: "profile/../../outside.md", data: "x" }]);
    expect(await failure(() => readImportFiles([archive(Bun.gzipSync(climb), "a.tgz")]))).toBe("unsafe");
    const absolute = tar([{ name: "/etc/hosts.md", data: "x" }]);
    expect(await failure(() => readImportFiles([archive(absolute, "a.tar")]))).toBe("unsafe");
    expect(await failure(() => readImportFiles([archive(zip({ "C:/Users/x/SOUL.md": "x" }), "a.zip")]))).toBe("unsafe");
    expect(await failure(() => readImportFiles([archive(zip({ "ok/../../SOUL.md": "x" }), "a.zip")]))).toBe("unsafe");
  });

  test("size, entry count and unpacking ratio are capped", async () => {
    const small = tar([
      { name: "a/SOUL.md", data: "x" },
      { name: "a/USER.md", data: "y" },
      { name: "a/MEMORY.md", data: "z" },
    ]);
    expect(await withLimits({ entries: 2 }, () => failure(() => readImportFiles([archive(small, "a.tar")])))).toBe(
      "tooLarge",
    );
    expect(await withLimits({ bytes: 100 }, () => failure(() => readImportFiles([archive(small, "a.tar")])))).toBe(
      "tooLarge",
    );
    // A small .tar.gz that unpacks to far more than itself.
    const bomb = Bun.gzipSync(tar([{ name: "a/MEMORY.md", data: "a".repeat(2 * 1024 * 1024) }]));
    expect(
      await withLimits({ ratioFrom: 64 * 1024, ratio: 50 }, () =>
        failure(() => readImportFiles([archive(bomb, "a.tar.gz")])),
      ),
    ).toBe("tooLarge");
    // A zip that says it unpacks to almost 4 GB.
    const lying = zip({ "a/SOUL.md": "x" }, { "a/SOUL.md": 0xfffffff0 });
    expect(await failure(() => readImportFiles([archive(lying, "a.zip")]))).toBe("tooLarge");
    // An entry that says 1 KB and inflates far past it: the reader stops at the declared size.
    const big = "a".repeat(8 * 1024 * 1024);
    const bomb2 = zip({ "a/SOUL.md": "x", "a/a.bin": big }, { "a/a.bin": 1024 }, { deflate: true });
    const read = readZip(new Blob([bomb2.slice()]));
    const entry = (await read).find((e) => e.name === "a/a.bin");
    await expect(entry?.read() ?? Promise.resolve()).rejects.toThrow("too_large");
    expect(await failure(() => readImportFiles([archive(bomb2, "a.zip")]))).toBe("tooLarge");
  });

  test("a zip from an old Windows tool keeps its accented names (CP850 when not flagged UTF-8)", async () => {
    expect(CP850_HIGH).toHaveLength(128);
    const names = async (z: Uint8Array) => (await readZip(new Blob([z.slice()]))).map((e) => e.name);
    expect(await names(zip({ "notas/relatório ação.md": "x" }, {}, { cp437: true }))).toEqual([
      "notas/relatório ação.md",
    ]);
    expect(await names(zip({ "relatório.md": "x" }))).toEqual(["relatório.md"]);
  });

  test("an unreadable archive is corrupt", async () => {
    const noise = new Uint8Array(256).map((_, i) => (i * 37) % 256);
    expect(await failure(() => readImportFiles([archive(noise, "export.zip")]))).toBe("corrupt");
    expect(await failure(() => readImportFiles([archive(new Uint8Array([0x1f, 0x8b, 1, 2, 3]), "x.tar.gz")]))).toBe(
      "corrupt",
    );
    const badSum = tar([{ name: "a/SOUL.md", data: "x" }], { checksum: false });
    expect(await failure(() => readImportFiles([archive(badSum, "x.tar")]))).toBe("corrupt");
  });
});

describe("picked files", () => {
  test("a dropped folder's paths are relative to it; its name is the root", async () => {
    const picked = Object.entries(folderFiles("paperclip-company")).map(([name, text]) => ({
      path: `corner-studio/${name}`,
      file: new Blob([text]),
    }));
    const { files, root } = await readImportFiles([
      ...picked,
      { path: "corner-studio/.DS_Store", file: new Blob(["x"]) },
    ]);
    expect(root).toBe("corner-studio");
    expect(files.map((f) => f.name)).toEqual(Object.keys(folderFiles("paperclip-company")));
    expect(parseImport(files, { root }).agents.map((a) => a.key)).toEqual(["ceo", "cto"]);
  });

  test("loose files keep their names; one too large to read is listed, not read", async () => {
    const big = new File(["x".repeat(4 * 1024 * 1024 + 1)], "huge.md");
    const pkg = new File([readFileSync(join(DIR, "sales-desk.openmaus.json"), "utf8")], "sales-desk.openmaus.json");
    const { files, root } = await readImportFiles([pkg, big]);
    expect(root).toBeNull();
    expect(files.map((f) => [f.name, f.text.length > 0])).toEqual([
      ["sales-desk.openmaus.json", true],
      ["huge.md", false],
    ]);
    expect(parseImport(files).leftOut).toContainEqual({ kind: "file", label: "huge.md" });
  });
});

describe("the agents' own files", () => {
  const manifest = readFileSync(join(DIR, "openbot-run/openbot-import.json"), "utf8");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
  const bytesOf = async (read: (() => Promise<Blob>) | undefined) =>
    new Uint8Array(await ((await read?.()) ?? new Blob()).arrayBuffer());

  test("an OpenBot.run export (.zip): its files folder is the agent's, for the Drive; system files and keys stay behind", async () => {
    const exported = {
      "openbot-export/openbot-import.json": manifest,
      "openbot-export/agents/scout/files/INSTRUCTIONS.md": readFileSync(
        join(DIR, "openbot-run/agents/scout/files/INSTRUCTIONS.md"),
        "utf8",
      ),
      "openbot-export/agents/scout/files/rivals.txt": "northwind.example\n",
      "openbot-export/agents/scout/files/notes/pricing.md": "# Pricing",
      "openbot-export/agents/scout/files/charts/q3.png": png,
      "openbot-export/agents/scout/files/.env": "NORTHWIND_TOKEN=fixture-never-read",
      "openbot-export/agents/scout/files/.DS_Store": "junk",
      "openbot-export/agents/scout/files/charts/Thumbs.db": "junk",
      "__MACOSX/openbot-export/agents/scout/files/._rivals.txt": "junk",
      // What tools fetch or build again.
      "openbot-export/agents/scout/files/app/.venv/lib/site.py": "junk",
      "openbot-export/agents/scout/files/app/venv/bin/activate": "junk",
      "openbot-export/agents/scout/files/app/.next/cache.json": "junk",
    };
    const read = await readImportFiles([archive(zip(exported), "openbot-export-2026-10-18.zip")]);
    expect(read.root).toBe("openbot-export");
    expect(read.junk).toEqual([
      "agents/scout/files/.DS_Store",
      "agents/scout/files/charts/Thumbs.db",
      "agents/scout/files/._rivals.txt",
      "agents/scout/files/app/.venv/lib/site.py",
      "agents/scout/files/app/venv/bin/activate",
      "agents/scout/files/app/.next/cache.json",
    ]);

    const { bundle, files } = parsePackage(read.files, { root: read.root, junk: read.junk });
    expect(files.map((f) => [f.agent, f.path, f.size, f.skip ?? "copy"])).toEqual([
      ["scout", "rivals.txt", 18, "copy"],
      ["scout", "notes/pricing.md", 9, "copy"],
      ["scout", "charts/q3.png", 10, "copy"],
      ["scout", ".env", 34, "secret"],
      ["scout", ".DS_Store", 0, "junk"],
      ["scout", "charts/Thumbs.db", 0, "junk"],
      ["scout", "._rivals.txt", 0, "junk"],
      ["scout", "app/.venv/lib/site.py", 0, "junk"],
      ["scout", "app/venv/bin/activate", 0, "junk"],
      ["scout", "app/.next/cache.json", 0, "junk"],
    ]);
    // The bytes as the archive has them, a binary's too; what stays behind can't be read at all.
    expect(await bytesOf(files[2]?.read)).toEqual(png);
    expect(new TextDecoder().decode(await bytesOf(files[0]?.read))).toBe("northwind.example\n");
    expect(files.filter((f) => f.skip).every((f) => f.read === undefined)).toBe(true);
    // INSTRUCTIONS.md is the agent's instructions, not one of its files; the folder is no longer "other files".
    expect(bundle.agents[0]?.instructions).toStartWith("You watch three competitors");
    expect(bundle.leftOut.filter((l) => l.kind === "file")).toEqual([]);
    expect(bundle.leftOut).toContainEqual({ kind: "secret", label: "agents/scout/files/.env" });
    expect(JSON.stringify(bundle)).not.toContain("fixture-never-read");
  });

  test("over the Drive's limit, no bytes to read, or a password inside: listed with why; a text a link brought is copied from its text", () => {
    const { files } = parsePackage([
      { name: "openbot-import.json", text: manifest },
      { name: "agents/scout/files/demo.mp4", text: "", size: MAX_UPLOAD_BYTES + 1, read: async () => new Blob() },
      { name: "agents/scout/files/escape.md", text: "" },
      { name: "agents/scout/files/servers.md", text: "Deploy box\npassword: fixture-never-stored" },
      { name: "agents/scout/files/plan.md", text: "# Plan" },
    ]);
    expect(files.map((f) => [f.path, f.size, f.skip ?? "copy", typeof f.read])).toEqual([
      ["demo.mp4", MAX_UPLOAD_BYTES + 1, "too_large", "undefined"],
      ["escape.md", 0, "unreadable", "undefined"],
      ["servers.md", 41, "secret", "undefined"],
      ["plan.md", 6, "copy", "function"],
    ]);
  });

  test("keys stay behind whatever the file's type: by what they hold (JSON's quotes too, a script peeked at), by their names, a note named like one", async () => {
    const key = `sk-proj-${"x".repeat(24)}`;
    const pem = ["-----BEGIN PRIVATE KEY-----", "fixture", "-----END PRIVATE KEY-----"].join("\n");
    const own: Record<string, string> = {
      "accounts.json": '{"gmail":{"password":"hunter22-fixture"}}',
      "config.json": `{"apiKey":"${"f".repeat(20)}"}`,
      "prod.env": `OPENAI_API_KEY=${key}`,
      "deploy.sh": `#!/bin/sh\nexport OPENAI_API_KEY=${key}\n`,
      "run.sh": "DB_PASSWORD=fixture-never-stored ./run",
      kubeconfig: "users:\n- name: ci\n  user:\n    token: fixture-never-stored\n",
      "AuthKey_ABC123.p8": pem,
      "certs/server.crt": pem,
      "passwords.md": "- gmail: fixture",
      "credentials.md": "the logins",
      "hello.sh": "#!/bin/sh\necho hi\n",
      "fetch.py": 'token = get_token()\npassword = input("Senha: ")\n# export OPENAI_API_KEY=your-key-here\n',
      "server.key": pem,
      "Apresentação Q3.key": "PK deck",
      "cookie-recipes.pdf": "%PDF recipes",
      "password-policy.pdf": "%PDF policy",
      "notes/kubeconfig-guide.md": "# How we set up kubeconfig",
    };
    const files: Record<string, string> = { "openbot-import.json": manifest };
    for (const [path, text] of Object.entries(own)) files[`agents/scout/files/${path}`] = text;
    const entries = Object.entries(files).map(([name, data]) => ({ name, data }));
    const reads = {
      zip: await readImportFiles([archive(zip(files), "export.zip")]),
      tgz: await readImportFiles([archive(Bun.gzipSync(tar(entries)), "export.tgz")]),
      picked: await readImportFiles(entries.map((e) => ({ path: `export/${e.name}`, file: new Blob([e.data]) }))),
    };
    for (const [how, read] of Object.entries(reads)) {
      const parsed = parsePackage(read.files, { root: read.root });
      // Each one held back is named with what never comes, before Importar.
      const named = parsed.bundle.leftOut.filter((l) => l.kind === "secret").map((l) => l.label.split("/files/")[1]);
      const held = parsed.files.filter((f) => f.skip === "secret").map((f) => f.path);
      expect([how, named.sort()]).toEqual([how, held.sort()]);
      const skips = parsed.files.map((f) => [f.path, f.skip ?? "copy"]);
      expect([how, Object.fromEntries(skips)]).toEqual([
        how,
        {
          "accounts.json": "secret",
          "config.json": "secret",
          "prod.env": "secret",
          "deploy.sh": "secret",
          "run.sh": "secret",
          kubeconfig: "secret",
          "AuthKey_ABC123.p8": "secret",
          "certs/server.crt": "secret",
          "passwords.md": "secret",
          "credentials.md": "secret",
          "hello.sh": "copy",
          "fetch.py": "copy",
          "server.key": "secret",
          "Apresentação Q3.key": "copy",
          "cookie-recipes.pdf": "copy",
          "password-policy.pdf": "copy",
          "notes/kubeconfig-guide.md": "copy",
        },
      ]);
    }
  });

  test("an OpenClaw state folder (.tar.gz): each workspace's own files, never its skills; read back from the archive", async () => {
    const report = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4]);
    const entries: TarEntry[] = [
      { name: ".openclaw/openclaw.json", data: '{ agents: { list: [{ id: "main" }, { id: "ops" }] } }' },
      { name: ".openclaw/workspace/SOUL.md", data: "You are Pinch." },
      { name: ".openclaw/workspace/IDENTITY.md", data: "- Name: Pinch" },
      { name: ".openclaw/workspace/notes/ideas.md", data: "Ideas." },
      {
        name: ".openclaw/workspace/skills/grocery/SKILL.md",
        data: "---\nname: grocery\ndescription: Lists.\n---\nList.",
      },
      { name: ".openclaw/workspace/skills/grocery/merge.py", data: "print(1)" },
      { name: ".openclaw/workspace-ops/SOUL.md", data: "You keep the servers up." },
      { name: ".openclaw/workspace-ops/AGENTS.md", data: "Page the on-call." },
      { name: ".openclaw/workspace-ops/reports/uptime.pdf", data: report },
      { name: ".openclaw/workspace-ops/.git/HEAD", data: "ref: refs/heads/main" },
      { name: ".openclaw/agents/ops/sessions/1.jsonl", data: "{}" },
    ];
    const read = await readImportFiles([archive(Bun.gzipSync(tar(entries)), "openclaw.tgz")]);
    const { files } = parsePackage(read.files, { root: read.root, junk: read.junk });
    expect(files.map((f) => [f.agent, f.path, f.skip ?? "copy"])).toEqual([
      ["main", "notes/ideas.md", "copy"],
      ["ops", "reports/uptime.pdf", "copy"],
      ["ops", ".git/HEAD", "junk"],
    ]);
    expect(await bytesOf(files[1]?.read)).toEqual(report);
    expect(new TextDecoder().decode(await bytesOf(files[0]?.read))).toBe("Ideas.");
  });

  test("a Claw package: the files it puts in the workspace, at their place there", () => {
    const { bundle, files } = parsePackage([
      {
        name: "CLAW.md",
        text: [
          "---",
          "schemaVersion: 1",
          "agent:",
          "  id: researcher",
          "  name: Researcher",
          "workspace:",
          "  files:",
          "    - path: templates/brief.md",
          "      source: assets/brief-template.md",
          "    - path: missing.md",
          "      source: assets/missing.md",
          "---",
          "Be curious.",
        ].join("\n"),
      },
      { name: "assets/brief-template.md", text: "# Brief" },
    ]);
    expect(files.map((f) => [f.agent, f.path, f.skip ?? "copy"])).toEqual([
      ["researcher", "templates/brief.md", "copy"],
    ]);
    expect(bundle.leftOut).toContainEqual({ kind: "file", label: "missing.md" });
  });
});
