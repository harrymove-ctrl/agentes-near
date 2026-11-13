import {
  type Mission,
  type MissionDecision,
  type MissionFinding,
  type MissionReview,
  useApi,
  useMission,
  useMissionAct,
  useMissionControl,
  useMissionDecisions,
  useMissionReviews,
  useRetryMissionWorktree,
  useThreadMission,
} from "@agenteschat/client";
import { plainInline } from "@agenteschat/client/lib/markdown";
import { lastLines } from "@agenteschat/client/lib/missions";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import {
  Button,
  CHROME_MAX_SCALE,
  Chip,
  Count,
  Icon,
  LineIcon,
  PixelOrbit,
  PlanTrack,
  Text,
  useTheme,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { FoldedBody } from "../chat/FoldedBody";
import { useCardTop } from "../chat/look";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { missionTrack, planProgress, recommendedOption, waitingCount } from "./logic";

/**
 * The mission's cards (ADR 0029), shared by the conversation, the pinned
 * card, Início and the mission screen: the card with the plan strip, a
 * review ("Pronto para você ver"), a decision (options, Recomendado) and the
 * plan proposal (Começar / Mudar algo).
 */

// ── The mission card ─────────────────────────────────────────────────────────

/** By mission id or by its thread (the root of a `missionStart`). */
export function MissionCard({
  missionId,
  threadId,
  pinned = false,
}: {
  missionId?: string;
  threadId?: string;
  pinned?: boolean;
}) {
  const orgId = useOrgId();
  const byId = useMission(orgId, missionId);
  const byThread = useThreadMission(orgId, missionId ? null : threadId);
  const m = byId.data ?? byThread.data ?? null;
  if (!m) return null;
  return <MissionCardView mission={m} pinned={pinned} />;
}

export function MissionCardView({ mission: m, pinned = false }: { mission: Mission; pinned?: boolean }) {
  const ownTop = useCardTop(8);
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const surface = useSurface();
  const agent = dir.agentById.get(m.agentId);
  const color = agentLook(agent).color;
  const { done, total } = planProgress(m);
  const waiting = waitingCount(m);
  const working = m.status === "active" && (m.runningTasks > 0 || (m.plan.doing ?? 0) > 0);
  return (
    <Pressable
      onPress={() => router.push(`/mission/${m.id}`)}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.mission.cardLabel", { title: m.title, done, total })}
      style={({ pressed }) => [styles.mcard, surface, ownTop, pressed && styles.pressed]}
    >
      <View style={styles.row}>
        <Icon name="target" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {t("mobile.mission.kind")}
        </Text>
        <View style={styles.grow} />
        <Chip
          {...(working
            ? { leading: <PixelOrbit color={color} size={11} /> }
            : m.status === "done"
              ? { icon: "checkc" as const }
              : m.status === "paused"
                ? { icon: "pause" as const }
                : {})}
          label={
            working ? t("mobile.mission.working", { name: agent?.name ?? "" }) : t(`mobile.mission.status.${m.status}`)
          }
        />
      </View>
      <Text variant="body" style={[styles.bold, pinned ? styles.titlePinned : styles.title]} numberOfLines={2}>
        {m.title}
      </Text>
      <PlanTrack color={color} items={missionTrack(m)} />
      <View style={[styles.row, styles.ft]}>
        <Count value={done} size={13} />
        <Text variant="caption" tone="faint">
          {t("mobile.mission.ofTotal", { total })}
        </Text>
        {waiting > 0 ? (
          <Text variant="caption" tone="ink" style={styles.bold}>
            {" · "}
            {t("mobile.mission.waitingYou", { count: waiting })}
          </Text>
        ) : null}
        <View style={styles.grow} />
        <Icon name="right" size={16} color={c.faint} />
      </View>
    </Pressable>
  );
}

// ── Preparing the project failed (ADR 0044) ──────────────────────────────────

/**
 * `meta.missionSetup` in the conversation, or the mission screen while its copy
 * of the project failed: the end of the error and "Tentar de novo" for whoever
 * can act on the mission; once retried, where it stands now.
 */
export function SetupFailedCard({
  missionId,
  threadId,
  error,
  lostBranch,
}: {
  missionId?: string;
  threadId?: string | null;
  error: string;
  /** The mission's branch is gone (`branch_missing`): trying again starts over from the base. */
  lostBranch?: string | null;
}) {
  const ownTop = useCardTop(8);
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const { colors, fonts } = useTheme();
  const surface = useSurface();
  const toast = useToast();
  const byId = useMission(orgId, missionId);
  const byThread = useThreadMission(orgId, missionId ? null : threadId);
  const m = byId.data ?? byThread.data ?? null;
  const retry = useRetryMissionWorktree(orgId, m?.id ?? "");
  const lost = lostBranch !== undefined;
  const tail = lost ? "" : lastLines(error);
  const state = m?.worktreeState;
  const open = m ? m.status !== "done" && m.status !== "canceled" : false;
  return (
    <View style={[styles.askcard, surface, ownTop]}>
      <View style={styles.row}>
        <Icon name="code" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {t("mobile.mission.setup.cap")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.title]}>
        {t(lost ? "mobile.mission.setup.lostTitle" : "mobile.mission.setup.failedTitle")}
      </Text>
      {lost ? (
        <Text variant="small" tone="muted">
          {t("mobile.mission.setup.lostText", { branch: lostBranch ?? m?.branch ?? "" })}
        </Text>
      ) : null}
      {/* The log flat in the card (never a plate in a card), in mono: it is the command's own output. */}
      {tail ? (
        <RNText
          numberOfLines={8}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[styles.log, { fontFamily: fonts.mono, color: colors.ink2 }]}
        >
          {tail}
        </RNText>
      ) : null}
      {state === "preparing" ? (
        <View style={styles.row}>
          <PixelOrbit color={agentLook(dir.agentById.get(m?.agentId ?? "")).color} size={11} />
          <Text variant="small" tone="muted">
            {t("mobile.mission.setup.preparing")}
          </Text>
        </View>
      ) : state === "ready" ? (
        <View style={styles.row}>
          <Icon name="check" size={15} color={c.ok} />
          <Text variant="small" tone="muted">
            {t("mobile.mission.setup.ready")}
          </Text>
        </View>
      ) : m && open && state === "failed" ? (
        m.canAct ? (
          <View style={styles.acts}>
            <View style={styles.grow}>
              <Button
                variant="primary"
                size="sm"
                wide
                icon="undo"
                label={t(lost ? "mobile.mission.setup.restart" : "mobile.mission.setup.retry")}
                disabled={retry.isPending}
                onPress={() =>
                  retry.mutate(undefined, {
                    onSuccess: () => toast({ title: t("mobile.mission.setup.retrying") }),
                    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                  })
                }
              />
            </View>
          </View>
        ) : (
          <Text variant="small" tone="muted">
            {t("mobile.mission.setup.waiting")}
          </Text>
        )
      ) : null}
    </View>
  );
}

