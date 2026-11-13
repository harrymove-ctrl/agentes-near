import type { Agent, AgentSetup, CommandApproval } from "@agenteschat/client";
import { useAgents, useModels, useSetupPreview } from "@agenteschat/client";
import { autonomyName, changes, setupResultLine, sortedResults, takers } from "@agenteschat/client/lib/agent-setup";
import { setupPlanOpens } from "@agenteschat/client/lib/audience";
import { brainLine } from "@agenteschat/client/lib/brain";
import { firstName } from "@agenteschat/client/lib/format";
import { isAuto } from "@agenteschat/client/lib/providers";
import { Button, Checkbox, Dialog, DialogFooter, DialogSearchList, Locked, Switch } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useAgentEdit } from "../context";

/**
 * "Usar em outros agentes" (ADR 0094): every other agent with what the setup would do to it (the server's preview),
 * those that can take it first, "Todos" on top for all of them, and "Levar a autonomia" over them, which leaves each
 * agent's own when off. "Usar" saves it on the agents picked; this agent's own is already saved.
 */
export function SetupCopyDialog({
  setup,
  setupText,
  autonomy,
  withAutonomy,
  onWithAutonomy,
  busy,
  onClose,
  onUse,
}: {
  setup: AgentSetup;
  setupText: string;
  /** This agent's saved Autonomia. */
  autonomy: CommandApproval | undefined;
  withAutonomy: boolean;
  onWithAutonomy: (on: boolean) => void;
  busy: boolean;
  onClose: () => void;
  /** `opens`: the agents picked whose owner's plan it opens to more people (`setupPlanOpens`). */
  onUse: (agentIds: string[], opens: { agent: string; owner: string }[]) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const agents = useAgents(org.id);
  const models = useModels();
  const dir = useDirectory(org.id);
  const others = (agents.data ?? []).filter((a) => a.id !== agent.id);
  // This agent first, as its own setup is what the others take: a sign-in made for one agent is its own then.
  const preview = useSetupPreview(org.id, setup, [agent.id, ...others.map((a) => a.id)]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const results = sortedResults((preview.data ?? []).filter((r) => r.agentId !== agent.id));
  const can = takers(results);
  const chosen = can.filter((id) => picked.has(id));
  const byId = new Map(others.map((a) => [a.id, a]));
  const shown = results.filter((r) => !query || byId.get(r.agentId)?.name.toLowerCase().includes(query));
  const nowOf = (a: Agent) =>
    a.brain && a.brain.kind !== "model"
      ? brainLine(t, a.brain, "").text
      : isAuto(a.model)
        ? t("brain.auto.label")
        : (models.data?.models.find((m) => m.id === a.model)?.label ?? a.model);
  const ownerOf = (a: Agent) => {
    const name = a.ownerUserId ? dir.memberById.get(a.ownerUserId)?.name : undefined;
    return name ? firstName(name) : undefined;
  };
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("agentPage.work.brain.copy.title")}
      description={t("agentPage.work.brain.copy.sub", { setup: setupText })}
      closeLabel={t("common.close")}
      className="agp-copydialog"
    >
      <Locked when={busy}>
        {autonomy && (
          <div className="ac-dialog__tools">
            <label htmlFor="setup-autonomy" className="agp-copydialog__all">
              <span className="scope-row__text">
                <b>{t("agentPage.work.brain.copy.withAutonomy")}</b>
                <span className="small muted">
                  {t("agentPage.work.brain.copy.withAutonomyLine", { value: autonomyName(t, autonomy) })}
                </span>
              </span>
              <Switch id="setup-autonomy" checked={withAutonomy} disabled={busy} onCheckedChange={onWithAutonomy} />
            </label>
          </div>
        )}
        {preview.data && (
          <div className="ac-dialog__tools">
            <label htmlFor="setup-all" className="agp-copydialog__all" data-off={can.length === 0 || undefined}>
              <Checkbox
                id="setup-all"
                checked={can.length > 0 && chosen.length === can.length}
                disabled={can.length === 0}
                onCheckedChange={(on) => setPicked(new Set(on ? can : []))}
              />
              <span className="scope-row__text">
                <b>{t("agentPage.work.brain.copy.all")}</b>
                <span className="small muted">
                  {can.length === 0
                    ? t("agentPage.work.brain.copy.none")
                    : t("agentPage.work.brain.copy.allLine", { count: can.length })}
                </span>
              </span>
            </label>
          </div>
        )}
        {preview.isPending ? (
          <div className="ac-dialog__body">
            <LoadingLine width={220} />
          </div>
        ) : preview.isError ? (
          <p className="ac-dialog__empty">{t("agentPage.work.failed")}</p>
        ) : (
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            search={others.length > 8}
            searchLabel={t("agentPage.work.brain.copy.search")}
            searchPlaceholder={t("agentPage.work.brain.copy.search")}
            listLabel={t("agentPage.work.brain.copy.title")}
            isEmpty={shown.length === 0}
            emptyText={t("agentPage.work.brain.copy.noMatch", { q })}
          >
            {shown.map((r) => {
              const a = byId.get(r.agentId);
              if (!a) return null;
              const id = `setup-${a.id}`;
              const off = !changes(r);
              return (
                <label key={a.id} htmlFor={id} className="scope-row" data-off={off || undefined}>
                  <Checkbox
                    id={id}
                    checked={!off && picked.has(a.id)}
                    disabled={off}
                    onCheckedChange={(on) => toggle(a.id, on)}
                  />
                  <AgentAvatar agentId={a.id} name={a.name} size="sm" />
                  <span className="scope-row__text">
                    <span>{a.name}</span>
                    <span className="small muted">{setupResultLine(t, r, { now: nowOf(a), owner: ownerOf(a) })}</span>
                  </span>
                </label>
              );
            })}
          </DialogSearchList>
        )}
      </Locked>
      <DialogFooter bar>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={chosen.length === 0}
          loading={busy}
          onClick={() =>
            onUse(
              chosen,
              setupPlanOpens(
                results,
                chosen,
                (id) => byId.get(id),
                (id) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
              ),
            )
          }
        >
          {chosen.length === 0
            ? t("agentPage.work.brain.copy.pick")
            : t("agentPage.work.brain.copy.use", { count: chosen.length })}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
