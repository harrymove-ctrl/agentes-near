import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  ARTIFACT_LIMITS,
  addChannelMember,
  artifactDownload,
  artifactFile,
  ConflictError,
  createArtifact,
  createChannel,
  deleteArtifact,
  drainOutbox,
  ForbiddenError,
  getArtifact,
  grantScopes,
  insertVersion,
  listAgentScopes,
  listArtifacts,
  listArtifactVersions,
  listMessages,
  NotFoundError,
  postPersonMessage,
  searchVisible,
  setAgentScopes,
  tableToCsv,
  updateArtifact,
  ValidationError,
  validateContent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DRIVE = ["drive:read", "drive:write"].map((scope) => ({ connectionId: null, scope }));
const last = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** The agent writes a report when asked, and a v2 when asked to fix it. */
function driveAgent() {
  let artifactId = "";
  return (req: ModelRequest) => {
    const text = last(req);
    const saved = /artifact ([0-9a-f-]{36})/.exec(text);
    if (saved?.[1]) artifactId = saved[1];
    if (text.includes("tool_result")) return { chunks: ["Pronto, está no Drive."] };
    if (text.includes("corrige"))
      return {
        chunks: [],
        toolUses: [
          {
            name: "update_artifact",
            input: { artifact_id: artifactId, note: "Corrigi as vendas", markdown: "# Março\nVendas: 12" },
          },
        ],
      };
    if (text.includes("relatório"))
      return {
        chunks: [],
        toolUses: [
          {
            name: "create_artifact",
            input: { title: "Relatório de março", kind: "document", markdown: "# Março\nVendas: 10" },
          },
        ],
      };
    if (text.includes("página"))
      return {
        chunks: [],
        toolUses: [{ name: "create_artifact", input: { title: "Landing", kind: "html", html: "<h1>Oi</h1>" } }],
      };
    return { chunks: ["ok"] };
  };
}

const post = (body: string, channelId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId ?? f.general.id, { body });

const person = (userId: string) => ({ type: "person" as const, userId });

