import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { ARTIFACT_LIMITS, setOrgLimits } from "@agenteschat/engine";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TEAM = '{"format":"openmaus.package","version":2,"package":{}}';
const AGENTS = "agents:\n  - id: knowledge\n    name: Knowledge\n";

interface Entry {
  path: string;
  size?: number;
  type?: string;
  mode?: string;
}

/** A tenant package next to an OpenClaw-style workspace, with what must never be read. */
const PACKAGE: Entry[] = [
  { path: "tenant", type: "tree", mode: "040000" },
  { path: "tenant/.env.json" },
  { path: "tenant/CLAW.md" },
  { path: "tenant/agents.yaml", size: AGENTS.length },
  { path: "tenant/agents", type: "tree", mode: "040000" },
  { path: "tenant/agents/README.md" },
  { path: "tenant/agents/expense-review.yaml" },
  { path: "tenant/agents/scout/AGENTS.md" },
  { path: "tenant/agents/scout/deep/notes.md" },
  { path: "tenant/auth-profiles.json" },
  { path: "tenant/catalog/items.md" },
  { path: "tenant/cron/jobs.json" },
  { path: "tenant/link.md", mode: "120000" },
  { path: "tenant/logo.png", size: 2000 },
  { path: "tenant/memory/2026-10-19.md" },
  { path: "tenant/memory/2026-10-20.md" },
  { path: "tenant/model.yaml" },
  { path: "tenant/skills/triage/SKILL.md" },
  { path: "tenant/skills/triage/references/labels.md" },
  { path: "tenant/skills/triage/run.sh" },
  { path: "other/agents.yaml" },
];

/** Fake GitHub: a team file, and one repository (`acme/pacote`) listed with the recursive trees API. */
function fakeGithub(tree: Entry[] = PACKAGE, options: { truncated?: boolean } = {}) {
  const fetched: string[] = [];
  const raw = "https://raw.githubusercontent.com/acme/pacote/main/";
  const http = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (init?.redirect !== "error") return new Response("redirects must be refused", { status: 500 });
    if (url === "https://raw.githubusercontent.com/acme/time/main/sales.openmaus.json") return new Response(TEAM);
    if (url === "https://raw.githubusercontent.com/acme/time/feat%231/sales.openmaus.json") return new Response(TEAM);
    if (url === "https://api.github.com/repos/acme/pacote/git/trees/main?recursive=1") {
      const entries = tree.map((e) => ({ type: "blob", mode: "100644", size: 10, sha: "0", ...e }));
      return Response.json({ sha: "1", tree: entries, truncated: options.truncated ?? false });
    }
    if (url.startsWith(raw)) {
      const path = url.slice(raw.length).split("/").map(decodeURIComponent).join("/");
      if (!tree.some((e) => e.path === path)) return new Response("not found", { status: 404 });
      return new Response(path === "tenant/agents.yaml" ? AGENTS : `# ${path}`);
    }
    if (url.includes("/huge/")) return new Response("x".repeat(4 * 1024 * 1024 + 1));
    return new Response("not found", { status: 404 });
  };
  return { http: http as typeof fetch, fetched };
}

async function owner(options: Parameters<typeof createTestServer>[0]) {
  t = await createTestServer(options);
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const { orgId } = await seedOrg(b);
  const read = (url: string) => b(`/api/app/organizations/${orgId}/agent-imports/github`, { json: { url } });
  return { b, orgId, read };
}

type Files = { files: { path: string; text: string }[]; skipped?: string[] };

