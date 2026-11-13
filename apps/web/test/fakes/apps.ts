/**
 * Test fake — AI apps (ADR 0119), same shapes as the server's `/api/app/authorize/{req}` and `…/apps`, `…/tokens`
 * routes. Tests add consents, connect apps (as an app's sign-in would) and make the next call fail.
 */
import type { ApiClient, AppConsent, ConnectedApp, PersonalToken } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";

export const SERVER_URL = "https://agentes.example/mcp";

export interface FakeApps {
  client: ApiClient["apps"];
  apps: ConnectedApp[];
  tokens: PersonalToken[];
  /** Whether apps on the internet reach this server (a self-hosted one on a private host: false). */
  serverPublic: boolean;
  consents: Map<string, AppConsent & { decided?: boolean; redirectUri: string; state: string }>;
  /** The next call fails with this (once). */
  nextError: ApiError | null;
  /** An app finishes its sign-in: it shows in the list. */
  connect(app: Partial<ConnectedApp> & { name: string }): ConnectedApp;
  addConsent(id: string, patch?: Partial<AppConsent["request"]["client"]>, more?: Partial<AppConsent>): void;
}

let n = 0;

export function createFakeApps(log: (method: string, ...args: unknown[]) => void, now: () => Date): FakeApps {
  const fake: FakeApps = {
    apps: [],
    tokens: [],
    serverPublic: true,
    consents: new Map(),
    nextError: null,
    client: undefined as never,
    connect: (app) => {
      const full: ConnectedApp = {
        id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
        kind: "oauth",
        displayKind: "verified",
        host: null,
        brand: null,
        access: "write",
        connectedAt: now().toISOString(),
        lastUsedAt: null,
        ...app,
      };
      fake.apps.unshift(full);
      return full;
    },
    addConsent: (id, patch = {}, more = {}) => {
      fake.consents.set(id, {
        request: {
          id,
          expiresAt: new Date(now().getTime() + 30 * 60_000).toISOString(),
          access: { requested: ["read", "write"] },
          client: {
            displayKind: "verified",
            name: "Claude",
            host: "claude.ai",
            brand: "claude",
            returnsTo: "claude.ai",
            reservedNameWarning: false,
            ...patch,
          },
        },
        account: { name: "Walter", email: "walter@acme.test" },
        workspaces: [
          { id: "00000000-0000-4000-8000-000000000001", name: "Acme", logo: null, paused: false, current: true },
        ],
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        state: "st4te",
        ...more,
      });
    },
  };
  const failOnce = () => {
    const error = fake.nextError;
    if (!error) return;
    fake.nextError = null;
    throw error;
  };
  const consentOf = (id: string) => {
    const c = fake.consents.get(id);
    if (!c) throw new ApiError(404, "request_unknown", "Unknown request");
    if (c.decided) throw new ApiError(409, "request_used", "Already answered");
    return c;
  };
  fake.client = {
    consent: async (id) => {
      log("apps.consent", id);
      failOnce();
      const { decided: _d, redirectUri: _r, state: _s, ...view } = consentOf(id);
      return structuredClone(view);
    },
    decide: async (id, input) => {
      log("apps.decide", id, input);
      failOnce();
      const c = consentOf(id);
      const back = new URL(c.redirectUri);
      if (input.decision === "deny") back.searchParams.set("error", "access_denied");
      else {
        const org = c.workspaces.find((w) => w.id === input.orgId);
        if (!org) throw new ApiError(403, "not_member", "Not a member");
        if (org.paused) throw new ApiError(409, "workspace_paused", "Paused");
        back.searchParams.set("code", "c0de");
      }
      back.searchParams.set("state", c.state);
      back.searchParams.set("iss", "https://agentes.example");
      c.decided = true;
      return { redirectTo: back.toString() };
    },
    list: async (orgId, all = false) => {
      log("apps.list", orgId, all);
      failOnce();
      const person = { id: "u-joao", name: "João" };
      return structuredClone({
        serverUrl: SERVER_URL,
        serverPublic: fake.serverPublic,
        apps: all ? fake.apps.map((a) => ({ ...a, person: a.person ?? person })) : fake.apps,
        tokens: all ? fake.tokens.map((x) => ({ ...x, person: x.person ?? person })) : fake.tokens,
      });
    },
    disconnect: async (orgId, id) => {
      log("apps.disconnect", orgId, id);
      failOnce();
      fake.apps = fake.apps.filter((a) => a.id !== id);
    },
    createToken: async (orgId, input) => {
      log("apps.createToken", orgId, input);
      failOnce();
      if (fake.tokens.length >= 10) throw new ApiError(409, "token_limit", "Too many tokens");
      const expiresAt =
        input.expiresInDays === null
          ? null
          : new Date(now().getTime() + input.expiresInDays * 86_400_000).toISOString();
      const token: PersonalToken = {
        id: `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`,
        name: input.name,
        access: input.access,
        createdAt: now().toISOString(),
        expiresAt,
        lastUsedAt: null,
      };
      fake.tokens.unshift(token);
      return {
        token: { id: token.id, name: token.name, access: token.access, expiresAt },
        secret: "agp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK",
      };
    },
    revokeToken: async (orgId, id) => {
      log("apps.revokeToken", orgId, id);
      failOnce();
      fake.tokens = fake.tokens.filter((x) => x.id !== id);
    },
  };
  return fake;
}
