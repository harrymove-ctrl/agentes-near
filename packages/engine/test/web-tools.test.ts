import { describe, expect, test } from "bun:test";
import {
  askVerdict,
  createWebToolSource,
  HOW_YOU_WORK,
  type Judge,
  type JudgeRequest,
  parseDuckDuckGoHtml,
  presentTools,
  type ToolContext,
  type ToolDefinition,
  toolPolicy,
  turnMeans,
} from "../src";
import {
  advance,
  type ContinuationVerdict,
  callLine,
  continuationVerdict,
  decideTurnEnd,
  type TurnEnd,
} from "../src/continuation";

// ADR 0109: web reading for every agent, the general means, and the controller's `untried` verdict.

const ctx = { orgId: "o", agentId: "a", runId: "r" } as unknown as ToolContext;
const DDG = `<div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fa&amp;rut=x">Notícia <b>A</b></a><a class="result__snippet" href="#">Texto &amp; mais</a></div>`;

function web(routes: Record<string, () => Response>, extra: Parameters<typeof createWebToolSource>[0] = {}) {
  const asked: string[] = [];
  const source = createWebToolSource({
    fetch: async (url) => {
      asked.push(url);
      const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      return hit ? hit[1]() : new Response("not found", { status: 404 });
    },
    resolveHost: async (host) => (host.endsWith(".internal.example") ? ["10.0.0.7"] : ["93.184.216.34"]),
    ...extra,
  });
  const tool = async (name: string) => {
    const found = (await source.tools(ctx)).find((t) => t.name === name);
    if (!found) throw new Error(name);
    return found;
  };
  return { asked, run: async (name: string, input: Record<string, unknown>) => (await tool(name)).execute(input, ctx) };
}

describe("web_search", () => {
  test("DuckDuckGo's HTML page with no key: titles, real links and snippets", async () => {
    expect(parseDuckDuckGoHtml(DDG)).toEqual([
      { title: "Notícia A", url: "https://news.example.com/a", snippet: "Texto & mais" },
    ]);
    const usage: Record<string, unknown>[] = [];
    const w = web(
      { "https://html.duckduckgo.com/": () => new Response(DDG) },
      { usage: { recordExternalUsage: async (u) => usage.push(u) } },
    );
    const out = await w.run("web_search", { query: "notícias" });
    // Every call is the agent's usage, never on its budget.
    expect(usage).toEqual([
      expect.objectContaining({
        agentId: "a",
        runId: "r",
        kind: "agent",
        provider: "web",
        model: "duckduckgo",
        costNanoUsd: 0,
      }),
    ]);
    expect(out.content).toContain("1. Notícia A\n   https://news.example.com/a\n   Texto & mais");
    expect(out.data).toMatchObject({ provider: "duckduckgo" });
  });

  test("Brave first when its key is set; on its failure, the next provider", async () => {
    const brave = { web: { results: [{ title: "B", url: "https://b.example.com", description: "d" }] } };
    const ok = web({ "https://api.search.brave.com/": () => Response.json(brave) }, { braveKey: "k" });
    expect((await ok.run("web_search", { query: "x" })).data).toMatchObject({ provider: "brave" });
    const down = web(
      {
        "https://api.search.brave.com/": () => new Response("", { status: 500 }),
        "https://searx.example.com/": () => Response.json({ results: [{ title: "S", url: "https://s.example.com" }] }),
      },
      { braveKey: "k", searxngUrl: "https://searx.example.com/" },
    );
    expect((await down.run("web_search", { query: "x" })).data).toMatchObject({ provider: "searxng" });
  });

  test("the agent's browser: Google, then Bing on a captcha; DuckDuckGo's page when it has none", async () => {
    const opened: string[] = [];
    const w = web(
      {},
      {
        browser: async (_ctx, url) => {
          opened.push(url);
          return url.includes("google")
            ? { text: "Our systems have detected unusual traffic", url: "https://www.google.com/sorry/index" }
            : { text: "Resultados do Bing: Banco Azul", url };
        },
      },
    );
    const out = await w.run("web_search", { query: "banco azul" });
    expect(opened.map((u) => new URL(u).host)).toEqual(["www.google.com", "www.bing.com"]);
    expect(out.content).toContain("Resultados do Bing");
    const none = web({ "https://html.duckduckgo.com/": () => new Response(DDG) }, { browser: async () => null });
    expect((await none.run("web_search", { query: "x" })).data).toMatchObject({ provider: "duckduckgo" });
  });

  test("nothing anywhere: says what failed and what to try instead", async () => {
    const w = web({ "https://html.duckduckgo.com/": () => new Response("anomaly-modal", { status: 200 }) });
    const out = await w.run("web_search", { query: "x" });
    expect(out.content).toContain("Nothing found");
    expect(out.content).toContain("duckduckgo: showed a bot check");
  });
});

