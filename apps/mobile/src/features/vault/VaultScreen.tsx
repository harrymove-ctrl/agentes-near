import { useVault, type VaultConnection, type VaultItem, type VaultOverview } from "@agenteschat/client";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { vaultNoAgents } from "@agenteschat/client/lib/vault";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  Button,
  Chip,
  EmptyState,
  Filters,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  SearchField,
  Segmented,
  Text,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { Gap, SettingsPage } from "../settings/parts";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { Loaded, MONO } from "../shared/parts";
import {
  agentsSummary,
  connectionLine,
  connectionState,
  firstTab,
  itemLine,
  KIND_ICON,
  kindsIn,
  type VaultKindFilter,
  type VaultTab,
  vaultCounts,
  vaultHref,
  vaultList,
} from "./logic";
import { useVaultNames } from "./parts";

/** Above this many items a tab gets its search (a few rows read faster than a search box). */
const SEARCH_FROM = 6;

/**
 * Settings › Vault (ADR 0144), as the web's: the team's items, the person's own and the password managers connected,
 * one view at a time. Each row says what it is, which agents use it and when it was last used, and opens its page.
 * New items start here; importing a passwords file happens on a computer (the web), and a row says so.
 */
export function VaultScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const vault = useVault(orgId);
  const [tab, setTab] = useState<VaultTab | null>(null);
  const title = t("settings.section.vault");
  const data = vault.data;
  if (!data) {
    return (
      <SettingsPage title={title}>
        {vault.isError ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )}
      </SettingsPage>
    );
  }
  const current = tab ?? firstTab(data);
  const counts = vaultCounts(data);
  // A new item starts where the person is: the team's tab adds to the team when they may.
  const newScope = current === "team" && data.canManageTeam ? "team" : "personal";
  const tabEmpty = current === newScope && !data.items.some((i) => i.scope === current);
  return (
    <SettingsPage title={title}>
      <Loaded>
        <GroupedFooter>{t("settings.sectionText.vault")}</GroupedFooter>
        {/* Empty, the button in the tab's empty state is the one way to add. */}
        {tabEmpty ? null : (
          <>
            <Gap />
            <GroupedList>
              <GroupedRow
                icon="plus"
                label={t("mobile.vault.newItem")}
                chevron
                onPress={() => router.push(vaultHref.create(newScope) as never)}
              />
            </GroupedList>
          </>
        )}
        <View style={styles.tabs}>
          <Segmented
            items={[
              { key: "team", label: t("mobile.vault.tab.team"), count: counts.team },
              { key: "personal", label: t("mobile.vault.tab.personal"), count: counts.personal },
              { key: "connections", label: t("mobile.vault.tab.connections"), count: counts.connections },
            ]}
            value={current}
            onChange={(key) => setTab(key as VaultTab)}
          />
        </View>
        {/* Another tab's rows fade in where the last one's were. */}
        <Loaded key={current}>
          {current === "connections" ? (
            <Connections data={data} />
          ) : (
            <Items data={data} tab={current} onNew={() => router.push(vaultHref.create(newScope) as never)} />
          )}
        </Loaded>
      </Loaded>
    </SettingsPage>
  );
}

/** One tab of items: what it is for, a search and a kind filter when it holds enough, the rows. */
function Items({ data, tab, onNew }: { data: VaultOverview; tab: "team" | "personal"; onNew: () => void }) {
  const { t } = useTranslation();
  const now = useNow(60_000);
  const [kind, setKind] = useState<VaultKindFilter>("all");
  const [q, setQ] = useState("");
  const all = data.items.filter((i) => i.scope === tab);
  const kinds = kindsIn(data.items, tab);
  const shown = vaultList(data.items, tab, kinds.length > 1 ? kind : "all", q);
  const mayAdd = tab === "personal" || data.canManageTeam;
  return (
    <>
      {all.length > 0 ? (
        <GroupedFooter>
          {tab === "personal"
            ? t("mobile.vault.personalText")
            : data.canManageTeam
              ? t("mobile.vault.teamText")
              : t("mobile.vault.teamReadText")}
        </GroupedFooter>
      ) : null}
      {all.length === 0 ? (
        <FirstUse
          place={tab === "personal" ? "vaultPersonal" : "vaultTeam"}
          size="panel"
          acts={mayAdd}
          label={t("mobile.vault.newItem")}
          onPress={onNew}
        />
      ) : (
        <>
          {all.length > SEARCH_FROM ? (
            <View style={styles.search}>
              <SearchField
                value={q}
                onChangeText={setQ}
                placeholder={t("mobile.vault.search")}
                accessibilityLabel={t("mobile.vault.search")}
              />
            </View>
          ) : null}
          {kinds.length > 1 ? (
            <View style={styles.filters}>
              <Filters
                items={[
                  { key: "all", label: t("mobile.vault.kinds.all") },
                  ...kinds.map((k) => ({ key: k, label: t(`mobile.vault.kinds.${k}`) })),
                ]}
                value={kind}
                onChange={(k) => setKind(k as VaultKindFilter)}
              />
            </View>
          ) : (
            <Gap />
          )}
          {shown.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("mobile.vault.noResults", { q: q.trim() })}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  label={t("filters.clearAll")}
                  onPress={() => {
                    setQ("");
                    setKind("all");
                  }}
                />
              }
            />
          ) : (
            <GroupedList>
              {shown.map((item) => (
                <ItemRow key={item.id} icon={KIND_ICON[item.kind]} item={item} now={now} />
              ))}
            </GroupedList>
          )}
        </>
      )}
      <Gap />
      <GroupedList>
        <GroupedRow
          icon="laptop"
          label={t("mobile.vault.import.title")}
          sub={t("mobile.vault.import.text")}
          subLines={4}
          media
        />
      </GroupedList>
    </>
  );
}

