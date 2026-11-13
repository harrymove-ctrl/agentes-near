import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MigrationBundle } from "@agenteschat/client";
import { cronOf, everyMinutes, sha256, splitNote } from "@agenteschat/client/lib/import/shared";
import {
  detectSource,
  EXPORT_PROMPT,
  groupLeftOut,
  ImportError,
  type ImportFile,
  importedModel,
  interpolateEnv,
  parseImport,
  parsePackage,
  scrubSecrets,
  uniqueHandle,
} from "@/lib/import";

/**
 * Fixtures: the projects' own files where their license allows (upstream paths,
 * licenses and changes in fixtures/agent-import/NOTICE.md), and folders written
 * for these tests in the formats the projects document.
 */
const DIR = join(import.meta.dir, "fixtures", "agent-import");
const fixture = (name: string): ImportFile => ({ name, text: readFileSync(join(DIR, name), "utf8") });
/** Every file of a fixture folder, named relative to it (as a dropped folder or an archive gives them). */
const folder = (name: string): ImportFile[] =>
  (readdirSync(join(DIR, name), { recursive: true }) as string[])
    .filter((p) => statSync(join(DIR, name, p)).isFile())
    .sort()
    .map((p) => ({ name: p.replace(/\\/g, "/"), text: readFileSync(join(DIR, name, p), "utf8") }));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof ImportError ? err.code : String(err);
  }
  return null;
};
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-6.1-sol"];
const left = (b: MigrationBundle, kind: string) => b.leftOut.filter((l) => l.kind === kind).map((l) => l.label);
/** What OpenClaw writes into a workspace from a template: the body, without the frontmatter. */
const seeded = (template: string) => template.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^\s+/, "");

describe("detection", () => {
  test("each format is recognized by its content", () => {
    expect(detectSource([fixture("sales-desk.openmaus.json")])).toBe("openmausbot");
    expect(detectSource([fixture("signal-desk.md")])).toBe("openmausbot");
    expect(detectSource(folder("openmausbot-team"))).toBe("openmausbot");
    expect(detectSource([fixture("agents.yaml"), fixture("model.yaml")])).toBe("openbot");
    expect(detectSource(folder("openbot-run"))).toBe("openbotrun");
    expect(detectSource(folder("openclaw-workspace"))).toBe("openclaw");
    expect(detectSource(folder("openclaw-claw"))).toBe("openclaw");
    expect(detectSource(folder("hermes-profile"))).toBe("hermes");
    expect(detectSource(folder("paperclip-company"))).toBe("paperclip");
    expect(detectSource([{ name: "export.json", text: JSON.stringify(ourBundle) }])).toBe("agenteschat");
  });

  test("a coding repo's AGENTS.md, a README or broken YAML is none of them", () => {
    const repo = [
      { name: "AGENTS.md", text: "# Agents\n\nRun `bun test` before every commit." },
      { name: "README.md", text: "# My app" },
      { name: "package.json", text: '{"name":"my-app"}' },
    ];
    expect(detectSource(repo)).toBeNull();
    expect(code(() => parseImport(repo))).toBe("unknown");
    expect(code(() => parseImport([{ name: "x.yaml", text: "foo: [1, 2" }]))).toBe("unknown");
    expect(code(() => parseImport([{ name: "t.md", text: "  \n" }]))).toBe("empty");
    expect(code(() => parseImport([{ name: "big.json", text: "x".repeat(4 * 1024 * 1024 + 1) }]))).toBe("tooLarge");
  });
});

