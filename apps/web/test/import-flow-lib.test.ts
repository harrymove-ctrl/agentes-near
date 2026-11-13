import { describe, expect, test } from "bun:test";
import type {
  ApiClient,
  ImportedFile,
  ImportFileInput,
  ImportInput,
  ImportItemResult,
  MigrationBundle,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";
import { type AgentFile, ImportError } from "@/lib/import";
import {
  agentsArrived,
  agentsSince,
  applyInChunks,
  blockedItems,
  bundleOrigin,
  copyAgentFiles,
  defaultMethod,
  filesNotes,
  githubRoot,
  IMPORT_CARDS,
  isGithubLink,
  NOT_GITHUB,
  PER_APPLY,
  picksOf,
  retryable,
  sliceBundle,
  todoLine,
} from "@/lib/import-flow";

const bundle = (over: Partial<MigrationBundle> = {}): MigrationBundle => ({
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "openclaw", ref: "openclaw:pinch", name: "Pinch", files: [] },
  agents: [],
  skills: [],
  channels: [],
  routines: [],
  notes: [],
  todo: [],
  leftOut: [],
  ...over,
});
const agent = (key: string) => ({
  key,
  name: key,
  handle: key,
  role: "",
  instructions: "",
  model: null,
  appearance: {},
  skills: [],
});
const item = (id: string, action: ImportItemResult["action"] = "create"): ImportItemResult => {
  const [kind, key] = id.split(":") as [ImportItemResult["kind"], string];
  return { kind, key, label: key, action };
};

describe("where a bundle came from", () => {
  test("a parsed app, our own export, a reply to the export request, an app we don't know", () => {
    const from = (app: string, ref: string) => bundleOrigin(bundle({ source: { app, ref, name: "x", files: [] } }));
    expect(bundleOrigin(bundle())).toEqual({ card: "openclaw", app: "OpenClaw" });
    expect(from("openbotrun", "grok-bot")).toEqual({ card: "openbotrun", app: "OpenBot.run" });
    expect(from("agenteschat", "agenteschat:org-1")).toEqual({ card: "agenteschat", app: "agentes.chat" });
    // The two most used apps that answer the request have cards of their own; the others share Outro app's.
    expect(from("agenteschat", "grok-bot:my-bots")).toEqual({ card: "grok-bot", app: "Grok Bot" });
    expect(from("agenteschat", "chatgpt-dots:my-dot")).toEqual({ card: "chatgpt-dots", app: "ChatGPT dots" });
    expect(from("agenteschat", "claude:projects")).toEqual({ card: "other", app: "Claude" });
    // OpenBot is still read, without a card of its own.
    expect(from("openbot", "tenant")).toEqual({ card: "other", app: "OpenBot" });
    expect(from("agenteschat", "viktor")).toEqual({ card: "other", app: null });
    expect(from("cli", "x")).toEqual({ card: "other", app: null });
  });

  test("Tentar de novo only where the network or the server failed", () => {
    const down = new ApiError(503, "unavailable", "down");
    expect(retryable({ from: "files", step: "plan", cause: down })).toBe(true);
    expect(retryable({ from: "link", step: "read", cause: new TypeError("Failed to fetch") })).toBe(true);
    // A bad link, files no app wrote, a file that couldn't be read (picked again), the server refusing.
    expect(retryable({ from: "link", step: "read", cause: new ApiError(400, "invalid_request", "404") })).toBe(false);
    expect(retryable({ from: "link", step: "read", cause: NOT_GITHUB })).toBe(false);
    expect(retryable({ from: "files", step: "parse", cause: new ImportError("unknown") })).toBe(false);
    expect(retryable({ from: "files", step: "read", cause: new Error("NotReadableError") })).toBe(false);
    expect(retryable({ from: "paste", step: "plan", cause: new ApiError(413, "import.too_large", "big") })).toBe(false);
  });

  test("only the links the server reads count as GitHub links", () => {
    expect(isGithubLink("https://github.com/acme/agents/tree/main/team")).toBe(true);
    expect(isGithubLink("https://raw.githubusercontent.com/acme/agents/main/agents.yaml")).toBe(true);
    expect(isGithubLink("http://github.com/acme/agents")).toBe(false);
    expect(isGithubLink("https://gitlab.com/acme/agents")).toBe(false);
    expect(isGithubLink("https://github.com.evil.example/acme")).toBe(false);
    expect(isGithubLink("github.com/acme/agents")).toBe(false);
  });

  test("a GitHub link names the import after its folder or file, and after the repository, never a branch", () => {
    expect(githubRoot("https://github.com/acme/agents")).toBe("agents");
    expect(githubRoot("https://github.com/acme/agents/tree/main")).toBe("agents");
    expect(githubRoot("https://github.com/acme/agents/tree/main/team")).toBe("team");
    expect(githubRoot("https://github.com/acme/agents/blob/main/team/CLAW.md")).toBe("CLAW.md");
    expect(githubRoot("https://raw.githubusercontent.com/acme/agents/main/agents.yaml")).toBe("agents.yaml");
    expect(githubRoot("https://github.com/acme/time%20de%20vendas/tree/dev")).toBe("time de vendas");
  });
});

