import { useSyncExternalStore } from "react";

/**
 * "Criar um workspace novo" from Adicionar workspace (ADR 0154): the first run opens on that server once someone is
 * signed in there (straight away, or after its sign-in), until a new workspace is chosen or they go back. `from` is
 * the workspace open when the first run showed (undefined until then): another one chosen means it was made.
 */
export interface NewWorkspaceAsk {
  server: string;
  from?: string | null;
}

let asked: NewWorkspaceAsk | null = null;
const listeners = new Set<() => void>();

function set(next: NewWorkspaceAsk | null) {
  asked = next;
  for (const listener of listeners) listener();
}

export const askNewWorkspace = (server: string) => set({ server });

/** The first run showed over `from`. */
export const newWorkspaceShown = (from: string | null) => {
  if (asked && asked.from === undefined) set({ ...asked, from });
};

export const newWorkspaceDone = () => set(null);

export function useNewWorkspaceAsk() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => asked,
  );
}

/**
 * Whether the ask is over (pure): asked on another server, or a workspace other than the one open when the first run
 * showed is open now (the new one, chosen at the end of the first run).
 */
export const newWorkspaceMade = (ask: NewWorkspaceAsk, open: string | null) =>
  ask.from !== undefined && open !== ask.from;
