import {
  createFakeComposioClient,
  createFakeMailConnector,
  createFakeMailPoller,
  createFakeMailTester,
  type MailAdapters,
  type MailPreset,
} from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  createImapAccount,
  createLocalKeyWrapper,
  createMailToolSource,
  type MailDeps,
  type MailPolicy,
  type MailToolDeps,
  postPersonMessage,
  setAgentMail,
  startComposioConnect,
  type ToolContext,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";

export const ICLOUD: MailPreset = {
  id: "icloud",
  label: "iCloud",
  imapHost: "imap.mail.me.com",
  imapPort: 993,
  smtpHost: "smtp.mail.me.com",
  smtpPort: 587,
  username: "address",
  appPasswordUrl: "https://account.apple.com",
};

export const PUBLIC_URL = "http://localhost:3000";

/**
 * The engine fixture plus fake mail adapters (Composio and IMAP, one fake
 * mailbox behind both), the mail tool source in the Tool Gateway, and
 * `MailDeps` for accounts and inbound mail. No network.
 */
export async function mailSetup(options: { composio?: boolean; imap?: boolean; publicUrl?: string } = {}) {
  const box = createFakeMailConnector();
  const poller = createFakeMailPoller();
  const tester = createFakeMailTester();
  const composio = createFakeComposioClient();
  const mail: MailAdapters = {
    composio: options.composio === false ? null : { client: composio.client, connector: box.connector },
    imap:
      options.imap === false
        ? null
        : { connector: box.connector, poller: poller.poller, tester: tester.tester, presets: [ICLOUD] },
  };
  const keyWrappers = [createLocalKeyWrapper(SECRET)];
  const toolDeps: MailToolDeps = { keyWrappers, mail, publicUrl: PUBLIC_URL };
  const f = await setup({ toolSources: [createMailToolSource(toolDeps)] });
  toolDeps.artifacts = f.artifactDeps;
  const deps: MailDeps = {
    db: f.db,
    keyWrappers,
    mail,
    publicUrl: options.publicUrl ?? PUBLIC_URL,
    resolveHost: async (host) => (host.endsWith("example.com") ? ["93.184.216.34"] : ["10.0.0.5"]),
    composioPollMs: 0,
  };
  return {
    f,
    deps,
    mail,
    box,
    poller,
    tester,
    composio,
    tools: f.tools as NonNullable<Fixture["tools"]>,
  };
}

export type MailFixture = Awaited<ReturnType<typeof mailSetup>>;

/** An IMAP mailbox `address` (iCloud preset), connected by the owner. */
export async function imapAccount(m: MailFixture, address = "support@example.com") {
  const r = await createImapAccount(m.deps, m.f.owner.id, m.f.org.id, {
    preset: "icloud",
    address,
    password: "app-pass-1234",
  });
  if (!r.ok) throw new Error(`imap account: ${r.error}`);
  return r.account;
}

/** A Gmail mailbox through the fake Composio, already active. */
export async function gmailAccount(m: MailFixture, address = "team@example.com") {
  const { completeComposioConnect } = await import("../src");
  const started = await startComposioConnect(m.deps, m.f.owner.id, m.f.org.id, { provider: "gmail" });
  const link = m.composio.state.links.at(-1);
  if (!link) throw new Error("no connect link");
  m.composio.activate(link.connectedAccountId, address);
  await completeComposioConnect(m.deps, started.accountId);
  return { accountId: started.accountId, connectedAccountId: link.connectedAccountId };
}

export async function giveMail(
  m: MailFixture,
  accountId: string,
  level: "none" | "read" | "read_write",
  policy: Partial<MailPolicy> = {},
  canDelete = false,
) {
  return setAgentMail(m.f.db, m.f.owner.id, m.f.org.id, m.f.agent.id, accountId, {
    level,
    canDelete,
    policy: {
      folders: [],
      senders: [],
      windowDays: null,
      allowedRecipients: [],
      dailySendCap: 25,
      sendWithoutAsking: false,
      fromAddress: null,
      ...policy,
    },
  });
}

/** A run of the agent in #general, as the Tool Gateway sees it. */
export async function runContext(f: Fixture): Promise<ToolContext> {
  const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "check the mail",
  });
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
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run?.id ?? "",
    channelId: f.general.id,
    threadRootId: msg.id,
    triggerMessageId: msg.id,
  };
}