describe("web_fetch", () => {
  test("a GET through the public-URL guard on every hop: text out, private addresses never", async () => {
    const w = web({
      "https://site.example.com/a": () =>
        new Response("<h1>Olá</h1><p>Mundo</p>", { headers: { "content-type": "text/html" } }),
      "https://site.example.com/moved": () =>
        new Response(null, { status: 302, headers: { location: "https://x.internal.example/" } }),
    });
    const ok = await w.run("web_fetch", { url: "http://site.example.com/a" });
    expect(ok.content).toMatch(/^Page: https:\/\/site\.example\.com\/a\nOlá\n+Mundo$/);
    const moved = await w.run("web_fetch", { url: "https://site.example.com/moved" });
    expect(moved.isError).toBe(true);
    expect(w.asked).not.toContain("https://x.internal.example/");
    expect((await w.run("web_fetch", { url: "https://127.0.0.1/" })).isError).toBe(true);
  });

  test("a block says so and names the other ways", async () => {
    const w = web({ "https://shop.example.com/": () => new Response("Forbidden", { status: 403 }) });
    const out = await w.run("web_fetch", { url: "https://shop.example.com/" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("answered 403");
    expect(out.content).toContain("your browser");
  });

  test("every run may read the web, a routine's included", () => {
    const routine = { kind: "routine", personId: null, brief: null } as const;
    for (const name of ["web_search", "web_fetch"])
      expect(toolPolicy(routine, { name, scope: "" }).action).toBe("allow");
  });
});

describe("the general means", () => {
  const def = (name: string, scope = ""): ToolDefinition => ({
    name,
    scope,
    description: name.replace(/_/g, " "),
    inputSchema: { type: "object" },
    execute: async () => ({ content: "" }),
  });

  test("only what the run has", () => {
    expect(turnMeans(new Set(["web_search", "web_fetch"]))).toEqual([
      "the web: `web_search` to search it, `web_fetch` to read any public page",
    ]);
    expect(turnMeans(new Set(["run_code", "tell_agent"]), ["@lia (Finanças)"]).join("\n")).toContain(
      "teammates (`ask_agent`, `tell_agent`): @lia (Finanças)",
    );
    expect(turnMeans(new Set())).toEqual([]);
  });

  test("find_tools with no good match lists them; a good match doesn't", async () => {
    const tools = presentTools(
      [def("web_search"), def("web_fetch"), def("run_code", "sandbox:run"), def("create_issue", "issues:write")],
      undefined,
      [],
    );
    const find = tools.find((t) => t.name === "find_tools");
    if (!find) throw new Error("no find_tools");
    const weak = (await find.execute({ query: "book a flight to Lisbon" }, ctx)).content;
    expect(weak).toContain('General means you have for "book a flight to Lisbon"');
    expect(weak).toContain("`web_search`");
    expect(weak).toContain("`run_code`");
    expect(weak).not.toContain("browser");
    expect((await find.execute({ query: "create issue" }, ctx)).content).not.toContain("General means");
  });
});

describe("the controller's untried verdict", () => {
  const turn = (verdict: ContinuationVerdict, count = 0, executed = 1): TurnEnd => ({
    state: { count, executedAtNudge: count ? 1 : undefined },
    kind: "conversation",
    executed,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "Não consigo.",
    mission: false,
    wakesLater: async () => false,
    verdict: async () => verdict,
    evidence: { means: ["the web: `web_search`"], tried: ["find_tools(search the web) → No tool matches"] },
  });

  test("continues once with the means and what it tried; never past the cap or without progress", async () => {
    const d = await decideTurnEnd(turn("untried"));
    expect(d).toMatchObject({ outcome: "continue", rule: "untried" });
    expect(d.nudge).toContain("the web: `web_search`");
    expect(d.nudge).toContain("find_tools(search the web)");
    expect(await decideTurnEnd(turn("untried", 1, 1))).toMatchObject({ outcome: "done", rule: "untried_cap" });
    expect(await decideTurnEnd(turn("untried", 2, 9))).toMatchObject({ outcome: "done", rule: "untried_cap" });
    expect(await decideTurnEnd(turn("done"))).toMatchObject({ outcome: "done", rule: "judged" });
  });

  test("a secret asked in the chat never becomes a question card: told the secure way once, then ends", async () => {
    const asked = { ...turn("secret"), state: { count: 0, askNudged: true, askPending: true } };
    const d = await decideTurnEnd(asked);
    expect(d).toMatchObject({ outcome: "continue", rule: "secret" });
    expect(d.nudge).toContain("request_secret");
    const next = advance(asked.state, d, 1);
    expect(next.secretNudged).toBe(true);
    expect(next.count).toBe(0);
    expect(await decideTurnEnd({ ...turn("secret"), state: next })).toMatchObject({
      outcome: "done",
      rule: "secret_cap",
    });
    expect(await decideTurnEnd({ ...turn("secret"), kind: "routine" })).toMatchObject({
      outcome: "done",
      rule: "ask_elsewhere",
    });
  });

  test("an answer with a caveat is done: untried must read as more likely than done", async () => {
    const asked: JudgeRequest[] = [];
    const judgeSaying = (probabilities: Record<string, number>): Judge => ({
      name: "fake",
      ask: async (request) => {
        asked.push(request);
        return { verdict: { choice: "done", probabilities } };
      },
    });
    const input = {
      orgId: "o",
      agentId: "a",
      runId: "r",
      request: "Quanto vendemos em novembro no Stripe?",
      reply: "R$ 48.200 brutos em 312 cobranças, R$ 47.050 líquidos. A API não separa por produto.",
      means: ["the web: `web_search`"],
      tried: ["stripe_analytics(novembro) → 312 cobranças"],
      runKind: "conversation" as const,
    };
    expect(await continuationVerdict(judgeSaying({ done: 0.52, untried: 0.48 }), input)).toBe("done");
    expect(await continuationVerdict(judgeSaying({ done: 0.5, untried: 0.5 }), input)).toBe("done");
    // A give-up read as more likely untried is still held for another try.
    expect(await continuationVerdict(judgeSaying({ done: 0.35, untried: 0.65 }), input)).toBe("untried");
    // The judge reads that a caveat beside the answer is no give-up.
    const verdict = asked[0]?.questions.verdict as { criteria: Record<string, string> } | undefined;
    const criteria = verdict?.criteria ?? {};
    expect(criteria.done).toContain("also when it adds a caveat");
    expect(criteria.untried).toStartWith("What `request` asked for is still missing");
  });

  test("a call as the judge reads it", () => {
    expect(callLine("web_search", { query: "banco azul" }, { content: "1. A\n   https://a" })).toBe(
      "web_search(banco azul) → 1. A https://a",
    );
    expect(
      callLine("use_tool", { tool: "crm_find", arguments: { name: "Acme" } }, { content: "x", isError: true }),
    ).toBe("crm_find(Acme) → failed: x");
  });
});

describe("asking a person (ADR 0109 addendum)", () => {
  const judging = (probabilities: Record<string, number>): Judge => ({
    name: "fake",
    ask: async () => ({ verdict: { probabilities } }),
  });
  const input = { orgId: "o", agentId: "a", runId: "r", question: "q", request: "r", means: [], tried: [] };

  test("findable, secret or a person's own, by the judge's probabilities", async () => {
    expect(await askVerdict(judging({ findable: 0.7, secret: 0.1, person: 0.2 }), input)).toBe("findable");
    expect(await askVerdict(judging({ findable: 0.3, secret: 0.6, person: 0.1 }), input)).toBe("secret");
    // Unsure goes to the person: a needless hold is worse than a question.
    expect(await askVerdict(judging({ findable: 0.45, secret: 0.1, person: 0.45 }), input)).toBe("person");
    expect(await askVerdict(judging({}), input)).toBe("person");
  });

  test("the prompt says to find first, ask only what a person can give, a secret through request_secret", () => {
    expect(HOW_YOU_WORK).toContain("Before asking a person, find what you can");
    expect(HOW_YOU_WORK).toContain("A secret or a key always through `request_secret`");
    expect(HOW_YOU_WORK).toContain("with no `request_secret`, say which key is needed and where it is set up");
  });
});
