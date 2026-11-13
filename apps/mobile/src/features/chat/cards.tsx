import {
  type AgentQuestion,
  type Approval,
  type ThreadInfo,
  useApi,
  useApproval,
  useApprovals,
  useCardApprovals,
  useDecideApproval,
  useDecideApprovals,
} from "@agenteschat/client";
import { questionWaitsOn } from "@agenteschat/client/lib/agent-questions";
import {
  approvalCardItems,
  approvalRuns,
  approveAllScope,
  approveAlwaysAlso,
  approveAlwaysOn,
  asOfNow,
  cardDeadline,
  itemOwnWords,
  runKeys,
} from "@agenteschat/client/lib/approval-card";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import { approvalWhy } from "@agenteschat/client/lib/approval-origin";
import {
  alwaysRoutineName,
  approvalAskLine,
  approvalDetail,
  approvalGroupWaitsFor,
  approvalSummary,
  approvalWaitsFor,
  decisionOutcome,
  requesterDecidesLine,
} from "@agenteschat/client/lib/approval-words";
import { nextLabel } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import {
  ACT_LINE,
  Button,
  Count,
  EventPillAction,
  HoldButton,
  Icon,
  LineIcon,
  Text,
  useReducedMotion,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { approvalAction, approvalRisk, approveAlwaysToast } from "../approvals/logic";
import {
  ApprovalAheadLine,
  ApprovalDetails,
  ApprovalEmailLetter,
  ApprovalMark,
  ApprovalPreview,
  ApprovalTraits,
  ApproveAlwaysButton,
  ApproveAlwaysInfo,
  approvalHeadline,
  approvalTitleText,
  hasApprovalPreview,
  useApprovalSource,
  useApproveNow,
  useCancelAhead,
  useOriginShort,
  useRefuseApproval,
} from "../approvals/parts";
import { chatHref } from "../links/logic";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId, useWhen } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic, tapHaptic, useSurface } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { AskCard, AskDone, AskFoot, ExpiryLine, useAskStore } from "./asks";
import { markName, parseInline, threadFaces } from "./logic";
import { Spans } from "./MessageSpans";

/**
 * The cards inside a message: the approval it asks for, an agent's question and a change
 * it proposes (each the request card, `asks.tsx`), and the link to its thread. Its tools are `ToolCalls.tsx`.
 */

// ── Approval ─────────────────────────────────────────────────────────────────

/**
 * An approval in the conversation: while it waits, the request card (`ApprovalAsk`); after, one line with
 * what happened. Requests the agent asked later in this conversation join its card (`messageId`): then one card
 * lists them all (`ApprovalGroupAsk`).
 */
export function ApprovalInline({ approvalId, messageId }: { approvalId: string; messageId: string }) {
  const orgId = useOrgId();
  const approval = useApproval(orgId, approvalId);
  const approvals = useApprovals(orgId);
  // Older than the list reaches: its card's requests by the card (the list holds everything newer than the first).
  const card = useCardApprovals(
    orgId,
    messageId,
    approvals.isSuccess && !approvals.data.some((x) => x.id === approvalId),
  );
  const a = approval.data;
  if (!a) return null;
  const items = approvalCardItems([...(approvals.data ?? []), ...(card.data ?? [])], messageId, a).map((x) =>
    asOfNow(x),
  );
  if (items.length > 1) {
    if (items.some((x) => x.status === "pending")) return <ApprovalGroupAsk items={items} />;
    return (
      <>
        {items.map((x) => (
          <ApprovalDone key={x.id} approval={x} />
        ))}
      </>
    );
  }
  if (a.status === "pending") return <ApprovalAsk approval={a} />;
  return <ApprovalDone approval={a} />;
}

/** Approvals whose burst already played: a pill scrolling back into view, or remounted, stays quiet. */
const celebrated = new Set<string>();
/** How fresh a decision still bursts: the card turning into the pill, not an old one loading. */
const CELEBRATE_MS = 10_000;

