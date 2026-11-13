/**
 * Pairing this computer from the app itself, the Cloud included. A workspace the person is signed in to: the card the
 * app shows once after sign-in and Preferences › This Mac pair it with the main window's session, which confirms the
 * runner's code. A pair link from the web (`agenteschat://pair`, checked in `deep_link.rs`): the runner asks with the
 * link, and the link's maker lets it in on the web. Either way the person confirmed in the app first.
 */
import type { DeviceAudience } from "@agenteschat/client";
import { normalizeUserCode } from "@agenteschat/client/lib/machines";
import type { Host } from "../host/types";
import { siteApi } from "./devices";
import { appServer, homeServer, type ServerWorkspaces } from "./server";
import { type DesktopStore, isPairedHome, isUnpairedHome, type Snapshot } from "./store";
import { connect, type PairTools, whenPaired } from "./this-mac";

/** A workspace this computer could work for: offered once after sign-in, and listed in Preferences. */
export interface PairTarget {
  server: string;
  orgId: string;
  name: string;
  logo: string | null;
}

/** What a pair link's server says about it (`pair_link_info`); `computer`: this computer's own name, when known. */
export interface LinkInfo {
  org: string;
  by: string;
  kind: "computer" | "server";
  expiresAt: string;
  computer: string | null;
}

/** The workspace the welcome window offers this computer to (taken once), and those already offered (never again). */
export const PAIR_OFFER_PREF = "pairOffer";
export const PAIR_OFFERED_PREF = "pairOffered";

export const targetKey = (t: Pick<PairTarget, "server" | "orgId">) => `${t.server} ${t.orgId}`;

const PAIR_LINK = /^agenteschat:\/\/pair\/?\?(.*)$/i;

/** `agenteschat://pair?server=&link=` as Rust hands it over: the server and the code as stored (`ABCDEFGH`). */
export function parsePairLink(raw: string): { server: string; code: string } | null {
  const query = PAIR_LINK.exec(raw.trim())?.[1];
  if (query === undefined) return null;
  const fields = new URLSearchParams(query);
  const server = appServer(fields.get("server") ?? "");
  const code = normalizeUserCode(fields.get("link") ?? "");
  return server && code.length === 8 ? { server, code } : null;
}

/**
 * The workspaces this computer could work for and doesn't yet: signed in there, on a server where agents may work
 * here, and the person may pair a computer with it.
 */
export function unpairedWorkspaces(list: readonly ServerWorkspaces[], snap: Snapshot): PairTarget[] {
  const paired = new Set(
    snap.homes
      .filter(isPairedHome)
      .map((h) => targetKey({ server: homeServer(h) ?? "", orgId: h.status?.org?.id ?? "" })),
  );
  return list.flatMap((s) =>
    s.signedIn && s.agentsHere
      ? s.orgs
          .filter((o) => o.pair && !paired.has(targetKey({ server: s.server, orgId: o.id })))
          .map((o) => ({ server: s.server, orgId: o.id, name: o.name, logo: o.logo }))
      : [],
  );
}

const signedIn = (list: readonly ServerWorkspaces[]) =>
  new Set(list.flatMap((s) => (s.signedIn ? s.orgs.map((o) => targetKey({ server: s.server, orgId: o.id })) : [])));

/**
 * The next workspace to offer this computer to once, if any: one the person signed in to (or made) since the list
 * read `before`. The first read (`before` null) offers nothing, so a session that was already there never opens a
 * window by itself, and neither does an unread count changing. None until every running home said whether it is
 * paired: a home still starting would read as a workspace this computer doesn't work for.
 */
export function nextOffer(
  list: readonly ServerWorkspaces[],
  before: readonly ServerWorkspaces[] | null,
  snap: Snapshot,
  offered: readonly string[],
) {
  if (!before || !snap.loaded || snap.homes.some((h) => h.running && !h.status)) return null;
  const had = signedIn(before);
  return unpairedWorkspaces(list, snap).find((t) => !had.has(targetKey(t)) && !offered.includes(targetKey(t))) ?? null;
}

/**
 * Pairs this computer with `target`'s workspace using the main window's session there: the runner's code, confirmed
 * by the app, who may use it when that isn't only the person, and the tools they chose. The person already said yes
 * in the app.
 */
export async function pairWithSession(
  host: Host,
  store: DesktopStore,
  target: PairTarget,
  audience?: DeviceAudience,
  tools?: Partial<PairTools>,
) {
  const { userCode } = await connect({ store, tools }, target.orgId, target.server);
  if (!userCode) return;
  const api = siteApi(host, target.server);
  const machine = await api.machines.confirmDevice(target.orgId, userCode, {});
  if (audience && audience.mode !== "owner") await api.devices.updateComputer(target.orgId, machine.id, { audience });
}

/** How a link pairing ended badly: `pair.failed`'s code. */
export type LinkFailure = "expired" | "denied" | "network" | "internal" | "link_invalid";

/**
 * Pairs this computer with a connect link: a home of its own (one left unpaired, or a new one), then the runner asks
 * the server with the link and waits for the link's maker; once in, the tools the person chose. `done` resolves with
 * the workspace's name, or rejects with a `LinkFailure`; `cancel` stops waiting.
 */
export async function pairWithLink(store: DesktopStore, server: string, code: string, tools: Partial<PairTools> = {}) {
  const homeId = store.getSnapshot().homes.find(isUnpairedHome)?.homeId ?? (await store.addHome());
  let stop = () => {};
  const done = new Promise<string>((resolve, reject) => {
    const off = store.onEvent((id, event) => {
      if (id !== homeId) return;
      if (event.kind === "pair.done") {
        off();
        resolve(event.org.name);
      } else if (event.kind === "pair.failed") {
        off();
        reject(new Error(event.code));
      }
    });
    stop = () => {
      off();
      reject(new Error("canceled"));
    };
  });
  // The caller may never look at `done` after a cancel.
  done.catch(() => {});
  whenPaired(store, homeId, tools);
  try {
    await store.request(homeId, { type: "pair.start", server, link: code });
  } catch (err) {
    stop();
    throw err;
  }
  return {
    done,
    cancel: async () => {
      stop();
      await store.request(homeId, { type: "pair.cancel" }).catch(() => {});
    },
  };
}
