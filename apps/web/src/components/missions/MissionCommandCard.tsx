import type { MissionCommandDecision, MissionCommandMeta } from "@agenteschat/client";
import { ApiError, useMission, useMissionAct, useMissionCommands } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { formatTime } from "@agenteschat/client/lib/format";
import { executorName } from "@agenteschat/client/lib/missions";
import { Button, Checkbox, Chip, DetailsDialog, DetailsSection, Icon, Skeleton, Tip } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentSpinner } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./missions.css";

/**
 * The command card (ADR 0029): the executor asks to run a command off its
 * allow list ("Claude Code quer rodar: `swift build`"). The owner or someone
 * who decides answers Aprovar / Recusar / Aprovar sempre nesta missão, what
 * each "sempre" covers in its button's tip; the waiting executor gets the
 * answer within seconds. Merges, pushes to the default branch and deploys
 * never come here (they need `request_approval`).
 */
export function MissionCommandCard({ command: meta }: { command: MissionCommandMeta }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const mission = useMission(org.id, meta.missionId);
  const commands = useMissionCommands(org.id, meta.missionId);
  const decide = useMissionAct(org.id, meta.missionId, (decision: MissionCommandDecision) =>
    api.missions.decideCommand(org.id, meta.missionId, meta.id, decision),
  );
  const m = mission.data;
  const c = commands.data?.commands.find((x) => x.id === meta.id);
  if (!m || !c) {
    return mission.isPending || commands.isPending ? (
      <div className="mi-card mi-cmd" aria-hidden="true">
        <Skeleton width="60%" height={18} />
      </div>
    ) : null;
  }
  const who = executorName(m.executor === "codex" ? "codex" : "claude");
  const answer = (decision: MissionCommandDecision) =>
    decide.mutate(decision, { onError: (e) => toast.show(errorText(t, e), "error") });
  const by = c.decidedBy ? (dir.memberById.get(c.decidedBy)?.name ?? t("missions.someone")) : "";
  const time = c.decidedAt ? formatTime(i18n.language, c.decidedAt) : "";
  return (
    <section className="mi-card mi-cmd" aria-label={t("missions.command.label", { executor: who })}>
      <div className="mi-tags">
        <Chip icon="code">{t("missions.command.cap", { executor: who })}</Chip>
        {c.state !== "pending" && (
          <Chip icon={c.state === "allowed" ? "check" : c.state === "expired" ? "clock" : "close"}>
            {t(`missions.command.state.${c.state}`)}
          </Chip>
        )}
      </div>
      <pre className="mi-cmd__line">
        <code>{c.command}</code>
      </pre>
      {c.state === "pending" ? (
        m.canAct ? (
          <div className="mi-foot">
            <Button variant="primary" size="sm" icon="check" loading={decide.isPending} onClick={() => answer("allow")}>
              {t("missions.command.allow")}
            </Button>
            <Button size="sm" icon="close" disabled={decide.isPending} onClick={() => answer("deny")}>
              {t("missions.command.deny")}
            </Button>
            {c.rules.length > 0 && (
              <Tip
                tip={t("missions.command.alwaysHint", { rules: c.rules.map(ruleText).join(", ") })}
                look="ac-hint__bubble ac-glass"
                align="center"
                button
              >
                <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => answer("always")}>
                  {t("missions.command.always")}
                </Button>
              </Tip>
            )}
            {c.agentKind && (
              <Tip
                tip={t("missions.command.alwaysAgentHint", { kind: c.agentKind })}
                look="ac-hint__bubble ac-glass"
                align="center"
                button
              >
                <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => answer("agent")}>
                  {t("missions.command.alwaysAgent")}
                </Button>
              </Tip>
            )}
          </div>
        ) : (
          <p className="mi-hint">{t("missions.command.waiting")}</p>
        )
      ) : (
        <p className="mi-hint">
          {c.state === "expired"
            ? t("missions.command.expired")
            : c.always
              ? t("missions.command.alwaysBy", { name: by, time, rules: c.rules.map(ruleText).join(", ") })
              : c.forAgent && c.agentKind
                ? t("missions.command.alwaysAgentBy", { name: by, time, kind: c.agentKind })
                : t(c.state === "allowed" ? "missions.command.allowedBy" : "missions.command.deniedBy", {
                    name: by,
                    time,
                  })}
        </p>
      )}
    </section>
  );
}

/** `Bash(swift build *)` → `swift build …` (what people read). */
export const ruleText = (rule: string) => {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (m) return (m[1] ?? "").replace(/ \*$/, " …");
  const d = /^WebFetch\(domain:(.+)\)$/.exec(rule);
  return d ? (d[1] ?? rule) : rule;
};

/** What a refused command reads as: the shell line, or the tool and its target ("Read …/notes.md"). */
const blockedText = (d: { tool: string; command: string }) =>
  d.tool === "Bash" || !d.tool ? d.command : `${d.tool} ${d.command}`;

/** "python3", "zsh", "cd", "Read": the group a refused command goes in. */
export function blockedGroup(d: { tool: string; command: string }) {
  if (d.tool && d.tool !== "Bash") return d.tool;
  return d.command.trim().split(/\s+/)[0]?.split("/").pop() || d.command.slice(0, 16);
}

