import type { Artifact, ArtifactSharing } from "@agenteschat/client";
import { keys, useRoles, useSetArtifactSharing } from "@agenteschat/client";
import {
  CONVERSATION_ONLY,
  isPrivateArtifact,
  onlyItsConversation,
  toggledSharing,
} from "@agenteschat/client/lib/drive";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames } from "@agenteschat/client/lib/format";
import { rolePicksInSight } from "@agenteschat/client/lib/personal-view";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  Locked,
  OptionCard,
  RoleMark,
  SearchSelect,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { copyText } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { artifactLink, useAuthorName } from "./ArtifactViewer";
import "../who-sees.css";

type Mode = ArtifactSharing["mode"];

const MODES: { mode: Mode; icon: IconName }[] = [
  { mode: "conversation", icon: "lock" },
  { mode: "people", icon: "personAdd" },
  { mode: "everyone", icon: "audienceEveryone" },
];

const SAVED = {
  conversation: "share.savedConversation",
  people: "share.savedPeople",
  everyone: "share.savedEveryone",
} as const satisfies Record<Mode, string>;

/**
 * Compartilhar, for any file (ADR 0157), and Copiar link: a link copies at once when everyone it may reach opens it;
 * one only a private conversation sees opens the dialog, which says so beside its own Copiar link.
 */
export function useFileShare() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const [target, setTarget] = useState<Artifact | null>(null);
  return {
    open: (a: Artifact) => setTarget(a),
    copyLink: (a: Artifact, version?: number) => {
      if (onlyItsConversation(a)) setTarget(a);
      else
        void copyText(artifactLink(window.location.origin, org.id, a.id, version), () => toast.show(t("share.copied")));
    },
    dialog: target ? <ShareDialog key={target.id} artifact={target} onClose={() => setTarget(null)} /> : null,
  };
}

/**
 * The share dialog, Google Drive style: the file's name, who sees it with who has access, changed in place (with
 * Desfazer), and Copiar link at the bottom, an address of the app. While only a private conversation sees it, the
 * dialog says plainly that people outside won't open the link, with the way to choose them right there.
 */
