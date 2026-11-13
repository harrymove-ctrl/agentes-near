import {
  type Agent,
  type AgentAudience,
  type ForeignMailbox,
  type Message,
  useChannels,
  useRoles,
  useWidenAudience,
} from "@agenteschat/client";
import {
  type AgentUnavailableEvent,
  audienceNotice,
  audienceWith,
  audienceWithMe,
  canEditAudience,
  modeOf,
  opensOthersPlan,
  unavailableNotice,
  widenQuestion,
} from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { type ReachEntry, reachKey, reachOf, reachOpens } from "@agenteschat/client/lib/reach";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, LineIcon, ROW_CARD_INSET, RowAction, Text, useTheme, useToast } from "@/ui";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { boldRuns } from "./actions";
import { ConsultPairRow, useConsultById } from "./ConsultGroup";
import { useCardTop, useRhythm } from "./look";

const LIST_GAP = 8;

/**
 * On the phone, under an agent's message, every agent it @named that its mention didn't wake (`meta.reach`): one
 * outside the conversation got it by direct message (the two agents' pair row, opening their conversation), one it couldn't call
 * says why, and the agent's owner can let that person talk to it. The receipts' card, as the team actions' rows
 * beside it (TeamChecks.tsx): a sunken fill here stood apart from the raised cards under the same reply.
 */
export function ReachLines({ message: m }: { message: Message }) {
  const list = reachOf(m.meta);
  // Cards under the message's words: the body's card gap above them, as every card in a message.
  const cardTop = useCardTop();
  if (m.author.type !== "agent" || list.length === 0) return null;
  return (
    <View style={[styles.list, cardTop]}>
      {list.map((e, i) => (
        <Row key={e.agentId} entry={e} above={list[i - 1]} channelId={m.channelId} authorId={m.author.id ?? ""} />
      ))}
    </View>
  );
}

