import { type Memory, useMemoryAction, useOrgMemories } from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { memoryLine } from "@agenteschat/client/lib/proposals";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  EmptyState,
  Filters,
  Row,
  SCREEN_X,
  SearchField,
  SectionHeader,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { MemoryFix } from "../agents/AgentProfileScreen";
import { canEditMemories } from "../agents/logic";
import { useMemoryOriginText } from "../agents/useMemoryOriginText";
import { StarCard, StarStrip } from "../constellation/Constellation";
import { aroundStar, memoryMap } from "../constellation/logic";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { Face } from "../shared/Face";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { agentFilters, inAgent, justLearned, mostUsed, searchMemories } from "./logic";

const openMemory = (id: string) => router.push(`/memory/${id}`);

/**
 * Memória, pushed from Você: what the agents learned as a sky (each agent with its memories; pages live in the wiki's
 * own map), the search, a filter per agent, what they learned last and what they use most.
 */
export function MemoryScreen({ agent: initialAgent }: { agent?: string } = {}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const memories = useOrgMemories(orgId);
  const openDm = useOpenDm();
  // Whoever answers this person: the right hand first (the server's `canTalk` holds the talk permission).
  const listener = [rightHandOf(dir.agents), ...dir.agents].find((a) => a && canTalk(a));
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState(initialAgent || "all");
  const [picked, setPicked] = useState<string | null>(null);
  const search = useDeferredValue(q.trim());
  const shown = useMemo(() => inAgent(memories.data ?? [], agent), [memories.data, agent]);
  const map = useMemo(() => memoryMap(shown, dir.agents), [shown, dir.agents]);
  const selected = map.stars.find((s) => s.id === picked) ?? map.stars.find((s) => s.kind === "memory") ?? null;
  // The sky and the search's results cross-fade as a search starts and ends, and fade in when they load.
  const reduced = useReducedMotion();
  const fade = reduced ? {} : { entering: FadeIn.duration(160), exiting: FadeOut.duration(120) };
  const when = (iso: string) => relativeTime(t, i18n.language, iso);
  const row = (m: Memory, i: number) => (
    <Row
      key={m.id}
      divider={i > 0}
      leading={<Face who={{ type: "agent", id: m.agentId }} size={36} live={false} />}
      title={m.summary ?? memoryLine(t, m)}
      subtitle={`${dir.nameOf({ type: "agent", id: m.agentId })} · ${when(m.updatedAt)}`}
      chevron
      onPress={() => openMemory(m.id)}
    />
  );
  const found = search ? searchMemories(shown, search) : [];
  const subtitle = !selected
    ? ""
    : selected.kind === "agent"
      ? t("mobile.memory.agentLine", { count: shown.filter((m) => m.agentId === selected.id).length })
      : t("mobile.memory.line", {
          name: dir.nameOf({ type: "agent", id: selected.agentId ?? null }),
          count: selected.weight,
        });
  return (
    <PushedLargeTitle title={t("mobile.memory.title")}>
      <Text variant="subhead" tone="muted" style={styles.lead}>
        {t("mobile.memory.subtitle")}
      </Text>
      <View style={styles.search}>
        <SearchField
          value={q}
          onChangeText={setQ}
          placeholder={t("mobile.memory.search")}
          accessibilityLabel={t("mobile.memory.search")}
          returnKeyType="search"
        />
      </View>
      {memories.isLoading ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
      {memories.isError && !memories.data ? (
        <View style={styles.center}>
          <Text tone="muted">{t("common.loadFailed")}</Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("mobile.common.retry")}
            onPress={() => void memories.refetch()}
          />
        </View>
      ) : null}
      {memories.isSuccess && (memories.data ?? []).length === 0 ? (
        <FirstUse
          place="memory"
          size="panel"
          mood="thinking"
          acts={Boolean(listener)}
          label={listener ? t("team.sectors.ask", { name: listener.name }) : undefined}
          icon="chat"
          onPress={
            listener
              ? () => void openDm({ agentId: listener.id }, { compose: true, text: t("mobile.empty.memory.ask") })
              : undefined
          }
        />
      ) : null}
      {(memories.data ?? []).length > 0 ? (
        <Filters
          items={agentFilters(memories.data ?? [], dir.agents, t("mobile.memory.all"))}
          value={agent}
          onChange={(k) => {
            setAgent(k);
            setPicked(null);
          }}
        />
      ) : null}
      {search ? (
        <Animated.View key="found" {...fade}>
          {found.length === 0 ? (
            <EmptyState
              size="inline"
              title={t("mobile.memory.noMatch")}
              action={
                <Button variant="secondary" size="sm" label={t("filters.clearSearch")} onPress={() => setQ("")} />
              }
            />
          ) : (
            found.map(row)
          )}
        </Animated.View>
      ) : selected ? (
        <Animated.View key="sky" {...fade}>
          <StarCard
            label={t("mobile.memory.sky")}
            count={shown.length}
            map={map}
            selected={selected.id}
            onSelect={setPicked}
            title={selected.title}
            subtitle={subtitle}
            onOpen={() => (selected.kind === "agent" ? router.push(`/agent/${selected.id}`) : openMemory(selected.id))}
          />
          <SectionHeader title={t("mobile.memory.recent")} />
          {justLearned(shown).map(row)}
          <SectionHeader title={t("mobile.memory.mostUsed")} />
          {mostUsed(shown).map(row)}
        </Animated.View>
      ) : (memories.data ?? []).length > 0 ? (
        <EmptyState
          size="inline"
          title={t("mobile.empty.memory.noneForAgent")}
          action={
            <Button variant="secondary" size="sm" label={t("mobile.memory.all")} onPress={() => setAgent("all")} />
          }
        />
      ) : null}
    </PushedLargeTitle>
  );
}

