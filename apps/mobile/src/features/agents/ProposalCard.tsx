import {
  type AgentDraft,
  type AgentProposalCard,
  type Message,
  useAskAgentProposal,
  useCatalog,
  useChannels,
  useConnections,
  useCreateProposedAgent,
  useCreateProposedRoutine,
  useCustomServers,
  useDenyAgentProposal,
  useMembers,
  useRoles,
} from "@agenteschat/client";
import {
  agentProposalOf,
  type ProposalLine,
  proposalLines,
  proposalStatus,
  routineLeft,
  suggestedAiText,
} from "@agenteschat/client/lib/action-cards";
import { delegateLine, delegateUndoLine } from "@agenteschat/client/lib/approval-words";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { can } from "@agenteschat/client/lib/permissions";
import { sentToText } from "@agenteschat/client/lib/proposals";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { holdersOf } from "@agenteschat/client/lib/roles";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { AgentAvatar, Button, Icon, LineIcon, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { openConnectAi } from "../ai/NoAiCard";
import { AskButtons, AskCard, AskDone, AskFoot, ExpiryLine, useAskStore } from "../chat/asks";
import { requestComposerText } from "../chat/composer-request";
import { markName } from "../chat/logic";
import { useCardTop } from "../chat/look";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { chatHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { proposedRoutineWhen } from "../routines/rule";
import { useDirectory, useMeId, useWhen } from "../shared/hooks";
import { fullLook } from "./edit";
import { useDelegateUndoAction } from "./RightHandDelegate";

/**
 * An agent's proposal of a new agent (ADR 0081): while it is open, the request card (the agent's reason, the draft
 * in the well, the AI it would think with under "Ver a mudança", what it gets a line each with who gives a line the
 * viewer can't). Criar makes it as it is in one tap, Revisar opens "Criar agente" filled in with it, Recusar says no,
 * for who may create agents. Then one line with what was decided; it opens the draft, the lines it got and, once
 * created, the way to the new agent's page.
 *
 * The right hand's (ADR 0137) reads Criar e testar, full width, when it comes with a first task (created, the task goes
 * from the tapper in their DM with it, which opens), then Editar antes and Descartar; a newer one for the same agent
 * puts it away; and a person who can't create agents sends it to whoever may (Pedir a um admin), then reads whom it
 * went to. In their inbox it is the same card.
 */
export function ProposalCard({ message: m }: { message: Message }) {
  const card = agentProposalOf(m.meta);
  if (!card || m.author.type !== "agent") return null;
  return <AgentProposalView messageId={m.id} proposerId={m.author.id} sentAt={m.createdAt} card={card} />;
}

export function AgentProposalView({
  messageId,
  proposerId,
  sentAt,
  card,
}: {
  messageId: string;
  proposerId: string | null;
  /** When the card was posted: the fuse burns from it to the expiry. */
  sentAt: string;
  card: AgentProposalCard;
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const when = useWhen();
  const { colors } = useTheme();
  const cardTop = useCardTop();
  const create = useCreateProposedAgent(orgId);
  const makeRoutine = useCreateProposedRoutine(orgId);
  const deny = useDenyAgentProposal(orgId);
  const ask = useAskAgentProposal(orgId);
  const members = useMembers(orgId).data ?? [];
  const roles = useRoles(orgId).data?.roles ?? [];
  const failed = useFailed();
  const asks = useAskStore();
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  const decides = status === "open" && can(org, "create_agents");
  const agent = proposerId ? dir.agentById.get(proposerId) : undefined;
  const proposer = agent?.name || t("channel.unknownAgent");
  const rightHand = isRightHand(agent);
  // The person it is for, who can't create agents: they send it on (the right hand's cards only).
  const sends = status === "open" && rightHand && !decides && card.forUserId === meId;
  // Only for the person it was written for: anyone else (an admin from the inbox) gets the plain Criar.
  const firstTask = rightHand && card.forUserId === meId ? card.params.firstTask : undefined;
  const test = Boolean(firstTask);
  const sent =
    sends && card.askedAt
      ? sentToText(
          t,
          i18n.language,
          holdersOf(members, roles, "create_agents").map((p) => p.name),
          card.askedAt,
        )
      : null;
  const lines = proposalLines(card, { userId: meId ?? "", admin: can(org, "manage_agents") });
  // The right hand looked at it for the person it is for (ADR 0139): its line, Desfazer and "Por quê?".
  const delegate = card.delegate;
  const delegateUndo = useDelegateUndoAction(delegate);
  const delegated = delegate
    ? delegateLine(
        t,
        delegate,
        meId ?? null,
        (id) => dir.memberById.get(id)?.name,
        dir.agentById.get(delegate.agentId)?.name ?? "",
      )
    : null;
  const byRightHand =
    status === "created" && delegated && (delegate?.state === "approved" || delegate?.state === "undone");
  const outcome =
    status === "created"
      ? t("actionCard.agentProposal.created")
      : status === "denied"
        ? t("proposals.refused")
        : status === "expired"
          ? t("approval.expired")
          : status === "superseded"
            ? t("rightHand.card.superseded")
            : decides
              ? null
              : t("proposals.waitingAdmin");
  const busy = create.isPending || deny.isPending;
  const createIt = () =>
    create.mutate(
      { messageId, test },
      {
        onSuccess: ({ agent: made, ai, testChannelId }) => {
          asks?.settle(messageId);
          // Nothing to think with yet (the tapper's accounts decide, not the suggestion): it is created all the same,
          // and Connect opens for it here. Tried: its DM, the task in the composer.
          if (ai === "none") openConnectAi({ agentId: made.id });
          else if (testChannelId) {
            if (firstTask) requestComposerText(testChannelId, firstTask);
            router.push(chatHref(testChannelId));
          }
        },
        onError: failed,
      },
    );
  const edit = () => router.push(`/new-agent?proposal=${encodeURIComponent(messageId)}` as never);
  const dismiss = () => deny.mutate(messageId, { onSuccess: () => asks?.settle(messageId), onError: failed });
  if (status === "open") {
    return (
      <AskCard
        id={messageId}
        kind="agent"
        agentId={proposerId ?? ""}
        waitsFor={decides ? "you" : sends && !card.askedAt ? t("rightHand.card.onlyCreators") : null}
        lead={why || t("actionCard.agentProposal.title", { agent: proposer })}
        well={{
          tile: <AgentAvatar agent={fullLook(draft.appearance)} size={20} name={draft.name} live={false} />,
          title: draft.name,
          detail: [`@${draft.handle}`, draft.role].filter(Boolean).join(" · "),
          more: {
            label: t("ask.seeChange"),
            content: (
              <Text variant="footnote" tone="muted">
                {suggestedAiText(t, draft.ai)}
              </Text>
            ),
          },
        }}
        body={
          delegated || lines.length > 0 ? (
            <>
              {delegated ? (
                <Text variant="footnote" tone="muted">
                  {delegated}
                </Text>
              ) : null}
              {lines.length > 0 ? <Lines lines={lines} draft={draft} /> : null}
            </>
          ) : undefined
        }
        expiry={<ExpiryLine createdAt={sentAt} expiresAt={card.expiresAt} />}
        foot={
          <AskFoot>
            {decides && rightHand ? (
              <>
                <Button
                  variant="primary"
                  size="card"
                  wide
                  icon={test ? "bolt" : undefined}
                  label={test ? t("rightHand.card.createTest") : t("newAgent.create", { name: draft.name })}
                  disabled={busy}
                  onPress={createIt}
                />
                <AskButtons
                  primary={
                    <Button
                      variant="secondary"
                      size="card"
                      wide
                      label={t("rightHand.card.editFirst")}
                      disabled={busy}
                      onPress={edit}
                    />
                  }
                  secondary={
                    <Button
                      variant="ghost"
                      size="card"
                      wide
                      label={t("rightHand.card.dismiss")}
                      disabled={busy}
                      onPress={dismiss}
                    />
                  }
                />
              </>
            ) : decides ? (
              <>
                <AskButtons
                  primary={
                    <Button
                      variant="primary"
                      size="card"
                      wide
                      label={t("newAgent.create", { name: draft.name })}
                      disabled={busy}
                      onPress={createIt}
                    />
                  }
                  secondary={
                    <Button
                      variant="secondary"
                      size="card"
                      wide
                      label={t("actionCard.agentProposal.review")}
                      disabled={busy}
                      onPress={edit}
                    />
                  }
                />
                <Button
                  variant="ghost"
                  size="card"
                  wide
                  label={t("approval.refuse")}
                  disabled={busy}
                  onPress={dismiss}
                />
              </>
            ) : sent ? (
              <View style={styles.sent}>
                <LineIcon variant="small" name="send" size={15} color={colors.muted} />
                <Text variant="small" tone="muted" style={styles.fill}>
                  {sent}
                </Text>
              </View>
            ) : sends ? (
              <Button
                variant="primary"
                size="card"
                wide
                icon="send"
                label={t("rightHand.card.askAdmin")}
                loading={ask.isPending}
                onPress={() => ask.mutate(messageId, { onError: failed })}
              />
            ) : (
              <Text variant="small" tone="muted">
                {outcome}
              </Text>
            )}
          </AskFoot>
        }
      />
    );
  }
  return (
    <AskDone
      done={status === "created" && delegate?.state !== "undone"}
      words={`${byRightHand ? delegated : outcome}: ${markName(draft.name)}`}
      time={card.decidedAt ? when.short(card.decidedAt) : undefined}
      actions={byRightHand ? delegateUndo : null}
      more={{
        card: true,
        label: t(byRightHand && delegate?.state === "approved" ? "rightHandApprovals.card.why" : "ask.seeChange"),
        content: (
          <View style={[styles.card, { backgroundColor: colors.sunken }, cardTop]}>
            <View style={styles.row}>
              <AgentAvatar agent={fullLook(draft.appearance)} size={40} name={draft.name} live={false} />
              <View style={styles.fill}>
                <Text variant="body" style={styles.bold}>
                  {draft.name}
                </Text>
                <Text variant="footnote" tone="muted">
                  {[`@${draft.handle}`, draft.role].filter(Boolean).join(" · ")}
                </Text>
              </View>
            </View>
            {byRightHand && delegate?.reason ? (
              <Text variant="footnote" tone="ink2">
                {delegate.reason}
              </Text>
            ) : why ? (
              <Text variant="footnote" tone="ink2">
                {why}
              </Text>
            ) : null}
            {lines.length > 0 ? <Lines lines={lines} draft={draft} /> : null}
            <Text variant="footnote" tone="muted">
              {byRightHand && delegate?.state === "approved"
                ? delegateUndoLine(t, i18n.language, delegate, draft.name)
                : suggestedAiText(t, draft.ai)}
            </Text>
            {status === "created" && (card.agentId || routineLeft(card)) ? (
              <View style={styles.acts}>
                {card.agentId ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("newAgent.openProfile")}
                    onPress={() => router.push(`/agent/${encodeURIComponent(card.agentId ?? "")}` as never)}
                  />
                ) : null}
                {routineLeft(card) && (card.decidedByUserId === meId || can(org, "manage_routines")) ? (
                  // Not made with it (the agent wasn't where it reports yet): made from here once it is.
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("newAgent.routineKeep", { name: draft.routine?.name })}
                    disabled={makeRoutine.isPending}
                    onPress={() => makeRoutine.mutate(messageId, { onError: failed })}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        ),
      }}
    />
  );
}

/** What the proposed agent gets, a line each; a line the viewer can't give says who does, one it got takes a check. */
function Lines({ lines, draft }: { lines: ProposalLine[]; draft: AgentDraft }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const dir = useDirectory();
  const { colors } = useTheme();
  const channels = useChannels(orgId);
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const catalog = useCatalog();
  const apps = connectedItems(connections.data ?? [], servers.data ?? [], catalog.data?.connectors ?? []);
  const says = (level: "read" | "write" | undefined, name: string) =>
    t(level === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", { name });
  const shown = (l: ProposalLine): { icon: ReactNode; text: string } => {
    if (l.kind === "channel") {
      const name = channels.data?.find((c) => c.id === l.id)?.name;
      return {
        icon: <Icon name="hash" size={13} color={colors.muted} />,
        text: name ?? t("actionCard.agentProposal.aChannel"),
      };
    }
    if (l.kind === "app") {
      const item = apps.find((a) => a.id === l.id);
      const name = item ? itemName(t, item) : t("actionCard.agentProposal.anApp");
      return {
        icon: <ConnectorIcon def={item?.def ?? null} image={item?.image} label={name} size={16} />,
        text: says(l.level, name),
      };
    }
    if (l.kind === "mail") {
      const box = draft.mail?.find((b) => b.accountId === l.id);
      return { icon: <Icon name="mail" size={13} color={colors.muted} />, text: says(l.level, box?.address ?? "") };
    }
    const routine = draft.routine;
    return {
      icon: <Icon name="clock" size={13} color={colors.muted} />,
      text: routine ? [routine.name, proposedRoutineWhen(t, i18n.language, routine)].join(" · ") : l.id,
    };
  };
  const needs = (l: ProposalLine) =>
    !l.needs
      ? null
      : l.needs.who === "admin"
        ? t("actionCard.agentProposal.needsAdmin")
        : t("actionCard.agentProposal.needsPerson", {
            name: dir.memberById.get(l.needs.userId)?.name ?? t("actionCard.agentProposal.itsOwner"),
          });
  return (
    <View style={styles.lines} accessibilityLabel={t("actionCard.agentProposal.lines", { name: draft.name })}>
      {lines.map((l) => {
        const { icon, text } = shown(l);
        const who = [
          l.kind === "routine" && l.given === false ? t("actionCard.agentProposal.routineNotMade") : null,
          needs(l),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <View key={l.key} style={styles.line}>
            <View style={styles.mark}>{l.given ? <Icon name="check" size={13} color={colors.success} /> : icon}</View>
            <View style={styles.fill}>
              <Text variant="footnote" tone="ink2">
                {text}
                {/* Someone else gives it: it doesn't wait on the viewer, so no amber. */}
                {who ? <Text style={{ color: colors.muted }}>{` · ${who}`}</Text> : null}
              </Text>
              {l.kind === "routine" && draft.routine ? (
                <Text variant="footnote" tone="muted" numberOfLines={2}>
                  {draft.routine.prompt}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 12, gap: 8, alignItems: "stretch" },
  // The 40-point face beside a name and a line that may wrap: at the top, level with the name.
  row: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  lines: { gap: 4 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  mark: { width: 16, height: 18, alignItems: "center", justifyContent: "center" },
  acts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  // Its words wrap: the icon stays on the first line.
  sent: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
});
