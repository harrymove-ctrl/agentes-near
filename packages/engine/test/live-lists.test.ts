import { afterEach, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import {
  createArtifact,
  createCalendarEvent,
  createIssue,
  createRoutine,
  deleteArtifact,
  deleteCalendarEvent,
  deleteRoutine,
  openPersonAgentDm,
  restoreArtifact,
  updateCalendarEvent,
  updateIssue,
  updateRoutine,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** The ids-free broadcasts the org's topic carried, by name (`artifacts.changed`…). */
function broadcasts() {
  const heard: string[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e: RealtimeEvent) => {
    const inner = (e as { event?: { type?: unknown } }).event;
    if (e.type === "org.broadcast" && typeof inner?.type === "string") heard.push(inner.type);
  });
  return heard;
}

test("the Drive hears a file saved, deleted and restored, with no channel open", async () => {
  f = await setup();
  const heard = broadcasts();
  const file = await createArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
    title: "Plano",
    content: { kind: "document", markdown: "# Plano" },
  });
  expect(heard.filter((t) => t === "artifacts.changed")).toHaveLength(1);
  await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
  await restoreArtifact(f.artifactDeps, f.owner.id, f.org.id, file.id);
  expect(heard.filter((t) => t === "artifacts.changed")).toHaveLength(3);
});

test("the calendar hears an event made, moved and deleted, also one with no channel", async () => {
  f = await setup();
  const heard = broadcasts();
  const deps = { db: f.db, pubsub: f.pubsub };
  const event = await createCalendarEvent(deps, f.owner.id, f.org.id, {
    title: "Planejamento",
    start: "2026-11-20T13:00:00Z",
    end: "2026-11-20T14:00:00Z",
    recurrence: "none",
    participants: [],
  });
  await updateCalendarEvent(deps, f.owner.id, f.org.id, event.id, { title: "Planejamento do mês" });
  await deleteCalendarEvent(deps, f.owner.id, f.org.id, event.id);
  expect(heard.filter((t) => t === "calendar.changed")).toHaveLength(3);
});

test("Rotinas hears a routine made, changed and deleted", async () => {
  f = await setup();
  const heard = broadcasts();
  const deps = { db: f.db, pubsub: f.pubsub, context: f.context };
  const routine = await createRoutine(deps, f.owner.id, f.org.id, {
    agentId: f.agent.id,
    prompt: "Resuma o dia no canal.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "schedule", phrase: "dias úteis às 9h" },
  });
  await updateRoutine(deps, f.owner.id, f.org.id, routine.id, { prompt: "Resuma a semana no canal." });
  await deleteRoutine(deps, f.owner.id, f.org.id, routine.id);
  expect(heard.filter((t) => t === "routines.changed")).toHaveLength(3);
});

test("a task tied to my DM with an agent reaches my board, though I'm no admin; nobody else's", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
  const toBia: string[] = [];
  const toCaio: string[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, bia.id), (e: RealtimeEvent) => toBia.push(e.type));
  f.pubsub.subscribe(userTopic(f.org.id, caio.id), (e: RealtimeEvent) => toCaio.push(e.type));
  const deps = { db: f.db, pubsub: f.pubsub };
  const task = await createIssue(deps, { type: "person", userId: bia.id }, f.org.id, {
    title: "Fechar a folha",
    channelId: dm.id,
  });
  await updateIssue(deps, { type: "person", userId: bia.id }, f.org.id, task.id, { status: "in_progress" });
  expect(toBia).toEqual(expect.arrayContaining(["issue.created", "issue.updated"]));
  expect(toCaio.filter((t) => t.startsWith("issue."))).toEqual([]);
});
