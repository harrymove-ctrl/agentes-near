import type { InvitationWithStatus, JoinRequest, MySuggestion, OrgRole, Person } from "@agenteschat/client";
import {
  useAllInvitations,
  useApproveJoinRequest,
  useAuthConfig,
  useCancelSuggestion,
  useDenyJoinRequest,
  useInviteLinks,
  useJoinRequests,
  useMakeInviteLink,
  useMySuggestions,
  usePeople,
  useResendInvitation,
  useRevokeInvitation,
  useRoles,
  useSetInvitationRoles,
  useSetMemberRoles,
  useSuggestPerson,
  useWorkspaceLimits,
} from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import {
  daysBetween,
  formatMonth,
  formatPercent,
  formatShortDate,
  namesText,
  relativeTime,
  timeLeft,
} from "@agenteschat/client/lib/format";
import { approvalNews, JOIN_NOTE_MAX, JOIN_REASON_MAX, sendsEmail } from "@agenteschat/client/lib/join-requests";
import { membersFull } from "@agenteschat/client/lib/limits";
import { can, makesAgents } from "@agenteschat/client/lib/permissions";
import { settingsSectionNameKey } from "@agenteschat/client/lib/personal-view";
import { grants, rolesOf } from "@agenteschat/client/lib/roles";
import { isEmail } from "@agenteschat/client/lib/text";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  FilterBar,
  FilterChip,
  GroupHeading,
  Icon,
  type IconName,
  Input,
  List,
  Locked,
  Menu,
  MenuItem,
  MenuNote,
  PageHeader,
  PlanMeter,
  SwapLabel,
  Textarea,
} from "@agenteschat/ui";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usePlanHold } from "@/components/ai/ConnectAiSteps";
import { usePersonMenu } from "@/components/entity-menus";
import { useFilterCopy } from "@/components/filters";
import { useCopied } from "@/components/invite/copied";
import { useInviteDialog } from "@/components/invite/InviteDialog";
import { MembersFull } from "@/components/Limits";
import { LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { ProfileTrigger } from "@/components/ProfileCard";
import { RolesPicker } from "@/components/roles/RolesPicker";
import { RoleChip } from "@/components/roles/RolesSection";
import { useDirectory } from "@/hooks/useDirectory";
import { copyText } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { planMeterText, usageShown } from "@/lib/plan-usage";
import { TOAST_MS, useToast } from "@/lib/toast";
import "./members.css";
import { CreateAgentLink } from "@/components/new-agent/NewAgentDialog";

/**
 * How long a cancelled invitation waits for Desfazer before it's revoked: as long as the toast that offers it stays
 * (tests shorten it).
 */
export const undoWindow = { ms: TOAST_MS };

/** "agora", "há 2 h", "ontem", "em 22 out": when something happened, to follow a verb. */
function whenWords(t: TFunction, locale: string, iso: string, now = new Date()) {
  if (daysBetween(iso, now) > 1) return t("members.when.on", { date: formatShortDate(locale, iso) });
  return relativeTime(t, locale, iso, now);
}

/**
 * A request, an invitation or a suggestion as a MediaRow: the face and who it is on one line, its actions at that line's
 * end (under everything where the list is narrow), and what it is and its state under them at the row's width.
 */
function Who({ face, name, sub, children }: { face: ReactNode; name: string; sub: ReactNode; children?: ReactNode }) {
  return (
    <>
      <span className="ac-mediarow__face">{face}</span>
      <span className="ac-mediarow__head">
        <b className="members-row__name">{name}</b>
      </span>
      <span className="ac-mediarow__body">
        <span className="members-row__line">
          {sub && <span className="small muted members-row__sub">{sub}</span>}
          {children}
        </span>
      </span>
    </>
  );
}

/** A row's state, as an icon and words ("Expira em 5 dias", "Pediu pelo link há 3 h"). */
function State({ icon, tone, children }: { icon: IconName; tone?: "soon" | "ok"; children: ReactNode }) {
  return (
    <span className="members-row__state ac-iconline" data-tone={tone}>
      <Icon name={icon} size={14} />
      <span>{children}</span>
    </span>
  );
}

/**
 * Configurações › Membros e convites (ADR 0090): whoever may invite gets "Copiar link de convite" and "Convidar
 * pessoas" (the workspace's one invite dialog) on top, then what waits on them (requests through the link and
 * members' suggestions) and the invitations they sent; a member who may not invite suggests someone. Then the people
 * and the agents.
 */
export function MembersPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const manage = can(org, "manage_members");
  const invites = can(org, "invite_people");
  const setRolesOf = useSetMemberRoles(org.id);
  const peopleQuery = usePeople(org.id);
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const month = formatMonth(i18n.language, new Date());
  const [roles, setRoles] = useState<string[]>([]);
  const personEntries = usePersonMenu();
  const navigate = useNavigate();
  const allPeople = peopleQuery.data ?? [];
  // `?request=…&do=approve|deny`: the admins' email opens that request here.
  const search = useSearch({ strict: false }) as { request?: string; do?: string };
  const filterCopy = useFilterCopy();
  const authConfig = useAuthConfig();
  // On a server that sends no email, an owner makes the link for a member who forgot their password (ADR 0158).
  const makesPasswordLinks = org.role === "owner" && authConfig.data !== undefined && !authConfig.data.passwordReset;
  const [passwordLinkFor, setPasswordLinkFor] = useState<{ userId: string; name: string } | null>(null);
  // The filter's values: `owner`, or a role's id.
  const people = allPeople.filter(
    (m) =>
      roles.length === 0 || roles.some((r) => (r === "owner" ? m.role === "owner" : (m.roleIds ?? []).includes(r))),
  );
  // A personal workspace (ADR 0159): a few people need no filter by role, and its owner's own row leaves their roles
  // out (they say nothing to them); everyone else's keep theirs, and the "+" to give one.
  const personal = isPersonal(org);

  return (
    <div className={`${embedded ? "settings__section" : "page"} members-page`}>
      <PageHeader
        level={embedded ? 2 : 1}
        title={t(settingsSectionNameKey(org, "members"))}
        meta={t(modeKey(org, "members.subtitle"), {
          count: people.length,
          people: people.length,
          agents: dir.agents.length,
          org: org.name,
        })}
        actions={invites && <InviteActions />}
      />

      <div className="ac-groups">
        {invites && <WaitingRequests focus={search.request} action={search.do} />}
        {invites && <SentInvitations />}
        {!invites && <Suggestions />}

        <section aria-labelledby="sec-people" className="section section--tight">
          <GroupHeading id="sec-people" title={t("members.people")} />
          {!personal && (
            <FilterBar
              label={t("members.filters")}
              clearText={filterCopy.clearAll}
              onClear={() => setRoles([])}
              filters={[
                {
                  key: "role",
                  active: roles.length > 0,
                  node: (
                    <FilterChip
                      label={t("members.roleFilter")}
                      icon="members"
                      multiple
                      options={[
                        { value: "owner", label: t("roles.owner") },
                        ...orgRoles.filter((r) => r.kind === "custom").map((r) => ({ value: r.id, label: r.name })),
                      ]}
                      value={roles}
                      onChange={setRoles}
                      valueText={(o) => o.label}
                      countText={(count) => t("members.rolesCount", { count })}
                      clearLabel={filterCopy.clearOf(t("members.roleFilter"))}
                    />
                  ),
                },
              ]}
            />
          )}
          {peopleQuery.isLoading && <LoadingList count={3} trailing />}
          <List>
            {people.map((m) => {
              const isMe = m.userId === me.user.id;
              const held = rolesOf(m, orgRoles);
              // The server says who is below whom; here the "+" shows when there's anything to give.
              const gives = manage && (m.role !== "owner" || org.role === "owner") && orgRoles.some((r) => r.givable);
              const ownRoles = personal && isMe && m.role === "owner";
              return (
                <div key={m.userId} className="ac-list__row members-person" {...entityMenu(() => personEntries(m))}>
                  <ProfileTrigger
                    actor={{ type: "person", id: m.userId }}
                    label={t("profile.of", { name: m.name })}
                    decorative
                  >
                    <Avatar
                      size="md"
                      name={m.name}
                      imageUrl={m.image}
                      presence={m.presence}
                      presenceLabel={t(`presence.${m.presence}`)}
                    />
                  </ProfileTrigger>
                  <span className="list-col">
                    <ProfileTrigger
                      actor={{ type: "person", id: m.userId }}
                      label={t("profile.of", { name: m.name })}
                      className="profile-trigger--name members-person__name ac-captop"
                    >
                      {m.name}
                      {isMe ? t("common.youSuffix") : ""}
                    </ProfileTrigger>
                    <span className="small muted members-person__ids">
                      {m.handle && <span>@{m.handle}</span>}
                      <span>{m.email}</span>
                    </span>
                  </span>
                  <span className="members-person__end ac-captail ac-captop">
                    <span className="small muted members-person__seen">
                      {m.online
                        ? t("members.activeNow")
                        : m.lastSeenAt
                          ? t("members.seen", { when: relativeTime(t, i18n.language, m.lastSeenAt) })
                          : t("members.joined", { when: formatShortDate(i18n.language, m.joinedAt) })}
                    </span>
                    {!isMe && (
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon="message"
                        aria-label={t("profile.messageTo", { name: m.name })}
                        title={t("profile.messageTo", { name: m.name })}
                        onClick={() =>
                          void navigate({
                            to: "/org/$orgId/dm/person/$userId",
                            params: { orgId: org.id, userId: m.userId },
                          })
                        }
                      />
                    )}
                    {!isMe && makesPasswordLinks && (
                      <Menu
                        align="end"
                        label={t("members.moreOf", { name: m.name })}
                        trigger={
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon="more"
                            aria-label={t("members.moreOf", { name: m.name })}
                          />
                        }
                      >
                        <MenuItem
                          icon="key"
                          description={t("members.passwordLink.hint")}
                          onSelect={() => setPasswordLinkFor({ userId: m.userId, name: m.name })}
                        >
                          {t("members.passwordLink.item")}
                        </MenuItem>
                      </Menu>
                    )}
                  </span>
                  {!ownRoles && (
                    <span className="members-roles">
                      {m.role === "owner" && (
                        <Chip icon="audienceOwner" title={t("roles.ownerTitle")}>
                          {t("roles.owner")}
                        </Chip>
                      )}
                      {held.map((r) => (
                        <RoleChip key={r.id} role={r} />
                      ))}
                      {gives && (
                        <RolesPicker
                          roles={orgRoles}
                          value={m.roleIds ?? []}
                          onChange={(roleIds) =>
                            setRolesOf.mutate(
                              { userId: m.userId, roleIds },
                              { onError: (e) => toast.show(errorText(t, e), "error") },
                            )
                          }
                          label={t("members.rolesOf", { name: m.name })}
                          trigger={
                            <Button
                              size="sm"
                              variant="ghost"
                              iconOnly
                              icon="plus"
                              aria-label={t("members.rolesOf", { name: m.name })}
                            />
                          }
                        />
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </List>
          <PasswordLinkDialog person={passwordLinkFor} onClose={() => setPasswordLinkFor(null)} />
        </section>

        <section aria-labelledby="sec-agents" className="section section--tight">
          <GroupHeading id="sec-agents" title={t("members.agents")} aside={makesAgents(org) && <CreateAgentLink />} />
          <List>
            {dir.agents.length === 0 && <div className="ac-list__row muted">{t("members.noAgents")}</div>}
            {dir.agents.map((a) => {
              const owner = a.ownerUserId ? dir.memberById.get(a.ownerUserId) : undefined;
              // Its plan's limits, the budget under them only once it spent through the API (ADR 0063 §5).
              const shown = usageShown(a.brain, a.budgetUsedPercent ?? 0);
              const budget = shown.budget && a.budgetUsedPercent !== undefined;
              return (
                <Link
                  key={a.id}
                  to="/org/$orgId/agents/$agentId"
                  params={{ orgId: org.id, agentId: a.id }}
                  className="ac-list__row"
                >
                  <AgentAvatar agentId={a.id} size="md" name={a.name} />
                  <span className="list-col">
                    <span style={{ fontWeight: 600 }}>
                      {a.name}
                      {a.role ? ` · ${a.role}` : ""}
                    </span>
                    <span className="small muted">
                      {owner ? t("members.ownerLine", { name: owner.name }) : t("members.noOwner")}
                    </span>
                  </span>
                  {(shown.plan || budget) && (
                    <div className="list-col" style={{ flex: "0 1 220px", gap: 4 }}>
                      {shown.plan && (
                        <PlanMeter
                          compact
                          usage={shown.plan.usage}
                          text={planMeterText(t, i18n.language)}
                          label={shown.plan.account}
                        />
                      )}
                      {budget && (
                        <span className="small muted tabular">
                          {t("members.budgetLine", {
                            percent: formatPercent(i18n.language, a.budgetUsedPercent ?? 0),
                            month,
                          })}
                        </span>
                      )}
                    </div>
                  )}
                </Link>
              );
            })}
          </List>
        </section>
      </div>
    </div>
  );
}

/**
 * Members › the person › "Make a new-password link" (ADR 0158): made when it opens, shown to copy and send where the
 * team talks. It works once, for an hour; making another ends this one.
 */
function PasswordLinkDialog({
  person,
  onClose,
}: {
  person: { userId: string; name: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { org } = useOrg();
  const [copied, copy] = useCopied();
  const make = useMutation({
    mutationFn: (userId: string) => api.orgs.passwordLink(org.id, userId),
    meta: { silent: true },
  });
  const { mutate, reset } = make;
  useEffect(() => {
    if (person) mutate(person.userId);
    else reset();
  }, [person, mutate, reset]);
  const url = make.data?.url;
  return (
    <Dialog
      open={person !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("members.passwordLink.title", { name: person?.name ?? "" })}
      description={t("members.passwordLink.lead")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogBody>
        {make.isError ? (
          <Alert>{errorText(t, make.error)}</Alert>
        ) : (
          <Field label={t("members.passwordLink.label")} id="password-link">
            <Input readOnly value={url ?? ""} placeholder={t("members.passwordLink.making")} />
          </Field>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
        <Button
          variant="primary"
          disabled={!url}
          loading={make.isPending}
          onClick={() => url && copy("password-link", url)}
        >
          <SwapLabel
            icon="copy"
            altIcon="check"
            label={t("members.passwordLink.copy")}
            alt={t("common.copied")}
            showAlt={copied !== null}
          />
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The page's own actions for whoever may invite: copy the workspace's link (made the first time, ADR 0068) and open
 * the invite dialog. In a personal workspace both ask first who is invited (ADR 0159 §4).
 */
function InviteActions() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const invite = useInviteDialog();
  const links = useInviteLinks(org.id);
  const make = useMakeInviteLink(org.id);
  const [copied, copy] = useCopied();
  // Nobody joins on a billing hold: the invite dialog says so, and a link would open on a refusal.
  const held = usePlanHold() !== null;
  const copyLink = async () => {
    const shown = links.data?.find((l) => l.url !== null)?.url;
    const url = shown ?? (await make.mutateAsync().catch(() => null))?.url;
    if (url) copy("link", url);
  };
  const copyAsked = () => {
    if (invite) invite.ask(() => void copyLink());
    else void copyLink();
  };
  return (
    <>
      {!held && (
        <Button loading={make.isPending} onClick={copyAsked}>
          <SwapLabel
            icon="link"
            altIcon="check"
            label={t("members.copyInviteLink")}
            alt={t("common.copied")}
            showAlt={copied !== null}
          />
        </Button>
      )}
      {invite && (
        <Button variant="primary" icon="plus" onClick={() => invite.open()}>
          {t("members.inviteTitle")}
        </Button>
      )}
    </>
  );
}

/**
 * Esperando você (ADR 0068, 0090): who asked through the link and whom members suggested, oldest first, each
 * approved with roles or denied with a reason. `focus` (from the admins' email): that request in view with Approve
 * focused, which the admin still presses, or its Deny dialog open.
 */
function WaitingRequests({ focus, action }: { focus?: string; action?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const list = useJoinRequests(org.id);
  const approve = useApproveJoinRequest(org.id);
  const deny = useDenyJoinRequest(org.id);
  const full = membersFull(useWorkspaceLimits(org.id).data) !== null;
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const [roles, setRoles] = useState<Record<string, string[]>>({});
  const [denying, setDenying] = useState<JoinRequest | null>(null);
  const [reason, setReason] = useState("");
  const [handOff, setHandOff] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [gone, setGone] = useState(false);
  const approveButtons = useRef(new Map<string, HTMLButtonElement>());
  const opened = useRef<string | null>(null);
  const requests = list.data ?? [];

  useEffect(() => {
    if (!focus || opened.current === focus || !list.data) return;
    opened.current = focus;
    const request = list.data.find((r) => r.id === focus);
    if (!request) return setGone(true);
    if (action === "deny") {
      setReason("");
      return setDenying(request);
    }
    const button = approveButtons.current.get(request.id);
    button?.scrollIntoView({ block: "center" });
    button?.focus();
  }, [focus, action, list.data]);

  const approveOne = (r: JoinRequest) =>
    approve.mutate(
      { id: r.id, roleIds: roles[r.id] ?? [] },
      {
        onSuccess: (result) => {
          const news = approvalNews(result);
          if ("send" in news) {
            setCopied(false);
            setHandOff({ name: r.name, url: news.send });
          } else if (news.said === "joined") toast.show(t("members.requests.joined", { name: r.name }));
          else toast.show(t("members.requests.invited", { email: r.email }));
        },
      },
    );
  const denyOne = () => {
    if (!denying) return;
    deny.mutate(
      { id: denying.id, reason: reason.trim() || undefined },
      {
        onSuccess: () => {
          toast.show(t("members.requests.denied"));
          setDenying(null);
        },
        // Any other failure keeps the dialog: the reason stays there to send again.
        onError: (e) => {
          if (errorCode(e) === "join.answered") setDenying(null);
        },
      },
    );
  };

  return (
    <>
      {gone && <Alert tone="neutral">{t("members.requests.gone")}</Alert>}
      {requests.length > 0 && (
        <section aria-label={t("members.waitingTitle")} className="section section--tight">
          <GroupHeading title={t("members.waitingTitle")} count={requests.length} />
          <MembersFull />
          <List>
            {requests.map((r) => {
              const answering =
                (approve.isPending && approve.variables?.id === r.id) ||
                (deny.isPending && deny.variables?.id === r.id);
              const when = whenWords(t, i18n.language, r.createdAt);
              const by = r.suggestedBy ?? null;
              const how = by
                ? t("members.requests.suggested", { name: by, when })
                : t("members.requests.viaLink", { when });
              return (
                // biome-ignore lint/a11y/useSemanticElements: a row of the list, named for who it is about
                <div
                  key={r.id}
                  id={`join-request-${r.id}`}
                  className="ac-list__row members-row ac-mediarow"
                  role="group"
                  aria-label={
                    by
                      ? t("members.requests.suggestedLabel", { by, name: r.name })
                      : t("members.requests.label", { name: r.name })
                  }
                >
                  <Who face={<Avatar size="md" name={r.name} />} name={r.name} sub={r.email}>
                    <State icon={by ? "person" : "link"}>{how}</State>
                    {/* Nobody proved the address: approving can't let them in at once (ADR 0072). */}
                    {!r.verified && !by && (
                      <span className="members-row__flag">
                        <Chip icon="mail">{t("members.requests.unverified")}</Chip>
                      </span>
                    )}
                  </Who>
                  <span className="ac-mediarow__end ac-mediarow__end--wrap members-row__acts">
                    <RolesPicker
                      size="sm"
                      roles={orgRoles}
                      value={roles[r.id] ?? []}
                      onChange={(ids) => setRoles((prev) => ({ ...prev, [r.id]: ids }))}
                      label={t("members.requests.roleOf", { name: r.name })}
                    />
                    <Button
                      ref={(el) => {
                        if (el) approveButtons.current.set(r.id, el);
                        else approveButtons.current.delete(r.id);
                      }}
                      size="sm"
                      variant="primary"
                      disabled={answering || full}
                      loading={approve.isPending && approve.variables?.id === r.id}
                      onClick={() => approveOne(r)}
                    >
                      {t("members.requests.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={answering}
                      onClick={() => {
                        setReason("");
                        setDenying(r);
                      }}
                    >
                      {t("members.requests.deny")}
                    </Button>
                  </span>
                  {r.note && (
                    <p className="ac-mediarow__body members-row__note">
                      {t("members.requests.note", { note: r.note })}
                    </p>
                  )}
                </div>
              );
            })}
          </List>
        </section>
      )}
      <Dialog
        open={denying !== null}
        onOpenChange={(open) => !open && setDenying(null)}
        title={t("members.requests.denyTitle", { name: denying?.name ?? "" })}
        closeLabel={t("common.close")}
        width={440}
      >
        <Locked when={deny.isPending}>
          <DialogBody>
            <Field
              label={t("members.requests.reason")}
              id="join-deny-reason"
              hint={{
                name: t("common.about", { label: t("members.requests.reason") }),
                text: t("members.requests.reasonHelp"),
              }}
            >
              <Textarea
                rows={3}
                maxLength={JOIN_REASON_MAX}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={() => setDenying(null)}>{t("common.cancel")}</Button>
          <Button variant="danger" loading={deny.isPending} onClick={denyOne}>
            {t("members.requests.deny")}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog
        open={handOff !== null}
        onOpenChange={(open) => !open && setHandOff(null)}
        title={t("members.requests.copyTitle", { name: handOff?.name ?? "" })}
        description={t("members.requests.copyText")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogBody>
          <div className="invite-link__row">
            <Input
              readOnly
              value={handOff?.url ?? ""}
              aria-label={t("members.requests.copyTitle", { name: handOff?.name ?? "" })}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button onClick={() => handOff && void copyText(handOff.url, () => setCopied(true))}>
              <SwapLabel
                icon="copy"
                altIcon="check"
                label={t("common.copy")}
                alt={t("common.copied")}
                showAlt={copied}
              />
            </Button>
          </div>
        </DialogBody>
      </Dialog>
    </>
  );
}

/**
 * What a sent invitation's toasts say: a server that sends no email sends nothing again, the same link for longer.
 * One sent before links lasted (nothing to copy) gets a new link instead, and its old one stops opening (ADR 0090).
 */
const SENT_WORDS = {
  email: { copied: "copied", resent: "resent", renewed: "renewed", newLink: "newLink" },
  link: { copied: "copiedNoEmail", resent: "resentNoEmail", renewed: "renewedNoEmail", newLink: "newLinkNoEmail" },
} as const;

/** Pending first, then expired; the newest first in each. */
const byNewest = (a: InvitationWithStatus, b: InvitationWithStatus) =>
  (a.status === "expired" ? 1 : 0) - (b.status === "expired" ? 1 : 0) || b.createdAt.localeCompare(a.createdAt);

/** The names of an invitation's roles ("Admin, Financeiro"), or "Membro" with none. */
function roleWords(t: TFunction, ids: readonly string[] | undefined, roles: readonly OrgRole[]) {
  const names = roles.filter((r) => (ids ?? []).includes(r.id)).map((r) => r.name);
  return names.length ? names.join(", ") : t("roles.member");
}

/**
 * Convites enviados (ADR 0090): every invitation not accepted yet, with its link to copy at any time (the same as
 * the email's), Reenviar (the same link, 7 more days: its menu says a link that leaked stops only by cancelling), its
 * role to change and Cancelar with Desfazer; an expired one is renewed or taken off the list.
 */
function SentInvitations() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const invite = useInviteDialog();
  const list = useAllInvitations(org.id);
  const resend = useResendInvitation(org.id);
  const revoke = useRevokeInvitation(org.id);
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const [copied, copy] = useCopied();
  // Cancelled ones wait for Desfazer out of sight; each one's timer revokes it.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Sent again from here: until when it works now.
  const [resent, setResent] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<InvitationWithStatus | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const shown = (list.data ?? []).filter((i) => !hidden.has(i.id)).sort(byNewest);
  const date = (iso: string) => formatShortDate(i18n.language, iso);
  const words = SENT_WORDS[sendsEmail(useAuthConfig().data) ? "email" : "link"];

  const unhide = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const takeOff = (inv: InvitationWithStatus, said: "cancelled" | "dropped") => {
    setHidden((prev) => new Set(prev).add(inv.id));
    // It still goes when this page is left meanwhile: the toast offering Desfazer outlives it.
    const timer = setTimeout(() => {
      timers.current.delete(inv.id);
      revoke.mutate(inv.id, { onError: () => unhide(inv.id) });
    }, undoWindow.ms);
    timers.current.set(inv.id, timer);
    toast.show(t(`members.invitations.${said}`, { email: inv.email }), "info", {
      label: t("members.undo"),
      run: () => {
        const pending = timers.current.get(inv.id);
        if (!pending) return;
        clearTimeout(pending);
        timers.current.delete(inv.id);
        unhide(inv.id);
      },
    });
  };
  /**
   * Sends it again with the same link (ADR 0090), or a lasting one for an invitation sent before links lasted:
   * `renewing` an expired one, or reminding them of a pending one.
   */
  const sendAgain = (inv: InvitationWithStatus, renewing: boolean) =>
    resend.mutate(inv.id, {
      onSuccess: (res) => {
        setResent((prev) => ({ ...prev, [inv.id]: res.expiresAt }));
        const said = !inv.url ? words.newLink : renewing ? words.renewed : words.resent;
        toast.show(t(`members.invitations.${said}`, { email: inv.email, date: date(res.expiresAt) }));
      },
    });

  return (
    <section aria-labelledby="sec-sent" className="section section--tight">
      <GroupHeading id="sec-sent" title={t("members.invitations.title")} />
      {list.isLoading && <LoadingList count={2} trailing />}
      <List>
        {list.isSuccess && shown.length === 0 && (
          <div className="ac-list__row muted members-empty">
            <span>{t("members.invitations.empty")}</span>
            {invite && (
              <Button variant="ghost" size="sm" onClick={() => invite.open()}>
                {t("members.inviteTitle")}
              </Button>
            )}
          </div>
        )}
        {shown.map((inv) => {
          const left = timeLeft(t, inv.expiresAt);
          // Past its date it no longer opens, whatever the list said when it loaded.
          const off = inv.status === "expired" || !left;
          const again = resent[inv.id];
          const soon = !off && new Date(inv.expiresAt).getTime() - Date.now() < 2 * 86_400_000;
          const who =
            inv.invitedBy && inv.invitedBy === me.user.name
              ? t("members.invitations.mine")
              : inv.invitedBy
                ? t("members.invitations.by", { name: inv.invitedBy })
                : null;
          const sent = whenWords(t, i18n.language, inv.createdAt);
          const sub = [
            inv.role === "owner" ? t("roles.owner") : roleWords(t, inv.roleIds, orgRoles),
            who,
            off ? t("members.invitations.sentWhen", { when: sent }) : sent,
          ]
            .filter(Boolean)
            .join(" · ");
          const sending = resend.isPending && resend.variables === inv.id;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a row of the list, named for whom it invites
            <div
              key={inv.id}
              className="ac-list__row members-row ac-mediarow"
              data-off={off || undefined}
              role="group"
              aria-label={t("members.invitations.label", { email: inv.email })}
            >
              <Who
                face={<Avatar size="md" name={inv.email} initials={inv.email.slice(0, 2).toUpperCase()} />}
                name={inv.email}
                sub={sub}
              >
                {again && !off ? (
                  <State icon="check" tone="ok">
                    {t("members.invitations.resentState", { date: date(again) })}
                  </State>
                ) : off ? (
                  <State icon="clock">
                    {t("members.invitations.expired", { when: whenWords(t, i18n.language, inv.expiresAt) })}
                  </State>
                ) : (
                  <State icon="clock" tone={soon ? "soon" : undefined}>
                    {t("members.invitations.expires", { left })}
                  </State>
                )}
              </Who>
              <span className="ac-mediarow__end ac-mediarow__end--wrap members-row__acts ac-acts">
                {off ? (
                  <>
                    <Button size="sm" icon="refresh" loading={sending} onClick={() => sendAgain(inv, true)}>
                      {t("members.invitations.renew")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => takeOff(inv, "dropped")}>
                      {t("members.invitations.drop")}
                    </Button>
                  </>
                ) : (
                  <>
                    {inv.url && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          copy(inv.id, inv.url ?? "", t(`members.invitations.${words.copied}`, { email: inv.email }))
                        }
                      >
                        <SwapLabel
                          icon="copy"
                          altIcon="check"
                          label={t("members.copyLink")}
                          alt={t("common.copied")}
                          showAlt={copied === inv.id}
                        />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="send"
                      disabled={!!again}
                      loading={sending}
                      onClick={() => sendAgain(inv, false)}
                    >
                      {t("members.resend")}
                    </Button>
                    <Menu
                      align="end"
                      label={t("members.invitations.more", { email: inv.email })}
                      trigger={
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          icon="more"
                          aria-label={t("members.invitations.more", { email: inv.email })}
                        />
                      }
                    >
                      <MenuItem
                        icon="shield"
                        onSelect={() => {
                          setEditing(inv);
                          setEditOpen(true);
                        }}
                      >
                        {t("members.invitations.changeRole")}
                      </MenuItem>
                      <MenuItem icon="trash" danger onSelect={() => takeOff(inv, "cancelled")}>
                        {t("members.invitations.cancel")}
                      </MenuItem>
                      {/* Sending again keeps a lasting link: one that reached the wrong person stops only here. */}
                      {inv.url && <MenuNote>{t("members.invitations.linkStays")}</MenuNote>}
                    </Menu>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </List>
      {editing && (
        <InvitationRoles key={editing.id} invitation={editing} open={editOpen} onClose={() => setEditOpen(false)} />
      )}
    </section>
  );
}

/** "Mudar o papel": the roles a pending invitation gives, changed without sending it (the same link, ADR 0090). */
function InvitationRoles({
  invitation,
  open,
  onClose,
}: {
  invitation: InvitationWithStatus;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const save = useSetInvitationRoles(org.id);
  const [value, setValue] = useState<string[]>(invitation.roleIds ?? []);
  const title = t("members.invitations.roleTitle", { email: invitation.email });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={t("members.invitations.roleText")}
      closeLabel={t("common.close")}
      width={440}
    >
      <Locked when={save.isPending}>
        <DialogBody>
          <RolesPicker roles={orgRoles} value={value} onChange={setValue} label={title} />
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() =>
            save.mutate(
              { id: invitation.id, roleIds: value },
              {
                onSuccess: () => {
                  toast.show(
                    t("members.invitations.roleSaved", {
                      email: invitation.email,
                      roles: roleWords(t, value, orgRoles),
                    }),
                  );
                  onClose();
                },
              },
            )
          }
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The people who may invite here (ADR 0085): the owners, and whoever holds a role that gives it. */
function invitersOf(people: readonly Person[], roles: readonly OrgRole[]) {
  return people
    .filter((p) => p.role === "owner" || rolesOf(p, roles).some((r) => grants(r.permissions).has("invite_people")))
    .map((p) => p.name);
}

/** What a suggestion's refusal says, about the person suggested (the server's codes, ADR 0090 §7). */
const SUGGEST_REFUSALS: Record<string, "member" | "invited" | "waiting" | "full" | "invalid" | undefined> = {
  "join.member": "member",
  "join.invited": "invited",
  "join.waiting": "waiting",
  "join.full": "full",
  "join.invalid_email": "invalid",
};

/**
 * A member who may not invite (ADR 0090 §7): a card to suggest someone, which reaches the people who invite as a
 * request, and the suggestions still waiting, each to take back.
 */
function Suggestions() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const people = usePeople(org.id).data ?? [];
  const orgRoles = useRoles(org.id).data?.roles ?? [];
  const mine = useMySuggestions(org.id);
  const cancel = useCancelSuggestion(org.id);
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(0);
  const inviters = invitersOf(people, orgRoles);
  const names = namesText(t, inviters, 2);
  const waiting = mine.data ?? [];
  return (
    <>
      <Card aria-labelledby="suggest-title">
        <CardHeader
          id="suggest-title"
          icon="person"
          title={t("members.suggest.title", { org: org.name })}
          subtitle={
            inviters.length
              ? t("members.suggest.lead", { count: inviters.length, names })
              : t("members.suggest.leadNoNames")
          }
        />
        <div className="ac-acts">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setN((x) => x + 1);
              setOpen(true);
            }}
          >
            {t("members.suggest.button")}
          </Button>
        </div>
      </Card>
      {waiting.length > 0 && (
        <section aria-labelledby="sec-mine" className="section section--tight">
          <GroupHeading id="sec-mine" title={t("members.suggest.mine")} />
          <List>
            {waiting.map((s: MySuggestion) => (
              // biome-ignore lint/a11y/useSemanticElements: a row of the list, named for whom it suggests
              <div
                key={s.id}
                className="ac-list__row members-row ac-mediarow"
                role="group"
                aria-label={t("members.suggest.label", { email: s.email })}
              >
                <Who
                  face={<Avatar size="md" name={s.email} initials={s.email.slice(0, 2).toUpperCase()} />}
                  name={s.email}
                  sub={s.note ?? ""}
                >
                  <State icon="clock">
                    {t("members.suggest.waiting", { when: whenWords(t, i18n.language, s.createdAt) })}
                  </State>
                </Who>
                <span className="ac-mediarow__end ac-mediarow__end--wrap members-row__acts ac-acts">
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={cancel.isPending && cancel.variables === s.id}
                    aria-label={t("members.suggest.cancelOf", { email: s.email })}
                    onClick={() => cancel.mutate(s.id, { onSuccess: () => toast.show(t("members.suggest.cancelled")) })}
                  >
                    {t("common.cancel")}
                  </Button>
                </span>
              </div>
            ))}
          </List>
        </section>
      )}
      <SuggestDialog key={n} open={open} onClose={() => setOpen(false)} inviters={inviters} />
    </>
  );
}

/** "Sugerir pessoa": an address and, if they like, who it is; refusals said under the address, in our words. */
function SuggestDialog({ open, onClose, inviters }: { open: boolean; onClose: () => void; inviters: string[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const suggest = useSuggestPerson(org.id);
  // Where no email goes out, whoever approves hands the person the link instead.
  const emails = sendsEmail(useAuthConfig().data);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const address = email.trim().toLowerCase();
    if (!isEmail(address)) return setError(t("members.suggest.refused.invalid"));
    setError(null);
    suggest.mutate(
      { email: address, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          toast.show(
            inviters.length
              ? t("members.suggest.sent", { count: inviters.length, names: namesText(t, inviters, 2) })
              : t("members.suggest.sentNoNames"),
          );
          onClose();
        },
        onError: (e) => {
          const refusal = SUGGEST_REFUSALS[errorCode(e) ?? ""];
          setError(
            refusal ? t(`members.suggest.refused.${refusal}`, { email: address, org: org.name }) : errorText(t, e),
          );
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("members.suggest.dialogTitle", { org: org.name })}
      description={emails ? t("members.suggest.dialogText") : t("members.suggest.dialogTextNoEmail")}
      closeLabel={t("common.close")}
      width={480}
    >
      <Locked when={suggest.isPending}>
        <DialogBody>
          <Field label={t("members.suggest.email")} id="suggest-email" error={error}>
            <Input
              type="email"
              autoComplete="off"
              value={email}
              placeholder={t("members.emailsPlaceholder")}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submit();
              }}
            />
          </Field>
          <Field
            id="suggest-note"
            label={
              <>
                {t("members.suggest.who")} <span className="invite-optional">{t("members.dialog.optional")}</span>
              </>
            }
          >
            <Textarea
              rows={2}
              maxLength={JOIN_NOTE_MAX}
              value={note}
              placeholder={t("members.suggest.whoPlaceholder")}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={suggest.isPending} onClick={submit}>
          {t("members.suggest.send")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
