/**
 * The screen layer (ADR 0054): observe a screen as text, find targets in
 * words (and on images), check conditions, run plans. The agent browser is
 * its first surface; desktop computer use reuses it as is.
 */
export * from "./checks";
export * from "./observation";
export * from "./plan";
export * from "./report";
export * from "./targets";
