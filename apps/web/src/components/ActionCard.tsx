import type { AgentDraft, AgentProposalCard, Message, SkillSourceUpdate } from "@agenteschat/client";
import {
  useAiStatus,
  useAllInvitations,
  useAskAgentProposal,
  useCatalog,
  useChannels,
  useConnections,
  useCreateProposedAgent,
  useCreateProposedRoutine,
  useCustomServers,
  useDenyAgentProposal,
  useMailAccounts,
  useMembers,
  useRoles,
  useSkillAction,
  useSkills,
  useSkillUsage,
} from "@agenteschat/client";
import {
  actionCardOf,
  type ConnectAppCard,
  connectAiDone,
  connectAppDone,
  type InstallSkillCard,
  type InviteCard,
  installSkillDone,
  inviteDone,
  type ProposalLine,
  proposalLines,
  proposalStatus,
  routineLeft,
  skillUpdateState,
  suggestedAiText,
  type UpdateSkillsCard,
} from "@agenteschat/client/lib/action-cards";
import { delegateUndoLine } from "@agenteschat/client/lib/approval-words";
import { connectedItems, itemName } from "@agenteschat/client/lib/connected";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, whenAt } from "@agenteschat/client/lib/format";
import { hostOf } from "@agenteschat/client/lib/import/shared";
import { choiceOf } from "@agenteschat/client/lib/mail";
import { can } from "@agenteschat/client/lib/permissions";
import { sentToText } from "@agenteschat/client/lib/proposals";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { holdersOf } from "@agenteschat/client/lib/roles";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { SKILL_UPDATE_TOAST } from "@agenteschat/client/lib/skills";
import { Button, Dialog, EventPillAction, Icon, Spinner } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnectedById } from "@/components/AccessLevels";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOpenAgentPanel } from "@/components/agent-panel-context";
import { useConnectAi } from "@/components/ConnectAi";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorCatalog";
import { CostlyProposalCardView } from "@/components/CostlyProposalCard";
import { CalendarProposalCardView } from "@/components/calendar/ProposalCard";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { MailIcon } from "@/components/MailConnect";
import { useOrg } from "@/components/org-context";
import { PersonLimitCardView } from "@/components/PeopleUsage";
import { RequestCard, RequestDone, RequestFuse, RequestOpen, useExpired } from "@/components/RequestCard";
import {
  ApprovalsCardView,
  MemberChangesCardView,
  OpenPageCardView,
  SettingsProposalCardView,
  WorkspaceActionCardView,
} from "@/components/RightHandCards";
import { DelegateNote, DelegateUndo, useDelegateLine } from "@/components/RightHandDelegate";
import { InstallSkillDialog, SkillSheet } from "@/components/Skills";
import { StretchCardView } from "@/components/StretchCard";
import { TeamPlanCardView } from "@/components/TeamPlan";
import { TeamWeekCardView } from "@/components/TeamWeekCard";
import { TextAction, UsagePauseCardView } from "@/components/UsagePauseCard";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";
import { inlineWords } from "@/lib/markdown";
import { inPlaceClick } from "@/lib/navigate";
import { proposedRoutineWhen } from "@/lib/recurrence";
import { STORAGE_KEYS, sessionStore } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import { expiryText } from "@/pages/ApprovalsPage";

/** The whole time a proposal has (a day when its message doesn't say): the fuse burns down over it. */
const DAY_MS = 24 * 3_600_000;

/** "Criar agente" in the card's review, loaded when it opens. */
const NewAgentPage = lazy(() => import("@/pages/NewAgentPage").then((m) => ({ default: m.NewAgentPage })));

/**
 * An agent's action card (ADR 0061, `meta.actionCard`) in place of its text: what needs a person's credentials or
 * consent, one click away, as a waiting pill (`RequestOpen`) that turns into a decided one (`RequestDone`). "Connect
 * an AI" waits for the viewer with "Connect", which opens the Connect dialog at the card's step for the agents it names
 * (the dialog says what each person may do), its why under it; "Connected" once they can think. A proposal of a new
 * agent (ADR 0081) is a request card while it is open (`AgentProposalCardView`); a stretch's pause with "Continue"
 * (ADR 0089) is its own pill.
 */
