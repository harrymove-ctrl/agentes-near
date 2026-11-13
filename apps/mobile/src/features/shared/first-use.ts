import { featureKeysEn } from "../i18n/keys.en";

export type EmptyPlace = keyof typeof featureKeysEn.empty;

/**
 * The words of a place with nothing in it yet: what it gives and, when a person can't take the first step and the
 * place has words for them, a title they can use and who does it. The button is the screen's, shown only when `acts`.
 * A personal workspace (`personal`, ADR 0159) reads the place's words for one person where it has them (the sibling
 * `titlePersonal`, `textPersonal`, `viewerTitlePersonal`, `viewerTextPersonal`), its usual ones otherwise.
 */
export function firstUseCopy(place: EmptyPlace, acts: boolean, personal = false) {
  const words: object = featureKeysEn.empty[place];
  const viewer = !acts && "viewerTitle" in words;
  const own = (key: string) => (personal && `${key}Personal` in words ? `${key}Personal` : key);
  return {
    title: `mobile.empty.${place}.${own(viewer ? "viewerTitle" : "title")}`,
    text: `mobile.empty.${place}.${own(viewer ? "viewerText" : "text")}`,
  } as const;
}
