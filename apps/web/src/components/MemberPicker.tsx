import { listsAgent } from "@agenteschat/client/lib/audience";
import { joinsChannels } from "@agenteschat/client/lib/right-hand";
import { Checkbox, InfoHint, SearchField, Token, TokenList } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useDirectory } from "@/hooks/useDirectory";
import { useOrg } from "./org-context";

export type PickKey = `person:${string}` | `agent:${string}`;

export interface PickRow {
  key: PickKey;
  kind: "person" | "agent";
  id: string;
  name: string;
  sub: string;
}

/**
 * People and agents of the org as pickable rows, minus `exclude`, filtered by `query`. Agents only as far as my lists
 * show them (`listsAgent`), plus the ones in `keep` (already picked), so they can still be taken out. For a channel
 * (`channel`), only the agents that join channels (`joinsChannels`).
 */
export function useMemberRows(
  query: string,
  exclude: Set<PickKey> = new Set(),
  keep?: Set<PickKey>,
  { channel = false }: { channel?: boolean } = {},
) {
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const q = query.trim().toLowerCase();
  const rows: PickRow[] = [
    ...dir.members
      .filter((m) => m.userId !== me.user.id)
      .map((m) => ({
        key: `person:${m.userId}` as PickKey,
        kind: "person" as const,
        id: m.userId,
        name: m.name,
        sub: m.email,
      })),
    ...dir.agents
      .filter((a) => (!channel || joinsChannels(a)) && (listsAgent(org, a) || keep?.has(`agent:${a.id}`)))
      .map((a) => ({
        key: `agent:${a.id}` as PickKey,
        kind: "agent" as const,
        id: a.id,
        name: a.name,
        sub: `@${a.handle}`,
      })),
  ];
  return rows.filter((r) => !exclude.has(r.key) && (!q || `${r.name} ${r.sub}`.toLowerCase().includes(q)));
}

/** Searchable list rows with our checkbox (used inside a DialogSearchList). */
export function MemberPickerRows({
  rows,
  selected,
  onToggle,
}: {
  rows: PickRow[];
  selected: Set<PickKey>;
  onToggle: (key: PickKey, on: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {rows.map((r) => {
        const id = `pick-${r.key.replace(/[^a-zA-Z0-9]/g, "-")}`;
        return (
          <label key={r.key} htmlFor={id} className="scope-row">
            <Checkbox id={id} checked={selected.has(r.key)} onCheckedChange={(on) => onToggle(r.key, on)} />
            <ActorAvatar actor={{ type: r.kind, id: r.id }} size="sm" name={r.name} />
            <span className="scope-row__text">
              <span>{r.name}</span>
              <span className="small muted">
                {r.kind === "agent" ? `${t("channelMembers.agents")} · ${r.sub}` : r.sub}
              </span>
            </span>
          </label>
        );
      })}
    </>
  );
}

/** "person:u1" → { userId: "u1" }; "agent:a1" → { agentId: "a1" }. */
export const memberOf = (key: PickKey) =>
  key.startsWith("agent:") ? { agentId: key.slice(6) } : { userId: key.slice(7) };

/**
 * Pick people and agents inside a form: the label (with an optional ⓘ hint), the picked ones as tokens (with
 * remove), then the search box, then the matching rows right under it in their own short scroll area.
 */
export function PeoplePicker({
  label,
  searchLabel,
  hint,
  emptyText,
  selected,
  onChange,
  channel = false,
}: {
  label: string;
  searchLabel: string;
  hint?: string;
  /** Under the search when nothing matches what was typed. */
  emptyText: (query: string) => string;
  selected: Set<PickKey>;
  onChange: (next: Set<PickKey>) => void;
  /** Picking a channel's members: `useMemberRows`'s `channel`. */
  channel?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const rows = useMemberRows(query, undefined, selected, { channel });
  const all = useMemberRows("", undefined, selected, { channel });
  const picked = all.filter((r) => selected.has(r.key));
  const toggle = (key: PickKey, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onChange(next);
  };
  const hintId = `${searchLabel.replace(/\W+/g, "-")}-hint`;
  return (
    <div className="people-picker">
      {hint ? (
        <span className="ac-hintline">
          <span className="ac-field__label">{label}</span>
          <InfoHint name={t("common.about", { label })} id={hintId}>
            {hint}
          </InfoHint>
        </span>
      ) : (
        <span className="ac-field__label">{label}</span>
      )}
      {picked.length > 0 && (
        <TokenList label={label}>
          {picked.map((r) => (
            <li key={r.key}>
              <Token
                leading={<ActorAvatar actor={{ type: r.kind, id: r.id }} size="xs" name={r.name} />}
                removeLabel={t("common.removeName", { name: r.name })}
                onRemove={() => toggle(r.key, false)}
              >
                {r.name}
              </Token>
            </li>
          ))}
        </TokenList>
      )}
      <SearchField
        size="sm"
        aria-label={searchLabel}
        placeholder={searchLabel}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-describedby={hint ? hintId : undefined}
        onClear={() => setQuery("")}
        clearLabel={t("filters.clearSearch")}
      />
      {/* biome-ignore lint/a11y/useSemanticElements: a scroll region, not a fieldset */}
      <div className="people-picker__results" role="region" aria-label={searchLabel}>
        {rows.length === 0 ? (
          <p className="small muted">{emptyText(query)}</p>
        ) : (
          <MemberPickerRows rows={rows} selected={selected} onToggle={toggle} />
        )}
      </div>
    </div>
  );
}
