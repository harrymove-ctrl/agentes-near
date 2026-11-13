import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useCallback, useState } from "react";
import { COMPACT_QUERY, DESKTOP_QUERY, useMediaQuery } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { STORAGE_KEYS, storage } from "@/lib/storage";

/** Under this, a DM's sidebar leaves the chat too little room beside it: it floats over the chat, closed at first. */
export const DM_SIDE_NARROW_QUERY = "(max-width: 1099px)";
export const DM_SIDE_WIDE_QUERY = "(min-width: 1100px)";

/**
 * A column on the right of a conversation: open by default at `openQuery`, closed below it, the person's last choice
 * in this workspace wins. A personal workspace starts it closed at every width (ADR 0159 §3): only a choice never
 * saved follows the mode, so a saved one (from either mode) still wins. At `sheetQuery` it isn't a column: it opens
 * over the conversation, and stays only until it closes.
 */
function useSideColumn(prefix: string, sheetQuery: string, openQuery: string) {
  const { org, me } = useOrg();
  const compact = useMediaQuery(sheetQuery);
  const desktop = useMediaQuery(openQuery);
  const key = `${prefix}.${me.user.id}.${org.id}`;
  // The key in the state: another workspace or person reads its own choice.
  const [saved, setSaved] = useState(() => ({ key, value: storage.get(key) }));
  const value = saved.key === key ? saved.value : storage.get(key);
  const byDefault = desktop && !isPersonal(org);
  const column = !compact && (value === null ? byDefault : value === "1");
  const [sheet, setSheet] = useState(false);
  const toggle = useCallback(() => {
    if (compact) return setSheet((open) => !open);
    const next = column ? "0" : "1";
    storage.set(key, next);
    setSaved({ key, value: next });
  }, [compact, column, key]);
  const closeSheet = useCallback(() => setSheet(false), []);
  return { open: compact ? sheet : column, column, sheet: compact && sheet, toggle, closeSheet };
}

/** A channel's members, as the header's toggle shows them: a column, or on a phone a sheet over the channel. */
export const useMembersColumn = () => useSideColumn(STORAGE_KEYS.membersColumn, COMPACT_QUERY, DESKTOP_QUERY);

/** The sidebar of a DM with an agent: a column on a wide window, else floating over the chat. */
export const useDmSidebar = () => useSideColumn(STORAGE_KEYS.dmSidebar, DM_SIDE_NARROW_QUERY, DM_SIDE_WIDE_QUERY);
