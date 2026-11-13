import { expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { mcpSessionOver } from "../src";

/** A server answering like GitHub's `get_file_contents`: a status line, then the file as an embedded resource. */
async function session() {
  const server = new McpServer({ name: "files", version: "1" });
  server.registerTool("get_file_contents", { description: "Get a file" }, async () => ({
    content: [
      { type: "text" as const, text: "successfully downloaded text file (SHA: 34f0320)" },
      {
        type: "resource" as const,
        resource: {
          uri: "repo://acme/app/contents/docs/adr/0001.md",
          mimeType: "text/markdown",
          text: "# Early access\n\nSign-up is open.",
        },
      },
      {
        type: "resource" as const,
        resource: { uri: "repo://acme/app/contents/logo.png", mimeType: "image/png", blob: "iVBORw0KGgo=" },
      },
    ],
  }));
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  return mcpSessionOver(client);
}

test("a file sent as an embedded resource reaches the agent as its text; a binary one stays a placeholder", async () => {
  const s = await session();
  const out = await s.callTool("get_file_contents", {});
  expect(out.isError).toBe(false);
  expect(out.content).toBe(
    "successfully downloaded text file (SHA: 34f0320)\n# Early access\n\nSign-up is open.\n[resource]",
  );
  await s.close();
});

/** Twenty tools, each with an output schema of 40 columns a row. */
async function reports() {
  const server = new McpServer({ name: "reports", version: "1" });
  const row = z.object(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`column_${i}`, z.string()])));
  for (let i = 0; i < 20; i++) {
    server.registerTool(`report_${i}`, { description: "A report", outputSchema: { rows: z.array(row) } }, async () => ({
      content: [{ type: "text" as const, text: "[]" }],
      structuredContent: { rows: [] },
    }));
  }
  const [client, transport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  return client;
}

test("listing tools compiles none of their output schemas", async () => {
  const compiles = spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
  try {
    const s = await mcpSessionOver(await reports());
    expect(await s.listTools()).toHaveLength(20);
    expect(compiles).not.toHaveBeenCalled();
    await s.close();
    // The SDK's default: every listing compiles each one again, with a new Ajv for every client.
    const plain = new Client({ name: "plain", version: "1" });
    await plain.connect(await reports());
    await plain.listTools();
    expect(compiles).toHaveBeenCalledTimes(20);
    await plain.close();
  } finally {
    compiles.mockRestore();
  }
});
