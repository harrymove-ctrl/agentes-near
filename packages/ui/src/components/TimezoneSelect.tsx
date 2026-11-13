import { useCallback, useMemo } from "react";
import { cx } from "../cx";
import { filterZones, type ZoneOption, type ZoneRegion, zoneOption, zoneOptions } from "../timezones";
import { SearchSelect } from "./SearchSelect";
import type { SelectOption } from "./Select";

export interface TimezoneSelectLabels {
  /** Accessible name of the search field ("Buscar fuso"). */
  search: string;
  searchPlaceholder: string;
  /** "Sugeridos", "América", "Europa"… */
  groups: Record<ZoneRegion, string>;
  noResults: string;
  /** Accessible name of the list ("Fusos horários"). */
  list: string;
}

export interface TimezoneSelectProps {
  value: string;
  onChange: (zone: string) => void;
  labels: TimezoneSelectLabels;
  /** Friendly names ("Horário de Brasília"); the city otherwise. */
  nameOf?: (zone: string) => string | undefined;
  /** Shown first: my zone, the org's, the people's, UTC. */
  suggested?: string[];
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

type ZoneRow = SelectOption & { zone: ZoneOption };

const zoneRow = (o: ZoneRow) => (
  <>
    <span className="ac-tz__name">{o.zone.name}</span>
    {o.zone.name !== o.zone.zone && <span className="ac-tz__id">{o.zone.zone}</span>}
    <span className="ac-tz__off tabular">{o.zone.offsetLabel}</span>
  </>
);

const zoneMatches = (o: ZoneRow, query: string) => filterZones([o.zone], query).length > 0;

/**
 * Our time zone selector (a `SearchSelect`): the trigger says "Horário de Brasília · UTC−3"; the search (city,
 * country, IANA id or offset like "-3") goes over every zone, "Sugeridos" first and the rest by region, each row
 * with its friendly name, the IANA id and the live offset.
 */
export function TimezoneSelect({
  value,
  onChange,
  labels,
  nameOf,
  suggested = [],
  className,
  ...rest
}: TimezoneSelectProps) {
  const suggestedKey = suggested.join(",");
  // Read each time the list opens (the offsets are live); the lists only change with the suggestions.
  // biome-ignore lint/correctness/useExhaustiveDependencies: names are stable
  const options = useCallback((): ZoneRow[] => {
    const all = zoneOptions(suggested, nameOf);
    const row = (zone: ZoneOption, group: ZoneRegion): ZoneRow => ({ value: zone.zone, label: zone.name, group, zone });
    return [...all.suggested.map((z) => row(z, "suggested")), ...all.rest.map((z) => row(z, z.region))];
  }, [suggestedKey]);
  const current = useMemo(() => zoneOption(value || "UTC", nameOf), [value, nameOf]);
  return (
    <SearchSelect
      {...rest}
      className={cx("ac-tz", className)}
      value={value}
      onValueChange={onChange}
      options={options}
      labels={labels}
      groupLabel={(group) => labels.groups[group as ZoneRegion]}
      matches={zoneMatches}
      renderOption={zoneRow}
      renderValue={() => (
        <>
          {current.name} <span className="ac-tz__offset">· {current.offsetLabel}</span>
        </>
      )}
    />
  );
}