describe("OpenMausBot", () => {
  test("package v2: agents, skills, rooms, routines, seed memory and connections all come", () => {
    const b = parseImport([fixture("sales-desk.openmaus.json")], { models: MODELS });
    expect(b.format).toBe("agenteschat.bundle");
    expect(b.source).toEqual({
      app: "openmausbot",
      ref: "sales-desk",
      name: "Sales desk",
      files: ["sales-desk.openmaus.json"],
    });
    expect(b.agents.map((a) => [a.key, a.name, a.handle, a.role, a.model, a.skills])).toEqual([
      ["lead", "Morgan", "lead", "Sales lead", null, ["pricing-policy"]],
      ["scout", "Scout", "scout", "Prospect researcher", null, ["pricing-policy", "research-brief"]],
      ["writer", "Quill", "writer", "Outreach writer", null, []],
    ]);
    // The soul, then its playbook, then the team's shared instructions.
    expect(b.agents[0]?.instructions).toBe(
      [
        "You coordinate the desk. Keep answers short and cite the price list.",
        "## Qualify a lead\n\nDecide whether a lead is worth a call.\n\nCheck budget, authority, need and timing. Say which are unknown.",
        "## Sales desk\n\nWe sell a team plan at 49 per seat. Always quote from the price list and never promise discounts.",
      ].join("\n\n"),
    );
    // No soul: the description stands in. Their colors in our palette.
    expect(b.agents[1]?.instructions.startsWith("Finds and qualifies prospects.")).toBe(true);
    expect(b.agents.map((a) => a.appearance.color)).toEqual(["violet", "sky", "green"]);

    // skills.entries[].instructions is a whole SKILL.md, kept as written.
    expect(b.skills.map((s) => s.key)).toEqual(["pricing-policy", "research-brief", "objection-handling"]);
    expect(b.skills[0]?.markdown).toStartWith(
      "---\nname: pricing-policy\ndescription: Quote prices from the price list.\n---",
    );

    // The room's default responder is the only one answering on its own.
    expect(b.channels).toEqual([
      {
        key: "desk",
        name: "deal-desk",
        topic: "Cite sources. Morgan answers unless someone is mentioned.",
        agents: [
          { key: "lead", autoReply: true },
          { key: "scout", autoReply: false },
          { key: "writer", autoReply: false },
        ],
      },
    ]);
    expect(b.routines).toEqual([
      {
        key: "daily-digest",
        name: "Daily digest",
        agent: "scout",
        prompt: "Summarize new leads from yesterday with one line each.",
        channel: null,
        trigger: { cron: "0 9 * * 1,2,3,4,5", timezone: null },
      },
      {
        key: "weekly-review",
        name: "Weekly pipeline review",
        agent: "lead",
        prompt: "Review the pipeline together and agree the week's priorities.",
        channel: "desk",
        trigger: { cron: "0 10 * * 1", timezone: "UTC" },
      },
    ]);
    expect(b.notes).toEqual([
      {
        key: "lead/MEMORY.md",
        agent: "lead",
        kind: "note",
        content: "- The team prefers short summaries.\n- Pricing notes live in memory/pricing.md.",
      },
      {
        key: "lead/memory/pricing.md",
        agent: "lead",
        kind: "note",
        content: "# Pricing\n\nList price is 49 per seat per month.",
      },
    ]);
    expect(b.todo).toEqual([
      {
        kind: "connection",
        label: "CRM",
        agents: ["lead", "scout"],
        url: "https://mcp.example.com/crm",
      },
      { kind: "app", label: "HubSpot", agents: [] },
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "preset", labels: ["Support agent"] },
      { kind: "picture", labels: ["Morgan"] },
    ]);
  });

  test("version 1: the BotMRR Markdown playbook and the JSON read the same", () => {
    const md = parseImport([fixture("signal-desk.md")]);
    const json = parseImport([fixture("signal-desk.v1.openmaus.json")]);
    for (const b of [md, json]) {
      expect(b.source.name).toBe("Signal Desk");
      expect(b.agents.map((a) => [a.name, a.handle, a.role, a.skills])).toEqual([
        ["Package Scout", "scout", "Researcher", ["source-check"]],
        ["Package Editor", "editor", "Editor", []],
      ]);
      expect(b.agents[0]?.instructions).toBe(
        "Find evidence.\n\n## Signal Check\n\nVerify a public signal.\n\nKeep the source URL and confidence.",
      );
      expect(b.skills.map((s) => s.key)).toEqual(["source-check"]);
      expect(b.channels.map((c) => [c.name, c.agents])).toEqual([
        [
          "signal-room",
          [
            { key: "scout", autoReply: true },
            { key: "editor", autoReply: false },
          ],
        ],
      ]);
      expect(b.routines.map((r) => [r.name, r.agent, r.trigger])).toEqual([
        ["Morning signals", "scout", { cron: "0 9 * * 1,2,3,4,5", timezone: null }],
      ]);
      expect(b.todo).toEqual([{ kind: "app", label: "Reddit", agents: [] }]);
    }
    expect(md.agents).toEqual(json.agents);
  });

  test("the team file: souls and skills from files beside it, models mapped, keys named, never read", () => {
    const b = parseImport(folder("openmausbot-team"), { models: MODELS });
    expect(b.source).toMatchObject({ app: "openmausbot", ref: "launch-room", name: "Launch Room" });
    expect(b.source.files).toEqual(["launch-room.yaml", "skills/launch-report/SKILL.md", "souls/lead.md"]);
    expect(b.agents.map((a) => [a.key, a.name, a.handle, a.role, a.model, a.skills])).toEqual([
      ["room-lead", "Room Lead", "room-lead", "Launch rehearsal lead", "claude-sonnet-5-5", ["launch-report"]],
      ["priya", "Priya", "priya", "Skeptical procurement manager", null, []],
    ]);
    expect(b.agents[0]?.instructions).toBe(
      "You run launch rehearsals. Invite each visitor in turn, collect their objections, and close with a list of fixes.\n\n" +
        "## Launch Room\n\nRehearse every launch before it goes live, and keep a written log of what was found.",
    );
    expect(b.channels).toEqual([
      {
        key: "rehearsal",
        name: "rehearsal",
        topic: "Walk through the launch page the way a buyer would.",
        agents: [
          { key: "room-lead", autoReply: true },
          { key: "priya", autoReply: false },
        ],
      },
    ]);
    // A key in an environment variable is named; one in a file is never opened.
    expect(b.todo).toEqual([
      { kind: "secret", label: "ANTHROPIC_API_KEY", agents: [] },
      { kind: "secret", label: "claude baseUrl", agents: [] },
    ]);
    expect(left(b, "model")).toEqual(["openai/gpt-imaginary-1"]);
  });

  test("the Grok Bot reply to the export prompt, fenced or bare", () => {
    const reply = {
      format: "openmaus.grok/1",
      source: "Grok Bot",
      name: "Harbor",
      description: "Tracks shipping news.",
      instructions: "You track shipping news and write a daily note.",
      skills: [
        { name: "port-delays", description: "Find port delays.", body: "Check the port authority pages first." },
        "untold",
      ],
      routines: [
        {
          name: "Daily note",
          schedule: "every day at 7",
          cron: "0 7 * * *",
          timeZone: "Asia/Singapore",
          prompt: "Write the note.",
        },
        { name: "On new mail", schedule: "when a customs email arrives", cron: "", timeZone: "", prompt: "File it." },
      ],
      plugins: ["Gmail"],
      memories: ["The user ships from Rotterdam."],
    };
    const fenced = parseImport([
      { name: "reply.txt", text: `Here you go:\n\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\`\n` },
    ]);
    const bare = parseImport([{ name: "pasted", text: JSON.stringify(reply) }]);
    for (const b of [fenced, bare]) {
      expect(b.source.app).toBe("openmausbot");
      expect(b.agents.map((a) => [a.key, a.name, a.instructions, a.skills])).toEqual([
        ["harbor", "Harbor", "You track shipping news and write a daily note.", ["port-delays"]],
      ]);
      expect(b.skills[0]?.markdown).toBe(
        "---\nname: port-delays\ndescription: Find port delays.\n---\n\nCheck the port authority pages first.\n",
      );
      expect(b.routines.map((r) => r.trigger)).toEqual([{ cron: "0 7 * * *", timezone: "Asia/Singapore" }]);
      expect(left(b, "routine")).toEqual(["On new mail · when a customs email arrives"]);
      expect(left(b, "skill")).toEqual(["untold"]);
      expect(b.todo).toEqual([{ kind: "app", label: "Gmail", agents: ["harbor"] }]);
      expect(b.notes).toEqual([
        { key: "harbor/memory-1", agent: "harbor", kind: "fact", content: "The user ships from Rotterdam." },
      ]);
    }
  });

  test("a newer version, or a package with no agents", () => {
    expect(
      code(() => parseImport([{ name: "t.json", text: '{"format":"openmaus.package","version":3,"package":{}}' }])),
    ).toBe("newerVersion");
    expect(code(() => parseImport([{ name: "t.md", text: "---\nbotmrr: 2\n---\n" }]))).toBe("newerVersion");
    expect(
      code(() => parseImport([{ name: "t.json", text: '{"format":"openmaus.package","version":2,"package":{}}' }])),
    ).toBe("noAgents");
  });
});

