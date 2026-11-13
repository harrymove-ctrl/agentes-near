import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, MissionCommand } from "@agenteschat/client";
import { machineTaskOf, missionAutoApprovedOf, missionCommandOf } from "@agenteschat/client/lib/missions";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { commandApprovalOptions } from "@/components/missions/MissionBits";
import { AutoApprovedLine, groupAutoApproved } from "@/components/missions/MissionCards";
import { BlockedCommands, MissionCommandCard, ruleText } from "@/components/missions/MissionCommandCard";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function withCommand() {
  const state = seedState();
  const api = createFakeApi(state);
  const mission = await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "Fotos", channelId: ENG_ID });
  const command: MissionCommand = {
    id: "00000000-0000-4000-8000-00000000cc01",
    missionId: mission.id,
    taskId: "00000000-0000-4000-8000-00000000aa01",
    tool: "Bash",
    command: "swift build -c release",
    state: "pending",
    rules: ["Bash(swift build *)"],
    decidedBy: null,
    decidedAt: null,
    always: false,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const decided: string[] = [];
  api.missions.commands = async () => ({ commands: [{ ...command }], rules: [] });
  api.missions.decideCommand = async (_org, _mission, _id, decision) => {
    decided.push(decision);
    Object.assign(command, {
      state: decision === "deny" ? "denied" : "allowed",
      always: decision === "always",
      forAgent: decision === "agent",
    });
    return { ...command };
  };
  return { api, mission, command, decided, state };
}

