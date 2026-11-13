import { keys } from "@agenteschat/client";
import {
  Avatar,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  encodeRecipe,
  Icon,
  Locked,
  PERSON_CATALOG,
  PERSON_DEFAULT,
  PERSON_FIELDS,
  type PersonBuild,
  type PersonField,
  PersonPortrait,
  type PersonRecipe,
  personSwatchOf,
  randomPerson,
  recipeOfUrl,
  renderPerson,
  Segmented,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
import { ProfilePhotoDialog } from "@/components/ProfilePhoto";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/** The side of the image kept as the person's photo: 16 pixels per cell of the 32-cell portrait. */
export const PORTRAIT_PX = 512;

/** The groups a tab is made of, as their headings are keyed. */
type Section =
  | "skin"
  | "eyes"
  | "mood"
  | "color"
  | "cut"
  | "beard"
  | "lips"
  | "shadow"
  | "blush"
  | "mark"
  | "glasses"
  | "ear"
  | "neck"
  | "extra"
  | "piece"
  | "bg";

/** The fields whose options have a name under their tile (`portrait.options.<field>.<value>`); colors have none. */
export const NAMED_FIELDS = [
  "mood",
  "hair",
  "beard",
  "lips",
  "shadow",
  "blush",
  "mark",
  "glasses",
  "ear",
  "neck",
  "extra",
  "clothes",
] as const satisfies readonly PersonField[];

type TabId = "face" | "hair" | "beard" | "makeup" | "accessories" | "clothes" | "background";

/** The pieces each build starts from the first time it is chosen: nothing on, so every extra is the person's choice. */
const START: Record<PersonBuild, Partial<PersonRecipe>> = {
  m: { hair: "short", clothes: "tee" },
  f: { hair: "long", clothes: "vneck" },
};

/** What follows the person from one build to the other. */
const SHARED: PersonField[] = ["skin", "eyes", "hairColor", "bg", "mood"];

/**
 * The options of a field for the build in hand: the build's own list unless every option is asked for. The option the
 * person wears now is never left out.
 */
export function optionsOf(field: PersonField, recipe: PersonRecipe, all: boolean): string[] {
  const own = all ? undefined : PERSON_CATALOG[recipe.build][field];
  if (!own) return PERSON_FIELDS[field];
  return own.includes(recipe[field]) ? own : [...own, recipe[field]];
}

/** The tabs a build has: Beard only on the masculine one, makeup only on the feminine one (Marks stays on both). */
export function tabsOf(build: PersonBuild, all: boolean): TabId[] {
  const tabs: TabId[] = ["face", "hair"];
  if (build === "m" || all) tabs.push("beard");
  tabs.push("makeup", "accessories", "clothes", "background");
  return tabs;
}

/** The other build's portrait: the one left there before, else its plain start, with what follows the person. */
export function switchBuild(from: PersonRecipe, to: PersonBuild, kept?: PersonRecipe): PersonRecipe {
  const base: PersonRecipe = kept ?? { ...PERSON_DEFAULT, ...START[to], build: to };
  const next = { ...base };
  for (const field of SHARED) (next as Record<PersonField, string>)[field] = from[field];
  return next;
}

/** The portrait as the PNG to store (base64), or null where there is no canvas to draw it on. */
export function portraitPng(recipe: PersonRecipe): string | null {
  try {
    const canvas = document.createElement("canvas");
    if (!renderPerson(canvas, recipe, { crop: "full", px: PORTRAIT_PX })) return null;
    const url = canvas.toDataURL("image/png");
    return url.startsWith("data:image/png") ? url.slice(url.indexOf(",") + 1) : null;
  } catch {
    return null;
  }
}

/** The faces on the "Build an avatar" door: one of each build and one of either, one changing at a time. */
const doorFaces = (): PersonRecipe[] => [
  randomPerson(Math.random(), "m"),
  randomPerson(Math.random(), "f"),
  randomPerson(),
];

/**
 * "How do you want to appear?": what "Change photo" opens first (ADR 0166 §3). Two doors side by side: build an
 * avatar, with pixel faces taking turns on it, or upload a photo, with the person's own tile.
 */
export function AvatarChoiceDialog({
  open,
  onClose,
  onBuild,
  onPhoto,
}: {
  open: boolean;
  onClose: () => void;
  onBuild: () => void;
  onPhoto: () => void;
}) {
  const { t } = useTranslation();
  const { me } = useOrg();
  const [faces, setFaces] = useState(doorFaces);
  useEffect(() => {
    if (!open || calm()) return;
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      const at = n % 3;
      setFaces((now) =>
        now.map((face, i) => (i === at ? randomPerson(Math.random(), i === 2 ? undefined : face.build) : face)),
      );
    }, 1300);
    return () => clearInterval(timer);
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("portrait.ask.title")}
      closeLabel={t("common.close")}
      width={600}
    >
      <DialogBody>
        <div className="avatar-ask">
          <button type="button" className="avatar-ask__door" onClick={onBuild}>
            <span className="avatar-ask__art avatar-ask__art--sky" aria-hidden="true">
              <span className="avatar-ask__fan">
                {[0, 1, 2].map((i) => (
                  <span key={i}>
                    <PersonPortrait recipe={faces[i] ?? PERSON_DEFAULT} crop="full" />
                  </span>
                ))}
              </span>
            </span>
            <span className="avatar-ask__title">{t("portrait.ask.build")}</span>
            <span className="avatar-ask__text">{t("portrait.ask.buildText")}</span>
          </button>
          <button type="button" className="avatar-ask__door" onClick={onPhoto}>
            <span className="avatar-ask__art" aria-hidden="true">
              <span className="avatar-ask__photo">
                <Avatar name={me.user.name} size="lg" imageUrl={undefined} />
                <span className="avatar-ask__badge">
                  <Icon name="image" size={16} />
                </span>
              </span>
            </span>
            <span className="avatar-ask__title">{t("portrait.ask.photo")}</span>
            <span className="avatar-ask__text">{t("portrait.ask.photoText")}</span>
          </button>
        </div>
      </DialogBody>
    </Dialog>
  );
}

