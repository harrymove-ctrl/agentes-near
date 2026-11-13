import { useChannels, useDms, useMembers } from "@agenteschat/client";
import type { SearchDirectory } from "@agenteschat/client/lib/search-filters";
import { useEffect, useMemo, useState } from "react";
import { readValue, writeValue } from "@/lib/storage";
import { useDirectory, useOrgId } from "../shared/hooks";

/** Who and where a search's filters can name (ADR 0123): the workspace's people and agents, my channels and DMs. */
export function useSearchDirectory(): SearchDirectory {
  const orgId = useOrgId();
  const dir = useDirectory();
  const members = useMembers(orgId);
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  return useMemo<SearchDirectory>(
    () => ({
      actors: [
        ...(members.data ?? []).map((m) => ({ type: "person" as const, id: m.userId, name: m.name, handle: m.handle })),
        ...dir.agents.map((a) => ({ type: "agent" as const, id: a.id, name: a.name, handle: a.handle })),
      ],
      places: [
        ...(channels.data ?? []).filter((c) => c.isMember).map((c) => ({ id: c.id, name: c.name })),
        ...(dms.data ?? []).map((d) => ({ id: d.channelId, name: d.with.name, dm: true })),
      ],
    }),
    [members.data, dir.agents, channels.data, dms.data],
  );
}

/** This phone's recent searches kept under `key` in the stored value `name` (JSON by key), and their setter. */
export function useRecentSearches(name: string, key: string) {
  const [byKey, setByKey] = useState<Record<string, string[]>>({});
  useEffect(() => {
    void readValue(name).then((v) => {
      try {
        const parsed = JSON.parse(v ?? "{}");
        if (parsed && typeof parsed === "object") setByKey(parsed);
      } catch {
        // Nothing kept.
      }
    });
  }, [name]);
  const save = (list: string[]) => {
    const next = { ...byKey, [key]: list };
    setByKey(next);
    void writeValue(name, JSON.stringify(next));
  };
  return [byKey[key] ?? [], save] as const;
}
