/**
 * Test fake — skills (apps/server/src/routes/app/skills.ts), same shapes:
 * - `GET/POST …/skills`, `POST …/skills/import { url } | { url, paths } | { zipBase64 }`,
 *   `GET/PATCH/DELETE …/skills/{id}`, `POST …/skills/{id}/reimport`,
 *   `POST …/skills/{id}/update[/approve|/dismiss|/reopen|/undo]`
 * - `GET/PUT …/agents/{id}/skills` → `{ skills: (Skill & { enabled })[] }`
 * A repository's root holds three skills to pick and one that can't be installed (`{ choices, skipped }`), and `list`
 * lists a folder's one skill. `acme/secret` is private and no connection reaches it; `contoso/skills` is private and the
 * workspace's GitHub connection reads it (`github()`: that connection, none or one GitHub refuses). Scripts are listed
 * as `ignored`. "Revisão de PR" was changed by Ada since its link last wrote it, so its update from its link waits.
 */
import { type ApiClient, ApiError, type SkillDetail } from "@agenteschat/client";
import { clone, type MockContext, MockNotFoundError, mockId, perOrg } from "./context";

const CHOICES = [
  { path: "skills/deploy", name: "deploy", description: "Antes de qualquer deploy." },
  { path: "skills/review", name: "review", description: "Revisa um pull request." },
  { path: "skills/triage", name: "triage", description: "Organiza as issues novas." },
];
const SKIPPED = [
  {
    path: "skills/claude-api",
    code: "skill.invalid_description",
    message: "description: 1 to 1024 characters",
    params: { max: 1024 },
  },
];

