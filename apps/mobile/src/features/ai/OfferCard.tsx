import {
  type Message,
  useAgents,
  useAllInvitations,
  useApprovals,
  useCalendarProposal,
  useCatalog,
  useChannels,
  useConnections,
  useCustomServers,
  useMembers,
  useSkills,
} from "@agenteschat/client";
import {
  actionCardOf,
  connectAppDone,
  installSkillDone,
  inviteDone,
  memberRowDone,
  skillUpdateState,
} from "@agenteschat/client/lib/action-cards";
import { APP_PAGES, appPagePath } from "@agenteschat/client/lib/app-pages";
import { slotText } from "@agenteschat/client/lib/calendar";
import { connectedItems } from "@agenteschat/client/lib/connected";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { hostOf } from "@agenteschat/client/lib/import/shared";
import { can } from "@agenteschat/client/lib/permissions";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useOrg } from "@/providers/org";
import { EventPillAction, EventPillText, type IconName, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { AskDone, AskWaiting } from "../chat/asks";
import { openWebPath } from "../links/open-web";
import { openedFromCard } from "../settings/install-from-card";
import { useDirectory, useMeId } from "../shared/hooks";
import { PersonLimitNote } from "../usage/people";

/**
 * The web's cards to connect an app or an MCP server (`offer_connect_app`) and to invite people (`offer_invites`) in
 * place of their text, as waiting pills: the tinted action opens the app's own screen, filled in (Conectores at the
 * service or at connecting by address with the address typed in; Convidar pessoas with the addresses), the agent's why
 * and the address under the pill. Done from live data, a decided request's pill.
 * The right hand's approvals, people and "Abrir" cards (ADR 0137 §4) open the matching screen here (an approval, the
 * members), or the page on the website where the phone has none.
 */
export function OfferCard({ message: m }: { message: Message }) {
  const card = actionCardOf(m.meta);
  if (m.author.type !== "agent" || !card) return null;
  if (card.kind === "connect_app") return <ConnectApp card={card} />;
  if (card.kind === "invite_people") return <Invite card={card} />;
  if (card.kind === "install_skill") return <InstallSkill card={card} agentId={m.author.id} />;
  if (card.kind === "update_skills") return <UpdateSkills card={card} postedAt={m.createdAt} />;
  if (card.kind === "approvals") return <Approvals card={card} />;
  if (card.kind === "member_changes") return <People card={card} />;
  if (card.kind === "open_page") return <OpenScreen card={card} />;
  if (card.kind === "person_limit") return <PersonLimitNote card={card} />;
  if (card.kind === "calendar_proposal") return <CalendarProposalOffer message={m} card={card} />;
  return null;
}

type Card = NonNullable<ReturnType<typeof actionCardOf>>;

function ConnectApp({ card }: { card: Extract<Card, { kind: "connect_app" }> }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const catalog = useCatalog();
  const connections = useConnections(orgId);
  const servers = useCustomServers(orgId);
  const defs = catalog.data?.connectors ?? [];
  const def = defs.find((d) => d.id === card.connector);
  const name = def ? connectorName(t, def) : card.url ? hostOf(card.url) : "";
  const title = name ? t("actionCard.connect_app.title", { name }) : t("actionCard.connect_app.mcp");
  const done = connectAppDone(card, connectedItems(connections.data ?? [], servers.data ?? [], defs));
  const query = def ? `connect=${encodeURIComponent(def.id)}` : `mcp=${encodeURIComponent(card.url ?? "")}`;
  return (
    <Shell
      icon="globe"
      title={title}
      why={card.why}
      detail={card.url}
      done={done ? `${t("actionCard.connected")}: ${title}` : null}
      action={can(org, "manage_connectors") ? t("actionCard.connect") : null}
      onAction={() => router.push(`/connectors?${query}` as never)}
      blocked={t("actionCard.connect_app.adminOnly")}
    />
  );
}

function Invite({ card }: { card: Extract<Card, { kind: "invite_people" }> }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const may = can(org, "invite_people");
  const invitations = useAllInvitations(orgId, may);
  const members = useMembers(orgId);
  const known = [
    ...(invitations.data ?? []).filter((i) => i.status === "pending").map((i) => i.email),
    ...(members.data ?? []).map((p) => p.email),
  ];
  const emails = card.emails.join(", ");
  return (
    <Shell
      icon="person"
      title={t("actionCard.invite.title", { count: card.emails.length })}
      why={card.why}
      detail={emails}
      done={inviteDone(card, known) ? `${t("actionCard.invite.done")}: ${emails}` : null}
      action={may ? t("actionCard.invite.open") : null}
      onAction={() => router.push(`/invite-people?emails=${encodeURIComponent(card.emails.join(","))}` as never)}
      blocked={t("actionCard.invite.adminOnly")}
    />
  );
}

/** Its screen's check row turns what installs on for the agent that posted the card (`agentId`), as on the web. */
function InstallSkill({ card, agentId }: { card: Extract<Card, { kind: "install_skill" }>; agentId: string | null }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const may = can(org, "manage_agents");
  const skills = useSkills(orgId);
  return (
    <Shell
      icon="brain"
      title={t("actionCard.install_skill.title")}
      why={card.why}
      detail={card.url}
      done={installSkillDone(card, skills.data ?? []) ? `${t("actionCard.install_skill.done")}: ${card.url}` : null}
      action={may ? t("actionCard.install_skill.open") : null}
      onAction={() => {
        if (agentId) openedFromCard({ url: card.url, agentId });
        router.push(
          `/settings/skills/new?url=${encodeURIComponent(card.url)}${agentId ? `&agent=${encodeURIComponent(agentId)}` : ""}` as never,
        );
      }}
      blocked={t("actionCard.install_skill.adminOnly")}
    />
  );
}

/** The web's update card: the skills by name, Revisar opening the first one not done (its waiting update first). */
function UpdateSkills({ card, postedAt }: { card: Extract<Card, { kind: "update_skills" }>; postedAt: string }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const skills = useSkills(orgId, true);
  const rows = card.skillIds.map((id) => {
    const skill = skills.data?.find((s) => s.id === id);
    return { id, name: skill?.name ?? "", state: skillUpdateState(skill, postedAt) };
  });
  const next = rows.find((r) => r.state === "waiting") ?? rows.find((r) => r.state === "open");
  const names = rows
    .map((r) => r.name)
    .filter(Boolean)
    .join(", ");
  return (
    <Shell
      icon="brain"
      title={t("actionCard.update_skills.title", { count: rows.length })}
      why={card.why}
      detail={names}
      done={skills.data && !next ? `${t("actionCard.update_skills.done")}: ${names}` : null}
      action={can(org, "manage_agents") ? t("actionCard.update_skills.review") : null}
      onAction={() => router.push(`/settings/skills/${next?.id ?? ""}` as never)}
      blocked={t("actionCard.update_skills.adminOnly")}
    />
  );
}

function Approvals({ card }: { card: Extract<Card, { kind: "approvals" }> }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const approvals = useApprovals(orgId);
  const rows = card.approvalIds.map((id) => approvals.data?.find((a) => a.id === id));
  const next = rows.find((a) => a?.status === "pending");
  const titles = rows
    .map((a) => a?.title)
    .filter(Boolean)
    .join(", ");
  return (
    <Shell
      icon="shield"
      title={t("rightHand.approvals.title")}
      why={card.why}
      detail={titles}
      done={approvals.isSuccess && !next ? `${t("rightHand.approvals.done")}: ${titles}` : null}
      action={next ? t("rightHand.open.open") : null}
      onAction={() => router.push(`/approval/${next?.id ?? ""}` as never)}
      blocked=""
    />
  );
}

function People({ card }: { card: Extract<Card, { kind: "member_changes" }> }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const members = useMembers(orgId);
  const names = [...new Set(card.rows.map((r) => r.name))].join(", ");
  const done = members.isSuccess && card.rows.every((r) => memberRowDone(r, members.data));
  return (
    <Shell
      icon="members"
      title={t("rightHand.people.title")}
      why={card.why}
      detail={names}
      done={done ? `${t("rightHand.people.done")}: ${names}` : null}
      action={t("rightHand.open.open")}
      onAction={() => router.push("/me/members" as never)}
      blocked=""
    />
  );
}

function OpenScreen({ card }: { card: Extract<Card, { kind: "open_page" }> }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const agents = useAgents(orgId);
  const channels = useChannels(orgId);
  const page = APP_PAGES[card.page];
  const title =
    card.page === "agent"
      ? (agents.data?.find((a) => a.id === card.agentId)?.name ?? "")
      : card.page === "channel"
        ? `#${channels.data?.find((c) => c.id === card.channelId)?.name ?? ""}`
        : t(page.label as never);
  const here = appPagePath(page.phone, card);
  const web = appPagePath(page.web, card);
  const allowed = !page.may || can(org, page.may);
  return (
    <Shell
      icon="out"
      title={title}
      why={card.why}
      done={null}
      action={allowed && (here || web) ? t(here ? "rightHand.open.open" : "rightHand.open.web") : null}
      onAction={() => (here ? router.push(here as never) : openWebPath(`/org/${orgId}${web ?? ""}`))}
      blocked={t("rightHand.open.notAllowed")}
    />
  );
}

/**
 * An agent's event proposal, as the web's card: who asked (or who configures the workspace) confirms it here, which
 * creates the event and invites the people, or asks for another time; anyone else reads who confirms it.
 */
function CalendarProposalOffer({
  message,
  card,
}: {
  message: Message;
  card: Extract<Card, { kind: "calendar_proposal" }>;
}) {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const meId = useMeId();
  const dir = useDirectory();
  const toast = useToast();
  const decide = useCalendarProposal(orgId, { channelId: message.channelId, messageId: message.id });
  const p = card.proposal;
  if (p.status !== "pending") {
    const how = t(p.status === "confirmed" ? "calendar.confirmed" : "calendar.proposalDismissed");
    return (
      <View>
        <AskDone done={p.status === "confirmed"} words={`${p.title} · ${how}`} />
      </View>
    );
  }
  const mine = p.requesterUserId === meId || can(org, "configure");
  const run = (decision: "confirm" | "dismiss") =>
    decide.mutate(
      { proposal: p, decision },
      { onError: (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }) },
    );
  const requester = p.requesterUserId ? dir.nameOf({ type: "person", id: p.requesterUserId }) : "";
  return (
    <AskWaiting
      forMe={mine}
      mark="clock"
      words={p.title}
      actions={
        mine ? (
          <>
            <EventPillAction
              primary
              label={t("calendar.confirm")}
              disabled={decide.isPending}
              onPress={() => run("confirm")}
            />
            <EventPillAction
              label={t("calendar.otherTime")}
              disabled={decide.isPending}
              onPress={() => run("dismiss")}
            />
          </>
        ) : null
      }
      below={
        <EventPillText>
          <Text variant="footnote">
            {t("calendar.proposalDetail", {
              when: slotText(i18n.language, p.start, p.end),
              people: joinNames(
                p.participants.map((a) => dir.nameOf(a)),
                t,
              ),
            })}
          </Text>
          {p.note ? (
            <Text variant="footnote" tone="muted">
              {p.note}
            </Text>
          ) : null}
          {!mine && requester ? (
            <Text variant="footnote" tone="muted">
              {t("calendar.proposalWaits", { name: requester })}
            </Text>
          ) : null}
        </EventPillText>
      }
    />
  );
}

/**
 * One offer as a waiting pill: its title, the action (tinted) for who may take it, else who may in the text under it;
 * the agent's why and the detail (an address, names) under the pill too. Done, a decided request's pill.
 */
function Shell({
  icon,
  title,
  why,
  detail,
  done,
  action,
  onAction,
  blocked,
}: {
  icon: IconName;
  title: string;
  why: string;
  detail?: string;
  done: string | null;
  action: string | null;
  onAction: () => void;
  blocked: string;
}) {
  if (done) {
    return (
      <View>
        <AskDone done words={done} />
      </View>
    );
  }
  const note = action ? null : blocked;
  return (
    <AskWaiting
      forMe={action !== null}
      mark={icon}
      words={title}
      actions={action ? <EventPillAction key="act" primary label={action} onPress={onAction} /> : null}
      below={
        why || detail || note ? (
          <EventPillText>
            {why ? <Text variant="footnote">{why}</Text> : null}
            {detail ? (
              <Text variant="footnote" tone="muted">
                {detail}
              </Text>
            ) : null}
            {note ? (
              <Text variant="footnote" tone="muted">
                {note}
              </Text>
            ) : null}
          </EventPillText>
        ) : null
      }
    />
  );
}