describe("OpenBot (CopilotKit)", () => {
  const pkg = () =>
    [
      "agents.yaml",
      "expense-review.yaml",
      "model.yaml",
      "skills.yaml",
      "channels.yaml",
      "knowledge.yaml",
      "brand.yaml",
    ].map(fixture);

  test("coworkers, skills.yaml as SKILL.md, channels, knowledge and the credential as to-dos", () => {
    const b = parseImport(pkg(), { models: MODELS });
    expect(b.source).toMatchObject({ app: "openbot", ref: "openbot", name: "OpenBot" });
    expect(b.agents.map((a) => [a.key, a.name, a.handle, a.role, a.model])).toEqual([
      ["general-assistant", "General Assistant", "general-assistant", "Everyday Work", null],
      ["knowledge", "Knowledge", "knowledge", "Company Knowledge", null],
      ["expense-review", "Expense Review", "expense-review", "Finance Operations", null],
    ]);
    expect(b.agents[0]?.instructions).toBe(
      "You are a helpful general assistant. Give clear, concise, and accurate answers.",
    );
    // A folded block scalar (>-) is one paragraph.
    expect(b.agents[1]?.instructions.startsWith("Answer from the sources you can reach with the tools")).toBe(true);
    expect(b.agents[1]?.instructions).not.toContain("\n");
    expect(b.agents[0]?.skills).toEqual(["bot-creator", "skill-creator"]);
    expect(b.agents[1]?.skills).toEqual(["find-a-document", "check-a-claim", "whats-changed", "who-owns-this"]);

    expect(b.skills.map((s) => s.key)).toEqual([
      "research-public-web",
      "find-a-document",
      "find-a-notion-page",
      "whats-changed",
      "who-owns-this",
      "check-a-claim",
      "skill-creator",
      "bot-creator",
    ]);
    const find = b.skills.find((s) => s.key === "find-a-document")?.markdown ?? "";
    expect(find).toStartWith(
      "---\nname: find-a-document\ndescription: Search the connected document sources for a file and read what it says.\ntitle: Find a document\ntools:\n  - google-drive/search_files\n",
    );
    expect(find).toContain("---\n\nFind the document the person is asking about before answering anything");

    // Only coworkers that came along are members; package channels answer when mentioned.
    expect(b.channels.map((c) => [c.key, c.name, c.agents])).toEqual([
      ["general-assistant", "general-assistant", [{ key: "general-assistant", autoReply: false }]],
      ["risk-and-compliance", "risk-compliance", [{ key: "knowledge", autoReply: false }]],
      ["company-knowledge", "company-knowledge", [{ key: "knowledge", autoReply: false }]],
    ]);
    const all = ["general-assistant", "knowledge", "expense-review"];
    expect(b.todo).toEqual([
      { kind: "secret", label: "openai-api-key", agents: all },
      { kind: "app", label: "Google Drive: Policies, Compliance", agents: all },
      { kind: "app", label: "OneDrive: Risk, Operations", agents: all },
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "remote", labels: ["Risk Analyst (remote-ag-ui)", "Your Bot (remote-ag-ui)"] },
      { kind: "model", labels: ["openai/gpt-5.6-terra"] },
    ]);
  });

  test("the package's model comes when it's in our catalog", () => {
    const b = parseImport(pkg(), { models: [...MODELS, "gpt-5.6-terra"] });
    expect(b.agents.every((a) => a.model === "gpt-5.6-terra")).toBe(true);
    expect(left(b, "model")).toEqual([]);
  });

  test("a repeated id keeps the first; a lone channels.yaml has no agents", () => {
    const one =
      "id: ledger\nname: Ledger\ntitle: Finance\nrole_description: Closes the books.\ntype: built-in\nsystem_prompt: Keep the books.\n";
    const again = "id: ledger\nname: Ledger 2\ntitle: x\nrole_description: y\ntype: built-in\nsystem_prompt: z\n";
    const b = parseImport([
      { name: "agents/ledger.yaml", text: one },
      { name: "agents/ledger-copy.yml", text: again },
    ]);
    expect(b.agents.map((a) => a.name)).toEqual(["Ledger"]);
    expect(code(() => parseImport([fixture("channels.yaml")]))).toBe("noAgents");
  });
});

describe("OpenBot.run", () => {
  test("the Grok Bot migrator's archive: agents, skill folders, routines, memories, group chats", () => {
    const files = [...folder("openbot-run"), { name: "agents/scout/avatar.png", text: "" }];
    const b = parseImport(files, { models: MODELS });
    // A fresh export of the same bots is the same package: importing it again updates them.
    expect(b.source).toMatchObject({ app: "openbotrun", ref: "grok-bot", name: "Grok Bot" });
    expect(b.agents.map((a) => [a.key, a.name, a.role, a.model, a.skills])).toEqual([
      ["scout", "Scout", "Competitor scout", null, ["price-watch"]],
      ["closer", "Closer", "Account executive", null, []],
    ]);
    // The whole instructions, from files/INSTRUCTIONS.md, instead of the short version.
    expect(b.agents[0]?.instructions).toBe(
      "You watch three competitors and report changes to their prices, plans and positioning.\n\nAlways link the page you read and the date you read it.",
    );
    expect(b.agents[1]?.instructions).toBe("You write short follow-up emails. Never promise a discount.");
    expect(b.skills.map((s) => s.key)).toEqual(["price-watch"]);

    expect(b.routines.map((r) => [r.key, r.agent, r.channel, r.trigger])).toEqual([
      ["scout/morning-sweep", "scout", null, { cron: "15 8 * * 1,2,3,4,5", timezone: "Europe/Lisbon" }],
      [
        "scout/year-end-review",
        "scout",
        null,
        { rule: { freq: "once", start: "2026-12-30", times: ["10:00"], timezone: "Europe/Lisbon" } },
      ],
      ["closer/stale-deals", "closer", null, { cron: "0 17 * * 1-5", timezone: "America/Sao_Paulo" }],
      ["deal-room/friday-call", "scout", "deal-room", { cron: "0 15 * * 5", timezone: "Europe/Lisbon" }],
    ]);
    // A group chat answers through its lead; an unknown member is dropped.
    expect(b.channels).toEqual([
      {
        key: "deal-room",
        name: "deal-room",
        topic: "Weekly pricing call\n\nScout brings the news; Closer says what it changes for open deals.",
        agents: [
          { key: "scout", autoReply: true },
          { key: "closer", autoReply: false },
        ],
      },
    ]);
    expect(b.notes.map((n) => [n.agent, n.kind, n.content])).toEqual([
      ["scout", "fact", "Prices are compared in EUR."],
      ["scout", "fact", "The main rivals are Northwind and Contoso."],
      [null, "fact", "Deals above 10k need a second look."],
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "routine", labels: ["Pulse (Scout)"] },
      { kind: "picture", labels: ["Scout"] },
      { kind: "file", labels: ["agents/scout/skills/price-watch/ (1)"] },
    ]);
    // The rest of files/ is the agent's own, for its folder in the Drive.
    expect(parsePackage(files).files.map((f) => [f.agent, f.path, f.skip ?? "copy"])).toEqual([
      ["scout", "rivals.txt", "copy"],
    ]);
  });

  test("the instance transfer: models, MCP servers with names only, providers and agents it can't bring", () => {
    const transfer = {
      format: "openbot-instance-transfer",
      version: 1,
      source: { appVersion: "0.24.0", exportedAt: "2026-10-19T10:00:00Z" },
      agents: [
        {
          key: "ops",
          name: "Ops",
          title: "Operations",
          description: "Keep the servers healthy.",
          avatarSeed: "ops-seed",
          avatarHue: null,
          avatar: null,
          provider: "claude",
          model: "claude-sonnet-5-5",
          reasoningEffort: "medium",
          notifications: true,
          skills: [],
          files: null,
          routines: [],
          oneTimeRoutines: [
            {
              key: "r1",
              name: "Renew certificate",
              instruction: "Renew the TLS certificate.",
              active: true,
              timezone: "UTC",
              schedule: { kind: "once", date: "2026-11-02", time: "06:00" },
            },
          ],
          memories: [{ text: "Deploys happen on Tuesdays.", inclusion: "essential" }],
        },
      ],
      settings: {
        mcpServers: [
          {
            id: "m1",
            name: "status",
            transport: "http",
            enabled: true,
            command: "",
            args: [],
            env: [],
            envPassthrough: [],
            workingDirectory: "",
            url: "https://status.example.com/mcp",
            headers: [{ key: "X-Api-Key", value: "" }],
          },
          {
            id: "m2",
            name: "local-files",
            transport: "stdio",
            enabled: true,
            command: "npx",
            args: ["files-mcp"],
            env: [],
            envPassthrough: [],
            workingDirectory: "",
            url: "",
            headers: [],
          },
        ],
        customProviders: [
          { id: "p1", name: "My gateway", baseUrl: "https://llm.example.com", models: [], needsApiKey: true },
        ],
        customAgents: [{ id: "a1", name: "Local ACP", command: "acp-agent", args: [], envNames: [] }],
        sidebarSections: [],
        routineFlows: [],
      },
      shared: null,
      signedIn: ["claude"],
    };
    const b = parseImport([{ name: "openbot-transfer.json", text: JSON.stringify(transfer) }], { models: MODELS });
    expect(b.agents.map((a) => [a.key, a.model, a.instructions])).toEqual([
      ["ops", "claude-sonnet-5-5", "Keep the servers healthy."],
    ]);
    expect(b.routines.map((r) => r.trigger)).toEqual([
      { rule: { freq: "once", start: "2026-11-02", times: ["06:00"], timezone: "UTC" } },
    ]);
    expect(b.notes.map((n) => n.content)).toEqual(["Deploys happen on Tuesdays."]);
    expect(b.todo).toEqual([
      {
        kind: "connection",
        label: "status",
        agents: [],
        url: "https://status.example.com/mcp",
      },
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "connection", labels: ["local-files"] },
      { kind: "remote", labels: ["Local ACP"] },
      { kind: "model", labels: ["My gateway"] },
    ]);
    const newer = JSON.stringify({ ...transfer, version: 2 });
    expect(code(() => parseImport([{ name: "openbot-transfer.json", text: newer }]))).toBe("newerVersion");
  });
});

