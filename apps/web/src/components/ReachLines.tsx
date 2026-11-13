import {
  type Agent,
  type AgentAudience,
  type ForeignMailbox,
  type Message,
  useAddChannelMember,
  useChannels,
  useWidenAudience,
} from "@agenteschat/client";
import {
  audienceWith,
  audienceWithMe,
  canEditAudience,
  modeOf,
  opensOthersPlan,
  widenQuestion,
} from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { type ReachEntry, reachKey, reachOf, reachOpens } from "@agenteschat/client/lib/reach";
import { joinsChannels } from "@agenteschat/client/lib/right-hand";
import { Button, Dialog, DialogFooter, Icon } from "@agenteschat/ui";
import { type SyntheticEvent, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { ConsultPairRow, useConsultById } from "@/components/ConsultGroup";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./agent-actions.css";

/**
 * Under an agent's message, every agent it @named that its mention didn't wake (`meta.reach`), so nothing is silent:
 * one outside the conversation got it by direct message (the two agents' pair row, opening their conversation; who
 * manages channels may add it), or wasn't forwarded from a private one, one it couldn't call says why, and the agent's owner
 * can let that person talk to it. The team actions' rows (agent-actions.css).
 */
export function ReachLines({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channel = useChannels(org.id).data?.find((c) => c.id === message.channelId);
  const list = reachOf(message.meta);
  if (message.author.type !== "agent" || list.length === 0) return null;
  // A DM isn't in the channel list: "in this conversation", and nobody can be added to it.
  const place = channel ? t("reach.inChannel", { name: channel.name }) : t("reach.inHere");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset
    <div className="ag-rcs ag-rcs--stack" role="group" aria-label={t("reach.group")}>
      {list.map((e) => (
        <ReachRow
          key={e.agentId}
          entry={e}
          authorId={message.author.id ?? ""}
          channelId={message.channelId}
          place={place}
          addable={!!channel}
        />
      ))}
    </div>
  );
}

function ReachRow({
  entry: e,
  authorId,
  channelId,
  place,
  addable,
}: {
  entry: ReachEntry;
  /** The agent whose message @named it. */
  authorId: string;
  channelId: string;
  place: string;
  addable: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const add = useAddChannelMember(org.id);
  const agent = dir.agentById.get(e.agentId);
  const g = agentGrammar(agent?.name ?? `@${e.handle}`);
  const values = { ...g, place };
  const handed = Boolean(e.consultationId);
  const talk = useConsultById(channelId, reachOpens(e) ? e.consultationId : undefined);
  const detail = [
    !handed && e.outside ? t("reach.outside", { place }) : null,
    e.routine ? t("reach.routine", { name: e.routine.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // The right hand joins no channel, and an @mention reaches it in any of them.
  const addButton = ((handed && e.reason === "not_in_channel") || e.private) &&
    addable &&
    (!agent || joinsChannels(agent)) &&
    can(org, "manage_channels") && (
      <button
        type="button"
        className="ag-rc__btn"
        disabled={add.isPending || add.isSuccess}
        onClick={() =>
          add.mutate(
            { channelId, member: { agentId: e.agentId } },
            { onSuccess: () => toast.show(t("reach.added", { name: g.name })) },
          )
        }
      >
        {t("reach.add")}
      </button>
    );
  // Handed to it by direct message: the two agents talking, as the pair row that opens their conversation.
  if (talk)
    return (
      <div className="ag-rc--talk">
        <ConsultPairRow askerId={authorId} items={[talk]} />
        {addButton}
      </div>
    );
  return (
    <div className="ag-rc">
      <span className="ag-rc__ic" aria-hidden="true">
        <Icon name={handed ? "agent" : "info"} size={16} />
      </span>
      <span className="ac-actline">
        <span className="ag-rc__tx">
          <span className="ag-rc__sentence">
            <Trans i18nKey={reachKey(e) as "reach.handed"} values={values} components={{ b: <b /> }} />
          </span>
          {detail && <span className="ag-rc__by">{detail}</span>}
        </span>
        {(addButton || (!handed && agent && e.userId)) && (
          <span className="ac-acts">
            {addButton}
            {!handed && agent && e.userId && <AllowTalkButton agent={agent} userId={e.userId} className="ag-rc__btn" />}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * "Deixar Ana falar com ele": lets `userId` talk to the agent, for its owner and who manages agents, when its
 * audience keeps them out (a routine's creator it couldn't reach). Nothing otherwise.
 */
export function AllowTalkButton({ agent, userId, className }: { agent: Agent; userId: string; className?: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const save = useWidenAudience(org.id, agent.id);
  const asks = useWidenAsk(agent);
  const person = dir.memberById.get(userId)?.name;
  const audience = audienceWith(agent, userId);
  if (!person || !audience || modeOf(agent) === "everyone" || !canEditAudience(org, agent, me.user.id)) return null;
  const g = agentGrammar(agent.name);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={save.busy || save.done}
        onClick={(ev) => {
          ev.stopPropagation();
          save.widen(audience, asks.ask(audience), () => toast.show(t("reach.allowed", { person, name: g.name })));
        }}
      >
        {t("reach.allow", { person, context: g.context })}
      </button>
      {asks.dialog}
    </>
  );
}

/**
 * "Quero falar com ele": who manages agents (or owns it) lets themselves into an agent that keeps them out. Nothing
 * when it answers them already. On someone else's plan it asks first (`useWidenAsk`).
 */
export function LetMeTalkButton({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const save = useWidenAudience(org.id, agent.id);
  const asks = useWidenAsk(agent);
  const audience = audienceWithMe(org, agent, me.user.id);
  if (!audience) return null;
  const g = agentGrammar(agent.name);
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        icon="message"
        disabled={save.busy || save.done}
        onClick={() => save.widen(audience, asks.ask(audience), () => toast.show(t("reach.allowedMe", g)))}
      >
        {t("reach.allowMe", g)}
      </Button>
      {asks.dialog}
    </>
  );
}

/**
 * The one question before a wider audience (`widenQuestion`): on someone else's plan, that it uses their plan and
 * they get an email, and the mailboxes other people gave the agent that it loses. `ask(next)` answers whether to go
 * on, at once when there is nothing to ask. Every save that widens an agent's audience goes through it.
 */
export function useWidenAsk(agent: Agent) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const [asking, setAsking] = useState<{
    question: { title: string; description: string };
    answer: (yes: boolean) => void;
  } | null>(null);
  /** Asks `question` (none: yes at once). */
  const confirm = (question: { title: string; description: string } | null): Promise<boolean> =>
    question ? new Promise((answer) => setAsking({ question, answer })) : Promise.resolve(true);
  const ask =
    (next: AgentAudience) =>
    (mailboxes: ForeignMailbox[]): Promise<boolean> => {
      const owner = opensOthersPlan(agent, next, me.user.id)
        ? (dir.memberById.get(agent.ownerUserId ?? "")?.name ?? t("channel.unknownPerson"))
        : null;
      return confirm(widenQuestion(t, agent, owner, mailboxes));
    };
  const answer = (yes: boolean) => {
    asking?.answer(yes);
    setAsking(null);
  };
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const dialog = asking && (
    // biome-ignore lint/a11y/noStaticElementInteractions: the dialog's clicks and keys bubble through React to the row around the button (an inbox row opens on click)
    <span onClick={stop} onKeyDown={stop}>
      <Dialog
        open
        onOpenChange={(open) => !open && answer(false)}
        title={asking.question.title}
        description={asking.question.description}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button type="button" onClick={() => answer(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            {t("common.continue")}
          </Button>
        </DialogFooter>
      </Dialog>
    </span>
  );
  return { ask, confirm, dialog };
}
