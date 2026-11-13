import type { CommandApproval, Mission, MissionExecutor } from "@agenteschat/client";
import {
  keys,
  useMissionBrain,
  useMissionSettings,
  useRemoveCommandRule,
  useSetAgentMissionDefault,
  useSetCommandApproval,
  useSetMissionBrain,
  useSetMissionExecutor,
  useSetResumeTasks,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isAuto } from "@agenteschat/client/lib/providers";
import {
  AutonomyPixels,
  Button,
  Chip,
  DetailsDialog,
  Field,
  Icon,
  OptionList,
  Select,
  SettingNote,
  SettingRow,
  SettingsMore,
  SettingsSection,
  Switch,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { brainModelLabel } from "@/components/AgentBrain";
import { MachineIcon } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { useToast } from "@/lib/toast";
import { COMMAND_APPROVALS, ExecutorMark } from "./MissionBits";
import { ruleText } from "./MissionCommandCard";

/**
 * "Configurações da missão", opened from the
 * header's ⋯: Autonomia (three rows with the agent's pixel illustrations),
 * O que já foi liberado (the "Aprovar sempre" rules, ×), Próximas missões
 * do agente ("Usar como padrão") and, folded, Mais opções (who does the
 * work and the computer; what to do if it turns off). Every change saves at
 * once with a glass "Salvo" toast (Desfazer where it is cheap); the footer
 * only says so and has Pronto.
 */
export function MissionSettingsDialog({
  mission: m,
  open,
  onOpenChange,
}: {
  mission: Mission;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.agentById.get(m.agentId);
  const agentName = agent?.name ?? "";
  const [savedNow, setSavedNow] = useState(false);
  return (
    <DetailsDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setSavedNow(false);
        onOpenChange(o);
      }}
      className="mi-cfg"
      eyebrow={t("missions.settings.eyebrow")}
      title={t("missions.settings.title")}
      subtitle={
        <span className="mi-cfg__sub">
          <AgentAvatar agentId={m.agentId} name={agentName} size="xs" />
          <span>{m.title}</span>
        </span>
      }
      closeLabel={t("common.close")}
      footer={
        <div className="mi-cfg__foot">
          <span
            className="mi-cfg__saved ac-iconline"
            key={savedNow ? "saved" : "idle"}
            data-saved={savedNow || undefined}
          >
            <Icon name="check" size={14} />
            <span>{savedNow ? t("missions.settings.savedNow") : t("missions.settings.footer")}</span>
          </span>
          <Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
            {t("missions.settings.done")}
          </Button>
        </div>
      }
    >
      {open && <SettingsBody mission={m} agentName={agentName} onSaved={() => setSavedNow(true)} />}
    </DetailsDialog>
  );
}

