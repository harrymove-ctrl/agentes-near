import type { Availability, StatusInput } from "@agenteschat/client";
import { useSetMyStatus } from "@agenteschat/client";
import {
  AVAILABILITIES,
  clearsText,
  presenceOfAvailability,
  STATUS_SUGGESTIONS,
  UNTIL_CHOICES,
  type UntilChoice,
  untilFor,
} from "@agenteschat/client/lib/presence";
import {
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  EmojiPickerPopover,
  Icon,
  PresenceBadge,
  Radio,
  RadioGroup,
  Select,
} from "@agenteschat/ui";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { StatusLine } from "@/components/Presence";
import { useEmojiLabels } from "@/components/Reactions";
import { useDirectory } from "@/hooks/useDirectory";
import { availabilityOf, type PersonPresence, STATUS_EMOJI, usePersonPresence } from "@/hooks/usePresence";
import { useToast } from "@/lib/toast";
import "./presence.css";

/** When the line clears: a choice, or the end it already has ("keep", shown as "Some às 15:00"). */
type Until = UntilChoice | "keep";

interface Draft {
  text: string;
  emoji: string | null;
  until: Until;
  availability: Availability;
}

const draftOf = (mine: PersonPresence | null): Draft => ({
  text: mine?.status?.text ?? "",
  emoji: mine?.status?.emoji ?? null,
  until: mine?.status?.until ? "keep" : "never",
  availability: mine?.person.availability ?? availabilityOf(mine?.presence),
});

/**
 * "Definir status" (ADR 0084): how the others see you on top, the line (an emoji key, the words, ✕ to wipe them),
 * suggestions that fill the line, its end and how you appear, when the line clears, and how you appear (online, away,
 * busy or hidden). Saving shows at once (`useSetMyStatus` is optimistic); the server's answer follows.
 */
export function SetStatusDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useOrg();
  const mine = usePersonPresence(me.user.id);
  const saveStatus = useSaveStatus();
  const save = (input: StatusInput) => {
    onClose();
    saveStatus(input);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("presence.title")}
      closeLabel={t("common.close")}
      width={460}
    >
      {/* Mounted while open, once your row is in: each opening starts from the status as it is (never from nothing,
          which would save over it). */}
      {mine && <StatusForm mine={mine} onSave={save} onCancel={onClose} />}
    </Dialog>
  );
}

/** Saves how you appear or your line, shown at once, then says so: the line saved, or how you appear now. */
export function useSaveStatus() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const setStatus = useSetMyStatus(org.id, me.user.id);
  return (input: StatusInput) =>
    setStatus.mutate(input, {
      onSuccess: (person) =>
        toast.show(
          person.status
            ? t("presence.saved")
            : t("presence.appearsAs", { presence: t(`presence.lower.${person.presence}`) }),
        ),
    });
}

function StatusForm({
  mine,
  onSave,
  onCancel,
}: {
  mine: PersonPresence | null;
  onSave: (input: StatusInput) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const emojiLabels = useEmojiLabels();
  const id = useId().replace(/:/g, "");
  const field = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => draftOf(mine));
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const text = draft.text.trim();
  const presence = presenceOfAvailability(draft.availability);
  const word = t(`presence.${presence}`);
  const keptUntil = mine?.status?.until ?? null;
  const photo = dir.memberById.get(me.user.id)?.image ?? me.user.image;
  const submit = () =>
    onSave({
      availability: draft.availability,
      status: text
        ? {
            text,
            emoji: draft.emoji ?? STATUS_EMOJI,
            until: draft.until === "keep" ? keptUntil : untilFor(draft.until),
          }
        : null,
    });
  const untilOptions = [
    ...(keptUntil ? [{ value: "keep" as Until, label: clearsText(t, i18n.language, keptUntil) }] : []),
    ...UNTIL_CHOICES.map((c) => ({ value: c as Until, label: t(`presence.until.${c}`) })),
  ];
  return (
    <>
      <DialogBody className="status-dialog">
        <div className="status-preview">
          <span className="status-preview__caption">
            {draft.availability === "hidden" ? t("presence.hiddenPreview") : t("presence.howOthersSee")}
          </span>
          <div className="ac-mediarow">
            <span className="ac-mediarow__face">
              <Avatar name={me.user.name} imageUrl={photo} presence={presence} presenceLabel={word} />
            </span>
            <span className="ac-mediarow__head">
              <b className="status-preview__name">{me.user.name}</b>
            </span>
            <span className="ac-mediarow__body">
              {text ? <StatusLine emoji={draft.emoji ?? STATUS_EMOJI} text={text} /> : <StatusLine text={word} empty />}
            </span>
          </div>
        </div>

        <div>
          <div className="ac-input-affix status-field">
            <EmojiPickerPopover
              labels={emojiLabels}
              side="bottom"
              align="start"
              onPick={(emoji) => set({ emoji })}
              trigger={
                <button
                  type="button"
                  className="status-field__emoji"
                  aria-label={t("presence.emoji")}
                  title={t("presence.emoji")}
                >
                  {draft.emoji ?? <Icon name="smile" />}
                </button>
              }
            />
            <input
              ref={field}
              value={draft.text}
              maxLength={100}
              placeholder={t("presence.placeholder")}
              aria-label={t("presence.placeholder")}
              // biome-ignore lint/a11y/noAutofocus: the dialog opens to write the line
              autoFocus
              onChange={(e) => set({ text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                submit();
              }}
            />
            {draft.text && (
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                aria-label={t("presence.wipe")}
                onClick={() => {
                  set({ text: "", emoji: null, until: "never" });
                  field.current?.focus();
                }}
              />
            )}
          </div>
          <div className="status-suggest">
            {STATUS_SUGGESTIONS.map((s) => {
              const label = t(`presence.suggest.${s.key}`);
              return (
                <Button
                  key={s.key}
                  size="sm"
                  aria-pressed={draft.text === label}
                  onClick={() => set({ text: label, emoji: s.emoji, until: s.until, availability: s.availability })}
                >
                  <span aria-hidden="true">{s.emoji}</span>
                  {label}
                </Button>
              );
            })}
          </div>
        </div>

        {text && (
          <div className="status-dialog__row">
            <label htmlFor={`${id}-until`}>{t("presence.clearAfter")}</label>
            <Select
              id={`${id}-until`}
              size="sm"
              align="end"
              value={draft.until}
              onValueChange={(until) => set({ until })}
              options={untilOptions}
            />
          </div>
        )}

        <div>
          <span className="status-dialog__label" id={`${id}-avail`}>
            {t("presence.appearAs")}
          </span>
          <RadioGroup
            className="ac-list status-avail"
            aria-labelledby={`${id}-avail`}
            value={draft.availability}
            onValueChange={(availability) => set({ availability })}
          >
            {AVAILABILITIES.map((a) => (
              <label key={a} htmlFor={`${id}-${a}`} className="ac-list__row status-avail__opt">
                <PresenceBadge presence={presenceOfAvailability(a)} size="lg" ring={false} />
                <span className="status-avail__text">
                  <span className="status-avail__title">{t(`presence.${presenceOfAvailability(a)}`)}</span>
                  <span className="status-avail__help">{t(`presence.help.${a}`)}</span>
                </span>
                <Radio value={a} id={`${id}-${a}`} />
              </label>
            ))}
          </RadioGroup>
        </div>
      </DialogBody>
      <DialogFooter
        bar
        note={
          mine?.status ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSave({ availability: draft.availability, status: null })}
            >
              {t("presence.clearStatus")}
            </Button>
          ) : undefined
        }
      >
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={submit}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </>
  );
}
