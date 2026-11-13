import { afterEach, describe, expect, test } from "bun:test";
import { LOAD_SAMPLE_MS } from "@agenteschat/adapters";
import { testConfig } from "@agenteschat/config";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { setTelemetryEnabled, telemetryState } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import {
  FIRST_REPORT_MS,
  OVERDUE_REPORT_MS,
  printTelemetry,
  REPORT_EVERY_MS,
  RETRY_MS,
  startTelemetry,
  type Timers,
} from "../src/telemetry";
import { browser, createTestServer, deletionCode, deletionsDue, signUp, type TestServer } from "./harness";

const log = createLogger("error");
const PROD = { NODE_ENV: "production" };

/**
 * Timers that run only when a test fires them, on a clock of their own. `fire(ms)` runs the newest one with
 * that delay, the clock moved to its time; `delays()` are the report's, without the sampler's one (it re-arms
 * itself every `LOAD_SAMPLE_MS`, like a retry may).
 */
function fakeTimers(start = Date.UTC(2026, 9, 25, 9)) {
  const queue: { id: number; ms: number; at: number; run: () => void }[] = [];
  let next = 1;
  let clock = start;
  const timers: Timers = {
    set: (run, ms) => {
      const id = next++;
      queue.push({ id, ms, at: clock + ms, run });
      return id;
    },
    clear: (id) => {
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  return {
    timers,
    now: () => clock,
    /** Time passing with nothing fired (the server stopped). */
    advance: (ms: number) => {
      clock += ms;
    },
    delays: () => {
      const ms = queue.map((t) => t.ms);
      const sampler = ms.indexOf(LOAD_SAMPLE_MS);
      return sampler < 0 ? ms : ms.filter((_, i) => i !== sampler);
    },
    async fire(ms: number) {
      const i = queue.map((t) => t.ms).lastIndexOf(ms);
      if (i < 0) throw new Error(`no timer of ${ms} ms (have ${queue.map((t) => t.ms).join(", ")})`);
      const before = next;
      const [timer] = queue.splice(i, 1);
      if (timer) clock = Math.max(clock, timer.at);
      timer?.run();
      // Done once it set its next timer.
      for (let n = 0; n < 200 && next === before; n++) await Bun.sleep(5);
    },
  };
}

/** A fetch that records what it was sent and answers `status` (or throws, for `"down"`). */
function fakeFetch(answers: (number | "down")[] = [204]) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === "down") throw new TypeError("fetch failed");
    return new Response(null, { status: a });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

let db: Database;
let close: (() => Promise<void>) | undefined;
let t: TestServer | undefined;
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await close?.();
  close = undefined;
  await t?.close();
  t = undefined;
});

async function start(
  env: Record<string, string>,
  answers?: (number | "down")[],
  sample: () => Promise<{ load: number; memory: number } | null> = async () => null,
  clock = fakeTimers(),
) {
  // A restart keeps the database.
  if (!close) ({ db, close } = await createTestDatabase());
  const config = testConfig({ ...PROD, ...env });
  const http = fakeFetch(answers);
  const telemetry = startTelemetry({ db, config, log, fetch: http.fn, timers: clock.timers, sample, now: clock.now });
  stops.push(telemetry.stop);
  await telemetry.ready;
  return { config, clock, http, stop: telemetry.stop };
}

