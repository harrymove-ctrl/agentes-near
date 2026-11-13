import type { ControlConfig, ControlConfigPatch } from "@agenteschat/adapters/runner-control";
import { Button, Segmented } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { orgName, pairedHomes } from "../../control/store";
import { OrgTile, Stepper } from "../../ui/bits";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { shortPath } from "../../ui/time";

/** The runner's defaults (the same numbers `agentes-runner` uses when the config has none). */
export const DEFAULT_LIMITS: Required<Omit<ControlConfigPatch, "name">> = {
  maxConcurrentTasks: 3,
  taskMaxSeconds: 4 * 3600,
  brainMaxProcesses: 1,
  brainIdleMinutes: 3,
};

const TASK_MAX = ["3600", "14400", "28800"] as const;
const IDLE = ["3", "5", "10", "30"] as const;

export function Advanced() {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const first = homes[0]?.homeId;
  const [config, setConfig] = useState<ControlConfig | null>(null);

  useEffect(() => {
    if (!first) return;
    let live = true;
    store
      .request(first, { type: "config.get" })
      .then((c) => live && setConfig(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store, first]);

  const limits = { ...DEFAULT_LIMITS, ...(config ?? {}) };

  // Limits apply to each organization: the same numbers go to every one.
  const change = async (patch: ControlConfigPatch, done?: string) => {
    setConfig((c) => (c ? { ...c, ...patch } : c));
    try {
      await store.requestAll({ type: "config.set", patch });
      if (done) toast(done);
    } catch {
      toast(t("desktop.common.error"), "alert");
    }
  };

  const disabled = homes.length === 0;
  return (
    <>
      <PrefHead
        title={t("desktop.prefs.advanced.title")}
        lead={t("desktop.prefs.advanced.lead")}
        action={
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void change(DEFAULT_LIMITS, t("desktop.prefs.advanced.defaultsDone"))}
          >
            {t("desktop.prefs.advanced.defaults")}
          </Button>
        }
      />

      <CardTitle>{t("desktop.prefs.advanced.longJobs")}</CardTitle>
      <PrefCard>
        <PrefRow
          title={t("desktop.prefs.advanced.concurrent")}
          hint={hintFor(t, t("desktop.prefs.advanced.concurrent"), t("desktop.prefs.advanced.concurrentDesc"))}
          end={
            <Stepper
              label={t("desktop.prefs.advanced.concurrent")}
              value={limits.maxConcurrentTasks}
              min={1}
              max={8}
              onChange={(v) => void change({ maxConcurrentTasks: v })}
            />
          }
        />
        <PrefRow
          title={t("desktop.prefs.advanced.maxTime")}
          hint={hintFor(t, t("desktop.prefs.advanced.maxTime"), t("desktop.prefs.advanced.maxTimeDesc"))}
          end={
            <Segmented
              size="sm"
              label={t("desktop.prefs.advanced.maxTime")}
              value={
                (TASK_MAX as readonly string[]).includes(String(limits.taskMaxSeconds))
                  ? String(limits.taskMaxSeconds)
                  : ""
              }
              onValueChange={(v) => void change({ taskMaxSeconds: Number(v) })}
              options={TASK_MAX.map((s) => ({
                value: s as string,
                label: t("desktop.common.hours", { count: Number(s) / 3600 }),
              }))}
            />
          }
        />
      </PrefCard>

      <CardTitle>{t("desktop.prefs.advanced.claude")}</CardTitle>
      <PrefCard>
        <PrefRow
          title={t("desktop.prefs.advanced.brainMax")}
          hint={hintFor(t, t("desktop.prefs.advanced.brainMax"), t("desktop.prefs.advanced.brainMaxDesc"))}
          end={
            <Stepper
              label={t("desktop.prefs.advanced.brainMax")}
              value={limits.brainMaxProcesses}
              min={1}
              max={8}
              onChange={(v) => void change({ brainMaxProcesses: v })}
            />
          }
        />
        <PrefRow
          title={t("desktop.prefs.advanced.brainIdle")}
          end={
            <Segmented
              size="sm"
              label={t("desktop.prefs.advanced.brainIdle")}
              value={
                (IDLE as readonly string[]).includes(String(limits.brainIdleMinutes))
                  ? String(limits.brainIdleMinutes)
                  : ""
              }
              onValueChange={(v) => void change({ brainIdleMinutes: Number(v) })}
              options={IDLE.map((m) => ({
                value: m as string,
                label: t("desktop.common.minutes", { count: Number(m) }),
              }))}
            />
          }
        />
      </PrefCard>

      <CardTitle hint={hintFor(t, t("desktop.prefs.advanced.folder"), t("desktop.prefs.advanced.folderDesc"))}>
        {t("desktop.prefs.advanced.folder")}
      </CardTitle>
      <PrefCard>
        {homes.map((h) => (
          <PrefRow
            key={h.homeId}
            lead={<OrgTile logo={h.logo} size="md" />}
            title={orgName(h)}
            desc={h.status?.workspace && <span className="dk-path">{shortPath(h.status.workspace)}</span>}
            end={
              h.status?.workspace ? (
                <Button size="sm" variant="ghost" onClick={() => void host.revealFolder(h.status?.workspace ?? "")}>
                  {t("desktop.common.open")}
                </Button>
              ) : undefined
            }
          />
        ))}
      </PrefCard>
    </>
  );
}
