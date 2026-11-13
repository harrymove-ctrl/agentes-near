/**
 * Test fake — agent tool access, same shapes and resolution order as the
 * backend (packages/engine/src/access.ts): deny > tool > connector > scope > all.
 * - `GET/PUT /api/app/organizations/{orgId}/agents/{agentId}/access`
 */
import type {
  AccessInput,
  AccessScope,
  AccessState,
  AgentAccess,
  ApiClient,
  Connection,
  CustomServer,
} from "@agenteschat/client";

type FakeTool = { name: string; label: string; description: string; sensitive: boolean; readOnly: boolean };
const tool = (name: string, label: string, description: string, readOnly = false, sensitive = false): FakeTool => ({
  name,
  label,
  description,
  sensitive,
  readOnly,
});
const BUILTINS: { scope: string; label: string; tools: FakeTool[] }[] = [
  {
    scope: "memory:write",
    label: "Memória",
    tools: [
      tool("memory_remember", "Lembrar", "Guarda fatos e preferências."),
      tool("memory_search", "Buscar na memória", "Consulta o que já aprendeu.", true),
    ],
  },
  {
    scope: "context:read",
    label: "Busca",
    tools: [tool("search_workspace", "Ler o contexto", "Mensagens e issues.", true)],
  },
  {
    scope: "drive:write",
    label: "Drive",
    tools: [
      tool("drive_create_document", "Escrever arquivos", "Relatórios e tabelas."),
      tool("drive_read_file", "Ler arquivos", "Abre documentos.", true),
    ],
  },
  {
    scope: "issues:write",
    label: "Issues",
    tools: [
      tool("issues_create", "Criar e editar issues", "Abre uma issue."),
      tool("issues_list", "Ler issues", "Lista issues.", true),
    ],
  },
  {
    scope: "calendar:write",
    label: "Calendário",
    tools: [
      tool("calendar_propose_event", "Propor eventos", "Uma pessoa confirma."),
      tool("calendar_list_events", "Ver agenda", "Eventos do workspace.", true),
    ],
  },
  {
    scope: "skills:read",
    label: "Skills",
    tools: [
      tool("load_skill", "Abrir skill", "Lê o SKILL.md.", true),
      tool("read_skill_file", "Ler arquivo da skill", "Arquivos de texto da skill.", true),
    ],
  },
  {
    scope: "",
    label: "Perguntar à pessoa",
    tools: [tool("ask_user", "Perguntar", "Faz uma pergunta curta e espera.")],
  },
];
const GITHUB: { scope: string; label: string; tools: FakeTool[] }[] = [
  {
    scope: "github:repo.read",
    label: "Ler o repositório",
    tools: [tool("github_list_pull_requests", "Ver PRs", "Lista pull requests.", true)],
  },
  {
    scope: "github:pr.write",
    label: "Abrir e comentar PRs",
    tools: [tool("github_create_pull_request", "Abrir PR", "Cria um pull request.")],
  },
  {
    scope: "github:pr.merge",
    label: "Fazer merge",
    tools: [tool("github_merge_pull_request", "Fazer merge", "Merge de um PR.", false, true)],
  },
];

const empty = (): AccessInput => ({
  all: false,
  connectors: {},
  scopes: [
    { connectionId: null, scope: "context:read" },
    { connectionId: null, scope: "memory:write" },
    { connectionId: null, scope: "skills:read" },
  ],
  tools: { allow: [], deny: [] },
});

/** A custom server's classified tools in two scopes, like the backend (`custom:{id}:read` / `:write`). */
function customScopes(s: CustomServer): { scope: string; label: string; tools: FakeTool[] }[] {
  const exposed = s.reviewedAt ? s.tools.filter((t) => t.access !== null && t.access !== "off") : [];
  const of = (read: boolean) =>
    exposed
      .filter((t) => (t.access === "read") === read)
      .map((t) => tool(t.name, t.label || t.name, t.description, t.access === "read", t.access === "approval"));
  return [
    { scope: `custom:${s.id}:read`, label: "Leitura", tools: of(true) },
    { scope: `custom:${s.id}:write`, label: "Escrita", tools: of(false) },
  ].filter((x) => x.tools.length > 0);
}

