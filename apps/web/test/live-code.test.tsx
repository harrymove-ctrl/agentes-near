import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Run, RunStep } from "@agenteschat/client";
import { appendOutput, applyChannelEvent, emptyStreams, runsInChannel } from "@agenteschat/client";
import { workFromSteps } from "@agenteschat/client/lib/work";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { tokenizeCode } from "@/components/LiveCode";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

describe("code the agent runs", () => {
  test("light tokens: comments, strings, numbers, keywords", () => {
    const src = ["import csv  # lê", 'print("oi", 42)'].join("\n");
    expect(tokenizeCode(src).map((t) => [t.kind, t.text])).toEqual([
      ["keyword", "import"],
      ["text", " csv  "],
      ["comment", "# lê"],
      ["text", "\nprint("],
      ["string", '"oi"'],
      ["text", ", "],
      ["number", "42"],
      ["text", ")"],
    ]);
    const loop = ['x = "a"', "for i in range(3): pass"].join("\n");
    expect(
      tokenizeCode(loop)
        .filter((t) => t.kind !== "text")
        .map((t) => t.text),
    ).toEqual(['"a"', "for", "in", "3", "pass"]);
  });

  test("output: same stream merges; the newest characters stay under the limit", () => {
    let out = appendOutput([], { stream: "stdout", text: "a" });
    out = appendOutput(out, { stream: "stdout", text: "b" });
    out = appendOutput(out, { stream: "stderr", text: "erro" });
    expect(out).toEqual([
      { stream: "stdout", text: "ab" },
      { stream: "stderr", text: "erro" },
    ]);
    expect(appendOutput(out, { stream: "stderr", text: "!!" }, 4)).toEqual([{ stream: "stderr", text: "ro!!" }]);
  });

  test("agent.tool carries the code; agent.tool.output streams into the run; a new call starts fresh", () => {
    const base = { channelId: "c", threadId: "t", agentId: "theo", runId: "r" };
    let s = applyChannelEvent(emptyStreams, {
      type: "agent.tool",
      ...base,
      tool: "run_code",
      code: { language: "python", source: "print(1)" },
    });
    s = applyChannelEvent(s, { type: "agent.tool.output", ...base, stream: "stdout", text: "1\n" });
    expect(runsInChannel(s, "c")[0]?.code?.source).toBe("print(1)");
    expect(runsInChannel(s, "c")[0]?.output).toEqual([{ stream: "stdout", text: "1\n" }]);
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: null });
    expect(runsInChannel(s, "c")[0]?.code?.source).toBe("print(1)");
    s = applyChannelEvent(s, { type: "agent.tool", ...base, tool: "create_issue" });
    expect(runsInChannel(s, "c")[0]?.code).toBeNull();
    expect(runsInChannel(s, "c")[0]?.output).toEqual([]);
  });

  test("the activity bar: 'Ver código da Ada' opens the code and the live output (stderr in the danger tone)", async () => {
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: null, runId: "r-code", agentId: ADA_ID };
    await ev({ type: "agent.run", ...run, status: "running" });
    await ev({ type: "agent.tool", ...run, tool: "run_code", code: { language: "python", source: "import csv" } });
    await ev({ type: "agent.tool.output", ...run, stream: "stdout", text: "lendo 48 linhas\n" });
    await ev({ type: "agent.tool.output", ...run, stream: "stderr", text: "aviso: coluna vazia" });
    await settle(3);
    expect(document.querySelector(".ac-typing__text")?.textContent).toStartWith("Ada ");
    await click(screen().getByRole("button", { name: "Ver código da Ada" }));
    const panel = document.querySelector(".live-code") as HTMLElement;
    expect(within(panel).getByLabelText("Código (python)").textContent).toBe("import csv");
    const out = within(panel).getByLabelText("Saída");
    expect(out.querySelector(".live-code__stdout")?.textContent).toBe("lendo 48 linhas\n");
    expect(out.querySelector(".live-code__stderr")?.textContent).toBe("aviso: coluna vazia");
    expect(within(panel).getByRole("button", { name: "Copiar" })).toBeTruthy();
  });

  test("the work summary shows the code and output after the fact", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 22, 9, s)).toISOString();
    const steps: RunStep[] = [
      {
        seq: 1,
        kind: "tool_call",
        data: { toolUseId: "t1", name: "run_code", input: { code: "print(2)" } },
        createdAt: at(0),
      },
      { seq: 2, kind: "tool_result", data: { toolUseId: "t1", isError: false, content: "2\n" }, createdAt: at(2) },
    ];
    const w = workFromSteps(steps, { createdAt: at(0), finishedAt: at(3) } as Pick<Run, "createdAt" | "finishedAt">);
    expect(w.steps[0]?.code).toEqual({ language: "python", source: "print(2)" });
    expect(w.steps[0]?.output).toEqual([{ stream: "stdout", text: "2\n" }]);
  });
});