describe("OpenClaw", () => {
  test("a workspace: identity, persona, the person, memory and skills", () => {
    const files = [...folder("openclaw-workspace"), { name: "avatars/pinch.png", text: "" }];
    const b = parseImport(files, { models: MODELS, root: "workspace" });
    expect(b.source).toMatchObject({ app: "openclaw", ref: "openclaw:pinch", name: "Pinch" });
    expect(b.agents.map((a) => [a.key, a.name, a.handle, a.role, a.model, a.skills])).toEqual([
      ["pinch", "Pinch", "pinch", "lobster butler", null, ["grocery-list"]],
    ]);
    expect(b.agents[0]?.instructions).toBe(
      "# SOUL.md\n\nYou are Pinch, a calm household assistant. Keep answers short, and ask before buying anything.",
    );
    // Nested frontmatter (metadata.openclaw) stays as written.
    expect(b.skills[0]?.markdown).toBe(
      readFileSync(join(DIR, "openclaw-workspace/skills/grocery-list/SKILL.md"), "utf8"),
    );
    expect(b.notes.map((n) => [n.key, n.kind])).toEqual([
      ["pinch/USER.md", "preference"],
      ["pinch/memory/2026-10-01.md", "note"],
      ["pinch/MEMORY.md", "note"],
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "picture", labels: ["Pinch"] },
      { kind: "file", labels: ["skills/grocery-list/ (1)"] },
    ]);
    // What the agent made in its workspace is its own, for its folder in the Drive; its skills' files aren't.
    expect(parsePackage(files, { root: "workspace" }).files.map((f) => [f.agent, f.path])).toEqual([
      ["pinch", "notes/ideas.md"],
    ]);
  });

  test("files left as OpenClaw seeds them are dropped; a purpose before the AGENTS.md seed is kept", () => {
    const files = [
      { name: "SOUL.md", text: seeded(fixture("openclaw-template-SOUL.md").text) },
      {
        name: "AGENTS.md",
        text: `# Agent purpose\n\nRun the household budget.\n\n${seeded(fixture("openclaw-template-AGENTS.md").text)}`,
      },
      { name: "USER.md", text: "- Name: Dana" },
    ];
    const b = parseImport(files);
    expect(b.agents.map((a) => [a.key, a.instructions])).toEqual([["main", "Run the household budget."]]);
    expect(b.source.files).toEqual(["SOUL.md", "AGENTS.md", "USER.md"]);
  });

  test("the state folder: agents from openclaw.json (JSON5) and their workspaces; only allowed keys are read", () => {
    const config = `// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: { model: { primary: "anthropic/claude-sonnet-5-5" }, heartbeat: { every: "30m" } },
    entries: {
      main: { identity: { name: "Clawd", theme: "helpful assistant" } },
      coder: { workspace: "~/.openclaw/workspace-coder", model: "openai/gpt-4.1" }, // a trailing comma, too
    },
  },
  channels: { whatsapp: { allowFrom: ["+15555550123"] }, telegram: { botToken: "fixture-not-a-token" } },
  mcp: {
    servers: {
      docs: { url: "https://mcp.example.com/docs?key=fixture-query-key", transport: "streamable-http", headers: { Authorization: "Bearer fixture-not-a-token" } },
      files: { command: "npx", args: ["-y", "@example/files-mcp"] },
    },
  },
  env: { vars: { OPENAI_API_KEY: "fixture-env-value" } },
}`;
    const files: ImportFile[] = [
      { name: "openclaw.json", text: config },
      { name: "workspace/SOUL.md", text: "Be helpful and brief." },
      { name: "workspace/HEARTBEAT.md", text: "Check the calendar for anything in the next two hours." },
      { name: "workspace-coder/SOUL.md", text: "You write small, tested changes." },
      { name: "workspace-coder/AGENTS.md", text: "Run the tests before you say you're done." },
      {
        name: "skills/shared-notes/SKILL.md",
        text: "---\nname: shared-notes\ndescription: Keep notes tidy.\n---\n\nOne topic per note.",
      },
      { name: "credentials/whatsapp.json", text: '{"session":"fixture-session"}' },
      { name: "agents/main/agent/openclaw-agent.sqlite", text: "" },
    ];
    const b = parseImport(files, { models: MODELS, root: ".openclaw" });
    expect(b.source).toMatchObject({ app: "openclaw", ref: "openclaw", name: ".openclaw" });
    expect(b.agents.map((a) => [a.key, a.name, a.role, a.model, a.instructions, a.skills])).toEqual([
      ["main", "Clawd", "helpful assistant", "claude-sonnet-5-5", "Be helpful and brief.", ["shared-notes"]],
      [
        "coder",
        "coder",
        "",
        null,
        "You write small, tested changes.\n\nRun the tests before you say you're done.",
        ["shared-notes"],
      ],
    ]);
    expect(b.routines).toEqual([
      {
        key: "main/heartbeat",
        name: "Heartbeat",
        agent: "main",
        prompt: "Check the calendar for anything in the next two hours.",
        channel: null,
        trigger: { cron: "*/30 * * * *", timezone: null },
      },
    ]);
    // Named by the server, the address without its query; never header values.
    expect(b.todo).toEqual([
      {
        kind: "connection",
        label: "docs",
        agents: ["main", "coder"],
        url: "https://mcp.example.com/docs",
      },
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "connection", labels: ["files"] },
      { kind: "messaging", labels: ["whatsapp", "telegram"] },
      { kind: "model", labels: ["openai/gpt-4.1"] },
      { kind: "secret", labels: ["credentials/whatsapp.json"] },
      { kind: "file", labels: ["agents/ (1)"] },
    ]);
    const all = JSON.stringify(b);
    for (const value of [
      "fixture-not-a-token",
      "fixture-env-value",
      "fixture-session",
      "fixture-query-key",
      "15555550123",
    ]) {
      expect(all).not.toContain(value);
    }
  });

  test("a Claw package: CLAW.md (its body is the SOUL.md) and its workspace files", () => {
    const b = parseImport(folder("openclaw-claw"));
    expect(b.source).toMatchObject({ app: "openclaw", ref: "claw:researcher", name: "Researcher" });
    expect(b.agents.map((a) => [a.key, a.name, a.role])).toEqual([
      ["researcher", "Researcher", "curious, evidence-led research"],
    ]);
    expect(b.agents[0]?.instructions).toStartWith("# Researcher soul\n\nBe curious and skeptical in equal measure.");
    expect(b.agents[0]?.instructions).toContain("# Researcher operating program");

    const claw = `---
schemaVersion: 1
agent:
  id: ops
  name: Ops
  identity: { name: Ops, avatar: "data:image/png;base64,AAAA" }
packages:
  - { kind: skill, source: clawhub, ref: weather, version: 1.2.0 }
  - { kind: plugin, source: clawhub, ref: voice-call, version: 0.3.1 }
mcpServers:
  tickets: { url: "https://tickets.example.com/mcp", transport: streamable-http }
  shell: { command: bash }
cronJobs:
  - { id: standup, name: Standup, schedule: { cron: "0 9 * * 1-5", timezone: Europe/Berlin }, session: main, message: Post the standup. }
---

Keep the lights on.
`;
    const ops = parseImport([{ name: "CLAW.md", text: claw }]);
    expect(ops.agents.map((a) => [a.key, a.instructions])).toEqual([["ops", "Keep the lights on."]]);
    expect(ops.routines.map((r) => [r.key, r.prompt, r.trigger])).toEqual([
      ["standup", "Post the standup.", { cron: "0 9 * * 1-5", timezone: "Europe/Berlin" }],
    ]);
    expect(ops.todo.map((t) => t.label)).toEqual(["tickets"]);
    expect(groupLeftOut(ops.leftOut)).toEqual([
      { kind: "skill", labels: ["weather@1.2.0"] },
      { kind: "connection", labels: ["shell"] },
      { kind: "plugin", labels: ["voice-call@0.3.1"] },
      { kind: "picture", labels: ["Ops"] },
    ]);
    expect(
      code(() => parseImport([{ name: "CLAW.md", text: claw.replace("schemaVersion: 1", "schemaVersion: 2") }])),
    ).toBe("newerVersion");
  });
});

