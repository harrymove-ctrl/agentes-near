/** How long the floating date stays once scrolling stops. */
export const DATE_PILL_IDLE_MS = 1200;

/**
 * The day of what is at the top of a scrolled list: the last day divider (`[data-day]`) at or above the list's top
 * edge. Null above the first one, where the conversation starts with its greeting and cards, which have no day (a date
 * there would float over them), and with none.
 */
export function dayAtTop(list: HTMLElement): string | null {
  const edge = list.getBoundingClientRect().top;
  let day: string | null = null;
  for (const divider of list.querySelectorAll<HTMLElement>("[data-day]")) {
    if (divider.getBoundingClientRect().top > edge + 1) return day;
    day = divider.dataset.day ?? day;
  }
  return day;
}
