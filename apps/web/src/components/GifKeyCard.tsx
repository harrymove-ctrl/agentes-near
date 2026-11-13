import type { GifKey } from "@agenteschat/client";
import { useGifKey, useRemoveGifKey, useSaveGifKey } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  Chip,
  type ChipTone,
  Dialog,
  DialogFooter,
  type IconName,
  Input,
  List,
  Locked,
  SettingNote,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { type Ref, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { OpenPage, Step, StepTitle } from "@/components/ai/AddAccountFlow";
import { useOrg } from "@/components/org-context";

/*
 * The installation's GIPHY key (ADR 0091, amended 2026-10-31), in Settings › GIFs and stickers for its owner on a
 * server that isn't agentes.chat's own (the API answers null to everyone else). The same rows as Jev's key
 * (`ai/Jev.tsx`): its steps while there's none, its last 4 and its state once set.
 */

/** GIPHY's site for developers: where an app, and its key, is made for free. */
const GIPHY_DEVELOPERS = "https://developers.giphy.com/dashboard/";
/** Save is on from this length, the shortest key the server takes. */
const GIF_KEY_MIN = 8;

/** A server key's state as its card's chip (the GIPHY key's, the server's GitHub App's). */
export const KEY_STATE_CHIP: Record<
  GifKey["state"],
  { icon?: IconName; tone?: ChipTone; word: "off" | "on" | "invalid" }
> = {
  off: { word: "off" },
  ok: { icon: "check", tone: "done", word: "on" },
  invalid: { icon: "alert", tone: "waiting", word: "invalid" },
};

/** The steps to the key: an app at GIPHY Developers, and its key pasted here, with Save and Cancel beside it. */
function GifKeySteps({
  value,
  onChange,
  error,
  onSave,
  saving,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Under the field, in place of where the key is kept: why it wasn't saved. */
  error: string | null;
  onSave: () => void;
  saving: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const field = `${id}-key`;
  const below = `${id}-below`;
  const key = value.trim();
  return (
    <div className="agp-addacct jev-steps">
      <Step
        n={1}
        side={
          <OpenPage href={GIPHY_DEVELOPERS} primary={key === ""}>
            {t("settings.media.giphy.steps.openSite")}
          </OpenPage>
        }
      >
        <StepTitle title={t("settings.media.giphy.steps.app")} hint={t("settings.media.giphy.steps.appHint")} />
      </Step>
      <Step n={2}>
        <StepTitle title={t("settings.media.giphy.steps.paste")} htmlFor={field} />
        <span className="agp-addacct__paste">
          <Locked when={saving}>
            <Input
              id={field}
              type="password"
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("settings.media.giphy.steps.placeholder")}
              // The steps open in place of the button pressed: the field takes the focus.
              autoFocus
              invalid={Boolean(error)}
              aria-describedby={below}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (key.length >= GIF_KEY_MIN && !saving) onSave();
              }}
            />
          </Locked>
          <Button variant="primary" disabled={key.length < GIF_KEY_MIN} loading={saving} onClick={onSave}>
            {t("settings.saveKey")}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </span>
        <p id={below} className={error ? "jev-steps__below ac-field__error" : "jev-steps__below ac-field__example"}>
          {error ?? t("settings.media.giphy.steps.sealed")}
        </p>
      </Step>
    </div>
  );
}

/**
 * The GIPHY key's card: where to get one and its steps while there's none, its last 4 and its state once set, and,
 * while the server has no Jev key (`jevMissing`), a way to Jev's card, since agents send stickers on their own only
 * with it. A save or a removal reads the workspaces' settings again, so the picker's GIFs tab follows at once.
 */
export function GifKeyCard({ jevMissing }: { jevMissing: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // Read here rather than handed down: a save or a removal shows its key at once, so focus lands on what stays.
  const view = useGifKey().data;
  const save = useSaveGifKey();
  const remove = useRemoveGifKey();
  const [steps, setSteps] = useState<null | "set" | "replace">(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // The steps open in place of the button pressed and close into the card as it is now: focus goes back to its way in
  // ("Adicionar a chave", "Trocar a chave"), or to the card, never to the page.
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (opener.current ?? box.current)?.focus();
  });
  if (!view) return null;
  const env = view.source === "env";
  const chip = KEY_STATE_CHIP[view.state];
  const close = () => {
    setSteps(null);
    setDraft("");
    setError(null);
    refocus.current = true;
  };
  const submit = () => save.mutate(draft.trim(), { onSuccess: close, onError: (e) => setError(errorText(t, e)) });
  const keySteps = (
    <GifKeySteps
      value={draft}
      onChange={(v) => {
        setDraft(v);
        setError(null);
      }}
      error={error}
      onSave={submit}
      saving={save.isPending}
      onCancel={close}
    />
  );
  const ghost = (label: string, onClick: () => void, extra?: { danger?: boolean; ref?: Ref<HTMLButtonElement> }) => (
    <Button
      ref={extra?.ref}
      size="sm"
      variant="ghost"
      className={extra?.danger ? "ac-btn--danger" : undefined}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  // From `.env` it is changed there; a saved key this server can't read is replaced here.
  const note = env
    ? view.state === "invalid"
      ? t("settings.media.giphy.line.envInvalid")
      : t("settings.media.giphy.line.env")
    : view.state === "invalid"
      ? t("settings.media.giphy.line.invalid")
      : null;

  return (
    <Card aria-labelledby="media-giphy">
      <CardHeader
        id="media-giphy"
        icon="key"
        title={t("settings.media.giphy.title")}
        subtitle={t("settings.media.giphy.lead")}
        action={
          <Chip icon={chip.icon} tone={chip.tone}>
            {t(`settings.media.giphy.state.${chip.word}`)}
          </Chip>
        }
      />
      <div ref={box} tabIndex={-1} className="jev">
        <List>
          {view.source === null ? (
            <div className="ac-list__row jev__body">
              <span className="small muted">{t("settings.media.giphy.without")}</span>
              {steps ? (
                keySteps
              ) : (
                <Button ref={opener} size="sm" variant="primary" onClick={() => setSteps("set")}>
                  {t("settings.media.giphy.setUp")}
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="ac-list__row jev__key">
                <span className="list-col">
                  <span className="ai-accounts__name">{t("media.giphy")}</span>
                  {view.hint && <span className="small muted">{t("settings.keyEndsIn", { hint: view.hint })}</span>}
                  {note && <SettingNote icon={view.state === "ok" ? "info" : "alert"}>{note}</SettingNote>}
                </span>
                {!env && (
                  <span className="ac-acts">
                    {ghost(t("settings.rotate"), () => setSteps("replace"), { ref: opener })}
                    {view.state === "ok" && ghost(t("settings.remove"), () => setRemoving(true), { danger: true })}
                  </span>
                )}
              </div>
              {steps === "replace" && <div className="ac-list__row jev__body">{keySteps}</div>}
            </>
          )}
        </List>
      </div>
      {jevMissing && (
        <CardFooter>
          {t("settings.media.giphy.jev")}{" "}
          <Link
            className="ac-link"
            to="/org/$orgId/settings/$section"
            params={{ orgId: org.id, section: "usage" }}
            hash="jev"
          >
            {t("settings.media.giphy.jevLink")}
          </Link>
        </CardFooter>
      )}
      <Dialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("settings.media.giphy.remove.title")}
        description={t("settings.media.giphy.remove.text")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setRemoving(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            disabled={remove.isPending}
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  setRemoving(false);
                  close();
                },
              })
            }
          >
            {t("settings.remove")}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