function Row({
  entry: e,
  above,
  channelId,
  authorId,
}: {
  entry: ReachEntry;
  above: ReachEntry | undefined;
  channelId: string;
  authorId: string;
}) {
  const { t } = useTranslation();
  const rhythm = useRhythm();
  const { colors } = useTheme();
  const orgId = useOrgId();
  const dir = useDirectory();
  const channel = useChannels(orgId).data?.find((c) => c.id === channelId);
  // A DM isn't in the channel list: "in this conversation".
  const place = channel ? t("reach.inChannel", { name: channel.name }) : t("reach.inHere");
  const agent = dir.agentById.get(e.agentId);
  const g = agentGrammar(agent?.name ?? `@${e.handle}`);
  const handed = Boolean(e.consultationId);
  const talk = useConsultById(channelId, reachOpens(e) ? e.consultationId : undefined);
  const talkAbove = useConsultById(channelId, above && reachOpens(above) ? above.consultationId : undefined);
  const runs = boldRuns(t(reachKey(e) as "reach.handed", { ...g, place }) as string);
  const detail = [
    !handed && e.outside ? t("reach.outside", { place }) : null,
    e.routine ? t("reach.routine", { name: e.routine.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Handed to it by direct message: the two agents talking, as the pair row that opens their conversation.
  // Under another such line they stack as one group, as the list's quiet lines do: the part gap between them, past
  // the room the one above keeps under it and the list's own gap.
  if (talk)
    return (
      <ConsultPairRow
        askerId={authorId}
        channelId={channelId}
        items={[talk]}
        inline
        gap={talkAbove ? rhythm.part - (rhythm.turn - rhythm.part) - LIST_GAP : undefined}
      />
    );
  return (
    <View style={[styles.one, { backgroundColor: colors.raised, borderColor: colors.line2 }]}>
      <View style={styles.head}>
        <LineIcon name={handed ? "chat" : "info"} size={15} color={colors.muted} variant="small" />
        <View style={styles.words}>
          <Text variant="small" tone="ink2">
            {runs.map((r, i) =>
              r.bold ? (
                <Text key={String(i)} variant="small" tone="ink" style={styles.bold}>
                  {r.text}
                </Text>
              ) : (
                r.text
              ),
            )}
          </Text>
          {detail ? (
            <Text variant="caption" tone="faint" numberOfLines={1} style={styles.detail}>
              {detail}
            </Text>
          ) : null}
        </View>
      </View>
      {/* The action under the words, on their column: a long one ("Deixar Heitor Lima falar com ela") beside them
          squeezed the words into three cut lines. */}
      {!handed && agent && e.userId ? (
        <View style={styles.act}>
          <AllowTalkAction agent={agent} userId={e.userId} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * "Deixar Ana falar com ele": lets `userId` talk to the agent, for its owner and who manages agents, when its
 * audience keeps them out (a routine's creator it couldn't reach). Nothing otherwise.
 */
export function AllowTalkAction({ agent, userId }: { agent: Agent; userId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const me = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const save = useWidenAudience(orgId, agent.id);
  const ask = useWidenAsk(agent);
  const person = dir.memberById.get(userId)?.name;
  const audience = audienceWith(agent, userId);
  if (!person || !audience || !me || modeOf(agent) === "everyone" || !canEditAudience(org ?? undefined, agent, me))
    return null;
  const g = agentGrammar(agent.name);
  return (
    <RowAction
      label={t("reach.allow", { person, context: g.context })}
      onPress={() => {
        if (save.busy || save.done) return;
        tapHaptic();
        // A failure says why (it used to do nothing at all, and the person was left guessing).
        save
          .saveAsync(audience, ask(audience))
          .then((saved) => saved && toast({ title: t("reach.allowed", { person, name: g.name }) }))
          .catch((error: unknown) => toast({ title: errorText(t, error), icon: "x" }));
      }}
    />
  );
}

/**
 * "Quero falar com ele": who manages agents (or owns it) lets themselves into an agent that keeps them out. Nothing
 * when it answers them already. On someone else's plan it asks first (`useWidenAsk`).
 */
export function LetMeTalkButton({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const me = useMeId();
  const toast = useToast();
  const save = useWidenAudience(orgId, agent.id);
  const ask = useWidenAsk(agent);
  const audience = me ? audienceWithMe(org ?? undefined, agent, me) : null;
  if (!audience) return null;
  const g = agentGrammar(agent.name);
  return (
    <Button
      variant="primary"
      size="sm"
      label={t("reach.allowMe", g)}
      disabled={save.busy || save.done}
      onPress={() => {
        tapHaptic();
        save
          .saveAsync(audience, ask(audience))
          .then((saved) => saved && toast({ title: t("reach.allowedMe", g) }))
          .catch((error: unknown) => toast({ title: errorText(t, error), icon: "x" }));
      }}
    />
  );
}

/**
 * In place of the composer, in a conversation with an agent that doesn't answer me (who manages agents opens it): why,
 * and "Quero falar com ele" when I may let myself in.
 */
export function AgentLocked({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const roles = useRoles(useOrgId()).data?.roles;
  const notice = audienceNotice(
    t,
    agent,
    (id) => dir.memberById.get(id)?.name,
    (id) => roles?.find((r) => r.id === id)?.name,
  );
  return (
    <View style={styles.locked}>
      <Text variant="small" tone="muted" style={styles.lockedText}>
        {notice}
      </Text>
      <LetMeTalkButton agent={agent} />
    </View>
  );
}

/**
 * Over the composer, as the web's line under my message: why each agent my message here named won't answer me
 * (`agent.unavailable`), in my words.
 */
export function UnavailableLines({ notices }: { notices: AgentUnavailableEvent[] }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const dir = useDirectory();
  const roles = useRoles(useOrgId()).data?.roles;
  if (notices.length === 0) return null;
  return (
    <View style={styles.unavailable} accessibilityLiveRegion="polite">
      {notices.map((n) => (
        <View key={n.agentId} style={styles.unavailableRow}>
          <LineIcon name="lock" size={13} color={colors.muted} variant="footnote" />
          <Text variant="footnote" tone="muted" style={styles.grow}>
            {unavailableNotice(
              t,
              n,
              dir.agentById.get(n.agentId),
              (id) => dir.memberById.get(id)?.name,
              (id) => roles?.find((r) => r.id === id)?.name,
            )}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The one question before a wider audience (`widenQuestion`), as an alert: on someone else's plan, that it uses their
 * plan and they get an email, and the mailboxes other people gave the agent that it loses. `ask(next)(mailboxes)`
 * answers whether to go on, at once when there is nothing to ask. Every save that widens an audience goes through it.
 */
export function useWidenAsk(agent: Agent | undefined) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const me = useMeId();
  return (next: AgentAudience) =>
    (mailboxes: ForeignMailbox[]): Promise<boolean> => {
      if (!agent) return Promise.resolve(true);
      const owner =
        me && opensOthersPlan(agent, next, me)
          ? (dir.memberById.get(agent.ownerUserId ?? "")?.name ?? t("channel.unknownPerson"))
          : null;
      return confirmQuestion(t, widenQuestion(t, agent, owner, mailboxes));
    };
}

/** Asks `question` with Cancel and Continue (none: yes at once). */
export function confirmQuestion(t: TFunction, question: { title: string; description: string } | null) {
  if (!question) return Promise.resolve(true);
  return new Promise<boolean>((answer) =>
    Alert.alert(
      question.title,
      question.description,
      [
        { text: t("common.cancel"), style: "cancel", onPress: () => answer(false) },
        { text: t("common.continue"), onPress: () => answer(true) },
      ],
      { cancelable: true, onDismiss: () => answer(false) },
    ),
  );
}

const styles = StyleSheet.create({
  list: { gap: LIST_GAP },
  locked: { alignItems: "center", gap: 10, paddingVertical: 6 },
  unavailable: { gap: 4, paddingHorizontal: 16, paddingBottom: 6 },
  unavailableRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  lockedText: { textAlign: "center" },
  bold: { fontWeight: "600" },
  // The icon on the words' first line, the words across the card; the action under them on their column.
  one: {
    gap: 4,
    paddingVertical: 12,
    ...ROW_CARD_INSET,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
  },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  words: { flex: 1, minWidth: 0 },
  // The text column: the icon's 15 and the 8 after it.
  act: { paddingLeft: 15 + 8, alignItems: "flex-start" },
  detail: { marginTop: 2 },
});
