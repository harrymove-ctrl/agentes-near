import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Message, steerStore } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, comfortable, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  steerStore.reset();
});

const DM_ID = "00000000-0000-4000-8000-0000000000d1";
/** A person's message, `minutes` before now. */
const said = (id: string, body: string, minutes: number, over: Partial<Message> = {}) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    ...over,
  }) as Message;
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;
/** What a row lays out in its text's column: everything but what only screen readers get. */
const parts = (id: string) =>
  [...(row(id).querySelector(".ac-msg__body")?.children ?? [])]
    .filter((part) => !part.classList.contains("ac-visually-hidden"))
    .map((part) => part.className);

describe("a receipt never changes a message's height", () => {
  test("sent into a task at work: the mark where the check goes, the same parts as a message without it", async () => {
    const state = comfortable(seedState());
    const answering = {
      seenBy: [ADA_ID],
      pickedBy: [],
      handled: [{ agentId: ADA_ID, runId: "r1", status: "running" as const }],
    };
    state.messages = [
      said("s1", "Corrige o login.", 30, { receipts: answering }),
      said("j1", "Pode deixar.", 29.8, { author: { type: "person", id: "u-joao" } }),
      said("s2", "Olha também o refresh.", 29.5, { receipts: answering }),
      said("j2", "Bom dia.", 21, { author: { type: "person", id: "u-joao" } }),
      said("p1", "Bom dia.", 20),
      said("j3", "Sobre o quê?", 19.8, { author: { type: "person", id: "u-joao" } }),
      said("p2", "Sobre a reunião.", 19.5),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const steered = (messageId: string) => ({
      type: "agent.run.steered",
      channelId: ENG_ID,
      runId: "r1",
      agentId: ADA_ID,
      messageId,
    });
    await act(async () => {
      steerStore.apply(steered("s1"));
      steerStore.apply(steered("s2"));
      steerStore.apply({ type: "agent.run.read", channelId: ENG_ID, runId: "r1", agentId: ADA_ID, messageIds: ["s2"] });
    });
    await settle(4);
    // My own rows: the mark ends the time's line. Waiting for the next pause: the spinner.
    const waiting = row("s1").querySelector(".ac-msg__own-foot .ac-receipt__check");
    expect(waiting?.getAttribute("data-steer")).toBe("waiting");
    expect(waiting?.querySelector("canvas.ac-pixspin")).not.toBeNull();
    // Read: Ada's face, in the same place.
    const read = row("s2").querySelector(".ac-msg__own-foot .ac-receipt__check");
    expect(read?.getAttribute("data-steer")).toBe("read");
    expect(read?.querySelector(".ac-avatar")).not.toBeNull();
    // Nothing under the text: the same parts as the messages beside them that no task read.
    expect(parts("s1")).toEqual(parts("p1"));
    expect(parts("s2")).toEqual(parts("p2"));
    expect(document.querySelector(".msg-steer")).toBeNull();
  });

  test("while the author's plan picks who answers: the clock where the check goes, nothing under the text", async () => {
    const state = comfortable(seedState());
    state.messages = [said("k1", "Revisa o PR?", 2)];
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const socket = sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { channelId: ENG_ID, type: "message.routing", messageId: "k1", step: "plan" },
      }),
    );
    await settle(2);
    const clock = row("k1").querySelector(".ac-msg__own-foot .ac-receipt__check") as HTMLElement;
    expect(clock.getAttribute("aria-label")).toBe("Escolhendo quem responde");
    expect(clock.querySelector("path")?.getAttribute("d")).toBe("M10 6v4l2.6 1.8");
    expect(row("k1").querySelector(".ac-msg__foot")?.childNodes.length).toBe(0);
  });

  test("in a DM between people, who read my latest message is their face where its check goes, in a slot each turn's time line keeps", async () => {
    const state = comfortable(seedState());
    state.dms = [{ channelId: DM_ID, with: { type: "person", id: "u-joao", name: "João", handle: null } }];
    state.channelMembers[DM_ID] = [
      { type: "person", id: "u-walter" },
      { type: "person", id: "u-joao" },
    ];
    state.messages = [
      said("j1", "Me manda o relatório?", 4, { channelId: DM_ID, author: { type: "person", id: "u-joao" } }),
      said("d1", "Oi, João.", 3, { channelId: DM_ID }),
      said("d2", "Viu o relatório?", 2.5, { channelId: DM_ID }),
      said("d3", "Está no Drive.", 2, { channelId: DM_ID }),
    ];
    const api = createFakeApi(state);
    api.dms.reads = async () => [{ userId: "u-joao", lastReadAt: NOW.toISOString() }];
    await renderApp(`/org/${ORG_ID}/dm/person/u-joao`, { api });
    await settle(8);
    const seen = row("d3").querySelector(".ac-msg__own-foot .ac-receipt__seen");
    expect(seen).not.toBeNull();
    expect((seen as HTMLElement).querySelector(".ac-avatar")).not.toBeNull();
    // The turn's other bubbles have no time line, so no mark.
    expect(row("d2").className).toContain("ac-msg--grouped");
    for (const id of ["d1", "d2"]) expect(row(id).querySelector(".ac-receipt__seen")).toBeNull();
    // Not on João's: no face ever comes there.
    expect(row("j1").querySelector(".ac-receipt__seen")).toBeNull();
    // No line after it: the row ends the list as the one before it ends its own, but for the time a run's last bubble
    // has under it, face or not.
    expect(parts("d3").filter((part) => part !== "ac-msg__own-foot")).toEqual(parts("d2"));
    expect(screen().queryByText("Visto")).toBeNull();
    expect(document.querySelector(".channel__seen")).toBeNull();
    // I write again: the face leaves until João reads it, and a message still sending has its sending state in the
    // time line's place (the same box, so the row keeps its size when the time comes), and no face's slot yet.
    let release = () => {};
    state.holdPosts = new Promise<void>((r) => {
      release = r;
    });
    const composer = screen().getByRole("combobox", { name: /Mensagem para/ });
    await act(async () => fireEvent.change(composer, { target: { value: "Mais uma coisa." } }));
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    await settle(2);
    expect(row("d3").querySelector(".ac-receipt__seen .ac-avatar")).toBeNull();
    const sending = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Mais uma coisa.")) as HTMLElement;
    expect(sending.className).toContain("ac-msg--pending");
    expect(sending.querySelector(".ac-msg__own-foot > .ac-msg__status")?.textContent).toContain("enviando");
    expect(sending.querySelector(".ac-msg__own-foot .ac-receipt__seen")).toBeNull();
    await act(async () => release());
    await settle(2);
  });

  test("the face keeps the check's width and the name's line, and no stylesheet gives a receipt a line", () => {
    const css = (path: string) => readFileSync(join(import.meta.dir, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const kit = css("../../../packages/ui/src/styles/components.css");
    const app = css("../src/layout.css");
    const value = (sheet: string, selector: string, prop: string) =>
      [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
        .map((m) => new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(m[2] ?? "")?.[1]?.trim())
        .findLast(Boolean);
    const px = (v: string | undefined) => Number.parseFloat(v ?? "");
    // The check: a 16px icon with 2px each side. The action bar keeps its one place over it (components.test.tsx).
    const check = px(value(kit, ".ac-receipt__check .ac-icon", "width")) + 2 * 2;
    expect(value(kit, ".ac-receipt__check", "padding")).toBe("0 2px");
    expect(
      value(
        kit,
        ".ac-msg:has(> .ac-msg__body > .ac-msg__aside--floating:not(:empty)) > .ac-msg__body > .ac-msg__actions",
        "right",
      ),
    ).toBeUndefined();
    // The reader's face (18px) with 1px each side: the same 20px, and no taller than the name's line.
    const face = px(value(kit, ".ac-avatar--xs", "width"));
    expect(value(app, ".ac-receipt__check:has(> .ac-avatar)", "padding")).toBe("0 1px");
    expect(face + 2 * 1).toBe(check);
    // At every text size: the name's line is the tighter one, at its smallest on the smallest step.
    expect(value(kit, ".ac-msg__head", "line-height")).toBe("var(--msg-line-tight)");
    expect(px(value(kit, ".ac-avatar--xs", "height"))).toBeLessThanOrEqual(
      px(value(kit, '[data-text-size="xs"]', "--msg-line-tight")),
    );
    // A DM's face slot takes no width of its own: empty, it leaves the time on the bubble's edge.
    expect(value(app, ".ac-receipt__seen", "width")).toBeUndefined();
    expect(px(value(app, ".ac-receipt__seen", "height"))).toBe(16);
    // The mark ends the first line: right after the time in the name's line (never pushed to the row's far end), or
    // floated on a grouped message's text.
    expect(value(kit, ".ac-msg__head > .ac-msg__aside", "align-self")).toBe("center");
    expect(value(kit, ".ac-msg__aside", "margin-left")).toBeUndefined();
    expect(value(kit, ".ac-msg__aside--floating", "float")).toBe("right");
    // On my own rows it ends the time's line, no taller than the time, so it never adds a line either.
    expect(px(value(kit, ".ac-msg__own-foot > .ac-msg__aside", "height"))).toBe(16);
    expect(px(value(kit, ".ac-msg__own-time", "min-height"))).toBe(16);
    // No line of words under a message, nor a row after it, for a receipt.
    const src = join(import.meta.dir, "../src");
    const sheets = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
      );
    const all = sheets(src)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(all).not.toMatch(/\.(msg-steer|channel__seen)\b/);
  });
});