export function ShareDialog({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const dir = useDirectory(org.id);
  const roles = useRoles(org.id);
  const toast = useToast();
  const authorName = useAuthorName();
  const save = useSetArtifactSharing(org.id);
  const [file, setFile] = useState(artifact);
  const sharing = file.sharing ?? CONVERSATION_ONLY;
  // "people" is chosen before anyone is added: it's saved with the first one.
  const [mode, setMode] = useState<Mode>(sharing.mode);
  const add = useRef<HTMLDivElement>(null);
  const closed = isPrivateArtifact({ audience: file.audience });
  const canShare = closed && Boolean(file.canShare);
  const busy = save.isPending;

  const apply = (next: ArtifactSharing) => {
    const before = sharing;
    setMode(next.mode);
    save.mutate(
      { id: file.id, sharing: next },
      {
        onSuccess: (saved) => {
          setFile(saved);
          setMode(saved.sharing?.mode ?? "conversation");
          const savedMode = saved.sharing?.mode ?? "conversation";
          toast.show(t(savedMode === "everyone" ? modeKey(org, SAVED.everyone) : SAVED[savedMode]), "success", {
            label: t("share.undo"),
            // Through the API itself: the dialog may be closed by then (and shows it if it's still open).
            run: () =>
              void api.artifacts
                .setSharing(org.id, file.id, before)
                .then((restored) => {
                  setFile(restored);
                  setMode(restored.sharing?.mode ?? "conversation");
                  return qc.invalidateQueries({ queryKey: keys.artifacts(org.id) });
                })
                .catch((e: unknown) => toast.show(errorText(t, e, i18n.language), "error")),
          });
        },
        onError: (e) => {
          setMode(before.mode);
          toast.show(errorText(t, e, i18n.language), "error");
        },
      },
    );
  };
  const listed = sharing.mode === "people" ? sharing : CONVERSATION_ONLY;
  const toggle = (kind: "user" | "role", id: string) => apply(toggledSharing(sharing, { kind, id }));
  const choose = (m: Mode) => {
    if (m === mode) return;
    if (m === "people" && listed.userIds.length + listed.roleIds.length === 0) {
      setMode("people");
      requestAnimationFrame(() => add.current?.querySelector<HTMLElement>("button")?.focus());
      return;
    }
    apply(m === "people" ? listed : { mode: m, userIds: [], roleIds: [] });
  };

  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  // A personal workspace's family picks people: roles to add only when one is worth it or already listed, and alone,
  // no word on who else sees it (ADR 0159).
  const offersRoles = rolePicksInSight(org, roles.data?.roles ?? [], listed.roleIds);
  const { solo } = usePersonalView();
  const everyoneText = t(modeKey(org, "share.everyone"));
  const modeLabel = (m: Mode) =>
    m === "everyone"
      ? everyoneText
      : m === "people"
        ? t(offersRoles ? "share.people" : "share.peoplePersonal")
        : t("share.conversation");
  const addText = t(offersRoles ? "share.add" : "share.addPersonal");
  const addSearchText = t(offersRoles ? "share.addSearch" : "share.addSearchPersonal");
  // Who sees it where it lives (I do, to be here) has nothing to gain from the list.
  const addable = [
    ...dir.members
      .filter((m) => m.userId !== me.user.id && !listed.userIds.includes(m.userId))
      .map((m) => ({
        value: `u:${m.userId}`,
        label: m.name,
        description: m.email,
        group: t("share.groupPeople"),
        leading: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
      })),
    ...(offersRoles ? roleList : [])
      .filter((r) => !listed.roleIds.includes(r.id))
      .map((r) => ({
        value: `r:${r.id}`,
        label: r.name,
        description: t("share.role"),
        group: t("share.groupRoles"),
        leading: <RoleMark color={r.color} icon={r.icon} size={24} />,
      })),
  ];
  const aud = file.audience;
  const where =
    aud.kind === "dm"
      ? aud.between
        ? t("share.whereDmBetween", { names: joinNames(aud.between.map(authorName), t) })
        : aud.with
          ? t("share.whereDm", { name: authorName(aud.with) })
          : t("share.whereDmGone")
      : aud.kind === "channel"
        ? t("share.whereChannel", { name: aud.name })
        : everyoneText;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={t("share.title", { name: file.title })}
      closeLabel={t("common.close")}
      width={480}
      className="share"
    >
      <DialogBody>
        <Locked when={busy}>
          {closed ? (
            <section className="share__section" aria-label={t("whoSees.label")}>
              <h3 className="ac-eyebrow">{t("whoSees.label")}</h3>
              <div className="who-sees__options">
                {MODES.map((m) => (
                  <OptionCard
                    key={m.mode}
                    className="ac-mediarow ac-mediarow--row"
                    pressed={mode === m.mode}
                    disabled={!canShare}
                    onClick={() => choose(m.mode)}
                  >
                    <span className="ac-mediarow__face">
                      <Icon name={m.icon} size={16} />
                    </span>
                    <span className="ac-mediarow__head">
                      <span className="ac-option__title">{modeLabel(m.mode)}</span>
                    </span>
                  </OptionCard>
                ))}
              </div>
              {!canShare && <p className="small muted share__note">{t("share.readOnly")}</p>}
              {canShare && mode === "people" && (
                <div ref={add}>
                  <SearchSelect
                    className="share__add"
                    value={undefined}
                    placeholder={addText}
                    aria-label={addText}
                    labels={{
                      search: addSearchText,
                      searchPlaceholder: addSearchText,
                      noResults: t("share.noResults"),
                      list: addText,
                    }}
                    options={() => addable}
                    onValueChange={(v) => toggle(v.startsWith("u:") ? "user" : "role", v.slice(2))}
                  />
                </div>
              )}
            </section>
          ) : (
            <p className="share__open ac-iconline">
              <Icon name="audienceEveryone" size={16} />
              <span>{t(modeKey(org, "share.open"))}</span>
            </p>
          )}
          {closed && (
            <section className="share__section" aria-label={t("share.access")}>
              <h3 className="ac-eyebrow">{t("share.access")}</h3>
              <ul className="share__list">
                {sharing.mode === "everyone" ? (
                  <Row lead={<Icon name="audienceEveryone" size={16} />} name={everyoneText} />
                ) : (
                  <Row
                    lead={
                      aud.kind === "dm" && aud.with ? (
                        <ActorAvatar size="sm" actor={aud.with} name={authorName(aud.with)} />
                      ) : (
                        <Icon name={aud.kind === "dm" ? "message" : "channel"} size={16} />
                      )
                    }
                    name={where}
                  />
                )}
                {listed.userIds.map((id) => {
                  const m = dir.memberById.get(id);
                  const name = m?.name ?? t("channel.unknownPerson");
                  return (
                    <Row
                      key={id}
                      lead={<Avatar kind="person" size="sm" name={name} imageUrl={m?.image} />}
                      name={id === me.user.id ? t("share.you", { name }) : name}
                      onRemove={canShare ? () => toggle("user", id) : undefined}
                    />
                  );
                })}
                {listed.roleIds.map((id) => {
                  const r = roleList.find((role) => role.id === id);
                  const name = r?.name ?? t("share.role");
                  return (
                    <Row
                      key={id}
                      lead={
                        r ? <RoleMark color={r.color} icon={r.icon} size={24} /> : <Icon name="members" size={16} />
                      }
                      name={name}
                      detail={t("share.role")}
                      onRemove={canShare ? () => toggle("role", id) : undefined}
                    />
                  );
                })}
              </ul>
              {sharing.mode === "people" && !solo && (
                <p className="small muted share__note">{t(modeKey(org, "share.admins"))}</p>
              )}
            </section>
          )}
        </Locked>
      </DialogBody>
      <DialogFooter
        className="share__foot"
        note={
          closed && sharing.mode === "conversation" ? (
            <span className="share__warn ac-iconline">
              <Icon name="lock" size={16} />
              <span>
                {t("share.onlyHere")}{" "}
                {canShare && mode !== "people" && (
                  <button type="button" className="ac-link" onClick={() => choose("people")}>
                    {t("share.choosePeople")}
                  </button>
                )}
              </span>
            </span>
          ) : undefined
        }
      >
        <Button
          icon="link"
          disabled={busy}
          onClick={() =>
            void copyText(artifactLink(window.location.origin, org.id, file.id), () => toast.show(t("share.copied")))
          }
        >
          {t("share.copyLink")}
        </Button>
        <Button variant="primary" disabled={busy} onClick={onClose}>
          {t("share.done")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** One who has access: a face or mark, a name with what it is, and Tirar when it may be taken out. */
function Row({
  lead,
  name,
  detail,
  onRemove,
}: {
  lead: ReactNode;
  name: string;
  detail?: string;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="share__row">
      <span className="share__lead">{lead}</span>
      <span className="share__name">
        {name}
        {detail && <span className="muted"> · {detail}</span>}
      </span>
      {onRemove && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("share.remove", { name })}
          title={t("share.remove", { name })}
          onClick={onRemove}
        />
      )}
    </li>
  );
}
