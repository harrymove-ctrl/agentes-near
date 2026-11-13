import type { ReactNode } from "react";

/** The scrolling main column next to the sidebar (non-chat pages). */
export function Main({ children }: { children: ReactNode }) {
  return <main className="shell__main">{children}</main>;
}