describe("Hermes Agent", () => {
  test("a profile export: persona, memory split by §, skills, cron jobs and MCP; credential files never read", () => {
    const files = [
      ...folder("hermes-profile"),
      { name: ".env", text: "OPENAI_API_KEY=hermes-dotenv-value" },
      { name: "auth.json", text: '{"token":"hermes-auth-value"}' },
      { name: "state.db", text: "" },
    ];
    const b = parseImport(files, { models: MODELS, root: "research-bot" });
    expect(b.source).toMatchObject({ app: "hermes", ref: "research-bot", name: "Research Bot" });
    expect(b.agents.map((a) => [a.key, a.name, a.handle, a.role, a.model, a.skills])).toEqual([
      [
        "research-bot",
        "Research Bot",
        "research-bot",
        "Finds new papers and writes short briefs.",
        "claude-opus-5-5",
        ["arxiv"],
      ],
    ]);
    expect(b.agents[0]?.instructions).toBe(
      "You are a careful research assistant. Cite every paper you mention, and say plainly when you are not sure.",
    );
    // Nested metadata.hermes stays in the SKILL.md as written.
    expect(b.skills[0]?.markdown).toBe(
      readFileSync(join(DIR, "hermes-profile/skills/research/arxiv/SKILL.md"), "utf8"),
    );
    expect(b.notes.map((n) => [n.kind, n.content])).toEqual([
      ["note", "The lab keeps references in Zotero."],
      ["note", "The weekly sync is on Tuesdays."],
      ["preference", "Prefers summaries under 200 words."],
      ["preference", "Works in UTC-3."],
    ]);
    expect(b.routines.map((r) => [r.key, r.name, r.trigger])).toEqual([
      ["research-bot/a1b2c3", "Daily briefing", { cron: "0 9 * * 1-5", timezone: null }],
    ]);
    expect(b.todo).toEqual([
      {
        kind: "connection",
        label: "papers",
        agents: ["research-bot"],
        url: "https://mcp.papers.example/sse",
      },
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "routine", labels: ["Nightly backup (Research Bot)", "Queue check (Research Bot)"] },
      { kind: "connection", labels: ["github"] },
      { kind: "secret", labels: [".env", "auth.json"] },
      { kind: "file", labels: ["sessions/ (1)", "state.db"] },
    ]);
    const all = JSON.stringify(b);
    for (const value of ["hermes-dotenv-value", "hermes-auth-value", "hermes-fixture-not-a-real", "fixture"]) {
      expect(all).not.toContain(value);
    }
  });

  test("the seeded SOUL.md is dropped; a distribution names the keys it needs", () => {
    const files = [
      { name: "SOUL.md", text: fixture("hermes-SOUL.seed.md").text },
      { name: "config.yaml", text: "model:\n  default: nous/hermes-5\n" },
      {
        name: "distribution.yaml",
        text: 'name: support-bot\ndescription: Answers support email.\nenv_requires:\n  - name: SUPPORT_API_KEY\n    description: "Ticketing API key"\n    required: true\n    default: "never-read-default"\n',
      },
    ];
    const b = parseImport(files);
    expect(b.agents.map((a) => [a.key, a.name, a.role, a.instructions])).toEqual([
      ["support-bot", "support-bot", "Answers support email.", ""],
    ]);
    expect(b.todo).toEqual([{ kind: "secret", label: "SUPPORT_API_KEY", agents: ["support-bot"] }]);
    expect(left(b, "model")).toEqual(["nous/hermes-5"]);
    expect(JSON.stringify(b)).not.toContain("never-read-default");
  });

  test("~/.hermes dragged whole: its own profile is the default one, named Hermes (not the folder)", () => {
    const files = [
      { name: "SOUL.md", text: "You keep the lab's notes in order." },
      { name: "config.yaml", text: "model:\n  default: nous/hermes-5\n" },
    ];
    const b = parseImport(files, { root: ".hermes" });
    expect(b.agents.map((a) => [a.key, a.name])).toEqual([["hermes", "Hermes"]]);
    expect(b.source.name).toBe("Hermes");
  });
});

