/**
 * Test fake — artifacts (documents, tables, diffs, diagrams, HTML pages).
 * Mirrors these endpoints (shapes in `api/types.ts`):
 * - `GET    /api/app/organizations/{orgId}/artifacts?q&kind&channelId&authorType&authorId` → Artifact[] (newest update first)
 * - `GET    …/artifacts/{id}?version=` → ArtifactDetail (content of that version)
 * - `GET    …/artifacts/{id}/versions` → ArtifactVersion[] (newest first)
 * - `GET    …/artifacts/{id}/download?version=` → `{ url, expiresAt }` (signed URL)
 * - `POST   …/artifacts` `{ title, channelId?, content }`, `PATCH …/artifacts/{id}` `{ content, note?, baseVersion }` (409 when stale), `DELETE …/artifacts/{id}`
 * - channel events `artifact.created` / `artifact.updated` `{ artifact }`, and `meta.artifacts: [{ id, version }]` on agent messages.
 * Seeded in development only; lost on reload.
 */
import type {
  ApiClient,
  Artifact,
  ArtifactAudience,
  ArtifactAuthor,
  ArtifactContent,
  ArtifactDetail,
  ArtifactFilters,
  ArtifactKind,
  ArtifactVersion,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

interface Stored {
  meta: Omit<Artifact, "canEdit" | "untrusted" | "audience">;
  /** `bytes`: an uploaded file's version. */
  versions: (ArtifactVersion & { content: ArtifactContent; bytes?: Blob })[];
  /** In the trash since then (30 days to restore). */
  deletedAt?: string;
  /** Deleted for good: gone from the trash too. */
  purged?: boolean;
}

class MockConflictError extends Error {
  readonly status = 409;
  readonly code = "stale_version";
}

const openPoll = (id: string) => ({
  id,
  closesAt: new Date(Date.now() + 3_600_000).toISOString(),
  closedAt: null,
  people: 1,
  votes: [],
});

const editable = (kind: Artifact["kind"]) => kind === "document" || kind === "table" || kind === "file";

export function serializeContent(content: ArtifactContent): { text: string; type: string } {
  switch (content.kind) {
    case "document":
      return { text: content.markdown, type: "text/markdown" };
    case "table": {
      const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
      return { text: [content.columns, ...content.rows].map((r) => r.map(q).join(",")).join("\n"), type: "text/csv" };
    }
    case "diff":
      return {
        text: content.files.map((f) => `--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`).join("\n"),
        type: "text/x-diff",
      };
    case "diagram":
      return { text: content.mermaid, type: "text/plain" };
    case "html":
      return { text: content.html, type: "text/html" };
    case "file":
      return { text: content.text ?? "", type: content.contentType };
    case "block":
      return content.spec
        ? { text: JSON.stringify(content.spec, null, 2), type: "application/json" }
        : { text: content.html ?? "", type: "text/html" };
    case "poll":
      return { text: content.question, type: "text/plain" };
    case "choices":
      return { text: content.questions.map((q) => q.question).join("\n"), type: "text/plain" };
  }
}

/** Like the server: the type from the name, else what the browser said, else octet-stream. */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};
const typeOf = (name: string, sent: string) =>
  TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? (sent || "application/octet-stream");

