import { afterEach, expect, test } from "bun:test";
import { createTestServer, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("the git proxy is mounted at /api/git on every server and asks for the computer's credential", async () => {
  t = await createTestServer();
  const org = crypto.randomUUID();
  const conn = crypto.randomUUID();
  const res = await t.app.request(`/api/git/${org}/${conn}/acme/app.git/info/refs?service=git-upload-pack`);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain("Basic");
  const bad = await t.app.request(`/api/git/${org}/${conn}/acme/app.git/info/refs?service=git-upload-pack`, {
    headers: { authorization: `Basic ${Buffer.from("agentes:not-a-token").toString("base64")}` },
  });
  expect(bad.status).toBe(401);
  expect((await t.app.request(`/api/git/${org}/${conn}/not-a-repo`)).status).toBe(404);
});
