import type { Routine } from "@agenteschat/client";
import { useAgentDetail, useAgentSkills, useRoutines, useUsage } from "@agenteschat/client";
import { audienceSummary, modeOf } from "@agenteschat/client/lib/audience";
import { formatMonth, formatPercent, formatUsd, whenAt } from "@agenteschat/client/lib/format";
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  GroupHeading,
  Icon,
  Meter,
  PlanMeter,
  Switch,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResourceIcon, resourceName, useConnectedById } from "@/components/AccessLevels";
import { usd } from "@/components/AgentFields";
import { LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import type { Field } from "@/lib/agent-edit";
import { planMeterText, usageShown } from "@/lib/plan-usage";
import { useRoutineControls } from "@/pages/RoutinesPage";
import { AgentAsksLine, agentConnectorTools } from "./AgentTools";
import { ComputerNow } from "./ComputerNow";
import { useAgentEdit } from "./context";
import { useRepoSuffix } from "./Repos";
import { AudienceEditor, BudgetEditor, ChannelsEditor, OwnerEditor } from "./SettingsTab";
import { Cell, WorkCard } from "./Work";

/** The fact sheet's own dialogs; who thinks, where it works and the browser open the page's (`openWork`). */
type FichaDialog = "access" | "usage" | "budget" | "owner" | "audience" | "channels" | "routines";

/** How many of what it may use the row names before "and N more". */
const USES_NAMED = 2;

/**
 * The overview's fact sheet ("ficha"): what were the cells under the name and six cards, as two lists of rows (How
 * it works, then who it works with). A row says the value and opens a dialog: the page's own for who thinks, where it
 * works and the browser; for the rest, the same editors the Settings tab has, which edit the draft and save with the
 * dialog's Save (or the page's save bar). Who can't change a value reads it there.
 */
export function Ficha() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const { agent, g, viewer, saved, resources, accessState, openWork, workOpen } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const usage = useUsage(org.id);
  const routines = useRoutines(org.id);
  const items = useConnectedById();
  const { solo } = usePersonalView();
  const [open, setOpen] = useState<FichaDialog | null>(null);
  const shownOpen = open ?? workOpen;

  /* What it may use: the connectors first, then the workspace's tools. */
  const levels = saved.levels ?? {};
  const using = resources.filter((r) => (levels[r.id] ?? "none") !== "none");
  const named = [...using.filter((r) => r.kind === "connector"), ...using.filter((r) => r.kind === "builtin")].map(
    (r) => resourceName(t, r, items),
  );

  /* Its usage: its plan's limits, the budget once it spent through the API (ADR 0063 §5). */
  const used = detail.data?.budgetUsedPercent ?? 0;
  const shown = usageShown(agent.brain, used);
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const money = viewer === "admin" && spent !== undefined && limit !== undefined;
  const budgetLine = money
    ? `${formatUsd(locale, spent)} ${t("agentPage.stats.of", { amount: usd(t, locale, limit) })}`
    : t("agentPage.numbers.budget", { percent: formatPercent(locale, used) });

  const owner = agent.ownerUserId ? dir.memberById.get(agent.ownerUserId) : undefined;
  // Alone in a personal workspace, being its owner and who talks to it say nothing new while they hold what they hold
  // there (the person's, everyone or only them): Settings keeps both, and a list of people always shows (ADR 0159).
  const ownerShown = !(solo && agent.ownerUserId === me.user.id);
  const audienceShown = !solo || modeOf(agent) === "people";
  const channels = (detail.data?.channels ?? []).filter((c) => saved.channels?.includes(c.id) ?? true);
  const mine = (routines.data ?? []).filter((r) => r.agentId === agent.id);
  const next = mine
    .flatMap((r) => (r.nextRunAt ? [r.nextRunAt] : []))
    .sort()
    .at(0);

  return (
    <>
      <WorkCard
        onOpen={openWork}
        open={shownOpen}
        before={<ComputerNow />}
        after={
          <>
            <Cell
              row
              icon={<Icon name="plug" size={16} />}
              label={t("agentPage.overview.uses")}
              value={
                accessState === "loading" ? (
                  <LoadingLine width={160} />
                ) : named.length ? (
                  [
                    named.slice(0, USES_NAMED).join(", "),
                    named.length > USES_NAMED
                      ? t("agentPage.overview.andMore", { count: named.length - USES_NAMED })
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                ) : (
                  t("agentPage.overview.noConnectors")
                )
              }
              open={shownOpen === "access"}
              openLabel={t("agentPage.overview.uses")}
              onOpen={() => setOpen("access")}
            />
            {shown.plan ? (
              <Cell
                row
                icon={<Icon name="clock" size={16} />}
                label={t("agentPage.tabs.usage")}
                value={
                  <span className="agp-frow__usage">
                    <PlanMeter
                      compact
                      usage={shown.plan.usage}
                      text={planMeterText(t, locale)}
                      label={shown.plan.account}
                    />
                    {shown.budget && <span>{budgetLine}</span>}
                  </span>
                }
                open={shownOpen === "usage"}
                openLabel={t("agentPage.tabs.usage")}
                onOpen={() => setOpen("usage")}
              />
            ) : (
              shown.budget && (
                <Cell
                  row
                  icon={<Icon name="wallet" size={16} />}
                  label={t("agentPage.settings.budget")}
                  value={
                    <span className="agp-frow__usage">
                      <Meter value={Math.min(100, used)} max={100} label={t("agent.budgetUsed")} />
                      <span>{budgetLine}</span>
                    </span>
                  }
                  open={shownOpen === "budget"}
                  openLabel={t("agentPage.settings.budget")}
                  onOpen={() => setOpen("budget")}
                />
              )
            )}
          </>
        }
      />

      <div className="agp-work">
        <GroupHeading id="agp-ficha-with" title={t("agentPage.ficha.with")} />
        <section className="agp-ficha__card" aria-labelledby="agp-ficha-with">
          {ownerShown && (
            <Cell
              row
              icon={
                owner ? (
                  <Avatar kind="person" size="xs" name={owner.name} imageUrl={owner.image} />
                ) : (
                  <Icon name="members" size={16} />
                )
              }
              label={t("newAgent.owner")}
              value={
                owner
                  ? owner.userId === me.user.id
                    ? t("newAgent.you", { name: owner.name })
                    : owner.name
                  : t("newAgent.noOwnerOption")
              }
              open={shownOpen === "owner"}
              openLabel={t("newAgent.owner")}
              onOpen={() => setOpen("owner")}
            />
          )}
          {audienceShown && (
            <Cell
              row
              icon={<Icon name="message" size={16} />}
              label={t("audience.section")}
              value={audienceSummary(t, agent, (id) => dir.memberById.get(id)?.name, dir.roleName, org)}
              open={shownOpen === "audience"}
              openLabel={t("audience.section")}
              onOpen={() => setOpen("audience")}
            />
          )}
          <Cell
            row
            icon={<Icon name="channel" size={16} />}
            label={t("newAgent.channels")}
            value={channels.length ? channels.map((c) => `#${c.name}`).join(", ") : t("agentPage.none")}
            open={shownOpen === "channels"}
            openLabel={t("newAgent.channels")}
            onOpen={() => setOpen("channels")}
          />
          {mine.length > 0 && (
            <Cell
              row
              icon={<Icon name="routines" size={16} />}
              label={t("agentPage.overview.routines")}
              value={mine.map((r) => r.name).join(", ")}
              sub={
                next
                  ? t("agentPage.overview.nextRun", { when: whenAt(t, locale, next) })
                  : t("agentPage.overview.paused")
              }
              open={shownOpen === "routines"}
              openLabel={t("agentPage.overview.routines")}
              onOpen={() => setOpen("routines")}
            />
          )}
        </section>
      </div>

      <AccessDialog open={open === "access"} onClose={() => setOpen(null)} />
      <Dialog
        open={open === "usage"}
        onOpenChange={(o) => !o && setOpen(null)}
        title={t("agentPage.tabs.usage")}
        closeLabel={t("common.close")}
        width={520}
      >
        <DialogBody>
          <UsageBody />
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(null)}>{t("common.close")}</Button>
          <GoButton tab="usage" label={t("agentPage.overview.seeAll")} onGo={() => setOpen(null)} />
        </DialogFooter>
      </Dialog>
      <EditDialog
        open={open === "budget"}
        onClose={() => setOpen(null)}
        title={t("agentPage.settings.budget")}
        fields={["budget"]}
      >
        <BudgetEditor />
      </EditDialog>
      <EditDialog
        open={open === "owner"}
        onClose={() => setOpen(null)}
        title={t("newAgent.owner")}
        fields={["owner"]}
        // Choosing an owner who was in the list takes them out of it (OwnerEditor): Cancel puts both back.
        reverts={["owner", "audience"]}
      >
        <OwnerEditor />
      </EditDialog>
      <EditDialog
        open={open === "audience"}
        onClose={() => setOpen(null)}
        title={t("audience.title", g)}
        fields={["audience"]}
      >
        <AudienceEditor layout="rows" />
      </EditDialog>
      <EditDialog
        open={open === "channels"}
        onClose={() => setOpen(null)}
        title={t("newAgent.channels")}
        fields={["channels"]}
      >
        <ChannelsEditor />
      </EditDialog>
      <Dialog
        open={open === "routines"}
        onOpenChange={(o) => !o && setOpen(null)}
        title={t("agentPage.overview.routines")}
        closeLabel={t("common.close")}
        width={520}
      >
        <DialogBody>
          <ul className="agp-list">
            {mine.map((r) => (
              <RoutineLine key={r.id} routine={r} onGo={() => setOpen(null)} />
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => setOpen(null)}>{t("common.close")}</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

/** A tab of the page, from a dialog: the dialog closes first. */
function GoButton({ tab, label, onGo }: { tab: "usage" | "access"; label: string; onGo: () => void }) {
  const { goTo } = useAgentEdit();
  return (
    <Button
      variant="primary"
      onClick={() => {
        onGo();
        goTo(tab);
      }}
    >
      {label}
    </Button>
  );
}

/**
 * A dialog over one of the Settings tab's editors. Who may change it gets Cancel (puts its fields back) and Save (the
 * page's save, as the save bar's); everyone else reads it and closes. Closing any other way is Cancel.
 */
function EditDialog({
  open,
  onClose,
  title,
  fields,
  reverts = fields,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: Field[];
  reverts?: Field[];
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { can, changes, revert, save, saving } = useAgentEdit();
  const editable = fields.some((f) => can(f));
  const cancel = () => {
    for (const c of changes) if (reverts.includes(c.field)) revert(c.key);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && cancel()} title={title} closeLabel={t("common.close")} width={520}>
      <DialogBody>{children}</DialogBody>
      <DialogFooter>
        {editable ? (
          <>
            <Button onClick={cancel}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() =>
                void save().then((ok) => {
                  if (ok) onClose();
                })
              }
            >
              {t("common.save")}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t("common.close")}</Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** Can use: each connector at its level, the workspace's tools, its skills and what it asks before; the tab changes them. */
function AccessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent, saved, can, resources } = useAgentEdit();
  const items = useConnectedById();
  const skills = useAgentSkills(org.id, agent.id);
  const repoSuffix = useRepoSuffix();
  const levels = saved.levels ?? {};
  const using = resources.filter((r) => (levels[r.id] ?? "none") !== "none");
  const connectors = using.filter((r) => r.kind === "connector");
  const builtins = using.filter((r) => r.kind === "builtin");
  const enabledSkills = (skills.data ?? []).filter((s) => s.enabled);
  const label = can("levels") ? t("agentPage.overview.changeAccess") : t("agentPage.overview.seeAccess");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("agentPage.overview.uses")}
      closeLabel={t("common.close")}
      width={560}
    >
      <DialogBody>
        <div className="agp-kv">
          <div>
            <span className="agp-k">{t("access.kind.connectors")}</span>
            {connectors.length ? (
              <span className="agp-chips">
                {connectors.map((r) => {
                  const n = resourceName(t, r, items);
                  return (
                    <span key={r.id} className="ac-chip agp-res">
                      <ResourceIcon resource={r} items={items} name={n} />
                      {t(
                        levels[r.id] === "write"
                          ? "agentPage.overview.levelWrite"
                          : levels[r.id] === "custom"
                            ? "agentPage.overview.levelCustom"
                            : "agentPage.overview.levelRead",
                        { name: n },
                      )}
                      {r.connector === "github" && repoSuffix}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className="small muted">{t("agentPage.overview.noConnectors")}</span>
            )}
          </div>
          {builtins.length > 0 && (
            <div>
              <span className="agp-k">{t("access.kind.builtin")}</span>
              <span className="agp-chips">
                {builtins.map((r) => {
                  const n = resourceName(t, r, items);
                  return (
                    <span key={r.id} className="ac-chip agp-res">
                      <ResourceIcon resource={r} items={items} name={n} />
                      {n}
                    </span>
                  );
                })}
              </span>
            </div>
          )}
          {enabledSkills.length > 0 && (
            <div>
              <span className="agp-k">{t("skills.agentTitle")}</span>
              <span className="agp-chips">
                {enabledSkills.map((s) => (
                  <Chip key={s.id} icon="book">
                    {s.name}
                  </Chip>
                ))}
              </span>
            </div>
          )}
        </div>
        <AgentAsksLine
          agentName={agent.name}
          groups={agentConnectorTools(t, connectors, levels, items)}
          items={items}
          canChange={false}
          onChange={onClose}
        />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
        <GoButton tab="access" label={label} onGo={onClose} />
      </DialogFooter>
    </Dialog>
  );
}

/** Usage: its plan's limits (and the budget once it spent through the API), or the budget alone. */
function UsageBody() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { org } = useOrg();
  const { agent, viewer } = useAgentEdit();
  const detail = useAgentDetail(org.id, agent.id);
  const usage = useUsage(org.id);
  const used = detail.data?.budgetUsedPercent ?? 0;
  const shown = usageShown(agent.brain, used);
  const spent = usage.data?.find((u) => u.agentId === agent.id)?.costUsd;
  const limit = detail.data?.monthlyBudgetUsd ?? detail.data?.defaultBudgetUsd;
  const budgetText =
    viewer === "admin" && spent !== undefined && limit !== undefined
      ? t("agentPage.overview.spentOf", {
          spent: formatUsd(locale, spent),
          limit: usd(t, locale, limit),
          month: formatMonth(locale, new Date()),
        })
      : t(detail.data?.monthlyBudgetUsd === null ? "agentPage.overview.percentDefault" : "agentPage.overview.percent", {
          percent: formatPercent(locale, used),
        });
  return (
    <div className="agp-budget">
      {shown.plan && (
        <PlanMeter compact usage={shown.plan.usage} text={planMeterText(t, locale)} label={shown.plan.account} />
      )}
      {shown.budget && <span className="small muted">{budgetText}</span>}
    </div>
  );
}

/** One of its routines: when it runs next, a switch for who may pause it, a link to its page. */
function RoutineLine({ routine: r, onGo }: { routine: Routine; onGo: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const controls = useRoutineControls(r);
  return (
    <li className="agp-li ac-faceline">
      <span className="agp-ib">
        <Icon name="routines" size={14} />
      </span>
      <span className="agp-li__t">
        <Link
          className="ac-captop agp-li__link"
          to="/org/$orgId/routines"
          params={{ orgId: org.id }}
          search={{ open: r.id }}
          onClick={onGo}
        >
          {r.name}
        </Link>
        <span>
          {r.nextRunAt
            ? t("agentPage.overview.nextRun", { when: whenAt(t, i18n.language, r.nextRunAt) })
            : t("agentPage.overview.paused")}
        </span>
      </span>
      {r.canManage && (
        <span className="agp-li__tail ac-captop">
          <Switch
            checked={r.active}
            onCheckedChange={(on) => controls.setActive(on)}
            aria-label={t(r.active ? "routines.pause" : "routines.resume")}
          />
        </span>
      )}
    </li>
  );
}
