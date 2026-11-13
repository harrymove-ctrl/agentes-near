import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  acceptCustomSuggestion,
  type ConnectorDeps,
  connectCustomServer,
  createApiKeyConnection,
  createConnectorToolSource,
  createJobHandlers,
  createToolGateway,
  drainOutbox,
  grantScopes,
  openDm,
  postPersonMessage,
  suggestAccess,
} from "../src";
import { fakeGithubMcp } from "./fake-mcp";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });

describe("what earlier runs did", () => {
  test("a new run in the thread sees the issue the previous one created, and is told to verify with the tool", async () => {
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Criei a #1."] };
        if (last.includes("cria a issue"))
          return {
            chunks: [],
            toolUses: [{ name: "create_issue", input: { title: "Integração com TikTok Ads", labels: ["ads"] } }],
          };
        return { chunks: ["Sim."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:write" }]);
    const events = f.listen(f.general.id);
    const root = await post("@dev cria a issue da integração");
    await drainOutbox(f.db, f.handlers);
    // The activity bar: a tool started, then ended.
    await Bun.sleep(5);
    const toolEvents = events
      .filter((e) => e.type === "agent.tool")
      .map((e) => (e as unknown as { tool: string | null; threadId: string | null }).tool);
    expect(toolEvents).toEqual(["create_issue", null]);
    // The end names its call, and says nothing failed.
    const [start, end] = events.filter((e) => e.type === "agent.tool") as unknown as {
      toolUseId?: string;
      failed?: boolean;
    }[];
    expect(end?.toolUseId).toBe(start?.toolUseId);
    expect(end?.failed).toBeUndefined();
    await post("@dev você criou mesmo?", root.id);
    await drainOutbox(f.db, f.handlers);
    const prompt = systemText(f.provider.calls.at(-1)?.request.system ?? "");
    expect(prompt).toContain("# Recent actions in this thread");
    expect(prompt).toMatch(/@dev create_issue → Created #1 \[todo\] Integração com TikTok Ads.*\(ok\)/);
    expect(prompt).toContain(
      "check its current state with the matching tool or page (`list_issues`, `read_artifact`, `list_events`…), not `search_context`",
    );
    expect(prompt).toContain("Never say you didn't do");
  });
});

describe("connectors the agent can't use yet", () => {
  test("the prompt says what is missing and who can fix it", async () => {
    const tickets = fakeGithubMcp(); // any MCP server will do: its tools come in unclassified
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const deps: ConnectorDeps & { connect: typeof tickets.connect } = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      resolveHost: async () => ["93.184.216.34"],
      connect: tickets.connect,
    };
    await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: "https://app.himetrica.example.com/api/v1/mcp",
      apiKey: "hm_secret_12345",
      label: "himetrica",
    });
    const github = await createApiKeyConnection(deps, f.owner.id, f.org.id, {
      connector: "github",
      apiKey: "ghp_secret_123456",
    });
    // Taken away from Dev (a new connection is every agent's).
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, github.id));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      tools: createToolGateway({ sources: [createConnectorToolSource(deps)] }),
    });
    await post("@dev consegue ver o himetrica?");
    await drainOutbox(f.db, handlers);
    const prompt = systemText(f.provider.calls.at(-1)?.request.system ?? "");
    expect(prompt).toContain("Organization connectors you can't use yet:");
    expect(prompt).toContain("- himetrica: connected, waiting for an admin to classify the tools");
    expect(prompt).toContain("- GitHub: connected, but the tools were not enabled for you");
    expect(prompt).toContain("Never say the connector doesn't exist.");
  });

  test("suggested classification, accepted in one call, lists the agents without access", async () => {
    expect(suggestAccess({ name: "list_events", readOnlyHint: true })).toBe("read");
    expect(suggestAccess({ name: "delete_report", readOnlyHint: null })).toBe("approval");
    expect(suggestAccess({ name: "wipe", destructiveHint: true })).toBe("approval");
    expect(suggestAccess({ name: "get_pull_request" })).toBe("read");
    const mcp = fakeGithubMcp();
    f = await setup();
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      resolveHost: async () => ["93.184.216.34"],
      connect: mcp.connect,
    };
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: "https://mcp.example.com/mcp",
      apiKey: "key_12345678",
      label: "Repo",
    });
    if (started.status !== "connected") throw new Error("expected connected");
    expect(started.server.tools.find((t) => t.name === "merge_pull_request")?.suggestedAccess).toBe("approval");
    // Taken away from Dev (a new server is every agent's).
    await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.connectionId, started.server.id));
    const accepted = await acceptCustomSuggestion(deps, f.owner.id, f.org.id, started.server.id);
    expect(accepted.server.tools.every((t) => t.access !== null)).toBe(true);
    expect(accepted.server.tools.find((t) => t.name === "merge_pull_request")?.access).toBe("approval");
    expect(accepted.agentsWithoutAccess.map((a) => a.id)).toEqual([f.agent.id]);
    expect(accepted.suggestedGrant).toEqual({ connectors: { [started.server.id]: true } });
    const audit = await f.db.select().from(schema.auditLog);
    expect(audit.some((a) => a.action === "connector.custom_tools_classified")).toBe(true);
  });
});

test("in a DM, actions of earlier runs show up too (DMs are flat)", async () => {
  let n = 0;
  f = await setup({
    issueTools: true,
    reply: (req: ModelRequest) => {
      n++;
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (n === 1) return { chunks: [], toolUses: [{ name: "create_issue", input: { title: "Relatório semanal" } }] };
      return { chunks: [last.includes("tool_result") ? "Criei." : "Sim."] };
    },
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:write" }]);
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "cria uma issue" });
  await drainOutbox(f.db, f.handlers);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "e aí, criou?" });
  await drainOutbox(f.db, f.handlers);
  const prompt = systemText(f.provider.calls.at(-1)?.request.system ?? "");
  expect(prompt).toContain("# Recent actions in this DM");
  expect(prompt).toContain("create_issue → Created #1");
});
