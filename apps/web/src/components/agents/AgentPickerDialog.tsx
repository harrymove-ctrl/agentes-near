import type { Agent, AgentAccess } from "@agenteschat/client";
import { levelOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { type ConnectedItem, itemName } from "@agenteschat/client/lib/connected";
import { Chip, Dialog, DialogSearchList, Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectedById } from "@/components/AccessLevels";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { useAgentsAccess } from "@/hooks/useAgentsAccess";
import "./agent-picker.css";

/** Past this many agents the list gets a search field. */
const SEARCH_FROM = 7;
/** Connectors shown on a row before "+N". */
const CONNECTORS_SHOWN = 4;

export interface AgentPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** The agents to choose from (already the ones the person may talk to). */
  agents: Agent[];
  /** The one chosen now: checked in the list. */
  value: string | undefined;
  /** An agent was chosen: the dialog closes after it. */
  onPick: (agentId: string) => void;
  /** The dialog's title ("Who looks after it"). */
  title: string;
  /** A sentence under the title. */
  description?: ReactNode;
}

/**
 * Choosing an agent in a dialog: each one with its face, name and role, and the connectors it reads with (the
 * services' marks and names, from its access tree); a search field once the list is long. Choosing closes it.
 * Arrow keys move between the rows.
 */
export function AgentPickerDialog({
  open,
  onClose,
  agents,
  value,
  onPick,
  title,
  description,
}: AgentPickerDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      closeLabel={t("common.close")}
      width={520}
      className="apk"
    >
      {open && <PickerList agents={agents} value={value} onPick={onPick} onClose={onClose} />}
    </Dialog>
  );
}

function PickerList({
  agents,
  value,
  onPick,
  onClose,
}: {
  agents: Agent[];
  value: string | undefined;
  onPick: (agentId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const access = useAgentsAccess(agents);
  const items = useConnectedById();
  const q = query.trim().toLocaleLowerCase();
  const shown = q ? agents.filter((a) => `${a.name} ${a.role}`.toLocaleLowerCase().includes(q)) : agents;

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".apk-row")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  return (
    <DialogSearchList
      search={agents.length >= SEARCH_FROM}
      query={query}
      onQueryChange={setQuery}
      searchLabel={t("agentPicker.search")}
      searchPlaceholder={t("agentPicker.search")}
      listLabel={t("agentPicker.list")}
      isEmpty={shown.length === 0}
      emptyText={t("agentPicker.empty", { q: query.trim() })}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the arrow keys between the rows' own buttons */}
      <div className="apk-list" onKeyDown={move}>
        {shown.map((a) => (
          <PickerRow
            key={a.id}
            agent={a}
            current={a.id === value}
            access={access.byAgent.get(a.id)}
            items={items}
            onPick={() => {
              onPick(a.id);
              onClose();
            }}
          />
        ))}
      </div>
    </DialogSearchList>
  );
}

function PickerRow({
  agent,
  current,
  access,
  items,
  onPick,
}: {
  agent: Agent;
  current: boolean;
  /** Its access tree, once read (absent while loading, or for an agent whose tools the person doesn't see). */
  access: AgentAccess | undefined;
  items: Map<string, ConnectedItem>;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const connectors = useMemo(() => (access ? connectorsOf(t, access, items) : null), [t, access, items]);
  return (
    <button type="button" className="apk-row" aria-pressed={current} onClick={onPick}>
      <AgentAvatar agentId={agent.id} name={agent.name} size="md" />
      <span className="apk-row__text">
        <span className="apk-row__name">
          <b>{agent.name}</b>
          {agent.role && <small>{agent.role}</small>}
        </span>
        {connectors && (
          <span className="apk-row__conns">
            {connectors.length === 0 ? (
              <span className="apk-row__none">{t("agentPicker.noConnectors")}</span>
            ) : (
              <>
                {connectors.slice(0, CONNECTORS_SHOWN).map((c) => (
                  <Chip
                    key={c.id}
                    lead={<ConnectorIcon def={c.item?.def ?? null} image={c.item?.image} label={c.name} />}
                  >
                    {c.name}
                  </Chip>
                ))}
                {connectors.length > CONNECTORS_SHOWN && (
                  <span className="apk-row__more">
                    {t("agentPicker.more", { count: connectors.length - CONNECTORS_SHOWN })}
                  </span>
                )}
              </>
            )}
          </span>
        )}
      </span>
      <span className="apk-row__check" aria-hidden="true">
        {current && <Icon name="check" size={18} />}
      </span>
    </button>
  );
}

/** The connectors an agent may use (some of their tools granted), by name, each once. */
function connectorsOf(
  t: TFunction,
  access: AgentAccess,
  items: Map<string, ConnectedItem>,
): { id: string; name: string; item: ConnectedItem | undefined }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string; item: ConnectedItem | undefined }[] = [];
  for (const r of resourcesOf(access)) {
    if (!r.connectionId || levelOf(r) === "none") continue;
    const item = items.get(r.connectionId);
    const name = item ? itemName(t, item) : r.label;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: r.connectionId, name, item });
  }
  return out;
}
