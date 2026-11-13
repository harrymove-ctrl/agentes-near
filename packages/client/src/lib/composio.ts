import type { TFunction } from "i18next";
import type { ComposioUsage, ConnectorDef } from "../api/types";
import { formatInt, formatMonth } from "./format";
import { connectorBrand, connectorName } from "./scopes";

/** Uso's line (ADR 0107 §7): "Composio: 1.234 de 5.000 chamadas em novembro", the calls alone without a cap. */
export function composioUsageText(t: TFunction, locale: string, usage: ComposioUsage) {
  const [year = 1970, month = 1] = usage.month.split("-").map(Number);
  const values = { calls: formatInt(locale, usage.calls), month: formatMonth(locale, new Date(year, month - 1, 1)) };
  return usage.limit === null
    ? t("connectors.composio.usageNoLimit", values)
    : t("connectors.composio.usage", { ...values, limit: formatInt(locale, usage.limit) });
}

/** Uso says it once the server counts Composio calls: a cap, or calls made. */
export const showsComposioUsage = (usage: ComposioUsage) => usage.limit !== null || usage.calls > 0;

/** Conectores says it too past 80% of the month's cap. */
export const nearComposioLimit = (usage: ComposioUsage) => usage.limit !== null && usage.calls >= usage.limit * 0.8;

/** What connecting through Composio is (ADR 0107 §4): Composio's page, in English, and its consent naming Composio. */
export const composioConnectText = (t: TFunction, def: Pick<ConnectorDef, "label">) =>
  t("connectFlow.composioHelp", { name: connectorBrand(def) });

/** A service that connects only through Composio, on a server where it can't (ADR 0107 §9): the apps hide it. */
export const hiddenWithoutComposio = (def: Pick<ConnectorDef, "via" | "available" | "soon">) =>
  def.via === "composio" && !def.available && !def.soon;

/**
 * The line that ends the catalog for admins of a server without Composio: the first services it would connect, in
 * the order the apps suggest them, and how many more. Null when Composio connects here or nothing waits on it.
 */
export function composioOffText(t: TFunction, catalog: ConnectorDef[], suggested: readonly string[]) {
  if (catalog.some((d) => d.via === "composio" && d.available)) return null;
  const rank = (d: ConnectorDef) => (suggested.includes(d.id) ? suggested.indexOf(d.id) : suggested.length);
  const hidden = catalog.filter(hiddenWithoutComposio).sort((a, b) => rank(a) - rank(b));
  if (hidden.length < 3) return null;
  const names = hidden.slice(0, 2).map((d) => connectorName(t, d));
  return t("connectors.composio.off", { names: names.join(", "), count: hidden.length - 2 });
}