// ── Review ───────────────────────────────────────────────────────────────────

export function ReviewCard({ missionId, reviewId }: { missionId: string; reviewId: string }) {
  const orgId = useOrgId();
  const reviews = useMissionReviews(orgId, missionId);
  const mission = useMission(orgId, missionId);
  const review = reviews.data?.find((r) => r.id === reviewId);
  if (!review) return null;
  return <ReviewCardView review={review} mission={mission.data ?? null} />;
}

export function ReviewCardView({ review: r, mission }: { review: MissionReview; mission: Mission | null }) {
  const ownTop = useCardTop(8);
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const sheet = useSheet();
  const agentId = mission?.agentId ?? null;
  const name = agentId ? (dir.agentById.get(agentId)?.name ?? "") : "";
  const g = genderOf(name);
  const act = useMissionAct(orgId, r.missionId, (input: { outcome: "approve" | "changes"; note?: string }) =>
    api.missions.review(orgId, r.missionId, r.id, input.outcome, input.note),
  );
  if (r.status !== "pending") {
    return (
      <View style={[styles.done, surface]}>
        <LineIcon
          name={r.status === "approved" ? "check" : "reply"}
          size={15}
          color={r.status === "approved" ? c.ok : c.muted}
          variant="small"
        />
        <Text variant="small" tone="muted" style={styles.grow}>
          {r.status === "approved"
            ? t("mobile.mission.review.approved", { title: r.title })
            : t("mobile.mission.review.changes", { title: r.title })}
        </Text>
      </View>
    );
  }
  const canAct = mission?.canAct ?? false;
  return (
    <View style={[styles.askcard, surface, ownTop]}>
      <View style={styles.row}>
        <Icon name="sparkle" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {t("mobile.mission.review.ready")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.title]}>
        {r.title}
      </Text>
      {r.summary ? (
        <View style={styles.summary}>
          <FoldedBody body={r.summary} />
        </View>
      ) : null}
      {canAct ? (
        <View style={styles.acts}>
          <View style={styles.grow}>
            <Button
              variant="secondary"
              size="sm"
              wide
              label={t("mobile.mission.review.askChanges")}
              onPress={() =>
                sheet.open(
                  <PromptForm
                    title={t("mobile.mission.review.whatChange")}
                    placeholder={t("mobile.mission.review.changesPlaceholder")}
                    submitLabel={t("mobile.mission.review.sendChanges")}
                    onSubmit={(note) =>
                      act.mutateAsync({ outcome: "changes", note }).then(
                        () => {
                          sheet.close();
                          toast({
                            title: t("mobile.mission.review.changesSent"),
                            subtitle: t(`mobile.mission.review.changesSentSub${g}`, { name }),
                            ...(agentId ? { agentId } : {}),
                          });
                        },
                        () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                      )
                    }
                  />,
                )
              }
            />
          </View>
          <View style={styles.grow}>
            <Button
              variant="primary"
              size="sm"
              wide
              icon="check"
              label={t("mobile.mission.review.approve")}
              disabled={act.isPending}
              onPress={() =>
                act.mutate(
                  { outcome: "approve" },
                  {
                    onSuccess: () => {
                      successHaptic();
                      toast({
                        title: t("mobile.approval.approved"),
                        subtitle: t(`mobile.mission.review.approvedSub${g}`, { name }),
                        ...(agentId ? { agentId } : {}),
                      });
                    },
                    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                  },
                )
              }
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ── Decision ─────────────────────────────────────────────────────────────────

export function DecisionCard({ missionId, decisionId }: { missionId: string; decisionId: string }) {
  const orgId = useOrgId();
  const decisions = useMissionDecisions(orgId, missionId);
  const mission = useMission(orgId, missionId);
  const decision = decisions.data?.find((d) => d.id === decisionId);
  if (!decision) return null;
  return <DecisionCardView decision={decision} mission={mission.data ?? null} />;
}

export function DecisionCardView({ decision: d, mission }: { decision: MissionDecision; mission: Mission | null }) {
  const ownTop = useCardTop(8);
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const canAct = mission?.canAct ?? false;
  const canOpine = mission ? mission.role === "comment" : false;
  const choose = useMissionAct(orgId, d.missionId, (option: string) =>
    canAct
      ? api.missions.choose(orgId, d.missionId, d.id, option)
      : api.missions.opinion(orgId, d.missionId, d.id, option),
  );
  const taken = d.status === "taken";
  const picked = d.chosen;
  const rec = recommendedOption(d);
  const pick = (option: string) => {
    if (taken || !(canAct || canOpine) || choose.isPending) return;
    tapHaptic();
    choose.mutate(option, {
      onSuccess: () => {
        if (canAct)
          toast({
            title: t("mobile.mission.decision.noted"),
            subtitle: t("mobile.mission.decision.notedSub"),
            icon: "flag",
          });
      },
      onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
    });
  };
  return (
    <View style={[styles.askcard, surface, ownTop]}>
      <View style={styles.row}>
        <Icon name="flag" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={styles.bold}>
          {taken ? t("mobile.mission.decision.decided") : t("mobile.mission.decision.title")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.title]}>
        {d.question}
      </Text>
      <View style={styles.opts}>
        {d.options.map((o) => {
          const on = picked === o;
          return (
            <Pressable
              key={o}
              onPress={() => pick(o)}
              disabled={taken || !(canAct || canOpine)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={({ pressed }) => [
                styles.opt,
                { backgroundColor: on ? c.ink : c.sunken },
                pressed && styles.pressed,
              ]}
            >
              {on ? <LineIcon variant="body" name="check" size={16} color={c.bg} /> : null}
              <Text variant="body" style={[styles.optText, { color: on ? c.bg : c.ink }]}>
                {o}
              </Text>
              {o === rec ? (
                <LineIcon variant="body" size={16}>
                  <Text variant="caption" style={{ color: on ? c.bg : c.faint, opacity: on ? 0.7 : 1 }}>
                    {t("mobile.mission.decision.recommended")}
                  </Text>
                </LineIcon>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {d.why && !taken ? (
        <Text variant="caption" tone="faint" style={styles.summary}>
          {d.why}
        </Text>
      ) : null}
    </View>
  );
}

// ── Plan proposal ────────────────────────────────────────────────────────────

/** `meta.missionPlan`: before Start, the plan and Começar / Mudar algo; after, one quiet line. */
export function PlanCard({ missionId, goal }: { missionId: string; goal: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const c = useColors();
  const surface = useSurface();
  const toast = useToast();
  const sheet = useSheet();
  const dir = useDirectory();
  const mission = useMission(orgId, missionId);
  const control = useMissionControl(orgId);
  const ownTop = useCardTop(8);
  const m = mission.data;
  if (!m) return null;
  const name = dir.agentById.get(m.agentId)?.name ?? "";
  const g = genderOf(name);
  if (m.status !== "proposed") {
    return (
      <Pressable
        onPress={() => router.push(`/mission/${m.id}`)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.done, surface, pressed && styles.pressed]}
      >
        <LineIcon name="check" size={15} color={c.ok} variant="small" />
        <Text variant="small" tone="muted" style={styles.grow} numberOfLines={2}>
          {t("mobile.mission.plan.started", { title: m.title || goal })}
        </Text>
        <LineIcon name="right" size={15} color={c.faint} variant="small" />
      </Pressable>
    );
  }
  const items = (m.plan.items ?? []).filter((i) => i.status !== "dropped");
  const findings = m.findings ?? [];
  const investigated = findings.length > 0;
  return (
    <View style={[investigated ? styles.inv : styles.askcard, surface, ownTop]}>
      <View style={styles.row}>
        <Icon name="target" size={15} color={c.muted} />
        <Text variant="caption" tone="muted" style={[styles.bold, styles.shrink]}>
          {investigated
            ? t("missions.findings.proposed")
            : items.length > 0
              ? t("mobile.mission.plan.titleCount", { count: items.length })
              : t("mobile.mission.plan.title")}
        </Text>
      </View>
      <Text variant="body" style={[styles.bold, styles.title]}>
        {m.title || goal}
      </Text>
      {investigated ? <Findings findings={findings} /> : null}
      {investigated && items.length > 0 ? (
        <View style={[styles.plHead, { borderTopColor: c.line }]}>
          <Text variant="caption" tone="faint" style={styles.bold}>
            {t("missions.findings.plan", { count: items.length })}
          </Text>
        </View>
      ) : null}
      {items.slice(0, 4).map((it, i) => (
        <View key={it.id} style={styles.planRow}>
          <View style={styles.n}>
            <LineIcon variant="small" size={16}>
              <Count value={i + 1} size={13} />
            </LineIcon>
          </View>
          <Text variant="small" tone="ink2" style={styles.grow}>
            {it.title}
          </Text>
        </View>
      ))}
      {items.length > 4 ? (
        <Text variant="caption" tone="faint" style={styles.more}>
          {t("mobile.mission.plan.more", { count: items.length - 4 })}
        </Text>
      ) : null}
      {items.length === 0 ? (
        <Text variant="small" tone="muted">
          {t(`mobile.mission.plan.planning${g}`, { name })}
        </Text>
      ) : null}
      {m.canAct ? (
        <View style={styles.acts}>
          <View style={styles.grow}>
            <Button
              variant="secondary"
              size="sm"
              wide
              label={investigated ? t("missions.findings.adjust") : t("mobile.mission.plan.change")}
              onPress={() =>
                sheet.open(
                  <PromptForm
                    leading={<AgentFace agentId={m.agentId} size={32} />}
                    title={t("mobile.mission.plan.changeTitle")}
                    placeholder={t("mobile.mission.plan.changePlaceholder")}
                    submitLabel={t("mobile.app.send")}
                    onSubmit={(text) =>
                      api.missions.message(orgId, m.id, text).then(
                        (out) => {
                          sheet.close();
                          toast({
                            title: out.delivered
                              ? t("mobile.mission.plan.changeSent")
                              : t("mobile.mission.plan.changeQueued"),
                            agentId: m.agentId,
                          });
                        },
                        () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                      )
                    }
                  />,
                )
              }
            />
          </View>
          <View style={styles.grow}>
            <Button
              variant="primary"
              size="sm"
              wide
              label={t("mobile.mission.plan.start")}
              disabled={control.isPending || items.length === 0}
              onPress={() =>
                control.mutate(
                  { missionId: m.id, action: "start" },
                  {
                    onSuccess: () => {
                      successHaptic();
                      toast({
                        title: t("mobile.mission.plan.startedToast"),
                        subtitle: t(`mobile.mission.plan.startedSub${g}`, { name }),
                        agentId: m.agentId,
                      });
                    },
                    onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
                  },
                )
              }
            />
          </View>
        </View>
      ) : null}
      {m.canAct && investigated ? (
        <Text variant="caption" tone="faint" style={styles.note}>
          {t("missions.findings.note")}
        </Text>
      ) : null}
    </View>
  );
}

const FINDING_ICON = { read: "search", data: "chart", decision: "help" } as const;

/**
 * What the agent found before proposing: what it read (search), numbers
 * it saw (chart) and the one decision left for the person (help), in ink and bold: no band behind it, the card
 * holds no plate of its own. Refs are mono chips.
 */
function Findings({ findings }: { findings: MissionFinding[] }) {
  const { t } = useTranslation();
  const { colors, fonts } = useTheme();
  return (
    <View style={styles.fd}>
      {findings.map((f, i) => {
        const open = f.kind === "decision";
        return (
          <View
            key={`${f.kind}:${String(i)}`}
            style={styles.fdRow}
            accessible
            accessibilityLabel={`${t(`missions.findings.${f.kind}`)}: ${plainInline(f.text)}`}
          >
            <LineIcon name={FINDING_ICON[f.kind]} size={15} color={open ? colors.ink : colors.faint} variant="small" />
            <View style={styles.grow}>
              <Text variant="small" tone={open ? "ink" : "ink2"} style={open ? styles.bold : undefined}>
                {plainInline(f.text)}
              </Text>
              {f.refs && f.refs.length > 0 ? (
                <View style={styles.refs}>
                  {f.refs.slice(0, 6).map((ref) => (
                    <View key={ref} style={[styles.ref, { backgroundColor: colors.sunken }]}>
                      <RNText
                        numberOfLines={1}
                        maxFontSizeMultiplier={CHROME_MAX_SCALE}
                        style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.ink2 }}
                      >
                        {ref}
                      </RNText>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** A plan step's number column. */
const STEP_N = 16;

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  mcard: { padding: 14, borderRadius: 20, gap: 0 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  title: { marginTop: 6, marginBottom: 10 },
  titlePinned: { marginTop: 4, marginBottom: 8 },
  ft: { marginTop: 8, gap: 6 },
  askcard: { padding: 12, borderRadius: 20 },
  summary: { marginBottom: 10 },
  log: { fontSize: 12, lineHeight: 17, marginBottom: 10 },
  acts: { flexDirection: "row", gap: 8, marginTop: 4 },
  // Its words wrap to two lines: the icons stay on the first.
  done: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 20,
  },
  opts: { gap: 6 },
  // A long option wraps: its check and "Recommended" stay on its first line.
  opt: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 12, borderRadius: 14 },
  optText: { flex: 1, fontWeight: "500" },
  // A step's title wraps: its number stays on the first line.
  planRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 4 },
  n: { width: STEP_N, alignItems: "flex-end" },
  // Under the steps' words: past the number's column and the row's gap.
  more: { paddingLeft: STEP_N + 10, paddingBottom: 8 },
  inv: { padding: 14, borderRadius: 20 },
  fd: { gap: 8, marginBottom: 12 },
  fdRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  refs: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  ref: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, maxWidth: "100%" },
  plHead: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, marginBottom: 4 },
  note: { marginTop: 8, textAlign: "center" },
});
