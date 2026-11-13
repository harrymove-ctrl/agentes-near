import type { BrowserHandoff, Machine, ScopeGrant } from "@agenteschat/client";
import {
  agentStateOfRun,
  BROWSER_TOOL_SCOPE,
  isOpenHandoff,
  keys,
  useApi,
  useBrowserHandoffMutations,
  usesBrowser,
} from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  allowsInApp,
  canReduceAccess,
  commandInReason,
  machineReasonText,
  toolOnCommand,
} from "@agenteschat/client/lib/machines";
import { Button, Card, CardHeader, Chip, Icon } from "@agenteschat/ui";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { useStreams } from "@/realtime/context";
import { AgentAvatar } from "../AgentAvatar";
import { CommandBlock } from "../machine-bits";
import { useOrg } from "../org-context";
import { OpenPrefsButton, useIsThisMac } from "../ThisMac";
import { BrowserCard } from "./BrowserCard";
import "./browser.css";

/**
 * "Navegador" on a computer's page (ADR 0040): whether the browser is ready here, which agents are in it
 * now (Ver, Parar), and which agents may use it. Turning it on happens on
 * the computer; the owner can only turn it off here.
 */
export function MachineBrowserCard({ machine: m, onTurnOff }: { machine: Machine; onTurnOff: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const actions = useBrowserHandoffMutations(org.id);
  const [confirming, setConfirming] = useState<string | null>(null);
  // In the app, on this very Mac: the browser is turned on in Preferences → Ferramentas (ADR 0036).
  const here = useIsThisMac(org.id, m.id);
  const [seeing, setSeeing] = useState<string | null>(null);
  const agentIds = m.agents.map((a) => a.id);
  const handoffs = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.agentBrowserHandoff(org.id, id),
      queryFn: () => api.browser.agentHandoff(org.id, id),
      retry: false,
    })),
  });
  const scopes = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.scopes(org.id, id),
      queryFn: () => api.scopes.get(org.id, id),
      retry: false,
      enabled: m.canManage,
    })),
  });
  const settings = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.agentBrowser(org.id, id),
      queryFn: () => api.browser.settings(org.id, id),
      retry: false,
    })),
  });
  // Agents at work whose latest call is in the browser, from the live store: between two calls the run
  // has no current tool, and while it works its status reads "thinking", so neither alone says it.
  const busy = useStreams((s) =>
    Object.values(s.runs)
      .filter((r) => agentIds.includes(r.agentId) && agentStateOfRun(r) !== "idle" && usesBrowser(r))
      .map((r) => r.agentId)
      .sort()
      .join(","),
  );
  const access = m.access;
  if (!access && !m.browser) return null;
  const switchedOn = access?.tools.browser === true;
  const ready = switchedOn && m.browser?.available === true;
  const command = commandInReason(m.browser?.reason);
  const uses = m.agents.flatMap((a, i) => {
    const h = handoffs[i]?.data as BrowserHandoff | null | undefined;
    const open = h && isOpenHandoff(h) ? h : null;
    const running = busy.split(",").includes(a.id);
    return open || running ? [{ agent: a, open, running }] : [];
  });
  const allowed = m.agents.flatMap((a, i) => {
    const grants = scopes[i]?.data as ScopeGrant[] | undefined;
    if (!grants?.some((g) => g.connectionId === null && g.scope === BROWSER_TOOL_SCOPE)) return [];
    const domains = settings[i]?.data?.allowedDomains ?? null;
    return [{ agent: a, domains }];
  });
  const stop = (agentId: string, name: string) =>
    actions.stop.mutate(agentId, {
      onSuccess: () => {
        setConfirming(null);
        toast.show(t("browser.machine.stopped", agentGrammar(name)));
      },
      onError: () => toast.show(t("browser.live.actionFailed"), "error"),
    });
  return (
    <Card aria-labelledby="sec-machine-browser">
      <CardHeader
        id="sec-machine-browser"
        icon="globe"
        title={t("browser.title")}
        action={
          switchedOn &&
          canReduceAccess(m) && (
            <Button size="sm" variant="ghost" aria-label={t("browser.machine.turnOffLabel")} onClick={onTurnOff}>
              {t("browser.machine.turnOff")}
            </Button>
          )
        }
      />
      <div className="brw-status">
        {ready ? (
          <Chip icon="check" tone="done">
            {t("browser.machine.ready")}
          </Chip>
        ) : !switchedOn ? (
          <Chip icon="dash">{t("browser.machine.off")}</Chip>
        ) : command ? (
          <Chip icon="alert" tone="waiting">
            {t("browser.machine.needsCommand")}
          </Chip>
        ) : (
          <Chip icon="alert">{t("browser.machine.notReady")}</Chip>
        )}
        {ready && m.browser?.version && <span className="small muted">{m.browser.chrome ?? ""}</span>}
      </div>
      {!switchedOn &&
        (here ? (
          <div className="brw-note brw-note--act">
            <span className="brw-note__text ac-iconline">
              <Icon name="computer" size={16} />
              <span>{t("machines.thisMac.toolsHere")}</span>
            </span>
            <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
          </div>
        ) : allowsInApp(m.os) ? (
          <div className="brw-note ac-iconline">
            <Icon name="computer" size={16} />
            <div>{t("browser.machine.offHelp")}</div>
          </div>
        ) : (
          // A Linux computer may be a server without the app: the command too.
          <div className="brw-note ac-iconline">
            <Icon name="computer" size={16} />
            <div className="stack-4" style={{ flex: 1, minWidth: 0, gap: 6 }}>
              <span>{t("browser.machine.offHelp")}</span>
              <span>{t("machines.access.grantTerminal")}</span>
              <CommandBlock command={toolOnCommand(m, "browser")} />
            </div>
          </div>
        ))}
      {switchedOn && !ready && m.browser?.reason && (
        <div className="brw-note ac-iconline">
          <Icon name="alert" size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {machineReasonText(t, m.browser)}
            {command && <CommandBlock command={command} />}
          </div>
        </div>
      )}
      {ready && (
        <>
          <h3 className="brw-gh">{t("browser.machine.inUse")}</h3>
          {uses.length === 0 ? (
            <div className="brw-note ac-iconline" style={{ marginTop: 8 }}>
              <Icon name="globe" size={16} />
              <div>{t("browser.machine.nobody")}</div>
            </div>
          ) : (
            <div className="brw-uses">
              {uses.map(({ agent, open }) => {
                const g = agentGrammar(agent.name);
                const waiting = open?.status === "pending";
                return (
                  <div key={agent.id} className="brw-use">
                    <AgentAvatar
                      agentId={agent.id}
                      size="md"
                      name={agent.name}
                      state={waiting ? "waiting" : "thinking"}
                    />
                    <span className="brw-use__t">
                      <b>
                        {waiting
                          ? t("browser.machine.waiting", g)
                          : open
                            ? t("browser.machine.helping", g)
                            : t("browser.watch.title")}
                      </b>
                      <small>
                        {open?.kind === "ask" && <span>{open.instructions}</span>}
                        {waiting && (
                          <Chip icon="waiting" tone="waiting">
                            {t("browser.machine.waitingChip")}
                          </Chip>
                        )}
                      </small>
                    </span>
                    <span className="brw-use__acts">
                      <Button
                        size="sm"
                        icon="globe"
                        aria-expanded={seeing === agent.id}
                        onClick={() => setSeeing((v) => (v === agent.id ? null : agent.id))}
                      >
                        {t("browser.machine.see")}
                      </Button>
                      <Button size="sm" variant="ghost" icon="stop" onClick={() => setConfirming(agent.id)}>
                        {t("browser.machine.stop")}
                      </Button>
                    </span>
                    {confirming === agent.id && (
                      <div className="brw-confirm">
                        <span>{t("browser.machine.stopConfirm", g)}</span>
                        <span className="brw-grow" />
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                          {t("common.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={actions.stop.isPending}
                          onClick={() => stop(agent.id, agent.name)}
                        >
                          {t("browser.machine.stop")}
                        </Button>
                      </div>
                    )}
                    {/* "Ver": the agent's browser here, in its card (no page of its own); folding it puts it away. */}
                    {seeing === agent.id && (
                      <div className="brw-use__card">
                        <BrowserCard
                          agentId={agent.id}
                          name={agent.name}
                          handoff={open ?? null}
                          onFold={() => setSeeing(null)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {m.canManage && (
        <>
          <h3 className="brw-gh">{t("browser.machine.who")}</h3>
          <span className="small muted">{t("browser.machine.whoHelp")}</span>
          {allowed.length === 0 ? (
            <span className="small muted">{t("browser.machine.whoNone")}</span>
          ) : (
            <div className="brw-uses brw-uses--first">
              {allowed.map(({ agent, domains }) => (
                <div key={agent.id} className="brw-use">
                  <AgentAvatar agentId={agent.id} size="sm" name={agent.name} />
                  <span className="brw-use__t">
                    <b>{agent.name}</b>
                    <small>
                      {domains?.length
                        ? t("browser.machine.whoOnly", { sites: domains.join(", ") })
                        : t("browser.machine.whoAny")}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
