import {
  type Message,
  sendHelpers,
  type TeamAgentDraft,
  type TeamPlan,
  type TeamProposalCard,
  useAiStatus,
  useApplyTeamTemplate,
  useMessages,
  usePostMessage,
  useTeamCard,
  useTeamTemplates,
} from "@agenteschat/client";
import { teamProposalOf } from "@agenteschat/client/lib/action-cards";
import { joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand, RIGHT_HAND_DEFAULT } from "@agenteschat/client/lib/right-hand";
import {
  answerAfter,
  answerPicks,
  answerText,
  firstTasks,
  replyChipsOf,
  teamColumns,
  teamCounts,
  teamFailureText,
  teamInDms,
  teamRoutines,
  teamStatus,
  teamUndoable,
} from "@agenteschat/client/lib/team-plan";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { WAVE_SECONDS } from "@agenteschat/ui/agent/stickers";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { StickerCanvas } from "@/agent/StickerCanvas";
import { useOrg } from "@/providers/org";
import {
  AgentAvatar,
  Button,
  EventPillAction,
  fieldText,
  Icon,
  LineIcon,
  Locked,
  MEDIA_ROW,
  MediaRow,
  Sheet,
  Text,
} from "@/ui";
import { router } from "@/ui/navigation";
import { fullLook } from "../agents/edit";
import { openConnectAi } from "../ai/NoAiCard";
import { usePlanHold } from "../ai/parts";
import { AskButtons, AskCard, AskDone, AskFoot } from "../chat/asks";
import { MESSAGE_STICKER } from "../chat/media";
import { useOpenDm } from "../new/useOpenDm";
import { useFailed } from "../routines/hooks";
import { proposedRoutineWhen } from "../routines/rule";
import { useColors, useDirectory, useMeId, useWhen } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";

/**
 * The right hand's team setup on the phone (ADR 0137 §10), as on the web: answers to tap as chips (each the person's
 * own message), the team card as stacked rows with the same buttons, the templates and the map as sheets. In a
 * personal workspace (ADR 0159) the words are about the person's agents, and an agent with no channel lives in its DM
 * with the person: no channel is named for it and, when none has one, there is no map to see.
 */

/** One answer to tap, as the right hand's questions draw them: the ink face with a check once picked. */
export function ChoiceChip({
  label,
  on,
  disabled = false,
  onPress,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      onPress={() => {
        tapHaptic();
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: on ? c.ink : pressed ? c.sunken : c.raised, borderColor: c.line2 },
      ]}
    >
      {on ? <Icon name="check" size={15} color={c.bg} /> : null}
      <Text variant="small" style={on ? { color: c.bg } : undefined}>
        {label}
      </Text>
    </Pressable>
  );
}

