import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const LEAD = "Olhei o servidor e o banco: o pool está esgotado desde o deploy do v2.41.";
const LAST = "A correção é no código do v2.41, onde o carrinho abre conexão por item.";
const LONG = [
  LEAD,
  "",
  "O que vi:",
  "",
  "- Deploy do v2.41 às 18h02; na infra nada mudou.",
  "- O pool está em 20 de 20 desde as 18h10 e não desce.",
  "- 312 conexões em espera no pico; antes do deploy, nunca passou de 4.",
  "- A p95 do checkout foi de 180 ms para 1,4 s.",
  "- CPU e memória do banco longe do limite.",
  "",
  "```sql",
  "SELECT client_addr, state FROM pg_stat_activity",
  "WHERE application_name = 'checkout';",
  "```",
  "",
  "Os 5 primeiros estão em idle in transaction há mais de 40 min.",
  "",
  LAST,
].join("\n");

/** Ada's long message in #eng: to Atlas (her run answered his message) or, with `toAgent` off, to people. */
async function open(toAgent: boolean) {
  const state = seedState();
  state.messages.push({
    id: "msg-long",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: LONG,
    mentionedAgentIds: [],
    agentRunId: "r-ada",
    meta: toAgent ? { toAgent: ATLAS_ID } : {},
    createdAt: ago(30),
  });
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const row = screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(LEAD)) as HTMLElement;
  return { ...r, row };
}

describe("a long message from one agent to another", () => {
  test("its first paragraph and 'Ler tudo · mais N linhas', which opens it whole in its thread beside the chat", async () => {
    const { row } = await open(true);
    expect(row.textContent).not.toContain(LAST);
    const more = within(row).getByRole("button", { name: /Ler tudo/ });
    expect(more.textContent).toMatch(/mais \d+ linhas/);
    await act(async () => fireEvent.click(more));
    await settle(4);
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(panel.textContent).toContain(LAST);
    expect(more.getAttribute("aria-pressed")).toBe("true");
  });

  test("a message to people stays whole", async () => {
    const { row } = await open(false);
    expect(row.textContent).toContain(LAST);
    expect(within(row).queryByRole("button", { name: /Ler tudo/ })).toBeNull();
  });
});
