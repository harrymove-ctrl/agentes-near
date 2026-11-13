import { markTerms } from "@agenteschat/client/lib/search-filters";
import { matchesWords } from "@agenteschat/ui/search";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { GroupedList, GroupedRow, haptics, type IconName, SearchField, Sheet, Text } from "@/ui";
import { AgentFace, Face } from "./Face";

/**
 * What leads an option: a person's photo (or initial), an agent's living face, an icon's tile, a mark of the caller's
 * own (a widget kind's glyph), or nothing.
 */
export type PickLeading =
  | { kind: "person"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "icon"; name: IconName }
  | { kind: "node"; node: ReactNode };

export interface PickOption {
  key: string;
  label: string;
  /** A quieter line under it: a person's or an agent's role, a computer's state ("Desligado"). */
  sub?: string | undefined;
  leading?: PickLeading | undefined;
  /** Red, for the action menus that come here on Android ("Apagar conta"). */
  destructive?: boolean | undefined;
}

export interface PickAsk {
  title: string;
  /** One quiet line under the bar, when the choice needs saying what it changes. */
  note?: string | undefined;
  options: readonly PickOption[];
  /** The one in use: checked. */
  value?: string | null | undefined;
  /** A search field over the list; on its own from `SEARCH_FROM` options. */
  search?: boolean | undefined;
}

/** From this many options the list gets its search field (people, languages, times, zones). */
const SEARCH_FROM = 9;
/** Faces stay alive in a short list; a long one draws them still, as long lists do everywhere. */
const LIVE_UP_TO = 12;

type Pending = PickAsk & { mode: "pick" | "actions"; done: (key: string | null) => void };

let present: ((ask: Pending) => void) | null = null;

/**
 * One choice in the app's own sheet (never the system's alert list): the title as the sheet's bar with Cancelar, an
 * optional line under it, then a grouped list where each option shows who or what it is (a face, a photo, a tile), a
 * quieter line, and the check on the one in use; a search field when the list is long. Resolves with the chosen key,
 * or null when the person cancels (Cancelar, the scrim, a flick down). The row's value changes at once: the promise
 * resolves on the pick while the sheet slides away.
 */
export function pickOne(ask: PickAsk): Promise<string | null> {
  return new Promise((resolve) => {
    if (!present) {
      resolve(null);
      return;
    }
    present({ ...ask, mode: "pick", done: resolve });
  });
}

/**
 * A short menu of actions in the same sheet (Android: the system's dialog holds three buttons at most). The action
 * runs once the sheet is gone, so what it presents next (an alert, the photo library) never lands under it. False
 * when no host is mounted, and the caller keeps its own fallback.
 */
export function showActionSheet(
  title: string,
  actions: readonly {
    label: string;
    destructive?: boolean | undefined;
    checked?: boolean | undefined;
    onPress: () => void;
  }[],
): boolean {
  if (!present) return false;
  const options = actions.map((a, i) => ({ key: String(i), label: a.label, destructive: a.destructive }));
  const checkedAt = actions.findIndex((a) => a.checked);
  present({
    title,
    options,
    value: checkedAt >= 0 ? String(checkedAt) : null,
    mode: "actions",
    done: (key) => {
      if (key !== null) actions[Number(key)]?.onPress();
    },
  });
  return true;
}

