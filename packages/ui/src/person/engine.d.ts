/** Types for engine.js (plain JavaScript so plain HTML pages can import it as is). */

import type { AgentPresetColor } from "../agent/engine.js";

export type PersonBuild = "m" | "f";

/** A person's portrait: one value per piece. Every field has a default, so a partial recipe draws too. */
export interface PersonRecipe {
  build: PersonBuild;
  skin: string;
  hair: string;
  hairColor: string;
  beard: string;
  glasses: string;
  /** What goes on the head (a cap, a bow, a scarf). */
  extra: string;
  ear: string;
  neck: string;
  lips: string;
  shadow: string;
  blush: string;
  mark: string;
  eyes: string;
  clothes: string;
  clothesColor: string;
  mood: string;
  bg: AgentPresetColor;
}
export type PersonField = keyof PersonRecipe;

/** Cells per side of the full portrait. */
export const N: number;
export const SKINS: Record<string, { base: string; shade: string; blush: string }>;
export const HAIR_COLORS: Record<string, string>;
export const CLOTHES_COLORS: Record<string, string>;
export const LIPS: Record<string, string | null>;
export const SHADOWS: Record<string, string | null>;
/** Eye colors; `dark` (null) is the plain dark eye. */
export const EYES: Record<string, string | null>;
export const HAIRS: string[];
export const BEARDS: string[];
export const BUILDS: PersonBuild[];
export const GLASSES: string[];
export const EXTRAS: string[];
export const EARS_LIST: string[];
export const NECKS: string[];
export const BLUSHES: string[];
export const MARKS: string[];
export const CLOTHES: string[];
export const MOODS: string[];
export const BGS: AgentPresetColor[];
/** What each build is offered first, per field; a field left out offers everything. */
export const CATALOG: Record<PersonBuild, Partial<Record<PersonField, string[]>>>;
export const DEFAULT: PersonRecipe;
/** Every field in the order the code writes them, with the values each takes. */
export const FIELDS: Record<PersonField, string[]>;

/** A recipe → N×N colors, row by row (null = background). */
export function drawPerson(recipe: Partial<PersonRecipe>): (string | null)[];
/** The background color of the cell (x, y). */
export function bgAt(color: string, x: number, y: number): string;
/** "face" (24 cells) up to 48 px, "full" above. */
export function cropFor(px: number): "face" | "full";
/** Paints the portrait, `px` device pixels wide (cells are whole pixels, rounded up). False without a 2D context. */
export function renderPerson(
  canvas: HTMLCanvasElement,
  recipe: Partial<PersonRecipe>,
  options?: { crop?: "face" | "full"; px?: number },
): boolean;
export function cleanRecipe(recipe: Partial<PersonRecipe> | null | undefined): PersonRecipe;
/** "1." and the values in `FIELDS` order. */
export function encodeRecipe(recipe: Partial<PersonRecipe>): string;
export function decodeRecipe(code: unknown): PersonRecipe | null;
/** The fragment that marks a photo address as a drawn portrait. */
export const PORTRAIT_MARK: "#px=";
export function recipeOfUrl(url: string | null | undefined): PersonRecipe | null;
/** A color field's value as CSS (a color, or the background's gradient); null for fields that are not colors. */
export function swatchOf(field: PersonField, value: string): string | null;
/** A portrait at random (steady per seed), of the build asked for when one is given. */
export function randomPerson(seed?: string | number, build?: PersonBuild): PersonRecipe;