describe("artifacts made by agents", () => {
  test("an agent creates a document, updates it to v2, and a person downloads it", async () => {
    f = await setup({ artifactTools: true, reply: driveAgent() });
    await grantScopes(f.db, f.org.id, f.agent.id, DRIVE);
    const events = f.listen(f.general.id);
    await post("@dev faz um relatório de março");
    await drainOutbox(f.db, f.handlers);

    const [created] = await f.db.select().from(schema.artifacts);
    expect(created).toMatchObject({ kind: "document", title: "Relatório de março", currentVersion: 1 });
    // Asked in the channel: the file and the reply are in the channel itself.
    expect(created).toMatchObject({ channelId: f.general.id, threadId: null, createdByType: "agent" });
    const reply = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).at(-1);
    expect(reply?.meta.artifacts).toEqual([{ id: created?.id, version: 1, title: "Relatório de março" }]);
    await Bun.sleep(5);
    expect(events.some((e) => e.type === "artifact.created")).toBe(true);

    await post("@dev corrige o relatório, vendas foram 12");
    await drainOutbox(f.db, f.handlers);
    const id = created?.id ?? "";
    const v2 = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, id);
    expect(v2).toMatchObject({ version: 2, shownVersion: 2 });
    expect(v2.content).toEqual({ kind: "document", markdown: "# Março\nVendas: 12" });
    const v1 = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, id, 1);
    expect(v1.content).toEqual({ kind: "document", markdown: "# Março\nVendas: 10" });
    const versions = await listArtifactVersions(f.artifactDeps, person(f.owner.id), f.org.id, id);
    expect(versions.map((v) => [v.version, v.author.type, v.note])).toEqual([
      [2, "agent", "Corrigi as vendas"],
      [1, "agent", null],
    ]);

    const link = await artifactDownload(f.artifactDeps, f.owner.id, f.org.id, id);
    expect(link.url).toContain(encodeURIComponent(`orgs/${f.org.id}/artifacts/${id}/v2`));
    expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const file = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, id);
    expect(new TextDecoder().decode(file.body)).toBe("# Março\nVendas: 12");
    expect(file.filename).toBe("Relatorio-de-marco-v2.md");

    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, id));
    expect(audit.map((a) => a.action).sort()).toEqual(["artifact.created", "artifact.version_created"]);
    // Found by search, with the channel's visibility.
    const hits = await searchVisible(f.context, {
      orgId: f.org.id,
      text: "Vendas",
      visibleChannelIds: [f.general.id],
      kinds: ["file"],
    });
    expect(hits.map((h) => h.sourceId)).toContain(id);
  });

  test("a reply in the thread of the agent's message reads that message's files by title and id", async () => {
    // "Send it to Ana" under a reply with a file must name that file, not whatever the Drive has newest.
    const requests: ModelRequest[] = [];
    const contentOf = (m: ModelRequest["messages"][number]) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    f = await setup({
      artifactTools: true,
      reply: (req: ModelRequest) => {
        requests.push(req);
        const text = last(req);
        if (text.includes("tool_result")) return { chunks: ["Pronto, está no Drive."] };
        if (text.includes("monta o roteiro"))
          return {
            chunks: [],
            toolUses: [
              { name: "create_artifact", input: { title: "Roteiro do vídeo", kind: "document", markdown: "# Cena 1" } },
            ],
          };
        return { chunks: ["ok"] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, DRIVE);
    await post("@dev monta o roteiro");
    await drainOutbox(f.db, f.handlers);
    const [file] = await f.db.select().from(schema.artifacts);
    const reply = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).at(-1);
    // Written at post time with the title, so the context reads it with no query.
    expect(reply?.meta.artifacts).toEqual([{ id: file?.id, version: 1, title: "Roteiro do vídeo" }]);

    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev manda isso pra Ana",
      threadId: reply?.id ?? null,
    });
    await drainOutbox(f.db, f.handlers);
    const asked = requests.find((r) => r.messages.some((m) => contentOf(m).includes("manda isso pra Ana")));
    if (!asked) throw new Error("no run for the thread reply");
    // On the people's side (a note, like its own GIF's), never in its own words: it would learn to write the line.
    const note = `[Files you attached to your message above: "Roteiro do vídeo" (artifact ${file?.id})]`;
    const noteAt = asked.messages.findIndex((m) => m.role === "user" && contentOf(m).includes(note));
    expect(noteAt).toBeGreaterThan(0);
    expect(asked.messages[noteAt - 1]).toMatchObject({ role: "assistant", content: "Pronto, está no Drive." });
    expect(asked.messages.filter((m) => m.role === "assistant" && contentOf(m).includes("attached"))).toEqual([]);
  });

  test("html is stored as is and flagged untrusted", async () => {
    f = await setup({ artifactTools: true, reply: driveAgent() });
    await grantScopes(f.db, f.org.id, f.agent.id, DRIVE);
    await post("@dev monta uma página");
    await drainOutbox(f.db, f.handlers);
    const [row] = await f.db.select().from(schema.artifacts);
    expect(row).toMatchObject({ kind: "html", untrusted: true });
    const a = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, row?.id ?? "");
    expect(a).toMatchObject({ untrusted: true, canEdit: false, content: { kind: "html", html: "<h1>Oi</h1>" } });
    await expect(
      updateArtifact(f.artifactDeps, person(f.owner.id), f.org.id, a.id, {
        content: { kind: "html", html: "<h1>x</h1>" },
        baseVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("new agents can use the Drive by default; without drive:write the agent is refused", async () => {
    f = await setup({ artifactTools: true, reply: driveAgent() });
    const defaults = (await listAgentScopes(f.db, f.org.id, f.agent.id)).map((g) => g.scope);
    expect(defaults).toEqual(expect.arrayContaining(["context:read", "memory:write", "drive:read", "drive:write"]));
    // drive:write is a default; an admin revoked it here.
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "drive:read" }]);
    await post("@dev faz um relatório de março");
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.artifacts)).toEqual([]);
    const result = (await f.db.select().from(schema.agentRunSteps))
      .filter((s) => s.kind === "tool_result")
      .map((s) => s.data as { content: string; isError: boolean })[0];
    expect(result).toMatchObject({ isError: true });
    expect(result?.content).toContain("drive:write");
  });
});