export function ActionCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const status = useAiStatus(org.id);
  const connect = useConnectAi();
  const card = actionCardOf(message.meta);
  if (!card) return null;
  if (card.kind === "agent_proposal")
    return (
      <AgentProposalCardView
        messageId={message.id}
        proposerId={message.author.id}
        sentAt={message.createdAt}
        card={card}
      />
    );
  if (card.kind === "team_proposal") return <TeamPlanCardView message={message} card={card} />;
  if (card.kind === "settings_proposal") return <SettingsProposalCardView message={message} card={card} />;
  if (card.kind === "approvals") return <ApprovalsCardView message={message} card={card} />;
  if (card.kind === "member_changes") return <MemberChangesCardView message={message} card={card} />;
  if (card.kind === "open_page") return <OpenPageCardView card={card} />;
  if (card.kind === "workspace_action")
    return (
      <WorkspaceActionCardView
        where={{ messageId: message.id, channelId: message.channelId }}
        agentId={message.author.id ?? null}
        card={card}
        actions={message.actions}
      />
    );
  if (card.kind === "stretch_paused") return <StretchCardView message={message} card={card} />;
  if (card.kind === "usage_paused") return <UsagePauseCardView message={message} card={card} />;
  if (card.kind === "person_limit") return <PersonLimitCardView message={message} card={card} />;
  if (card.kind === "connect_app") return <ConnectAppCardView card={card} />;
  if (card.kind === "invite_people") return <InviteCardView card={card} />;
  if (card.kind === "install_skill") return <InstallSkillCardView card={card} agentId={message.author.id} />;
  if (card.kind === "update_skills") return <UpdateSkillsCardView message={message} card={card} />;
  if (card.kind === "autonomy_proposal") return <CostlyProposalCardView message={message} card={card} />;
  if (card.kind === "team_week") return <TeamWeekCardView message={message} card={card} />;
  if (card.kind === "calendar_proposal") return <CalendarProposalCardView message={message} card={card} />;
  const done = connectAiDone(card, status.data, dir.agentById);
  const agents = joinNames(
    card.agentIds.map((id) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent")),
    t,
  );
  const title = agents
    ? t("actionCard.connect_ai.title", { context: card.what, agents })
    : t(`connectAi.title.${card.what ?? "any"}`);
  if (done) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.connected")}: <b>{title}</b>
      </RequestDone>
    );
  }
  // The dialog says what each person may connect: Connect is everyone's.
  return (
    <RequestOpen
      mine={connect !== null}
      icon="plug"
      label={title}
      action={
        connect ? (
          <EventPillAction
            primary
            onClick={() =>
              connect.open({
                intent: card.what,
                provider: card.provider,
                agentIds: card.agentIds,
                agentId: card.agentIds[0],
              })
            }
          >
            {t("actionCard.connect")}
          </EventPillAction>
        ) : undefined
      }
      below={card.why ? <p>{inlineWords(card.why)}</p> : undefined}
    >
      {title}
    </RequestOpen>
  );
}

/**
 * "Connect Linear" / "Add MCP" (`offer_connect_app`) as a waiting pill: "Connect" opens the same connect dialog as
 * Settings, at the catalog entry or at connecting by address with the address filled in; the person signs in or types
 * the key there. Its why and address go under it, and who may not connect reads who does there. Done once the
 * workspace has it.
 */