/** Released here, per task: the line keeps saying so while the session resumes (no stale "Ver"). */
const releasedTasks = new Map<string, { count: number; delivered: boolean }>();

/**
 * Under a task's end notice: the commands it was refused with nobody to ask,
 * as ONE line ("4 comandos bloqueados · Ver"); the shared details dialog
 * lists them grouped by their first word ("python3 (2)", "zsh", "Read"),
 * each cut to two lines and checkable, with one action: "Liberar
 * selecionados e continuar" (the owner or deciders; the rules are added and
 * the session resumes once). Never a raw multi-line command in the thread.
 */
export function BlockedCommands({
  missionId,
  taskId,
  blocked,
}: {
  missionId: string;
  taskId: string;
  blocked: { tool: string; command: string }[];
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const mission = useMission(org.id, missionId);
  const [open, setOpen] = useState(false);
  const [released, setReleased] = useState(() => releasedTasks.get(taskId) ?? null);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(blocked.map((_, i) => i)));
  const [error, setError] = useState<string | null>(null);
  const retry = useMissionAct(org.id, missionId, (commands: string[]) =>
    api.missions.retryCommand(org.id, missionId, { taskId, commands }),
  );
  const m = mission.data;
  const status = m?.status;
  const closed = status === "done" || status === "canceled";
  // Why it can't continue now, said before anyone clicks.
  const why = !m
    ? null
    : !m.canAct
      ? t("missions.command.onlyDeciders")
      : status === "paused"
        ? t("missions.command.releasePaused")
        : closed
          ? t("missions.command.releaseClosed")
          : null;
  const groups = new Map<string, number[]>();
  blocked.forEach((d, i) => {
    const key = blockedGroup(d);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const release = () => {
    const commands = [...picked].sort((a, b) => a - b).flatMap((i) => (blocked[i] ? [blocked[i].command] : []));
    if (commands.length === 0) return;
    setError(null);
    retry.mutate(commands, {
      onSuccess: (out) => {
        const done = { count: commands.length, delivered: out.delivered };
        releasedTasks.set(taskId, done);
        setReleased(done);
        setOpen(false);
      },
      onError: (e) => {
        const code = e instanceof ApiError ? e.code : "";
        const text =
          code === "mission.paused"
            ? t("missions.command.releasePaused")
            : code === "mission.closed"
              ? t("missions.command.releaseClosed")
              : errorText(t, e);
        setError(text);
        toast.show(text, "error");
      },
    });
  };
  if (released) {
    return (
      <span className="mi-cmd-blocked" role="status">
        {released.delivered ? <AgentSpinner agentId={m?.agentId} /> : <Icon name="check" size={14} />}
        <span>
          {released.delivered
            ? t("missions.command.releasedResuming", { count: released.count })
            : t("missions.command.releasedQueued", { count: released.count })}
        </span>
      </span>
    );
  }
  return (
    <span className="mi-cmd-blocked">
      <Icon name="lock" size={14} />
      <span>{t("missions.command.blockedCount", { count: blocked.length })}</span>
      <span aria-hidden="true">·</span>
      <button type="button" className="mi-link" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {t("missions.command.see")}
      </button>
      {open && (
        <DetailsDialog
          open
          onOpenChange={setOpen}
          closeLabel={t("common.close")}
          eyebrow={m?.title}
          title={t("missions.command.blockedTitle", { count: blocked.length })}
          subtitle={<span>{t("missions.command.blockedText")}</span>}
          footer={
            <>
              {(why || error) && <span className="mi-cmd-why">{error ?? why}</span>}
              <Button
                variant="primary"
                icon="refresh"
                loading={retry.isPending}
                disabled={Boolean(why) || picked.size === 0 || retry.isPending}
                onClick={release}
              >
                {retry.isPending ? t("missions.command.releasing") : t("missions.command.release")}
              </Button>
            </>
          }
        >
          {[...groups.entries()].map(([key, indexes]) => (
            <DetailsSection
              key={key}
              title={<code className="mi-mono">{key}</code>}
              label={key}
              count={indexes.length > 1 ? indexes.length : undefined}
            >
              <ul className="mi-cmd-list" aria-label={key}>
                {indexes.map((i) => {
                  const d = blocked[i];
                  if (!d) return null;
                  return (
                    <BlockedRow
                      key={i}
                      text={blockedText(d)}
                      checked={picked.has(i)}
                      disabled={Boolean(why) || retry.isPending}
                      onChange={(on) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                  );
                })}
              </ul>
            </DetailsSection>
          ))}
        </DetailsDialog>
      )}
    </span>
  );
}

/** One refused command: a checkbox and the command cut to two lines ("Mostrar tudo" opens it). */
function BlockedRow({
  text,
  checked,
  disabled,
  onChange,
}: {
  text: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const long = text.length > 140 || text.includes("\n");
  return (
    <li className="mi-cmd-item">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        aria-label={t("missions.command.pick", { command: text.slice(0, 80) })}
      />
      <span className="mi-cmd-item__t">
        <code className="mi-cmd-item__code" data-all={all || undefined}>
          {text}
        </code>
        {long && (
          <button type="button" className="mi-link" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? t("missions.sessions.less") : t("missions.command.showAll")}
          </button>
        )}
      </span>
    </li>
  );
}