/** A `file` content from an upload (small text files carry their text). */
async function fileContent(file: File): Promise<ArtifactContent> {
  const contentType = typeOf(file.name, file.type);
  const isText = contentType.startsWith("text/") || contentType === "application/json";
  const text = isText && file.size <= 40_000 ? await file.text() : undefined;
  return {
    kind: "file",
    name: file.name,
    contentType,
    size: file.size,
    sha256: "0".repeat(64),
    ...(text !== undefined ? { text } : {}),
  };
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const tooLarge = () => new ApiError(413, "artifact.file_too_large", "The file is too large (max 50 MB)");

export function createMockArtifacts(
  ctx: MockContext,
  record: (method: string, ...args: unknown[]) => void = () => {},
): ApiClient["artifacts"] {
  const store = perOrg(async (orgId) => {
    const list: Stored[] = [];
    if (!ctx.seed) return list;
    const [agents, channels] = await Promise.all([ctx.lookup.agents(orgId), ctx.lookup.channels(orgId)]);
    const me = await ctx.lookup.me();
    const agent = (i: number): ArtifactAuthor => ({
      type: "agent",
      id: agents[i % Math.max(agents.length, 1)]?.id ?? "agent",
    });
    const person: ArtifactAuthor = { type: "person", id: me?.user.id ?? "me" };
    const channel = channels[0]?.id ?? null;
    const now = ctx.now();
    for (const seed of seeds()) {
      const by = seed.byPerson ? person : agent(seed.agent);
      const versions = seed.versions.map((content, i) => ({
        version: i + 1,
        author: i === 0 ? agent(seed.agent) : by,
        note: seed.notes[i] ?? null,
        createdAt: minutesAgo(now, seed.age - i * 30),
        content,
      }));
      const last = versions[versions.length - 1] as Stored["versions"][number];
      list.push({
        meta: {
          id: mockId("art"),
          kind: last.content.kind,
          title: seed.title,
          version: last.version,
          channelId: channel,
          threadId: null,
          createdBy: agent(seed.agent),
          updatedBy: last.author,
          createdAt: (versions[0] as Stored["versions"][number]).createdAt,
          updatedAt: last.createdAt,
        },
        versions,
      });
    }
    return list;
  });
  /** Like the server: the DM's other participant, the channel's name and privacy, else the whole workspace. */
  const audienceOf = async (orgId: string, channelId: string | null): Promise<ArtifactAudience> => {
    if (!channelId) return { kind: "workspace" };
    const dm = (await ctx.lookup.dms?.(orgId))?.find((d) => d.channelId === channelId);
    if (dm) return { kind: "dm", with: { type: dm.with.type, id: dm.with.id } };
    const c = (await ctx.lookup.channels(orgId)).find((x) => x.id === channelId);
    return c ? { kind: "channel", name: c.name, private: c.visibility !== "public" } : { kind: "workspace" };
  };
  const find = async (orgId: string, id: string) => {
    const s = (await store(orgId)).find((a) => a.meta.id === id);
    if (!s) throw new MockNotFoundError("Arquivo não encontrado.");
    return s;
  };
  const view = async (orgId: string, s: Stored): Promise<Artifact> => {
    const audience = await audienceOf(orgId, s.meta.channelId);
    return {
      canDelete: true,
      sharing: { mode: "conversation", userIds: [], roleIds: [] },
      ...clone(s.meta),
      canEdit: editable(s.meta.kind),
      untrusted: s.meta.kind === "html" || s.meta.kind === "file",
      audience,
      // As the server: whoever reads it where it lives may share what not everyone sees (the fake's viewer is there).
      canShare:
        s.meta.inDrive !== false && (audience.kind === "dm" || (audience.kind === "channel" && audience.private)),
    };
  };
  const detail = async (orgId: string, s: Stored, version?: number): Promise<ArtifactDetail> => {
    const v = s.versions.find((x) => x.version === (version ?? s.meta.version));
    if (!v) throw new MockNotFoundError("Versão não encontrada.");
    const content = clone(v.content);
    // As the server's `keepsVersions` (ADR 0019): a picture, a clip or a recording keeps no versions.
    const versioned =
      content.kind !== "file" || s.meta.version > 1 || !/^(image|video|audio)\//i.test(content.contentType);
    return { ...(await view(orgId, s)), shownVersion: v.version, content, versioned };
  };
  const me = async (): Promise<ArtifactAuthor> => ({ type: "person", id: (await ctx.lookup.me())?.user.id ?? "me" });
  /** Like the server's `listArtifacts`: the Drive's filters (`kinds` too unless `allKinds`), in its order. */
  const listed = async (orgId: string, filters: ArtifactFilters, allKinds = false) => {
    const q = filters.q?.trim().toLowerCase();
    const same = (a: ArtifactAuthor, b: ArtifactAuthor | undefined) => a.type === b?.type && a.id === b.id;
    const shown = (await store(orgId))
      .filter((s) => !s.deletedAt)
      .filter((s) => allKinds || !filters.kind || s.meta.kind === filters.kind)
      .filter((s) => allKinds || !filters.kinds?.length || filters.kinds.includes(s.meta.kind))
      .filter((s) => !filters.channelId || s.meta.channelId === filters.channelId)
      .filter((s) => !filters.channelIds?.length || filters.channelIds.includes(s.meta.channelId ?? ""))
      .filter((s) => !filters.author || s.versions.some((v) => same(v.author, filters.author)))
      .filter(
        (s) =>
          !filters.authors?.length ||
          filters.authors.some((a) => same(a, s.meta.createdBy) || same(a, s.meta.updatedBy)),
      )
      .filter((s) => !filters.who || s.meta.createdBy.type === (filters.who === "agents" ? "agent" : "person"))
      .filter((s) => !q || s.meta.title.toLowerCase().includes(q));
    const order = ["document", "table", "diff", "diagram", "html", "file"];
    const newest = (a: Artifact, b: Artifact) => b.updatedAt.localeCompare(a.updatedAt);
    return (await Promise.all(shown.map((s) => view(orgId, s)))).sort(
      filters.sort === "name"
        ? (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || newest(a, b)
        : filters.sort === "kind"
          ? (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || newest(a, b)
          : newest,
    );
  };
  /** The server's page size. */
  const PAGE = 100;
  return {
    list: async (orgId, filters = {}) => (await listed(orgId, filters)).slice(0, PAGE),
    page: async (orgId, filters = {}, cursor) => {
      const all = await listed(orgId, filters);
      const at = Number(cursor ?? 0);
      const counts: Partial<Record<ArtifactKind, number>> = {};
      if (!cursor) for (const a of await listed(orgId, filters, true)) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
      return {
        artifacts: all.slice(at, at + PAGE),
        nextCursor: at + PAGE < all.length ? String(at + PAGE) : null,
        ...(cursor ? {} : { counts }),
      };
    },
    get: async (orgId, id, version) => detail(orgId, await find(orgId, id), version),
    keep: async (orgId, id) => {
      const s = await find(orgId, id);
      s.meta.inDrive = true;
      return view(orgId, s);
    },
    reply: async () => ({ id: mockId("msg") }),
    blockState: async (_orgId, id, version) => ({ id, version, state: {}, changes: {}, rev: 0 }),
    setBlockState: async (_orgId, id, version, values) => ({ id, version, state: values, changes: {}, rev: 1 }),
    drawBlock: async (_orgId, id, version, name, options) => ({
      id,
      version,
      state: { [name]: options[0] },
      changes: { [name]: { by: "me", name: "", at: new Date().toISOString(), drawn: options.length } },
      rev: 1,
    }),
    poll: async (_orgId, id) => openPoll(id),
    vote: async (_orgId, id) => openPoll(id),
    choices: async (_orgId, id) => ({ id, answer: null }),
    answerChoices: async (_orgId, id, picks, _clientId, others) => ({
      choices: {
        id,
        answer: { userId: "me", picks, messageId: null, at: new Date().toISOString(), ...(others ? { others } : {}) },
      },
      messageId: mockId("msg"),
    }),
    setSharing: async (orgId, id, sharing) => {
      record("artifacts.setSharing", orgId, id, sharing);
      const s = await find(orgId, id);
      const listed = [...(sharing.userIds ?? []), ...(sharing.roleIds ?? [])];
      if (sharing.mode === "people" && listed.length === 0) {
        throw new ApiError(400, "artifact.sharing_empty", "Choose who sees it");
      }
      s.meta.sharing =
        sharing.mode === "people"
          ? { mode: "people", userIds: sharing.userIds ?? [], roleIds: sharing.roleIds ?? [] }
          : { mode: sharing.mode, userIds: [], roleIds: [] };
      return view(orgId, s);
    },
    versions: async (orgId, id) =>
      (await find(orgId, id)).versions.map(({ content: _c, bytes: _b, ...v }) => clone(v)).reverse(),
    fileUrl: (orgId, id, options = {}) => {
      const params = new URLSearchParams();
      if (options.version) params.set("version", String(options.version));
      if (options.format) params.set("format", options.format);
      const qs = params.toString();
      return `/api/app/organizations/${orgId}/artifacts/${id}/file${qs ? `?${qs}` : ""}`;
    },
    download: async (orgId, id, version) => {
      const { text, type } = serializeContent((await detail(orgId, await find(orgId, id), version)).content);
      return {
        url: `data:${type};charset=utf-8,${encodeURIComponent(text)}`,
        expiresAt: new Date(ctx.now().getTime() + 5 * 60_000).toISOString(),
      };
    },
    create: async (orgId, input) => {
      const author = await me();
      const at = ctx.now().toISOString();
      const s: Stored = {
        meta: {
          id: mockId("art"),
          kind: input.content.kind,
          title: input.title,
          version: 1,
          channelId: input.channelId ?? null,
          threadId: null,
          createdBy: author,
          updatedBy: author,
          createdAt: at,
          updatedAt: at,
        },
        versions: [{ version: 1, author, note: null, createdAt: at, content: clone(input.content) }],
      };
      (await store(orgId)).push(s);
      return detail(orgId, s);
    },
    upload: async (orgId, file, options = {}) => {
      record("artifacts.upload", orgId, file.name, options);
      if (file.size > MAX_FILE_BYTES) throw tooLarge();
      const author = await me();
      const at = ctx.now().toISOString();
      const content = await fileContent(file);
      const s: Stored = {
        meta: {
          id: mockId("art"),
          kind: "file",
          title: options.title?.trim() || file.name,
          version: 1,
          channelId: options.channelId ?? null,
          threadId: options.threadId ?? null,
          createdBy: author,
          updatedBy: author,
          createdAt: at,
          updatedAt: at,
        },
        versions: [{ version: 1, author, note: null, createdAt: at, content, bytes: file }],
      };
      (await store(orgId)).push(s);
      return detail(orgId, s);
    },
    uploadVersion: async (orgId, id, file, options = {}) => {
      record("artifacts.uploadVersion", orgId, id, file.name, options);
      const s = await find(orgId, id);
      if (s.meta.kind !== "file") throw new Error("Só arquivos enviados ganham versão por upload.");
      if (file.size > MAX_FILE_BYTES) throw tooLarge();
      const author = await me();
      const at = ctx.now().toISOString();
      const version = s.meta.version + 1;
      s.versions.push({
        version,
        author,
        note: options.note?.trim() || null,
        createdAt: at,
        content: await fileContent(file),
        bytes: file,
      });
      Object.assign(s.meta, { version, updatedBy: author, updatedAt: at });
      return detail(orgId, s);
    },
    fileBlob: async (orgId, id, version) => {
      record("artifacts.fileBlob", orgId, id, version);
      const s = await find(orgId, id);
      const v = s.versions.find((x) => x.version === (version ?? s.meta.version));
      if (!v) throw new MockNotFoundError("Versão não encontrada.");
      if (v.bytes) return v.bytes;
      const { text, type } = serializeContent(v.content);
      return new Blob([text], { type });
    },
    update: async (orgId, id, input) => {
      const s = await find(orgId, id);
      if (input.baseVersion !== s.meta.version) throw new MockConflictError("Alguém salvou uma versão nova antes.");
      if (input.content.kind !== s.meta.kind) throw new Error("O tipo do arquivo não muda.");
      const author = await me();
      const at = ctx.now().toISOString();
      const version = s.meta.version + 1;
      s.versions.push({
        version,
        author,
        note: input.note?.trim() || null,
        createdAt: at,
        content: clone(input.content),
      });
      Object.assign(s.meta, { version, updatedBy: author, updatedAt: at, title: input.title ?? s.meta.title });
      return detail(orgId, s);
    },
    remove: async (orgId, id) => {
      record("artifacts.remove", id);
      const s = await find(orgId, id);
      s.deletedAt = ctx.now().toISOString();
    },
    trash: async (orgId) =>
      Promise.all(
        (await store(orgId))
          .filter((s) => s.deletedAt && !s.purged)
          .map(async (s) => ({
            ...(await view(orgId, s)),
            deletedAt: s.deletedAt as string,
            purgeAt: new Date(new Date(s.deletedAt as string).getTime() + 30 * 86_400_000).toISOString(),
          })),
      ),
    purge: async (orgId, id) => {
      record("artifacts.purge", id);
      const s = await find(orgId, id);
      if (!s.deletedAt) throw new MockNotFoundError("Arquivo não encontrado.");
      s.purged = true;
    },
    restore: async (orgId, id) => {
      record("artifacts.restore", id);
      const s = await find(orgId, id);
      s.deletedAt = undefined;
      return detail(orgId, s);
    },
  };
}

function seeds(): {
  title: string;
  agent: number;
  byPerson?: boolean;
  age: number;
  notes: (string | null)[];
  versions: ArtifactContent[];
}[] {
  const report = (extra: string) =>
    `# Incidente no checkout\n\nO erro \`TypeError\` em \`/api/checkout\` começou às 18:04, logo depois do último deploy.\n\n## O que aconteceu\n\n- 142 eventos desde ontem\n- Só afeta carrinhos vazios\n${extra}\n## Próximos passos\n\n1. Corrigir a validação do carrinho\n2. Adicionar um teste\n\n\`\`\`ts\nif (!cart.items.length) return empty();\n\`\`\`\n`;
  return [
    {
      title: "Relatório de incidente: checkout",
      agent: 1,
      byPerson: true,
      age: 180,
      notes: [null, "Acrescentei quem foi afetado."],
      versions: [
        { kind: "document", markdown: report("") },
        { kind: "document", markdown: report("- **38 clientes** tentaram pagar nesse período\n") },
      ],
    },
    {
      title: "Pedidos mais comuns nos reviews",
      agent: 2,
      age: 120,
      notes: [],
      versions: [
        {
          kind: "table",
          columns: ["Pedido", "Menções", "Nota média"],
          rows: [
            ["Modo offline", "31", "2,6"],
            ["Exportar em PDF", "18", "3,1"],
            ["Tema escuro", "12", "4,0"],
            ["Login com Google", "9", "3,8"],
          ],
        },
      ],
    },
    {
      title: "Corrige o checkout com carrinho vazio",
      agent: 0,
      age: 90,
      notes: [],
      versions: [
        {
          kind: "diff",
          files: [
            {
              path: "api/checkout.ts",
              patch:
                '@@ -10,6 +10,9 @@ export async function checkout(cart: Cart) {\n   const user = await currentUser();\n-  const total = cart.items.reduce(sum, 0);\n+  if (!cart.items.length) {\n+    return { ok: false, error: "empty_cart" };\n+  }\n+  const total = cart.items.reduce(sum, 0);\n   return charge(user, total);\n }\n',
            },
            {
              path: "api/checkout.test.ts",
              patch:
                '@@ -1,3 +1,7 @@\n import { checkout } from "./checkout";\n+\n+test("empty cart", async () => {\n+  expect(await checkout({ items: [] })).toEqual({ ok: false, error: "empty_cart" });\n+});\n',
            },
          ],
        },
      ],
    },
    {
      title: "Organograma do time",
      agent: 3,
      age: 60,
      notes: [],
      versions: [
        {
          kind: "diagram",
          mermaid:
            "flowchart TD\n  W[Walter] --> J[João]\n  W --> M[Mariana]\n  J --> A[Ada · agente]\n  J --> T[Atlas · agente]\n  W --> H[Theo · agente]\n  M --> L[Lia · agente]",
        },
      ],
    },
    {
      title: "Painel de erros da semana",
      agent: 1,
      age: 30,
      notes: [],
      versions: [
        {
          kind: "html",
          html: '<!doctype html><html><body style="font-family:sans-serif;padding:16px"><h1>Erros da semana</h1><p id="n">…</p><script>document.getElementById("n").textContent = "142 eventos, 3 issues abertas";</script></body></html>',
        },
      ],
    },
  ];
}
