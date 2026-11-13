import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type {
  ApiClient,
  SecretTarget,
  SecretToVaultInput,
  VaultContactFields,
  VaultItem,
  VaultItemDetail,
  VaultOverview,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { generateSecretKeyPair } from "../../../packages/adapters/src/secret-box";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Settings › Vault and the secret request card's "Save to the Vault" (ADR 0144), against a fake Vault: the lists and
 * their counts, what a member without `manage_credentials` can't do, Show and Copy asking the server, the card saving
 * only after it delivered and only when its box is checked, and a code typed one digit per box.
 */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

const NOW = new Date().toISOString();
const access = (patch: Partial<VaultItem["access"]> = {}): VaultItem["access"] => ({
  everyone: true,
  roleIds: [],
  userIds: [],
  allAgents: false,
  agentIds: [],
  ...patch,
});

function vaultItem(patch: Partial<VaultItem> & Pick<VaultItem, "id" | "kind" | "title">): VaultItem {
  return {
    scope: "team",
    ownerUserId: null,
    description: "",
    website: null,
    match: "exact",
    username: null,
    keyName: null,
    keyHint: null,
    hasSecret: patch.kind !== "contact",
    contact: null,
    connectionId: null,
    sourceName: null,
    accessFromConnection: false,
    access: access(),
    missing: false,
    createdByUserId: "u-walter",
    createdByAgentId: null,
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    can: { edit: true, delete: true },
    ...patch,
  };
}

const LOGIN = vaultItem({
  id: "vi-login",
  kind: "login",
  title: "Acme mail",
  website: "https://mail.acme.example",
  username: "ana@acme.example",
  access: access({ agentIds: [ADA_ID] }),
});
const KEY = vaultItem({
  id: "vi-key",
  kind: "key",
  title: "Payments",
  keyName: "ACME_API_KEY",
  keyHint: "a1b2",
  description: "Test mode",
});
/** A contact as the list has it: no fields (ADR 0144 §7), only its title and description. */
const CONTACT = vaultItem({
  id: "vi-contact",
  kind: "contact",
  scope: "personal",
  ownerUserId: "u-walter",
  title: "Billing details",
  description: "Invoices for the Recife office",
  access: access({ everyone: false, allAgents: true }),
});
/** Its fields: only an item's details carry them. */
const CONTACT_FIELDS = { fullName: "Ana Souza", city: "Recife" };

function overviewOf(patch: Partial<VaultOverview> = {}): VaultOverview {
  return {
    items: [LOGIN, KEY, CONTACT],
    connections: [
      {
        id: "vc-1",
        kind: "onepassword",
        name: "1Password",
        scope: "team",
        ownerUserId: null,
        label: "Agents",
        config: { vaultName: "Agents" },
        access: access(),
        status: "ready",
        errorCode: null,
        itemCount: 3,
        syncedAt: NOW,
        can: { edit: true },
      },
    ],
    sources: [
      {
        kind: "onepassword",
        name: "1Password",
        kinds: ["login", "key"],
        steps: ["Create a vault", "Create a service account", "Paste the token"],
        fields: [{ id: "token", kind: "secret", label: "Service account token", required: true }],
      },
    ],
    canManageTeam: true,
    ...patch,
  };
}

/**
 * A fake Vault over `overview`, every call logged in `state.calls` as `vault.<method>`. An item's details add a
 * contact's fields (`fields`, by id), or say they can't be read (`unreadable`).
 */
function fakeVault(
  state: FakeState,
  overview: VaultOverview,
  details: { fields?: Record<string, VaultContactFields>; unreadable?: string[] } = {
    fields: { [CONTACT.id]: CONTACT_FIELDS },
  },
): NonNullable<ApiClient["vault"]> {
  const log = (method: string, ...args: unknown[]) => state.calls.push({ method: `vault.${method}`, args });
  const find = (id: string) => {
    const item = overview.items.find((i) => i.id === id);
    if (!item) throw new ApiError(404, "not_found", "Not found");
    return item;
  };
  return {
    overview: async (orgId) => {
      log("overview", orgId);
      return structuredClone(overview);
    },
    item: async (orgId, itemId) => {
      log("item", orgId, itemId);
      const listed = structuredClone(find(itemId));
      const unreadable = details.unreadable?.includes(itemId) === true;
      const contact = unreadable ? null : (details.fields?.[itemId] ?? listed.contact);
      const detail: VaultItemDetail = { ...listed, contact, uses: [], unreadable };
      return detail;
    },
    create: async (orgId, input) => {
      log("create", orgId, input);
      const item = vaultItem({ id: `vi-${overview.items.length + 1}`, kind: input.kind, title: input.title });
      overview.items.push(item);
      return structuredClone(item);
    },
    update: async (orgId, itemId, patch) => {
      log("update", orgId, itemId, patch);
      return structuredClone(Object.assign(find(itemId), patch));
    },
    remove: async (orgId, itemId) => {
      log("remove", orgId, itemId);
      overview.items = overview.items.filter((i) => i.id !== itemId);
    },
    importCsv: async (orgId, input) => {
      log("importCsv", orgId, input.scope, input.dryRun);
      return { added: 2, updated: 0, skipped: [], format: "chrome" };
    },
    connect: async (orgId, input) => {
      log("connect", orgId, input.kind, input.scope);
      return structuredClone(overview.connections[0] as VaultOverview["connections"][number]);
    },
    updateConnection: async (orgId, connectionId, patch) => {
      log("updateConnection", orgId, connectionId, patch);
      return structuredClone(overview.connections[0] as VaultOverview["connections"][number]);
    },
    syncConnection: async (orgId, connectionId) => {
      log("syncConnection", orgId, connectionId);
      return structuredClone(overview.connections[0] as VaultOverview["connections"][number]);
    },
    removeConnection: async (orgId, connectionId) => {
      log("removeConnection", orgId, connectionId);
    },
  };
}

async function openVault(state = seedState(), overview = overviewOf(), details?: Parameters<typeof fakeVault>[2]) {
  const api = createFakeApi(state);
  api.vault = fakeVault(state, overview, details);
  const r = await renderApp(`/org/${ORG_ID}/settings/vault`, { api });
  await settle(6);
  // The app's own words, whatever the keys say in this build.
  const t = r.services.i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return { ...r, state, t };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".vlt-row")];