/** The agent's color when I approved this one just now and it hasn't burst yet; null otherwise. */
function celebrationFor(a: Approval, meId: string | null, color: string): string | null {
  if (a.status !== "approved" || !meId || a.decidedByUserId !== meId || !a.decidedAt) return null;
  if (celebrated.has(a.id) || Date.now() - new Date(a.decidedAt).getTime() > CELEBRATE_MS) return null;
  celebrated.add(a.id);
  return color;
}

/**
 * One decided request, as the conversation's event pill: how it ended and what it did ("Approved by you: Generate
 * image"), when it was decided; its values (so several of one tool are told apart), when it goes out if approved
 * ahead, and the reason open under it ("See details"). Approved ahead and still to run, "Cancel" withdraws it.
 */
function ApprovalDone({ approval: a }: { approval: Approval }) {
  const { t, i18n } = useTranslation();
  const meId = useMeId();
  const dir = useDirectory();
  const when = useWhen();
  const outcome = decisionOutcome(t, a, meId, (id) => dir.memberById.get(id)?.name);
  // Approved by me a moment ago (the card turning into this pill): the check bursts once in the agent's tones.
  const [celebrate] = useState(() => celebrationFor(a, meId, agentLook(dir.anyAgent(a.agentId)).color));
  // Approved ahead and still to run: when it goes out, said under its pill, and a way to withdraw it.
  const scheduled = aheadPhase(a) === "scheduled" && a.runAt;
  const cancelAhead = useCancelAhead();
  const lines = [
    approvalSummary(a, i18n.language),
    scheduled ? t("approval.ahead.scheduled", { when: nextLabel(i18n.language, scheduled) }) : null,
    a.reason ? t("approval.reasonLine", { reason: a.reason }) : null,
  ].filter((x): x is string => Boolean(x));
  return (
    <AskDone
      done={a.status === "approved"}
      words={`${outcome}: ${markName(approvalHeadline(t, a, i18n.language))}`}
      celebrate={celebrate}
      time={a.decidedAt ? when.short(a.decidedAt) : undefined}
      actions={
        scheduled && a.canCancel ? (
          <EventPillAction
            label={t("approval.ahead.cancel")}
            loading={cancelAhead.pending}
            onPress={() => cancelAhead.cancel(a.id)}
          />
        ) : null
      }
      more={
        lines.length > 0
          ? {
              label: t("approval.seeDetails"),
              content: (
                <Text variant="small" tone="muted">
                  {lines.join("\n")}
                </Text>
              ),
            }
          : undefined
      }
    />
  );
}

/**
 * Several requests of one agent in one conversation on one card. Waiting requests of one kind in a row fold into one
 * run (`approvalRuns`: "3 pedidos de Ada para Executar sql") with Aprovar todos, "Aprovar sempre" where its kind
 * offers it and "Agora não para todos", unfolding into each; a card that is one run is that run, its buttons in the
 * strip. Otherwise each item has its values and its own buttons in a row under them while it waits, how it ended once
 * decided, then "Aprovar tudo" / "Agora não para todos" over the ones listed now (held when any is high risk) and the
 * earliest deadline. Someone who may decide only some reads that "Aprovar tudo" covers only those.
 */
