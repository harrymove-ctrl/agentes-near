import { describe, expect, test } from "bun:test";
import type { Agent } from "../src/api/types";
import { audienceWith, consultableLocked, offersConsultable } from "../src/lib/audience";
import { reachByAccess, reachHandoffs, reachKey, reachOf, reachOpens, routineReachWarnings } from "../src/lib/reach";

const agent = (id: string, handle: string, extra: Partial<Agent> = {}) => ({ id, handle, ...extra }) as Agent;
const gil = agent("a-gil", "gil", { canTalk: false, audience: { mode: "owner", userIds: [] } });
const ada = agent("a-ada", "ada", { canTalk: true, audience: { mode: "everyone", userIds: [] } });
const dev = agent("a-dev", "dev", { canTalk: false });

describe("routineReachWarnings", () => {
  test("the agents its creator can't talk to, never its own agent, nor an email", () => {
    const out = routineReachWarnings("Cobre o @gil e a @ada; avise gil@x.com e @dev", [gil, ada, dev], {
      agentId: dev.id,
    });
    expect(out.map((w) => w.agent.id)).toEqual(["a-gil"]);
  });
});

describe("reachOf", () => {
  test("keeps well formed entries only", () => {
    const entries = reachOf({
      reach: [{ agentId: "a", handle: "ivo", reason: "not_in_channel", consultationId: "c" }, { agentId: 1 }, null],
    });
    expect(entries.map((e) => e.handle)).toEqual(["ivo"]);
    expect(reachOf({})).toEqual([]);
  });

  test("old messages: a routine that only looked kept the agent out by its access", () => {
    const base = { agentId: "a", handle: "gil", reason: "routine_creator_reach" as const };
    expect(reachByAccess({ ...base, routine: { id: "r", name: "R", creatorUserId: "u", access: "read" } })).toBe(true);
    expect(reachByAccess({ ...base, routine: { id: "r", name: "R", creatorUserId: "u", access: "act" } })).toBe(false);
  });
});

describe("someone else's routine, being edited", () => {
  test("its creator's reach counts, not the editor's", () => {
    const owned = agent("a-gil", "gil", {
      canTalk: true,
      ownerUserId: "u-carla",
      audience: { mode: "people", userIds: ["u-bob"] },
    });
    const prompt = "Cobre o @gil";
    expect(routineReachWarnings(prompt, [owned], { agentId: null })).toEqual([]);
    expect(
      routineReachWarnings(prompt, [owned], { agentId: null, creatorUserId: "u-ana" }).map((w) => w.agent.id),
    ).toEqual(["a-gil"]);
    expect(routineReachWarnings(prompt, [owned], { agentId: null, creatorUserId: "u-bob" })).toEqual([]);
  });

  test("a role it answers: the creator's roles decide; unknown roles don't warn", () => {
    const support = agent("a-dev", "dev", {
      canTalk: true,
      ownerUserId: "u-carla",
      audience: { mode: "people", userIds: [], roleIds: ["r-sup"] },
    });
    const warned = (creatorRoleIds?: string[]) =>
      routineReachWarnings("Cobre o @dev", [support], { agentId: null, creatorUserId: "u-caio", creatorRoleIds }).map(
        (w) => w.agent.id,
      );
    expect(warned(["r-tec"])).toEqual(["a-dev"]);
    expect(warned([])).toEqual(["a-dev"]);
    expect(warned(["r-tec", "r-sup"])).toEqual([]);
    expect(warned(undefined)).toEqual([]);
  });
});

describe("audienceWith", () => {
  test("adds the person to its people, and never saves over a list it wasn't sent", () => {
    const owned = agent("a-gil", "gil", { audience: { mode: "people", userIds: ["u-bob"], roleIds: ["r-sup"] } });
    // Its roles stay picked.
    expect(audienceWith(owned, "u-ana")).toEqual({ mode: "people", userIds: ["u-bob", "u-ana"], roleIds: ["r-sup"] });
    expect(audienceWith(agent("a-x", "x", { audienceMode: "people" }), "u-ana")).toBeNull();
    expect(audienceWith(agent("a-y", "y", { audienceMode: "owner" }), "u-ana")).toEqual({
      mode: "people",
      userIds: ["u-ana"],
      roleIds: [],
    });
  });
});

describe("reachKey", () => {
  test("says which line each entry is", () => {
    const base = { agentId: "a", handle: "ivo", reason: "not_in_channel" as const };
    expect(reachKey({ ...base, consultationId: "c" })).toBe("reach.handed");
    expect(reachKey({ ...base, private: true })).toBe("reach.private");
    expect(reachKey({ ...base, noAi: true })).toBe("reach.noAi");
    expect(reachKey({ ...base, reason: "routine_creator_reach", routinePost: true })).toBe("reach.routinePost");
    expect(reachKey({ ...base, reason: "audience" })).toBe("reach.blocked");
  });
});

describe("reachOpens", () => {
  test("a hand-off opens beside the conversation; a private consultation for someone outside the audience doesn't", () => {
    const base = { agentId: "a", handle: "ivo", consultationId: "c" };
    expect(reachOpens({ ...base, reason: "not_in_channel" })).toBe(true);
    expect(reachOpens({ ...base, reason: "audience" })).toBe(false);
    expect(reachOpens({ agentId: "a", handle: "ivo", reason: "not_in_channel" })).toBe(false);
  });
});

describe("Outros agentes podem consultar", () => {
  test("offered when someone is left out, never on a plan answering only its owner", () => {
    const owner = { mode: "owner" as const, userIds: [] };
    expect(offersConsultable(owner, false)).toBe(true);
    expect(offersConsultable(owner, true)).toBe(false);
    expect(offersConsultable({ mode: "people", userIds: ["u"] }, true)).toBe(true);
    expect(offersConsultable({ mode: "everyone", userIds: [] }, false)).toBe(false);
  });

  test("on a plan, once off, only its owner turns it back on", () => {
    const off = { mode: "people" as const, userIds: [], consultable: false };
    expect(consultableLocked(off, { owner: false, onPlan: true })).toBe(true);
    expect(consultableLocked(off, { owner: true, onPlan: true })).toBe(false);
    expect(consultableLocked(off, { owner: false, onPlan: false })).toBe(false);
    expect(consultableLocked({ ...off, consultable: true }, { owner: false, onPlan: true })).toBe(false);
  });
});

test("reachHandoffs: the hand-offs by direct message its reach lines show, not a private consult or a blocked one", () => {
  const meta = {
    reach: [
      { agentId: "a", handle: "a", reason: "not_in_channel", consultationId: "c1" },
      { agentId: "b", handle: "b", reason: "audience", consultationId: "c2" },
      { agentId: "c", handle: "c", reason: "audience" },
    ],
  };
  expect([...reachHandoffs(meta)]).toEqual(["c1"]);
  expect(reachHandoffs(undefined).size).toBe(0);
});