/** One memory, with its small sky. */
export function MemoryDetailScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <MemoryDetail id={id} />
    </SheetHostProvider>
  );
}

function MemoryDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const meId = useMeId();
  const { org } = useOrg();
  const dir = useDirectory();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const failed = useFailed();
  const sheet = useSheet();
  const originText = useMemoryOriginText();
  const memories = useOrgMemories(orgId);
  const m = memories.data?.find((x) => x.id === id);
  const agentId = m?.agentId ?? "";
  const action = useMemoryAction(orgId, agentId);
  const reduced = useReducedMotion();
  const agent = dir.anyAgent(agentId);
  const name = dir.nameOf({ type: "agent", id: agentId });
  const editable = canEditMemories(agent, { id: meId, org });
  const [details, setDetails] = useState(false);
  const around = useMemo(
    () => aroundStar(memoryMap(memories.data ?? [], dir.agents), agentId),
    [memories.data, dir.agents, agentId],
  );
  if (!m) {
    return (
      <View style={[styles.fill, { backgroundColor: c.bg }]}>
        <PushedHeader solid={false} />
        {memories.isLoading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : (
          <EmptyState icon="brain" title={t("mobile.memory.gone")} />
        )}
      </View>
    );
  }
  const forget = () =>
    Alert.alert(t("mobile.memory.forgetTitle"), t("mobile.memory.forgetText", { name }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("mobile.intentAgents.fix.forget"),
        style: "destructive",
        onPress: () =>
          action.mutate(
            { type: "archive", id: m.id, archived: true },
            {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("mobile.intentAgents.fix.forgotten"), agentId });
                goBack();
              },
              onError: failed,
            },
          ),
      },
    ]);
  const confirm = () =>
    action.mutate(
      { type: "confirm", id: m.id },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("mobile.memory.confirmedToast"), agentId });
        },
        onError: failed,
      },
    );
  // Confirmar (ADR 0167): who may edit it, or the person who said it.
  const confirms = (editable || m.editedByUserId === meId) && (m.lowTrust || !m.verified);
  // Tornar do time (ADR 0167): who reviews memory makes it every agent's, its copies archived.
  const teams = can(org, "review_memory") && !m.howTo && !m.playbook && m.kind !== "lesson";
  const makeTeam = () =>
    action.mutate(
      { type: "team", id: m.id },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("teamMemory.made"), agentId });
          goBack();
        },
        onError: failed,
      },
    );
  const fix = () =>
    sheet.open(
      <MemoryFix
        memory={m}
        agentId={agentId}
        agentName={name}
        g={genderOf(name)}
        source={originText(m)}
        onSee={undefined}
        onDone={sheet.close}
      />,
    );
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <PushedHeader solid={false} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <StarStrip map={around} selected={m.id} />
        <View style={styles.body}>
          <View style={styles.who}>
            <Face who={{ type: "agent", id: agentId }} size={20} />
            <Text variant="subhead" tone="faint" style={styles.shrink}>
              {t("mobile.memory.of", { name })}
            </Text>
          </View>
          <Text variant="title2" accessibilityRole="header">
            {m.summary ?? memoryLine(t, m)}
          </Text>
          {m.summary ? (
            <Pressable
              onPress={() => setDetails((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: details }}
              hitSlop={12}
              style={({ pressed }) => [styles.details, pressed && styles.pressed]}
            >
              <Text variant="subhead" tone="ink2" style={styles.bold}>
                {t("mobile.memory.details")}
              </Text>
              {details ? (
                <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
                  <Text variant="subhead" tone="muted" selectable>
                    {memoryLine(t, m)}
                  </Text>
                </Animated.View>
              ) : null}
            </Pressable>
          ) : null}
          <View style={styles.chips}>
            <Chip
              icon={m.verified ? "check" : "sparkle"}
              label={t(m.verified ? "mobile.memory.confirmed" : "mobile.memory.unconfirmed")}
            />
            <Chip icon="clock" label={t("mobile.memory.uses", { count: m.uses })} />
          </View>
          <Text variant="subhead" tone="muted">
            {originText(m)}
          </Text>
          {m.supersedes ? (
            <View style={[styles.before, { backgroundColor: c.sunken }]}>
              <Text variant="subhead" tone="muted">
                {t("mobile.memory.before", { text: m.supersedes })}
              </Text>
            </View>
          ) : null}
        </View>
        {editable || confirms || teams ? (
          <View style={styles.actions}>
            {confirms ? (
              <Button
                variant="secondary"
                wide
                icon="check"
                label={t("mobile.memory.confirm")}
                disabled={action.isPending}
                onPress={confirm}
              />
            ) : null}
            {teams ? (
              <Button
                variant="secondary"
                wide
                icon="members"
                label={t("teamMemory.make")}
                disabled={action.isPending}
                onPress={makeTeam}
              />
            ) : null}
            {editable ? (
              <>
                <Button variant="secondary" wide icon="pen" label={t("mobile.memory.fix")} onPress={fix} />
                <Button
                  variant="ghost"
                  wide
                  label={t("mobile.intentAgents.fix.forget")}
                  disabled={action.isPending}
                  onPress={forget}
                />
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  fill: { flex: 1 },
  lead: { paddingHorizontal: SCREEN_X, marginTop: -4 },
  search: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  loading: { marginVertical: 24 },
  center: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  body: { paddingHorizontal: SCREEN_X, paddingTop: 14, gap: 10 },
  who: { flexDirection: "row", alignItems: "center", gap: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  before: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  actions: { paddingHorizontal: SCREEN_X, paddingTop: 20, gap: 8 },
  details: { gap: 6 },
  pressed: { opacity: 0.6 },
  bold: { fontWeight: "600" },
});