describe("what comes", () => {
  const b = bundle({
    agents: [agent("ana"), agent("bia"), agent("cid")],
    channels: [{ key: "ops", name: "ops", topic: "", agents: [] }],
    routines: [
      {
        key: "r-ana",
        name: "R",
        agent: "ana",
        prompt: "p",
        channel: null,
        trigger: { cron: "0 9 * * *", timezone: null },
      },
      {
        key: "r-ops",
        name: "R",
        agent: "bia",
        prompt: "p",
        channel: "ops",
        trigger: { cron: "0 9 * * *", timezone: null },
      },
      {
        key: "r-cid",
        name: "R",
        agent: "cid",
        prompt: "p",
        channel: null,
        trigger: { cron: "0 9 * * *", timezone: null },
      },
    ],
    notes: [
      { key: "n-ana", agent: "ana", kind: "note", content: "x" },
      { key: "n-org", agent: null, kind: "note", content: "y" },
    ],
  });
  // cid was brought by an earlier import: what needs it comes either way.
  const items = [
    item("agent:ana"),
    item("agent:bia"),
    item("agent:cid", "unchanged"),
    item("channel:ops"),
    item("routine:r-ana"),
    item("routine:r-ops"),
    item("routine:r-cid"),
    item("note:n-ana"),
    item("note:n-org"),
  ];

  test("unchecking a new agent or channel holds back the routines and memory that need it", () => {
    const pick = new Set(["agent:bia", "routine:r-ana", "routine:r-ops", "routine:r-cid", "note:n-ana", "note:n-org"]);
    const blocked = blockedItems(b, items, pick);
    expect([...blocked]).toEqual([
      ["routine:r-ana", "agent_not_picked"],
      ["routine:r-ops", "channel_not_picked"],
      ["note:n-ana", "agent_not_picked"],
    ]);
    expect(picksOf(items, pick, blocked)).toEqual(["agent:bia", "routine:r-cid", "note:n-org"]);
  });

  test("an existing channel the agents would only now join holds back its routines when unchecked", () => {
    const joined = items.map((i) =>
      i.key === "ops" ? { ...i, action: "update" as const, reason: "exists" as const } : i,
    );
    const pick = new Set(["agent:bia", "routine:r-ops"]);
    expect([...blockedItems(b, joined, pick)]).toContainEqual(["routine:r-ops", "channel_not_picked"]);
    // One an earlier import made (an update with no note) is here either way.
    const ours = items.map((i) => (i.key === "ops" ? { ...i, action: "update" as const } : i));
    expect(blockedItems(b, ours, pick).has("routine:r-ops")).toBe(false);
  });

  test("a chunk carries its items and every agent, never the to-dos or what stays behind", () => {
    const sliced = sliceBundle(
      { ...b, todo: [{ kind: "app", label: "Gmail", agents: [] }], leftOut: [{ kind: "file", label: "x" }] },
      new Set(["agent:bia", "note:n-org"]),
    );
    // The handle a new agent gets depends on the bundle's other agents, picked or not.
    expect(sliced.agents.map((a) => a.key)).toEqual(["ana", "bia", "cid"]);
    expect(sliced.notes.map((n) => n.key)).toEqual(["n-org"]);
    expect([sliced.channels, sliced.routines, sliced.todo, sliced.leftOut]).toEqual([[], [], [], []]);
    expect(sliced.source).toEqual(b.source);
  });
});