describe("Paperclip", () => {
  test("an Agent Companies package: agents with their SOUL, TOOLS and heartbeat, skills, tasks and the sidecar", () => {
    const b = parseImport(folder("paperclip-company"), { models: MODELS });
    expect(b.source).toMatchObject({ app: "paperclip", ref: "corner-studio", name: "Corner Studio" });
    expect(b.agents.map((a) => [a.key, a.name, a.role, a.model, a.skills])).toEqual([
      ["ceo", "Ada", "Chief Executive Officer", "claude-sonnet-5-5", ["review"]],
      ["cto", "Linus", "Chief Technology Officer", null, ["review"]],
    ]);
    expect(b.agents[0]?.instructions).toBe(
      "You are direct and kind. You prefer a small shipped change to a large plan.\n\n" +
        "Set the week's priorities, review what shipped, and decide what waits.\n\n" +
        "## Tools\n\nUse the issue tracker for every decision you make.",
    );
    expect(b.skills.map((s) => s.key)).toEqual(["review"]);
    expect(b.routines.map((r) => [r.key, r.agent, r.prompt, r.trigger])).toEqual([
      [
        "ceo/heartbeat",
        "ceo",
        "Look at the open issues, and nudge the owner of anything blocked for more than a day.",
        { cron: "0 * * * *", timezone: null },
      ],
      [
        "monday-review",
        "ceo",
        "Review last week's results and set three priorities.",
        { cron: "0 9 * * 1", timezone: "America/Chicago" },
      ],
    ]);
    expect(b.notes).toEqual([
      {
        key: "COMPANY.md",
        agent: null,
        kind: "note",
        content:
          "A two-agent studio that builds small tools for independent shops.\n\n- Ship one improvement every week\n\nWe answer customers within a day and never ship on Fridays.",
      },
    ]);
    expect(b.todo).toEqual([
      { kind: "secret", label: "GH_TOKEN", agents: ["ceo"] },
      { kind: "secret", label: "OPENAI_API_KEY", agents: ["ceo", "cto"] },
    ]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "skill", labels: ["plan-ceo-review"] },
      { kind: "model", labels: ["gpt-imaginary-2"] },
      { kind: "task", labels: ["Landing page", "Q4 launch"] },
      { kind: "team", labels: ["Engineering"] },
    ]);
  });
});

const ourBundle = {
  format: "agenteschat.bundle",
  version: 1,
  source: { app: "claude", ref: "dana-claude", name: "Dana's Claude", files: [] },
  agents: [
    {
      key: "writer",
      name: "Writer",
      handle: "writer",
      role: "Newsletter writer",
      instructions: "Write the weekly newsletter in a warm voice.",
      model: "anthropic/claude-opus-5-5",
      appearance: { color: "rose", eyes: "laser", accessory: "hat" },
      skills: ["tone-check", "missing-skill"],
    },
  ],
  skills: [
    {
      key: "tone-check",
      markdown:
        "---\nname: tone-check\ndescription: Check a draft against the house voice.\n---\n\nRead it aloud; cut every adverb you can.",
    },
  ],
  channels: [
    { key: "news", name: "Newsletter", topic: "Drafts and feedback", agents: [{ key: "writer", autoReply: true }] },
  ],
  routines: [
    {
      key: "draft",
      name: "Friday draft",
      agent: "writer",
      prompt: "Draft this week's issue.",
      channel: "news",
      trigger: { cron: "0 10 * * FRI", timezone: "America/Sao_Paulo" },
    },
    {
      key: "launch",
      name: "Launch post",
      agent: "writer",
      prompt: "Write the launch post.",
      channel: null,
      trigger: { at: "2026-12-01T12:00:00Z" },
    },
    {
      key: "inbox",
      name: "Inbox",
      agent: "writer",
      prompt: "Answer new mail.",
      channel: null,
      trigger: { event: "email" },
    },
  ],
  notes: [
    { key: "n1", agent: "writer", kind: "preference", title: "Paragraphs", content: "Dana likes short paragraphs." },
    { key: "n2", agent: null, kind: "opinion", content: "The newsletter goes out on Fridays." },
  ],
  todo: [{ kind: "app", label: "Gmail", agents: ["writer"] }],
  leftOut: [{ kind: "projects", label: "Q4 planning" }],
};