export function createFakeSkills(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
  github: () => "none" | "refused" | "ok" = () => "none",
): ApiClient["skills"] {
  const assigned = new Map<string, Set<string>>();
  /** Names of skills removed here: a pick named like one replaces it, as the server says. */
  const removed = new Set<string>();
  /** A waiting update a person chose, as it was: Desfazer makes it wait again. */
  const chosen = new Map<string, Pick<SkillDetail, "body" | "pendingUpdate" | "pending">>();
  /** "Agentes melhoram as skills sozinhos" per workspace (on unless saved off). */
  const settingsOf = new Map<string, boolean>();
  const store = perOrg(async (orgId) => {
    const list: SkillDetail[] = [];
    if (!ctx.seed) return list;
    const agents = await ctx.lookup.agents(orgId);
    const now = ctx.now().toISOString();
    const add = (s: Omit<SkillDetail, "id" | "metadata" | "createdAt" | "updatedAt">) => {
      const skill: SkillDetail = { ...s, id: mockId("skill"), metadata: {}, createdAt: now, updatedAt: now };
      list.push(skill);
      return skill.id;
    };
    const review = add({
      name: "Revisão de PR",
      description: "Use quando pedirem para revisar um pull request.",
      version: 3,
      source: "url",
      sourceUrl: "https://github.com/acme/skills/tree/main/pr-review",
      defaultForNewAgents: false,
      body: "# Revisão de PR\n\n1. Leia o diff inteiro.\n2. Rode os testes.\n\n```bash\nbun test\n```",
      // Ada added the tests step after its link last wrote it: "Atualizar do link" waits for a person.
      changes: [
        {
          id: mockId("change"),
          agentId: agents[0]?.id ?? "",
          at: now,
          before: "# Revisão de PR\n\n1. Leia o diff inteiro.",
          after: "# Revisão de PR\n\n1. Leia o diff inteiro.\n2. Rode os testes.\n\n```bash\nbun test\n```",
          undone: false,
        },
      ],
      files: [
        { path: "SKILL.md", size: 120, mime: "text/markdown", status: "stored" },
        { path: "checklist.md", size: 40, mime: "text/markdown", status: "stored" },
        { path: "scripts/lint.sh", size: 30, mime: "text/x-sh", status: "script" },
        { path: "scripts/old.py", size: 20, mime: "text/x-python", status: "ignored" },
      ],
    });
    add({
      name: "Relatório semanal",
      description: "Monta o resumo da semana.",
      version: 1,
      source: "manual",
      sourceUrl: null,
      defaultForNewAgents: true,
      body: "# Relatório semanal\n\nDecisões, entregas e pendências.",
      files: [{ path: "SKILL.md", size: 60, mime: "text/markdown", status: "stored" }],
    });
    add({
      name: "Atendimento",
      description: "Tom e respostas padrão do suporte.",
      version: 2,
      source: "upload",
      sourceUrl: null,
      defaultForNewAgents: false,
      body: "# Atendimento\n\nSeja breve e cordial.",
      // An agent improved it by itself (Agentes melhoram as skills sozinhos): Desfazer in its sheet.
      lastUpdate: { fromVersion: 1, at: now, agentId: agents[0]?.id ?? null },
      changes: [
        {
          id: mockId("change"),
          agentId: agents[0]?.id ?? "",
          at: now,
          before: "# Atendimento\n\nSeja cordial.",
          after: "# Atendimento\n\nSeja breve e cordial.",
          undone: false,
        },
      ],
      files: [
        { path: "SKILL.md", size: 50, mime: "text/markdown", status: "stored" },
        { path: "respostas.txt", size: 20, mime: "text/plain", status: "stored" },
      ],
    });
    const first = agents[0];
    if (first) assigned.set(first.id, new Set([review]));
    return list;
  });
  const find = async (orgId: string, id: string) => {
    const s = (await store(orgId)).find((x) => x.id === id);
    if (!s) throw new MockNotFoundError("Skill não encontrada.");
    return s;
  };
  const make = async (
    orgId: string,
    s: Omit<SkillDetail, "id" | "metadata" | "createdAt" | "updatedAt" | "version">,
  ) => {
    const at = ctx.now().toISOString();
    const skill: SkillDetail = { ...s, id: mockId("skill"), version: 1, metadata: {}, createdAt: at, updatedAt: at };
    (await store(orgId)).push(skill);
    return clone(skill);
  };
  /** Its link read again: the workspace's GitHub refusing as the server does, else a new version. */
  const readAgain = async (orgId: string, id: string) => {
    const s = await find(orgId, id);
    if (s.sourceVia && github() === "none") {
      throw new ApiError(400, "skill.connection_gone", "The GitHub connection that read contoso/skills is gone", {
        repo: "contoso/skills",
      });
    }
    if (s.sourceVia && github() === "refused") {
      throw new ApiError(400, "github.repo_missing", "contoso/skills is private or doesn't exist on GitHub", {
        repo: "contoso/skills",
        connection: "refused",
        app: false,
      });
    }
    s.version += 1;
    return clone(s);
  };
  /** The picks as the server lists them: one named like a skill installed, or removed, says it replaces it. */
  const marked = async (orgId: string, choices: typeof CHOICES) => {
    const names = new Set((await store(orgId)).map((s) => s.name));
    return clone(choices).map((c) =>
      names.has(c.name)
        ? { ...c, replaces: "installed" as const }
        : removed.has(c.name)
          ? { ...c, replaces: "removed" as const }
          : c,
    );
  };
  const forAgent = async (orgId: string, agentId: string) =>
    (await store(orgId)).map(({ body: _b, files: _f, ...s }) => ({
      ...clone(s),
      enabled: assigned.get(agentId)?.has(s.id) ?? false,
    }));
  return {
    list: async (orgId) => (await store(orgId)).map(({ body: _b, files: _f, ...s }) => clone(s)),
    get: async (orgId, id) => clone(await find(orgId, id)),
    create: async (orgId, input) => {
      log("skills.create", orgId, input);
      return make(orgId, {
        name: input.name,
        description: input.description,
        body: input.body,
        source: "manual",
        sourceUrl: null,
        defaultForNewAgents: input.defaultForNewAgents ?? false,
        files: [{ path: "SKILL.md", size: input.body.length, mime: "text/markdown", status: "stored" }],
      });
    },
    import: async (orgId, input) => {
      log("skills.import", orgId, input);
      const url = "url" in input ? input.url : null;
      const hidden = url?.includes("/acme/secret")
        ? "acme/secret"
        : url?.includes("/contoso/") && github() !== "ok"
          ? "contoso/skills"
          : null;
      if (hidden) {
        throw new ApiError(400, "github.repo_missing", `${hidden} is private or doesn't exist on GitHub`, {
          repo: hidden,
          connection: github(),
          app: false,
        });
      }
      const via = url?.includes("/contoso/") ? { via: "github" as const } : {};
      if (url && /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(url)) {
        return { choices: await marked(orgId, CHOICES), skipped: clone(SKIPPED), ...via };
      }
      if (url && "list" in input && input.list) return { choices: await marked(orgId, CHOICES.slice(0, 1)), ...via };
      const name = url ? (url.split("/").filter(Boolean).pop() ?? "skill") : "Skill enviada";
      return make(orgId, {
        name,
        description: url ? "Instalada do GitHub." : "Enviada em .zip.",
        body: `# ${name}`,
        source: url ? "url" : "upload",
        sourceUrl: url,
        ...(via.via ? { sourceVia: via.via } : {}),
        defaultForNewAgents: false,
        files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
      });
    },
    importPicked: async (orgId, url, paths, forAgentId) => {
      log("skills.importPicked", orgId, url, paths, ...(forAgentId ? [forAgentId] : []));
      const installed: SkillDetail[] = [];
      for (const path of paths) {
        const choice = CHOICES.find((c) => c.path === path);
        if (!choice) throw new MockNotFoundError("Skill não encontrada.");
        installed.push(
          await make(orgId, {
            name: choice.name,
            description: choice.description,
            body: `# ${choice.name}`,
            source: "url",
            sourceUrl: `${url}/tree/HEAD/${path}`,
            ...(url.includes("/contoso/") ? { sourceVia: "github" as const } : {}),
            defaultForNewAgents: false,
            files: [{ path: "SKILL.md", size: 10, mime: "text/markdown", status: "stored" }],
          }),
        );
      }
      return installed;
    },
    update: async (orgId, id, patch) => {
      log("skills.update", orgId, id, patch);
      const s = await find(orgId, id);
      const edits = patch.description !== undefined || patch.body !== undefined;
      Object.assign(s, patch, { updatedAt: ctx.now().toISOString(), version: s.version + (edits ? 1 : 0) });
      return clone(s);
    },
    reimport: async (orgId, id) => {
      log("skills.reimport", orgId, id);
      return readAgain(orgId, id);
    },
    updateFromSource: async (orgId, id) => {
      log("skills.updateFromSource", orgId, id);
      const s = await find(orgId, id);
      // The agents changed it since its link last wrote it, and its link has a new version and script: it waits.
      const since = s.changes?.find((c) => !c.undone);
      if (since && s.source === "url" && !s.sourceVia) {
        const at = ctx.now().toISOString();
        s.pendingUpdate = { scripts: ["scripts/lint.sh"], at, dismissed: false, dismissedAt: null, edited: true };
        s.pending = {
          body: `${since.before}\n2. Rode o lint.`,
          description: s.description,
          base: {
            body: since.before,
            description: s.description,
            at: new Date(Date.parse(since.at) - 60_000).toISOString(),
          },
          files: [{ path: "scripts/lint.sh", before: "eslint .", after: "biome check .", large: false }],
        };
        return { status: "waiting" as const, skill: clone(s), scripts: s.pendingUpdate.scripts };
      }
      return { status: "updated" as const, skill: await readAgain(orgId, id) };
    },
    approveUpdate: async (orgId, id) => {
      log("skills.approveUpdate", orgId, id);
      const s = await find(orgId, id);
      if (s.pendingUpdate && s.pending)
        chosen.set(id, { body: s.body, pendingUpdate: s.pendingUpdate, pending: s.pending });
      Object.assign(s, {
        body: s.pending?.body ?? s.body,
        pendingUpdate: null,
        pending: null,
        lastUpdate: { fromVersion: s.version, at: ctx.now().toISOString(), agentId: null, waited: true },
        version: s.version + 1,
      });
      return { status: "updated" as const, skill: clone(s) };
    },
    dismissUpdate: async (orgId, id) => {
      log("skills.dismissUpdate", orgId, id);
      const s = await find(orgId, id);
      if (s.pendingUpdate)
        s.pendingUpdate = { ...s.pendingUpdate, dismissed: true, dismissedAt: ctx.now().toISOString() };
      return clone(s);
    },
    reopenUpdate: async (orgId, id) => {
      log("skills.reopenUpdate", orgId, id);
      const s = await find(orgId, id);
      if (s.pendingUpdate) s.pendingUpdate = { ...s.pendingUpdate, dismissed: false, dismissedAt: null };
      return clone(s);
    },
    undoUpdate: async (orgId, id) => {
      log("skills.undoUpdate", orgId, id);
      const s = await find(orgId, id);
      const back = s.lastUpdate?.waited ? chosen.get(id) : undefined;
      const last = s.lastUpdate?.agentId ? s.changes?.find((c) => !c.undone) : undefined;
      if (last) last.undone = true;
      Object.assign(s, { lastUpdate: null, version: s.version + 1, ...(back ?? {}) });
      return clone(s);
    },
    remove: async (orgId, id) => {
      log("skills.remove", orgId, id);
      const list = await store(orgId);
      const i = list.findIndex((x) => x.id === id);
      const gone = list[i];
      if (gone) removed.add(gone.name);
      if (i >= 0) list.splice(i, 1);
      for (const set of assigned.values()) set.delete(id);
    },
    settings: async (orgId) => ({ agentsImprove: settingsOf.get(orgId) ?? true }),
    saveSettings: async (orgId, input) => {
      log("skills.saveSettings", orgId, input);
      settingsOf.set(orgId, input.agentsImprove);
      return { agentsImprove: input.agentsImprove };
    },
    forAgent,
    setForAgent: async (orgId, agentId, skills) => {
      log("skills.setForAgent", orgId, agentId, skills);
      assigned.set(agentId, new Set(skills.filter((s) => s.enabled).map((s) => s.skillId)));
      return forAgent(orgId, agentId);
    },
  };
}