describe("applying in chunks", () => {
  const many = bundle({
    notes: Array.from({ length: 450 }, (_, i) => ({ key: `n${i}`, agent: null, kind: "note", content: `${i}` })),
  });
  const ids = many.notes.map((n) => `note:${n.key}`);
  /** The server's answer for one chunk: every picked item made, or unchanged when made before. */
  const server = (fail?: (call: number) => boolean) => {
    const made = new Set<string>();
    const inputs: ImportInput[] = [];
    const api = {
      imports: {
        apply: async (_orgId: string, input: ImportInput) => {
          inputs.push(input);
          if (fail?.(inputs.length)) throw new Error("down");
          return {
            items: (input.pick ?? []).map((id) => {
              const result = item(id, made.has(id) ? "unchanged" : "create");
              made.add(id);
              return { ...result, targetId: `id-${id}` };
            }),
          };
        },
      },
    } as unknown as ApiClient;
    return { api, inputs };
  };

  test(`at most ${PER_APPLY} per call, in the plan's order; the report adds them up`, async () => {
    const { api, inputs } = server();
    const progress: number[] = [];
    const report = await applyInChunks(api, "org", { bundle: many, pick: ids }, new Map(), (n) => progress.push(n));
    expect(inputs.map((i) => i.pick?.length)).toEqual([200, 200, 50]);
    expect(inputs.every((i) => i.dryRun === false)).toBe(true);
    expect(inputs[1]?.bundle.notes.map((n) => n.key)).toEqual(ids.slice(200, 400).map((id) => id.slice(5)));
    expect(progress).toEqual([200, 400, 450]);
    expect(report.map((i) => `${i.kind}:${i.key}`)).toEqual(ids);
    expect(report.every((i) => i.action === "create")).toBe(true);
  });

  test("after a chunk fails, trying again keeps what the first try made as made", async () => {
    const { api, inputs } = server((call) => call === 2);
    const done = new Map<string, ImportItemResult>();
    const input = { bundle: many, pick: ids };
    await expect(applyInChunks(api, "org", input, done)).rejects.toThrow("down");
    const report = await applyInChunks(api, "org", input, done);
    expect(inputs).toHaveLength(5);
    expect(report).toHaveLength(450);
    // The first 200 come back unchanged from the server on the second try: still counted as made.
    expect(report.every((i) => i.action === "create")).toBe(true);
  });
});

