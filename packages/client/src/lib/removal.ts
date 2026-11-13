import type { TFunction } from "i18next";
import type { RemovalPreview } from "../api/types";
import { joinNames } from "./format";

/**
 * What the confirmation of "Remover do workspace" (or "Sair do workspace") says, one fact per line, from the server's
 * preview: their access ends, who answers for their agents, which agents lose a plan of theirs, their computers and
 * routines, and that the messages stay. Pure, for the web and the phone app.
 */
export function removalLines(
  t: TFunction,
  p: RemovalPreview,
  who: { name: string; org: string; mine: boolean; meId: string },
): string[] {
  const { name, mine } = who;
  const names = (list: { name: string }[]) =>
    joinNames(
      list.map((x) => x.name),
      t,
    );
  const heir = p.heir ? (p.heir.userId === who.meId ? t("members.remove.you") : p.heir.name) : "";
  const own = mine ? "Mine" : "";
  const lines = [
    mine ? t("members.remove.accessMine") : t("members.remove.access", { name, org: who.org }),
    p.agents.length > 0 &&
      p.heir &&
      t(`members.remove.agents${own}`, { count: p.agents.length, name, heir, names: names(p.agents) }),
    p.losePlan.length > 0 &&
      t(`members.remove.losePlan${own}`, { count: p.losePlan.length, name, names: names(p.losePlan) }),
    p.computers.length > 0 &&
      t(`members.remove.computers${own}`, { count: p.computers.length, name, names: names(p.computers) }),
    p.routines > 0 && t(`members.remove.routines${own}`, { count: p.routines, name }),
    mine ? t("members.remove.messagesMine") : t("members.remove.messages", { name }),
  ];
  return lines.filter((l): l is string => typeof l === "string");
}
