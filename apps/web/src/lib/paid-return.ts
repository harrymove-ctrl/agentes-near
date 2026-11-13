import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";

/**
 * Back from a paid Checkout (`isPaidReturn`), until the hold lifts. Read from the address itself, since only some
 * routes keep `paid` in their search, and kept for the tab, since the first move to another page drops it.
 */
export function usePaidReturn(orgId: string, held: boolean) {
  const key = `${STORAGE_KEYS.paidReturn}.${orgId}`;
  const search = useSearch({ strict: false });
  const inAddress =
    isPaidReturn(search) || isPaidReturn(Object.fromEntries(new URLSearchParams(window.location.search)));
  useEffect(() => {
    if (!held) sessionStore.remove(key);
    else if (inAddress) sessionStore.set(key, "1");
  }, [held, inAddress, key]);
  return held && (inAddress || sessionStore.get(key) === "1");
}