/**
 * An item's row: what it is, its source and state, which agents use it and its last use. `icon` is a prop of the row
 * itself so the list insets the line between rows past the icon, as it does for its own rows.
 */
function ItemRow({ icon, item, now }: { icon: IconName; item: VaultItem; now: number }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const names = useVaultNames();
  const line = itemLine(item);
  const facts = [
    agentsSummary(t, item.access, names),
    item.lastUsedAt
      ? t("mobile.vault.usedAt", { when: relativeTime(t, i18n.language, item.lastUsedAt, new Date(now)) })
      : t("mobile.vault.neverUsed"),
  ].join(" · ");
  const chips = item.sourceName !== null || item.missing;
  return (
    <GroupedRow
      icon={icon}
      label={item.title}
      {...(line ? { sub: line } : {})}
      belowText={facts}
      media
      below={
        <>
          {item.kind === "key" && item.keyName ? (
            <Text numberOfLines={1} style={[styles.code, { color: c.ink2 }]}>
              {item.keyName}
            </Text>
          ) : null}
          {chips ? (
            <View style={styles.chips}>
              {item.sourceName ? <Chip icon="bolt" label={item.sourceName} /> : null}
              {item.missing ? <Chip icon="wait" label={t("mobile.vault.missing")} /> : null}
            </View>
          ) : null}
        </>
      }
      chevron
      onPress={() => router.push(vaultHref.item(item.id) as never)}
    />
  );
}

/** The password managers this person sees connected, then one row per source to connect. */
function Connections({ data }: { data: VaultOverview }) {
  const { t } = useTranslation();
  const now = useNow(60_000);
  return (
    <>
      <GroupedFooter>{t("mobile.vault.connections.text")}</GroupedFooter>
      {data.connections.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.vault.connections.connected")}</GroupedHeader>
          <GroupedList>
            {data.connections.map((conn) => (
              <ConnectionRow key={conn.id} icon="bolt" conn={conn} now={now} />
            ))}
          </GroupedList>
        </>
      ) : null}
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("mobile.vault.connections.add") }),
          text: t("mobile.vault.connections.help"),
        }}
      >
        {t("mobile.vault.connections.add")}
      </GroupedHeader>
      {data.sources.length === 0 ? (
        <GroupedFooter>{t("mobile.vault.connections.none")}</GroupedFooter>
      ) : (
        <GroupedList>
          {data.sources.map((s) => (
            <GroupedRow
              key={s.kind}
              icon="bolt"
              label={t("mobile.vault.connect.title", { name: s.name })}
              sub={joinNames(
                s.kinds.map((k) => t(`mobile.vault.kinds.${k}`)),
                t,
              )}
              chevron
              onPress={() => router.push(vaultHref.connect(s.kind) as never)}
            />
          ))}
        </GroupedList>
      )}
    </>
  );
}

function ConnectionRow({ icon, conn, now }: { icon: IconName; conn: VaultConnection; now: number }) {
  const { t, i18n } = useTranslation();
  const state = connectionState(conn);
  return (
    <GroupedRow
      icon={icon}
      label={conn.name}
      sub={connectionLine(t, i18n.language, conn, new Date(now))}
      subLines={2}
      media
      below={
        <>
          <View style={styles.chips}>
            <Chip icon={state.icon} label={t(state.key)} />
            <Chip
              icon={conn.scope === "personal" ? "lock" : "members"}
              label={conn.scope === "personal" ? t("mobile.vault.tab.personal") : t("mobile.vault.tab.team")}
            />
          </View>
          {vaultNoAgents(conn.access) ? (
            <Text variant="small" tone="muted">
              {t("vault.connections.noAgents")}
            </Text>
          ) : null}
        </>
      }
      chevron
      onPress={() => router.push(vaultHref.connection(conn.id) as never)}
    />
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
  tabs: { paddingTop: 20, paddingBottom: 4, paddingHorizontal: 4 },
  search: { paddingTop: 12, paddingBottom: 4 },
  // The pills scroll to the screen's edges; their row has its own inset.
  filters: { marginHorizontal: -16, paddingTop: 10, paddingBottom: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 4 },
  code: { fontFamily: MONO, fontSize: 12, lineHeight: 17, paddingTop: 2 },
});
