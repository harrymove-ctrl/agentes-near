import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  coAuthorOf,
  creditedMessage,
  postPersonMessage,
  SIGNATURE_MARK,
  signatureLine,
  signedBody,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const API = "https://api.github.test";

describe("the line and the credit (ADR 0156)", () => {
  test("a body gets the line once, its names inert; a commit message gets the trailer in its trailer block", () => {
    const line = "Dev, agent for @everyone <b>x</b> on agentes.chat";
    const signed = signedBody("Fixes #1", line);
    expect(signed).toBe(
      `Fixes #1\n\n${SIGNATURE_MARK}\n<sub>Dev, agent for &#64;everyone &#60;b&#62;x&#60;/b&#62; on agentes.chat</sub>`,
    );
    expect(signedBody(signed, "Dev")).toBe(`Fixes #1\n\n${SIGNATURE_MARK}\n<sub>Dev</sub>`);
    // An edit that wrote on after the old line keeps all it wrote; the old line goes.
    expect(signedBody(`${signed}\n\nmore`, "Dev")).toBe(`Fixes #1\n\nmore\n\n${SIGNATURE_MARK}\n<sub>Dev</sub>`);
    expect(signedBody(signed.replaceAll("\n", "\r\n"), "Dev")).toBe(`Fixes #1\n\n${SIGNATURE_MARK}\n<sub>Dev</sub>`);
    // A signed comment quoted in a reply is the reply's text: nothing after it is lost.
    const quoted = `> ${signed.replaceAll("\n", "\n> ")}\n\nAgreed, done in #2.`;
    expect(signedBody(quoted, "Dev")).toBe(`${quoted}\n\n${SIGNATURE_MARK}\n<sub>Dev</sub>`);
    expect(signedBody("", "Dev\nfor Ana")).toBe(`${SIGNATURE_MARK}\n<sub>Dev for Ana</sub>`);
    const trailer = "Co-authored-by: Ana <1+ana@users.noreply.github.com>";
    expect(creditedMessage("Fix login", trailer)).toBe(`Fix login\n\n${trailer}`);
    expect(creditedMessage("Fix: login", trailer)).toBe(`Fix: login\n\n${trailer}`);
    expect(creditedMessage("Fix\n\nBody text here.\n", trailer)).toBe(`Fix\n\nBody text here.\n\n${trailer}`);
    expect(creditedMessage("Fix\n\nRefs: #2", trailer)).toBe(`Fix\n\nRefs: #2\n${trailer}`);
    expect(creditedMessage(`Fix\n\n${trailer}`, trailer)).toBe(`Fix\n\n${trailer}`);
  });

  test("in the workspace owner's language, for the person who asked, else the agent's responsável, else nobody", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect(await signatureLine(f.db, { orgId: f.org.id, agentId: f.agent.id })).toBe(
      "Dev, agente de ana no agentes.chat",
    );

    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, { body: "oi" });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    const ctx = { orgId: f.org.id, agentId: f.agent.id, runId: run?.id };
    expect(await signatureLine(f.db, ctx)).toBe("Dev, agente de bia no agentes.chat");

    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, f.owner.id));
    expect(await signatureLine(f.db, ctx)).toBe("Dev, agent for bia on agentes.chat");
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, f.agent.id));
    await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bia.id));
    expect(await signatureLine(f.db, { orgId: f.org.id, agentId: f.agent.id, runId: run?.id })).toBe(
      "Dev, an agent on agentes.chat",
    );
  });

  test("the trailer only for a linked GitHub account, at GitHub's noreply address; nothing when GitHub doesn't say", async () => {
    f = await setup();
    let answer: Response | null = Response.json({ login: "ana-gh" });
    const asked: string[] = [];
    const http = {
      apiUrl: API,
      fetch: (async (input: string | URL | Request) => {
        asked.push(String(input));
        return answer?.clone() ?? new Response("down", { status: 503 });
      }) as typeof fetch,
    };
    expect(await coAuthorOf({ db: f.db, http }, f.owner.id)).toBeNull();
    expect(asked).toEqual([]);
    await f.db.insert(schema.accounts).values({
      id: crypto.randomUUID(),
      accountId: "9001",
      providerId: "github",
      userId: f.owner.id,
    });
    await f.db.update(schema.users).set({ name: "Ana\n<Lima>" }).where(eq(schema.users.id, f.owner.id));
    expect(await coAuthorOf({ db: f.db, http }, f.owner.id)).toBe(
      "Co-authored-by: AnaLima <9001+ana-gh@users.noreply.github.com>",
    );
    expect(asked).toEqual([`${API}/user/9001`]);

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db.insert(schema.accounts).values({
      id: crypto.randomUUID(),
      accountId: "9002",
      providerId: "github",
      userId: bia.id,
    });
    answer = null;
    expect(await coAuthorOf({ db: f.db, http }, bia.id)).toBeNull();
  });
});
