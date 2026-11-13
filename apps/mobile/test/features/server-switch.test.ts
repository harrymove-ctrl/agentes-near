import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { serverTrouble } from "../../src/features/chats/logic";

const source = (file: string) => readFileSync(path.join(import.meta.dir, "../../src", file), "utf8");

describe("switching servers (ADR 0154)", () => {
  test("every screen mounts again on another server: a query hook keeps the client it mounted with", () => {
    // TanStack's useQuery makes its observer once, with the client it first saw: without a fresh tree the screens kept
    // the first server's cache and asked the new server for the old one's workspace (403 "not a member").
    expect(source("providers/AppProviders.tsx")).toContain(
      "<QueryClientProvider key={scope.server} client={scope.queryClient}>",
    );
  });

  test("Conversas that didn't load says why, never 'open Tailscale' when the server answered", () => {
    const answered = { ok: true, server: "https://agentes-1.exemplo.ts.net" } as never;
    expect(serverTrouble({ offline: true, check: answered, tailnet: true })).toEqual({ kind: "offline" });
    expect(serverTrouble({ offline: false, check: answered, tailnet: true })).toEqual({ kind: "answered" });
    // Not answering: on a tailnet its Tailscale advice, elsewhere a server that is down.
    expect(serverTrouble({ offline: false, check: null, tailnet: true })).toEqual({
      kind: "problem",
      problem: "unreachable",
    });
    expect(serverTrouble({ offline: false, check: null, tailnet: false })).toEqual({ kind: "down" });
    const old = { ok: false, problem: "server-too-old", server: "https://x.test" } as never;
    expect(serverTrouble({ offline: false, check: old, tailnet: false })).toEqual({
      kind: "problem",
      problem: "server-too-old",
    });
  });
});