function SettingsBody({
  mission: m,
  agentName,
  onSaved,
}: {
  mission: Mission;
  agentName: string;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const g = agentGrammar(agentName);
  const look = lookOf(dir.agentById.get(m.agentId));
  const settings = useMissionSettings(org.id, m.id);
  const setApproval = useSetCommandApproval(org.id, m.id);
  const removeRule = useRemoveCommandRule(org.id, m.id);
  const setDefault = useSetAgentMissionDefault(org.id, m.id, m.agentId);
  const setResume = useSetResumeTasks(org.id, m.id);
  const setExecutor = useSetMissionExecutor(org.id);
  const qc = useQueryClient();
  const [more, setMore] = useState(false);
  // Who does the work and its model sit under Mais opções: loaded when it opens.
  const brain = useMissionBrain(org.id, m.id, more);
  const setBrain = useSetMissionBrain(org.id, m.id);
  const resumeId = useId();
  const modelId = useId();
  const mode = m.commandApproval;
  const name = (v: CommandApproval) => t(`missions.commandApproval.${v}` as const);
  const fail = (error: unknown) => toast.show(errorText(t, error), "error");
  const saved = (detail: string, undo?: () => void) => {
    onSaved();
    toast.show(
      t("missions.settings.saved"),
      "info",
      undo ? { label: t("missions.settings.undo"), run: undo } : undefined,
      detail,
    );
  };

  const chooseMode = (next: CommandApproval, prev: CommandApproval | null) =>
    setApproval.mutate(next, {
      onSuccess: () =>
        saved(
          t("missions.commandApproval.changed", { value: name(next) }),
          prev ? () => chooseMode(prev, null) : undefined,
        ),
      onError: fail,
    });

  const data = settings.data;
  const stats = data?.stats ?? { auto: 0, asked: 0, blocked: 0 };
  const agentDefault = data?.agentDefault;
  const isDefault = agentDefault?.commandApproval === mode;
  const makeDefault = (next: CommandApproval, prev: CommandApproval | null) =>
    setDefault.mutate(next, {
      onSuccess: () => {
        onSaved();
        toast.show(
          t("missions.settings.defaults.updated", g),
          "info",
          prev ? { label: t("missions.settings.undo"), run: () => makeDefault(prev, null) } : undefined,
          t("missions.settings.defaults.updatedDetail", { value: name(next) }),
        );
      },
      onError: fail,
    });

  const started = m.status !== "proposed";
  const executors: MissionExecutor[] = [
    ...new Set([...(m.machine?.executors ?? []), m.executor as MissionExecutor]),
  ].filter((e): e is MissionExecutor => e === "claude" || e === "codex" || e === "agent");
  const brainView = brain.data;
  const brainOption = brainView?.options.find((o) => o.kind === brainView.effectiveBrain);
  const executorName = (e: MissionExecutor) =>
    e === "agent" ? agentName : e === "codex" ? t("missions.settings.executor.codex") : t("missions.executor.claude");

  return (
    <div className="mi-cfg__body">
      <SettingsSection title={t("missions.commandApproval.label")} description={t("missions.settings.autonomy.sub")}>
        {!m.canAct && <SettingNote icon="lock">{t("missions.settings.readOnly")}</SettingNote>}
        <OptionList
          aria-label={t("missions.commandApproval.label")}
          value={mode}
          disabled={!m.canAct}
          onValueChange={(v) => {
            if (v !== mode) chooseMode(v, mode);
          }}
          options={COMMAND_APPROVALS.map((v) => ({
            value: v,
            title: name(v),
            tag: v === "low_risk_auto" ? t("missions.commandApproval.recommended") : undefined,
            description: t(`missions.commandApproval.${v}Text` as const),
            leading: <AutonomyPixels kind={v} color={look?.color} eyes={look?.eyes} alive={v === mode} />,
          }))}
        />
        <SettingNote icon="bulb" live key={mode}>
          {t(`missions.settings.autonomy.ex_${mode}` as const)}
        </SettingNote>
        <SettingNote icon="lock">{t("missions.settings.autonomy.alwaysAsks")}</SettingNote>
        <SettingNote icon="clock" quiet>
          {t("missions.settings.autonomy.stats", stats)}
        </SettingNote>
      </SettingsSection>

      <SettingsSection title={t("missions.settings.rules.title")} description={t("missions.settings.rules.sub")}>
        {data && data.rules.length > 0 ? (
          <ul className="ac-setlist" aria-label={t("missions.settings.rules.title")}>
            {data.rules.map((r) => {
              const command = ruleText(r.rule);
              const who = r.by ? (dir.memberById.get(r.by)?.name ?? t("channel.unknownPerson")) : "";
              return (
                <li key={r.id} className="ac-setlist__row">
                  <span className="ac-setlist__text">
                    <code className="ac-setlist__code">{command}</code>
                    <span className="ac-setlist__meta">
                      {[who, whenAt(t, i18n.language, r.createdAt)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {m.canAct && (
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="close"
                      aria-label={t("missions.settings.rules.remove", { command })}
                      title={t("missions.settings.rules.remove", { command })}
                      disabled={removeRule.isPending}
                      onClick={() =>
                        removeRule.mutate(r.id, {
                          onSuccess: () => saved(t("missions.settings.rules.removed", { command })),
                          onError: fail,
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="ac-setempty">
            <b>{t("missions.settings.rules.emptyTitle")}</b>
            {t("missions.settings.rules.emptyText")}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("missions.settings.defaults.title", g)}>
        <SettingRow
          title={t("missions.settings.defaults.startWith", { value: name(mode) })}
          status={
            !agentDefault
              ? undefined
              : isDefault
                ? t("missions.settings.defaults.isDefault", g)
                : t("missions.settings.defaults.today", { value: name(agentDefault.commandApproval) })
          }
        >
          {agentDefault &&
            (isDefault ? (
              <Chip icon="check">{t("missions.settings.defaults.chip")}</Chip>
            ) : (
              <Button
                size="sm"
                disabled={!agentDefault.canSet}
                loading={setDefault.isPending}
                title={agentDefault.canSet ? undefined : t("missions.settings.defaults.cannot", g)}
                onClick={() => makeDefault(mode, agentDefault.commandApproval)}
              >
                {t("missions.settings.defaults.use")}
              </Button>
            ))}
        </SettingRow>
        {agentDefault && !isDefault && !agentDefault.canSet && (
          <SettingNote icon="lock">{t("missions.settings.defaults.cannot", g)}</SettingNote>
        )}
      </SettingsSection>

      <SettingsMore
        title={t("missions.settings.more.title")}
        description={t("missions.settings.more.sub")}
        open={more}
        onOpenChange={setMore}
      >
        <SettingsSection
          title={t("missions.settings.executor.title")}
          description={t("missions.settings.executor.sub")}
        >
          <OptionList
            aria-label={t("missions.settings.executor.title")}
            value={m.executor as MissionExecutor}
            disabled={started || m.role !== "owner"}
            onValueChange={(v) =>
              setExecutor.mutate(
                { missionId: m.id, executor: v },
                {
                  onSuccess: () => {
                    // Its model follows who does the work.
                    void qc.invalidateQueries({ queryKey: keys.missionPart(org.id, m.id, "brain") });
                    saved(t("missions.settings.executor.saved", { name: executorName(v) }));
                  },
                  onError: fail,
                },
              )
            }
            options={executors.map((e) => ({
              value: e,
              title: (
                <>
                  <ExecutorMark executor={e} agentId={m.agentId} agentName={agentName} />
                  {executorName(e)}
                </>
              ),
              description:
                e === "agent"
                  ? t("missions.settings.executor.agentText", g)
                  : t(`missions.settings.executor.${e}Text` as const),
            }))}
          />
          {brainView && brainOption && brainOption.models.length > 0 && (
            <Field
              label={t("brain.mission.modelLabel")}
              id={modelId}
              hint={{
                name: t("common.about", { label: t("brain.mission.modelLabel") }),
                text: t("brain.mission.modelHint"),
              }}
            >
              <Select
                value={brainView.effectiveModel ?? undefined}
                disabled={!brainView.canSetModel || setBrain.isPending}
                onValueChange={(model) =>
                  setBrain.mutate(
                    { model },
                    {
                      onSuccess: () => saved(t("brain.mission.saved", { model: brainModelLabel(brainOption, model) })),
                      onError: fail,
                    },
                  )
                }
                options={[
                  ...brainOption.models.map((o) => ({
                    value: o.value,
                    label: o.label,
                    description: o.recommended ? t("brain.recommended") : undefined,
                  })),
                  // The agent's own model when it isn't one of the list (a typed one, a coding plan's, "Automático").
                  ...(brainView.effectiveModel && !brainOption.models.some((o) => o.value === brainView.effectiveModel)
                    ? [
                        {
                          value: brainView.effectiveModel,
                          label: isAuto(brainView.effectiveModel)
                            ? t("brain.auto.label")
                            : brainModelLabel(brainOption, brainView.effectiveModel),
                        },
                      ]
                    : []),
                ]}
              />
            </Field>
          )}
          <ul className="ac-setlist mi-cfg__computer">
            <li className="ac-setlist__row ac-setlist__row--pad">
              <span className="ac-setlist__text">
                <span className="ac-setlist__title">
                  <MachineIcon machineId={m.machine?.id} size={16} />
                  {m.machine?.name ?? t("missions.settings.executor.noComputer")}
                </span>
              </span>
              {m.machine && (
                <Chip icon={m.machine.online ? "check" : "pause"}>
                  {m.machine.online ? t("missions.settings.executor.online") : t("missions.settings.executor.offline")}
                </Chip>
              )}
            </li>
          </ul>
          <SettingNote icon={started ? "lock" : "clock"}>
            {started ? t("missions.settings.executor.locked") : t("missions.settings.executor.open")}
          </SettingNote>
        </SettingsSection>
        <SettingsSection title={t("missions.settings.recovery.title")}>
          <SettingRow
            title={t("missions.settings.recovery.label")}
            hint={{
              name: t("common.about", { label: t("missions.settings.recovery.label") }),
              text: t("missions.settings.recovery.hint"),
            }}
            htmlFor={resumeId}
          >
            <Switch
              id={resumeId}
              checked={m.resumeTasks}
              disabled={!m.canAct || setResume.isPending}
              onCheckedChange={(on) =>
                setResume.mutate(on, {
                  onSuccess: () => saved(on ? t("missions.settings.recovery.on") : t("missions.settings.recovery.off")),
                  onError: fail,
                })
              }
            />
          </SettingRow>
        </SettingsSection>
      </SettingsMore>
    </div>
  );
}
