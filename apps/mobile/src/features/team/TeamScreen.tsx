import { type TeamAgent, useAgentGroups, useChannels, useMembers, useTeam } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import {
  type ChartNode,
  chartByPerson,
  mapColumns,
  noSectorsCopy,
  sectorSupervisor,
  supervisorOf,
} from "@agenteschat/client/lib/team-views";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, Icon, IconButton, ListRow, SCREEN_X, SectionHeader, Text, weights } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { Tile, useSurface } from "../shared/parts";
import { chartRows, teamSections } from "./logic";

/** The org chart's faces: the right hand and the people at 40, their agents at 28; a thin stem joins them. */
const LEAD = 40;
const AGENT = 28;
/** Between the people's columns; a column's width when they scroll sideways (more than two). */
const COLUMN_GAP = 12;
const SCROLL_COLUMN = 156;
/** How far a supervisor's reports sit in under it (ADR 0148 addendum). */
const INDENT = 16;
/** Faces on a channel's card before "+N". */
const CHANNEL_FACES = 4;

/**
 * Equipe on the phone (ADR 0148), one page with each thing said once: the org chart (the right hand on top, out of the
 * line, then each person with the agents that report to them, a supervisor's reports indented under it, ADR 0148
 * addendum) as faces and thin stems, no boxes, every agent a row that opens its profile; the channels as the page's
 * only cards (places: who works in each and who each reports to), who is in none; and the setores as rows with who
 * leads and who stands in. With no setores, what they give; the bar's "+" makes one, for who can. Editing setores,
 * the map's drag and Governança e uso are on the web; Responde a is on the agent's edit screen.
 */
