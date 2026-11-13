import type { Approval } from "../api/types";
import { plainLine } from "./markdown";
import type { Words } from "./routine-view";

/**
 * An approval asked while nobody was watching (ADR 0053 §8), in words: "Pedido pela rotina «X» enquanto
 * ninguém acompanhava", or "Pedido enquanto ninguém acompanhava". Null when a person was there.
 */
export function approvalOriginWords(a: Pick<Approval, "origin">): Words | null {
  const o = a.origin;
  if (!o) return null;
  if (o.kind === "routine" && o.routineName) return { key: "approval.origin.routine", values: { name: o.routineName } };
  return { key: "approval.origin.unattended", values: {} };
}

/** Why the agent asks, trimmed; null when it said nothing. */
export const approvalWhy = (a: Pick<Approval, "why">) => (a.why ? plainLine(a.why) : "") || null;
/** The same why on one line with its marks kept (code between backticks, bold), for a card that draws them. */
export const approvalWords = (a: Pick<Approval, "why">) => a.why?.replace(/\s+/g, " ").trim() || null;

/** The same, short, on the line of who asks: "rotina «X»", "sem ninguém acompanhando". */
export function approvalOriginShort(a: Pick<Approval, "origin">): Words | null {
  const o = a.origin;
  if (!o) return null;
  if (o.kind === "routine" && o.routineName) {
    return { key: "approval.originShort.routine", values: { name: o.routineName } };
  }
  return { key: "approval.originShort.unattended", values: {} };
}
