import { createContext, useContext } from "react";

/** Opens an agent's computer in the workspace's one dialog (`ComputerDialogProvider`). */
export const OpenComputerContext = createContext<((agentId: string) => void) | null>(null);

const noop = () => {};

/** Opens an agent's computer in place; does nothing outside a workspace's pages. */
export const useOpenComputer = (): ((agentId: string) => void) => useContext(OpenComputerContext) ?? noop;

/**
 * The agent whose computer the dialog shows now, or null: a card behind it leaves the screen to the dialog's own
 * view (ADR 0058 §7), so one person never holds two streams of one screen.
 */
export const OpenedComputerContext = createContext<string | null>(null);

export const useOpenedComputer = (): string | null => useContext(OpenedComputerContext);
