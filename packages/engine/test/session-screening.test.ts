import { afterEach, expect, test } from "bun:test";
import {
  DESKTOP_TEXT_PROTOCOL,
  type MachineReplies,
  type MachineRequest,
  type StreamRequest,
} from "@agenteschat/adapters";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import {
  createSessionScreening,
  enableOperatorEvents,
  MachineRequestError,
  type MachineStatus,
  SESSION_KEEP_MS,
  SESSION_SCREEN_MS,
  SESSION_SEGMENT_MAX_BYTES,
  SESSION_SEGMENT_MS,
  type Stream,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  enableOperatorEvents(false);
  await f?.close();
  f = undefined;
});

const MACHINE = "0199a3a0-0000-7000-8000-00000000000a";
/** Made up for these tests: it must never reach a table, a log line or an event. */
const SECRET_TEXT = "Banco Sintético 0001 · login de teste";
const CONTROL: StreamRequest = { kind: "desktop", mode: "control" };
const WATCH: StreamRequest = { kind: "desktop", mode: "watch" };

/** The clock and the timer the screening runs on: `advance` runs what falls due, in order, awaiting each. */
function fakeTime() {
  let at = Date.parse("2026-10-27T12:00:00.000Z");
  const due: { at: number; run: () => Promise<void>; gone: boolean }[] = [];
  return {
    now: () => at,
    later: (ms: number, run: () => Promise<void>) => {
      const timer = { at: at + ms, run, gone: false };
      due.push(timer);
      return () => {
        timer.gone = true;
      };
    },
    async advance(ms: number) {
      const end = at + ms;
      for (;;) {
        const next = due.filter((t) => !t.gone && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.gone = true;
        at = next.at;
        await next.run();
      }
      at = end;
    },
  };
}

/** A computer that answers `desktop.text` with what `answers` gives, one call after another. */
function fakeHub(protocol = DESKTOP_TEXT_PROTOCOL) {
  const calls: MachineRequest[] = [];
  let answers: (MachineReplies["desktop.text"] | Error)[] = [];
  const hub = {
    async call(_machineId: string, request: MachineRequest) {
      calls.push(request);
      const next = answers.shift() ?? { same: true };
      if (next instanceof Error) throw next;
      return next;
    },
    async status(id: string) {
      return { id, protocol, online: true } as MachineStatus;
    },
  };
  return {
    hub: hub as unknown as Parameters<typeof createSessionScreening>[0]["hub"],
    calls,
    answer(...next: (string | MachineReplies["desktop.text"] | Error)[]) {
      answers = next.map((a) => (typeof a === "string" ? { text: a } : a));
    },
  };
}

async function screening(o: { protocol?: number } = {}) {
  f = await setup();
  enableOperatorEvents();
  const time = fakeTime();
  const machine = fakeHub(o.protocol);
  const logged: { message: string; data?: Record<string, unknown> }[] = [];
  const s = createSessionScreening({
    db: f.db,
    hub: machine.hub,
    log: { warn: (message, data) => logged.push({ message, data }) },
    now: time.now,
    later: time.later,
  });
  let n = 0;
  const stream = (request: StreamRequest = CONTROL): Stream =>
    ({
      id: `stream-${++n}`,
      userId: f?.owner.id,
      orgId: f?.org.id,
      agentId: f?.agent.id,
      request,
      machineId: MACHINE,
      closed: false,
    }) as unknown as Stream;
  const fx = f;
  const events = async () =>
    fx.db
      .select()
      .from(schema.operatorEvents)
      .where(eq(schema.operatorEvents.type, "desktop_control.ended"))
      .orderBy(schema.operatorEvents.createdAt);
  return { f: fx, s, time, machine, logged, stream, events };
}

test("a control stream reads the screen every 30 s as its agent; a watch stream is never read", async () => {
  const t = await screening();
  const control = t.stream();
  await t.s.ready(t.stream(WATCH));
  await t.s.ready(control);
  t.machine.answer("one", "two");
  await t.time.advance(SESSION_SCREEN_MS - 1);
  expect(t.machine.calls).toEqual([]);
  await t.time.advance(1);
  await t.time.advance(SESSION_SCREEN_MS);
  expect(t.machine.calls).toEqual([
    { op: "desktop.text", agent: { id: t.f.agent.id, handle: t.f.agent.handle, name: t.f.agent.name } },
    { op: "desktop.text", agent: { id: t.f.agent.id, handle: t.f.agent.handle, name: t.f.agent.name } },
  ]);
});

test("a close ends the segment: one event with ids, times and a count, never the text; nothing read after", async () => {
  const t = await screening();
  const control = t.stream();
  await t.s.ready(control);
  t.machine.answer(SECRET_TEXT, SECRET_TEXT, { same: true }, `${SECRET_TEXT} 2`);
  await t.time.advance(4 * SESSION_SCREEN_MS);
  const started = new Date(t.time.now() - 4 * SESSION_SCREEN_MS).toISOString();
  await t.s.closed(control);
  const [event, ...more] = await t.events();
  expect(more).toEqual([]);
  // Read first: an asymmetric matcher in `toMatchObject` takes the place of what it matched.
  const id = String(event?.data.segmentId);
  // An unchanged screen is kept once, the computer's `same` not at all.
  expect(event).toMatchObject({
    orgId: t.f.org.id,
    userId: t.f.owner.id,
    data: {
      agentId: t.f.agent.id,
      segmentId: expect.any(String),
      startedAt: started,
      endedAt: new Date(t.time.now()).toISOString(),
      screens: 2,
    },
  });
  expect(Object.keys(event?.data ?? {}).sort()).toEqual(["agentId", "endedAt", "screens", "segmentId", "startedAt"]);
  expect(JSON.stringify(event)).not.toContain("Sintético");
  expect(t.s.segment(id)?.screens.map((s) => s.text)).toEqual([SECRET_TEXT, `${SECRET_TEXT} 2`]);
  await t.time.advance(10 * SESSION_SCREEN_MS);
  expect(t.machine.calls).toHaveLength(4);
});

test("a segment ends at 10 minutes and the next one starts, while the person stays in control", async () => {
  const t = await screening();
  const control = t.stream();
  await t.s.ready(control);
  const reads = SESSION_SEGMENT_MS / SESSION_SCREEN_MS;
  t.machine.answer(...Array.from({ length: reads + 2 }, (_, i) => `screen ${i}`));
  await t.time.advance(SESSION_SEGMENT_MS);
  const [first] = await t.events();
  expect(first?.data).toMatchObject({ screens: reads });
  await t.time.advance(2 * SESSION_SCREEN_MS);
  await t.s.closed(control);
  const [, second] = await t.events();
  expect(second?.data).toMatchObject({ screens: 2, startedAt: first?.data.endedAt });
  expect(second?.data.segmentId).not.toBe(first?.data.segmentId);
});

test("a segment keeps its first screen and the latest ones, 48 KB at most", async () => {
  const t = await screening();
  const control = t.stream();
  await t.s.ready(control);
  const big = (i: number) => `${i}`.repeat(15_000);
  t.machine.answer(...[1, 2, 3, 4, 5].map(big));
  await t.time.advance(5 * SESSION_SCREEN_MS);
  await t.s.closed(control);
  const [event] = await t.events();
  const segment = t.s.segment(String(event?.data.segmentId));
  expect(segment?.screens.map((s) => s.text[0])).toEqual(["1", "4", "5"]);
  expect(segment?.bytes).toBeLessThanOrEqual(SESSION_SEGMENT_MAX_BYTES);
  expect(event?.data).toMatchObject({ screens: 5 });
});

test("a segment's text is read until 10 minutes after it ends, then it is gone, and no table ever held it", async () => {
  const t = await screening();
  const control = t.stream();
  await t.s.ready(control);
  t.machine.answer(SECRET_TEXT);
  await t.time.advance(SESSION_SCREEN_MS);
  await t.s.closed(control);
  const [event] = await t.events();
  const id = String(event?.data.segmentId);
  await t.time.advance(SESSION_KEEP_MS - 1);
  expect(t.s.segment(id)?.screens.map((s) => s.text)).toEqual([SECRET_TEXT]);
  await t.time.advance(1);
  expect(t.s.segment(id)).toBeNull();
  const tables = rowsOf<{ name: string }>(
    await t.f.db.execute(sql`select tablename as name from pg_tables where schemaname = 'public'`),
  );
  expect(tables.length).toBeGreaterThan(50);
  const holding: string[] = [];
  for (const { name } of tables) {
    const [row] = rowsOf<{ n: number }>(
      await t.f.db.execute(
        sql`select count(*)::int as n from ${sql.identifier(name)} t where t::text like ${"%Sintético%"}`,
      ),
    );
    if (row?.n) holding.push(name);
  }
  expect(holding).toEqual([]);
  expect(JSON.stringify(t.logged)).not.toContain("Sintético");
});

test("a runner too old to read, or a computer without tesseract: no segment, said once per computer", async () => {
  const old = await screening({ protocol: DESKTOP_TEXT_PROTOCOL - 1 });
  for (const stream of [old.stream(), old.stream()]) {
    await old.s.ready(stream);
    await old.time.advance(3 * SESSION_SCREEN_MS);
    await old.s.closed(stream);
  }
  expect(old.machine.calls).toEqual([]);
  expect(await old.events()).toEqual([]);
  expect(old.logged).toEqual([{ message: expect.stringContaining("too old"), data: { machineId: MACHINE } }]);
  await f?.close();

  const t = await screening();
  const unavailable = new MachineRequestError("desktop_unavailable", "Reading the screen's text needs tesseract");
  for (const stream of [t.stream(), t.stream()]) {
    await t.s.ready(stream);
    t.machine.answer(unavailable, unavailable, unavailable);
    await t.time.advance(3 * SESSION_SCREEN_MS);
    await t.s.closed(stream);
  }
  // Asked every 30 s all the same, and no segment or event.
  expect(t.machine.calls).toHaveLength(6);
  expect(await t.events()).toEqual([]);
  expect(t.logged).toEqual([
    { message: expect.stringContaining("can't read"), data: { machineId: MACHINE, reason: unavailable.message } },
  ]);
});

test("a refusal in the middle of control stops nothing: the reads go on and the segment still ends at 10 minutes", async () => {
  const t = await screening();
  const control = t.stream();
  await t.s.ready(control);
  const stopped = new MachineRequestError(
    "desktop_unavailable",
    "The desktop helper stopped. It starts again on the next use.",
  );
  t.machine.answer(SECRET_TEXT, stopped, "after");
  await t.time.advance(3 * SESSION_SEGMENT_MS);
  const [event, ...more] = await t.events();
  expect(more).toEqual([]);
  expect(event?.data).toMatchObject({ screens: 2 });
  const lasted = Date.parse(String(event?.data.endedAt)) - Date.parse(String(event?.data.startedAt));
  expect(lasted).toBeLessThanOrEqual(SESSION_SEGMENT_MS);
  expect(t.s.segment(String(event?.data.segmentId))).toBeNull();
  expect(t.machine.calls).toHaveLength((3 * SESSION_SEGMENT_MS) / SESSION_SCREEN_MS);
  expect(t.logged).toEqual([
    { message: expect.stringContaining("can't read"), data: { machineId: MACHINE, reason: stopped.message } },
  ]);
  await t.s.closed(control);
});

test("a stream that closes while its ended segment's event is written is read no more", async () => {
  const t = await screening();
  const control = t.stream();
  let closing: Promise<void> | undefined;
  const s = createSessionScreening({
    db: t.f.db,
    hub: t.machine.hub,
    now: t.time.now,
    // An ended segment's drop is set before its event is written: the close lands in between.
    later: (ms, run) => {
      if (ms === SESSION_KEEP_MS) closing ??= s.closed(control);
      return t.time.later(ms, run);
    },
  });
  await s.ready(control);
  t.machine.answer("screen");
  await t.time.advance(SESSION_SEGMENT_MS);
  expect(closing).toBeDefined();
  await closing;
  const reads = t.machine.calls.length;
  await t.time.advance(3 * SESSION_SCREEN_MS);
  expect(t.machine.calls).toHaveLength(reads);
  expect(await t.events()).toHaveLength(1);
});

test("a screen that fails to come is missed, and the next read goes on", async () => {
  const t = await screening();
  const control = t.stream();
  await t.s.ready(control);
  t.machine.answer(new MachineRequestError("timeout", "no answer"), "after");
  await t.time.advance(2 * SESSION_SCREEN_MS);
  await t.s.closed(control);
  const [event] = await t.events();
  expect(event?.data).toMatchObject({ screens: 1 });
  expect(t.logged).toEqual([]);
});

test("a stream closed before its first segment started is never read", async () => {
  const t = await screening();
  const control = t.stream();
  const ready = t.s.ready(control);
  (control as { closed: boolean }).closed = true;
  await t.s.closed(control);
  await ready;
  await t.time.advance(3 * SESSION_SCREEN_MS);
  expect(t.machine.calls).toEqual([]);
});
