import { afterEach, describe, expect, test } from "bun:test";
import { createFakeEmailSender, createMemoryBlobStore } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  attachFeedbackFiles,
  dropFeedbackFile,
  FEEDBACK_FILES,
  FEEDBACK_MAX,
  FEEDBACK_SENT_MS,
  FEEDBACK_UNSENT_MS,
  feedbackBlobKey,
  feedbackFileByToken,
  NotFoundError,
  PermanentJobError,
  purgeFeedbackFile,
  renderFeedback,
  sendQueuedFeedback,
  sniffFeedbackFile,
  storeFeedbackFile,
  sweepFeedbackFiles,
  TooManyError,
} from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

const feedback = {
  to: "feedback@example.com",
  name: "Ana Lima",
  email: "ana@example.com",
  text: "  The sky is too dark\nat night.  ",
  version: "1.2.3",
};

test("a feedback email: the person's words first, then who wrote them and from where", () => {
  const mail = renderFeedback({ ...feedback, orgName: "Acme", where: "/org/x", app: "web" });
  expect(mail.subject).toBe("Feedback from Ana Lima");
  expect(mail.text).toBe(
    "The sky is too dark\nat night.\n\n--\nFrom: Ana Lima <ana@example.com>\nWorkspace: Acme\nScreen: /org/x\nApp: web\nServer: 1.2.3\n",
  );
  expect(mail.html).toContain("The sky is too dark\nat night.");
});

test("a feedback email: a name can't start another line or header, the text is cut and inert", () => {
  const mail = renderFeedback({
    ...feedback,
    name: "Ana\r\nBcc: everyone@example.com",
    text: `<script>alert(1)</script>${"x".repeat(FEEDBACK_MAX)}`,
  });
  expect(mail.subject).toBe("Feedback from Ana Bcc: everyone@example.com");
  expect(mail.html).toContain("&lt;script&gt;");
  expect(mail.html).not.toContain("<script>");
  expect(mail.text.split("\n\n--\n")[0]).toHaveLength(FEEDBACK_MAX);
  // No name: the address stands for it.
  expect(renderFeedback({ ...feedback, name: " " }).subject).toBe("Feedback from ana@example.com");
});

test("the feedback job: answered to the person, sent once per key, and nothing without text", async () => {
  const sender = createFakeEmailSender();
  await sendQueuedFeedback(sender, { key: "u1:m1", feedback });
  expect(sender.sent).toHaveLength(1);
  expect(sender.sent[0]).toMatchObject({
    to: ["feedback@example.com"],
    replyTo: "ana@example.com",
    idempotencyKey: "feedback:u1:m1",
  });
  await expect(
    sendQueuedFeedback(sender, { key: "u1:m2", feedback: { ...feedback, text: "" } }),
  ).rejects.toBeInstanceOf(PermanentJobError);
});

