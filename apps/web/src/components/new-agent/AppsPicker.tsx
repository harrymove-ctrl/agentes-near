import type { ConnectorDef } from "@agenteschat/client";
import { hiddenWithoutComposio } from "@agenteschat/client/lib/composio";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { connectorDescription, connectorName } from "@agenteschat/client/lib/scopes";
import { Button, Dialog, DialogBody, DialogFooter, GroupHeading, Icon, SearchField } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectorIcon, searchCatalog } from "@/components/ConnectorCatalog";

/**
 * "Outro app" on a new agent's card (ADR 0164): the catalog as rows, its starting point's apps on top. A connected
 * app is used at once ("Usar"); another runs the usual connect flow (the card's own `ConnectFlow`), then lands on the
 * card. Nothing here leaves the card for Settings.
 */
export function AppsPickerDialog({
  agentName,
  connectors,
  suggested,
  connected,
  onCard,
  canConnect,
  onUse,
  onConnect,
  onClose,
}: {
  agentName: string;
  /** The catalog. */
  connectors: ConnectorDef[];
  /** Its starting point's apps (catalog ids), in order. */
  suggested: string[];
  /** Catalog ids connected in the workspace. */
  connected: Set<string>;
  /** Catalog ids already on the card. */
  onCard: Set<string>;
  /** Whoever opened it may connect apps for the workspace. */
  canConnect: boolean;
  onUse: (def: ConnectorDef) => void;
  onConnect: (def: ConnectorDef) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const g = agentGrammar(agentName);
  // What may be offered: ready on this server, and through Composio only where it is on (or already connected).
  const offered = connectors.filter(
    (d) => d.available && !d.soon && (!hiddenWithoutComposio(d) || connected.has(d.id)),
  );
  const found = searchCatalog(offered, q, (d) => `${connectorName(t, d)} ${connectorDescription(t, d)}`);
  const byName = (a: ConnectorDef, b: ConnectorDef) => connectorName(t, a).localeCompare(connectorName(t, b));
  const top = suggested.flatMap((id) => found.filter((d) => d.id === id));
  const rest = found.filter((d) => !suggested.includes(d.id));
  // The rest: what is connected here first (one click away), then the catalog by name.
  const groups = [
    {
      id: "suggested",
      title: agentName ? t("newAgentCard.picker.suggested", g) : t("newAgentCard.picker.suggestedBlank"),
      list: top,
    },
    {
      id: "connected",
      title: t("connectors.connectedFilter"),
      list: rest.filter((d) => connected.has(d.id)).sort(byName),
    },
    { id: "more", title: t("connectors.more"), list: rest.filter((d) => !connected.has(d.id)).sort(byName) },
  ].filter((group) => group.list.length > 0);

  const action = (d: ConnectorDef) =>
    onCard.has(d.id) ? (
      <span className="nac-pick__on ac-iconline">
        <Icon name="check" size={16} />
        <span>{t("newAgentCard.picker.added")}</span>
      </span>
    ) : connected.has(d.id) ? (
      <Button size="sm" onClick={() => onUse(d)}>
        {t("newAgentCard.picker.use")}
      </Button>
    ) : canConnect ? (
      <Button size="sm" onClick={() => onConnect(d)}>
        {t("agentSetup.firstRun.apps.connect")}
      </Button>
    ) : null;
  const row = (d: ConnectorDef) => {
    const name = connectorName(t, d);
    return (
      // The icon beside two lines: the name's capitals at its top, the action on the name's line.
      <li key={d.id} className="nac-pick__row ac-faceline">
        <ConnectorIcon def={d} label={name} />
        <span className="nac-pick__text">
          <b className="ac-captop">{name}</b>
          <small>{connectorDescription(t, d)}</small>
        </span>
        <span className="ac-captail ac-captop">{action(d)}</span>
      </li>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={agentName ? t("newAgentCard.picker.title", g) : t("newAgentCard.picker.titleBlank")}
      description={t("newAgentCard.picker.lead")}
      closeLabel={t("common.close")}
      width={560}
      className="nac-pick"
    >
      <DialogBody>
        <SearchField
          size="sm"
          className="nac-pick__search"
          aria-label={t("connectors.search")}
          placeholder={t("connectors.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onClear={() => setQ("")}
          clearLabel={t("filters.clearSearch")}
        />
        {groups.length === 0 ? (
          <p className="small muted">{t("connectors.empty", { q: q.trim() })}</p>
        ) : (
          groups.map((group) => (
            <section key={group.id} className="nac-pick__group" aria-labelledby={`nac-pick-${group.id}`}>
              <GroupHeading level={3} id={`nac-pick-${group.id}`} title={group.title} />
              <ul className="nac-pick__list">{group.list.map(row)}</ul>
            </section>
          ))
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          {t("newAgentCard.app.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
