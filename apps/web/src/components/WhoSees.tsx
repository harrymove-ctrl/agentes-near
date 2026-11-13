import type { Issue } from "@agenteschat/client";
import { useIssueAction } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import {
  type AudienceChoice,
  type AudienceKind,
  audienceKind,
  audienceOfKind,
  pickedOf,
  whoSeesLabel,
} from "@agenteschat/client/lib/who-sees";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  Input,
  Locked,
  OptionCard,
} from "@agenteschat/ui";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { usePersonalView } from "@/hooks/usePersonalView";
import { useToast } from "@/lib/toast";
import "./who-sees.css";

const KINDS: {
  kind: AudienceKind;
  icon: "audienceEveryone" | "lock" | "person";
  label: "whoSees.everyone" | "whoSees.me" | "whoSees.people";
}[] = [
  { kind: "everyone", icon: "audienceEveryone", label: "whoSees.everyone" },
  { kind: "me", icon: "lock", label: "whoSees.me" },
  { kind: "people", icon: "person", label: "whoSees.people" },
];

/** The setting in a few words, from the directory's names. */
export function useWhoSeesLabel() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  return (a: { mode: "everyone" | "people"; userIds?: readonly string[] }) =>
    whoSeesLabel(t, a, me.user.id, (id) => dir.members.find((m) => m.userId === id)?.name, org);
}

/**
 * Who sees it, as a button: the setting itself, and the way to change it. A field's control (`select`) is drawn as
 * the select it stands with, its chevron opening the dialog.
 */
export function WhoSeesButton({
  value,
  onClick,
  disabled,
  select,
}: {
  value: { mode: "everyone" | "people"; userIds?: readonly string[] };
  onClick: () => void;
  disabled?: boolean;
  select?: boolean;
}) {
  const { t } = useTranslation();
  const label = useWhoSeesLabel()(value);
  const icon = value.mode === "everyone" ? "audienceEveryone" : "lock";
  if (select)
    return (
      <div className="ac-select ac-select--sm">
        <button
          type="button"
          className="ac-select__trigger"
          aria-haspopup="dialog"
          aria-label={`${t("whoSees.label")}: ${label}`}
          disabled={disabled}
          onClick={onClick}
        >
          <span className="ac-select__value">
            <span>
              <span className="ac-select__lead" aria-hidden="true">
                <Icon name={icon} size={16} />
              </span>
              <span className="ac-select__text">{label}</span>
            </span>
          </span>
          <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
            <path d="m6 8 4 4 4-4" />
          </svg>
        </button>
      </div>
    );
  return (
    <Button
      size="sm"
      className="who-sees__button"
      icon={icon}
      aria-label={`${t("whoSees.label")}: ${label}`}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

/**
 * "Quem vê" (ADR 0151), for a task and a wiki page alike: everyone, only me, or specific people. Administrators always
 * see, so one may leave themselves out of a list; anyone else stays in it. A personal workspace says it its way, and
 * alone, leaves out who else sees it: nobody else is there (ADR 0159).
 */
export function WhoSeesDialog({
  title,
  value,
  note,
  peopleNote,
  extra,
  saving = false,
  onSave,
  onClose,
}: {
  title: string;
  value: { mode: "everyone" | "people"; userIds?: readonly string[] };
  /** Said above the administrators' line. */
  note?: string;
  /** The same, while it's a list of people: others stay on it, so it opens as a list, even of me alone. */
  peopleNote?: string;
  extra?: ReactNode;
  saving?: boolean;
  onSave: (audience: AudienceChoice, kind: AudienceKind) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const myId = me.user.id;
  const [kind, setKind] = useState<AudienceKind>(() => {
    const now = audienceKind(value, myId);
    return now === "me" && peopleNote ? "people" : now;
  });
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => pickedOf(value, myId));
  const stays = !can(org, "administrator");
  const { solo } = usePersonalView();
  const [q, setQ] = useState("");
  const people = useMemo(() => {
    const words = q.trim().toLowerCase();
    return dir.members.filter((m) => !words || `${m.name} ${m.email}`.toLowerCase().includes(words));
  }, [dir.members, q]);
  const ready = kind !== "people" || picked.size > 0;
  const admins = solo ? undefined : t(modeKey(org, "whoSees.admins"));
  const noteText = [note, kind === "people" ? peopleNote : undefined, admins].filter(Boolean).join(" ");
  const toggle = (id: string, on: boolean) =>
    setPicked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
      title={title}
      closeLabel={t("common.close")}
      width={480}
      className="who-sees"
    >
      <DialogBody>
        <Locked when={saving}>
          <div className="who-sees__options">
            {KINDS.map((k) => (
              <OptionCard
                key={k.kind}
                className="ac-mediarow ac-mediarow--row"
                pressed={kind === k.kind}
                onClick={() => setKind(k.kind)}
              >
                <span className="ac-mediarow__face">
                  <Icon name={k.icon} size={16} />
                </span>
                <span className="ac-mediarow__head">
                  <span className="ac-option__title">
                    {t(k.kind === "everyone" ? modeKey(org, "whoSees.everyone") : k.label)}
                  </span>
                </span>
              </OptionCard>
            ))}
          </div>
          {kind === "people" && (
            <>
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("whoSees.search")}
                aria-label={t("whoSees.search")}
              />
              <ul className="who-sees__people">
                {people.map((m) => {
                  const id = `who-${m.userId}`;
                  return (
                    <li key={m.userId}>
                      <label htmlFor={id} className="who-sees__person">
                        <Checkbox
                          id={id}
                          checked={picked.has(m.userId) || (stays && m.userId === myId)}
                          disabled={stays && m.userId === myId}
                          onCheckedChange={(on) => toggle(m.userId, on)}
                        />
                        <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />
                        <span className="who-sees__name">{m.name}</span>
                      </label>
                    </li>
                  );
                })}
                {people.length === 0 && <li className="small muted">{t("whoSees.noMatch")}</li>}
              </ul>
            </>
          )}
          {noteText && <p className="small muted who-sees__note">{noteText}</p>}
        </Locked>
      </DialogBody>
      <DialogFooter>
        {extra}
        <span className="who-sees__grow" />
        <Button onClick={onClose} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={!ready || saving}
          loading={saving}
          onClick={() => onSave(audienceOfKind(kind, [...picked], myId), kind)}
        >
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** A task's "Quem vê", saved as soon as it's chosen. */
export function IssueWhoSeesDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useIssueAction(org.id);
  const audience = issue.audience ?? { mode: "everyone" as const, userIds: [], channelId: null };
  return (
    <WhoSeesDialog
      title={t("whoSees.taskTitle")}
      value={audience}
      note={audience.channelId ? t("whoSees.tied") : undefined}
      saving={action.isPending}
      onClose={onClose}
      onSave={(next) =>
        action.mutate(
          { type: "audience", id: issue.id, audience: next },
          { onSuccess: onClose, onError: (e) => toast.show(errorText(t, e, i18n.language), "error") },
        )
      }
    />
  );
}