/**
 * "Trocar foto" as Editar perfil's button and the account menu's face open it: the question, then the builder or the
 * photo. `onClose` as soon as the question is answered or dismissed: what it led to stays open on its own.
 */
export function ChangeAvatarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [next, setNext] = useState<"build" | "photo" | null>(null);
  const go = (to: "build" | "photo") => {
    onClose();
    setNext(to);
  };
  return (
    <>
      <AvatarChoiceDialog open={open} onClose={onClose} onBuild={() => go("build")} onPhoto={() => go("photo")} />
      <AvatarBuilderDialog
        open={next === "build"}
        onClose={() => setNext(null)}
        onUploadPhoto={() => setNext("photo")}
      />
      <ProfilePhotoDialog open={next === "photo"} onClose={() => setNext(null)} />
    </>
  );
}

const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * "Your avatar", from the question's "Build an avatar": the person builds a pixel portrait (ADR 0166). Masculine or Feminine picks what is offered (cuts,
 * clothes, earrings, what goes around the neck and on the head; Beard on one, makeup on the other), each option is the
 * person's own portrait wearing it, and pointing at one tries it on the large portrait. A photo is one link away.
 */
export function AvatarBuilderDialog({
  open,
  onClose,
  onUploadPhoto,
}: {
  open: boolean;
  onClose: () => void;
  onUploadPhoto: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const mine = useDirectory(org.id).memberById.get(me.user.id)?.image ?? me.user.image;
  const [draft, setDraft] = useState<PersonRecipe>(PERSON_DEFAULT);
  const [tab, setTab] = useState<TabId>("face");
  const [all, setAll] = useState(false);
  /** The option under the pointer, tried on the large portrait. */
  const [trying, setTrying] = useState<Partial<PersonRecipe> | null>(null);
  const [pop, setPop] = useState(0);
  const looks = useRef<Partial<Record<PersonBuild, PersonRecipe>>>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Opens on the portrait the person has now, else on the plain start.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once, as it opens
  useEffect(() => {
    if (!open) return;
    setDraft(recipeOfUrl(mine) ?? PERSON_DEFAULT);
    setTab("face");
    setAll(false);
    setTrying(null);
    looks.current = {};
  }, [open]);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const wear = (next: PersonRecipe) => {
    setDraft(next);
    setTrying(null);
    setPop((n) => n + 1);
  };
  const set = (field: PersonField, value: string) => wear({ ...draft, [field]: value });
  const setBuild = (to: PersonBuild) => {
    if (to === draft.build) return;
    looks.current[draft.build] = draft;
    wear(switchBuild(draft, to, looks.current[to]));
  };
  const shuffle = () => {
    const end = randomPerson(Math.random(), draft.build);
    if (timer.current) clearInterval(timer.current);
    if (calm()) return wear(end);
    let n = 0;
    timer.current = setInterval(() => {
      n += 1;
      if (n < 7) return setTrying(randomPerson(Math.random(), draft.build));
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      wear(end);
    }, 55);
  };

  const save = useMutation({
    mutationFn: async () => {
      const png = portraitPng(draft);
      if (!png) throw new Error("no canvas");
      await api.orgs.setAvatar(org.id, { imageBase64: png, contentType: "image/png", portrait: encodeRecipe(draft) });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.members(org.id) });
      void qc.invalidateQueries({ queryKey: keys.people(org.id) });
      toast.show(t("portrait.saved"));
      onClose();
    },
    onError: () => toast.show(t("portrait.failed")),
  });

  const tabs = tabsOf(draft.build, all);
  const at = tabs.includes(tab) ? tab : "hair";
  const makeup = draft.build === "f" || all;
  const shown = trying ? { ...draft, ...trying } : draft;

  const group = (field: Section, body: ReactNode) => (
    <section className="avatar-builder__group">
      <h3 className="avatar-builder__label">{t(`portrait.sections.${field}`)}</h3>
      {body}
    </section>
  );
  const tryOn = (field: PersonField, value: string) => ({
    onPointerEnter: () => setTrying({ [field]: value }),
    onPointerLeave: () => setTrying(null),
  });
  const tiles = (field: PersonField, named = true) => (
    <div className="avatar-builder__options">
      {optionsOf(field, draft, all).map((value, i) => (
        <button
          key={value}
          type="button"
          className="avatar-builder__option"
          aria-pressed={draft[field] === value}
          aria-label={named ? undefined : t("portrait.swatch", { group: t("portrait.sections.bg"), n: i + 1 })}
          onClick={() => set(field, value)}
          {...tryOn(field, value)}
        >
          <span className="avatar-builder__face">
            <PersonPortrait recipe={{ ...draft, [field]: value }} crop="full" />
          </span>
          {/* The value comes from the engine's lists; a test holds a name for each. */}
          {named && <span>{t(`portrait.options.${field}.${value}` as never)}</span>}
        </button>
      ))}
    </div>
  );
  const swatches = (field: PersonField, label: string) => (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form's fieldset
    <div className="avatar-builder__swatches" role="group" aria-label={label}>
      {PERSON_FIELDS[field].map((value, i) => (
        <button
          key={value}
          type="button"
          className="avatar-builder__swatch"
          style={{ background: personSwatchOf(field, value) ?? undefined }}
          aria-pressed={draft[field] === value}
          aria-label={t("portrait.swatch", { group: label, n: i + 1 })}
          onClick={() => set(field, value)}
          {...tryOn(field, value)}
        />
      ))}
    </div>
  );
  const more = (
    <p className="avatar-builder__hint">
      <button type="button" className="ac-link" onClick={() => setAll((v) => !v)}>
        {t(all ? "portrait.showFewer" : "portrait.showAll")}
      </button>
    </p>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("portrait.title")}
      closeLabel={t("common.close")}
      width={840}
    >
      <Locked when={save.isPending}>
        <DialogBody>
          <div className="avatar-builder">
            <div className="avatar-builder__side">
              <div
                className="avatar-builder__stage"
                key={pop}
                data-pop={pop > 0 || undefined}
                role="img"
                aria-label={t("portrait.preview")}
              >
                <PersonPortrait recipe={shown} crop="full" />
              </div>
              <Segmented
                block
                label={t("portrait.build.label")}
                value={draft.build}
                onValueChange={setBuild}
                options={[
                  { value: "m", label: t("portrait.build.m") },
                  { value: "f", label: t("portrait.build.f") },
                ]}
              />
              <Button icon="shuffle" onClick={shuffle}>
                {t("portrait.shuffle")}
              </Button>
              <div className="avatar-builder__sizes" aria-hidden="true">
                {[48, 32, 24].map((px) => (
                  <span key={px} style={{ width: px, height: px }}>
                    <PersonPortrait recipe={shown} />
                  </span>
                ))}
              </div>
              <p className="avatar-builder__hint">{t("portrait.small")}</p>
            </div>
            <div className="avatar-builder__main">
              <Tabs
                label={t("portrait.tabs.label")}
                value={at}
                onValueChange={setTab}
                items={tabs.map((id) => ({
                  value: id,
                  label: t(id === "makeup" && !makeup ? "portrait.tabs.marks" : `portrait.tabs.${id}`),
                }))}
              >
                <TabPanel value={at}>
                  {at === "face" && (
                    <>
                      {group("skin", swatches("skin", t("portrait.sections.skin")))}
                      {group("eyes", swatches("eyes", t("portrait.sections.eyes")))}
                      {group("mood", tiles("mood"))}
                    </>
                  )}
                  {at === "hair" && (
                    <>
                      {group("color", swatches("hairColor", t("portrait.sections.hairColor")))}
                      {group("cut", tiles("hair"))}
                      {more}
                    </>
                  )}
                  {at === "beard" && (
                    <>
                      {group("beard", tiles("beard"))}
                      <p className="avatar-builder__hint">{t("portrait.beardHint")}</p>
                    </>
                  )}
                  {at === "makeup" && (
                    <>
                      {makeup && group("lips", tiles("lips"))}
                      {makeup && group("shadow", tiles("shadow"))}
                      {group("blush", tiles("blush"))}
                      {group("mark", tiles("mark"))}
                      {more}
                    </>
                  )}
                  {at === "accessories" && (
                    <>
                      {group("glasses", tiles("glasses"))}
                      {group("ear", tiles("ear"))}
                      {group("neck", tiles("neck"))}
                      {group("extra", tiles("extra"))}
                      <p className="avatar-builder__hint">{t("portrait.hatsHint")}</p>
                      {more}
                    </>
                  )}
                  {at === "clothes" && (
                    <>
                      {group("color", swatches("clothesColor", t("portrait.sections.clothesColor")))}
                      {group("piece", tiles("clothes"))}
                      {more}
                    </>
                  )}
                  {at === "background" && group("bg", tiles("bg", false))}
                </TabPanel>
              </Tabs>
            </div>
          </div>
        </DialogBody>
      </Locked>
      <DialogFooter
        note={
          <>
            {t("portrait.photoAsk")}{" "}
            <button type="button" className="ac-link" onClick={onUploadPhoto}>
              {t("portrait.photoUpload")}
            </button>
          </>
        }
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="primary" loading={save.isPending} disabled={save.isPending} onClick={() => save.mutate()}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
