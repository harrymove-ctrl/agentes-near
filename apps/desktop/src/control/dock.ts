/** Preferences › General › "Show in the Dock" (on by default, like Slack; dock.rs). */
export const DOCK_PREF = "dock";

/** Preferences › General › "Show in the menu bar" (a Mac): unset, the icon follows what this computer does. */
export const MENU_BAR_PREF = "menuBar";

/**
 * The menu bar icon on a Mac: the person's choice, else only while this computer works for agents; and always
 * while the Dock icon is off, so the app keeps one of the two.
 */
export const menuBarShown = (pref: boolean | null, dock: boolean, works: boolean) => !dock || (pref ?? works);
