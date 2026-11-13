import type { BrowserHandoff } from "@agenteschat/client";
import {
  drivesOnDesktop,
  HANDOFF_OVER,
  handoffFuse,
  handoffIsMine,
  handoffScreen,
  handoffTimeLeft,
  isWaitingHandoff,
  keys,
  useApi,
  useBrowserHandoffMutations,
  useDesktopStatus,
} from "@agenteschat/client";
import { formatTime, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { inlineWords } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { AgentAvatar } from "../AgentAvatar";
import { useOpenComputer } from "../computer/open";
import { useOrg } from "../org-context";
import { RequestCard, RequestFuse, RequestTile, useExpired } from "../RequestCard";
import { BrowserCard } from "./BrowserCard";
import { useBrowserCardRequest } from "./open";
import "./browser.css";

/** The newest view of a request: what the cache heard (an action, the realtime event), else the card's meta. */
export function useCurrentHandoff(orgId: string, handoff: BrowserHandoff) {
  const api = useApi();
  // Listens to the cache entry without fetching: the card's meta is where it starts.
  const query = useQuery({
    queryKey: keys.browserHandoff(orgId, handoff.id),
    queryFn: () => api.browser.handoff(orgId, handoff.id),
    enabled: false,
    placeholderData: handoff,
  });
  return query.data ?? handoff;
}

/**
 * An agent asks a person for help in its browser (`browser_ask_person`,
 * ADR 0040 §6) or on its desktop (`desktop_ask_person`, ADR 0058): the
 * request, the time left, "Abrir" to the live view; who is helping; and how
 * it ended. While it waits, the same request card as every other ask.
 */
export function BrowserHandoffCard({ handoff }: { handoff: BrowserHandoff }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const current = useCurrentHandoff(org.id, handoff);
  const actions = useBrowserHandoffMutations(org.id);
  const agent = dir.agentById.get(current.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const g = agentGrammar(name);
  // It stops waiting the moment it expires, even before the server's event says so.
  const expired = useExpired(current.status === "pending" ? current.expiresAt : null);
  const waiting = !expired && isWaitingHandoff(current);
  const active = current.status === "active";
  // The time left moves on.
  useNow(waiting ? 15_000 : false);
  const mineInControl = active && current.controllerUserId === me.user.id;
  const helper = current.controllerUserId ? dir.memberById.get(current.controllerUserId)?.name : undefined;
  const people = [current.requestedForUserId, agent?.ownerUserId ?? null]
    .filter((id, i, all): id is string => Boolean(id) && all.indexOf(id) === i)
    .map((id) => (id === me.user.id ? null : dir.memberById.get(id)?.name))
    .filter(Boolean) as string[];
  const settled = !waiting && !active;
  const status = current.status === "pending" ? "expired" : current.status;
  const left = handoffTimeLeft(t, current);
  const onDesktop = handoffScreen(current) === "desktop";
  // The window of a browser request on the agent's screen, for someone who may drive that screen: they help there.
  const desktop = useDesktopStatus(org.id, current.agentId, { enabled: !onDesktop && (waiting || active) });
  const opensDesktop = drivesOnDesktop(current, desktop.data);
  // The agent's browser opens right here, under the request; on its screen, in the computer dialog.
  const [here, setHere] = useState(false);
  const openComputer = useOpenComputer();
  const show = () => (opensDesktop ? openComputer(current.agentId) : setHere(true));
  const take = () =>
    actions.takeControl.mutate(current.id, {
      onSuccess: show,
      onError: (err) => {
        // It ended meanwhile: the card says so itself (`useBrowserHandoffMutations` reads it again).
        if ((err as { code?: string }).code === HANDOFF_OVER) return;
        toast.show(
          (err as { status?: number }).status === 409 ? t("browser.card.busy") : t("browser.card.openFailed"),
          "error",
        );
      },
    });
  // A notification asked for this request: take it (or show it, when it's already mine).
  const asked = useBrowserCardRequest({ handoffId: current.id });
  const latest = useRef({ take, waiting, show });
  latest.current = { take, waiting, show };
  useEffect(() => {
    if (asked === null) return;
    if (latest.current.waiting) latest.current.take();
    else latest.current.show();
  }, [asked]);
  const showBrowser = !opensDesktop && ((here && (waiting || active)) || mineInControl);
  const time = current.resolvedAt ? formatTime(i18n.language, current.resolvedAt) : "";
  const screenIcon = onDesktop ? "computer" : "globe";
  const groupLabel = onDesktop ? t("desktop.card.group", g) : t("browser.card.group", g);
  // Waiting: a request card like every other. "Ver a tela" shows the agent's browser under it (its desktop, in
  // the computer dialog); "Abrir aqui" takes control as before.
  if (waiting) {
    const asked = current.requestedForUserId;
    // Its buttons only for whom it waits on (the server checks again when they open it).
    const mine = handoffIsMine(current, me.user.id, agent?.ownerUserId, org);
    const askedName = asked ? dir.memberById.get(asked)?.name : undefined;
    return (
      <>
        <RequestCard
          id={current.id}
          kind={onDesktop ? "desktop" : "browser"}
          agent={agent}
          label={groupLabel}
          mine={mine}
          waitingFor={askedName ? t("ask.waitingFor", { name: askedName }) : undefined}
          lead={current.instructions}
          object={{
            logo: (
              <RequestTile>
                <Icon name={screenIcon} size={16} />
              </RequestTile>
            ),
            title: onDesktop ? t("desktop.card.where", g) : t("browser.card.where", g),
            detail: agent?.handle ? `@${agent.handle}` : undefined,
            more: t("ask.seeScreen"),
          }}
          open={!opensDesktop && showBrowser}
          onOpenChange={(open) => (opensDesktop ? openComputer(current.agentId) : setHere(open))}
          actions={
            mine ? (
              <Button
                variant="primary"
                size="sm"
                icon={screenIcon}
                loading={actions.takeControl.isPending}
                onClick={take}
                title={t("browser.inCard.openHereHint")}
              >
                {t("browser.inCard.openHere")}
              </Button>
            ) : undefined
          }
          end={
            <RequestFuse
              left={handoffFuse(current)}
              agent={agent}
              text={left !== null ? t("browser.card.left", { time: left }) : null}
            />
          }
          what={current.instructions}
        />
        {showBrowser && (
          <BrowserCard agentId={current.agentId} name={name} handoff={current} onSettled={() => setHere(false)} />
        )}
      </>
    );
  }
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset */}
      <div className={settled ? "brw-rq brw-rq--settled" : "brw-rq"} role="group" aria-label={groupLabel}>
        <span className="brw-rq__face">
          <AgentAvatar
            agentId={current.agentId}
            size="md"
            state={waiting ? "waiting" : active ? "thinking" : "idle"}
            name={name}
          />
        </span>
        <div className="brw-rq__meta">
          <b>{name}</b>
          {settled ? (
            <span>
              {t(
                status === "done"
                  ? "browser.card.settledDone"
                  : status === "failed"
                    ? "browser.card.settledFailed"
                    : status === "cancelled"
                      ? "browser.card.settledCancelled"
                      : status === "withdrawn"
                        ? "browser.card.settledWithdrawn"
                        : "browser.card.settledExpired",
              )}
            </span>
          ) : (
            <span>
              {people.length > 0
                ? t("browser.card.asked", { people: joinNames(people, t) })
                : t("browser.card.askedShort")}
            </span>
          )}
          <span className="brw-grow" />
          {active && (
            <>
              <Icon name="person" size={14} />
              <span>
                {mineInControl ? t("browser.card.helpingYou") : t("browser.card.helping", { name: helper ?? "" })}
              </span>
            </>
          )}
        </div>
        <p className="brw-rq__title">{current.instructions}</p>
        <div className="brw-rq__body">
          <div className="brw-exact">
            <span className="brw-exact__ic">
              <Icon name={screenIcon} size={16} />
            </span>
            <span className="brw-exact__t">
              <b>{onDesktop ? t("desktop.card.where", g) : t("browser.card.where", g)}</b>
              {agent?.handle && <small>@{agent.handle}</small>}
            </span>
          </div>
          {status === "done" && settled && (
            <div className="brw-rq__res brw-rq__res--ok">
              <Icon name="check" size={16} />
              {current.controllerUserId === me.user.id
                ? t(onDesktop ? "desktop.card.doneByYou" : "browser.card.doneByYou", { time, ...g, agent: name })
                : t(onDesktop ? "desktop.card.doneBy" : "browser.card.doneBy", {
                    ...g,
                    time,
                    agent: name,
                    name: helper ?? "",
                  })}
            </div>
          )}
          {status === "failed" && settled && (
            <>
              <div className="brw-rq__res">
                <Icon name="close" size={16} />
                {t("browser.card.failed")}
              </div>
              {current.note && <div className="brw-rq__why">“{inlineWords(current.note)}”</div>}
            </>
          )}
          {status === "expired" && settled && (
            <div className="brw-rq__res">
              <Icon name="clock" size={16} />
              {t("browser.card.expired", g)}
            </div>
          )}
          {status === "cancelled" && settled && (
            <div className="brw-rq__res">
              <Icon name="close" size={16} />
              {t("browser.card.cancelled")}
            </div>
          )}
          {status === "withdrawn" && settled && (
            <div className="brw-rq__res">
              <Icon name="check" size={16} />
              {t("browser.card.withdrawn", g)}
            </div>
          )}
          {active && !showBrowser && (
            <div className="brw-rq__acts">
              <Button icon={screenIcon} onClick={show}>
                {opensDesktop && mineInControl ? t("agentComputer.open") : t("browser.card.watch")}
              </Button>
            </div>
          )}
          {showBrowser && (
            <div className="brw-rq__res">
              <Icon name="person" size={16} />
              {mineInControl
                ? t("browser.inCard.helpingHere")
                : t("browser.inCard.helpingOther", { person: helper ?? "" })}
            </div>
          )}
        </div>
      </div>
      {showBrowser && (
        <BrowserCard agentId={current.agentId} name={name} handoff={current} onSettled={() => setHere(false)} />
      )}
    </>
  );
}
