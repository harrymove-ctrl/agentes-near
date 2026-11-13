import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { DesktopStore, Snapshot } from "./control/store";
import type { Host } from "./host/types";

interface AppServices {
  host: Host;
  store: DesktopStore;
}

const Services = createContext<AppServices | null>(null);

export function AppProvider({ host, store, children }: AppServices & { children: ReactNode }) {
  return <Services.Provider value={{ host, store }}>{children}</Services.Provider>;
}

function useServices(): AppServices {
  const s = useContext(Services);
  if (!s) throw new Error("AppProvider missing");
  return s;
}

export const useHost = () => useServices().host;
export const useStore = () => useServices().store;

/** The runners' state, re-rendering on every change. */
export function useSnapshot(): Snapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