describe("agentes.chat bundle", () => {
  test("our own shape is read like any other source: nothing in it is trusted", () => {
    const b = parseImport([{ name: "agentes-chat-export.json", text: JSON.stringify(ourBundle) }], { models: MODELS });
    expect(b.source).toEqual({
      app: "agenteschat",
      // Every reply from one app is one package: the model's own `ref` changes from one export to the next.
      ref: "claude",
      name: "Dana's Claude",
      files: ["agentes-chat-export.json"],
    });
    expect(
      b.agents.map((a) => [a.key, a.handle, a.model, a.skills, a.appearance.color, a.appearance.accessory]),
    ).toEqual([["writer", "writer", "claude-opus-5-5", ["tone-check"], "rose", "hat"]]);
    // An eye shape we don't draw falls back to the stable look.
    expect(["round", "dots", "wide", "happy", "sleepy"]).toContain(b.agents[0]?.appearance.eyes as string);
    expect(b.channels).toEqual([
      { key: "news", name: "newsletter", topic: "Drafts and feedback", agents: [{ key: "writer", autoReply: true }] },
    ]);
    expect(b.routines.map((r) => [r.key, r.channel, r.trigger])).toEqual([
      ["writer/friday-draft", "news", { cron: "0 10 * * 5", timezone: "America/Sao_Paulo" }],
      ["writer/launch-post", null, { at: "2026-12-01T12:00:00.000Z" }],
    ]);
    // A note keeps its title (our export writes one).
    expect(b.notes.map((n) => [n.agent, n.kind, n.title])).toEqual([
      ["writer", "preference", "Paragraphs"],
      [null, "note", undefined],
    ]);
    expect(b.todo).toEqual([{ kind: "app", label: "Gmail", agents: ["writer"] }]);
    expect(groupLeftOut(b.leftOut)).toEqual([
      { kind: "routine", labels: ["Inbox"] },
      { kind: "other", labels: ["Q4 planning"] },
    ]);
    expect(code(() => parseImport([{ name: "x.json", text: JSON.stringify({ ...ourBundle, version: 2 }) }]))).toBe(
      "newerVersion",
    );
  });

  test("the export prompt's reply, pasted fenced or bare, reads the same", () => {
    const json = JSON.stringify(ourBundle, null, 2);
    const fenced = parseImport([
      { name: "pasted", text: `Here is your export.\n\n\`\`\`json\n${json}\n\`\`\`\n\nAnything else?` },
    ]);
    const bare = parseImport([{ name: "pasted", text: `Sure! ${json}` }]);
    expect(fenced).toEqual(bare);
    expect(fenced.agents.map((a) => a.key)).toEqual(["writer"]);
    expect(fenced.source.files).toEqual(["pasted"]);
  });

  test("labels another app's agent writes as paragraphs are shortened to what the server takes, never refused", () => {
    // Grok Bot wrote left-out labels of 503 to 1,768 characters, and the server takes 500: the whole import failed.
    const paragraph =
      "A daily routine that reads the inbox, sums up the threads and tells the team in the channel. ".repeat(20);
    const b = parseImport([
      {
        name: "agentes-chat-export.json",
        text: JSON.stringify({
          ...ourBundle,
          todo: [{ kind: "app", label: paragraph, agents: ["writer"] }],
          leftOut: [
            { kind: "routine", label: paragraph },
            { kind: "other", label: "Q4 planning" },
          ],
        }),
      },
    ]);
    const labels = [...b.todo.map((t) => t.label), ...b.leftOut.map((l) => l.label)];
    expect(labels.every((label) => label.length <= 500)).toBe(true);
    const long = b.leftOut.find((l) => l.label.startsWith("A daily routine that reads the inbox"))?.label ?? "";
    expect(long.length).toBeGreaterThan(400);
    expect(long.endsWith("channel.")).toBe(true);
    // A label that fits stays as written.
    expect(b.leftOut.find((l) => l.kind === "other")?.label).toBe("Q4 planning");
  });

  test("asking the same app again brings the same package and the same agents, whatever keys the model picks", () => {
    const read = (over: object) =>
      parseImport([{ name: "pasted", text: JSON.stringify({ ...ourBundle, ...over }) }], { models: MODELS });
    const first = read({});
    const [writer] = ourBundle.agents;
    const again = read({
      source: { app: "Claude", ref: "export-2", name: "My agents", files: [] },
      agents: [
        { ...writer, key: "agent-1", handle: "agent-1" },
        { ...writer, key: "agent-2", name: "Editor", handle: "" },
      ],
      channels: [{ key: "c1", name: "Newsletter", topic: "", agents: [{ key: "agent-1" }, { key: "Editor" }] }],
      routines: [{ ...ourBundle.routines[0], key: "r-77", agent: "@agent-1", channel: null }],
      notes: [{ key: "x", agent: "Writer", kind: "preference", content: "Dana likes short paragraphs." }],
      todo: [{ kind: "app", label: "Gmail", agents: ["agent-2"] }],
    });
    expect(again.source.ref).toBe(first.source.ref);
    expect(again.agents.map((a) => a.key)).toEqual(["writer", "editor"]);
    expect(again.channels[0]?.agents.map((m) => m.key)).toEqual(["writer", "editor"]);
    expect(again.routines.map((r) => [r.key, r.agent])).toEqual([["writer/friday-draft", "writer"]]);
    expect(again.notes[0]?.key).toBe(first.notes[0]?.key);
    expect(again.notes[0]?.agent).toBe("writer");
    expect(again.todo[0]?.agents).toEqual(["editor"]);
    // Two agents with one name stay two.
    const twins = read({ agents: [writer, { ...writer, key: "writer-b" }] });
    expect(twins.agents.map((a) => a.key)).toEqual(["writer", "writer-writer-b"]);
  });

  test("our own export keeps its workspace and its keys", () => {
    const b = parseImport([
      {
        name: "agentes-chat-export.json",
        text: JSON.stringify({
          ...ourBundle,
          source: { app: "agenteschat", ref: "org-1", name: "Acme", files: [] },
          agents: [{ ...ourBundle.agents[0], key: "a-1" }],
          channels: [],
          routines: [{ ...ourBundle.routines[0], agent: "a-1", channel: null }],
          notes: [{ key: "n1", agent: "a-1", kind: "fact", content: "Fridays." }],
          todo: [],
        }),
      },
    ]);
    expect(b.source.ref).toBe("agenteschat:org-1");
    expect(b.agents.map((a) => a.key)).toEqual(["a-1"]);
    expect(b.routines.map((r) => [r.key, r.agent])).toEqual([["draft", "a-1"]]);
    expect(b.notes.map((n) => [n.key, n.agent])).toEqual([["n1", "a-1"]]);
  });

  test("the export prompt asks for every agent, not only the one in the chat", () => {
    expect(EXPORT_PROMPT).toContain("Export all of my agents in this one file, not only the one I'm talking to now");
    expect(EXPORT_PROMPT).toContain('"agents" has one entry for every agent I have');
    expect(EXPORT_PROMPT).toContain('"instructions": ""');
  });

  test("the export prompt asks for exactly our shape, and never for a secret", () => {
    expect(EXPORT_PROMPT).toContain('"format": "agenteschat.bundle"');
    expect(EXPORT_PROMPT).toContain('"version": 1');
    for (const field of [
      '"agents"',
      '"skills"',
      '"channels"',
      '"routines"',
      '"notes"',
      '"todo"',
      '"leftOut"',
      '"trigger"',
    ]) {
      expect(EXPORT_PROMPT).toContain(field);
    }
    expect(EXPORT_PROMPT).toContain("Never include API keys, tokens, passwords");
    // The example in the prompt parses, once its placeholders are filled the way an agent would.
    const example = EXPORT_PROMPT.slice(EXPORT_PROMPT.indexOf("{"), EXPORT_PROMPT.indexOf("\n}\n") + 2);
    const filled = example.replace(/"<[^"]*>"/g, '"x"').replace('"model": "x"', '"model": null');
    expect(() => JSON.parse(filled)).not.toThrow();
  });
});