export function AnswerChips({
  choices,
  multiple,
  answer,
  onSend,
  step,
}: {
  choices: readonly string[];
  multiple: boolean;
  answer: string | null;
  onSend: (text: string) => void;
  step?: { step: number; of: number };
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const answered = answer !== null;
  const shown = answered ? new Set(answerPicks(choices, answer)) : picked;
  const listed = answered ? choices.filter((choice) => shown.has(choice)) : choices;
  if (listed.length === 0 && !(step && step.of > 1)) return null;
  return (
    <View style={styles.chips}>
      <View style={styles.chipRow}>
        {listed.map((choice) => (
          <ChoiceChip
            key={choice}
            label={choice}
            on={shown.has(choice)}
            disabled={answered}
            onPress={() => {
              if (!multiple) return onSend(choice);
              setPicked((p) => {
                const next = new Set(p);
                if (next.has(choice)) next.delete(choice);
                else next.add(choice);
                return next;
              });
            }}
          />
        ))}
      </View>
      <View style={styles.chipFoot}>
        {multiple && !answered && picked.size > 0 ? (
          <Button
            variant="primary"
            size="sm"
            label={t("teamPlan.send", { count: picked.size })}
            onPress={() => onSend(answerText(choices, picked))}
          />
        ) : null}
        {step && step.of > 1 ? (
          <Text variant="caption" tone="muted">
            {t("teamPlan.step", { step: step.step, of: step.of })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Sends a tapped answer in the conversation as the person, as the composer would. */
export function useSendAnswer(channelId: string) {
  const { orgId } = useOrg();
  const meId = useMeId();
  const post = usePostMessage(orgId, channelId, { me: { id: meId ?? "" } });
  return (text: string) => sendHelpers(post).send(text);
}

/** Under a right hand's question (`meta.replyChips`). */
export function ReplyChips({ message: m }: { message: Message }) {
  const { orgId } = useOrg();
  const messages = useMessages(orgId, m.channelId).data;
  const send = useSendAnswer(m.channelId);
  const chips = replyChipsOf(m.meta);
  if (!chips || m.author.type !== "agent") return null;
  return (
    <AnswerChips
      choices={chips.choices}
      multiple={chips.multiple}
      answer={answerAfter(messages, m.id)}
      onSend={send}
      step={{ step: chips.step, of: chips.of }}
    />
  );
}

/**
 * The team: a row per agent, its routines, its skills and what waits for approval. Flat on the card that holds it
 * (rows divided by hairlines, icons on the first line), never a plate or a box in a card. An agent's row is a MediaRow:
 * its face, name and role on one line, what it does, its channel and "Ajustar" under them at the card's width.
 * `reviewer`: the right hand's name, which keeps the weekly check (the onboarding has no workspace open to read it from).
 * `personal` (ADR 0159): each agent is someone to talk to, not a place, so its channel shows only in a team's workspace
 * and when it has one.
 */
export function TeamRows({
  plan,
  reviewer,
  personal = false,
  onAdjust,
}: {
  plan: TeamPlan;
  reviewer: string;
  personal?: boolean;
  onAdjust?: (a: TeamAgentDraft) => void;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const channelOf = (a: TeamAgentDraft) => (personal ? "" : a.channel);
  return (
    <View style={styles.rows}>
      {plan.agents.map((a, i) => (
        <View key={a.handle} style={i > 0 && [styles.divided, { borderTopColor: c.line2 }]}>
          <MediaRow
            face={<AgentAvatar agent={fullLook(a.appearance)} size={MEDIA_ROW.card.face} name={a.name} live={false} />}
            name={a.name}
            meta={a.role}
          >
            <Text variant="small" tone="ink2">
              {a.line}
            </Text>
            {/* Its channel under its words, "new" on its line; "Adjust" at the right. With no channel, only "Adjust",
                still at the right; with neither, nothing under its words. */}
            {channelOf(a) || onAdjust ? (
              <View style={styles.agentFoot}>
                {channelOf(a) ? (
                  <Text variant="footnote" tone="muted" style={styles.fill}>
                    #{a.channel}
                    {plan.newChannels.includes(a.channel) ? (
                      <Text variant="footnote" style={[styles.bold, { color: c.info }]}>
                        {` ${t("teamPlan.card.new")}`}
                      </Text>
                    ) : null}
                  </Text>
                ) : (
                  <View style={styles.fill} />
                )}
                {onAdjust ? (
                  <Button
                    variant="text"
                    size="sm"
                    label={t("teamPlan.card.adjustName", { name: a.name })}
                    onPress={() => onAdjust(a)}
                  />
                ) : null}
              </View>
            ) : null}
          </MediaRow>
        </View>
      ))}
      {teamRoutines(plan).length > 0 ? (
        <View style={styles.section}>
          <Text variant="footnote" tone="muted" style={styles.bold}>
            {t("teamPlan.card.routines")}
          </Text>
          {teamRoutines(plan).map(({ agent, routine }) => (
            <View key={`${agent?.handle ?? "weekly"}-${routine.name}`} style={styles.line}>
              <LineIcon name="clock" size={15} color={c.muted} variant="small" />
              <Text variant="small" style={styles.fill}>
                <Text variant="small" style={styles.bold}>
                  {proposedRoutineWhen(t, i18n.language, routine)}
                </Text>{" "}
                ·{" "}
                {agent
                  ? `${channelOf(agent) ? `${agent.name}, #${agent.channel}` : agent.name}: ${routine.name}`
                  : `${reviewer}: ${t(personal ? "teamPlan.card.weeklyPersonal" : "teamPlan.card.weekly")}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {plan.skills.length > 0 ? (
        <View style={styles.section}>
          <Text variant="footnote" tone="muted" style={styles.bold}>
            {t("teamPlan.card.skills")}
          </Text>
          {plan.skills.map((s) => (
            <View key={s.name} style={styles.line}>
              <LineIcon name="doc" size={15} color={c.muted} variant="small" />
              <Text variant="small" style={styles.fill}>
                <Text variant="small" style={styles.bold}>
                  {s.title}
                </Text>{" "}
                · {s.description}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {plan.approvals ? (
        <View style={[styles.line, styles.note]}>
          <LineIcon name="shield" size={15} color={c.muted} variant="small" />
          <Text variant="small" style={styles.fill}>
            {plan.approvals}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** "3 agents · 2 new channels · 3 routines"; a personal workspace counts no channels (ADR 0159). */
const countsText = (t: TFunction, plan: TeamPlan, personal: boolean) => {
  const n = teamCounts(plan);
  return [
    t("teamPlan.card.agents", { count: n.agents }),
    n.newChannels > 0 && !personal ? t("teamPlan.card.newChannels", { count: n.newChannels }) : "",
    n.routines > 0 ? t("teamPlan.card.routineCount", { count: n.routines }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

/** The right hand's team card in place of its text (`meta.actionCard.kind = team_proposal`). */
export function TeamCard({ message: m }: { message: Message }) {
  const card = teamProposalOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  return <TeamCardView message={m} card={card} />;
}

function TeamCardView({ message: m, card }: { message: Message; card: TeamProposalCard }) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const when = useWhen();
  const failed = useFailed();
  const held = usePlanHold(orgId, org) !== null;
  const team = useTeamCard(orgId, { channelId: m.channelId, messageId: m.id });
  // Made here and now, on a hold: when the new agents' wave started.
  const [waveFrom, setWaveFrom] = useState<number>();
  const [adjusting, setAdjusting] = useState<TeamAgentDraft | null>(null);
  const [map, setMap] = useState(false);
  const plan = card.params;
  const status = teamStatus(card);
  const personal = isPersonal(org);
  const names = joinNames(
    plan.agents.map((a) => a.name),
    t,
  );
  if (status === "open") {
    const decides = can(org, "create_agents");
    const busy = team.create.isPending || team.deny.isPending || card.state === "creating";
    // Agents that each live in a DM with the person have no map to show (ADR 0159): the rows say it all.
    const mapButton = teamInDms(plan) ? null : (
      <Button variant="secondary" size="card" wide label={t("teamPlan.card.map")} onPress={() => setMap(true)} />
    );
    const dismissButton =
      decides || card.forUserId === meId ? (
        <Button
          variant="ghost"
          size="card"
          wide
          label={t("rightHand.card.dismiss")}
          disabled={busy}
          onPress={() => team.deny.mutate(undefined, { onError: failed })}
        />
      ) : null;
    return (
      <>
        <AskCard
          id={m.id}
          kind="team"
          agentId={m.author.id ?? ""}
          waitsFor={decides ? "you" : t("teamPlan.card.onlyCreators")}
          lead={plan.lead || names}
          body={
            <>
              <TeamRows
                plan={plan}
                reviewer={dir.agents.find(isRightHand)?.name ?? RIGHT_HAND_DEFAULT.name}
                personal={personal}
                onAdjust={decides ? setAdjusting : undefined}
              />
              {card.error ? (
                <Text variant="small" tone="danger" accessibilityRole="alert">
                  {teamFailureText(t, card.error, i18n.language)}
                </Text>
              ) : null}
            </>
          }
          foot={
            <AskFoot>
              <Text variant="caption" tone="muted">
                {countsText(t, plan, personal)}
              </Text>
              {decides ? (
                <Button
                  variant="primary"
                  size="card"
                  wide
                  label={t(card.error ? "teamPlan.card.retry" : modeKey(org, "teamPlan.card.create"))}
                  loading={team.create.isPending || card.state === "creating"}
                  disabled={busy}
                  onPress={() =>
                    team.create.mutate(undefined, {
                      onSuccess: ({ noAi }) => {
                        if (held) setWaveFrom(Date.now());
                        else if (noAi?.[0]) openConnectAi({ agentId: noAi[0] });
                      },
                      onError: failed,
                    })
                  }
                />
              ) : null}
              {mapButton || dismissButton ? (
                <AskButtons
                  primary={mapButton ?? dismissButton}
                  secondary={mapButton ? (dismissButton ?? undefined) : undefined}
                />
              ) : null}
            </AskFoot>
          }
        />
        <AdjustSheet
          agent={adjusting}
          saving={team.adjust.isPending}
          onClose={() => setAdjusting(null)}
          onSave={(patch) =>
            adjusting &&
            team.adjust.mutate(
              { handle: adjusting.handle, patch },
              { onSuccess: () => setAdjusting(null), onError: failed },
            )
          }
        />
        <TeamMapSheet plan={plan} open={map} onClose={() => setMap(false)} />
      </>
    );
  }
  const decidedAt = card.decidedAt ? when.short(card.decidedAt) : undefined;
  if (status === "created") {
    const by = card.decidedByUserId === meId ? null : dir.memberById.get(card.decidedByUserId ?? "")?.name;
    const undoable = teamUndoable(card, { userId: meId ?? "", admin: can(org, "manage_agents") });
    const madeBy = by
      ? t(modeKey(org, "teamPlan.card.created"), { name: by })
      : t(modeKey(org, "teamPlan.card.createdYou"));
    return (
      <>
        <AskDone
          done
          words={`${madeBy}: ${names}`}
          time={decidedAt}
          actions={
            undoable ? (
              <EventPillAction
                label={t("agentActions.undo")}
                loading={team.undo.isPending}
                onPress={() => team.undo.mutate(undefined, { onError: failed })}
              />
            ) : null
          }
        />
        {card.created?.skipped.includes("skills") ? (
          <Text variant="footnote" tone="muted">
            {t("teamPlan.card.skillsWait")}
          </Text>
        ) : null}
        {waveFrom !== undefined ? (
          <View style={styles.wave} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {plan.agents.map((a) => (
              <StickerCanvas
                key={a.handle}
                look={fullLook(a.appearance)}
                mood="wave"
                size={MESSAGE_STICKER}
                seed={a.handle}
                live
                playFor={WAVE_SECONDS}
                from={waveFrom}
              />
            ))}
          </View>
        ) : null}
        {card.decidedByUserId === meId ? <FirstTasks message={m} card={card} held={held} /> : null}
      </>
    );
  }
  return (
    <AskDone
      done={false}
      time={decidedAt}
      words={`${t(
        status === "superseded"
          ? "rightHand.card.superseded"
          : status === "undone"
            ? modeKey(org, "teamPlan.card.undone")
            : status === "denied"
              ? modeKey(org, "teamPlan.card.dismissed")
              : "approval.expired",
      )}: ${names}`}
    />
  );
}

/**
 * A first task per agent (its DM opens with it typed, never sent, for the person to finish) and inviting the people.
 * Only once the team can answer: never on a billing hold, nor before an AI.
 */
function FirstTasks({ message: m, card, held }: { message: Message; card: TeamProposalCard; held: boolean }) {
  const { t } = useTranslation();
  const { org, orgId } = useOrg();
  const dir = useDirectory();
  const c = useColors();
  const openDm = useOpenDm();
  const thinks = useAiStatus(orgId).data?.any === true;
  const [later, setLater] = useState(false);
  const tasks = firstTasks(card).filter((f) => dir.agentById.has(f.agentId));
  // No "Invite …" in a personal workspace (ADR 0159): it is for one person, inviting stays in Settings.
  const people = isPersonal(org) ? [] : card.params.invite;
  if (later || held || !thinks || (tasks.length === 0 && people.length === 0)) return null;
  return (
    <AskCard
      id={`${m.id}-first`}
      kind="firstTask"
      agentId={m.author.id ?? ""}
      waitsFor={t("teamPlan.firstTask.suggestion")}
      lead={t("teamPlan.firstTask.lead")}
      body={
        <View style={styles.rows}>
          {tasks.map((f, i) => (
            <View key={f.agentId} style={i > 0 && [styles.divided, { borderTopColor: c.line2 }]}>
              {/* The task under the name at the card's width, its one action under it at its start. */}
              <MediaRow
                face={
                  <AgentAvatar agent={fullLook(f.appearance)} size={MEDIA_ROW.card.face} name={f.name} live={false} />
                }
                name={f.name}
              >
                <Text variant="small" tone="ink2">
                  {f.task}
                </Text>
                <View style={styles.agentFoot}>
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("teamPlan.firstTask.open")}
                    onPress={() => void openDm({ agentId: f.agentId }, { compose: true, text: `${f.task} ` })}
                  />
                </View>
              </MediaRow>
            </View>
          ))}
        </View>
      }
      foot={
        <AskFoot>
          <AskButtons
            primary={
              people.length > 0 && can(org, "invite_people") ? (
                <Button
                  variant="primary"
                  size="card"
                  wide
                  label={t("teamPlan.firstTask.invite", { names: joinNames(people, t) })}
                  onPress={() => router.push("/invite-people")}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="card"
                  wide
                  label={t("teamPlan.firstTask.later")}
                  onPress={() => setLater(true)}
                />
              )
            }
            secondary={
              people.length > 0 && can(org, "invite_people") ? (
                <Button
                  variant="ghost"
                  size="card"
                  wide
                  label={t("teamPlan.firstTask.later")}
                  onPress={() => setLater(true)}
                />
              ) : undefined
            }
          />
        </AskFoot>
      }
    />
  );
}

type AdjustPatch = {
  name: string;
  role: string;
  line: string;
  channel: string;
  instructions: string;
  firstTask: string;
};

/** "Ajustar": the agent's draft on the card, edited in a sheet before the team exists. */
function AdjustSheet({
  agent,
  saving,
  onSave,
  onClose,
}: {
  agent: TeamAgentDraft | null;
  saving: boolean;
  onSave: (patch: AdjustPatch) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={agent !== null} onClose={onClose} solid>
      {agent ? <AdjustForm key={agent.handle} agent={agent} saving={saving} onSave={onSave} onClose={onClose} /> : null}
    </Sheet>
  );
}

function AdjustForm({
  agent,
  saving,
  onSave,
  onClose,
}: {
  agent: TeamAgentDraft;
  saving: boolean;
  onSave: (patch: AdjustPatch) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [v, setV] = useState<AdjustPatch>({
    name: agent.name,
    role: agent.role,
    line: agent.line,
    channel: agent.channel,
    instructions: agent.instructions,
    firstTask: agent.firstTask ?? "",
  });
  const field = [styles.field, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  const input = (key: keyof AdjustPatch, label: string, max: number) => (
    <View style={styles.formRow}>
      <Text variant="footnote" tone="muted">
        {label}
      </Text>
      <TextInput
        value={v[key]}
        maxLength={max}
        accessibilityLabel={label}
        onChangeText={(text) => setV((p) => ({ ...p, [key]: text }))}
        style={field}
      />
    </View>
  );
  return (
    <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
      <Text variant="title2">{t("teamPlan.adjust.title", { name: agent.name })}</Text>
      <Locked when={saving} style={styles.fields}>
        {input("name", t("teamPlan.adjust.name"), 80)}
        {input("role", t("teamPlan.adjust.role"), 200)}
        {input("line", t("teamPlan.adjust.line"), 300)}
        {/* An agent with no channel lives in its DM with the person (ADR 0159): nothing to name. */}
        {agent.channel ? input("channel", t("teamPlan.adjust.channel"), 80) : null}
        <View style={styles.formRow}>
          <Text variant="footnote" tone="muted">
            {t("teamPlan.adjust.instructions")}
          </Text>
          <TextArea
            value={v.instructions}
            accessibilityLabel={t("teamPlan.adjust.instructions")}
            onChangeText={(text) => setV((p) => ({ ...p, instructions: text }))}
          />
        </View>
        {input("firstTask", t("teamPlan.adjust.firstTask"), 500)}
      </Locked>
      <Button variant="primary" wide label={t("common.save")} loading={saving} onPress={() => onSave(v)} />
      <Button variant="ghost" wide label={t("common.cancel")} onPress={onClose} />
    </ScrollView>
  );
}

/**
 * "See as a map" as a sheet: the people, a block per channel with its agents and routines, the weekly reviewer. An
 * agent with no channel (it lives in its DM with the person, ADR 0159) has a block of its own, with no channel on top.
 */
export function TeamMapSheet({ plan, open, onClose }: { plan: TeamPlan; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const c = useColors();
  const dir = useDirectory();
  const lodi = dir.agents.find(isRightHand);
  return (
    <Sheet open={open} onClose={onClose} solid>
      <ScrollView contentContainerStyle={styles.form}>
        <Text variant="title2">{t(modeKey(org, "teamPlan.map.title"))}</Text>
        <Text variant="footnote" tone="muted" style={styles.bold}>
          {t("teamPlan.map.people")}
        </Text>
        <Text variant="small">{joinNames([t("agentActions.you"), ...plan.invite], t)}</Text>
        {teamColumns(plan).map((col) => (
          <View key={col.key} style={[styles.mapCol, { borderColor: c.line2 }]}>
            {col.channel ? (
              <View style={styles.line}>
                <LineIcon name="hash" size={17} color={c.muted} />
                {/* "New" inside the name's line, on its baseline. */}
                <Text variant="body" style={[styles.bold, styles.fill]}>
                  {col.channel}
                  {col.fresh ? (
                    <Text variant="caption" style={[styles.bold, { color: c.info }]}>
                      {` ${t("teamPlan.card.new")}`}
                    </Text>
                  ) : null}
                </Text>
              </View>
            ) : null}
            {col.agents.map((a) => (
              <MediaRow
                key={a.handle}
                size="row"
                face={
                  <AgentAvatar agent={fullLook(a.appearance)} size={MEDIA_ROW.row.face} name={a.name} live={false} />
                }
                name={a.name}
                meta={a.role}
              >
                {a.routines.map((r) => (
                  <View key={r.name} style={styles.line}>
                    <LineIcon name="clock" size={14} color={c.muted} variant="footnote" />
                    <Text variant="footnote" tone="muted" style={styles.fill}>
                      {proposedRoutineWhen(t, i18n.language, r)}
                    </Text>
                  </View>
                ))}
              </MediaRow>
            ))}
          </View>
        ))}
        {plan.weekly && lodi ? (
          <Text variant="small" tone="muted">
            {t("teamPlan.map.reviewer", { name: lodi.name })}
          </Text>
        ) : null}
        {plan.approvals ? (
          <Text variant="small">
            <Text variant="small" style={styles.bold}>
              {t("teamPlan.map.waits")}
            </Text>{" "}
            · {plan.approvals}
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

/**
 * "Team templates" as a sheet: the templates, each opening its team; "Create the team" makes it. In a personal
 * workspace (ADR 0159) the server lists them by area of life, and the words are about the person's agents.
 */
export function TeamTemplatesSheet({
  open,
  onClose,
  onNone,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  /** "Nenhum desses": back to writing what they do. */
  onNone: () => void;
  /** The business the first run's row 1 saved (ADR 0155 §6): its template opens picked. */
  initial?: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const c = useColors();
  const failed = useFailed();
  const dir = useDirectory();
  const held = usePlanHold(orgId, org) !== null;
  const personal = isPersonal(org);
  const name = dir.agents.find(isRightHand)?.name ?? RIGHT_HAND_DEFAULT.name;
  const list = useTeamTemplates(orgId, i18n.language, open);
  const use = useApplyTeamTemplate(orgId);
  const [picked, setPicked] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    if (open) setPicked(initial ?? null);
    setRefused(null);
  }, [open, initial]);
  const chosen = list.data?.find((x) => x.id === picked) ?? null;
  return (
    <Sheet open={open} onClose={onClose} solid>
      <ScrollView contentContainerStyle={styles.form}>
        <Text variant="title2">{chosen ? chosen.name : t(modeKey(org, "teamPlan.templates.title"))}</Text>
        <Text variant="small" tone="muted">
          {chosen
            ? chosen.description
            : held
              ? t(modeKey(org, "teamPlan.templates.heldLead"))
              : t(modeKey(org, "teamPlan.templates.lead"), { name })}
        </Text>
        {chosen ? (
          <>
            <TeamRows plan={chosen.team} reviewer={name} personal={personal} />
            {held ? null : (
              <Text variant="footnote" tone="muted">
                {t(modeKey(org, "teamPlan.templates.tailor"))}
              </Text>
            )}
            <Text variant="caption" tone="muted">
              {countsText(t, chosen.team, personal)}
            </Text>
            <Button
              variant="primary"
              wide
              label={t(modeKey(org, "teamPlan.templates.create"))}
              loading={use.isPending}
              onPress={() =>
                use.mutate(
                  { templateId: chosen.id, locale: i18n.language },
                  {
                    // A step that failed: its reason, and the card stays open in the right hand's DM.
                    onSuccess: (out) =>
                      out.state === "created"
                        ? onClose()
                        : setRefused(
                            out.error
                              ? teamFailureText(t, out.error, i18n.language)
                              : t(modeKey(org, "teamPlan.templates.failed")),
                          ),
                    onError: failed,
                  },
                )
              }
            />
            {refused ? (
              <Text variant="small" tone="danger">
                {refused}
              </Text>
            ) : null}
            <Button
              variant="ghost"
              wide
              label={t("common.back")}
              disabled={use.isPending}
              onPress={() => setPicked(null)}
            />
          </>
        ) : (
          <>
            {(list.data ?? []).map((x) => (
              <Pressable
                key={x.id}
                accessibilityRole="button"
                onPress={() => setPicked(x.id)}
                style={({ pressed }) => [
                  styles.template,
                  { borderColor: c.line2, backgroundColor: pressed ? c.sunken : c.raised },
                ]}
              >
                <View style={styles.faces}>
                  {x.team.agents.map((a) => (
                    <AgentAvatar key={a.handle} agent={fullLook(a.appearance)} size={22} name={a.name} live={false} />
                  ))}
                </View>
                <View style={styles.fill}>
                  <Text variant="body" style={styles.bold}>
                    {x.name}
                  </Text>
                  <Text variant="small" tone="muted">
                    {x.sub}
                  </Text>
                </View>
              </Pressable>
            ))}
            {held ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={onNone}
                style={({ pressed }) => [
                  styles.template,
                  { borderColor: c.line2, backgroundColor: pressed ? c.sunken : c.raised },
                ]}
              >
                <View style={styles.faces}>
                  <Icon name="pen" size={16} color={c.muted} />
                </View>
                <View style={styles.fill}>
                  <Text variant="body" style={styles.bold}>
                    {t("teamPlan.templates.none")}
                  </Text>
                  <Text variant="small" tone="muted">
                    {t(modeKey(org, "teamPlan.templates.noneSub"), { name })}
                  </Text>
                </View>
              </Pressable>
            )}
            <Button
              variant="text"
              size="sm"
              label={t("teamPlan.templates.import")}
              onPress={() => {
                onClose();
                router.push("/settings/import");
              }}
            />
            <Button
              variant="text"
              size="sm"
              label={t("teamPlan.templates.scratch")}
              onPress={() => {
                onClose();
                router.push("/new-agent");
              }}
            />
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  wave: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  chips: { gap: 8, marginTop: 6 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipFoot: { flexDirection: "row", alignItems: "center", gap: 12 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderBottomLeftRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rows: { gap: 8 },
  // 12 above the hairline (with the rows' gap) and 12 under it.
  divided: { marginTop: 4, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  // Under the agent's words, at the row's width.
  agentFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  section: { gap: 6, marginTop: 4 },
  // An icon on the first line of its words, as the conversation's event lines.
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  note: { marginTop: 4 },
  fill: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  form: { gap: 12, padding: 16, paddingBottom: 32 },
  fields: { gap: 12 },
  formRow: { gap: 4 },
  field: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 },
  mapCol: { gap: 8, padding: 12, borderRadius: 14, borderWidth: 1, borderStyle: "dashed" },
  template: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  faces: { flexDirection: "row", gap: 2, width: 72, justifyContent: "center" },
});
