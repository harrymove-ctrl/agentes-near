/** Types for portrait.js (plain JavaScript so plain HTML pages can import it as is). */

export type ComputerKind = "mac" | "windows" | "linux";
/** A phone reached through a computer, drawn by the same engine. */
export type PhoneKind = "android" | "iphone";
export type PortraitKind = ComputerKind | PhoneKind;
export type ComputerState = "online" | "paused" | "offline";

/** The 2D context subset the portraits draw with. */
export type ComputerCtx = Pick<CanvasRenderingContext2D, "fillRect" | "clearRect"> & { fillStyle: unknown };

export const COMPUTER_GRID: 48;
export const COMPUTER_ART: Record<PortraitKind, readonly [first: number, count: number]>;
export const COMPUTER_ROWS: Record<PortraitKind, readonly [first: number, count: number]>;
export const COMPUTER_KINDS: ComputerKind[];
export const PHONE_KINDS: PhoneKind[];
export const COMPUTER_STATES: ComputerState[];

export function drawComputer(
  ctx: ComputerCtx,
  kind: PortraitKind,
  state: ComputerState,
  options?: { dark?: boolean; t?: number },
): void;
