import { afterEach, describe, expect, test } from "bun:test";
import { createFakeErrorReporter } from "@agenteschat/adapters";
import { schema, sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { createOutboxPump, enqueue, NotFoundError } from "@agenteschat/engine";
import type { AgentesModule, ModuleContext } from "@agenteschat/modules";
import { validator } from "hono/validator";
import { createApp } from "../src/app";
import { createLogger } from "../src/logger";
import { logJobFailure } from "../src/workers";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

const ORG_ID = "0b0e5b55-7e6c-4b51-9c3c-2f1d8f5a7c01";
/** Shaped like a person's id from Better Auth: 32 letters and digits. */
const USER_ID = "notarealuseridnotarealuserid0001";
const RUN_ID = "5f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("error reports (ADR 0104)", () => {
  test("a 500 is reported with its route pattern, method, status, request id and whose request it was; a 4xx is not, a malformed body included", async () => {
    const errors = createFakeErrorReporter();
    const failing: AgentesModule = {
      name: "failing",
      registerRoutes(api) {
        api.use("/failing/*", async (c, next) => {
          c.set("user" as never, { id: USER_ID } as never);
          await next();
        });
        api.get("/failing/:orgId/broken", () => {
          throw new TypeError("Cannot destructure property 'context' of 'f' as it is undefined.");
        });
        api.get("/failing/:orgId/missing", () => {
          throw new NotFoundError("No such thing");
        });
        api.post(
          "/failing/:orgId/json",
          validator("json", (body) => body),
          (c) => c.json({ ok: true }),
        );
      },
    };
    const app = createApp({
      edition: "selfhost",
      version: "test",
      modules: [failing],
      moduleContext: {} as ModuleContext,
      pingDatabase: async () => {},
      log: createLogger("error", errors),
    });

    const broken = await app.request(`/api/failing/${ORG_ID}/broken`);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({
      error: { code: "internal_error", message: "Something went wrong on our side" },
    });
    expect(errors.reports).toHaveLength(1);
    expect(errors.reports[0]?.error).toBeInstanceOf(TypeError);
    expect(errors.reports[0]?.tags).toEqual({
      log: "unhandled error",
      route: "/api/failing/:orgId/broken",
      method: "GET",
      status: 500,
      request_id: broken.headers.get("x-request-id") ?? "missing",
      org_id: ORG_ID,
      user_id: USER_ID,
    });

    expect((await app.request(`/api/failing/${ORG_ID}/missing`)).status).toBe(404);
    expect((await app.request("/api/nowhere")).status).toBe(404);
    // A body that isn't the JSON it claims to be (a client's bug, an upload cut short) is the client's error.
    const malformed = await app.request(`/api/failing/${ORG_ID}/json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: { code: "invalid_request", message: "Malformed JSON in request body" },
    });
    expect(errors.reports).toHaveLength(1);
  });

  test("a sign-in that fails inside Better Auth (its own 500) is reported once; a wrong password is not", async () => {
    const errors = createFakeErrorReporter();
    t = await createTestServer({ errors });
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const signIn = (password: string) =>
      ana("/api/auth/sign-in/email", { json: { email: "ana@example.com", password } });
    expect((await signIn("not the password")).status).toBe(401);
    expect(errors.reports).toEqual([]);

    await t.db.execute(
      sql`create function refuse_sessions() returns trigger language plpgsql as $$ begin raise exception 'sessions are down'; end $$`,
    );
    await t.db.execute(
      sql`create trigger refuse_sessions before insert on sessions for each row execute function refuse_sessions()`,
    );
    expect((await signIn("correct horse battery")).status).toBe(500);
    expect(errors.reports).toHaveLength(1);
    expect(errors.reports[0]?.tags).toEqual({ log: "auth request failed" });
    expect(String(errors.reports[0]?.error)).toContain("Failed query");
  });

  test("a failing job is reported once per attempt with its kind, attempt and ids, never its payload", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const errors = createFakeErrorReporter();
      const log = createLogger("error", errors);
      await enqueue(db, {
        orgId: null,
        kind: "test.broken",
        payload: { runId: RUN_ID, text: "ana@example.com asked for the report" },
      });
      const pump = createOutboxPump(
        db,
        {
          "test.broken": async () => {
            throw new Error("the handler broke");
          },
        },
        { workerId: "test-worker", onError: (job, error, outcome) => logJobFailure(log, job, error, outcome) },
      );
      expect(await pump.pump()).toBe(1);
      await pump.idle();
      expect(errors.reports).toHaveLength(1);
      expect(errors.reports[0]?.error).toMatchObject({ message: "the handler broke" });
      const [job] = await db.select().from(schema.outbox);
      expect(errors.reports[0]?.tags).toEqual({
        log: "outbox job failed",
        job_kind: "test.broken",
        job_id: job?.id,
        job_attempt: 1,
        job_outcome: "retry",
        run_id: RUN_ID,
      });
      if (!job) throw new Error("no job");

      // A worker stopping, a refusal the engine expects and a transient failure tried again are logged, not reported.
      logJobFailure(log, job, Object.assign(new Error("stopping"), { handback: true }), "retry");
      logJobFailure(log, job, new NotFoundError("The run is gone"), "failed");
      logJobFailure(log, job, Object.assign(new Error("overloaded"), { retryable: true }), "retry");
      expect(errors.reports).toHaveLength(1);
      // Out of attempts, even a transient one is.
      logJobFailure(log, job, Object.assign(new Error("overloaded"), { retryable: true }), "failed");
      expect(errors.reports).toHaveLength(2);
    } finally {
      await close();
    }
  });

  test("an error line is reported with its ids as tags, never its other fields; warnings and plain lines are not", () => {
    const errors = createFakeErrorReporter();
    const log = createLogger("error", errors);
    log.warn("couldn't do it", { error: new Error("a warning") });
    log.error("bot check: Cloudflare can't be reached");
    expect(errors.reports).toEqual([]);
    const crash = new Error("crashed");
    log.error("uncaught exception", { error: crash, unhandled: true, userId: USER_ID, email: "ana@example.com" });
    expect(errors.reports).toEqual([
      { error: crash, tags: { log: "uncaught exception", user_id: USER_ID }, unhandled: true },
    ]);
  });

  test("the deploy's version (APP_VERSION) is the instance's, and the release the web app reports under", async () => {
    t = await createTestServer({
      env: { APP_VERSION: "2026.10.31.4", SENTRY_WEB_DSN: "https://public@example.invalid/2" },
    });
    expect(await (await t.app.request("/api/instance")).json()).toMatchObject({ version: "2026.10.31.4" });
    expect(await (await t.app.request("/api/health")).json()).toMatchObject({ version: "2026.10.31.4" });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      errorReports: { dsn: "https://public@example.invalid/2", environment: "production", release: "2026.10.31.4" },
      mobileErrorReports: { dsn: "https://public@example.invalid/2" },
    });
  });

  test("the phone app reports to its own project when SENTRY_MOBILE_DSN is set", async () => {
    t = await createTestServer({
      env: {
        SENTRY_WEB_DSN: "https://public@example.invalid/2",
        SENTRY_MOBILE_DSN: "https://public@example.invalid/3",
      },
    });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      errorReports: { dsn: "https://public@example.invalid/2" },
      mobileErrorReports: { dsn: "https://public@example.invalid/3", environment: "production" },
    });
  });

  test("without SENTRY_WEB_DSN the web app gets no reporting, and the version is the server's own", async () => {
    t = await createTestServer();
    expect(await (await t.app.request("/api/instance")).json()).toMatchObject({ version: "test" });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      errorReports: null,
      mobileErrorReports: null,
    });
  });
});
