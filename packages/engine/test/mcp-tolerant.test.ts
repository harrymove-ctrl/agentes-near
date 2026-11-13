import { afterEach, describe, expect, test } from "bun:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectCustomServer, type McpConnect, mcpSessionOver, refreshCustomServer, tolerantMcpFetch } from "../src";
import { type Fixture, setup } from "./fixtures";

const SERVER = "https://cnpj.example.com/mcp";

type Sse = "crlf" | "multiline" | "cr";

/**
 * An MCP server over HTTP (no network) that, like some public servers, adds its own top-level member (`fonte`) to
 * every JSON-RPC answer. `sse`: answers as an event stream cut in the middle of its lines, with \r\n line endings, the
 * message pretty-printed over several `data:` lines, or bare \r line endings.
 */
function chattyServer(mode: { sse?: Sse; down?: boolean; twice?: boolean } = {}) {
  const fetch: FetchLike = async (_url, init) => {
    if (mode.down) return new Response("upstream timed out", { status: 502 });
    if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 405 });
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const result =
      msg.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "cnpj", version: "1" },
          }
        : {
            tools: [
              { name: "consultar_cnpj", description: "Consulta um CNPJ", inputSchema: { type: "object" } },
              { name: "buscar_empresas", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              ...(mode.twice ? [{ name: "buscar_empresas", inputSchema: { type: "object" } }] : []),
            ],
          };
    const text = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result, fonte: { nome: "Receita", em: "2026" } });
    if (!mode.sse) return new Response(text, { headers: { "content-type": "application/json" } });
    const event =
      mode.sse === "multiline"
        ? `event: message\n${JSON.stringify(JSON.parse(text), null, 2)
            .split("\n")
            .map((l) => `data: ${l}\n`)
            .join("")}\n`
        : mode.sse === "cr"
          ? `event: message\rdata: ${text}\r\r`
          : `event: message\r\ndata: ${text}\r\n\r\n`;
    const cut = Math.floor(event.length / 2);
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(event.slice(0, cut)));
        c.enqueue(enc.encode(event.slice(cut)));
        c.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  return fetch;
}

const over = (fetch: FetchLike) =>
  mcpSessionOver(new StreamableHTTPClientTransport(new URL(SERVER), { fetch: tolerantMcpFetch(fetch) }));

describe("MCP servers that add their own members to JSON-RPC", () => {
  for (const sse of [undefined, "crlf", "multiline", "cr"] as const) {
    test(`their tools are listed (${sse ? `event stream, ${sse}` : "JSON"})`, async () => {
      const session = await over(chattyServer({ sse }));
      const tools = await session.listTools();
      expect(tools.map((t) => [t.name, t.readOnlyHint])).toEqual([
        ["consultar_cnpj", null],
        ["buscar_empresas", true],
      ]);
      expect(session.serverInfo?.()?.name).toBe("cnpj");
      await session.close();
    });
  }

  test("an event with bare \\r line endings is passed on before the stream ends", async () => {
    const enc = new TextEncoder();
    const msg = `{"jsonrpc":"2.0","method":"notifications/tools/list_changed","fonte":{}}`;
    const open = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(enc.encode(`data: ${msg}\r\rdata: next`)),
    });
    const fetch = tolerantMcpFetch(
      async () => new Response(open, { headers: { "content-type": "text/event-stream" } }),
    );
    const res = await fetch(SERVER);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("\n\n")) seen += decoder.decode((await reader.read()).value, { stream: true });
    expect(seen).toBe(`data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n`);
    await reader.cancel();
  });

  test("the SDK alone refuses them: what the tolerant fetch is for", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(SERVER), { fetch: chattyServer() });
    await expect(mcpSessionOver(transport)).rejects.toThrow();
  });
});

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

describe("a server whose tools can't be read", () => {
  test("says why (and logs it) instead of 0 tools; Tentar de novo that works clears it", async () => {
    f = await setup();
    const mode = { down: true };
    const connect: McpConnect = async () => over(chattyServer(mode));
    const warned: unknown[] = [];
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      resolveHost: async () => ["93.184.216.34"],
      connect,
      log: { warn: (_m: string, data?: Record<string, unknown>) => warned.push(data) },
    };
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "fake-key-not-real",
      label: "CNPJ",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    expect(started.server.tools).toEqual([]);
    expect(started.server.toolsError).toContain("upstream timed out");
    expect(warned).toHaveLength(1);

    mode.down = false;
    const fresh = await refreshCustomServer(deps, f.owner.id, f.org.id, started.server.id);
    expect(fresh.toolsError).toBeNull();
    expect(fresh.tools.map((t) => t.name)).toEqual(["buscar_empresas", "consultar_cnpj"]);
  });

  test("a failure after the tools were read is still an error, not a quiet refresh", async () => {
    f = await setup();
    const mode = { down: true, twice: false };
    const deps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      resolveHost: async () => ["93.184.216.34"],
      connect: (async () => over(chattyServer(mode))) as McpConnect,
    };
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "fake-key-not-real",
      label: "CNPJ",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    Object.assign(mode, { down: false, twice: true });
    await expect(refreshCustomServer(deps, f.owner.id, f.org.id, started.server.id)).rejects.toThrow();
  });
});