export function fakeAccessTree(
  input: AccessInput,
  connections: Connection[],
  servers: CustomServer[] = [],
): AgentAccess {
  const allowed = (c: string | null, name: string) =>
    input.tools.allow.some((t) => t.connectionId === c && t.name === name);
  const denied = (c: string | null, name: string) =>
    input.tools.deny.some((t) => t.connectionId === c && t.name === name);
  const scopeGranted = (c: string | null, scope: string) =>
    input.scopes.some((s) => s.connectionId === c && s.scope === scope);
  const toolState = (c: string | null, name: string, scope: string): AccessState => {
    if (denied(c, name)) return "denied";
    if (allowed(c, name)) return "granted";
    if (scope === "" || scopeGranted(c, scope) || (c && input.connectors[c]) || input.all) return "inherited";
    return "off";
  };
  const scopeState = (c: string | null, scope: string): AccessState =>
    scopeGranted(c, scope) ? "granted" : (c && input.connectors[c]) || input.all || scope === "" ? "inherited" : "off";
  const builtins: AccessScope[] = BUILTINS.map((b) => ({
    scope: b.scope,
    label: b.label,
    state: scopeState(null, b.scope),
    tools: b.tools.map((t) => ({
      ...t,
      connectionId: null,
      scope: b.scope,
      state: toolState(null, t.name, b.scope),
    })),
  }));
  const connectors = [
    ...connections
      .filter((c) => !c.revokedAt && c.connector === "github")
      .map((c) => ({ id: c.id, connector: c.connector, label: "GitHub", custom: false, scopes: GITHUB })),
    ...servers.map((s) => ({
      id: s.id,
      connector: `custom:${s.id}`,
      label: s.label,
      custom: true,
      scopes: customScopes(s),
    })),
  ].map((c) => ({
    connectionId: c.id,
    connector: c.connector,
    label: c.label,
    custom: c.custom,
    state: (input.connectors[c.id] ? "granted" : input.all ? "inherited" : "off") as AccessState,
    scopes: c.scopes.map((s) => ({
      scope: s.scope,
      label: s.label,
      state: scopeState(c.id, s.scope),
      tools: s.tools.map((t) => ({
        ...t,
        connectionId: c.id,
        scope: s.scope,
        state: toolState(c.id, t.name, s.scope),
      })),
    })),
  }));
  return { all: input.all, builtins, connectors };
}

export function createFakeAccess(
  connections: (orgId: string) => Promise<Connection[]>,
  log: (method: string, ...args: unknown[]) => void,
  /** Custom MCP servers (their classified tools join the tree). */
  servers: (orgId: string) => Promise<CustomServer[]> = async () => [],
): ApiClient["access"] & {
  /** A new connection, as the backend gives it (`grantToEveryAgent`): every agent's, whole. */
  connected: (connectionId: string, agentIds: string[]) => void;
} {
  const inputs = new Map<string, AccessInput>();
  const of = (agentId: string) => inputs.get(agentId) ?? empty();
  const tree = async (orgId: string, input: AccessInput) =>
    fakeAccessTree(input, await connections(orgId), await servers(orgId));
  return {
    get: async (orgId, agentId) => tree(orgId, of(agentId)),
    set: async (orgId, agentId, input) => {
      log("access.set", orgId, agentId, input);
      inputs.set(agentId, structuredClone(input));
      return tree(orgId, input);
    },
    connected: (connectionId, agentIds) => {
      for (const agentId of agentIds) {
        const input = of(agentId);
        inputs.set(agentId, { ...input, connectors: { ...input.connectors, [connectionId]: true } });
      }
    },
  };
}
