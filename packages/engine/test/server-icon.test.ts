import { afterEach, describe, expect, test } from "bun:test";
import { createPostgresBlobStore } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type ConnectorConnection,
  type CustomDeps,
  connectCustomServer,
  connectorIconFile,
  createOrganization,
  iconCandidates,
  imageDimensions,
  type McpConnect,
  type McpIcon,
  mcpSessionOver,
  NotFoundError,
  readIcon,
  refreshCustomServer,
  refreshServerIcon,
} from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SERVER = "https://tickets.example.com/mcp";
/** A 1×1 PNG. */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** The same PNG claiming another size in its header. */
function pngSized(width: number, height: number) {
  const out = PNG.slice();
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

describe("which icon to try", () => {
  test("PNG, JPEG or WebP on the server's own origin or inline; nearest 128 px first", () => {
    const icons: McpIcon[] = [
      { src: "https://tickets.example.com/16.png", sizes: ["16x16"] },
      { src: "https://tickets.example.com/logo.svg", sizes: ["any"] },
      { src: "https://tickets.example.com/vector", mimeType: "image/svg+xml" },
      { src: "https://cdn.other.com/logo.png", sizes: ["128x128"] },
      { src: "http://tickets.example.com/plain.png", sizes: ["128x128"] },
      { src: "javascript:alert(1)" },
      { src: "data:image/svg+xml;base64,PHN2Zy8+" },
      { src: "https://tickets.example.com:8443/port.png", sizes: ["128x128"] },
      { src: "https://tickets.example.com/512.png", sizes: ["512x512"] },
      { src: "https://tickets.example.com/any.png" },
      { src: `data:image/png;base64,${b64(PNG)}`, sizes: ["96x96"] },
      { src: "https://tickets.example.com/120.webp", sizes: ["120x120"], mimeType: "image/webp" },
    ];
    expect(iconCandidates(SERVER, icons).map((i) => i.src.slice(0, 40))).toEqual([
      "https://tickets.example.com/120.webp",
      "data:image/png;base64,iVBORw0KGgoAAAANSU",
      "https://tickets.example.com/512.png",
      "https://tickets.example.com/any.png",
      "https://tickets.example.com/16.png",
    ]);
    expect(iconCandidates(SERVER, "nope")).toEqual([]);
    expect(iconCandidates(SERVER, [null, 3, { src: 4 }])).toEqual([]);
  });

  test("the bytes decide the type; the declared one must agree; huge images are refused", () => {
    expect(imageDimensions(PNG, "image/png")).toEqual({ width: 1, height: 1 });
    expect(readIcon(PNG)?.type).toBe("image/png");
    expect(readIcon(PNG, "image/png")?.type).toBe("image/png");
    expect(readIcon(PNG, "image/jpeg")).toBeNull();
    expect(readIcon(new Uint8Array(Buffer.from("<svg onload=alert(1)/>")))).toBeNull();
    expect(readIcon(pngSized(1024, 1024))).not.toBeNull();
    expect(readIcon(pngSized(20_000, 20_000))).toBeNull();
    expect(readIcon(pngSized(0, 1))).toBeNull();
    expect(readIcon(new Uint8Array(0))).toBeNull();
  });
});

/** An in-process MCP server whose `serverInfo` lists `icons` (changeable between connections). */
function iconMcp(icons: McpIcon[]) {
  const state = { icons };
  const connect: McpConnect = async () => {
    const server = new McpServer({ name: "tickets", version: "1", icons: state.icons } as never);
    server.registerTool("list_tickets", { description: "List tickets", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "none" }],
    }));
    const [client, end] = InMemoryTransport.createLinkedPair();
    await server.connect(end);
    return mcpSessionOver(client);
  };
  return { connect, state };
}

