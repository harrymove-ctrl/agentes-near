import type { Actor, Issue, IssuePriority, IssuesView } from "@agenteschat/client";
import {
  ISSUE_CARD_FIELDS,
  ISSUES_GROUPS,
  ISSUES_SORTS,
  type IssuesViewChange,
  isDefaultIssuesView,
  PRIORITY_ORDER,
} from "@agenteschat/client/lib/issues-view";
import {
  Button,
  Icon,
  type IconName,
  Menu,
  MenuCheckboxItem,
  MenuHeading,
  MenuSeparator,
  Popover,
  Segmented,
  Switch,
} from "@agenteschat/ui";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { actorFromKey, actorKey, NO_ACTOR, useActors } from "@/components/actors";
import { useFilterCopy } from "@/components/filters";
import { useOrg } from "@/components/org-context";

/** Each priority's mark: the chips', and a flag for the normal one (which has no chip). */
export const PRIORITY_ICON: Record<IssuePriority, IconName> = { high: "arrowUp", normal: "flag", low: "dash" };

const toggled = <V extends string>(list: V[], value: V) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

/**
 * "Filtro" and the filters in use. One menu filters by assignee (me, each agent and person with a task here, nobody)
 * and by priority; each filter in use shows as a chip that opens the same menu, with a × to take it off.
 */