describe("visibility and editing", () => {
  test("files of a private channel are invisible outside it, to people and agents", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const hidden = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, {
      title: "Plano secreto",
      channelId: secret.id,
      content: { kind: "document", markdown: "x" },
    });
    const open = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, {
      title: "Manual",
      content: { kind: "document", markdown: "y" },
    });
    await expect(getArtifact(f.artifactDeps, person(bia.id), f.org.id, hidden.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(artifactDownload(f.artifactDeps, bia.id, f.org.id, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listArtifacts(f.db, person(bia.id), f.org.id)).map((a) => a.id)).toEqual([open.id]);
    expect((await listArtifacts(f.db, person(f.owner.id), f.org.id)).map((a) => a.id).sort()).toEqual(
      [hidden.id, open.id].sort(),
    );
    // The agent sees it only in a run in that channel.
    const inGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    const inSecret = { type: "agent" as const, agentId: f.agent.id, channelId: secret.id };
    await expect(getArtifact(f.artifactDeps, inGeneral, f.org.id, hidden.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getArtifact(f.artifactDeps, inSecret, f.org.id, hidden.id)).title).toBe("Plano secreto");
    // A non-member can't create a file in the private channel either.
    await expect(
      createArtifact(f.artifactDeps, person(bia.id), f.org.id, {
        title: "x",
        channelId: secret.id,
        content: { kind: "document", markdown: "x" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("people edit documents and tables; a stale base version conflicts; delete by creator or admin", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const table = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, {
      title: "Metas",
      content: { kind: "table", columns: ["mês", "meta"], rows: [["jan", "10"]] },
    });
    const v2 = await updateArtifact(f.artifactDeps, person(f.owner.id), f.org.id, table.id, {
      content: {
        kind: "table",
        columns: ["mês", "meta"],
        rows: [
          ["jan", "10"],
          ["fev", "12, revisada"],
        ],
      },
      note: "fevereiro",
      baseVersion: 1,
    });
    expect(v2.version).toBe(2);
    await expect(
      updateArtifact(f.artifactDeps, person(bia.id), f.org.id, table.id, {
        content: { kind: "table", columns: ["mês"], rows: [] },
        baseVersion: 1,
      }),
    ).rejects.toThrow("newer version");
    const csv = await artifactFile(f.artifactDeps, bia.id, f.org.id, table.id, { format: "csv" });
    expect(new TextDecoder().decode(csv.body)).toBe('mês,meta\r\njan,10\r\nfev,"12, revisada"');

    const other = await addMember(f.db, f.org.id, "member", "caio");
    await expect(deleteArtifact(f.artifactDeps, other.id, f.org.id, table.id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteArtifact(f.artifactDeps, bia.id, f.org.id, table.id);
    await expect(getArtifact(f.artifactDeps, person(bia.id), f.org.id, table.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("two saves at the same version get distinct blob keys (a lost race keeps committed bytes)", async () => {
    f = await setup();
    const created = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, {
      title: "Doc",
      content: { kind: "document", markdown: "# v1" },
    });
    // The row as two racers would both have read it: currentVersion 1, so both compute v2.
    const [current] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, created.id));
    if (!current) throw new Error("no artifact row");
    const actor = person(f.owner.id);
    const bytesA = new TextEncoder().encode("AAAA");
    const bytesB = new TextEncoder().encode("BBBBBBBB");
    const a = await insertVersion(f.artifactDeps, actor, f.org.id, current, {
      stored: { body: bytesA, contentType: "text/markdown" },
      excerpt: "",
    });
    expect(a.version).toBe(2);
    // The second save holds the same stale v1: it writes its blob first, then the DB guard rejects it.
    await expect(
      insertVersion(f.artifactDeps, actor, f.org.id, current, {
        stored: { body: bytesB, contentType: "text/markdown" },
        excerpt: "",
      }),
    ).rejects.toThrow(ConflictError);
    // v2's committed bytes survive: with a shared key the losing put would have overwritten them.
    const store = await f.artifactDeps.blobs.forConfig(f.org.id, a.blob.storageConfigId);
    const got = await store.get(a.blob.key);
    expect(got ? [...got.body] : []).toEqual([...bytesA]);
  });

  test("an author's files: made by them, or made or changed by them (an agent's page)", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const mine = await createArtifact(f.artifactDeps, person(f.owner.id), f.org.id, {
      title: "Meu",
      content: { kind: "document", markdown: "a" },
    });
    const hers = await createArtifact(f.artifactDeps, person(bia.id), f.org.id, {
      title: "Dela",
      content: { kind: "document", markdown: "b" },
    });
    await updateArtifact(f.artifactDeps, person(f.owner.id), f.org.id, hers.id, {
      content: { kind: "document", markdown: "b2" },
      baseVersion: 1,
    });
    await createArtifact(f.artifactDeps, person(bia.id), f.org.id, {
      title: "Só dela",
      content: { kind: "document", markdown: "c" },
    });
    const owner = { type: "person" as const, id: f.owner.id };
    const ids = async (filters: Parameters<typeof listArtifacts>[3]) =>
      (await listArtifacts(f.db, person(bia.id), f.org.id, filters)).map((a) => a.id).sort();
    expect(await ids({ author: owner })).toEqual([mine.id]);
    expect(await ids({ changedBy: owner })).toEqual([mine.id, hers.id].sort());
  });

  test("kinds and sizes are validated", () => {
    expect(() => validateContent({ kind: "pdf" })).toThrow(ValidationError);
    expect(() => validateContent({ kind: "document" })).toThrow("markdown");
    const huge = "x".repeat(ARTIFACT_LIMITS.documentBytes + 1);
    expect(() => validateContent({ kind: "document", markdown: huge })).toThrow("too large");
    expect(() => validateContent({ kind: "table", columns: [], rows: [] })).toThrow("columns");
    expect(() => validateContent({ kind: "table", columns: ["a"], rows: [["1", "2"]] })).toThrow("too many cells");
    expect(() => validateContent({ kind: "diff", files: [{ path: "", patch: "" }] })).toThrow("path");
    expect(validateContent({ kind: "diagram", mermaid: "graph TD; A-->B" })).toEqual({
      kind: "diagram",
      mermaid: "graph TD; A-->B",
    });
    expect(tableToCsv(["a"], [['say "hi"']])).toBe('a\r\n"say ""hi"""');
  });
});