describe("sending", () => {
  test("the first report about an hour after start, then once a day; it says only what the report holds", async () => {
    const { clock, http, config } = await start({});
    expect(clock.delays()).toEqual([FIRST_REPORT_MS]);
    await clock.fire(FIRST_REPORT_MS);
    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe(config.TELEMETRY_URL);
    expect(call?.url).toBe("https://telemetry.agentes.chat/v1/report");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(call?.body ?? {})).toEqual([
      "report",
      "instance",
      "version",
      "edition",
      "install",
      "os",
      "arch",
      "uptimeHours",
      "host",
      "organizations",
      "people",
      "agents",
      "computers",
      "lastDay",
    ]);
    expect(call?.body.instance).toBe((await telemetryState(db)).instanceId);
    expect(clock.delays()).toEqual([REPORT_EVERY_MS]);
    await clock.fire(REPORT_EVERY_MS);
    expect(http.calls).toHaveLength(2);
    expect(clock.delays()).toEqual([REPORT_EVERY_MS]);
  });

  test("a failed send is tried again after 5 min, 30 min and 2 h, then waits for the next day's", async () => {
    const { clock, http } = await start({}, ["down", 503, 500, "down", 204]);
    await clock.fire(FIRST_REPORT_MS);
    for (const delay of RETRY_MS) {
      expect(clock.delays()).toEqual([delay]);
      await clock.fire(delay);
    }
    expect(http.calls).toHaveLength(4);
    // The next day keeps its time: nothing queued, the day's report is just built again.
    const waited = RETRY_MS.reduce((a, b) => a + b, 0);
    expect(clock.delays()).toEqual([REPORT_EVERY_MS - waited]);
    await clock.fire(REPORT_EVERY_MS - waited);
    expect(http.calls).toHaveLength(5);
    expect(clock.delays()).toEqual([REPORT_EVERY_MS]);
  });

  test("a restart keeps the report's time: the rest is waited out, and one that came due meanwhile goes soon", async () => {
    const clock = fakeTimers();
    const first = await start({}, [204], undefined, clock);
    expect(clock.delays()).toEqual([FIRST_REPORT_MS]);
    // Restarted 40 minutes in: the first report still comes an hour after the first start.
    first.stop();
    clock.advance(40 * 60_000);
    const second = await start({}, [204], undefined, clock);
    expect(clock.delays()).toEqual([20 * 60_000]);
    await clock.fire(20 * 60_000);
    expect(second.http.calls).toHaveLength(1);
    expect(clock.delays()).toEqual([REPORT_EVERY_MS]);
    // Down for two days: the missed report goes soon after the next start, then a day after that.
    second.stop();
    clock.advance(2 * REPORT_EVERY_MS);
    const third = await start({}, [204], undefined, clock);
    expect(clock.delays()).toEqual([OVERDUE_REPORT_MS]);
    await clock.fire(OVERDUE_REPORT_MS);
    expect(third.http.calls).toHaveLength(1);
    expect(clock.delays()).toEqual([REPORT_EVERY_MS]);
  });

  test("a restart keeps the host's day of samples", async () => {
    const clock = fakeTimers();
    const samples = [
      { load: 2, memory: 0.9 },
      { load: 1, memory: 0.5 },
      { load: 0, memory: 0.1 },
    ];
    const take = async () => samples.shift() ?? null;
    const first = await start({}, [204], take, clock);
    await clock.fire(LOAD_SAMPLE_MS);
    first.stop();
    clock.advance(3600_000);
    await start({}, [204], take, clock);
    expect((await telemetryState(db)).hostLoad).toMatchObject({
      loadAvg: 1,
      loadPeak: 2,
      memoryAvg: 0.5,
      memoryPeak: 0.9,
      hours: 0.3,
    });
  });

  test("off means nothing is sent: TELEMETRY=off schedules nothing", async () => {
    const { clock, http } = await start({ TELEMETRY: "off" });
    expect(clock.delays()).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  test("the owner's switch off: the day comes and goes, nothing is sent", async () => {
    const { clock, http } = await start({});
    await setTelemetryEnabled(db, false);
    await clock.fire(FIRST_REPORT_MS);
    expect(http.calls).toEqual([]);
    expect(clock.delays()).toEqual([REPORT_EVERY_MS]);
    // Turned back on: the next day's goes out.
    await setTelemetryEnabled(db, true);
    await clock.fire(REPORT_EVERY_MS);
    expect(http.calls).toHaveLength(1);
  });

  test("TELEMETRY=off wins over the switch", async () => {
    const { clock, http } = await start({ TELEMETRY: "off" });
    await setTelemetryEnabled(db, true);
    expect(clock.delays()).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  test("agentes.chat's own server always sends, whatever TELEMETRY and the switch say", async () => {
    const { clock, http } = await start({ PUBLIC_URL: "https://agentes.chat", TELEMETRY: "off" });
    await setTelemetryEnabled(db, false);
    await clock.fire(FIRST_REPORT_MS);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.body.edition).toBe("cloud");
  });

  test("a development server sends nothing", async () => {
    const { clock } = await start({ NODE_ENV: "development" });
    expect(clock.delays()).toEqual([]);
  });

  test("the host load sampler keeps the last day in the database, and the report carries it", async () => {
    const samples = [
      { load: 0.5, memory: 0.4 },
      { load: 1.5, memory: 0.8 },
    ];
    const { clock, http } = await start({}, [204], async () => samples.shift() ?? null);
    await clock.fire(LOAD_SAMPLE_MS);
    const load = { loadAvg: 1, loadPeak: 1.5, memoryAvg: 0.6, memoryPeak: 0.8, hours: 0.2 };
    expect((await telemetryState(db)).hostLoad).toMatchObject(load);
    await clock.fire(FIRST_REPORT_MS);
    expect(http.calls[0]?.body.host).toMatchObject({ load });
  });
});

test("agentes telemetry prints exactly the next report, on or off, and sends nothing", async () => {
  const { clock, http, config } = await start({});
  // A computer whose agents' browsers said how much they moved (protocol 23).
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  await db.insert(schema.machines).values({
    orgId: org?.id as string,
    name: "Box",
    os: "linux",
    arch: "x64",
    lastSeenAt: new Date(clock.now()),
    browserTraffic: { up: 5_200_000, down: 81_000_000, hours: 1.5, at: new Date(clock.now()).toISOString() },
  });
  const out: string[] = [];
  const err: string[] = [];
  const print = (c = config) =>
    printTelemetry(
      db,
      c,
      { write: (s: string) => out.push(s) },
      { write: (s: string) => err.push(s) },
      new Date(clock.now() + FIRST_REPORT_MS),
    );
  await print();
  await clock.fire(FIRST_REPORT_MS);
  expect(http.calls).toHaveLength(1);
  expect(JSON.parse(out.join(""))).toEqual(http.calls[0]?.body);
  expect(JSON.parse(out.join("")).computers).toEqual([
    expect.objectContaining({ count: 1, browserTraffic: { upMb: 5, downMb: 81, hours: 1.5, computers: 1 } }),
  ]);
  expect(err.join("")).toContain("On: sent once a day to https://telemetry.agentes.chat/v1/report");

  await setTelemetryEnabled(db, false);
  out.length = 0;
  err.length = 0;
  await print();
  expect(JSON.parse(out.join(""))).toMatchObject({ report: 1, instance: http.calls[0]?.body.instance });
  expect(err.join("")).toBe("Off (turned off in Settings): nothing is sent.\n");
  await print(testConfig({ ...PROD, TELEMETRY: "off" }));
  expect(err.at(-1)).toBe("Off (TELEMETRY=off): nothing is sent.\n");
  expect(http.calls).toHaveLength(1);
});

describe("the switch in Settings", () => {
  async function server(env: Record<string, string> = {}) {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true", ...env } });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const other = browser(t);
    await signUp(other, "other@example.com");
    return { owner, other, db: t.db, app: t };
  }

  test("only the installation's owner sees it; turning it off is stored", async () => {
    const { owner, other, db } = await server();
    expect((await other("/api/app/telemetry")).status).toBe(404);
    expect((await other("/api/app/telemetry", { method: "PUT", json: { enabled: false } })).status).toBe(404);
    const res = await owner("/api/app/telemetry");
    expect(res.status).toBe(200);
    const view = (await res.json()) as { enabled: boolean; envOff: boolean; report: Record<string, unknown> };
    expect(view).toMatchObject({ enabled: true, envOff: false, report: { report: 1, people: { total: 2 } } });
    const off = await owner("/api/app/telemetry", { method: "PUT", json: { enabled: false } });
    expect(((await off.json()) as { enabled: boolean }).enabled).toBe(false);
    const [row] = await db.select().from(schema.instanceTelemetry).where(eq(schema.instanceTelemetry.id, 1));
    expect(row?.enabled).toBe(false);
  });

  test("once the first account deletes itself, nobody inherits the switch", async () => {
    const { owner, other, app } = await server();
    const code = await deletionCode(app, owner, null);
    expect((await owner("/api/app/account", { method: "DELETE", json: { code } })).status).toBe(204);
    await deletionsDue(app);
    expect((await other("/api/app/telemetry")).status).toBe(404);
    expect((await other("/api/app/telemetry", { method: "PUT", json: { enabled: false } })).status).toBe(404);
  });

  test("once no account is left, the next first account has the switch", async () => {
    const app = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    t = app;
    const first = browser(app);
    await signUp(first, "first@example.com");
    expect((await first("/api/app/telemetry")).status).toBe(200);
    const code = await deletionCode(app, first, null);
    expect((await first("/api/app/account", { method: "DELETE", json: { code } })).status).toBe(204);
    await deletionsDue(app);
    const next = browser(t);
    await signUp(next, "next@example.com");
    expect((await next("/api/app/telemetry")).status).toBe(200);
  });

  test("with TELEMETRY=off the page says so", async () => {
    const { owner } = await server({ TELEMETRY: "off" });
    const view = (await (await owner("/api/app/telemetry")).json()) as { enabled: boolean; envOff: boolean };
    expect(view).toMatchObject({ enabled: true, envOff: true });
  });

  test("on agentes.chat itself nobody has it", async () => {
    const origin = "https://agentes.chat";
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true", PUBLIC_URL: origin } });
    const first = browser(t);
    const signedUp = await first("/api/auth/sign-up/email", {
      json: { email: "first@example.com", password: "correct horse battery", name: "First" },
      origin,
    });
    expect(signedUp.status).toBe(200);
    expect((await first("/api/app/me")).status).toBe(200);
    expect((await first("/api/app/telemetry")).status).toBe(404);
    expect((await first("/api/app/telemetry", { method: "PUT", json: { enabled: false }, origin })).status).toBe(404);
  });
});
