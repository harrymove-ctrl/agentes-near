import { describe, expect, test } from "bun:test";
import {
  agentIntro,
  composerSuggestions,
  firstAskKind,
  firstAsks,
  isNewAgent,
  mentionsCodeChange,
  personNamed,
  plainWhat,
} from "../../src/features/chat/intent";
import { agent, message } from "./fixtures";

const people = [
  { id: "me", name: "Walter Nogueira" },
  { id: "u2", name: "Caio Souza" },
  { id: "u3", name: "Ana" },
];
const theo = (over: Parameters<typeof message>[0]) =>
  message({ author: { type: "agent", id: "a1" }, agentRunId: "r1", ...over });
const keys = (list: { key: string }[]) => list.map((s) => s.key);

describe("composer suggestions", () => {
  test("after a code change: merge, review by the person the agent named, see the change", () => {
    const list = composerSuggestions({
      messages: [
        message({ id: "m1", author: { type: "person", id: "me" }, body: "O login quebrou" }),
        theo({ id: "m2", body: "Abri o PR #128. Faço o merge ou espera o Caio revisar?" }),
      ],
      meId: "me",
      people,
    });
    expect(keys(list)).toEqual(["merge", "review", "seeChange"]);
    expect(list[1]?.values).toEqual({ name: "Caio" });
  });

  test("a code change without a named person leaves the review out", () => {
    const list = composerSuggestions({
      messages: [theo({ id: "m2", body: "Pull request aberto: github.com/acme/app/pull/12" })],
      meId: "me",
      people,
    });
    expect(keys(list)).toEqual(["merge", "seeChange"]);
  });

  test("never suggests a review by me", () => {
    expect(personNamed("O Walter pode revisar", people, "me")).toBeNull();
    expect(personNamed("a ana revisa", people, "me")?.id).toBe("u3");
    expect(personNamed("Anabela revisa", people, "me")).toBeNull();
  });

  test("after a file: summarize and the next step", () => {
    const list = composerSuggestions({
      messages: [
        theo({ id: "m2", body: "Pronto, segue a pesquisa.", meta: { artifacts: [{ id: "f1", version: 1 }] } }),
      ],
      meId: "me",
      people,
    });
    expect(keys(list)).toEqual(["summarize", "nextStep"]);
  });

  test("a removed file suggests nothing", () => {
    const list = composerSuggestions({
      messages: [theo({ id: "m2", body: "Segue.", meta: { artifacts: [{ id: "f1", deleted: true, title: "x" }] } })],
      meId: "me",
      people,
    });
    expect(list).toEqual([]);
  });

  test("nothing while the latest is a person's, an approval, an open question or a plain reply", () => {
    const base = { meId: "me", people };
    expect(
      composerSuggestions({
        ...base,
        messages: [
          theo({ id: "m1", body: "Abri o PR #128" }),
          message({ id: "m2", author: { type: "person", id: "me" }, body: "Pode fazer o merge" }),
        ],
      }),
    ).toEqual([]);
    expect(
      composerSuggestions({ ...base, messages: [theo({ id: "m1", body: "merge", meta: { approvalId: "ap1" } })] }),
    ).toEqual([]);
    expect(
      composerSuggestions({
        ...base,
        messages: [
          theo({
            id: "m1",
            body: "Faço o merge agora?",
            meta: { question: { id: "q1", agentId: "a1", text: "Faço o merge agora?", status: "open" } },
          }),
        ],
      }),
    ).toEqual([]);
    expect(composerSuggestions({ ...base, messages: [theo({ id: "m1", body: "Bom dia, tudo certo." })] })).toEqual([]);
    expect(composerSuggestions({ ...base, messages: [] })).toEqual([]);
  });

  test("a message still sending doesn't count as the latest", () => {
    const list = composerSuggestions({
      meId: "me",
      people,
      messages: [
        theo({ id: "m1", body: "Abri o PR #3" }),
        message({ id: "local-1", author: { type: "person", id: "me" }, body: "…", local: "failed" }),
      ],
    });
    expect(keys(list)).toEqual(["merge", "seeChange"]);
  });

  test("what counts as a code change", () => {
    expect(mentionsCodeChange("Abri o PR #128")).toBe(true);
    expect(mentionsCodeChange("o pull request está pronto")).toBe(true);
    expect(mentionsCodeChange("Fiz o merge")).toBe(true);
    expect(mentionsCodeChange("Preciso de um prazo")).toBe(false);
    expect(mentionsCodeChange("Esse é o principal problema")).toBe(false);
  });
});

describe("first conversation with an agent", () => {
  test("introduces itself with what it does, in one plain sentence", () => {
    expect(plainWhat("Responder os clientes no e-mail e me chamar quando for urgente")).toBe(
      "Responder os clientes no e-mail e me chamar quando for urgente.",
    );
    expect(plainWhat("# Função\n- cuida do código do app. Usa o GitHub.")).toBe("Cuida do código do app.");
    expect(plainWhat("Pesquisa mercado!")).toBe("Pesquisa mercado.");
  });

  test("a prompt, too short or too long is not an introduction", () => {
    expect(plainWhat("Você é a Lu, uma agente de atendimento.")).toBeNull();
    expect(plainWhat("You are a helpful assistant.")).toBeNull();
    expect(plainWhat("oi")).toBeNull();
    expect(plainWhat("a".repeat(200))).toBeNull();
    expect(plainWhat("")).toBeNull();
  });

  test("falls back to the role, then nothing", () => {
    expect(agentIntro({ role: "Dev", instructions: "You are a coder." })).toEqual({ kind: "role", role: "Dev" });
    expect(agentIntro({ role: " ", instructions: "" })).toEqual({ kind: "none" });
    expect(agentIntro({ role: "Dev", instructions: "Cuida do código do app e do site" })).toEqual({
      kind: "what",
      text: "Cuida do código do app e do site.",
    });
  });

  test("first requests follow what it does (role first, then instructions)", () => {
    expect(firstAskKind({ role: "Atendimento", instructions: "" })).toBe("support");
    expect(firstAskKind({ role: "", instructions: "Responde os clientes no e-mail" })).toBe("support");
    expect(firstAskKind({ role: "Dev", instructions: "Responde clientes" })).toBe("dev");
    expect(firstAskKind({ role: "Operações", instructions: "" })).toBe("ops");
    expect(firstAskKind({ role: "", instructions: "Pesquisa mercado e concorrentes" })).toBe("research");
    expect(firstAskKind({ role: "", instructions: "Escrever relatórios da semana" })).toBe("writing");
    expect(firstAskKind({ role: "QA", instructions: "" })).toBe("qa");
    expect(firstAskKind({ role: "PM", instructions: "" })).toBe("product");
    expect(firstAskKind({ role: "", instructions: "Cuida das vendas" })).toBe("sales");
    expect(firstAskKind({ role: "", instructions: "Ajuda no dia a dia" })).toBe("general");
    expect(firstAsks(agent({ id: "a", name: "Lu", role: "Atendimento" })).map((a) => a.key)).toEqual([
      "support.how",
      "support.task",
      "support.routine",
    ]);
  });

  test("new in the team for two weeks", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    expect(isNewAgent("2026-10-17T12:00:00Z", now)).toBe(true);
    expect(isNewAgent("2026-09-01T12:00:00Z", now)).toBe(false);
  });
});