describe("a custom server's own icon", () => {
  test("concurrent refreshes that fetch different icons leave no orphan blob", async () => {
    f = await setup();
    const blobs = createPostgresBlobStore(f.db);
    const images: Record<string, Uint8Array> = {
      "https://tickets.example.com/o.png": pngSized(64, 64),
      "https://tickets.example.com/x.png": pngSized(72, 72),
      "https://tickets.example.com/y.png": pngSized(80, 80),
    };
    const httpFor = (url: string) => (async () => new Response(images[url])) as unknown as typeof fetch;
    const deps: CustomDeps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      resolveHost: async () => ["93.184.216.34"],
      http: httpFor("https://tickets.example.com/o.png"),
      connect: iconMcp([{ src: "https://tickets.example.com/o.png", sizes: ["64x64"] }]).connect,
      blobs,
    };
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "tk_secret_12345",
      label: "Tickets",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const id = started.server.id;
    const prefix = `orgs/${f.org.id}/connector-icons/${id}/`;
    expect(await blobs.list(prefix)).toHaveLength(1);

    // Both refreshes read the icon the connect stored (stale) and fetch a different new icon.
    const stale = {
      id,
      orgId: f.org.id,
      serverUrl: SERVER,
      icon: started.server.iconUrl,
    } as unknown as ConnectorConnection;
    const iconDeps = (url: string) => ({
      db: f.db,
      blobs,
      resolveHost: async () => ["93.184.216.34"],
      http: httpFor(url),
    });
    await refreshServerIcon(iconDeps("https://tickets.example.com/x.png"), stale, {
      icons: [{ src: "https://tickets.example.com/x.png", sizes: ["64x64"] }],
    });
    await refreshServerIcon(iconDeps("https://tickets.example.com/y.png"), stale, {
      icons: [{ src: "https://tickets.example.com/y.png", sizes: ["64x64"] }],
    });

    // The refresh that lost the compare-and-set deleted its own new blob: only the winner's icon remains.
    const left = await blobs.list(prefix);
    expect(left).toHaveLength(1);
    const [row] = await f.db.select().from(schema.connectorConnections);
    expect(left[0]).toBe(`${prefix}${row?.icon?.split("/").pop()}`);
  });

  test("kept on connect, served to members only, replaced, and dropped when the server stops listing one", async () => {
    f = await setup();
    // Postgres: the store a self-hosted server without a bucket or a files folder uses (it refuses unknown keys).
    const blobs = createPostgresBlobStore(f.db);
    const fetched: { url: string; init?: RequestInit }[] = [];
    const http = (async (input: string | URL, init?: RequestInit) => {
      fetched.push({ url: String(input), init });
      if (String(input) === "https://tickets.example.com/icon.png") return new Response(PNG);
      if (String(input) === "https://tickets.example.com/huge.png") return new Response(pngSized(9000, 9000));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const mcp = iconMcp([
      { src: "https://tickets.example.com/huge.png", sizes: ["128x128"] },
      { src: "https://tickets.example.com/icon.png", sizes: ["64x64"] },
    ]);
    const deps: CustomDeps = {
      db: f.db,
      keyWrappers: [f.keyWrapper],
      publicUrl: "https://chat.example.com",
      resolveHost: async () => ["93.184.216.34"],
      http,
      connect: mcp.connect,
      blobs,
    };
    const started = await connectCustomServer(deps, f.owner.id, f.org.id, {
      serverUrl: SERVER,
      apiKey: "tk_secret_12345",
      label: "Tickets",
    });
    if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
    const id = started.server.id;
    const iconUrl = started.server.iconUrl;
    expect(iconUrl).toMatch(new RegExp(`^/api/app/connector-icons/${f.org.id}/${id}/[0-9a-f]{16}\\.png$`));
    // The huge one was tried first and refused; no credentials went with either request.
    expect(fetched.map((x) => x.url)).toEqual([
      "https://tickets.example.com/huge.png",
      "https://tickets.example.com/icon.png",
    ]);
    for (const x of fetched) {
      expect(x.init?.redirect).toBe("error");
      expect(JSON.stringify(x.init?.headers ?? {})).not.toContain("tk_secret_12345");
    }

    const file = iconUrl?.split("/").pop() ?? "";
    const served = await connectorIconFile({ db: f.db, blobs }, f.owner.id, f.org.id, id, file);
    expect(served.contentType).toBe("image/png");
    const outsider = await addUser(f.db, "zed");
    await createOrganization(f.db, outsider.id, { name: "Other" });
    await expect(connectorIconFile({ db: f.db, blobs }, outsider.id, f.org.id, id, file)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      connectorIconFile({ db: f.db, blobs }, f.owner.id, f.org.id, id, "../secret.png"),
    ).rejects.toBeInstanceOf(NotFoundError);

    // An inline icon replaces it; the old file goes.
    mcp.state.icons = [{ src: `data:image/png;base64,${b64(pngSized(48, 48))}` }];
    const inline = await refreshCustomServer(deps, f.owner.id, f.org.id, id);
    expect(inline.iconUrl).not.toBe(iconUrl);
    expect(await blobs.list(`orgs/${f.org.id}/connector-icons/${id}/`)).toHaveLength(1);

    // Every icon failing keeps the last good one (the failure may pass).
    mcp.state.icons = [{ src: "https://tickets.example.com/gone.png" }];
    expect((await refreshCustomServer(deps, f.owner.id, f.org.id, id)).iconUrl).toBe(inline.iconUrl);

    // No icons listed: back to the monogram.
    mcp.state.icons = [];
    expect((await refreshCustomServer(deps, f.owner.id, f.org.id, id)).iconUrl).toBeNull();
    expect(await blobs.list(`orgs/${f.org.id}/connector-icons/${id}/`)).toEqual([]);
    const [row] = await f.db.select().from(schema.connectorConnections);
    expect(row?.icon).toBeNull();
  });
});
