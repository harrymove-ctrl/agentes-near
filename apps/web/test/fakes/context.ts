/**
 * In-memory stand-ins used by the tests' fake backend (test/fake-api.ts) for
 * the newer endpoints: artifacts, storage, issues/routines/calendar and custom
 * MCP servers. Same shapes as apps/server/src/routes/app/*; nothing here ships.
 */
import type { Agent, Channel, Me, Member, Message } from "@agenteschat/client";

export interface MockContext {
  seed: boolean;
  now: () => Date;
  /** Real data the seeds attach to. */
  lookup: {
    me(): Promise<Me | null>;
    agents(orgId: string): Promise<Agent[]>;
    channels(orgId: string): Promise<Channel[]>;
    members(orgId: string): Promise<Member[]>;
    /** Every message (any channel), as the chat fake holds them. */
    messages?(orgId: string): Promise<Message[]>;
    /** Direct conversations: their channel and the other participant. */
    dms?(orgId: string): Promise<{ channelId: string; with: { type: "person" | "agent"; id: string } }[]>;
  };
}

let counter = 0;
export const mockId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

export const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString();
export const hoursFromNow = (now: Date, h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();

/** Lazily seeded per-organization store. */
export function perOrg<T>(init: (orgId: string) => Promise<T>) {
  const stores = new Map<string, Promise<T>>();
  return (orgId: string) => {
    let store = stores.get(orgId);
    if (!store) {
      store = init(orgId);
      stores.set(orgId, store);
    }
    return store;
  };
}

export class MockNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
}

export const clone = <T>(value: T): T => structuredClone(value);