export function TeamScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const team = useTeam(orgId);
  const groups = useAgentGroups(orgId);
  const channels = useChannels(orgId);
  const members = useMembers(orgId);
  const pull = usePullRefresh(() =>
    Promise.allSettled([team.refetch(), groups.refetch(), channels.refetch(), members.refetch()]),
  );
  const lodi = rightHandOf(dir.agents);
  const agents = (team.data?.agents ?? []).filter((a) => a.id !== lodi?.id);
  const people = new Set((members.data ?? []).map((m) => m.userId));
  const chart = chartByPerson(agents, groups.data ?? [], people);
  const places = mapColumns(
    agents,
    (channels.data ?? []).map((c) => c.id),
  );
  const rooms = places.filter((p) => p.channelId !== null);
  const outside = places.find((p) => p.channelId === null)?.agents ?? [];
  const sectors = teamSections("list", {
    agents,
    groups: groups.data ?? [],
    members: members.data ?? [],
    channels: channels.data ?? [],
    rightHandId: lodi?.id ?? null,
  }).filter((s) => s.group);
  const channelName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? "";
  const arranges = can(org, "manage_agents");
  const noSectors = noSectorsCopy(arranges);
  const summary = [
    t("team.agents", { count: agents.length }),
    t("team.people", { count: chart.filter((c) => c.personId).length }),
    rooms.length > 0 ? t("filters.channels", { count: rooms.length }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <PushedLargeTitle
      title={t("team.title")}
      {...(arranges
        ? {
            right: (
              <IconButton icon="plus" label={t("agentGroups.create")} onPress={() => router.push("/sector-new")} />
            ),
          }
        : {})}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <Text variant="subhead" tone="muted" style={styles.summary}>
        {summary}
      </Text>

      <SectionHeader title={t("team.view.chart")} />
      <OrgChart lodi={lodi ? { id: lodi.id, name: lodi.name } : null} columns={chart} />

      {rooms.length > 0 || outside.length > 0 ? (
        <>
          <SectionHeader title={t("team.sectors.channels")} count={rooms.length} />
          <View style={styles.grid}>
            {rooms.map((r) => (
              <ChannelCard
                key={r.channelId}
                channelId={r.channelId ?? ""}
                name={channelName(r.channelId ?? "")}
                agents={r.agents}
                team={agents}
              />
            ))}
          </View>
          {outside.length > 0 ? (
            <View style={styles.outside}>
              <View style={styles.faces}>
                {outside.slice(0, CHANNEL_FACES).map((a, i) => (
                  <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
                    <AgentFace agentId={a.id} size={24} live={false} />
                  </View>
                ))}
              </View>
              <Text variant="small" tone="muted" numberOfLines={1} style={styles.grow}>
                {`${t("team.list.noChannel")}: ${outside.map((a) => a.name).join(", ")}`}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}

      <SectionHeader title={t("team.view.sectors")} {...(sectors.length > 0 ? { count: sectors.length } : {})} />
      {groups.isError && !groups.data ? (
        <LoadFailed onRetry={() => void groups.refetch()} />
      ) : !groups.data ? null : sectors.length === 0 ? (
        // The bar's "+" makes the first one: the words say what setores give.
        <EmptyState
          size="panel"
          agent={lodi ? agentLook(lodi) : true}
          title={t(noSectors.title)}
          subtitle={t(noSectors.text)}
        />
      ) : (
        sectors.map((s, i) => {
          // One line of who: "Ana cuida · Bruno substitui", and the supervising agent when there is one.
          const who = [
            s.lead ? t("mobile.team.sectorLead", { name: s.lead }) : null,
            s.backup ? t("mobile.team.sectorBackup", { name: s.backup }) : null,
            s.group && sectorSupervisor(s.group, agents)
              ? `${t("team.sectors.supervisor")}: ${sectorSupervisor(s.group, agents)?.supervisor.name}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <ListRow
              key={s.key}
              divider={i > 0}
              leading={<Tile icon="members" size={52} />}
              title={s.title ?? ""}
              sub={who || t("team.sectors.nobody")}
              subLines={1}
              time={t("team.agents", { count: s.agents.length })}
              // A setor opens its page; "Sem setor" (no group) is only a heading for the rest.
              {...(s.group
                ? {
                    chevron: true,
                    accessibilityRole: "button" as const,
                    onPress: () => router.push(`/sector/${s.group?.id}`),
                  }
                : {})}
            />
          );
        })
      )}
    </PushedLargeTitle>
  );
}

/**
 * The org chart as faces and thin stems, no boxes: the right hand on its own row (it opens its profile), a stem, then
 * a column per person (face, first name, how many agents) with a stem down to the agents that report to them, each a
 * 44-point row with a hairline between them and a chevron (it opens the profile); a supervisor's reports sit one
 * step in. More than two people scroll sideways.
 */
function OrgChart({
  lodi,
  columns,
}: {
  lodi: { id: string; name: string } | null;
  columns: { personId: string | null; agents: TeamAgent[]; nodes: ChartNode[] }[];
}) {
  const { t } = useTranslation();
  const c = useColors();
  const dir = useDirectory();
  const { width } = useWindowDimensions();
  const wide = columns.length > 2;
  const column = wide ? SCROLL_COLUMN : Math.floor((width - SCREEN_X * 2 - COLUMN_GAP) / 2);
  const stem = { backgroundColor: c.line2 };
  return (
    <View>
      {lodi ? (
        <View style={styles.page}>
          <Pressable
            onPress={() => router.push(`/agent/${lodi.id}`)}
            accessibilityRole="button"
            accessibilityLabel={[lodi.name, t("team.chart.lodi")].join(", ")}
            style={({ pressed }) => [styles.lead, pressed && styles.pressed]}
          >
            <AgentFace agentId={lodi.id} size={LEAD} live={false} />
            <View style={styles.grow}>
              <Text variant="title" numberOfLines={1}>
                {lodi.name}
              </Text>
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {t("team.chart.lodi")}
              </Text>
            </View>
            <Icon name="right" size={15} color={c.faint} />
          </Pressable>
          <View style={[styles.stem, stem, { marginLeft: LEAD / 2 }]} />
        </View>
      ) : null}
      <ScrollView
        horizontal
        scrollEnabled={wide}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.columns}
      >
        {columns.map((col) => (
          <View key={col.personId ?? "none"} style={[styles.column, { width: column }]}>
            <View style={styles.person}>
              {col.personId ? (
                <Face who={{ type: "person", id: col.personId }} size={LEAD} />
              ) : (
                <Tile icon="person" size={LEAD} />
              )}
              <Text variant="footnote" tone="ink" style={styles.semibold} numberOfLines={1}>
                {col.personId ? firstName(dir.nameOf({ type: "person", id: col.personId })) : t("team.noOwner")}
              </Text>
              <Text variant="footnote" tone="faint" numberOfLines={1}>
                {t("team.agents", { count: col.agents.length })}
              </Text>
            </View>
            <View style={[styles.stem, stem, styles.personStem]} />
            <View>
              {chartRows(col.nodes).map(({ agent: a, depth }, i) => (
                <Pressable
                  key={a.id}
                  onPress={() => router.push(`/agent/${a.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={[a.name, a.role].filter(Boolean).join(", ")}
                  style={({ pressed }) => [
                    styles.node,
                    { paddingLeft: depth * INDENT },
                    pressed && { backgroundColor: c.sunken },
                  ]}
                >
                  {i > 0 ? <View style={[styles.nodeLine, stem, { left: depth * INDENT + AGENT + 8 }]} /> : null}
                  <AgentFace agentId={a.id} size={AGENT} mode={a.busy ? "run" : "idle"} live={false} />
                  <View style={styles.grow}>
                    <Text variant="footnote" tone="ink" style={styles.semibold} numberOfLines={1}>
                      {a.name}
                    </Text>
                    {a.role.trim() ? (
                      <Text variant="footnote" tone="faint" numberOfLines={1}>
                        {a.role.trim()}
                      </Text>
                    ) : null}
                  </View>
                  <Icon name="right" size={13} color={c.faint} />
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

/** A person's first name under their face; the whole name is in the row's label for screen readers. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * A channel as a place (an object, so a card): its name, the faces of the agents in it and who they are, and who each
 * reports to ("Responde a Nina"), as the web's map says it below 720 px.
 */
function ChannelCard({
  channelId,
  name,
  agents,
  team,
}: {
  channelId: string;
  name: string;
  agents: TeamAgent[];
  team: TeamAgent[];
}) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const { width } = useWindowDimensions();
  const more = agents.length - CHANNEL_FACES;
  return (
    <Pressable
      onPress={() => router.push(chatHref(channelId))}
      accessibilityRole="button"
      accessibilityLabel={`#${name}, ${agents.map((a) => a.name).join(", ")}`}
      style={({ pressed }) => [
        styles.card,
        surface,
        { width: Math.floor((width - SCREEN_X * 2 - COLUMN_GAP) / 2) },
        pressed && styles.pressed,
      ]}
    >
      <Text variant="title" numberOfLines={1}>
        {`#${name}`}
      </Text>
      <View style={styles.faces}>
        {agents.slice(0, CHANNEL_FACES).map((a, i) => (
          <View key={a.id} style={i > 0 ? styles.overlap : undefined}>
            <AgentFace agentId={a.id} size={AGENT} mode={a.busy ? "run" : "idle"} live={false} ring={c.raised} />
          </View>
        ))}
        {more > 0 ? (
          <Text variant="footnote" tone="faint" style={styles.more}>
            {`+${more}`}
          </Text>
        ) : null}
      </View>
      <Text variant="footnote" tone="faint" numberOfLines={1}>
        {agents.map((a) => a.name).join(", ")}
      </Text>
      {agents.flatMap((a) => {
        const up = supervisorOf(a, team);
        return up
          ? [
              <Text key={a.id} variant="footnote" tone="faint" numberOfLines={1}>
                {`${a.name} · ${t("team.map.reportsTo", { name: up.name })}`}
              </Text>,
            ]
          : [];
      })}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Under the large title's words, tucked to it as Memória's and Wiki's lines are.
  summary: { paddingHorizontal: SCREEN_X, marginTop: -4 },
  page: { paddingHorizontal: SCREEN_X },
  lead: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52 },
  // The thin stem between a face and what hangs from it.
  stem: { width: 1, height: 12 },
  personStem: { alignSelf: "center", marginVertical: 4 },
  columns: { paddingHorizontal: SCREEN_X, gap: COLUMN_GAP },
  column: { paddingTop: 4 },
  person: { alignItems: "center", gap: 4 },
  // A row of 44 for each agent, its hairline from its face's right edge.
  node: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingVertical: 4, paddingRight: 4 },
  nodeLine: { position: "absolute", right: 0, top: 0, height: StyleSheet.hairlineWidth },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: COLUMN_GAP, paddingHorizontal: SCREEN_X },
  card: { padding: 16, gap: 8, borderRadius: 20, borderBottomLeftRadius: 6 },
  faces: { flexDirection: "row", alignItems: "center" },
  overlap: { marginLeft: -8 },
  more: { marginLeft: 6 },
  outside: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: SCREEN_X, paddingTop: 14 },
  grow: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: weights.semibold },
  pressed: { opacity: 0.7 },
});