describe("Settings › Vault (ADR 0144)", () => {
  test("lists the team's items and mine, each view with its count, and the connections", async () => {
    const { t } = await openVault();
    expect(document.querySelector(".settings__body h2")?.textContent).toBe(t("settings.section.vault"));
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    const tab = (key: string) => within(views).getByRole("radio", { name: new RegExp(`^${t(key)}`) });
    expect(tab("vault.tab.team").textContent).toContain("2");
    expect(tab("vault.tab.personal").textContent).toContain("1");
    expect(tab("vault.tab.connections").textContent).toContain("1");

    // Team: the login (its site and username, Ada may use it) and the key (its variable, in code).
    expect(rows().map((r) => r.querySelector(".vlt-row__title")?.textContent)).toEqual(["Acme mail", "Payments"]);
    const login = rows()[0] as HTMLElement;
    expect(login.textContent).toContain("mail.acme.example · ana@acme.example");
    expect(login.textContent).toContain("Ada");
    expect(rows()[1]?.querySelector("code")?.textContent).toBe("ACME_API_KEY");
    // Never a value in a list.
    expect(document.body.textContent).not.toContain("hunter2");

    // The search finds by what a person looks it up by.
    const search = screen().getByRole("searchbox", { name: t("vault.list.search") });
    await type(search, "acme_api");
    expect(rows().map((r) => r.querySelector(".vlt-row__title")?.textContent)).toEqual(["Payments"]);
    await type(search, "");

    await click(tab("vault.tab.personal"));
    expect(rows().map((r) => r.querySelector(".vlt-row__title")?.textContent)).toEqual(["Billing details"]);
    // A contact's row: its title and description, never its fields (the list has none).
    expect(rows()[0]?.textContent).toContain("Invoices for the Recife office");
    expect(rows()[0]?.textContent).not.toContain("Ana Souza");
    expect(document.body.textContent).toContain(t("vault.list.personalNote"));

    await click(tab("vault.tab.connections"));
    expect(rows()).toHaveLength(0);
    const card = screen().getByRole("region", { name: "1Password" });
    expect(card.textContent).toContain(t("vault.connections.items", { count: 3 }));
    expect(within(card).getByRole("button", { name: t("vault.connections.syncNow") })).toBeTruthy();
  });

  test("a contact's fields come with its details, and its form starts from them", async () => {
    const { state, t } = await openVault();
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    await click(within(views).getByRole("radio", { name: new RegExp(`^${t("vault.tab.personal")}`) }));
    await click(rows()[0] as HTMLElement);
    await settle(4);
    expect(state.calls.some((c) => c.method === "vault.item" && c.args[1] === CONTACT.id)).toBe(true);
    const dialog = screen().getByRole("dialog", { name: "Billing details" });
    expect((within(dialog).getByLabelText(t("vault.contact.fullName")) as HTMLInputElement).value).toBe("Ana Souza");
    expect((within(dialog).getByLabelText(t("vault.contact.city")) as HTMLInputElement).value).toBe("Recife");
    expect(dialog.textContent).not.toContain(t("vault.item.unreadable"));
    // Nothing changed yet: nothing to save.
    const save = within(dialog).getByRole("button", { name: t("common.save") }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  test("a contact whose saved fields can't be read says so, for its owner to type them again", async () => {
    const { t } = await openVault(seedState(), overviewOf(), { unreadable: [CONTACT.id] });
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    await click(within(views).getByRole("radio", { name: new RegExp(`^${t("vault.tab.personal")}`) }));
    await click(rows()[0] as HTMLElement);
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Billing details" });
    expect(dialog.textContent).toContain(t("vault.item.unreadable"));
    expect((within(dialog).getByLabelText(t("vault.contact.fullName")) as HTMLInputElement).value).toBe("");
    expect(dialog.textContent).not.toContain("Ana Souza");
  });

  test("a full Vault: the connection says so and offers Sync now, not Reconnect", async () => {
    const overview = overviewOf();
    const connection = overview.connections[0] as VaultOverview["connections"][number];
    Object.assign(connection, { status: "error", errorCode: "too_many_items" });
    const { t } = await openVault(seedState(), overview);
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    await click(within(views).getByRole("radio", { name: new RegExp(`^${t("vault.tab.connections")}`) }));
    const card = screen().getByRole("region", { name: "1Password" });
    expect(card.textContent).toContain(t("vault.connections.error.too_many_items"));
    expect(card.textContent).toContain(t("vault.connections.fix.too_many_items"));
    expect(t("vault.connections.error.too_many_items")).not.toBe(t("vault.connections.error.other"));
    expect(within(card).getByRole("button", { name: t("vault.connections.syncNow") })).toBeTruthy();
    expect(
      within(card).queryByRole("button", { name: t("vault.connections.reconnectName", { name: "1Password" }) }),
    ).toBeNull();
  });

  test("a refused connect says why under the token, in 1Password's own words, until the token changes", async () => {
    const r = await openVault(seedState(), overviewOf({ connections: [] }));
    const { t, state } = r;
    const vault = r.services.api.vault as NonNullable<ApiClient["vault"]>;
    let refusal = new ApiError(400, "vault.source.many_vaults", "The service account sees more than one vault.");
    vault.connect = async (orgId, input) => {
      state.calls.push({ method: "vault.connect", args: [orgId, input.kind] });
      throw refusal;
    };
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    await click(within(views).getByRole("radio", { name: new RegExp(`^${t("vault.tab.connections")}`) }));
    const card = screen().getByRole("region", { name: "1Password" });
    await click(within(card).getByRole("button", { name: t("vault.connections.connect") }));
    const token = within(card).getByLabelText(t("vault.source.onepassword.field.token"));
    const connect = async () => {
      await click(within(card).getByRole("button", { name: t("vault.connections.connect") }));
      await settle();
    };
    await type(token, `ops_${"a".repeat(40)}`);
    await connect();
    expect(state.calls.filter((c) => c.method === "vault.connect")).toHaveLength(1);
    expect(within(card).getByRole("alert").textContent).toBe(t("vault.source.onepassword.error.many_vaults"));

    await type(token, `ops_${"b".repeat(40)}`);
    expect(within(card).queryByRole("alert")).toBeNull();

    // A refusal 1Password has no line of its own for reads as any other.
    refusal = new ApiError(429, "vault.source.rate_limited", "1Password asked us to wait before reading more.");
    await connect();
    expect(within(card).getByRole("alert").textContent).toBe(t("errors.vault.source.rateLimited"));
  });

  test("connecting ends as a tool's: who can use it, Ajustar (its access) and Pronto", async () => {
    const made = { ...(overviewOf().connections[0] as VaultOverview["connections"][number]) };
    made.access = access({ allAgents: true });
    const r = await openVault(seedState(), overviewOf({ connections: [] }));
    const { t } = r;
    const vault = r.services.api.vault as NonNullable<ApiClient["vault"]>;
    vault.connect = async () => structuredClone(made);
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    await click(within(views).getByRole("radio", { name: new RegExp(`^${t("vault.tab.connections")}`) }));
    const card = screen().getByRole("region", { name: "1Password" });
    await click(within(card).getByRole("button", { name: t("vault.connections.connect") }));
    await type(within(card).getByLabelText(t("vault.source.onepassword.field.token")), `ops_${"a".repeat(40)}`);
    await click(within(card).getByRole("button", { name: t("vault.connections.connect") }));
    await settle();
    const done = screen().getByRole("dialog", { name: t("connectFlow.done.title", { name: "1Password" }) });
    expect(done.textContent).toContain(t("vault.summary.everyone", { agents: t("vault.summary.allAgents"), count: 1 }));
    expect(within(done).getByRole("button", { name: t("connectFlow.done.ok") })).toBeTruthy();
    await click(within(done).getByRole("button", { name: t("connectFlow.done.adjust") }));
    await settle();
    expect(
      screen().getByRole("dialog", { name: t("vault.connections.accessTitle", { label: "Agents" }) }),
    ).toBeTruthy();
  });

  test("a connection no agent uses says so, with the way to give access", async () => {
    const { t } = await openVault();
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    await click(within(views).getByRole("radio", { name: new RegExp(`^${t("vault.tab.connections")}`) }));
    const card = screen().getByRole("region", { name: "1Password" });
    expect(card.textContent).toContain(t("vault.connections.noAgents"));
    await click(within(card).getByRole("button", { name: t("vault.connections.giveAccess") }));
    await settle();
    expect(
      screen().getByRole("dialog", { name: t("vault.connections.accessTitle", { label: "Agents" }) }),
    ).toBeTruthy();
  });

  test("a write the server refuses says why in a toast, never nothing", async () => {
    const r = await openVault();
    const { t } = r;
    const vault = r.services.api.vault as NonNullable<ApiClient["vault"]>;
    vault.syncConnection = async () => {
      throw new ApiError(400, "vault.source.unreachable", "Couldn't reach the password manager.");
    };
    const views = screen().getByRole("radiogroup", { name: t("vault.tab.label") });
    await click(within(views).getByRole("radio", { name: new RegExp(`^${t("vault.tab.connections")}`) }));
    const card = screen().getByRole("region", { name: "1Password" });
    await click(within(card).getByRole("button", { name: t("vault.connections.syncNow") }));
    await settle();
    expect(document.querySelector(".ac-toast")?.textContent).toContain(t("errors.vault.source.unreachable"));
  });

  test("a member who doesn't manage the Vault: a team item reads only, and new items stay personal", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const shared = { ...LOGIN, can: { edit: false, delete: false } };
    const { t } = await openVault(state, overviewOf({ items: [shared], connections: [], canManageTeam: false }));

    await click(rows()[0] as HTMLElement);
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Acme mail" });
    expect(within(dialog).queryByRole("button", { name: t("common.save") })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: t("vault.item.delete") })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: t("vault.item.change") })).toBeNull();
    const editAgents = t("vault.access.editOf", { what: t("vault.access.agents") });
    expect(within(dialog).queryByRole("button", { name: editAgents })).toBeNull();
    expect((within(dialog).getByLabelText(t("vault.field.username")) as HTMLInputElement).readOnly).toBe(true);
    // The footer's Close (the header's × has the same name).
    await click(
      within(dialog)
        .getAllByRole("button", { name: t("common.close") })
        .at(-1) as HTMLElement,
    );
    await settle(2);

    await click(screen().getByRole("button", { name: t("vault.new.open") }));
    await settle(2);
    const create = screen().getByRole("dialog", { name: t("vault.new.title") });
    const who = within(create).getByRole("radiogroup", { name: t("vault.new.who") });
    for (const option of within(who).getAllByRole("radio")) expect((option as HTMLButtonElement).disabled).toBe(true);
    expect(within(who).getByRole("radio", { checked: true }).textContent).toContain(t("vault.scope.personal"));
    expect(create.textContent).toContain(t("vault.new.teamLocked"));
  });

  test("a saved value stays behind its dots: no Show or Copy, Change for who manages it, and why", async () => {
    const { state, t } = await openVault();
    await click(rows()[0] as HTMLElement);
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Acme mail" });
    const value = within(dialog).getByRole("group", { name: t("vault.field.password") });
    expect(value.textContent).toContain("••••••••••");
    // Its only action is Change.
    expect(
      within(value)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([t("vault.item.change")]);
    expect(dialog.textContent).toContain(t("vault.item.sealedHelp"));
    // Nothing on the page asks for it: the client has no way to.
    expect(state.calls.some((c) => /reveal/i.test(c.method))).toBe(false);
  });
});