describe("the agents' files to the Drive", () => {
  const file = (agent: string, path: string, text = path, extra: Partial<AgentFile> = {}): AgentFile => ({
    agent,
    path,
    size: text.length,
    read: async () => new Blob([text]),
    ...extra,
  });
  /** The backend's answer: `<folder>/<path>` once, `exists` after; `fail` decides a file's error. */
  const drive = (fail: (input: ImportFileInput) => Error | null = () => null) => {
    const titles = new Map<string, string>();
    const sent: { path: string; agentId: string; name: string; note?: string; text: string }[] = [];
    const api = {
      imports: {
        copyFile: async (_orgId: string, input: ImportFileInput): Promise<ImportedFile> => {
          const error = fail(input);
          if (error) throw error;
          sent.push({
            path: input.path,
            agentId: input.agentId,
            name: input.name,
            note: input.note,
            text: await input.file.text(),
          });
          const folder = input.agentId === "id-scout" ? "Scout" : "Closer";
          const title = `${folder}/${input.path}`;
          const there = titles.get(title);
          if (there) return { status: "exists", artifactId: there, title, folder };
          titles.set(title, `art-${titles.size + 1}`);
          return { status: "created", artifactId: `art-${titles.size}`, title, folder };
        },
      },
    } as unknown as ApiClient;
    return { api, sent };
  };
  const agentIds = new Map([
    ["scout", "id-scout"],
    ["closer", "id-closer"],
  ]);

  test("only the agents that came; what was set aside stays, with why; a name already there is never sent over", async () => {
    const { api, sent } = drive();
    const files = [
      file("scout", "rivals.txt", "northwind"),
      file("scout", "notes/pricing.md"),
      { agent: "scout", path: ".env", size: 12, skip: "secret" as const },
      { agent: "scout", path: ".DS_Store", size: 0, skip: "junk" as const },
      file("ghost", "never.md"),
    ];
    const progress: number[] = [];
    const first = await copyAgentFiles(api, "org", { files, agentIds, note: "Trazido do OpenBot.run" }, (n) =>
      progress.push(n),
    );
    expect(sent.map((x) => [x.agentId, x.path, x.name, x.note])).toEqual([
      ["id-scout", "rivals.txt", "rivals.txt", "Trazido do OpenBot.run"],
      ["id-scout", "notes/pricing.md", "pricing.md", "Trazido do OpenBot.run"],
    ]);
    expect(sent[0]?.text).toBe("northwind");
    expect(progress).toEqual([1, 2]);
    expect(first.copied).toBe(2);
    expect([...first.folders]).toEqual([["scout", "Scout"]]);
    expect(first.left.map((l) => [l.file.path, l.why])).toEqual([
      [".env", "secret"],
      [".DS_Store", "junk"],
    ]);

    // The same export again: nothing is overwritten, and the agent's folder is still where its files are.
    const again = await copyAgentFiles(api, "org", { files, agentIds, note: "" });
    expect(again.copied).toBe(0);
    expect([...again.folders]).toEqual([["scout", "Scout"]]);
    expect(again.left.map((l) => [l.file.path, l.why])).toEqual([
      [".env", "secret"],
      [".DS_Store", "junk"],
      ["rivals.txt", "exists"],
      ["notes/pricing.md", "exists"],
    ]);
  });

  test("the backend's refusals say why each file stayed behind", async () => {
    const files = [file("closer", "id_rsa.pub.txt"), file("closer", "huge.mov"), file("closer", "flaky.md")];
    const { api, sent } = drive(({ path }) => {
      if (path === "id_rsa.pub.txt") return new ApiError(400, "import.secret_file", "never");
      if (path === "huge.mov") return new ApiError(413, "artifact.file_too_large", "too large");
      return new Error("network");
    });
    const result = await copyAgentFiles(api, "org", { files, agentIds, note: "" });
    expect(sent).toEqual([]);
    expect(result.left.map((l) => [l.file.path, l.why])).toEqual([
      ["id_rsa.pub.txt", "secret"],
      ["huge.mov", "too_large"],
      ["flaky.md", "failed"],
    ]);
  });

  test("once the workspace's storage is full, the files not sent yet stay behind too", async () => {
    const files = ["full.md", "b.md", "c.md", "d.md", "e.md", "f.md"].map((path) => file("scout", path));
    const { api, sent } = drive(({ path }) => (path === "full.md" ? new ApiError(409, "storage.full", "full") : null));
    const result = await copyAgentFiles(api, "org", { files, agentIds, note: "" });
    const why = Object.fromEntries(result.left.map((l) => [l.file.path, l.why]));
    expect(why["full.md"]).toBe("storage_full");
    // Sent before the answer came, or kept back with that reason: never lost, never sent after it.
    for (const path of ["b.md", "c.md", "d.md", "e.md", "f.md"]) {
      expect(sent.some((x) => x.path === path) !== (why[path] === "storage_full")).toBe(true);
    }
    expect(why["f.md"]).toBe("storage_full");
  });

  test("files go for the agents the preview shows coming, each once: never an unchecked update, a failed one on the next try", () => {
    const agent = (key: string, action: ImportItemResult["action"], targetId?: string): ImportItemResult => ({
      kind: "agent",
      key,
      label: key,
      action,
      ...(targetId ? { targetId } : {}),
    });
    const planned = [
      agent("scout", "update", "id-scout"),
      agent("closer", "create"),
      agent("pinch", "create"),
      agent("ana", "unchanged", "id-ana"),
    ];
    const pick = new Set(["agent:closer", "agent:pinch"]);
    // Scout's update unchecked; Pinch failed this time.
    const first = agentsArrived(
      planned,
      [agent("closer", "create", "id-closer"), agent("pinch", "skip")],
      pick,
      new Set(),
    );
    expect([...first]).toEqual([
      ["closer", "id-closer"],
      ["ana", "id-ana"],
    ]);
    // Tentar de novo: Pinch arrives, the others were sent already.
    const again = agentsArrived(
      planned,
      [agent("closer", "unchanged", "id-closer"), agent("pinch", "create", "id-pinch")],
      pick,
      new Set(first.keys()),
    );
    expect([...again]).toEqual([["pinch", "id-pinch"]]);
  });

  test("each agent keeps one line about where its files are", () => {
    const notes = filesNotes(new Map([["scout", "Scout"]]), (folder) => `Seus arquivos estão em Drive › ${folder}.`);
    expect(notes).toEqual([
      { key: "scout/drive-files", agent: "scout", kind: "fact", content: "Seus arquivos estão em Drive › Scout." },
    ]);
  });
});