describe("command approvals", () => {
  test("the card shows the command and Aprovar / Recusar / Aprovar sempre; answering says who and when", async () => {
    const { api, mission, command, decided } = await withCommand();
    await renderPage(
      <MissionCommandCard
        command={{
          id: command.id,
          missionId: mission.id,
          taskId: command.taskId,
          tool: "Bash",
          command: command.command,
        }}
      />,
      { api, org: true },
    );
    await settle(6);
    const card = screen().getByRole("region", { name: "Claude Code pede para rodar um comando" });
    expect(card.textContent).toContain("swift build -c release");
    // What it covers is the button's tip: no line of its own under the buttons.
    expect(card.textContent).not.toContain("Aprovar sempre libera");
    expect(
      within(card).getByRole("button", { name: "Aprovar sempre nesta missão" }).getAttribute("aria-description"),
    ).toContain("Aprovar sempre libera swift build …");
    expect(within(card).getByRole("button", { name: "Recusar" })).toBeTruthy();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aprovar sempre nesta missão" })));
    await settle(6);
    expect(decided).toEqual(["always"]);
    expect(card.textContent).toContain("Liberado nesta missão");
    expect(within(card).queryByRole("button", { name: "Recusar" })).toBeNull();
  });

  test("Aprovar sempre para este agente keeps the command's kind for the agent, said on the card", async () => {
    const { api, mission, command, decided } = await withCommand();
    Object.assign(command, { command: "gh issue create --title x", agentKind: "gh issue create" });
    await renderPage(
      <MissionCommandCard
        command={{
          id: command.id,
          missionId: mission.id,
          taskId: command.taskId,
          tool: "Bash",
          command: command.command,
        }}
      />,
      { api, org: true },
    );
    await settle(6);
    const card = screen().getByRole("region", { name: "Claude Code pede para rodar um comando" });
    expect(card.textContent).not.toContain("com quaisquer argumentos");
    expect(
      within(card).getByRole("button", { name: "Aprovar sempre para este agente" }).getAttribute("aria-description"),
    ).toContain("libera gh issue create com quaisquer argumentos");
    await act(async () =>
      fireEvent.click(within(card).getByRole("button", { name: "Aprovar sempre para este agente" })),
    );
    await settle(6);
    expect(decided).toEqual(["agent"]);
    expect(card.textContent).toContain("Liberado para este agente");
  });

  const blockedList = [
    { tool: "Bash", command: "zsh /Users/w/work/t-conteudo/search2.sh" },
    { tool: "Bash", command: "python3 -P -E geo.py > geo.out" },
    { tool: "Bash", command: `python3 - <<'EOF'\nimport PIL\nprint(PIL.__version__)\nEOF` },
    { tool: "Read", command: "/Users/w/app/.agentes/notes.md" },
  ];

  test("a task's blocked commands: one line, the list in the details dialog grouped by first word", async () => {
    const { api, mission } = await withCommand();
    await api.missions.control(ORG_ID, mission.id, "start");
    await renderPage(
      <BlockedCommands missionId={mission.id} taskId="00000000-0000-4000-8000-00000000aa01" blocked={blockedList} />,
      { api, org: true },
    );
    await settle(6);
    // Never the raw commands inline in the thread.
    expect(document.body.textContent).toContain("4 comandos bloqueados");
    expect(document.body.textContent).not.toContain("geo.py");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ver" })));
    const dialog = screen().getByRole("dialog", { name: "4 comandos bloqueados" });
    const python = within(dialog).getByRole("region", { name: "python3" });
    expect(python.querySelector(".ac-countchip")?.textContent).toBe("2");
    expect(within(dialog).getByRole("region", { name: "zsh" })).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "Read" }).textContent).toContain(
      "Read /Users/w/app/.agentes/notes.md",
    );
    // Long and multi-line commands are cut to two lines with "Mostrar tudo".
    expect(within(python).getAllByRole("button", { name: "Mostrar tudo" })).toHaveLength(1);
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(4);
  });

  test("Liberar selecionados e continuar: the picked commands in one call, then the line says it resumes", async () => {
    const { api, mission, state } = await withCommand();
    await api.missions.control(ORG_ID, mission.id, "start");
    await renderPage(
      <BlockedCommands missionId={mission.id} taskId="00000000-0000-4000-8000-00000000aa02" blocked={blockedList} />,
      { api, org: true },
    );
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ver" })));
    const dialog = screen().getByRole("dialog", { name: "4 comandos bloqueados" });
    await act(async () => fireEvent.click(within(dialog).getByRole("checkbox", { name: /^Liberar zsh/ })));
    await act(async () =>
      fireEvent.click(within(dialog).getByRole("button", { name: "Liberar selecionados e continuar" })),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "missions.retryCommand")?.args[2]).toEqual({
      taskId: "00000000-0000-4000-8000-00000000aa02",
      commands: [blockedList[1]?.command, blockedList[2]?.command, blockedList[3]?.command],
    });
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".mi-cmd-blocked")?.textContent).toContain(
      "3 comandos liberados · retomando a sessão",
    );
  });

  test("a paused mission says why it can't continue, before anyone clicks", async () => {
    const { api, mission } = await withCommand();
    await api.missions.control(ORG_ID, mission.id, "start");
    await api.missions.control(ORG_ID, mission.id, "pause");
    await renderPage(
      <BlockedCommands missionId={mission.id} taskId="00000000-0000-4000-8000-00000000aa03" blocked={blockedList} />,
      { api, org: true },
    );
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ver" })));
    const dialog = screen().getByRole("dialog", { name: "4 comandos bloqueados" });
    expect(dialog.textContent).toContain("A missão está pausada");
    expect(
      within(dialog).getByRole("button", { name: "Liberar selecionados e continuar" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("meta readers and rule text", () => {
    expect(
      missionCommandOf({ missionCommand: { id: "c1", missionId: "m1", taskId: "t1", tool: "Bash", command: "ls" } }),
    ).toEqual({ id: "c1", missionId: "m1", taskId: "t1", tool: "Bash", command: "ls" });
    expect(missionCommandOf({})).toBeNull();
    expect(
      machineTaskOf({ machineTask: { id: "t1", blocked: [{ tool: "Bash", command: "git init" }, { x: 1 }] } })?.blocked,
    ).toEqual([{ tool: "Bash", command: "git init" }]);
    expect(ruleText("Bash(swift build *)")).toBe("swift build …");
    expect(ruleText("WebFetch(domain:x.dev)")).toBe("x.dev");
  });

  const autoMessage = (id: string, missionId: string, command: string, at: number, reason = "low_risk"): Message => ({
    id,
    channelId: ENG_ID,
    threadId: "root",
    author: { type: "agent", id: ADA_ID },
    body: `Allowed automatically: ${command}`,
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {
      missionAutoApproved: { missionId, taskId: "t1", tool: "Bash", command, reason },
      bodyCode: "mission_auto_approved",
    },
    createdAt: new Date(at).toISOString(),
  });

  test("a command allowed automatically (low risk): one quiet line with the command and Revogar (back to asking for every one)", async () => {
    const { api, mission, state } = await withCommand();
    expect(mission.commandApproval).toBe("low_risk_auto");
    await renderPage(
      <AutoApprovedLine messages={[autoMessage("a1", mission.id, "swift build -c release", Date.now())]} />,
      {
        api,
        org: true,
      },
    );
    await settle(6);
    const line = document.querySelector(".mi-evt--auto") as HTMLElement;
    expect(line.textContent).toContain("Aprovado automaticamente:");
    expect(line.querySelector("code")?.textContent).toBe("swift build -c release");
    expect(line.textContent).toContain("baixo risco");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Revogar" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "missions.setCommandApproval")?.args[2]).toBe("always");
    expect(within(line).queryByRole("button", { name: "Revogar" })).toBeNull();
  });

  test("several within a minute: one line ('3 comandos', Ver comandos); a gap starts a new line", async () => {
    const { api, mission } = await withCommand();
    const t0 = Date.now() - 120_000;
    const list = [
      autoMessage("a1", mission.id, "swift build", t0),
      autoMessage("a2", mission.id, "swift test", t0 + 20_000),
      autoMessage("a3", mission.id, "make lint", t0 + 50_000),
      autoMessage("a4", mission.id, "make docs", t0 + 90_000),
    ];
    const { groups, hidden } = groupAutoApproved(list);
    expect([...groups.keys()]).toEqual(["a1", "a4"]);
    expect(groups.get("a1")?.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect([...hidden]).toEqual(["a2", "a3"]);
    expect(missionAutoApprovedOf(list[0]?.meta ?? {})).toMatchObject({ command: "swift build", reason: "low_risk" });
    expect(missionAutoApprovedOf({})).toBeNull();
    await renderPage(<AutoApprovedLine messages={groups.get("a1") ?? []} />, { api, org: true });
    await settle(6);
    const line = document.querySelector(".mi-evt--auto") as HTMLElement;
    expect(line.textContent).toContain("3 comandos");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Ver comandos" })));
    expect([...line.querySelectorAll("li code")].map((c) => c.textContent)).toEqual([
      "swift build",
      "swift test",
      "make lint",
    ]);
  });

  test("Autonomia: the three options, from asking the most to asking nothing, in plain words", () => {
    expect(commandApprovalOptions(createI18n("pt-BR").t).map((o) => o.label)).toEqual([
      "Pergunta sempre",
      "Só o que é arriscado",
      "Não pergunta",
    ]);
    expect(commandApprovalOptions(createI18n("en").t).map((o) => o.value)).toEqual([
      "always",
      "low_risk_auto",
      "never",
    ]);
  });
});
