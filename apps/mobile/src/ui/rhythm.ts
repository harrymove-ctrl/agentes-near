/**
 * The phone's page rhythm: a screen's content 16 from its sides, a card's content 16 inside it, a toolbar's controls
 * (Segmented, Filters) 32 tall with their target grown to 44. Grouped rows are 52 with 10 above and below and 16 at the
 * sides, as the system's own grouped lists on the current iOS (taller than the web's 44: a finger, not a pointer, and
 * an icon's tile with room around it). A row whose text wraps starts its label where a one-line row's sits: its
 * 22-point line centred in 52.
 */
export const SCREEN_X = 16;
export const CARD_PAD = 16;
export const TOOL_H = 32;
export const TOUCH = 44;
export const GROUPED_ROW = { minHeight: 52, padX: 16, padY: 10, tallPadY: (52 - 22) / 2 } as const;
