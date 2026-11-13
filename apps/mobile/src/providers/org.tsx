import { type OrgSummary, useApi, useMe } from "@agenteschat/client";
import { useLocaleSync } from "@agenteschat/client/lib/locale-sync";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { accountFailed, chooseOrg, openOrgs } from "@/lib/org-choice";
import { orgValueName, useServer } from "@/lib/server";
import { readValue, writeValue } from "@/lib/storage";
import { deviceLocale, i18n, readLocaleState, rememberLocale, setLocale } from "./i18n";
import { useSession } from "./session";

export interface OrgState {
  /** The current organization (always set inside the app's screens). */
  orgId: string;
  org: OrgSummary | null;
  orgs: OrgSummary[];
  setOrgId: (orgId: string) => void;
}

interface OrgGate {
  /** Loading `me` or the remembered choice. */
  loading: boolean;
  /** Signed in with no workspace to open yet: none, or only one they are still setting up (`openOrgs`). */
  none: boolean;
  /**
   * `me` failed and nothing is cached (the server is down or out of reach): not "no organization", which would
   * open the first run.
   */
  unreachable: boolean;
  /** Asks for `me` again (the unreachable screen's "Tentar de novo"). */
  retry: () => Promise<unknown>;
  state: OrgState | null;
  /** Makes an organization the current one (an invitation accepted, a workspace created in the first run). */
  choose: (orgId: string) => void;
}

/** How many times `me` is asked again while signed in and still null, and how long apart (ms). */
const STALE_TRIES = 3;
const STALE_RETRY_MS = 700;

const OrgContext = createContext<OrgGate>({
  loading: true,
  none: false,
  unreachable: false,
  retry: async () => {},
  state: null,
  choose: () => {},
});

/**
 * The current organization: remembered in SecureStore for each server (ADR 0154), switched by `setOrgId` (and by a
 * push's `orgId`).
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const server = useServer();
  const session = useSession();
  const api = useApi();
  // The person's language here and on the server, matched once their `me` arrives (ADR 0122).
  useLocaleSync({
    user: me.data?.user,
    read: readLocaleState,
    detected: deviceLocale,
    apply: (code, store) => {
      rememberLocale(store, false);
      if (code !== i18n.language) setLocale(code);
    },
    send: (patch) => api.account.updateMe(patch),
  });
  const [remembered, setRemembered] = useState<string | null | undefined>(undefined);

  // `me` answered while signed out (null) a moment before the session arrived is not "no organization": that
  // opened the first run over someone with workspaces (signing in with the web's QR code). It is still loading
  // until `me` is asked again with the session (SessionProvider does it; here a few more times while it stays
  // null, then the session itself is read again, and one the server no longer knows ends there).
  const stale = session.signedIn && me.data === null;
  const tries = useRef(0);
  const { refetch } = me;
  const { refresh } = session;
  useEffect(() => {
    if (!stale) {
      tries.current = 0;
      return;
    }
    if (me.isFetching || tries.current >= STALE_TRIES) return;
    const timer = setTimeout(() => {
      tries.current += 1;
      void refetch().then((r) => {
        if (r.data === null && tries.current >= STALE_TRIES) void refresh();
      });
    }, STALE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [stale, me.isFetching, refetch, refresh]);

  // Each server remembers its own: read again when the app moves to another.
  useEffect(() => {
    let alive = true;
    setRemembered(undefined);
    readValue(orgValueName(server)).then((v) => {
      if (alive) setRemembered(v);
    });
    return () => {
      alive = false;
    };
  }, [server]);

  const setOrgId = useCallback(
    (orgId: string) => {
      setRemembered(orgId);
      void writeValue(orgValueName(server), orgId);
    },
    [server],
  );

  const orgs = useMemo(() => openOrgs(me.data?.organizations ?? []), [me.data]);
  const orgId = remembered === undefined ? null : chooseOrg(orgs, remembered);
  const unreachable = accountFailed(me.isError, me.data);
  // From the top: one still null reads the session again at the end of its tries.
  const retry = useCallback(() => {
    tries.current = 0;
    return refetch();
  }, [refetch]);
  const value = useMemo<OrgGate>(() => {
    const base = { unreachable, retry, choose: setOrgId };
    const loading = me.isPending || remembered === undefined || stale;
    if (loading || unreachable) return { ...base, loading, none: false, state: null };
    if (!orgId) return { ...base, loading: false, none: true, state: null };
    return {
      ...base,
      loading: false,
      none: false,
      state: { orgId, org: orgs.find((o) => o.id === orgId) ?? null, orgs, setOrgId },
    };
  }, [me.isPending, stale, unreachable, retry, remembered, orgId, orgs, setOrgId]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

/** For the root gate: whether the organization is known yet. */
export const useOrgGate = () => useContext(OrgContext);

/** The current organization. Only inside the app's screens (the gate guarantees one). */
export function useOrg(): OrgState {
  const { state } = useContext(OrgContext);
  if (!state) throw new Error("useOrg is only available once an organization is chosen");
  return state;
}

/** Like `useOrg`, but null instead of throwing (providers that also run outside the app's screens). */
export const useOrgMaybe = (): OrgState | null => useContext(OrgContext).state;