/** A pending secret request for me, with `saveToVault` on the fake api (logged as `secrets.saveToVault`). */
async function withRequest(
  target: SecretTarget,
  extra: { name?: string; codeDigits?: number; username?: string } = {},
) {
  const pair = await generateSecretKeyPair();
  const state = seedState();
  const name = extra.name ?? "NPM_TOKEN";
  const secretRequest = {
    id: "00000000-0000-4000-8000-0000000000e1",
    agentId: ADA_ID,
    channelId: ENG_ID,
    threadId: null,
    messageId: "msg-s",
    requestedForUserId: "u-walter",
    name,
    purpose: "publicar o pacote no npm",
    target,
    site: target.kind === "site" ? target.site : null,
    machineId: null,
    publicKey: pair.publicKey,
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    deliveredAt: null,
    removed: false,
    username: extra.username ?? null,
    codeDigits: extra.codeDigits ?? null,
  };
  state.messages.push({
    id: "msg-s",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: `Pedido de segredo: ${name}`,
    mentionedAgentIds: [],
    agentRunId: "r-s",
    meta: { secretRequestId: secretRequest.id, secretRequest },
    createdAt: new Date().toISOString(),
  });
  const api = createFakeApi(state);
  api.secrets.saveToVault = async (orgId: string, requestId: string, input: SecretToVaultInput) => {
    state.calls.push({ method: "secrets.saveToVault", args: [orgId, requestId, input] });
    return vaultItem({ id: "vi-saved", kind: "key", title: name, keyName: name });
  };
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  const t = r.services.i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const card = () => screen().getByRole("group", { name: t("secret.group", { agent: "Ada" }) });
  return { state, t, card };
}

