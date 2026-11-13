import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const ID = "7b0c2c0e-5a51-4a3f-9d0e-0d6f6a4f1a01";

test("feedback: no address, no form and no route", async () => {
  t = await createTestServer();
  const ana = browser(t);
  expect(await (await ana("/api/app/auth-config")).json()).toMatchObject({ feedback: false });
  await signUp(ana, "ana@example.com");
  expect((await ana("/api/app/feedback", { json: { id: ID, text: "The attach button is gone" } })).status).toBe(404);
});

test("feedback: one email to the server's address, through the outbox, answered to the person", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com" } });
  const ana = browser(t);
  expect(await (await ana("/api/app/auth-config")).json()).toMatchObject({ feedback: true });
  expect((await browser(t)("/api/app/feedback", { json: { id: ID, text: "hi" } })).status).toBe(401);
  await signUp(ana, "ana@example.com");
  const { orgId } = await seedOrg(ana);
  await t.drain();
  t.email.sent.length = 0;

  const send = (json: Record<string, unknown>) => ana("/api/app/feedback", { json });
  expect((await send({ id: ID, text: "   " })).status).toBe(400);
  const sent = await send({
    id: ID,
    text: "The attach button is gone\n<b>on a narrow window</b>",
    orgId,
    where: "/org/x/dm/agent/y",
    app: "web",
  });
  expect(sent.status).toBe(204);
  // The same message sent again (a retry of the request) goes once.
  expect((await send({ id: ID, text: "The attach button is gone" })).status).toBe(204);
  expect(t.email.sent).toEqual([]); // never inline in the request
  await t.drain();
  expect(t.email.sent).toHaveLength(1);
  const mail = t.email.sent[0];
  expect(mail).toMatchObject({ to: ["feedback@example.com"], replyTo: "ana@example.com" });
  expect(mail?.subject).toStartWith("Feedback from ");
  expect(mail?.text).toContain("The attach button is gone\n<b>on a narrow window</b>");
  expect(mail?.text).toContain("<ana@example.com>");
  expect(mail?.text).toContain("Workspace: Acme");
  expect(mail?.text).toContain("Screen: /org/x/dm/agent/y");
  // What the person typed is text in the HTML part, never markup.
  expect(mail?.html).toContain("&lt;b&gt;on a narrow window&lt;/b&gt;");
  expect(mail?.html).not.toContain("<b>on a narrow window</b>");
});

test("feedback: a workspace that isn't theirs is not named, and an hour takes ten", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com", ALLOW_SIGNUP: "true" } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.drain();
  t.email.sent.length = 0;

  const id = (n: number) => `7b0c2c0e-5a51-4a3f-9d0e-0d6f6a4f1a${String(n).padStart(2, "0")}`;
  expect((await bia("/api/app/feedback", { json: { id: id(0), text: "From outside", orgId } })).status).toBe(204);
  await t.drain();
  expect(t.email.sent[0]?.text).not.toContain("Workspace:");
  for (let n = 1; n < 10; n++)
    expect((await bia("/api/app/feedback", { json: { id: id(n), text: `Again ${n}` } })).status).toBe(204);
  expect((await bia("/api/app/feedback", { json: { id: id(10), text: "One too many" } })).status).toBe(429);
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const upload = (b: ReturnType<typeof browser>, bytes: Uint8Array, name: string, type = "image/png") => {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }), name);
  return b("/api/app/feedback/files", { method: "POST", body: form });
};

test("feedback: a picture is added, sent as a link good for a month, and opens only as a download", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com", ALLOW_SIGNUP: "true" } });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  const bia = browser(t);
  await signUp(bia, "bia@example.com");
  await t.drain();
  t.email.sent.length = 0;

  expect((await upload(browser(t), PNG, "a.png")).status).toBe(401);
  // What it calls itself doesn't matter: its bytes do.
  const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
  const refused = await upload(ana, html, "shot.png");
  expect(refused.status).toBe(400);
  expect(JSON.stringify(await refused.json())).toContain("feedback.file_type");

  const added = await upload(ana, PNG, "shot.png");
  expect(added.status).toBe(200);
  const file = (await added.json()) as { id: string; name: string; kind: string };
  expect(file).toMatchObject({ name: "shot.png", kind: "image" });
  const taken = (await (await upload(ana, PNG, "other.png")).json()) as { id: string };
  expect((await bia(`/api/app/feedback/files/${taken.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await ana(`/api/app/feedback/files/${taken.id}`, { method: "DELETE" })).status).toBe(204);

  // Someone else's file sends nothing, not even the text.
  const stolen = await bia("/api/app/feedback", { json: { id: ID, text: "Mine now", files: [file.id] } });
  expect(stolen.status).toBe(400);
  const sent = await ana("/api/app/feedback", {
    json: {
      id: ID,
      text: "This answer is wrong",
      about: { kind: "agent message", label: "Ada", text: "Deploy done." },
      facts: [["Route", "/org/$orgId/home"]],
      files: [file.id],
    },
  });
  expect(sent.status).toBe(204);
  await t.drain();
  expect(t.email.sent).toHaveLength(1);
  const mail = t.email.sent[0];
  expect(mail?.text).toContain("About agent message: Ada\n\n> Deploy done.");
  expect(mail?.text).toContain("Route: /org/$orgId/home");
  expect(mail?.inline).toMatchObject([{ filename: "shot.png", contentType: "image/png" }]);
  const link = /https?:\/\/\S+\/api\/feedback-files\/[\w-]+/.exec(mail?.text ?? "")?.[0] ?? "";
  expect(link).not.toBe("");

  // The link needs no session, and this origin never shows the file: a download, with nothing sniffed or run.
  const opened = await browser(t)(new URL(link).pathname);
  expect(opened.status).toBe(200);
  expect(opened.headers.get("content-type")).toBe("image/png");
  expect(opened.headers.get("content-disposition")).toStartWith('attachment; filename="shot.png"');
  expect(opened.headers.get("x-content-type-options")).toBe("nosniff");
  expect(opened.headers.get("content-security-policy")).toContain("sandbox");
  expect(new Uint8Array(await opened.arrayBuffer())).toEqual(PNG);
  expect((await browser(t)("/api/feedback-files/not-a-real-token-at-all-0000")).status).toBe(404);
  expect((await ana(`/api/app/feedback/files/${file.id}`, { method: "DELETE" })).status).toBe(404);
});

test("feedback files: the hour's limit and the size are answered before the file is read", async () => {
  t = await createTestServer({ env: { FEEDBACK_EMAIL: "feedback@example.com" } });
  const ana = browser(t);
  await signUp(ana, "ana@example.com");
  // A body that says it is past the largest file is refused by that alone.
  const claimed = await ana("/api/app/feedback/files", {
    method: "POST",
    body: new FormData(),
    headers: { "content-length": String(60 * 1024 * 1024) },
  });
  expect(claimed.status).toBe(413);
  // Thirty an hour, tried or kept: the thirty-first is refused whatever it holds.
  const junk = new TextEncoder().encode("not a picture at all");
  for (let n = 0; n < 30; n++) expect((await upload(ana, junk, `${n}.png`)).status).toBe(400);
  expect((await upload(ana, PNG, "real.png")).status).toBe(429);
});