describe("its words stay reachable", () => {
  test("screen readers hear what became of it as it changes; the mark is named and opens the words", async () => {
    const state = comfortable(seedState());
    state.messages = [
      said("s1", "Olha também o refresh.", 2, {
        receipts: {
          seenBy: [ADA_ID],
          pickedBy: [],
          handled: [{ agentId: ADA_ID, runId: "r1", status: "running" }],
        },
      }),
      said("s2", "E o logout.", 30, { author: { type: "person", id: "u-joao" } }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(async () => {
      steerStore.apply({ type: "agent.run.steered", channelId: ENG_ID, runId: "r1", agentId: ADA_ID, messageId: "s1" });
      steerStore.apply({ type: "agent.run.steered", channelId: ENG_ID, runId: "r2", agentId: ADA_ID, messageId: "s2" });
    });
    await settle(4);
    const check = row("s1").querySelector(".ac-receipt__check") as HTMLElement;
    const live = row("s1").querySelector(".ac-msg__aside .ac-visually-hidden[aria-live='polite']") as HTMLElement;
    expect(live.textContent).toBe("Ada lê na próxima pausa");
    // The agents' words name the mark; what became of it in the task describes it.
    expect(check.getAttribute("aria-label")).toBe("Vista por Ada. Ada está respondendo");
    expect(check.getAttribute("aria-describedby")).toBe(live.id);
    await act(async () => {
      steerStore.apply({ type: "agent.run.read", channelId: ENG_ID, runId: "r1", agentId: ADA_ID, messageIds: ["s1"] });
    });
    await settle(2);
    expect(live.textContent).toBe("Ada leu");
    // A message no agent was asked about: the words name the mark itself.
    const alone = row("s2").querySelector(".ac-receipt__check") as HTMLElement;
    expect(alone.getAttribute("aria-label")).toBe("Ada lê na próxima pausa");
    expect(alone.hasAttribute("aria-describedby")).toBe(false);
    // From the keyboard too: a button that opens the agents and, under them, what became of it.
    expect(check.tagName).toBe("BUTTON");
    await act(async () => fireEvent.click(check));
    await settle(2);
    const popover = screen().getByRole("dialog", { name: "Agentes" });
    expect(within(popover).getByText("Respondendo")).toBeTruthy();
    expect(popover.querySelector(".who-by")?.textContent).toBe("Ada leu");
  });

  test("in a DM, who read it is a button that says it, from the keyboard or a tap, and to screen readers as it shows", async () => {
    const state = comfortable(seedState());
    state.dms = [{ channelId: DM_ID, with: { type: "person", id: "u-joao", name: "João", handle: null } }];
    state.channelMembers[DM_ID] = [
      { type: "person", id: "u-walter" },
      { type: "person", id: "u-joao" },
    ];
    state.messages = [said("d1", "Viu o relatório?", 2, { channelId: DM_ID })];
    const api = createFakeApi(state);
    api.dms.reads = async () => [{ userId: "u-joao", lastReadAt: NOW.toISOString() }];
    await renderApp(`/org/${ORG_ID}/dm/person/u-joao`, { api });
    await settle(8);
    // The slot is a polite live region that is there before the face, so the face coming in is said.
    const seen = row("d1").querySelector(".ac-msg__own-foot .ac-receipt__seen") as HTMLElement;
    expect(seen.getAttribute("aria-live")).toBe("polite");
    const face = within(seen).getByRole("button", { name: "Vista por João" });
    expect(face.querySelector(".ac-avatar")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => fireEvent.click(face));
    await settle(2);
    const popover = screen().getByRole("dialog", { name: "Vista por João" });
    expect(within(popover).getByText("Vista por João")).toBeTruthy();
  });
});

describe("an agent's message that mentions agents (ADR 0089)", () => {
  test("its mark lists whom it mentioned: one the judge read as no hand-off is 'Só mencionado', with 'Chamar um agente'", async () => {
    const state = comfortable(seedState());
    state.messages = [
      said("a1", "Valeu @ada, por agora basta.", 2, {
        author: { type: "agent", id: ATLAS_ID },
        mentionedAgentIds: [ADA_ID],
        agentRunId: "r-atlas",
        receipts: { seenBy: [ADA_ID], pickedBy: [], handled: [], blocked: [], referenced: [ADA_ID] },
      }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    // A mark, never "Nenhum agente vai responder": an agent's message waits for nobody.
    expect(row("a1").textContent).not.toContain("Nenhum agente vai responder");
    const check = row("a1").querySelector(".ac-receipt__check") as HTMLElement;
    await act(async () => fireEvent.click(check));
    await settle(2);
    const popover = screen().getByRole("dialog", { name: "Agentes" });
    expect(within(popover).getByText("Só mencionado")).toBeTruthy();
    expect(within(popover).getByRole("button", { name: "Chamar um agente" })).toBeTruthy();
  });
});

describe("an agent whose AI provider is down", () => {
  test("its run parked says so under the message, not that it waits for an answer", async () => {
    const state = comfortable(seedState());
    state.messages = [
      said("o1", "O build passou?", 2, {
        receipts: {
          seenBy: [ADA_ID],
          pickedBy: [ADA_ID],
          handled: [{ agentId: ADA_ID, runId: "r-outage", status: "waiting_input", outage: true }],
        },
      }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(row("o1").textContent).toContain("Ada: o provedor de IA está fora do ar · tenta de novo sozinho");
    expect(row("o1").textContent).not.toContain("esperando uma resposta");
  });
});

describe("an agent waiting on its plan's limit", () => {
  test("its run parked says so under the message, and its popover too, never that it waits for an answer", async () => {
    const state = comfortable(seedState());
    state.messages = [
      said("p1", "O build passou?", 2, {
        receipts: {
          seenBy: [ADA_ID],
          pickedBy: [ADA_ID],
          handled: [{ agentId: ADA_ID, runId: "r-plan", status: "waiting_input", usage: "plan" }],
          decidedBy: { step: "jev" },
        },
      }),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(row("p1").textContent).toContain("Ada está esperando o plano");
    expect(row("p1").textContent).not.toContain("esperando uma resposta");
    await act(async () => fireEvent.click(row("p1").querySelector(".ac-receipt__check") as HTMLElement));
    await settle(2);
    const popover = screen().getByRole("dialog", { name: "Agentes" });
    expect(within(popover).getByText("Esperando o plano")).toBeTruthy();
    expect(popover.textContent).not.toContain("Escolhido pelo Jev");
  });
});
