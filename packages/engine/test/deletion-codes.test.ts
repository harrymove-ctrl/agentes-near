import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { eq, like, schema } from "@agenteschat/db";
import { CODE_TTL_MS, createOrganization, renderEmail, sendDeletionCode, spendDeletionCode } from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A clock the codes and their rate limiter both read, moved by the test. */
function clock() {
  let at = Date.parse("2026-10-31T12:00:00Z");
  return { now: () => new Date(at), ms: () => at, pass: (ms: number) => (at += ms) };
}

const emails = { publicUrl: "https://chat.example.com/", support: "help@example.com" };

async function codes(c: ReturnType<typeof clock>) {
  f = await setup();
  return { db: f.db, rateLimiter: createMemoryRateLimiter(c.ms), emails };
}

/** The deletion codes' emails queued so far, oldest first. */
const sentMail = async () =>
  (await f.db.select().from(schema.outbox).where(like(schema.outbox.dedupeKey, "email:deletion-code:%")))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((job) => ({ ...job, payload: job.payload as { to: string[]; template: Record<string, unknown> } }));
const lastCode = async () => String((await sentMail()).at(-1)?.payload.template.code ?? "");
/** The error code a call is refused with, or "ok". */
const answer = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );

describe("the code that proves it's you before deleting (ADR 0088 §2)", () => {
  test("it goes to the account's own address, says what it deletes, and is kept only as a hash", async () => {
    const c = clock();
    const deps = await codes(c);
    expect(await sendDeletionCode(deps, f.owner.id, f.org.id, c.now())).toEqual({
      email: f.owner.email,
      resendIn: 60,
    });
    const [mail] = await sentMail();
    const code = String(mail?.payload.template.code ?? "");
    expect(code).toMatch(/^\d{6}$/);
    expect(mail?.orgId).toBeNull();
    expect(mail?.payload.to).toEqual([f.owner.email]);
    expect(mail?.payload.template).toEqual({
      kind: "deletion_code",
      locale: "pt-BR",
      code,
      email: f.owner.email,
      orgName: f.org.name,
      support: "help@example.com",
      url: "https://chat.example.com",
    });
    const rows = await f.db.select().from(schema.verifications);
    expect(rows.map((r) => r.identifier)).toEqual([`deletion-code:${f.owner.id}:workspace:${f.org.id}`]);
    expect(rows[0]?.value).not.toContain(code);

    // The account's own, with its address and no workspace.
    c.pass(1000);
    await sendDeletionCode(deps, f.owner.id, null, c.now());
    const account = (await sentMail()).at(-1)?.payload.template ?? {};
    expect([account.email, "orgName" in account]).toEqual([f.owner.email, false]);
  });

  test("bound to the person and what it deletes, and spent once", async () => {
    const c = clock();
    const deps = await codes(c);
    const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Other" });
    const bia = await addUser(f.db, "bia");
    await sendDeletionCode(deps, f.owner.id, f.org.id, c.now());
    const code = await lastCode();
    expect(await answer(spendDeletionCode(deps, f.owner.id, null, code, c.now()))).toBe("reauth.code_wrong");
    expect(await answer(spendDeletionCode(deps, f.owner.id, other.id, code, c.now()))).toBe("reauth.code_wrong");
    expect(await answer(spendDeletionCode(deps, bia.id, f.org.id, code, c.now()))).toBe("reauth.code_wrong");
    expect(await answer(spendDeletionCode(deps, f.owner.id, f.org.id, code, c.now()))).toBe("ok");
    expect(await answer(spendDeletionCode(deps, f.owner.id, f.org.id, code, c.now()))).toBe("reauth.code_wrong");
    expect(await f.db.select().from(schema.verifications)).toEqual([]);
  });

  test("five wrong tries use a code up, and an account gets ten wrong tries a day", async () => {
    const c = clock();
    const deps = await codes(c);
    await sendDeletionCode(deps, f.owner.id, f.org.id, c.now());
    const right = await lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    const tries: string[] = [];
    for (let i = 0; i < 5; i++) tries.push(await answer(spendDeletionCode(deps, f.owner.id, f.org.id, wrong, c.now())));
    expect(tries).toEqual([...Array(4).fill("reauth.code_wrong"), "reauth.code_tries"]);
    expect(await answer(spendDeletionCode(deps, f.owner.id, f.org.id, right, c.now()))).toBe("reauth.code_tries");

    // A new code works, and a right one counts against nothing: 8 wrong tries so far today.
    c.pass(61_000);
    await sendDeletionCode(deps, f.owner.id, f.org.id, c.now());
    const next = await lastCode();
    const other = next === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await spendDeletionCode(deps, f.owner.id, f.org.id, other, c.now()).catch(() => null);
    expect(await answer(spendDeletionCode(deps, f.owner.id, f.org.id, next, c.now()))).toBe("ok");

    // The tenth, on another deletion's code: past it a right code is refused unread, and no code goes out.
    c.pass(61_000);
    await sendDeletionCode(deps, f.owner.id, null, c.now());
    const account = await lastCode();
    const miss = account === "000000" ? "111111" : "000000";
    for (let i = 0; i < 2; i++)
      expect(await answer(spendDeletionCode(deps, f.owner.id, null, miss, c.now()))).toBe("reauth.code_wrong");
    expect(await answer(spendDeletionCode(deps, f.owner.id, null, account, c.now()))).toBe("reauth.code_limit");
    const mails = (await sentMail()).length;
    expect(await answer(sendDeletionCode(deps, f.owner.id, null, c.now()))).toBe("reauth.code_limit");
    expect(await sentMail()).toHaveLength(mails);
    c.pass(86_400_000);
    await sendDeletionCode(deps, f.owner.id, null, c.now());
    expect(await answer(spendDeletionCode(deps, f.owner.id, null, await lastCode(), c.now()))).toBe("ok");
  });

  test("it works for 10 minutes; another goes after 60 s, 5 an hour and 10 a day", async () => {
    const c = clock();
    const deps = await codes(c);
    await sendDeletionCode(deps, f.owner.id, f.org.id, c.now());
    const code = await lastCode();
    c.pass(59_000);
    const early = await sendDeletionCode(deps, f.owner.id, f.org.id, c.now()).catch((e) => e);
    expect([early.code, early.params]).toEqual(["reauth.code_wait", { retryIn: 1 }]);
    c.pass(CODE_TTL_MS - 59_000);
    expect(await answer(spendDeletionCode(deps, f.owner.id, f.org.id, code, c.now()))).toBe("reauth.code_expired");

    const sends: string[] = [];
    const send = async () => {
      c.pass(61_000);
      sends.push(await answer(sendDeletionCode(deps, f.owner.id, f.org.id, c.now())));
    };
    for (let i = 0; i < 5; i++) await send();
    expect(sends).toEqual([...Array(4).fill("ok"), "reauth.code_limit"]);
    c.pass(3_600_000);
    sends.length = 0;
    for (let i = 0; i < 6; i++) await send();
    expect(sends).toEqual([...Array(5).fill("ok"), "reauth.code_limit"]);
    c.pass(3_600_000);
    await send();
    expect(sends.at(-1)).toBe("reauth.code_limit");
  });

  test("the email: what goes, for how long, and what to do if it wasn't you, in each language", async () => {
    const workspace = renderEmail({
      kind: "deletion_code",
      locale: "en",
      code: "482913",
      email: "ana@souzabakery.com",
      orgName: "Souza Bakery",
      support: "help@agentes.chat",
      url: "https://chat.example.com",
    });
    expect(workspace.subject).toBe("482913 is your code to delete a workspace");
    expect(workspace.text).toContain(
      "Type this code to delete the workspace Souza Bakery. It turns read-only for everyone at once and is deleted for good 7 days later.",
    );
    expect(workspace.text).toContain("If it wasn't you, don't share it and write to help@agentes.chat.");
    const account = renderEmail({
      kind: "deletion_code",
      locale: "pt-BR",
      code: "482913",
      email: "ana@padariasouza.com.br",
      support: null,
      url: "https://chat.example.com",
    });
    expect(account.subject).toBe("482913 é seu código para apagar sua conta inteira");
    // The address is inert, as every name in an email is (ADR 0069).
    expect(account.text).toContain("Digite este código para apagar a conta inteira ana@");
    expect(account.text).toContain(
      "Ela sai de todos os aparelhos na hora e é apagada de vez 7 dias depois, e os workspaces em que só você está fecham com ela.",
    );
    expect(account.text).toContain("Se não foi você, não passe para ninguém e avise quem cuida deste servidor.");
  });

  test("a blocked account gets no code", async () => {
    const c = clock();
    const deps = await codes(c);
    await f.db.update(schema.users).set({ blockedAt: c.now() }).where(eq(schema.users.id, f.owner.id));
    expect(await answer(sendDeletionCode(deps, f.owner.id, f.org.id, c.now()))).toBe("forbidden");
    expect(await sentMail()).toEqual([]);
  });
});