describe("reading a GitHub link for an import", () => {
  test("one file (a blob link) comes back as text; nothing is saved", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/time/blob/main/sales.openmaus.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ path: "sales.openmaus.json", text: TEAM }] });
    expect(gh.fetched).toEqual(["https://raw.githubusercontent.com/acme/time/main/sales.openmaus.json"]);
  });

  test("a branch whose name has # or % is read from that branch, its name still encoded", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/time/blob/feat%231/sales.openmaus.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [{ path: "sales.openmaus.json", text: TEAM }] });
    expect(gh.fetched).toEqual(["https://raw.githubusercontent.com/acme/time/feat%231/sales.openmaus.json"]);
  });

  test("a folder: one tree request, then only the allowlisted files, relative to the folder, memory newest first", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const res = await read("https://github.com/acme/pacote/tree/main/tenant");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Files;
    expect(body.files.map((f) => f.path)).toEqual([
      "CLAW.md",
      "agents.yaml",
      "model.yaml",
      "agents/README.md",
      "agents/expense-review.yaml",
      "agents/scout/AGENTS.md",
      "skills/triage/SKILL.md",
      "skills/triage/references/labels.md",
      "cron/jobs.json",
      "memory/2026-10-20.md",
      "memory/2026-10-19.md",
    ]);
    expect(body.files[1]?.text).toBe(AGENTS);
    expect(body.skipped).toBeUndefined();
    const never = [".env", "auth-profiles", "catalog", "deep", "link.md", "logo.png", "run.sh", "/other/"];
    expect(gh.fetched.filter((u) => never.some((n) => u.includes(n)))).toEqual([]);
    expect(gh.fetched.filter((u) => u.startsWith("https://api.github.com/"))).toHaveLength(1);
  });

  test("caps: 4 MB a file, 8 MB and 200 files in all; what doesn't fit is listed, not read", async () => {
    const mb = 1024 * 1024;
    const days = Array.from({ length: 205 }, (_, i) => ({ path: `memory/day-${String(i).padStart(3, "0")}.md` }));
    const tree = [
      { path: "a.md", size: 3.5 * mb },
      { path: "b.md", size: 3.5 * mb },
      { path: "big.json", size: 5 * mb },
      { path: "c.md", size: 3.5 * mb },
      ...days,
    ];
    const gh = fakeGithub(tree);
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    const body = (await (await read("https://github.com/acme/pacote/tree/main")).json()) as Files;
    expect(body.files).toHaveLength(200);
    expect(body.files.slice(0, 3).map((f) => f.path)).toEqual(["a.md", "b.md", "memory/day-204.md"]);
    expect(body.skipped).toEqual([
      "big.json",
      "c.md",
      ...days
        .slice(0, 7)
        .map((d) => d.path)
        .reverse(),
    ]);
    expect(gh.fetched.some((u) => u.endsWith("/big.json") || u.endsWith("/c.md") || u.endsWith("day-006.md"))).toBe(
      false,
    );

    const truncated = fakeGithub(PACKAGE, { truncated: true });
    await t?.close();
    const again = await owner({ http: truncated.http, resolveHost: async () => ["140.82.112.3"] });
    expect((await again.read("https://github.com/acme/pacote/tree/main/tenant")).status).toBe(400);
  });

  test("only GitHub over HTTPS, public addresses, within 4 MB; signed in", async () => {
    const gh = fakeGithub();
    const { read } = await owner({ http: gh.http, resolveHost: async () => ["140.82.112.3"] });
    for (const url of [
      "https://example.com/team.json",
      "http://github.com/acme/time/blob/main/sales.openmaus.json",
      "https://api.github.com/repos/acme/time/contents",
      "https://github.com.evil.example/acme/time",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect((await read(url)).status).toBe(400);
    }
    // A file type that isn't a team file or an agent definition, or where keys are kept.
    expect((await read("https://github.com/acme/time/blob/main/run.sh")).status).toBe(400);
    expect((await read("https://github.com/acme/time/blob/main/.env.json")).status).toBe(400);
    expect((await read("https://raw.githubusercontent.com/acme/huge/main/team.json")).status).toBe(400);
    expect(gh.fetched.every((u) => /^https:\/\/(raw\.githubusercontent\.com|api\.github\.com)\//.test(u))).toBe(true);

    await t?.close();
    const privateDns = await owner({ http: gh.http, resolveHost: async () => ["10.0.0.7"] });
    expect((await privateDns.read("https://github.com/acme/time/blob/main/sales.openmaus.json")).status).toBe(400);

    const anon = browser(t as TestServer);
    const res = await anon(`/api/app/organizations/${privateDns.orgId}/agent-imports/github`, {
      json: { url: "https://github.com/acme/time/blob/main/sales.openmaus.json" },
    });
    expect(res.status).toBe(401);
  });
});

/** What another app's files became in the browser: an agent, a skill, a room, a routine, a note. */
const BUNDLE = {
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "openmausbot", ref: "pkg-sales", name: "Vendas", files: ["sales.openmaus.json"] },
  agents: [
    {
      key: "scout",
      name: "Scout",
      handle: "scout",
      role: "Prospecção",
      instructions: "Ache leads.",
      model: null,
      appearance: { color: "rose" },
      skills: ["weekly"],
    },
  ],
  skills: [{ key: "weekly", markdown: "---\nname: relatorio-semanal\ndescription: Relatório semanal.\n---\nCorpo." }],
  channels: [{ key: "room", name: "vendas", topic: "Pipeline", agents: [{ key: "scout", autoReply: true }] }],
  routines: [
    {
      key: "daily",
      name: "Resumo",
      agent: "scout",
      prompt: "Resuma o pipeline.",
      channel: "room",
      trigger: { rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"], timezone: null } },
    },
  ],
  notes: [{ key: "cycle", agent: "scout", kind: "fact", content: "O ciclo de venda leva 30 dias." }],
  todo: [{ kind: "connection", label: "CRM", agents: ["scout"] }],
  leftOut: [{ kind: "picture", label: "Scout" }],
};

/** BUNDLE's agent alone, as another package (`ref`) may bring it. */
const ONLY_SCOUT = (agent: Partial<(typeof BUNDLE.agents)[number]> = {}, ref = BUNDLE.source.ref) => ({
  ...BUNDLE,
  source: { ...BUNDLE.source, ref },
  agents: [{ ...BUNDLE.agents[0], skills: [], ...agent }],
  skills: [],
  channels: [],
  routines: [],
  notes: [],
  todo: [],
  leftOut: [],
});

type Plan = { items: { kind: string; key: string; action: string; reason?: string; targetId?: string }[] };

describe("imports and the export", () => {
  test("plan, apply, apply again; what came, by source; admins only; the bundle is checked", async () => {
    const { b, orgId } = await owner({});
    const imports = `/api/app/organizations/${orgId}/imports`;
    const sources = async () => ((await (await b(imports)).json()) as { sources: unknown[] }).sources;
    const dry = await b(imports, { json: { bundle: BUNDLE, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as Plan).items.map((i) => `${i.kind}:${i.action}`)).toEqual([
      "skill:create",
      "agent:create",
      "channel:create",
      "routine:create",
      "note:create",
    ]);
    const agents = async () =>
      (
        (await (await b(`/api/app/organizations/${orgId}/agents`)).json()) as { agents: { handle: string }[] }
      ).agents.map((a) => a.handle);
    expect(await agents()).toEqual(["lodi", "dev"]);
    // Planned only: nothing came yet.
    expect(await sources()).toEqual([]);

    const applied = (await (await b(imports, { json: { bundle: BUNDLE, dryRun: false } })).json()) as Plan;
    expect(applied.items.every((i) => i.action === "create" && i.targetId)).toBe(true);
    expect(await agents()).toEqual(["lodi", "dev", "scout"]);
    const routines = (await (await b(`/api/app/organizations/${orgId}/routines`)).json()) as {
      routines: { name: string; active: boolean; nextRunAt: string | null }[];
    };
    // Imported routines arrive active, with their next run already set.
    expect(routines.routines.map((r) => [r.name, r.active])).toEqual([["Resumo", true]]);
    expect(Date.parse(routines.routines[0]?.nextRunAt ?? "")).toBeGreaterThan(Date.now());
    const again = (await (await b(imports, { json: { bundle: BUNDLE, dryRun: false } })).json()) as Plan;
    expect(again.items.map((i) => i.action)).toEqual(Array(5).fill("unchanged"));
    // What came, once, by the package it came from.
    expect(await sources()).toEqual([
      { app: "openmausbot", ref: "pkg-sales", counts: { agent: 1, skill: 1, channel: 1, routine: 1, note: 1 } },
    ]);

    expect((await b(imports, { json: { bundle: { ...BUNDLE, format: "other" }, dryRun: true } })).status).toBe(400);
    expect((await b(imports, { json: { bundle: { ...BUNDLE, version: 2 }, dryRun: true } })).status).toBe(400);

    // A member: refused, the import and the export.
    const member = await joinByInvitation(t as TestServer, b, orgId, "member@example.com");
    expect((await member(imports, { json: { bundle: BUNDLE, dryRun: true } })).status).toBe(403);
    expect((await member(imports)).status).toBe(403);
    expect((await member(`/api/app/organizations/${orgId}/export`)).status).toBe(403);

    const anon = browser(t as TestServer);
    expect((await anon(imports, { json: { bundle: BUNDLE, dryRun: true } })).status).toBe(401);
    expect((await anon(imports)).status).toBe(401);
    expect((await anon(`/api/app/organizations/${orgId}/export`)).status).toBe(401);
  });

  test("the export downloads as a file and imports into another workspace", async () => {
    // Two people with a workspace each (self-host and Cloud).
    const { b, orgId } = await owner({ env: { ALLOW_SIGNUP: "true" } });
    await b(`/api/app/organizations/${orgId}/imports`, {
      json: { bundle: BUNDLE, dryRun: false },
    });
    const res = await b(`/api/app/organizations/${orgId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="agentes-chat-\d{4}-\d{2}-\d{2}\.json"/,
    );
    const exported = (await res.json()) as typeof BUNDLE & { agents: { key: string; handle: string }[] };
    expect(exported.source).toMatchObject({ app: "agenteschat", ref: orgId, name: "Acme" });
    expect(exported.agents.map((a) => a.handle)).toEqual(["dev", "scout"]);
    expect(JSON.stringify(exported).includes("sk-ant-api-secret-9876")).toBe(false);

    const other = browser(t as TestServer);
    await signUp(other, "cloud@example.com");
    const created = (await (await other("/api/app/organizations", { json: { name: "Acme Cloud" } })).json()) as {
      organization: { id: string };
    };
    const into = `/api/app/organizations/${created.organization.id}/imports`;
    const plan = (await (await other(into, { json: { bundle: exported, dryRun: false } })).json()) as Plan;
    expect(plan.items.filter((i) => i.action !== "create").map((i) => [i.kind, i.action, i.reason])).toEqual([
      ["channel", "update", "exists"],
    ]);
    // The channel it found here was joined, not brought: it isn't counted as what came.
    expect(await (await other(into)).json()).toEqual({
      sources: [{ app: "agenteschat", ref: orgId, counts: { agent: 2, skill: 1, channel: 1, routine: 1, note: 1 } }],
    });
    const copy = (await (
      await other(`/api/app/organizations/${created.organization.id}/export`)
    ).json()) as typeof exported;
    const names = (x: typeof exported) => ({
      agents: x.agents.map((a) => a.handle),
      skills: x.skills.length,
      channels: x.channels.map((c) => c.name),
      routines: x.routines.map((r) => r.name),
      notes: x.notes.map((n) => n.content),
    });
    expect(names(copy)).toEqual(names(exported));
  });
});

describe("an imported agent's own files into the Drive", () => {
  /** A multipart POST with the browser's session cookie and our Origin. */
  const send = (b: Browser, path: string, fields: Record<string, string | File>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return (t as TestServer).app.request(path, {
      method: "POST",
      headers: { cookie: b.cookie(), origin: ORIGIN },
      body: form,
    });
  };
  type Copied = { status: string; artifactId: string; title: string; folder: string };

  test("its folder, made by the agent; a name already there stays as it was; never keys; the Drive's limits; admins only", async () => {
    const { b, orgId } = await owner({});
    const base = `/api/app/organizations/${orgId}`;
    const applied = (await (await b(`${base}/imports`, { json: { bundle: BUNDLE, dryRun: false } })).json()) as Plan;
    const scout = applied.items.find((i) => i.kind === "agent")?.targetId as string;
    const copy = (path: string, text: string, name = path.split("/").pop() as string, as = b) =>
      send(as, `${base}/imports/files`, {
        file: new File([text], name, { type: "text/markdown" }),
        agentId: scout,
        path,
        note: "Trazido do OpenBot.run",
      });

    const created = await copy("notes/plan.md", "# Plan");
    expect(created.status).toBe(201);
    const first = (await created.json()) as Copied;
    expect(first).toMatchObject({ status: "created", title: "Scout/notes/plan.md", folder: "Scout" });
    const file = (await (await b(`${base}/artifacts/${first.artifactId}`)).json()) as {
      kind: string;
      channelId: string | null;
      createdBy: { type: string; id: string };
      content: { name: string; text?: string };
    };
    // The whole workspace sees it; the agent made it (its page lists it); the first version says where it came from.
    expect(file).toMatchObject({ kind: "file", channelId: null, createdBy: { type: "agent", id: scout } });
    expect(file.content).toMatchObject({ name: "plan.md", text: "# Plan" });
    const versions = (await (await b(`${base}/artifacts/${first.artifactId}/versions`)).json()) as {
      versions: { note: string | null }[];
    };
    expect(versions.versions.map((v) => v.note)).toEqual(["Trazido do OpenBot.run"]);
    const onItsPage = (await (await b(`${base}/artifacts?authorType=agent&authorId=${scout}&changed=1`)).json()) as {
      artifacts: { id: string }[];
    };
    expect(onItsPage.artifacts.map((a) => a.id)).toEqual([first.artifactId]);
    // Who imported is who the audit names.
    const [audit] = await (t as TestServer).db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "artifact.created"), eq(schema.auditLog.targetId, first.artifactId)));
    expect(audit?.actorType).toBe("person");

    // The same name again: it stays as it was.
    const again = await copy("notes/plan.md", "# Plan, edited elsewhere");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ...first, status: "exists" });
    const kept = (await (await b(`${base}/artifacts/${first.artifactId}`)).json()) as {
      version: number;
      content: { text?: string };
    };
    expect(kept).toMatchObject({ version: 1, content: { text: "# Plan" } });

    // Never a key file (by its name, or a text with a password in it), never outside the folder.
    for (const [path, text, code] of [
      [".env", "NORTHWIND_TOKEN=fixture-never-stored", "import.secret_file"],
      ["config/credentials.json", "{}", "import.secret_file"],
      ["keys/deploy.pem", "x", "import.secret_file"],
      [".netrc", "machine example.com login scout password fixture", "import.secret_file"],
      ["notes/servers.md", "Deploy box\npassword: fixture-never-stored", "import.secret_file"],
      ["../escape.md", "x", "import.file_path"],
    ] as const) {
      const refused = await copy(path, text);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(code);
    }
    // As an archive's file comes (no type): keys by what they hold, whatever the type, JSON's quotes too; key and
    // login files by their names, a note named like one too.
    const key = `sk-proj-${"x".repeat(24)}`;
    const pem = ["-----BEGIN PRIVATE KEY-----", "fixture", "-----END PRIVATE KEY-----"].join("\n");
    const bytes = (body: string | Uint8Array, path: string) =>
      send(b, `${base}/imports/files`, {
        file: new File([body], path.split("/").pop() as string),
        agentId: scout,
        path,
      });
    const binary = new Uint8Array([0xff, 0xfe, 0, 1, ...new TextEncoder().encode(pem), 0xff]);
    for (const [path, body] of [
      ["accounts.json", '{"gmail":{"password":"hunter22-fixture"}}'],
      ["config.json", `{"apiKey":"${"f".repeat(20)}"}`],
      ["prod.env", `OPENAI_API_KEY=${key}`],
      ["deploy.sh", `#!/bin/sh\nexport OPENAI_API_KEY=${key}\n`],
      ["run.sh", "DB_PASSWORD=fixture-never-stored ./run"],
      ["kubeconfig", "users:\n- name: ci\n  user:\n    token: fixture-never-stored\n"],
      ["AuthKey_ABC123.p8", pem],
      ["certs/server.crt", pem],
      ["blob.bin", binary],
      ["passwords.md", "- gmail: fixture"],
      ["notes/credentials.md", "the logins"],
    ] as const) {
      const refused = await bytes(body, path);
      expect([path, refused.status]).toEqual([path, 400]);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("import.secret_file");
    }
    // A script or a binary with none goes like any file.
    expect((await bytes("#!/bin/sh\necho hi\n", "hello.sh")).status).toBe(201);
    expect((await bytes('token = get_token()\npassword = input("Senha: ")\n', "fetch.py")).status).toBe(201);
    expect((await bytes(new Uint8Array([0xff, 0xfe, 0, 1]), "data.bin")).status).toBe(201);

    // The Drive's limits: the workspace's storage.
    await setOrgLimits((t as TestServer).db, orgId, {
      members: null,
      membersMax: null,
      payerUserId: null,
      storageBytes: 10,
      uploadBytesPerDay: null,
      platformUsdPerMonth: null,
    });
    const full = await copy("notes/long.md", "more than ten bytes");
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe("storage.full");
    await setOrgLimits((t as TestServer).db, orgId, {
      members: null,
      membersMax: null,
      payerUserId: null,
      storageBytes: null,
      uploadBytesPerDay: null,
      platformUsdPerMonth: null,
    });
    // And 50 MB a file.
    const big = await send(b, `${base}/imports/files`, {
      file: new File([new Uint8Array(ARTIFACT_LIMITS.fileBytes + 1)], "video.mp4"),
      agentId: scout,
      path: "video.mp4",
    });
    expect([400, 413]).toContain(big.status);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("artifact.file_too_large");

    const titles = (await (await b(`${base}/artifacts?q=Scout%2F`)).json()) as { artifacts: { title: string }[] };
    expect(titles.artifacts.map((a) => a.title).sort()).toEqual([
      "Scout/data.bin",
      "Scout/fetch.py",
      "Scout/hello.sh",
      "Scout/notes/plan.md",
    ]);

    // Only who imports; and only into an agent of this workspace.
    const member = await joinByInvitation(t as TestServer, b, orgId, "member@example.com");
    expect((await copy("notes/other.md", "x", "other.md", member)).status).toBe(403);
    expect((await send(browser(t as TestServer), `${base}/imports/files`, { path: "a.md" })).status).toBe(401);
    const stranger = await send(b, `${base}/imports/files`, {
      file: new File(["x"], "a.md"),
      agentId: crypto.randomUUID(),
      path: "a.md",
    });
    expect(stranger.status).toBe(404);
  });

  test("who may create agents but not manage them copies only into the agents their own import brought", async () => {
    const { b, orgId } = await owner({});
    const base = `/api/app/organizations/${orgId}`;
    const role = await b(`${base}/roles`, { json: { name: "Builders", permissions: ["create_agents"] } });
    expect(role.status).toBe(201);
    const { id: roleId } = (await role.json()) as { id: string };
    const builder = await joinByInvitation(t as TestServer, b, orgId, "builder@example.com");
    const builderId = ((await (await builder("/api/app/me")).json()) as { user: { id: string } }).user.id;
    expect((await b(`${base}/members/${builderId}/roles`, { method: "PUT", json: { roleIds: [roleId] } })).status).toBe(
      200,
    );
    const agentOf = async (as: Browser) =>
      (
        (await (await as(`${base}/imports`, { json: { bundle: ONLY_SCOUT(), dryRun: false } })).json()) as Plan
      ).items.find((i) => i.kind === "agent")?.targetId as string;
    const admins = await agentOf(b);
    const copy = (agentId: string, path: string) =>
      send(builder, `${base}/imports/files`, { file: new File(["# Notes"], "notes.md"), agentId, path });

    // The admin's agent: as if it weren't there, so nothing is credited to it.
    expect((await copy(admins, "notes.md")).status).toBe(404);
    // Their own import's agent: like any importer.
    const mine = await agentOf(builder);
    expect(mine).not.toBe(admins);
    expect((await copy(mine, "notes.md")).status).toBe(201);
  });

  test("importing again keeps what the agent has at a path: the name trimmed as the Drive keeps it, after a rename, never another agent's file", async () => {
    const { b, orgId } = await owner({});
    const base = `/api/app/organizations/${orgId}`;
    const applied = (await (await b(`${base}/imports`, { json: { bundle: BUNDLE, dryRun: false } })).json()) as Plan;
    const scout = applied.items.find((i) => i.kind === "agent")?.targetId as string;
    const copy = (path: string, agentId = scout) =>
      send(b, `${base}/imports/files`, { file: new File(["x"], "plan.md"), agentId, path });
    const first = (await (await copy("plan.md ")).json()) as Copied;
    expect(first).toMatchObject({ status: "created", title: "Scout/plan.md" });
    expect(((await (await copy("plan.md ")).json()) as Copied).status).toBe("exists");

    // Renamed: its files stay where they are, never copied again.
    await (t as TestServer).db.update(schema.agents).set({ name: "Scout Pro" }).where(eq(schema.agents.id, scout));
    expect(await (await copy("plan.md")).json()).toEqual({ ...first, status: "exists", folder: "Scout Pro" });

    // Another agent with that name: its file at the same title is its own.
    const bundle = ONLY_SCOUT({ name: "Scout Pro", handle: "scout-pro" }, "pkg-other");
    const other = (await (await b(`${base}/imports`, { json: { bundle, dryRun: false } })).json()) as Plan;
    const theirs = (await (await copy("plan.md", other.items[0]?.targetId)).json()) as Copied;
    expect(theirs.status).toBe("created");
  });

  test("a file at the folder's top is its own, not a deeper one with the same name", async () => {
    const { b, orgId } = await owner({});
    const base = `/api/app/organizations/${orgId}`;
    const applied = (await (await b(`${base}/imports`, { json: { bundle: BUNDLE, dryRun: false } })).json()) as Plan;
    const scout = applied.items.find((i) => i.kind === "agent")?.targetId as string;
    const copy = (path: string) =>
      send(b, `${base}/imports/files`, { file: new File(["x"], "plan.md"), agentId: scout, path });
    expect((await copy("notes/plan.md")).status).toBe(201);
    const top = await copy("plan.md");
    expect(top.status).toBe(201);
    expect(((await top.json()) as Copied).title).toBe("Scout/plan.md");
  });
});