describe("the secret request card: Save to the Vault (ADR 0144)", () => {
  test("checked (the default): saved after it was delivered, for Ada, as mine", async () => {
    const { state, t, card } = await withRequest({ kind: "env" });
    const save = within(card()).getByRole("checkbox", { name: t("vault.card.save") });
    expect(save.getAttribute("aria-checked")).toBe("true");
    // The asking agent is preselected.
    expect(within(card()).getByRole("list", { name: t("vault.card.agents") }).textContent).toContain("Ada");
    await type(within(card()).getByLabelText(t("secret.labelKey", { agent: "Ada" })), "npm_live_abc123");
    await click(within(card()).getByRole("button", { name: t("secret.send") }));
    await settle(6);

    const methods = state.calls
      .map((c) => c.method)
      .filter((m) => m === "secrets.deliver" || m === "secrets.saveToVault");
    expect(methods).toEqual(["secrets.deliver", "secrets.saveToVault"]);
    const call = state.calls.find((c) => c.method === "secrets.saveToVault");
    expect(call?.args.slice(0, 2)).toEqual([ORG_ID, "00000000-0000-4000-8000-0000000000e1"]);
    // A key: no username in it at all.
    expect(call?.args[2]).toStrictEqual({
      value: "npm_live_abc123",
      scope: "personal",
      allAgents: false,
      agentIds: [ADA_ID],
    });
    // The delivery itself never carried the value in the clear.
    expect(JSON.stringify(state.calls.find((c) => c.method === "secrets.deliver")?.args)).not.toContain(
      "npm_live_abc123",
    );
    expect(card().textContent).toContain(t("vault.card.saved"));
  });

  test("a site's password: the username on the card always goes, so one the agent suggested can be cleared", async () => {
    const site = { kind: "site" as const, site: "https://shop.example.com" };
    const { state, t, card } = await withRequest(site, { name: "SHOP_PASSWORD", username: "guessed@shop.example.com" });
    await type(within(card()).getByLabelText(t("vault.field.username")), "  ");
    await type(
      within(card()).getByLabelText(t("secret.labelPassword", { host: "shop.example.com" })),
      "hunter2-for-the-shop",
    );
    await click(within(card()).getByRole("button", { name: t("secret.send") }));
    await settle(6);
    const call = state.calls.find((c) => c.method === "secrets.saveToVault");
    // Empty: no username, not the agent's guess (absent would keep it).
    expect(call?.args[2]).toMatchObject({ value: "hunter2-for-the-shop", username: "" });
  });

  test("unchecked: delivered, and nothing goes to the Vault", async () => {
    const site = { kind: "site" as const, site: "https://shop.example.com" };
    const { state, t, card } = await withRequest(site, { name: "SHOP_PASSWORD", username: "ana@shop.example.com" });
    // A site's password keeps its username with it, prefilled from the request.
    expect((within(card()).getByLabelText(t("vault.field.username")) as HTMLInputElement).value).toBe(
      "ana@shop.example.com",
    );
    await click(within(card()).getByRole("checkbox", { name: t("vault.card.save") }));
    expect(within(card()).queryByLabelText(t("vault.field.username"))).toBeNull();
    await type(
      within(card()).getByLabelText(t("secret.labelPassword", { host: "shop.example.com" })),
      "hunter2-for-real",
    );
    await click(within(card()).getByRole("button", { name: t("secret.send") }));
    await settle(6);
    expect(state.calls.some((c) => c.method === "secrets.deliver")).toBe(true);
    expect(state.calls.some((c) => c.method === "secrets.saveToVault")).toBe(false);
    expect(card().textContent).not.toContain(t("vault.card.saved"));
  });

  test("a verification code: one box per digit, a paste fills them all, and it is never saved", async () => {
    const { state, t, card } = await withRequest(
      { kind: "site", site: "https://shop.example.com" },
      { name: "SHOP_CODE", codeDigits: 6 },
    );
    const code = within(card()).getByRole("group", { name: t("secret.labelCode", { host: "shop.example.com" }) });
    const boxes = within(code).getAllByRole("textbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(6);
    expect(boxes[0]?.getAttribute("aria-label")).toBe(t("vault.card.codeBox", { n: 1, total: 6 }));
    expect(boxes[0]?.getAttribute("autocomplete")).toBe("one-time-code");
    expect(boxes[0]?.getAttribute("inputmode")).toBe("numeric");
    // No "Save to the Vault" for a code.
    expect(within(card()).queryByRole("checkbox", { name: t("vault.card.save") })).toBeNull();
    expect(card().textContent).toContain(t("vault.card.codeWhere", { agent: "Ada", host: "shop.example.com" }));

    // A short code isn't sent.
    await type(boxes[0] as HTMLInputElement, "12");
    await click(within(card()).getByRole("button", { name: t("secret.send") }));
    await settle(2);
    expect(state.calls.some((c) => c.method === "secrets.deliver")).toBe(false);
    expect(card().textContent).toContain(t("vault.card.codeShort", { count: 6 }));

    // The system's suggestion (or a paste) lands in the first box and spreads over all of them.
    await act(async () =>
      fireEvent.paste(boxes[0] as HTMLInputElement, { clipboardData: { getData: () => "48 21 07" } }),
    );
    const filled = within(code).getAllByRole("textbox") as HTMLInputElement[];
    expect(filled.map((b) => b.value)).toEqual(["4", "8", "2", "1", "0", "7"]);
    await click(within(card()).getByRole("button", { name: t("secret.send") }));
    // Sealing the code is WebCrypto, which runs off the JS thread: on a loaded machine it outlasts any number of
    // ticks, so this waits for the delivery instead of counting them.
    await waitFor(() => expect(state.calls.some((c) => c.method === "secrets.deliver")).toBe(true), {
      timeout: 10_000,
    });
    expect(state.calls.some((c) => c.method === "secrets.saveToVault")).toBe(false);
  });
});