describe("secrets, notes and what doesn't come", () => {
  test("key-looking text is removed from every field and named under redacted", () => {
    const leaky = parseImport([fixture("leaky-desk.openmaus.json")]);
    expect(leaky.agents[0]?.instructions).toBe(
      "Sign in to the fixture portal with password [redacted] and never share it.",
    );
    expect(left(leaky, "redacted")).toEqual(["Scout"]);

    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "fixturepayloadvalue", "fixturesignaturevalue"].join(".");
    const pem = ["-----BEGIN PRIVATE KEY-----", "fixture", "-----END PRIVATE KEY-----"].join("\n");
    const reply = {
      format: "openmaus.grok/1",
      name: "Leaky",
      instructions: `Call the API with Authorization: Bearer ${"f".repeat(32)} and key sk-${"a".repeat(24)}.`,
      skills: [{ name: "deploy", description: "Deploy.", body: `Use this key:\n${pem}` }],
      routines: [{ name: "Sync", cron: "0 * * * *", timeZone: "UTC", prompt: `token: ${"z".repeat(12)}` }],
      memories: [`The session is ${jwt}`],
    };
    const b = parseImport([{ name: "reply.json", text: JSON.stringify(reply) }]);
    const all = JSON.stringify(b);
    for (const value of ["f".repeat(32), "a".repeat(24), "fixturepayloadvalue", "BEGIN PRIVATE KEY", "z".repeat(12)]) {
      expect(all).not.toContain(value);
    }
    expect(b.agents[0]?.instructions).toBe("Call the API with Authorization: Bearer [redacted] and key [redacted].");
    expect(b.routines[0]?.prompt).toBe("token [redacted]");
    expect(left(b, "redacted")).toEqual(["Leaky", "deploy", "Sync"]);
  });

  test("memory longer than a note is split at paragraphs, never cut", () => {
    const paragraph = (n: number) => `${String(n).padStart(4, "0")} ${"word ".repeat(199).trim()}`;
    const text = Array.from({ length: 20 }, (_, i) => paragraph(i)).join("\n\n");
    const b = parseImport([
      { name: "SOUL.md", text: "Be useful." },
      { name: "MEMORY.md", text },
    ]);
    const parts = b.notes.filter((n) => n.key.startsWith("main/MEMORY.md"));
    expect(parts.map((n) => n.key)).toEqual(["main/MEMORY.md", "main/MEMORY.md~2", "main/MEMORY.md~3"]);
    expect(parts.every((n) => n.content.length <= 8000)).toBe(true);
    expect(parts.map((n) => n.content).join("\n\n")).toBe(text);
    expect(splitNote("a".repeat(9000))).toEqual(["a".repeat(8000), "a".repeat(1000)]);
  });

  test("files nobody reads are listed by folder; package docs are not", () => {
    const b = parseImport([
      fixture("sales-desk.openmaus.json"),
      { name: "README.md", text: "# Sales desk" },
      { name: ".DS_Store", text: "" },
      { name: "drafts/a.md", text: "a" },
      { name: "drafts/b.md", text: "b" },
      { name: "logo.png", text: "" },
      { name: "secrets/prod.yaml", text: "password: fixture-never-read" },
    ]);
    expect(left(b, "file")).toEqual(["drafts/ (2)", "logo.png"]);
    expect(left(b, "secret")).toEqual(["secrets/prod.yaml"]);
    expect(JSON.stringify(b)).not.toContain("fixture-never-read");
  });
});

describe("helpers", () => {
  test("handles, env placeholders, the model, schedules and hashes", () => {
    expect(uniqueHandle("scout", new Set(["scout", "scout2"]))).toBe("scout3");
    expect(uniqueHandle("ada", new Set())).toBe("ada");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: OpenBot's own placeholder syntax
    expect(interpolateEnv("a ${X:-Your Bot} b ${Y} c")).toBe("a Your Bot b  c");
    expect(scrubSecrets("key ghp_abcdefghijklmnopqrstuvwxyz0123 ok")).toEqual({
      text: "key [redacted] ok",
      redacted: true,
    });
    // GitHub's stateless App token (`ghs_<app id>_<JWT>`): all of it, dots and dashes included.
    const app = `ghs_123_eyJhbGciOiJSUzI1NiJ9.${"e".repeat(40)}.${"s-ig_".repeat(8)}`;
    expect(scrubSecrets(`key ${app} ok`)).toEqual({ text: "key [redacted] ok", redacted: true });
    expect(scrubSecrets("nothing here")).toEqual({ text: "nothing here", redacted: false });
    expect(importedModel({ model: null }, MODELS, "claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(importedModel({ model: "gpt-6.1-sol" }, MODELS, "claude-sonnet-5-5")).toBe("gpt-6.1-sol");

    expect(cronOf("0 9 * * MON-FRI")).toBe("0 9 * * 1-5");
    expect(cronOf("30 6 1 JAN,JUL ?")).toBe("30 6 1 1,7 *");
    expect(cronOf("@daily")).toBe("0 0 * * *");
    expect(cronOf("0 0 9 * * *")).toBeNull();
    expect(cronOf("0 9 L * *")).toBeNull();
    expect(everyMinutes(15)).toEqual({ cron: "*/15 * * * *", timezone: null });
    expect(everyMinutes(15, Date.parse("2026-10-01T08:07:00Z"))).toEqual({ cron: "7/15 * * * *", timezone: "UTC" });
    expect(everyMinutes(360, Date.parse("2026-10-01T03:20:00Z"))).toEqual({ cron: "20 3/6 * * *", timezone: "UTC" });
    expect(everyMinutes(2880, Date.parse("2026-10-01T07:45:00Z"))).toEqual({
      rule: { freq: "daily", interval: 2, times: ["07:45"], timezone: "UTC", start: "2026-10-01" },
    });
    expect(everyMinutes(45)).toBeNull();

    for (const text of ["", "abc", "🦞 OpenClaw", "x".repeat(1000)]) {
      expect(sha256(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });

  test("the same agent always gets the same look", () => {
    const [a] = parseImport([fixture("sales-desk.openmaus.json")]).agents;
    const [b] = parseImport([fixture("sales-desk.openmaus.json")]).agents;
    expect(a?.appearance).toEqual(b?.appearance as NonNullable<typeof b>["appearance"]);
  });
});