describe("Conectar com MCP", () => {
  test("the default way in: MCP where the app takes it and apps reach this server; a dot asks first", () => {
    const pick = (reachable: boolean) => IMPORT_CARDS.filter((c) => defaultMethod(c, reachable) === "mcp");
    expect(pick(true)).toEqual(["grok-bot", "openbotrun", "openmausbot", "hermes", "openclaw", "other"]);
    expect(pick(false)).toEqual([]);
  });

  test("arrived: my agents not there when the steps opened, never another person's", () => {
    const list = [
      { id: "a-old", ownerUserId: "u-me" },
      { id: "a-new", ownerUserId: "u-me" },
      { id: "a-theirs", ownerUserId: "u-them" },
      { id: "a-nobody", ownerUserId: null },
    ];
    expect(agentsSince(list, new Set(["a-old"]), "u-me").map((a) => a.id)).toEqual(["a-new"]);
    expect(agentsSince(list, new Set(list.map((a) => a.id)), "u-me")).toEqual([]);
  });
});

describe("todoLine", () => {
  const pt = createI18n("pt-BR");
  const en = createI18n("en");
  const names: Record<string, string> = { ada: "Ada", theo: "Theo" };
  const nameOf = (key: string) => names[key] ?? key;
  const line = (lang: typeof pt, todo: MigrationBundle["todo"][number]) =>
    todoLine(lang.t.bind(lang) as TFunction, todo, nameOf);

  test("says who needs what, one agent or several, in both languages", () => {
    expect(line(pt, { kind: "app", label: "HubSpot", agents: ["ada"] })).toBe("Ada usa o HubSpot.");
    expect(line(pt, { kind: "connection", label: "HubSpot", agents: ["ada", "theo"] })).toBe(
      "Ada e Theo usam o HubSpot.",
    );
    expect(line(en, { kind: "app", label: "HubSpot", agents: ["ada"] })).toBe("Ada uses HubSpot.");
    expect(line(en, { kind: "app", label: "HubSpot", agents: ["ada", "theo"] })).toBe("Ada and Theo use HubSpot.");
  });

  test("with no agent named, the import is the subject; a key says the agent asks for it", () => {
    expect(line(pt, { kind: "app", label: "Reddit", agents: [] })).toBe("Esta importação usa o Reddit.");
    expect(line(en, { kind: "app", label: "Reddit", agents: [] })).toBe("This import uses Reddit.");
    expect(line(pt, { kind: "secret", label: "GH_TOKEN", agents: ["ada"] })).toBe(
      "Ada usa GH_TOKEN. Não vem no arquivo: o agente pede no chat.",
    );
  });
});
