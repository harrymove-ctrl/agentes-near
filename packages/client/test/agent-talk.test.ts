import { expect, test } from "bun:test";
import { openableConsultation } from "../src/lib/consult-group";
import { forPeople, previewOf, withoutRelayLine } from "../src/lib/consultations";

test("only a real consultation id opens the conversation, not the stand-in for none", () => {
  expect(openableConsultation("8f0c1c0e-0000-4000-8000-000000000001")).toBe("8f0c1c0e-0000-4000-8000-000000000001");
  expect(openableConsultation("agent-1:failed")).toBeNull();
  expect(openableConsultation("")).toBeNull();
  expect(openableConsultation(undefined)).toBeNull();
});

const RELAYED =
  "[@caio mentioned you in a conversation, where you aren't a member, so it reaches you here]\n\nTheo, revisa o PR?";
const RELAYED_MEMBER =
  "[@caio mentioned you in #general for someone you answer only through other agents, so it reaches you here: answer it, not them]\n\nOi";

test("people never read the relay line the server writes for the agent", () => {
  expect(withoutRelayLine(RELAYED)).toBe("Theo, revisa o PR?");
  expect(withoutRelayLine(RELAYED_MEMBER)).toBe("Oi");
  expect(previewOf(RELAYED)).toBe("Theo, revisa o PR?");
  // Anything else stays as written, a bracket of its own too.
  expect(withoutRelayLine("[nota] fica")).toBe("[nota] fica");
  expect(withoutRelayLine("Veja: [@caio mentioned you in #x, so it reaches you here]")).toContain("mentioned you");
  const talk = forPeople({
    consultation: { id: "c1", question: RELAYED },
    messages: [
      { id: "m1", body: RELAYED },
      { id: "m2", body: "Feito." },
    ],
  });
  expect(talk.consultation).toEqual({ id: "c1", question: "Theo, revisa o PR?" });
  expect(talk.messages.map((m) => m.body)).toEqual(["Theo, revisa o PR?", "Feito."]);
});