function ConnectAppCardView({ card }: { card: ConnectAppCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const catalog = useCatalog();
  const connections = useConnections(org.id);
  const servers = useCustomServers(org.id);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const defs = catalog.data?.connectors ?? [];
  const def = defs.find((d) => d.id === card.connector) ?? null;
  const name = def ? connectorName(t, def) : card.url ? hostOf(card.url) : "";
  const title = name ? t("actionCard.connect_app.title", { name }) : t("actionCard.connect_app.mcp");
  if (connectAppDone(card, connectedItems(connections.data ?? [], servers.data ?? [], defs))) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.connected")}: <b>{title}</b>
      </RequestDone>
    );
  }
  const may = can(org, "manage_connectors");
  return (
    <>
      <RequestOpen
        mine={may}
        icon="plug"
        label={title}
        action={
          may ? (
            <EventPillAction
              primary
              onClick={() => setFlow(def ? { step: 0, def } : { step: 0, def: null, url: card.url })}
            >
              {t("actionCard.connect")}
            </EventPillAction>
          ) : undefined
        }
        below={
          card.why || card.url || !may ? (
            <>
              {card.why && <p>{inlineWords(card.why)}</p>}
              {card.url && (
                <p>
                  <code>{card.url}</code>
                </p>
              )}
              {!may && <p>{t("actionCard.connect_app.adminOnly")}</p>}
            </>
          ) : undefined
        }
      >
        {title}
      </RequestOpen>
      <ConnectFlow flow={flow} onChange={setFlow} onClose={() => setFlow(null)} />
    </>
  );
}

/**
 * "Install a skill" (`offer_install_skill`) as a waiting pill, its why and link under it: "Install" opens Install
 * skill with the link read, its skills listed to pick; who manages agents installs there, and its box turns what
 * installs on for the agent that posted the card (`agentId`). Done once the library has a skill from that link.
 */
function InstallSkillCardView({ card, agentId }: { card: InstallSkillCard; agentId?: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const may = can(org, "manage_agents");
  const skills = useSkills(org.id);
  const [open, setOpen] = useState(false);
  const title = t("actionCard.install_skill.title");
  if (installSkillDone(card, skills.data ?? [])) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.install_skill.done")}: <b>{card.url}</b>
      </RequestDone>
    );
  }
  return (
    <>
      <RequestOpen
        mine={may}
        icon="book"
        label={title}
        action={
          may ? (
            <EventPillAction
              primary
              onClick={() => {
                // Kept for the way back from connecting GitHub on its site (SkillsSection).
                if (agentId) sessionStore.set(STORAGE_KEYS.skillInstallFor, JSON.stringify({ url: card.url, agentId }));
                setOpen(true);
              }}
            >
              {t("actionCard.install_skill.open")}
            </EventPillAction>
          ) : undefined
        }
        below={
          <>
            {card.why && <p>{inlineWords(card.why)}</p>}
            <p>
              <code>{card.url}</code>
            </p>
            {!may && <p>{t("actionCard.install_skill.adminOnly")}</p>}
          </>
        }
      >
        {title}
      </RequestOpen>
      {may && (
        <InstallSkillDialog
          open={open}
          onOpenChange={setOpen}
          onInstalled={() => {}}
          initialUrl={open ? card.url : undefined}
          forAgentId={agentId ?? undefined}
        />
      )}
    </>
  );
}

/**
 * "Update skills" (`update_skill_from_source`) as a waiting pill, each skill a line under it with where it stands.
 * "Update" reads its link (new text applies, files that run wait); "Review" opens the skill, where its waiting update
 * is applied or refused. Done once every one was read after the card and nothing waits.
 */
