import { describe, expect, test } from "bun:test";
import { foldTalk, TALK_LINE_CHARS, talksToAgent } from "../src/lib/agent-talk";

const AGENTS: Record<string, string> = { iris: "a-iris", theo: "a-theo" };
const agentOf = (handle: string) => AGENTS[handle];
const msg = (over: { type?: "agent" | "person"; id?: string; body?: string; meta?: Record<string, unknown> }) => ({
  author: { type: over.type ?? "agent", id: over.id ?? "a-iris" },
  body: over.body ?? "Pronto.",
  meta: over.meta ?? {},
});

const LONG = [
  "@Theo Olhei o servidor e o banco. Resumo: o pool do pgbouncer está esgotado desde o deploy do v2.41.",
  "",
  "**O que vi:**",
  "",
  "- Deploy do v2.41 às 18h02; na infra nada mudou.",
  "- O pool do pgbouncer está em 20 de 20 desde as 18h10 e não desce.",
  "- 312 conexões em espera no pico das 20h40; antes do deploy, nunca passou de 4.",
  "- A p95 do /checkout foi de 180 ms para 1,4 s; os outros endpoints estão normais.",
  "- CPU e memória do db-prod-1 estão em 35% e 52%, longe do limite.",
  "",
  "```sql",
  "SELECT client_addr, state FROM pg_stat_activity",
  "WHERE application_name = 'checkout';",
  "```",
  "",
  "Os 5 primeiros estão em idle in transaction há 41 a 47 min: é código que abre transação e não fecha.",
  "",
  "Reiniciar o pgbouncer alivia por umas horas, mas volta. A correção é no código do v2.41.",
].join("\n");

describe("talksToAgent", () => {
  test("a run another agent's message started (`toAgent`), or one the router brought in after it (`joined`)", () => {
    expect(talksToAgent(msg({ meta: { toAgent: "a-theo" } }), agentOf)).toBe(true);
    expect(talksToAgent(msg({ meta: { joined: true } }), agentOf)).toBe(true);
    // Its own notice woke it: not another agent.
    expect(talksToAgent(msg({ meta: { toAgent: "a-iris" } }), agentOf)).toBe(false);
  });

  test("a message that opens by mentioning another agent; a mention further in, or of itself, isn't one", () => {
    expect(talksToAgent(msg({ body: "@Theo, achei o problema." }), agentOf)).toBe(true);
    expect(talksToAgent(msg({ body: "  @theo achei." }), agentOf)).toBe(true);
    expect(talksToAgent(msg({ body: "Pedi pra @theo ver o código." }), agentOf)).toBe(false);
    expect(talksToAgent(msg({ body: "@iris aqui." }), agentOf)).toBe(false);
    expect(talksToAgent(msg({ body: "@walter pronto." }), agentOf)).toBe(false);
  });

  test("people's messages never fold", () => {
    const person = msg({ type: "person", id: "u1", body: "@Theo olha isso", meta: { toAgent: "a-theo" } });
    expect(talksToAgent(person, agentOf)).toBe(false);
  });
});

describe("foldTalk", () => {
  test("a short message stays whole", () => {
    expect(foldTalk("@Theo pronto, subi a correção.", TALK_LINE_CHARS.web)).toBeNull();
  });

  test("a long one: its first paragraph as written, and about how many lines more", () => {
    const fold = foldTalk(LONG, TALK_LINE_CHARS.web);
    expect(fold?.lead).toBe(
      "@Theo Olhei o servidor e o banco. Resumo: o pool do pgbouncer está esgotado desde o deploy do v2.41.",
    );
    expect(fold?.more).toBeGreaterThanOrEqual(12);
  });

  test("the same text folds sooner on a phone, with more lines behind", () => {
    const medium = [
      "@Theo O deploy do v2.41 foi às 18h02 e o pool está em 20 de 20 desde as 18h10, sem descer.",
      "",
      "As conexões presas são todas do checkout, em idle in transaction há mais de 40 minutos.",
      "",
      "Reiniciar alivia por umas horas; a correção é no código do v2.41, onde o carrinho abre conexão por item.",
      "",
      "CPU e memória do db-prod-1 estão em 35% e 52%, longe do limite, então o servidor não é o gargalo.",
      "",
      "Se quiser, eu acompanho o pool e aviso se passar de 18 de 20 antes da correção subir.",
    ].join("\n");
    expect(foldTalk(medium, TALK_LINE_CHARS.web)).toBeNull();
    const phone = foldTalk(medium, TALK_LINE_CHARS.phone);
    expect(phone?.lead.startsWith("@Theo O deploy")).toBe(true);
    expect(phone?.more).toBeGreaterThanOrEqual(4);
  });

  test("one huge paragraph: cut at a word, with an ellipsis", () => {
    const words = Array.from({ length: 400 }, (_, i) => `palavra${i}`).join(" ");
    const fold = foldTalk(words, TALK_LINE_CHARS.web);
    expect(fold?.lead.endsWith("…")).toBe(true);
    expect((fold?.lead.length ?? 0) <= 361).toBe(true);
    expect(fold?.lead.includes("palavra0 palavra1")).toBe(true);
  });

  test("opening with a list or code: the first line of prose, plain", () => {
    const list = ["- **Pool** em 20 de 20", ...Array.from({ length: 14 }, (_, i) => `- item ${i}`)].join("\n");
    expect(foldTalk(list, TALK_LINE_CHARS.web)?.lead).toBe("Pool em 20 de 20");
  });
});
