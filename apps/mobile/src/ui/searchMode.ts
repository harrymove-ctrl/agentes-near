/**
 * The search field's two modes, like iOS's search bar: at rest the screen shows its list; focused or with
 * words it shows results and a "Cancelar" button that brings the list back.
 */

/** Whether the cancel button shows: forced by `showCancel`, else while focused or with words. */
export const searchCancelVisible = (o: { focused: boolean; value: string; showCancel?: boolean }) =>
  o.showCancel ?? (o.focused || o.value.length > 0);

/** Whether a screen shows search results instead of its list: while the field is focused or has words. */
export const searchShowsResults = (o: { focused: boolean; value: string }) => o.focused || o.value.trim().length > 0;