export function IssueFilters({
  view,
  issues,
  onChange,
}: {
  view: IssuesView;
  /** The tasks loaded: who has one is who the menu offers. */
  issues: Issue[];
  onChange: (change: IssuesViewChange) => void;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const actors = useActors();
  const copy = useFilterCopy();
  const mine: Actor = { type: "person", id: me.user.id };
  const keys = new Set([...issues.map((i) => actorKey(i.assignee)), ...view.assignees]);
  keys.delete(actorKey(mine));
  keys.delete(NO_ACTOR);
  // Agents first, then people, each by name.
  const kind = (a: Actor) => (a.type === "agent" ? 0 : 1);
  const others = [...keys]
    .map((k) => actorFromKey(k))
    .filter((a): a is Actor => a !== null)
    .sort((a, b) => kind(a) - kind(b) || actors.name(a).localeCompare(actors.name(b), i18n.language));
  const nameOf = (key: string) => {
    const actor = actorFromKey(key);
    return actor ? actors.name(actor) : t("issues.noAssignee");
  };
  const who: { key: string; label: string; actor: Actor | null }[] = [
    { key: actorKey(mine), label: t("issues.me"), actor: mine },
    ...others.map((a) => ({ key: actorKey(a), label: actors.name(a), actor: a })),
    { key: NO_ACTOR, label: t("issues.noAssignee"), actor: null },
  ];
  const items = (
    <>
      <MenuHeading>{t("issues.assigneeFilter")}</MenuHeading>
      {who.map((o) => (
        <MenuCheckboxItem
          key={o.key}
          checked={view.assignees.includes(o.key)}
          onCheckedChange={() => onChange({ assignees: toggled(view.assignees, o.key) })}
          leading={
            o.actor ? <ActorAvatar actor={o.actor} name={o.label} size="xs" /> : <Icon name="person" size={16} />
          }
        >
          {o.label}
        </MenuCheckboxItem>
      ))}
      <MenuSeparator />
      <MenuHeading>{t("issues.priorityFilter")}</MenuHeading>
      {PRIORITY_ORDER.map((p) => (
        <MenuCheckboxItem
          key={p}
          icon={PRIORITY_ICON[p]}
          checked={view.priorities.includes(p)}
          onCheckedChange={() => onChange({ priorities: toggled(view.priorities, p) })}
        >
          {t(`issues.priority.${p}`)}
        </MenuCheckboxItem>
      ))}
    </>
  );
  const chips: { key: string; icon: IconName; filter: string; value: string; clear: () => void }[] = [
    ...view.assignees.map((k) => ({
      key: k,
      icon: "person" as const,
      filter: t("issues.assigneeFilter"),
      value: nameOf(k),
      clear: () => onChange({ assignees: view.assignees.filter((x) => x !== k) }),
    })),
    ...view.priorities.map((p) => ({
      key: p,
      icon: "alert" as const,
      filter: t("issues.priorityFilter"),
      value: t(`issues.priority.${p}`),
      clear: () => onChange({ priorities: view.priorities.filter((x) => x !== p) }),
    })),
  ];
  return (
    <span className="ac-filterbar">
      {chips.map((c) => (
        <span key={c.key} className="ac-filter ac-filter--active">
          <Menu
            label={t("issues.filters")}
            trigger={
              <button type="button" className="ac-filter__trigger">
                <Icon name={c.icon} size={14} />
                <span className="ac-filter__text">{t("issues.filterValue", { filter: c.filter, value: c.value })}</span>
              </button>
            }
          >
            {items}
          </Menu>
          <button type="button" className="ac-filter__clear" aria-label={copy.clearOf(c.value)} onClick={c.clear}>
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      <Menu
        label={t("issues.filters")}
        trigger={
          <Button size="sm" icon="filter" iconOnly={chips.length > 0} aria-label={t("issues.filterButton")}>
            {t("issues.filterButton")}
          </Button>
        }
      >
        {items}
      </Menu>
    </span>
  );
}

/** The layout cards' pictures: a tiny board or list in pixels. */
function MiniLayout({ layout }: { layout: IssuesView["layout"] }) {
  const parts: ReactNode[] = [];
  if (layout === "board") {
    for (let k = 0; k < 3; k++) {
      const x = 2 + k * 15;
      parts.push(<rect key={`well${k}`} className="issues-mini__well" x={x} y={2} width={13} height={26} />);
      for (let j = 0; j < 3 - k; j++) {
        parts.push(
          <rect key={`card${k}${j}`} className="issues-mini__card" x={x + 1} y={5 + j * 7} width={11} height={6} />,
          <rect
            key={`ink${k}${j}`}
            className="issues-mini__ink"
            x={x + 3}
            y={7 + j * 7}
            width={5 + ((j + k) % 3)}
            height={1}
          />,
        );
      }
    }
  } else {
    for (let j = 0; j < 5; j++) {
      parts.push(
        <rect
          key={`row${j}`}
          className={j === 0 ? "issues-mini__well" : "issues-mini__card"}
          x={2}
          y={3 + j * 5}
          width={44}
          height={4}
        />,
        <rect
          key={`ink${j}`}
          className="issues-mini__ink"
          x={5}
          y={4.5 + j * 5}
          width={j === 0 ? 10 : 18 + (j % 3) * 5}
          height={1}
        />,
      );
    }
  }
  return (
    <svg
      className="issues-mini"
      viewBox="0 0 48 30"
      width={96}
      height={60}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {parts}
    </svg>
  );
}

/**
 * "Exibição": the button reads the layout and the grouping ("Quadro · Etapa") and opens the choices: board or list,
 * group by stage, assignee or priority, the order inside each group, what the cards show, canceled tasks. Every
 * change is kept for the person in this workspace at once; "Voltar ao padrão" when it differs from the default.
 */
export function DisplayButton({
  view,
  onChange,
}: {
  view: IssuesView;
  /** `null`: back to the default. */
  onChange: (change: IssuesViewChange | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  const layoutName = t(view.layout === "board" ? "issues.board" : "issues.list");
  const groupName = t(`issues.display.by.${view.group}`);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t("issues.display.title")}
      side="bottom"
      align="end"
      className="issues-display"
      trigger={
        <Button
          size="sm"
          className="issues-display__trigger"
          aria-label={t("issues.display.label", { layout: layoutName, group: groupName })}
        >
          <Icon name={view.layout === "board" ? "grid" : "list"} size={16} />
          <span>
            {layoutName}
            <span className="issues-display__sub"> · {groupName}</span>
          </span>
          <Icon name="chevronDown" size={14} className="issues-display__chev" />
        </Button>
      }
    >
      {/* biome-ignore lint/a11y/useSemanticElements: two toggles side by side, not a form's fieldset */}
      <div className="issues-layouts" role="group" aria-label={t("issues.display.layout")}>
        {(["board", "list"] as const).map((l) => (
          <button
            key={l}
            type="button"
            className="issues-layout"
            aria-pressed={view.layout === l}
            onClick={() => onChange({ layout: l })}
          >
            <MiniLayout layout={l} />
            <span>{t(l === "board" ? "issues.board" : "issues.list")}</span>
          </button>
        ))}
      </div>
      <div className="issues-display__row">
        <span className="issues-display__label">{t("issues.display.group")}</span>
        <Segmented
          size="sm"
          label={t("issues.display.group")}
          value={view.group}
          onValueChange={(group) => onChange({ group })}
          options={ISSUES_GROUPS.map((g) => ({ value: g, label: t(`issues.display.by.${g}`) }))}
        />
      </div>
      <div className="issues-display__row">
        <span className="issues-display__label">{t("issues.display.sort")}</span>
        <Segmented
          size="sm"
          label={t("issues.display.sort")}
          value={view.sort}
          onValueChange={(sort) => onChange({ sort })}
          options={ISSUES_SORTS.map((s) => ({ value: s, label: t(`issues.display.order.${s}`) }))}
        />
      </div>
      <div className="issues-display__row issues-display__row--col">
        <span className="issues-display__label" id={`${id}-fields`}>
          {t("issues.display.fields")}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: toggles that read their group's name, not a fieldset */}
        <div className="issues-display__fields" role="group" aria-labelledby={`${id}-fields`}>
          {ISSUE_CARD_FIELDS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant="ghost"
              icon={view.fields[f] ? "check" : undefined}
              aria-pressed={view.fields[f]}
              onClick={() => onChange({ fields: { ...view.fields, [f]: !view.fields[f] } })}
            >
              {t(`issues.display.field.${f}`)}
            </Button>
          ))}
        </div>
      </div>
      <div className="issues-display__row">
        <label className="issues-display__label" htmlFor={`${id}-canceled`}>
          {t("issues.showCanceled")}
        </label>
        <Switch
          id={`${id}-canceled`}
          checked={view.showCanceled}
          onCheckedChange={(showCanceled) => onChange({ showCanceled })}
        />
      </div>
      <div className="issues-display__foot">
        <span>
          <Icon name="check" size={14} />
          {t("issues.display.saved")}
        </span>
        {!isDefaultIssuesView(view) && (
          <button type="button" className="ac-link issues-display__reset" onClick={() => onChange(null)}>
            {t("issues.display.reset")}
          </button>
        )}
      </div>
    </Popover>
  );
}