function UpdateSkillsCardView({ message, card }: { message: Message; card: UpdateSkillsCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const may = can(org, "manage_agents");
  const skills = useSkills(org.id, true);
  const action = useSkillAction(org.id);
  const [open, setOpen] = useState<string | null>(null);
  const usage = useSkillUsage(org.id, open !== null);
  const rows = card.skillIds.map((id) => {
    const skill = skills.data?.find((s) => s.id === id);
    return { id, name: skill?.name ?? "", state: skillUpdateState(skill, message.createdAt) };
  });
  const title = t("actionCard.update_skills.title", { count: rows.length });
  if (skills.data && rows.every((r) => r.state === "done")) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.update_skills.done")}:{" "}
        <b>
          {rows
            .map((r) => r.name)
            .filter(Boolean)
            .join(", ")}
        </b>
      </RequestDone>
    );
  }
  const update = (r: (typeof rows)[number]) =>
    action.mutate(
      { type: "updateFromSource", id: r.id },
      { onSuccess: (u) => toast.show(t(SKILL_UPDATE_TOAST[(u as SkillSourceUpdate).status], { name: r.name })) },
    );
  const named = rows.filter((r) => r.name);
  return (
    <>
      <RequestOpen
        mine={may}
        icon="book"
        label={title}
        below={
          <>
            {card.why && <p>{inlineWords(card.why)}</p>}
            {/* A skill a line, each with its own action ("Update", "Review"): the pill's sentence covers them all. */}
            <ul className="waitcard__lines">
              {named.map((r) => (
                <li key={r.id} className="ac-iconline">
                  <Icon name={r.state === "done" ? "check" : "book"} size={14} />
                  <span>
                    <b>{r.name}</b>
                    {r.state === "done" ? (
                      <> · {t("actionCard.update_skills.done")}</>
                    ) : !may ? (
                      r.state === "waiting" && <> · {t("actionCard.update_skills.waiting")}</>
                    ) : (
                      <>
                        {" · "}
                        {r.state === "waiting" ? (
                          <TextAction onClick={() => setOpen(r.id)}>{t("actionCard.update_skills.review")}</TextAction>
                        ) : (
                          <TextAction pending={action.isPending} onClick={() => update(r)}>
                            {t("actionCard.update_skills.update")}
                          </TextAction>
                        )}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            {!may && <p>{t("actionCard.update_skills.adminOnly")}</p>}
          </>
        }
      >
        {title}
      </RequestOpen>
      {open && <SkillSheet id={open} users={usage.get(open) ?? []} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * "Invite people" (`offer_invites`) as a waiting pill, its why and addresses under it: "Invite" opens the workspace's
 * invite dialog with the addresses filled in, as members; the person sends it there. Done once each address is
 * invited or a member.
 */
function InviteCardView({ card }: { card: InviteCard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const invite = useInviteDialog();
  const mayInvite = can(org, "invite_people");
  const invitations = useAllInvitations(org.id, mayInvite);
  const members = useMembers(org.id);
  const title = t("actionCard.invite.title", { count: card.emails.length });
  const known = [
    ...(invitations.data ?? []).filter((i) => i.status === "pending").map((i) => i.email),
    ...(members.data ?? []).map((m) => m.email),
  ];
  if (inviteDone(card, known)) {
    return (
      <RequestDone done label={title}>
        {t("actionCard.invite.done")}: <b>{card.emails.join(", ")}</b>
      </RequestDone>
    );
  }
  return (
    <RequestOpen
      mine={mayInvite && invite !== null}
      icon="personAdd"
      label={title}
      action={
        mayInvite && invite ? (
          <EventPillAction primary onClick={() => invite.open({ emails: card.emails })}>
            {t("actionCard.invite.open")}
          </EventPillAction>
        ) : undefined
      }
      below={
        <>
          {card.why && <p>{inlineWords(card.why)}</p>}
          <p>{card.emails.join(", ")}</p>
          {!(mayInvite && invite) && <p>{t("actionCard.invite.adminOnly")}</p>}
        </>
      }
    >
      {title}
    </RequestOpen>
  );
}

/**
 * "Ada propõe um novo agente". While it is open, a request card like every other: the agent's reason, the draft in the
 * well (its face, name, handle and role, and the AI it would think with where the line has room), what it gets a line
 * each, and the fuse to its expiry. Criar makes it as it is, in one click, with each line the person may give; Revisar
 * opens "Criar agente" filled in with it over the conversation; Recusar says no; all three for who may create agents.
 * Then one line says what was decided, the draft and what it got behind "Ver detalhes"; created, it links to the agent
 * there.
 *
 * The right hand's (ADR 0137) reads Criar e testar when it comes with a first task (created, the task goes from the
 * clicker in their DM with it, which opens), Editar antes and Descartar; a newer one for the same agent greys it out;
 * and a person who can't create agents sends it to whoever may (Pedir a um admin), then reads whom it went to. In
 * their inbox it is the same card (`ChangeRequestCard`).
 */
export function AgentProposalCardView({
  messageId,
  proposerId,
  sentAt,
  card,
}: {
  messageId: string;
  proposerId: string | null;
  /** When the card was posted: the fuse burns from it to the expiry. */
  sentAt: string;
  card: AgentProposalCard;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const ask = useAskAgentProposal(org.id);
  const members = useMembers(org.id).data ?? [];
  const roles = useRoles(org.id).data?.roles ?? [];
  const create = useCreateProposedAgent(org.id);
  const makeRoutine = useCreateProposedRoutine(org.id);
  const connect = useConnectAi();
  const [reviewing, setReviewing] = useState(false);
  const deny = useDenyAgentProposal(org.id);
  const toast = useToast();
  const openPanel = useOpenAgentPanel();
  const { draft, why } = card.params;
  const status = proposalStatus(card);
  // The right hand looked at it for the person it is for (ADR 0139): its line, Desfazer and "Por quê?".
  const delegate = card.delegate;
  const delegated = useDelegateLine(delegate);
  // Open until it expires: drawn again at that moment, even before the server's event says so.
  useExpired(status === "open" ? card.expiresAt : null);
  const decides = status === "open" && can(org, "create_agents");
  const agent = proposerId ? dir.anyAgent(proposerId) : undefined;
  const rightHand = isRightHand(agent);
  // The person it is for, who can't create agents: they send it on (the right hand's cards only).
  const asks = status === "open" && rightHand && !decides && card.forUserId === me.user.id;
  const proposer = agent?.name || t("channel.unknownAgent");
  const title = t("actionCard.agentProposal.title", { agent: proposer });
  const lines = proposalLines(card, { userId: me.user.id, admin: can(org, "manage_agents") });
  const failed = (error: unknown) => toast.show(errorText(t, error), "error");
  const busy = create.isPending || deny.isPending;
  // Only for the person it was written for: anyone else (an admin from the inbox) gets the plain Criar.
  const firstTask = rightHand && card.forUserId === me.user.id ? card.params.firstTask : undefined;
  const test = Boolean(firstTask);
  const sent =
    asks && card.askedAt
      ? sentToText(
          t,
          i18n.language,
          holdersOf(members, roles, "create_agents").map((m) => m.name),
          card.askedAt,
        )
      : null;
  if (status === "superseded") {
    return (
      <RequestCard
        id={messageId}
        kind="agent"
        agent={agent}
        label={title}
        mine={false}
        muted
        waitingFor={t("rightHand.card.superseded")}
        lead={why || title}
        object={{
          logo: <AgentAvatar name={draft.name} appearance={lookOf(draft)} size="md" />,
          title: draft.name,
          detail: [`@${draft.handle}`, draft.role, suggestedAiText(t, draft.ai)].filter(Boolean).join(" · "),
        }}
        what={draft.name}
      />
    );
  }
  if (status === "open") {
    const end = Date.parse(card.expiresAt);
    const span = Math.max(1, end - Date.parse(sentAt) || DAY_MS);
    return (
      <>
        <RequestCard
          id={messageId}
          kind="agent"
          agent={agent}
          label={title}
          mine={decides}
          waitingFor={t(asks && !card.askedAt ? "rightHand.card.onlyCreators" : "proposals.waitingAdmin")}
          lead={why || title}
          object={{
            logo: <AgentAvatar name={draft.name} appearance={lookOf(draft)} size="md" />,
            title: draft.name,
            // The AI comes last: where the line runs out, it is what gives way.
            detail: [`@${draft.handle}`, draft.role, suggestedAiText(t, draft.ai)].filter(Boolean).join(" · "),
          }}
          body={
            delegated || lines.length > 0 ? (
              <>
                <DelegateNote d={delegate} />
                {lines.length > 0 && <ProposalLines lines={lines} draft={draft} />}
              </>
            ) : undefined
          }
          actions={
            decides ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  loading={create.isPending}
                  disabled={deny.isPending}
                  icon={test ? "bolt" : undefined}
                  onClick={() =>
                    create.mutate(
                      { messageId, test },
                      {
                        // Nothing to think with yet (the clicker's accounts decide, not the suggestion): it is
                        // created all the same, and Connect opens for it. Tried: its DM, the task in the composer.
                        onSuccess: ({ agent: made, ai, testChannelId }) => {
                          if (ai === "none") connect?.open({ agentId: made.id, agentIds: [made.id] });
                          else if (testChannelId) {
                            if (firstTask) setDraftFor(`agent:${made.id}`, firstTask);
                            void navigate({
                              to: "/org/$orgId/dm/agent/$agentId",
                              params: { orgId: org.id, agentId: made.id },
                            });
                          }
                        },
                        onError: failed,
                      },
                    )
                  }
                >
                  {test ? t("rightHand.card.createTest") : t("newAgent.create", { name: draft.name })}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => setReviewing(true)}>
                  {t(rightHand ? "rightHand.card.editFirst" : "actionCard.agentProposal.review")}
                </Button>
                <Button
                  size="sm"
                  variant={rightHand ? "ghost" : undefined}
                  loading={deny.isPending}
                  disabled={create.isPending}
                  onClick={() => deny.mutate(messageId, { onError: failed })}
                >
                  {t(rightHand ? "rightHand.card.dismiss" : "approval.refuse")}
                </Button>
              </>
            ) : sent ? (
              <span className="rq__sent ac-iconline">
                <Icon name="arrowUp" size={14} />
                <span>{sent}</span>
              </span>
            ) : asks ? (
              <Button
                size="sm"
                variant="primary"
                icon="arrowUp"
                loading={ask.isPending}
                onClick={() => ask.mutate(messageId, { onError: failed })}
              >
                {t("rightHand.card.askAdmin")}
              </Button>
            ) : undefined
          }
          end={<RequestFuse left={Math.max(0, end - Date.now()) / span} agent={agent} text={expiryText(t, card)} />}
          what={draft.name}
          locked={busy || ask.isPending}
        />
        {reviewing && (
          // Over the conversation: creating, saying no or leaving closes it, and the person is where they were.
          <Dialog
            bare
            open
            onOpenChange={(open) => !open && setReviewing(false)}
            title={t("actionCard.agentProposal.reviewTitle", { name: draft.name })}
            closeLabel={t("common.close")}
            width={1200}
            className="newag-dialog"
          >
            <Suspense fallback={<Spinner />}>
              <NewAgentPage proposalId={messageId} onClose={() => setReviewing(false)} />
            </Suspense>
          </Dialog>
        )}
      </>
    );
  }
  // Created, refused or expired: one line. No one decided one that ran out: it expired at its deadline.
  const byRightHand =
    status === "created" && delegated && (delegate?.state === "approved" || delegate?.state === "undone");
  const ended =
    status === "created"
      ? t("actionCard.agentProposal.created")
      : t(status === "denied" ? "proposals.refused" : "approval.expired");
  const at = status === "expired" ? card.expiresAt : card.decidedAt;
  const details = (
    <>
      <span className="ac-faceline">
        <AgentAvatar name={draft.name} appearance={lookOf(draft)} size="md" />
        <span className="list-col">
          <b className="ac-captop">{draft.name}</b>{" "}
          <span className="small muted">{[`@${draft.handle}`, draft.role].filter(Boolean).join(" · ")}</span>
        </span>
      </span>
      {byRightHand && delegate?.reason ? <p>{inlineWords(delegate.reason)}</p> : why && <p>{inlineWords(why)}</p>}
      {lines.length > 0 && <ProposalLines lines={lines} draft={draft} />}
      {byRightHand && delegate?.state === "approved" ? (
        <span className="small muted ac-iconline">
          <Icon name="clock" size={14} />
          <span>{delegateUndoLine(t, i18n.language, delegate, draft.name)}</span>
        </span>
      ) : (
        <span className="small muted ac-iconline">
          <Icon name="bolt" size={14} />
          <span>{suggestedAiText(t, draft.ai)}</span>
        </span>
      )}
      {status === "created" && (card.agentId || routineLeft(card)) && (
        <div className="ac-acts">
          {card.agentId && (
            <Button asChild size="sm" variant="ghost">
              {/* In a conversation, its page opens in the panel beside it. */}
              <Link
                to="/org/$orgId/agents/$agentId"
                params={{ orgId: org.id, agentId: card.agentId }}
                onClick={openPanel ? (e) => inPlaceClick(e, () => card.agentId && openPanel(card.agentId)) : undefined}
              >
                {t("newAgent.openProfile")}
              </Link>
            </Button>
          )}
          {routineLeft(card) && (card.decidedByUserId === me.user.id || can(org, "manage_routines")) && (
            // Not made with it (the agent wasn't where it reports yet): made from here once it is.
            <Button
              size="sm"
              variant="ghost"
              loading={makeRoutine.isPending}
              onClick={() => makeRoutine.mutate(messageId, { onError: failed })}
            >
              {t("newAgent.routineKeep", { name: draft.routine?.name })}
            </Button>
          )}
        </div>
      )}
    </>
  );
  if (byRightHand)
    return (
      <RequestDone
        done={delegate?.state === "approved"}
        label={title}
        action={<DelegateUndo d={delegate} />}
        more={{
          label: t(delegate?.state === "approved" ? "rightHandApprovals.card.why" : "approval.seeDetails"),
          content: details,
        }}
        time={delegate?.at ? whenAt(t, i18n.language, delegate.at) : undefined}
      >
        <b>{draft.name}</b> · {delegated}
      </RequestDone>
    );
  return (
    <RequestDone
      done={status === "created"}
      label={title}
      more={{ label: t("approval.seeDetails"), content: details }}
      time={at ? whenAt(t, i18n.language, at) : undefined}
    >
      {ended}: <b>{draft.name}</b>
    </RequestDone>
  );
}

/**
 * What the proposed agent gets, a line each: its channels, its apps and mailboxes at their level, its routine. A line
 * the viewer can't give says who gives it; created in one click, the lines it got take a check.
 */
function ProposalLines({ lines, draft }: { lines: ProposalLine[]; draft: AgentDraft }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const channels = useChannels(org.id);
  const apps = useConnectedById();
  const mail = useMailAccounts(org.id);
  const says = (level: "read" | "write" | undefined, name: string) =>
    t(level === "write" ? "newAgent.preview.readsWrites" : "newAgent.preview.reads", { name });
  const shown = (l: ProposalLine): { icon: ReactNode; text: string } => {
    if (l.kind === "channel") {
      const name = channels.data?.find((c) => c.id === l.id)?.name;
      return {
        icon: <Icon name="channel" size={14} />,
        text: name ?? t("actionCard.agentProposal.aChannel"),
      };
    }
    if (l.kind === "app") {
      const item = apps.get(l.id);
      const name = item ? itemName(t, item) : t("actionCard.agentProposal.anApp");
      return {
        icon: item ? <ConnectorIcon def={item.def} image={item.image} label={name} /> : <Icon name="plug" size={14} />,
        text: says(l.level, name),
      };
    }
    if (l.kind === "mail") {
      const box = draft.mail?.find((m) => m.accountId === l.id);
      const account = mail.data?.find((a) => a.id === l.id);
      return {
        icon: account ? <MailIcon choice={choiceOf(account)} /> : <Icon name="mail" size={14} />,
        text: says(l.level, box?.address ?? ""),
      };
    }
    const routine = draft.routine;
    return {
      icon: <Icon name="routines" size={14} />,
      text: routine ? [routine.name, proposedRoutineWhen(t, i18n.language, routine)].join(" · ") : l.id,
    };
  };
  const needs = (l: ProposalLine) =>
    !l.needs
      ? null
      : l.needs.who === "admin"
        ? t("actionCard.agentProposal.needsAdmin")
        : t("actionCard.agentProposal.needsPerson", {
            name: dir.memberById.get(l.needs.userId)?.name ?? t("actionCard.agentProposal.itsOwner"),
          });
  return (
    <ul className="waitcard__lines" aria-label={t("actionCard.agentProposal.lines", { name: draft.name })}>
      {lines.map((l) => {
        const { icon, text } = shown(l);
        const who = needs(l);
        return (
          <li key={l.key} className="ac-iconline" data-given={l.given ?? undefined}>
            {l.given ? <Icon name="check" size={14} /> : icon}
            <span>
              {text}
              {who && <span className="waitcard__needs"> · {who}</span>}
              {l.kind === "routine" && l.given === false && (
                <span className="waitcard__needs"> · {t("actionCard.agentProposal.routineNotMade")}</span>
              )}
              {l.kind === "routine" && draft.routine && (
                <details className="waitcard__prompt">
                  <summary className="small muted">{t("routines.form.what")}</summary>
                  <p className="small">{draft.routine.prompt}</p>
                </details>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