test("a feedback email: what was reported is quoted, the app's facts listed, the files linked", () => {
  const mail = renderFeedback({
    ...feedback,
    text: "This answer is wrong",
    about: { kind: "agent message", label: "Ada", text: "Deploy done.\n<i>All green</i>" },
    facts: [
      ["Route", "/org/$orgId/dm/agent/$agentId"],
      ["Broken\r\nBcc", "x"],
      ["Empty", ""],
    ],
    files: [
      {
        id: "f1",
        name: "screen.png",
        contentType: "image/png",
        size: 2048,
        kind: "image",
        url: "https://chat.example.com/api/feedback-files/tok",
        expiresAt: "2026-12-09T10:00:00.000Z",
      },
    ],
  });
  expect(mail.text).toBe(
    [
      "This answer is wrong",
      "About agent message: Ada",
      "> Deploy done.\n> <i>All green</i>",
      "Files (the links open until 2026-12-09):\n- screen.png (2 KB): https://chat.example.com/api/feedback-files/tok",
      "--\nFrom: Ana Lima <ana@example.com>\nRoute: /org/$orgId/dm/agent/$agentId\nBroken Bcc: x\nServer: 1.2.3\n",
    ].join("\n\n"),
  );
  // The reported words are text in the HTML part, and the picture rides along by its content id.
  expect(mail.html).toContain("&lt;i&gt;All green&lt;/i&gt;");
  expect(mail.html).toContain('<img src="cid:feedback-1"');
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const MP4 = new Uint8Array([0, 0, 0, 24, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), 0, 0, 2, 0, 1, 2]);

test("a file is what its bytes say: pictures and videos, never markup or a claim", () => {
  expect(sniffFeedbackFile(PNG)).toMatchObject({ kind: "image", contentType: "image/png" });
  expect(sniffFeedbackFile(MP4)).toMatchObject({ kind: "video", contentType: "video/mp4" });
  const text = (s: string) => new TextEncoder().encode(s.padEnd(20, " "));
  expect(sniffFeedbackFile(text("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
  expect(sniffFeedbackFile(text("<!doctype html><script>"))).toBeNull();
  expect(sniffFeedbackFile(new Uint8Array(4))).toBeNull();
  // The same container as a video's, holding sound alone or anything unknown: not taken.
  const boxed = (brand: string) =>
    new Uint8Array([0, 0, 0, 24, ...[...`ftyp${brand}`].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
  expect(sniffFeedbackFile(boxed("M4A "))).toBeNull();
  expect(sniffFeedbackFile(boxed("zzzz"))).toBeNull();
  expect(sniffFeedbackFile(boxed("qt  "))).toMatchObject({ kind: "video", contentType: "video/quicktime" });
  expect(sniffFeedbackFile(boxed("heic"))).toMatchObject({ kind: "image", contentType: "image/heic" });
});

describe("feedback files", () => {
  let f: Fixture;
  afterEach(async () => {
    await f?.close();
  });
  const NOW = new Date("2026-11-09T12:00:00Z");
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  test("kept an hour, then a month behind a link once sent; only the person's own, within what a feedback takes", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const deps = { db: f.db, blobs };
    const ana = await addUser(f.db, "ana");
    const bia = await addUser(f.db, "bia");

    await expect(storeFeedbackFile(deps, ana.id, { name: "a.html", bytes: new Uint8Array(40) })).rejects.toMatchObject({
      code: "feedback.file_type",
    });
    const big = new Uint8Array(FEEDBACK_FILES.imageBytes + 1);
    big.set(PNG);
    await expect(storeFeedbackFile(deps, ana.id, { name: "big.png", bytes: big })).rejects.toMatchObject({
      code: "feedback.file_too_large",
    });

    // The name is cleaned and takes the extension of what the file is.
    const shot = await storeFeedbackFile(deps, ana.id, { name: "../../etc/pass<wd>.exe", bytes: PNG }, NOW);
    expect(shot).toMatchObject({ name: "passwd.png", kind: "image", contentType: "image/png", size: PNG.byteLength });
    const video = await storeFeedbackFile(deps, ana.id, { name: "rec.mov", bytes: MP4 }, NOW);
    expect(video).toMatchObject({ name: "rec.mp4", kind: "video" });
    expect(blobs.objects.size).toBe(2);

    // Someone else's file, or one more video than a feedback takes: nothing is attached.
    const attach = (userId: string, ids: string[], now = NOW) =>
      attachFeedbackFiles(f.db, { userId, orgId: null, ids, publicUrl: "https://chat.example.com/" }, now);
    await expect(attach(bia.id, [shot.id])).rejects.toMatchObject({ code: "feedback.files_gone" });
    const second = await storeFeedbackFile(deps, ana.id, { name: "again.mp4", bytes: MP4 }, NOW);
    await expect(attach(ana.id, [video.id, second.id])).rejects.toMatchObject({ code: "feedback.files_many" });
    // Past its hour it is gone for a feedback too.
    await expect(attach(ana.id, [shot.id], later(FEEDBACK_UNSENT_MS + 1))).rejects.toMatchObject({
      code: "feedback.files_gone",
    });

    const [ref] = await attach(ana.id, [shot.id]);
    expect(ref?.url).toStartWith("https://chat.example.com/api/feedback-files/");
    const token = ref?.url.split("/").pop() ?? "";
    expect(await feedbackFileByToken(deps, token, NOW)).toMatchObject({ name: "passwd.png", contentType: "image/png" });
    expect(await feedbackFileByToken(deps, `${token}x`, NOW)).toBeNull();
    expect(await feedbackFileByToken(deps, "../../etc", NOW)).toBeNull();
    // Sent, it can't be attached again nor taken back.
    await expect(attach(ana.id, [shot.id])).rejects.toMatchObject({ code: "feedback.files_gone" });
    await expect(dropFeedbackFile(deps, ana.id, shot.id)).rejects.toBeInstanceOf(NotFoundError);

    // The first purge (an hour in) finds it wanted for a month; the month's purge removes row and bytes.
    await purgeFeedbackFile(deps, shot.id, later(FEEDBACK_UNSENT_MS + 60_000));
    expect(await feedbackFileByToken(deps, token, later(FEEDBACK_UNSENT_MS + 60_000))).not.toBeNull();
    expect(await feedbackFileByToken(deps, token, later(FEEDBACK_SENT_MS + 1))).toBeNull();
    await purgeFeedbackFile(deps, shot.id, later(FEEDBACK_SENT_MS + 60_000));
    expect(blobs.objects.has(feedbackBlobKey(shot.id))).toBe(false);

    // Never sent: taken back by its person, or purged after its hour.
    await dropFeedbackFile(deps, ana.id, second.id);
    await purgeFeedbackFile(deps, video.id, later(FEEDBACK_UNSENT_MS + 60_000));
    expect(blobs.objects.size).toBe(0);
    expect(await f.db.select().from(schema.feedbackFiles)).toEqual([]);
  });

  test("a person holds only so many files not sent yet", async () => {
    f = await setup();
    const deps = { db: f.db, blobs: createMemoryBlobStore() };
    const ana = await addUser(f.db, "ana");
    for (let n = 0; n < FEEDBACK_FILES.pending; n++)
      await storeFeedbackFile(deps, ana.id, { name: `${n}.png`, bytes: PNG }, NOW);
    await expect(storeFeedbackFile(deps, ana.id, { name: "more.png", bytes: PNG }, NOW)).rejects.toBeInstanceOf(
      TooManyError,
    );
    // An hour later the old ones no longer count.
    const next = await storeFeedbackFile(deps, ana.id, { name: "new.png", bytes: PNG }, later(FEEDBACK_UNSENT_MS + 1));
    expect(next.name).toBe("new.png");
  });

  test("the job sends the pictures inside the email too", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const ana = await addUser(f.db, "ana");
    const shot = await storeFeedbackFile({ db: f.db, blobs }, ana.id, { name: "s.png", bytes: PNG }, NOW);
    const files = await attachFeedbackFiles(
      f.db,
      { userId: ana.id, orgId: null, ids: [shot.id], publicUrl: "https://chat.example.com" },
      NOW,
    );
    const sender = createFakeEmailSender();
    await sendQueuedFeedback(sender, { key: "k", feedback: { ...feedback, files } }, blobs);
    expect(sender.sent[0]?.inline).toMatchObject([{ cid: "feedback-1", filename: "s.png", contentType: "image/png" }]);
    expect(sender.sent[0]?.html).toContain("cid:feedback-1");
  });

  test("the sweep takes what a purge job missed: a file long past its time, and bytes with no row", async () => {
    f = await setup();
    const blobs = createMemoryBlobStore();
    const deps = { db: f.db, blobs };
    const ana = await addUser(f.db, "ana");
    const old = await storeFeedbackFile(deps, ana.id, { name: "old.png", bytes: PNG }, NOW);
    const fresh = await storeFeedbackFile(deps, ana.id, { name: "fresh.png", bytes: PNG }, later(FEEDBACK_UNSENT_MS));
    await blobs.put(feedbackBlobKey("00000000-0000-4000-8000-00000000dead"), PNG, { contentType: "image/png" });
    // Just past its hour it is still its own job's to remove; an hour later, the sweep's.
    expect(await sweepFeedbackFiles(deps, later(FEEDBACK_UNSENT_MS + 60_000))).toBe(1);
    expect(blobs.objects.has(feedbackBlobKey(old.id))).toBe(true);
    expect(await sweepFeedbackFiles(deps, later(2 * FEEDBACK_UNSENT_MS + 60_000))).toBe(1);
    expect([...blobs.objects.keys()]).toEqual([feedbackBlobKey(fresh.id)]);
  });
});
