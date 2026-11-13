import type { ApprovalCoverInput, RightHandApprovals, RightHandApprovalsInput } from "@agenteschat/client";
import {
  useApprovalCovers,
  useDeclineApprovalCover,
  useMe,
  useRightHandApprovals,
  useSetApprovalCover,
  useSetRightHandApprovals,
} from "@agenteschat/client";
import { coveringLine } from "@agenteschat/client/lib/approval-words";
import { endOfDay, toYmd } from "@agenteschat/client/lib/format";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  AffixInput,
  Avatar,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Checkbox,
  DatePicker,
  InfoHint,
  Select,
  Switch,
  Textarea,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingLine } from "@/components/Loading";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { useToast } from "@/lib/toast";

/** "Ninguém" in the person list (Radix lists take no empty value). */
const NOBODY = "none";

/**
 * Configurações › Você › Aprovações (ADR 0139): "Quem aprova por mim" (one person, always or only while my status
 * says out, until a day, risky actions off unless turned on), each change saved at once; then the people I approve
 * for, each with "Não quero cobrir". Alone in a personal workspace there is nobody to approve for you: the card waits
 * until someone joins or while a cover is set (ADR 0159). What the right hand does for the person is on its own page,
 * a row away.
 */
export function ApprovalsSection() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const meId = useMe().data?.user.id ?? "";
  const dir = useDirectory(org.id);
  const covers = useApprovalCovers(org.id);
  const set = useSetApprovalCover(org.id, meId);
  const { solo } = usePersonalView();
  const navigate = useNavigate();
  const rightHand = dir.agents.find(isRightHand);
  const decline = useDeclineApprovalCover(org.id);
  const failed = () => toast.show(t("approvalCover.failed"), "error");
  if (!covers.data) return covers.isError ? <p className="muted">{t("approvalCover.failed")}</p> : <LoadingLine />;
  const cover = covers.data.cover;
  const save = (patch: Partial<ApprovalCoverInput>) => {
    const next = {
      mode: cover?.mode ?? "while_out",
      risky: cover?.risky ?? false,
      endsAt: cover?.endsAt ?? null,
      userId: cover?.userId ?? "",
      ...patch,
    };
    set.mutate(next.userId ? next : null, { onError: failed });
  };
  const face = (userId: string) => {
    const m = dir.memberById.get(userId);
    return <Avatar kind="person" size="sm" name={m?.name ?? ""} imageUrl={m?.image} />;
  };
  const people = dir.members
    .filter((m) => m.userId !== meId)
    .map((m) => ({ value: m.userId, label: m.name, leading: face(m.userId) }));
  // A cover goes with its person's membership: one still read after they left shows Ninguém, never an empty box.
  const coverPerson = cover && people.some((p) => p.value === cover.userId) ? cover.userId : NOBODY;

  return (
    <>
      {(!solo || cover) && (
        <Card aria-labelledby="cover-title">
          <CardHeader
            id="cover-title"
            icon="audiencePeople"
            title={t("approvalCover.title")}
            subtitle={t("approvalCover.subtitle")}
          />
          <div className="settings-rows">
            <PrefRow
              id="cover-person"
              icon="person"
              label={t("approvalCover.person")}
              control={
                <Select
                  value={coverPerson}
                  onValueChange={(userId) => save({ userId: userId === NOBODY ? "" : userId })}
                  aria-label={t("approvalCover.person")}
                  align="end"
                  options={[{ value: NOBODY, label: t("approvalCover.nobody") }, ...people]}
                />
              }
            />
            {cover && (
              <>
                <PrefRow
                  id="cover-when"
                  icon="clock"
                  label={t("approvalCover.when")}
                  hint={t("approvalCover.whenHelp")}
                  control={
                    <Select
                      value={cover.mode}
                      onValueChange={(mode) => save({ mode })}
                      aria-label={t("approvalCover.when")}
                      align="end"
                      options={[
                        { value: "while_out", label: t("approvalCover.whileOut") },
                        { value: "always", label: t("approvalCover.always") },
                      ]}
                    />
                  }
                />
                <PrefRow
                  id="cover-until"
                  icon="calendar"
                  label={t("approvalCover.until")}
                  control={
                    <DatePicker
                      value={cover.endsAt ? toYmd(new Date(cover.endsAt)) : null}
                      onChange={(day) => save({ endsAt: endOfDay(day) })}
                      onClear={() => save({ endsAt: null })}
                      min={toYmd(new Date())}
                      placeholder={t("approvalCover.noDate")}
                      aria-label={t("approvalCover.until")}
                      locale={i18n.language}
                      labels={{
                        previousMonth: t("common.previousMonth"),
                        nextMonth: t("common.nextMonth"),
                        choose: t("common.chooseDate"),
                        clear: t("approvalCover.clearDate"),
                      }}
                    />
                  }
                />
                <PrefRow
                  id="cover-risky"
                  icon="alert"
                  label={t("approvalCover.risky")}
                  hint={t("approvalCover.riskyOn")}
                  control={
                    <Switch
                      checked={cover.risky}
                      onCheckedChange={(risky) => save({ risky })}
                      aria-label={t("approvalCover.risky")}
                    />
                  }
                />
              </>
            )}
          </div>
          <CardFooter icon="lock">{t("approvalCover.lock")}</CardFooter>
        </Card>
      )}

      {rightHand && (
        <Card>
          <div className="settings-rows">
            <PrefRow
              id="rh-approvals"
              lead={<AgentAvatar agentId={rightHand.id} name={rightHand.name} size="sm" />}
              label={t("rightHandApprovals.title", { name: rightHand.name })}
              onOpen={() =>
                void navigate({ to: "/org/$orgId/agents/$agentId", params: { orgId: org.id, agentId: rightHand.id } })
              }
            />
          </div>
        </Card>
      )}

      {covers.data.covering.length > 0 && (
        <Card aria-labelledby="covering-title">
          <CardHeader
            id="covering-title"
            icon="approve"
            title={t("approvalCover.coveringTitle")}
            subtitle={t("approvalCover.coveringSubtitle")}
          />
          <div className="settings-rows">
            {covers.data.covering.map((c) => (
              <PrefRow
                key={c.userId}
                id={`covering-${c.userId}`}
                lead={face(c.userId)}
                label={dir.memberById.get(c.userId)?.name ?? ""}
                status={coveringLine(t, i18n.language, c)}
                control={
                  <Button
                    size="sm"
                    loading={decline.isPending && decline.variables === c.userId}
                    onClick={() => decline.mutate(c.userId, { onError: failed })}
                  >
                    {t("approvalCover.decline")}
                  </Button>
                }
              />
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

const USD = 1_000_000_000;

/** A row whose box is the choice: the box, then the label with an ⓘ for what it does, or why it is off under it. */
function CheckRow({
  id,
  label,
  hint,
  status,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  status?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-row ac-actrow rh-check">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={`${id}-help`}
      />
      <span className="settings-row__text ac-actrow__text">
        <span className="ac-hintline">
          <label className="settings-row__label" htmlFor={id}>
            {label}
          </label>
          {hint && (
            <InfoHint id={`${id}-help`} name={t("common.about", { label })}>
              {hint}
            </InfoHint>
          )}
        </span>
        {status && (
          <span className="settings-row__status" id={`${id}-help`}>
            {status}
          </span>
        )}
      </span>
    </div>
  );
}

/** What the right hand creates and adjusts for the viewer without asking, on its own page; nothing while it loads. */
export function RightHandApprovalsCard() {
  const { org } = useOrg();
  const view = useRightHandApprovals(org.id).data;
  return view?.rightHand ? <RightHandCard view={view} name={view.rightHand.name} /> : null;
}

/**
 * What the right hand does for the person without asking (ADR 0139 §2), under the workspace's name for it: one switch, the two kinds
 * (greyed when the person can't decide that themselves), the budget it may add per agent and their own guidance. The
 * day and month caps are code, not fields. What never leaves the person closes the card.
 */
function RightHandCard({ view, name }: { view: RightHandApprovals; name: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const set = useSetRightHandApprovals(org.id);
  const [budget, setBudget] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string | null>(null);
  const save = (patch: RightHandApprovalsInput) =>
    set.mutate(patch, { onError: () => toast.show(t("approvalCover.failed"), "error") });
  const title = t("rightHandApprovals.title", { name });
  const saveBudget = () => {
    if (budget === null) return;
    const usd = Number(budget.replace(",", "."));
    setBudget(null);
    if (!Number.isFinite(usd)) return;
    const nano = Math.round(Math.min(50, Math.max(0, usd)) * USD);
    if (nano !== view.budgetCapNanoUsd) save({ budgetCapNanoUsd: nano });
  };
  const saveGuidance = () => {
    if (guidance === null) return;
    setGuidance(null);
    if (guidance.trim() !== view.guidance) save({ guidance: guidance.trim() });
  };
  return (
    <Card aria-labelledby="rh-title">
      <CardHeader
        id="rh-title"
        icon="agent"
        title={title}
        subtitle={view.pausedAt ? t("rightHandApprovals.paused") : t("rightHandApprovals.subtitle")}
        action={
          <Switch
            checked={view.enabled && !view.pausedAt}
            disabled={set.isPending}
            onCheckedChange={(enabled) => save({ enabled })}
            aria-label={title}
          />
        }
      />
      {view.enabled && !view.pausedAt && (
        <div className="settings-rows">
          <CheckRow
            id="rh-new"
            label={t("rightHandApprovals.newAgents")}
            hint={view.mayDecide.newAgents ? t("rightHandApprovals.newAgentsHelp") : undefined}
            status={view.mayDecide.newAgents ? undefined : t("rightHandApprovals.cantDecide")}
            checked={view.newAgents && view.mayDecide.newAgents}
            disabled={!view.mayDecide.newAgents}
            onChange={(newAgents) => save({ newAgents })}
          />
          <CheckRow
            id="rh-changes"
            label={t("rightHandApprovals.agentChanges")}
            hint={view.mayDecide.agentChanges ? t("rightHandApprovals.agentChangesHelp") : undefined}
            status={view.mayDecide.agentChanges ? undefined : t("rightHandApprovals.cantDecide")}
            checked={view.agentChanges && view.mayDecide.agentChanges}
            disabled={!view.mayDecide.agentChanges}
            onChange={(agentChanges) => save({ agentChanges })}
          />
          <div className="settings-row ac-actrow">
            <span className="settings-row__text ac-actrow__text">
              <span className="ac-hintline">
                <label className="settings-row__label" htmlFor="rh-budget">
                  {t("rightHandApprovals.budget")}
                </label>
                <InfoHint id="rh-budget-help" name={t("common.about", { label: t("rightHandApprovals.budget") })}>
                  {t("rightHandApprovals.budgetHelp")}
                </InfoHint>
              </span>
            </span>
            <span className="settings-row__end rh-money">
              <AffixInput
                id="rh-budget"
                prefix="US$"
                inputMode="decimal"
                value={budget ?? String(Math.round(view.budgetCapNanoUsd / USD))}
                onChange={(e) => setBudget(e.target.value)}
                onBlur={saveBudget}
                onKeyDown={(e) => e.key === "Enter" && saveBudget()}
                aria-describedby="rh-budget-help"
              />
              <span className="muted">{t("rightHandApprovals.perMonth")}</span>
            </span>
          </div>
          <div className="settings-row ac-actrow rh-guidance">
            <span className="settings-row__text ac-actrow__text">
              <span className="ac-hintline">
                <label className="settings-row__label" htmlFor="rh-guidance">
                  {t("rightHandApprovals.guidanceLabel", { name })}
                </label>
                <InfoHint
                  id="rh-guidance-help"
                  name={t("common.about", { label: t("rightHandApprovals.guidanceLabel", { name }) })}
                >
                  {t("rightHandApprovals.guidanceHelp", { name })}
                </InfoHint>
              </span>
            </span>
            <Textarea
              id="rh-guidance"
              rows={3}
              maxLength={2000}
              value={guidance ?? view.guidance}
              onChange={(e) => setGuidance(e.target.value)}
              onBlur={saveGuidance}
              placeholder={t("rightHandApprovals.guidancePlaceholder")}
              aria-describedby="rh-guidance-help"
            />
          </div>
        </div>
      )}
      <CardFooter icon="lock">{t("approvalCover.lock")}</CardFooter>
    </Card>
  );
}
