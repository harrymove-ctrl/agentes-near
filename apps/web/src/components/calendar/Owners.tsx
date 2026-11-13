import type { Actor } from "@agenteschat/client";
import type { CalItem } from "@agenteschat/client/lib/calendar";
import { Checkbox } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ActorWho } from "@/components/AgentAvatar";
import { actorKey, useActors } from "@/components/actors";

/**
 * Agentes e pessoas: everyone with something in view, agents first and then people, each by how many items. A row's
 * box shows or hides their items in every view, as Google Calendar's own calendars and OpenMausBot's bots do.
 */
export function Owners({
  items,
  hidden,
  onToggle,
}: {
  items: CalItem[];
  /** Whose items are hidden, by `actorKey`. */
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation();
  const actors = useActors();
  const counts = new Map<string, { actor: Actor; count: number }>();
  for (const it of items) {
    if (!it.owner) continue;
    const key = actorKey(it.owner);
    counts.set(key, { actor: it.owner, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const rows = [...counts].sort(
    ([, a], [, b]) =>
      Number(b.actor.type === "agent") - Number(a.actor.type === "agent") ||
      b.count - a.count ||
      actors.name(a.actor).localeCompare(actors.name(b.actor)),
  );
  if (rows.length === 0) return null;
  return (
    <section className="cal-side__section" aria-label={t("calendar.owners")}>
      <h2 className="cal-side__title">{t("calendar.owners")}</h2>
      <ul className="cal-owners">
        {rows.map(([key, { actor, count }]) => {
          const name = actors.name(actor);
          const id = `cal-owner-${key}`;
          return (
            <li key={key} className="cal-owner" data-off={hidden.has(key) || undefined}>
              <Checkbox
                id={id}
                checked={!hidden.has(key)}
                onCheckedChange={() => onToggle(key)}
                aria-label={t("calendar.showOwner", { name })}
              />
              <label htmlFor={id} className="cal-owner__label">
                <span className="cal-owner__name">
                  <ActorWho actor={actor} name={name} />
                </span>
                <span className="cal-owner__count tabular">{count}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
