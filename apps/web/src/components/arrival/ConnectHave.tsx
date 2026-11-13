import type { PlanUsage } from "@agenteschat/client";
import { accountAbout, accountTitle, type ExistingAi } from "@agenteschat/client/lib/ai-accounts";
import { namesText } from "@agenteschat/client/lib/format";
import { type PlanChoice, planOfAccount } from "@agenteschat/client/lib/no-ai";
import { keyLine } from "@agenteschat/client/lib/providers";
import { Icon, ProviderLogo, planState, Radio, RadioGroup } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, Fragment, type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { planWord } from "@/lib/plan-usage";

/** A row's id in the list: an account's or a key's. */
export const haveId = (r: ExistingAi) => (r.kind === "key" ? `key:${r.key.id}` : `account:${r.choice.login.id}`);

/**
 * One row of what the person already has, as the list draws it: an account, a key, or (the agent's "Quem pensa") any
 * other way it thinks. The list orders and groups these; the row puts the radio, the mark, the name and how full the
 * plan is on one line, then a line about it and its state in words.
 */
export interface HaveItem {
  id: string;
  title: string;
  /** In its owner's group: who else thinks with it, its email or its key's end. */
  about?: string;
  /** In a list of mixed owners: whose it is ("Sua", "De Walter", "Chave do workspace"). */
  whose: string;
  /** Its group, by owner: `mine`, `keys`, or another owner's key. */
  group: { key: string; label: string };
  mark: ReactNode;
  /** Its plan's limits; null where nothing says (a key). */
  usage: PlanUsage | null;
  /** It can't be picked. */
  off?: boolean;
  /** Picking it asks for a sign-in: after those used in one click. */
  signIn?: boolean;
  /** A workspace key: after the plans. */
  isKey?: boolean;
}

/** How much of its plan an item has used, and whether it is near or at its limit; null where nothing says. */
const roomOf = (usage: PlanUsage | null) => (usage ? planState(usage) : null);
const limited = (i: Pick<HaveItem, "usage">) => roomOf(i.usage)?.state === "limited";

type Rankable = Pick<HaveItem, "usage" | "off" | "signIn" | "isKey">;

/**
 * A plan that is used in one click first, the one with most room on top (one that doesn't say counts as half used);
 * then one that asks for a sign-in, the workspace's keys, a plan at its limit, and last what can't be picked.
 */