function ApprovalGroupAsk({ items }: { items: Approval[] }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const asks = useAskStore();
  const one = useDecideApproval(orgId);
  const all = useDecideApprovals(orgId);
  // Which runs are unfolded, by `runKeys`: one stays open while its requests are decided, the card reshaping or not.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const first = items[0];
  if (!first) return null;
  const name = dir.agentById.get(first.agentId)?.name ?? "";
  const g = genderOf(name);
  const waiting = items.filter((a) => a.status === "pending");
  const { ids, waiting: count, blocked } = approveAllScope(items);
  const ownerId = first.ownerUserId ?? dir.agentById.get(first.agentId)?.ownerUserId ?? null;
  const owner = approvalGroupWaitsFor(items, ownerId ? dir.memberById.get(ownerId)?.name : undefined);
  const deadline = cardDeadline(items);
  const leadItem = waiting[0] ?? first;
  const always = approveAlwaysOn(items);
  const runs = approvalRuns(items);
  const keys = runKeys(runs);
  const [only] = runs;
  const single = runs.length === 1 && only && only.length > 1 ? only : null;
  const busy = one.isPending || all.isPending;
  const failed = () => toast({ title: t("mobile.app.failed"), icon: "x" });
  const settle = (list: string[]) => {
    for (const id of list) asks?.settle(id);
  };
  const decideMany = (list: string[], decision: "approve" | "refuse") =>
    all.mutate(
      { ids: list, decision },
      {
        onSuccess: () => {
          settle(list);
          if (decision === "approve") {
            successHaptic();
            toast({
              title: t("mobile.approval.approved"),
              subtitle: t(`mobile.approval.approvedSub${g}`, { name }),
              agentId: first.agentId,
            });
          }
        },
        onError: failed,
      },
    );
  const approveOne = (a: Approval) =>
    one.mutate({ id: a.id, decision: "approve" }, { onSuccess: () => asks?.settle(a.id), onError: failed });
  // "Aprovar sempre" approves the like ones waiting beside it too (`approveAlwaysAlso`).
  const approveAlways = (a: Approval) =>
    one.mutate(
      { id: a.id, decision: "approve", always: true },
      {
        onSuccess: () => {
          asks?.settle(a.id);
          const also = approveAlwaysAlso(items, a);
          if (also.length) all.mutate({ ids: also, decision: "approve" }, { onSuccess: () => settle(also) });
          toast({ ...approveAlwaysToast(t, name, alwaysRoutineName(t, a)), agentId: a.agentId });
        },
        onError: failed,
      },
    );
  const toggle = (id = "") => {
    setOpened((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const head = (run: Approval[]) =>
    t("approval.run.head", { count: run.length, name, what: run[0] ? approvalTitleText(t, run[0]) : "" });
  const item = (a: Approval, inRun: boolean, divider: boolean) => (
    <ApprovalGroupItem
      key={a.id}
      divider={divider}
      approval={a}
      lead={leadItem}
      name={name}
      always={!inRun && always.has(a.id)}
      busy={busy}
      onApprove={() => approveOne(a)}
      onAlways={() => approveAlways(a)}
    />
  );
  // A run's "Aprovar sempre": its first request that offers it, which I may decide.
  const alwaysLead = (list: Approval[]) => list.find((a) => always.has(a.id) && a.canDecide);
  // A run's or the card's decision, in one row of buttons; on a run, "Aprovar sempre" with its ⓘ (what it covers, under
  // the row while open).
  const decideParts = (
    list: Approval[],
    label: string,
    run: boolean,
    info?: { button: ReactNode; text: ReactNode },
  ) => {
    const scope = approveAllScope(list).ids;
    if (scope.length < 2) return null;
    const high = list.some((a) => scope.includes(a.id) && approvalRisk(a) === "high");
    const lead = run ? alwaysLead(list) : undefined;
    return {
      acts: (
        <View style={styles.itemActs}>
          {high ? (
            <HoldButton size="card" label={label} onConfirm={() => decideMany(scope, "approve")} />
          ) : (
            <Button
              variant="primary"
              size="card"
              icon="check"
              label={label}
              disabled={busy}
              onPress={() => decideMany(scope, "approve")}
            />
          )}
          {lead ? <ApproveAlwaysButton approval={lead} disabled={busy} onPress={() => approveAlways(lead)} /> : null}
          {lead ? info?.button : null}
          <Button
            variant="secondary"
            size="card"
            label={t("approval.all.refuse")}
            disabled={busy}
            onPress={() => decideMany(scope, "refuse")}
          />
        </View>
      ),
      hint: lead ? info?.text : null,
    };
  };
  const decide = (list: Approval[], label: string, run: boolean) => (
    <ApproveAlwaysInfo approval={run ? alwaysLead(list) : undefined} name={name}>
      {(info) => {
        const parts = decideParts(list, label, run, info);
        return parts ? (
          <>
            {parts.acts}
            {parts.hint}
          </>
        ) : null;
      }}
    </ApproveAlwaysInfo>
  );
  const partial =
    blocked > 0 && ids.length > 0 ? (
      <Text variant="footnote" tone="muted">
        {t("approval.all.partial", { mine: ids.length, count, who: owner ?? t("approval.all.partialAdmin") })}
      </Text>
    ) : null;
  return (
    <AskCard
      id={first.id}
      kind="approval"
      agentId={first.agentId}
      waitsFor={ids.length > 0 ? "you" : owner ? t("ask.waitingFor", { name: owner }) : null}
      lead={approvalWhy(leadItem) ?? approvalAskLine(t, ids.length > 0, waiting.length)}
      well={
        single
          ? {
              tile: <ApprovalMark approval={first} size={20} bare />,
              title: head(single),
              more: {
                label: t("approval.run.show"),
                content: <View style={styles.nested}>{single.map((a) => item(a, true, true))}</View>,
                open: opened.has(keys[0] ?? ""),
                onToggle: () => toggle(keys[0]),
              },
            }
          : undefined
      }
      body={
        single ? (
          partial
        ) : (
          <View style={styles.items}>
            {runs.map((run, i) => {
              const [lead] = run;
              if (!lead) return null;
              if (run.length < 2) return item(lead, false, true);
              const key = keys[i] ?? lead.id;
              const open = opened.has(key);
              return (
                <ApproveAlwaysInfo key={key} approval={alwaysLead(run)} name={name}>
                  {(info) => {
                    const parts = decideParts(run, t("approval.run.approve"), true, info);
                    return (
                      <View style={[styles.item, styles.divided, { borderTopColor: c.line2 }]}>
                        <View style={styles.itemRow}>
                          <View style={styles.itemMark}>
                            <ApprovalMark approval={lead} size={20} bare />
                          </View>
                          <View style={[ACT_LINE.row, styles.itemWrap]}>
                            <View style={ACT_LINE.text}>
                              <Text variant="subhead" tone="ink" style={styles.bold}>
                                {head(run)}
                              </Text>
                              <Pressable
                                onPress={() => {
                                  tapHaptic();
                                  toggle(key);
                                }}
                                accessibilityRole="button"
                                accessibilityState={{ expanded: open }}
                                // An 18-point line: the slop gives "Show" the 44 a finger needs.
                                hitSlop={{ top: 13, bottom: 13, left: 6, right: 6 }}
                                style={({ pressed }) => [styles.runMore, pressed && styles.pressed]}
                              >
                                <Text variant="footnote" tone="ink2" style={styles.bold}>
                                  {t("approval.run.show")}
                                </Text>
                                <View style={open ? styles.flip : undefined}>
                                  <Icon name="chev" size={13} color={c.muted} />
                                </View>
                              </Pressable>
                            </View>
                            {parts?.acts}
                          </View>
                        </View>
                        {parts?.hint ? <View style={styles.itemUnder}>{parts.hint}</View> : null}
                        {open ? <View style={styles.nested}>{run.map((a) => item(a, true, true))}</View> : null}
                      </View>
                    );
                  }}
                </ApproveAlwaysInfo>
              );
            })}
            {partial}
          </View>
        )
      }
      expiry={deadline ? <ExpiryLine createdAt={first.createdAt} expiresAt={deadline} /> : undefined}
      foot={
        <AskFoot>
          {single ? decide(single, t("approval.run.approve"), true) : decide(items, t("approval.all.approve"), false)}
        </AskFoot>
      }
    />
  );
}

/**
 * One request on a shared card: its values (and its own why and origin where they differ from the card's lead) across
 * the item, then its own buttons in a row under them while it waits ("Aprovar sempre" on the first of its kind), or
 * how it ended once decided.
 */
function ApprovalGroupItem({
  divider,
  approval: a,
  lead,
  name,
  always,
  busy,
  onApprove,
  onAlways,
}: {
  /** A hairline above it: every item but the card's first. */
  divider: boolean;
  approval: Approval;
  lead: Approval;
  name: string;
  always: boolean;
  busy: boolean;
  onApprove: () => void;
  onAlways: () => void;
}) {
  const { t, i18n } = useTranslation();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const cancelAhead = useCancelAhead();
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const pending = a.status === "pending";
  const source = useApprovalSource(a);
  const detail = a.email
    ? [a.email.to.join(", "), a.email.subject].filter(Boolean).join(" · ")
    : !a.connector
      ? approvalDetail(a, i18n.language)
      : [source.name, approvalSummary(a, i18n.language)].filter(Boolean).join(" · ");
  const own = itemOwnWords(a, lead);
  const scheduled = aheadPhase(a) === "scheduled" && a.runAt;
  // "Recusar" asks once, in the system's alert, as the card of one request does.
  const { refuse, pending: refusing } = useRefuseApproval(a);
  return (
    <ApproveAlwaysInfo approval={pending && a.canDecide && always ? a : undefined} name={name}>
      {(info) => (
        <View
          style={[styles.item, divider && [styles.divided, { borderTopColor: c.line2 }], !pending && styles.itemDone]}
        >
          <View style={styles.itemRow}>
            <View style={styles.itemMark}>
              <ApprovalMark approval={a} size={20} bare />
            </View>
            {/* Its words, then its buttons at the row's end while the words fit their line beside them; else the buttons
            go under the words, from where they start. The words read whole, code drawn as code. */}
            <View style={[ACT_LINE.row, styles.itemWrap]}>
              <View style={ACT_LINE.text}>
                <Text variant="subhead" tone="ink" style={styles.bold}>
                  {approvalTitleText(t, a)}
                </Text>
                {detail ? (
                  <Text variant="footnote" tone="muted">
                    <Spans inline={parseInline(detail)} />
                  </Text>
                ) : null}
                {own.why ? (
                  <Text variant="footnote" tone="ink">
                    <Spans inline={parseInline(own.why)} />
                  </Text>
                ) : null}
                {own.origin ? (
                  <Text variant="footnote" tone="muted">
                    {tt(own.origin.key, own.origin.values)}
                  </Text>
                ) : null}
                <ApprovalAheadLine approval={a} />
              </View>
              {pending && a.canDecide ? (
                <View style={styles.itemActs}>
                  {approvalRisk(a) === "high" ? (
                    <HoldButton size="card" label={t("mobile.approval.hold")} onConfirm={onApprove} />
                  ) : (
                    <Button
                      variant="primary"
                      size="card"
                      label={t("mobile.approval.approve")}
                      disabled={busy || refusing}
                      onPress={onApprove}
                    />
                  )}
                  {always ? <ApproveAlwaysButton approval={a} disabled={busy || refusing} onPress={onAlways} /> : null}
                  {info.button}
                  <Button
                    variant="secondary"
                    size="card"
                    label={t("mobile.approval.refuse")}
                    disabled={busy || refusing}
                    onPress={refuse}
                  />
                </View>
              ) : null}
            </View>
          </View>
          {pending ? (
            info.text ? (
              <View style={styles.itemUnder}>{info.text}</View>
            ) : null
          ) : (
            // Decided while the card shows: how it ended fades in under its words.
            <Animated.View
              entering={reduced ? undefined : FadeIn.duration(160)}
              style={[styles.item, styles.itemUnder]}
            >
              <Text variant="footnote" tone="muted">
                {[
                  decisionOutcome(t, a, meId, (id) => dir.memberById.get(id)?.name),
                  scheduled && t("approval.ahead.scheduled", { when: nextLabel(i18n.language, scheduled) }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {scheduled && a.canCancel ? (
                <View style={styles.cancelAhead}>
                  <Button
                    variant="ghost"
                    size="sm"
                    label={t("approval.ahead.cancel")}
                    loading={cancelAhead.pending}
                    onPress={() => cancelAhead.cancel(a.id)}
                  />
                </View>
              ) : null}
            </Animated.View>
          )}
        </View>
      )}
    </ApproveAlwaysInfo>
  );
}

/**
 * An approval waiting in the conversation, as the request card: what the agent said in its own words, the
 * exact action in the well with the app's mark ("Ver o e-mail" / "Ver detalhes" opens it whole, with where it
 * came from and "Aprovar sempre" where it is offered), then the strip with the fuse to its expiry and Aprovar
 * (held for a second when the risk is high) beside "Agora não" (the request's sheet, which asks why: a lesson
 * for the agent). Who can't decide sees who it waits for.
 */
function ApprovalAsk({ approval: a }: { approval: Approval }) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const asks = useAskStore();
  const origin = useOriginShort(a);
  const { org } = useOrg();
  const ownerId = a.ownerUserId ?? dir.agentById.get(a.agentId)?.ownerUserId ?? null;
  const owner = approvalWaitsFor(a, ownerId ? dir.memberById.get(ownerId)?.name : undefined);
  const requester = requesterDecidesLine(t, a);
  // The same approving as Atividade's card: the haptic, the toast saying what follows; refusing asks once, in the
  // system's alert, with the reason optional.
  const { approve, pending, high } = useApproveNow(a, () => asks?.settle(a.id));
  const { refuse, pending: refusing } = useRefuseApproval(a, () => asks?.settle(a.id));
  // A connector's detail is its raw call (`tool · key=value`), so its values in words instead, the call under "Ver
  // detalhes". An email's preview says to whom and about what: its line says only where it goes from.
  const source = useApprovalSource(a);
  const previewed = hasApprovalPreview(a);
  const detail = previewed
    ? source.name
    : !a.connector
      ? approvalDetail(a, i18n.language)
      : [source.name, approvalSummary(a, i18n.language)].filter(Boolean).join(" · ");
  return (
    <AskCard
      id={a.id}
      kind="approval"
      // A request that leaves the workspace (an e-mail, a post, a payment) says so before anything else; a personal
      // workspace's is no company's (ADR 0159).
      kindNote={high ? t(modeKey(org, "mobile.approval.leaves")) : undefined}
      agentId={a.agentId}
      waitsFor={a.canDecide ? "you" : owner ? t("ask.waitingFor", { name: owner }) : null}
      lead={approvalWhy(a) ?? approvalAskLine(t, a.canDecide)}
      preview={previewed ? <ApprovalPreview approval={a} /> : undefined}
      well={{
        tile: <ApprovalMark approval={a} size={20} bare />,
        title: approvalHeadline(t, a, i18n.language),
        detail,
        more: {
          label: a.email ? t("approval.seeEmail") : t("approval.seeDetails"),
          content: (
            <>
              {a.email ? (
                <ApprovalEmailLetter email={a.email} full flat />
              ) : (
                <>
                  <ApprovalDetails approval={a} stacked />
                  <ApprovalTraits approval={a} />
                </>
              )}
              {origin ? (
                <View style={styles.origin}>
                  <LineIcon variant="footnote" name="clock" size={13} color={c.muted} />
                  <Text variant="footnote" tone="muted" style={styles.grow}>
                    {origin}
                  </Text>
                </View>
              ) : null}
              {requester ? (
                <Text variant="footnote" tone="muted">
                  {requester}
                </Text>
              ) : null}
            </>
          ),
        },
      }}
      body={aheadPhase(a) === "asking" && a.runAt ? <ApprovalAheadLine approval={a} /> : undefined}
      expiry={<ExpiryLine createdAt={a.createdAt} expiresAt={a.expiresAt} />}
      foot={
        <AskFoot>
          {a.canDecide ? (
            // Aprovar and Recusar, the same two words as everywhere the request shows; "Aprovar sempre" is a switch
            // in the request's sheet, not a third button here.
            <View style={styles.itemActs}>
              {high ? (
                <HoldButton size="card" label={t("mobile.approval.hold")} onConfirm={() => approve()} />
              ) : (
                <Button
                  variant="primary"
                  size="card"
                  label={approvalAction(a) === "draft" ? t("approval.approve.draft") : t("mobile.approval.approve")}
                  disabled={pending || refusing}
                  onPress={() => approve()}
                />
              )}
              <Button
                variant="secondary"
                size="card"
                label={t("mobile.approval.refuse")}
                disabled={pending || refusing}
                onPress={refuse}
              />
            </View>
          ) : owner ? null : (
            <Text variant="small" tone="muted">
              {t("approval.waitingAdmin")}
            </Text>
          )}
        </AskFoot>
      }
    />
  );
}

// ── Question (ask_user) ──────────────────────────────────────────────────────

/**
 * An agent's question (`ask_user`, `meta.question`) as the request card: the question, then the choices as
 * full-width rows and "Outra resposta" for a free answer beside them; with no choices, just Responder. Once
 * answered, one line with the answer. Anyone in the conversation may answer, unless it is for one person: then
 * everyone else reads who it waits for, and nothing to press.
 */
export function QuestionCard({ question }: { question: AgentQuestion }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const meId = useMeId();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const asks = useAskStore();
  const [answered, setAnswered] = useState<AgentQuestion | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const q = answered ?? question;
  const choices = q.choices ?? [];
  // Refused because it ended (someone answered, its run stopped): the card closes here, even if no event came.
  const [ended, setEnded] = useState(false);
  const refused = (err: unknown, failed: string) => {
    if ((err as { status?: number }).status !== 409) return toast({ title: failed, icon: "x" });
    asks?.settle(q.id);
    setEnded(true);
    setAnswered({ ...q, status: "answered", answer: null, answeredByUserId: null });
  };

  const answer = (input: { choice: string } | { text: string }) => {
    setPicking("choice" in input ? input.choice : null);
    return api.questions
      .answer(orgId, q.id, input)
      .then((res) => {
        tapHaptic();
        asks?.settle(q.id);
        setAnswered({ ...res, answer: res.answer ?? ("choice" in input ? input.choice : input.text) });
      })
      .catch((err: unknown) => refused(err, t("mobile.app.failed")))
      .finally(() => setPicking(null));
  };
  const [skipping, setSkipping] = useState(false);
  const skip = () => {
    setSkipping(true);
    api.questions
      .dismiss(orgId, q.id)
      .then((res) => {
        asks?.settle(q.id);
        setAnswered(res);
      })
      .catch((err: unknown) => refused(err, t("question.skipFailed")))
      .finally(() => setSkipping(false));
  };
  const busy = picking !== null || skipping;

  if (q.status === "answered") {
    const who = q.answeredByUserId && q.answeredByUserId !== meId ? dir.memberById.get(q.answeredByUserId)?.name : null;
    const said = markName(q.answer ?? "");
    return (
      <AskDone
        done
        words={
          q.withdrawn
            ? t("question.withdrawn", agentGrammar(dir.anyAgent(q.agentId)?.name ?? t("channel.unknownAgent")))
            : q.dismissed
              ? who
                ? t("question.dismissed", { name: who })
                : t("question.dismissedByYou")
              : q.answer === null
                ? t(ended ? "mobile.chat.question.taken" : "mobile.chat.question.closed")
                : who
                  ? t("mobile.chat.question.answered", { name: who, answer: said })
                  : t("mobile.chat.question.answeredByYou", { answer: said })
        }
      />
    );
  }
  // A free answer in a sheet: "Outra resposta" beside the choices, or the question's only button.
  const write = () =>
    sheet.open(
      <PromptForm
        title={q.text}
        placeholder={t("mobile.chat.question.placeholder")}
        submitLabel={t("mobile.app.send")}
        onSubmit={(text) => answer({ text }).then(() => sheet.close())}
      />,
    );
  if (!questionWaitsOn(q, meId)) {
    const person = dir.memberById.get(q.requestedForUserId ?? "")?.name ?? t("channel.unknownPerson");
    return (
      <AskCard
        id={q.id}
        kind="question"
        agentId={q.agentId}
        waitsFor={t("ask.waitingFor", { name: person })}
        lead={q.text}
      />
    );
  }
  return (
    <AskCard
      id={q.id}
      kind="question"
      agentId={q.agentId}
      waitsFor="you"
      lead={q.text}
      foot={
        <AskFoot>
          {choices.length > 0 ? (
            <View style={styles.opts}>
              {choices.map((choice) => {
                const on = picking === choice;
                return (
                  <Pressable
                    key={choice}
                    disabled={busy}
                    onPress={() => void answer({ choice })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on, disabled: busy }}
                    style={({ pressed }) => [
                      styles.opt,
                      { backgroundColor: on ? c.ink : c.sunken },
                      pressed && styles.optPressed,
                    ]}
                  >
                    <Text variant="callout" style={[styles.optText, { color: on ? c.bg : c.ink }]}>
                      {choice}
                    </Text>
                  </Pressable>
                );
              })}
              <Pressable
                disabled={busy}
                onPress={write}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.opt,
                  styles.other,
                  { borderColor: c.line2 },
                  pressed && styles.optPressed,
                ]}
              >
                <Text variant="callout" tone="muted">
                  {t("ask.otherAnswer")}
                </Text>
              </Pressable>
            </View>
          ) : (
            <Button
              variant="primary"
              size="card"
              wide
              label={t("question.answer")}
              disabled={skipping}
              onPress={write}
            />
          )}
          <Button
            variant="ghost"
            size="card"
            wide
            label={t("question.skip")}
            loading={skipping}
            disabled={picking !== null}
            onPress={skip}
          />
        </AskFoot>
      }
    />
  );
}

// ── Thread link ──────────────────────────────────────────────────────────────

/** "3 respostas" with who wrote; opens the thread. */
export function ThreadLink({ thread }: { thread: ThreadInfo }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const when = useWhen();
  const faces = threadFaces(thread.participants, 2);
  return (
    <Pressable
      onPress={() => router.push(chatHref(thread.channelId, thread.id))}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.chat.replies", { count: thread.replyCount })}
      // A 36-point link under the message: the slop gives it the 44 a finger needs.
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => [styles.tlink, surface, pressed && styles.pressed]}
    >
      <View style={styles.faces}>
        {faces.map((f, i) => (
          <View key={`${f.type}:${f.id}`} style={i > 0 ? styles.overlap : undefined}>
            <Face who={f} size={20} live={false} />
          </View>
        ))}
      </View>
      {thread.replyCount > 0 ? (
        <>
          <Count value={thread.replyCount} size={15} />
          <Text variant="small" tone="ink2" style={styles.bold}>
            {t("mobile.chat.repliesWord", { count: thread.replyCount })}
          </Text>
        </>
      ) : (
        <Text variant="small" tone="ink2" style={styles.bold}>
          {t("mobile.chat.thread")}
        </Text>
      )}
      <Text variant="small" tone="faint" numberOfLines={1} style={styles.shrink}>
        {thread.state === "closed" ? ` · ${t("mobile.chat.closed")}` : ` · ${when.short(thread.lastActivityAt)}`}
      </Text>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  bold: { fontWeight: "600" },
  flip: { transform: [{ rotate: "180deg" }] },
  pressed: { opacity: 0.85 },
  origin: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  // Requests sharing one card: rows edge to edge across the card, each with a hairline above (never a plate in a
  // card), decided ones quieter.
  items: { marginTop: 2, marginHorizontal: -16 },
  // A run's requests, unfolded under it or in the name line's place: the same rows.
  nested: { marginHorizontal: -16 },
  item: { gap: 8 },
  divided: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
  itemDone: { opacity: 0.7 },
  // The mark beside the title's first line.
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  itemMark: { width: 20, paddingTop: 1, alignItems: "center" },
  // Its words and its buttons on one line while the words fit theirs; else the buttons under the words, at their start.
  itemWrap: { flex: 1, minWidth: 0, alignItems: "center", columnGap: 16, rowGap: 8 },
  // Under the words, from where they start (the mark's 20 and the gap's 10).
  itemUnder: { marginLeft: 30 },
  // A request's decision: one row under its values, left-aligned, every button the strip's height.
  itemActs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  runMore: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", marginTop: 4 },
  // A question's answers: full-width rows in the card's strip.
  opts: { gap: 8 },
  // Under its done line, at the left edge where the line's words start.
  cancelAhead: { alignSelf: "flex-start", marginTop: -4 },
  opt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
  },
  optText: { flexShrink: 1 },
  optPressed: { transform: [{ scale: 0.98 }] },
  other: { backgroundColor: "transparent", borderWidth: 1 },
  tlink: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingLeft: 8,
    paddingRight: 12,
    borderRadius: 10,
  },
  faces: { flexDirection: "row", marginRight: 2 },
  overlap: { marginLeft: -6 },
});