/** The host of `pickOne` and `showActionSheet`, mounted once at the app's root. */
export function PickerHost() {
  const { t } = useTranslation();
  const [ask, setAsk] = useState<Pending | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // What happens once the sheet is gone: an action menu's action, or a cancelled pick's null.
  const after = useRef<(() => void) | null>(null);
  const current = useRef<Pending | null>(null);

  useEffect(() => {
    present = (next) => {
      // A second ask while one shows: the first one is cancelled; an action still waiting for the last sheet to leave
      // runs now rather than under the new one.
      current.current?.done(null);
      const waiting = after.current;
      after.current = null;
      waiting?.();
      current.current = next;
      setQuery("");
      setAsk(next);
      setOpen(true);
    };
    return () => {
      present = null;
    };
  }, []);

  const finish = (key: string | null) => {
    const pending = current.current;
    if (!pending) return;
    current.current = null;
    // A pick changes its row now; an action waits for the sheet to be gone (it may present something).
    if (pending.mode === "pick" || key === null) pending.done(key);
    else after.current = () => pending.done(key);
    setOpen(false);
  };

  const options = ask?.options ?? [];
  const searchable = Boolean(ask) && ask?.mode === "pick" && (ask.search ?? options.length >= SEARCH_FROM);
  const typed = query.trim();
  // Every typed word, accents and case aside, in the option's name or its line (as the app's other pickers search).
  const shown = useMemo(
    () => (typed ? options.filter((o) => matchesWords(`${o.label} ${o.sub ?? ""}`, typed)) : options),
    [options, typed],
  );
  const live = options.length <= LIVE_UP_TO;

  const bar = ask ? (
    <View>
      <View style={styles.bar}>
        <Pressable
          onPress={() => finish(null)}
          accessibilityRole="button"
          hitSlop={10}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
        >
          <Text variant="body" tone="ink2" numberOfLines={1}>
            {t("mobile.common.cancel")}
          </Text>
        </Pressable>
        <Text variant="title" style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {ask.title}
        </Text>
        <View style={styles.side} />
      </View>
      {ask.note ? (
        <Text variant="footnote" tone="muted" style={styles.note} numberOfLines={2}>
          {ask.note}
        </Text>
      ) : null}
      {searchable ? (
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("mobile.search.placeholder")}
            accessibilityLabel={t("mobile.search.placeholder")}
            returnKeyType="search"
          />
        </View>
      ) : null}
    </View>
  ) : null;

  return (
    <Sheet
      open={open}
      onClose={() => finish(null)}
      header={bar}
      onGone={() => {
        const run = after.current;
        after.current = null;
        // A new ask may have come while this one left: it keeps its list.
        if (!current.current) setAsk(null);
        run?.();
      }}
    >
      {ask ? (
        <GroupedList>
          {shown.map((o) => {
            const picked = ask.value != null && o.key === ask.value;
            const lead = o.leading;
            return (
              <GroupedRow
                key={o.key}
                label={o.label}
                {...(typed ? { labelParts: markTerms(o.label, [typed]) } : {})}
                {...(o.sub ? { sub: o.sub } : {})}
                {...(lead?.kind === "icon" ? { icon: lead.name } : {})}
                {...(lead?.kind === "person"
                  ? { leading: <Face who={{ type: "person", id: lead.userId }} size={36} /> }
                  : lead?.kind === "agent"
                    ? { leading: <AgentFace agentId={lead.agentId} size={36} framed live={live} /> }
                    : lead?.kind === "node"
                      ? { leading: lead.node }
                      : {})}
                danger={Boolean(o.destructive)}
                {...(ask.mode === "pick" || picked ? { checked: picked } : {})}
                onPress={() => {
                  haptics.selection();
                  finish(o.key);
                }}
              />
            );
          })}
        </GroupedList>
      ) : null}
      {ask && shown.length === 0 ? (
        <Text variant="subhead" tone="muted" style={styles.empty}>
          {t("mobile.picker.none", { text: typed })}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // The sheet's bar, as Novo's: Cancelar at the left, the title centered, 44 tall under the grabber.
  bar: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 16 },
  cancel: { minWidth: 72, minHeight: 44, justifyContent: "center" },
  title: { flex: 1, textAlign: "center" },
  side: { minWidth: 72 },
  pressed: { opacity: 0.6 },
  note: { textAlign: "center", paddingHorizontal: 24, paddingBottom: 8 },
  search: { paddingHorizontal: 18, paddingBottom: 12 },
  empty: { textAlign: "center", paddingVertical: 24 },
});