export function sortHave<T extends Rankable>(items: readonly T[]): T[] {
  const rank = (i: Rankable) => {
    const s = roomOf(i.usage);
    return (
      (i.off ? 8000 : 0) +
      (s?.state === "limited" ? 4000 : 0) +
      (i.isKey ? 2000 : 0) +
      (i.signIn ? 1000 : 0) +
      (s?.used ?? 50)
    );
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** A row the person can't pick: someone else's they may not use, or a plan that can't run on that computer now. */
const offOf = (r: ExistingAi, dims: (choice: PlanChoice) => boolean) =>
  r.kind === "account" && (r.act === "locked" || dims(planOfAccount(r.choice.login)));

const rankOf = (r: ExistingAi, dims: (choice: PlanChoice) => boolean): Rankable => ({
  usage: r.kind === "account" ? r.choice.login.usage : null,
  off: offOf(r, dims),
  signIn: r.kind === "account" && r.act !== "use" && r.act !== "move",
  isKey: r.kind === "key",
});

/** The row a list opens on: the usable one with most room, never one at its limit while another has room. */
export function bestHave(rows: readonly ExistingAi[], dims: (choice: PlanChoice) => boolean): string | undefined {
  const first = sortHave(rows.map((r) => ({ r, ...rankOf(r, dims) }))).find((x) => !x.off);
  return first ? haveId(first.r) : undefined;
}

/** Up to this many rows the list shows them all, in groups; past it, this many with most room and a way to the rest. */
export const HAVE_SHOWN = 3;

const firstName = (name: string | null | undefined) => name?.split(" ")[0] ?? "";

/** What the person already has (`ExistingAi`), as the list's rows. */
function itemOf(t: TFunction, r: ExistingAi, agentName: string, dims: (choice: PlanChoice) => boolean): HaveItem {
  if (r.kind === "key") {
    return {
      id: haveId(r),
      title: r.key.label,
      about: keyLine(t, r.key),
      whose: t("connectAi.chat.keys"),
      group: { key: "keys", label: t("connectAi.chat.keys") },
      mark: <Icon name="key" size={16} className="arrival-have__mark" />,
      usage: null,
      isKey: true,
    };
  }
  const a = r.choice.login;
  const others = [...new Set(a.usedBy)].filter((n) => n !== agentName);
  const whose = a.mine
    ? t("connectAi.chat.yours")
    : t("agentPage.work.brain.accountOf", { name: firstName(a.ownerName) });
  return {
    id: haveId(r),
    title: accountTitle(a),
    // In its owner's group, who else thinks with it; someone else's says nothing more there.
    about: !a.mine
      ? undefined
      : others.length > 0 && a.shared === true
        ? t("agentPage.work.brain.accountAlso", { agents: namesText(t, others, 2) })
        : accountAbout(t, r.choice, agentName),
    whose,
    group: a.mine ? { key: "mine", label: t("connectAi.chat.mine") } : { key: `owner:${a.ownerId}`, label: whose },
    mark: <ProviderLogo id={a.provider ?? a.kind} size="xs" />,
    ...rankOf(r, dims),
  };
}

/**
 * One row. In a list (`RadioGroup`) its radio picks it; `still`: the one in use, shown alone with its dot, nothing to
 * pick. `whose`: it says whose it is instead of the line about it (a list of mixed owners).
 */
export function HaveRow({
  item,
  checked,
  whose = false,
  disabled = false,
  still = false,
  word,
}: {
  item: HaveItem;
  checked: boolean;
  whose?: boolean;
  disabled?: boolean;
  still?: boolean;
  /** Its state in words, over the plan's own ("Quase no limite"). */
  word?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const dom = useId();
  const off = disabled || item.off === true;
  const state = roomOf(item.usage);
  const about = whose ? item.whose : item.about;
  const shownWord = word !== undefined ? word : item.usage ? planWord(t, i18n.language, item.usage) : null;
  const used = state ? Math.min(100, Math.round(state.used)) : 0;
  const body = (
    <>
      {item.mark}
      <span className="arrival-have__text">
        <span className="arrival-have__title">{item.title}</span>
        {about && <span className="arrival-have__line">{about}</span>}
        {shownWord && (
          <span className="arrival-have__line" data-plan={state?.state}>
            {shownWord}
          </span>
        )}
      </span>
      {state && (
        // Only the bar is hidden: how full the plan is stays read with the row, since the rows are sorted and picked
        // by room (ADR 0032, addendum).
        <span className="arrival-have__room" data-plan={state.state}>
          <span className="arrival-have__meter" aria-hidden="true">
            <i style={{ "--used": `${used}%` } as CSSProperties} />
          </span>
          <span className="arrival-have__pct">
            {new Intl.NumberFormat(i18n.language, { style: "percent" }).format(used / 100)}
          </span>
        </span>
      )}
    </>
  );
  if (still) {
    return (
      <div className="arrival-have__row" data-state="checked" data-still="">
        <span className="ac-radio" data-state="checked" aria-hidden="true">
          <span className="ac-radio__dot" data-state="checked" />
        </span>
        {body}
      </div>
    );
  }
  return (
    <label
      htmlFor={`${dom}-row`}
      className="arrival-have__row"
      data-state={checked ? "checked" : "unchecked"}
      data-disabled={off ? "" : undefined}
    >
      <Radio value={item.id} id={`${dom}-row`} disabled={off} />
      {body}
    </label>
  );
}

/**
 * Rows to pick one from (`HaveItem`): few are grouped (the person's, the workspace's keys, each other owner's); many
 * show the three with most room, each saying whose it is, and `all` lists every one under a search, by owner, those at
 * their limit last. `pinned`: a group over the rest whatever their number (the one in use), never in `all`.
 */
export function HaveList({
  items,
  value,
  onChange,
  all = false,
  onAll,
  disabled = false,
  pinned,
  label,
}: {
  items: readonly HaveItem[];
  value: string | undefined;
  onChange: (id: string) => void;
  all?: boolean;
  onAll?: () => void;
  disabled?: boolean;
  pinned?: { label: string; items: readonly HaveItem[] };
  label: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const list = sortHave(items);
  const many = items.length > HAVE_SHOWN;
  const row = (i: HaveItem, whose: boolean) => (
    <HaveRow key={i.id} item={i} checked={i.id === value} whose={whose} disabled={disabled} />
  );

  /** By owner: the person's, the workspace's keys, each other owner's; in `all`, those at their limit last. */
  const groups = () => {
    const out: { key: string; label: string; rows: HaveItem[] }[] = [];
    const into = (key: string, label: string, i: HaveItem) => {
      const group = out.find((g) => g.key === key);
      if (group) group.rows.push(i);
      else out.push({ key, label, rows: [i] });
    };
    const open = all ? list.filter((i) => !limited(i)) : list;
    for (const i of open) if (i.group.key === "mine") into(i.group.key, i.group.label, i);
    for (const i of open) if (i.group.key === "keys") into(i.group.key, i.group.label, i);
    for (const i of open) if (i.group.key !== "mine" && i.group.key !== "keys") into(i.group.key, i.group.label, i);
    if (all) for (const i of list.filter(limited)) into("limit", t("connectAi.chat.atLimit"), i);
    return out;
  };
  const grouped = (
    <>
      {groups().map((g) => (
        <Fragment key={g.key}>
          <p className="arrival-opts__label">{g.label}</p>
          {g.rows.map((i) => row(i, g.key === "limit"))}
        </Fragment>
      ))}
    </>
  );
  const top = pinned && pinned.items.length > 0 && !all && (
    <>
      <p className="arrival-opts__label">{pinned.label}</p>
      {pinned.items.map((i) => row(i, false))}
    </>
  );

  const found = query.trim()
    ? list.filter((i) => `${i.title} ${i.whose}`.toLowerCase().includes(query.trim().toLowerCase()))
    : null;
  return (
    <RadioGroup className="arrival-have" aria-label={label} value={value ?? ""} onValueChange={onChange}>
      {all ? (
        <>
          <label className="arrival-have__search">
            <Icon name="search" size={16} />
            <input
              type="search"
              value={query}
              placeholder={t("connectAi.chat.search")}
              aria-label={t("connectAi.chat.search")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="arrival-have__scroll">
            {found ? (
              found.length > 0 ? (
                found.map((i) => row(i, true))
              ) : (
                <p className="arrival-have__none">{t("connectAi.chat.none")}</p>
              )
            ) : (
              grouped
            )}
          </div>
        </>
      ) : many ? (
        <>
          {top}
          <p className="arrival-opts__label">{t("connectAi.chat.best")}</p>
          {list.slice(0, HAVE_SHOWN).map((i) => row(i, true))}
          {/* The one picked in the full list stays in sight when it isn't among the three. */}
          {list
            .slice(HAVE_SHOWN)
            .filter((i) => i.id === value)
            .map((i) => row(i, true))}
          <button type="button" className="arrival-have__link" onClick={onAll}>
            <Icon name="layers" size={16} />
            <span>{t("connectAi.chat.seeAll", { count: items.length })}</span>
            <Icon name="chevronRight" size={16} />
          </button>
        </>
      ) : (
        <>
          {top}
          {grouped}
        </>
      )}
    </RadioGroup>
  );
}

/**
 * What the person already has for the agent, to pick one and confirm it at the dialog's foot (ADR 0160, addendum). A
 * row puts the radio, the mark, the name and how full the plan is on one line, then who else thinks with it and its
 * state in words. Few accounts are grouped (the person's, the workspace's keys, each other owner's); many show the
 * three with most room, each saying whose it is, and `all` lists every one under a search, by owner, those at their
 * limit last.
 */
export function ConnectHave({
  rows,
  agentName,
  value,
  onChange,
  dims,
  all = false,
  onAll,
  disabled = false,
}: {
  rows: readonly ExistingAi[];
  agentName: string;
  value: string | undefined;
  onChange: (id: string) => void;
  /** A plan that can't sign in on that computer now: its rows are off. */
  dims: (choice: PlanChoice) => boolean;
  /** Every account, with the search. */
  all?: boolean;
  /** Past `HAVE_SHOWN` rows: opens the list of all of them. */
  onAll?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <HaveList
      items={rows.map((r) => itemOf(t, r, agentName, dims))}
      value={value}
      onChange={onChange}
      all={all}
      onAll={onAll}
      disabled={disabled}
      label={t("connectAi.have.title")}
    />
  );
}
