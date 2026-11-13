/**
 * Test fake — mailboxes (ADR 0038), same shapes as the server's `…/mail/*` and
 * `…/agents/{id}/mail` routes. Off by default (no way in, like a server without
 * email): tests turn it on with `fake.providers = MAIL_PROVIDERS` and add
 * mailboxes through the API. An IMAP connect fails with the code in `fake.nextError`.
 */
import type { AgentMailbox, ApiClient, MailAccount, MailConnectError, MailProviders } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { defaultPolicy } from "@agenteschat/client/lib/mail";
import { clone, MockNotFoundError, mockId } from "./context";

export interface FakeMail {
  client: ApiClient["mail"];
  accounts: MailAccount[];
  providers: MailProviders;
  /** The next IMAP connect or password change fails with this code (once). */
  nextError: MailConnectError | null;
  /** Per agent, per mailbox. */
  agentMail: Map<string, Map<string, AgentMailbox>>;
  /** What `suggestedAddresses` answers (the mailbox's sent folder). */
  suggested: string[];
}

export const MAIL_PROVIDERS: MailProviders = {
  composio: true,
  imap: true,
  presets: [
    {
      id: "icloud",
      label: "iCloud",
      imapHost: "imap.mail.me.com",
      imapPort: 993,
      smtpHost: "smtp.mail.me.com",
      smtpPort: 587,
      username: "address",
      appPasswordUrl: "https://account.apple.com/account/manage",
    },
    {
      id: "locaweb",
      label: "Locaweb",
      imapHost: "email-ssl.com.br",
      imapPort: 993,
      smtpHost: "email-ssl.com.br",
      smtpPort: 465,
      username: "address",
      appPasswordUrl: null,
    },
    {
      id: "zoho",
      label: "Zoho",
      imapHost: "imap.zoho.com",
      imapPort: 993,
      smtpHost: "smtp.zoho.com",
      smtpPort: 465,
      username: "address",
      appPasswordUrl: "https://accounts.zoho.com/home#security/app_password",
    },
  ],
};

export function createFakeMail(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  meId: () => string | null = () => null,
): FakeMail {
  const fake: FakeMail = {
    accounts: [],
    providers: { composio: false, imap: false, presets: [] },
    nextError: null,
    agentMail: new Map(),
    suggested: [],
    client: undefined as unknown as ApiClient["mail"],
  };
  const find = (id: string) => {
    const a = fake.accounts.find((x) => x.id === id);
    if (!a) throw new MockNotFoundError("Mailbox not found");
    return a;
  };
  const failOnce = () => {
    const code = fake.nextError;
    if (!code) return;
    fake.nextError = null;
    throw new ApiError(422, code, code);
  };
  const entry = (agentId: string, accountId: string): AgentMailbox =>
    fake.agentMail.get(agentId)?.get(accountId) ?? {
      accountId,
      level: "none",
      canDelete: false,
      policy: defaultPolicy(),
    };
  fake.client = {
    providers: async (orgId) => {
      log("mail.providers", orgId);
      return clone(fake.providers);
    },
    accounts: async () => clone(fake.accounts),
    connectImap: async (orgId, input) => {
      log("mail.connectImap", orgId, { ...input, password: "[redacted]" });
      failOnce();
      const account: MailAccount = {
        id: mockId("mail"),
        provider: "imap",
        via: "imap",
        address: input.address,
        label: input.label ?? input.address,
        status: "active",
        offActions: [],
        askActions: [],
        aliases: [],
        defaultFrom: null,
        lastError: null,
        preset: input.preset === "custom" ? null : input.preset,
        createdAt: now().toISOString(),
        ownerUserId: meId(),
        agents: [],
      };
      fake.accounts.push(account);
      return clone(account);
    },
    connectComposio: async (orgId, input) => {
      log("mail.connectComposio", orgId, input);
      return { accountId: mockId("mail"), redirectUrl: `https://composio.example/connect/${input.provider}` };
    },
    update: async (orgId, accountId, input) => {
      log("mail.update", orgId, accountId, {
        ...input,
        ...(input.password ? { password: "[redacted]" } : {}),
      });
      if (input.password) failOnce();
      const a = find(accountId);
      if (input.label) a.label = input.label;
      if (input.offActions) a.offActions = [...input.offActions];
      if (input.askActions) a.askActions = [...input.askActions];
      if (input.aliases) a.aliases = input.aliases.map((x) => x.toLowerCase()).filter((x) => x !== a.address);
      if (input.defaultFrom !== undefined) a.defaultFrom = input.defaultFrom === a.address ? null : input.defaultFrom;
      if (input.password) {
        a.status = "active";
        a.lastError = null;
      }
      return clone(a);
    },
    suggestedAddresses: async (orgId, accountId) => {
      log("mail.suggestedAddresses", orgId, accountId);
      find(accountId);
      return [...fake.suggested];
    },
    disconnect: async (orgId, accountId) => {
      log("mail.disconnect", orgId, accountId);
      fake.accounts = fake.accounts.filter((a) => a.id !== accountId);
    },
    folders: async (orgId, accountId) => {
      log("mail.folders", orgId, accountId);
      find(accountId);
      return [
        { id: "INBOX", name: "Caixa de entrada", role: "inbox" },
        { id: "Sent", name: "Enviados", role: "sent" },
        { id: "Clientes", name: "Clientes" },
      ];
    },
    // A mailbox still connecting has no agent access yet, as on the server.
    agent: async (_orgId, agentId) =>
      clone(fake.accounts.filter((a) => a.status !== "pending").map((a) => entry(agentId, a.id))),
    setAgent: async (orgId, agentId, accountId, input) => {
      log("mail.setAgent", orgId, agentId, accountId, input);
      if (input.policy.sendWithoutAsking && input.policy.allowedRecipients.length === 0)
        throw new ApiError(422, "send_without_recipients", "Allowed recipients are required");
      const a = fake.accounts.find((x) => x.id === accountId && x.status !== "pending");
      if (!a) throw new ApiError(404, "mail.account_not_found", "Mailbox not found");
      const saved: AgentMailbox = { accountId, ...clone(input) };
      const byAccount = fake.agentMail.get(agentId) ?? new Map<string, AgentMailbox>();
      byAccount.set(accountId, saved);
      fake.agentMail.set(agentId, byAccount);
      a.agents = a.agents.filter((x) => x.agentId !== agentId);
      if (input.level !== "none") a.agents.push({ agentId, level: input.level, canDelete: input.canDelete });
      return clone(saved);
    },
  };
  return fake;
}
