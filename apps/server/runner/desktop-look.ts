import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentScope, DESKTOP_SIZE } from "@agenteschat/adapters/machine-protocol";
import MARK_BASE64 from "./assets/desktop-mark.png.b64" with { type: "text" };
import WALLPAPER_BASE64 from "./assets/desktop-wallpaper.png.b64" with { type: "text" };
import KEEPER_SOURCE from "./desktop-keeper.py" with { type: "text" };
import { shQuote } from "./install-script";
import { xmlEscape, xmlUnescape } from "./xml";

/**
 * The agents' desktops' own look (ADR 0058 §15): the agentes.chat wallpaper and a dock floating at the bottom
 * center (the mark, which opens the apps menu, then Browser, Files and Terminal), one workspace, no top panel and
 * no desktop icons, Orchis's light theme where it is installed.
 *
 * - It is XFCE's own settings, written into the desktop session's HOME only (the agent's own home in system
 *   mode, `<agent folder>/.agentes/home` otherwise), by the agent's own process (`LOOK_SCRIPT`): never the
 *   computer's settings, so a self-hosted computer's own desktop stays as it is.
 * - Versioned: the HOME's marker names the look written there. A desktop gets it at its first start, and again
 *   once when anything it writes changes (its version, the theme or dock the computer has, the HOME's own path,
 *   the agent's name, how Browser reaches the runner); what a person changes in between stays until then. One
 *   already running gets it in place (`lookCommand`'s live mode, from desktop-session.ts), its windows untouched.
 * - The dock is xfce4-docklike-plugin where it is installed, so an app's windows show on its own launcher; else
 *   the panel's own launchers, then a button for each window. Desktop use (ADR 0062) reads the panel's own
 *   plugins only: docklike runs in a process of its own, outside what the agent reads of the screen.
 * - Browser, Files and Terminal are desktop entries of the look's own (`agentes-*.desktop`), on the dock and at
 *   the top of the apps menu, in place of XFCE's generic Terminal Emulator and File Manager. Their names are only
 *   English: the desktop session runs in `C.UTF-8` (`desktop-session.ts`), where a translated name never shows.
 * - The terminal's prompt and title show the agent's name, where bash's own show its system user and the
 *   computer's hostname, and each command goes to the history file as it runs (ADR 0168).
 * - The desktop's keeper (`desktop-keeper.py`, ADR 0168) starts with the session (XDG autostart): it lists the app
 *   windows open there, which the runner opens again after the computer restarted or moved. A desktop that takes a
 *   new look while it runs starts it too.
 */

/** Bumped whenever what `lookFiles` writes changes. */
export const LOOK_VERSION = 7;

/** Orchis's light theme (GTK and xfwm4), else GTK's Adwaita and xfwm4's Default. */
export type LookTheme = "orchis" | "stock";

/** xfce4-docklike-plugin, else the panel's own launchers and window buttons. */
export type LookDock = "docklike" | "panel";

const TRIPLETS = ["x86_64-linux-gnu", "aarch64-linux-gnu"];
const ORCHIS = "/usr/share/themes/Orchis-Light/xfwm4/themerc";
/** Orchis's window buttons are SVG files: without gdk-pixbuf's SVG loader, windows would have no close button. */
const SVG_LOADERS = TRIPLETS.flatMap((triplet) =>
  ["libpixbufloader_svg.so", "libpixbufloader-svg.so"].map(
    (file) => `/usr/lib/${triplet}/gdk-pixbuf-2.0/2.10.0/loaders/${file}`,
  ),
);
const DOCKLIKE = "/usr/share/xfce4/panel/plugins/docklike.desktop";
const DOCKLIKE_MODULES = TRIPLETS.map((triplet) => `/usr/lib/${triplet}/xfce4/panel/plugins/libdocklike.so`);

export const lookTheme = (exists: (path: string) => boolean): LookTheme =>
  exists(ORCHIS) && SVG_LOADERS.some(exists) ? "orchis" : "stock";

export const lookDock = (exists: (path: string) => boolean): LookDock =>
  exists(DOCKLIKE) && DOCKLIKE_MODULES.some(exists) ? "docklike" : "panel";

/** What a desktop's look depends on besides its HOME. */
export interface LookOptions {
  theme: LookTheme;
  dock: LookDock;
  /** The terminal's prompt and title show its name. */
  agent: Pick<AgentScope, "name" | "handle">;
  /** The session's shell (`SHELL`): the prompt is bash's, so any other shell keeps its own. */
  shell: string;
  /** What Browser runs: this runner's `desktop-browser` with the desktop's socket (`desktop-browser.ts`). */
  browser: string[];
  /** The computer's shared folder (ADR 0115): a bookmark in the file manager's side pane. */
  shared?: string | null;
}

/** The agent's name as its desktop shows it: the name viewers see, the terminal's prompt. */
export const desktopName = (agent: Pick<AgentScope, "name" | "handle">) =>
  (agent.name || agent.handle)
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 60) || "agent";

/** The look's own files and its marker, under HOME. */
export const LOOK_DIR = ".local/share/agentes";
export const LOOK_MARKER = `${LOOK_DIR}/look`;
/** The desktop's keeper (ADR 0168), its settings, and the list of windows it keeps (`desktop-session.ts` reads it). */
export const KEEPER_FILE = `${LOOK_DIR}/keeper.py`;
export const KEEPER_SETTINGS = `${LOOK_DIR}/keeper.json`;
export const KEEPER_STATE = ".local/state/agentes/windows.json";
const KEEPER_AUTOSTART = ".config/autostart/agentes-keeper.desktop";
/** XFCE's settings files (xfconf's channels), under HOME. */
const XFCONF = ".config/xfce4/xfconf/xfce-perchannel-xml";

/** The agent's Chrome on its desktop has this window class (`browser.ts`), so the dock shows it on Browser. */
export const BROWSER_WM_CLASS = "agentes-browser";
/**
 * The icon theme's globe, next to its Files and Terminal icons. Not its web browser's (`org.xfce.webbrowser`, a link
 * to `web-browser`): that globe has a mouse pointer drawn into it, which reads as a stray pointer on the dock.
 * elementary-xfce has this one at every size, 16 to 128 px, in 0.16 to 0.21 (Ubuntu 22.04 and 24.04, Debian 12
 * and 13).
 */
export const BROWSER_ICON = "applications-internet";
/**
 * Browser's notes (`desktop-browser.ts`) have window classes of their own: with Browser's, docklike would show them
 * on Browser, and a click there would only raise or hide the note, never reach the runner, where it is told `busy`
 * while the browser opens (the wait) or tries again (the one that says why it didn't open).
 */
export const WAIT_WM_CLASS = "agentes-wait";
export const NOTE_WM_CLASS = "agentes-note";
export const NOTE_ICON = "dialog-warning";

/**
 * 1280×900, the exact desktop size: shown 1:1, its logo centered on the dock's line below maximized windows. The
 * images are base64 text (`assets/*.png.b64`, written next to the PNGs by docs/design/desktop/render.sh): Bun's
 * text loader inlines them in the one-file runner, and would mangle a PNG's bytes.
 */
const WALLPAPER = Buffer.from(WALLPAPER_BASE64, "base64");
/** The favicon at the dock's icon size: the same mark as the wallpaper's logo. */
const MARK = Buffer.from(MARK_BASE64, "base64");

/** The ink of the sky's agents (the wallpaper's logo): the dock's lines and its window bars. */
const INK = "4, 32, 63";
/** The dock's rounded ends; its frame is 1 px. */
const DOCK_RADIUS = 16;
/**
 * The dock's hairline as it shows on its glass, in one colour: the ink at 0.18 over white at 0.88. Where a ring
 * draws it on nothing (docklike's corners), it lands on the wallpaper in the same tone as the dock's own frame.
 */
const HAIRLINE_ON_GLASS = "rgba(205, 210, 217, 0.9)";

/** Browser, Files and Terminal, in the dock's and the menu's order. */
interface DockApp {
  /** Its desktop id, without `.desktop`. */
  id: string;
  name: string;
  exec: string;
  icon: string;
  /** Its windows' WM_CLASS: the dock shows them on its launcher. */
  wmClass: string;
  /** Browser's window is Chrome's, never its command's own: a startup notice would spin until it timed out. */
  notify: boolean;
}

/**
 * One argument of a desktop entry's Exec, as the Desktop Entry spec quotes it: as it is when it has no reserved
 * character, else in double quotes with `"`, `` ` ``, `$` and `\` escaped; then the string's own escape of `\`,
 * and `%` doubled, since it starts a field code.
 */
export const execArg = (arg: string) =>
  (/^[\w@+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/["`$\\]/g, "\\$&")}"`)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "%%");

const dockApps = (browser: string[]): DockApp[] => [
  {
    id: "agentes-browser",
    name: "Browser",
    exec: browser.map(execArg).join(" "),
    icon: BROWSER_ICON,
    wmClass: BROWSER_WM_CLASS,
    notify: false,
  },
  {
    id: "agentes-files",
    name: "Files",
    exec: "thunar",
    icon: "org.xfce.thunar",
    wmClass: "Thunar",
    notify: true,
  },
  {
    id: "agentes-terminal",
    name: "Terminal",
    exec: "xfce4-terminal",
    icon: "org.xfce.terminalemulator",
    wmClass: "Xfce4-terminal",
    notify: true,
  },
];

/** Top level only (X-Xfce-Toplevel): none of the menu's categories lists them a second time. */
const desktopEntry = (app: DockApp) =>
  [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${app.name}`,
    `Exec=${app.exec}`,
    `Icon=${app.icon}`,
    `StartupWMClass=${app.wmClass}`,
    `StartupNotify=${app.notify}`,
    "Categories=X-Xfce-Toplevel;",
    "",
  ].join("\n");

/** A note's entry, out of the menu: docklike shows the note's window with its icon. Opened, it is Browser's command. */
const noteEntry = (browser: DockApp, wmClass: string, icon: string) =>
  [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${browser.name}`,
    `Exec=${browser.exec}`,
    `Icon=${icon}`,
    `StartupWMClass=${wmClass}`,
    "StartupNotify=false",
    "NoDisplay=true",
    "",
  ].join("\n");

/**
 * Plugin ids: they name their widgets (`#separator-2` in gtk.css), the panel's launchers' folders (`launcher-3`)
 * and docklike's settings (`docklike-7.rc`). Files and Terminal keep the ids they had before Browser came, so a
 * desktop that had the earlier look reuses their folders.
 */
const LAUNCHERS = [
  { plugin: 6, file: "browser.desktop" },
  { plugin: 3, file: "files.desktop" },
  { plugin: 4, file: "terminal.desktop" },
];
const TASKLIST = 5;
const DOCKLIKE_PLUGIN = 7;

const launcherPlugin = ({ plugin, file }: (typeof LAUNCHERS)[number]) =>
  `    <property name="plugin-${plugin}" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="${file}"/>
      </property>
    </property>
`;

/** The panel's own: a launcher each, then a button for each window, flat, no labels. */
const PANEL_PLUGINS = `${LAUNCHERS.map(launcherPlugin).join("")}    <property name="plugin-${TASKLIST}" type="string" value="tasklist">
      <property name="show-labels" type="bool" value="false"/>
      <property name="grouping" type="bool" value="false"/>
      <property name="include-all-workspaces" type="bool" value="false"/>
      <property name="show-handle" type="bool" value="false"/>
      <property name="flat-buttons" type="bool" value="true"/>
      <property name="window-scrolling" type="bool" value="false"/>
      <property name="sort-order" type="uint" value="0"/>
    </property>
`;

/**
 * The dock: floating (p=0) with its center 31 px above the bottom, so it stays centered as windows come and go.
 * It reserves no room of its own: xfwm4's margin_bottom keeps maximized windows 60 px above the bottom. No gap
 * before the windows: a separator there would also stand in the empty dock, off its center.
 */
const panel = (home: string, dock: LookDock) => {
  const ids = dock === "docklike" ? [1, 2, DOCKLIKE_PLUGIN] : [1, 2, ...LAUNCHERS.map((l) => l.plugin), TASKLIST];
  const own =
    dock === "docklike"
      ? `    <property name="plugin-${DOCKLIKE_PLUGIN}" type="string" value="docklike"/>\n`
      : PANEL_PLUGINS;
  return `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="false"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=0;x=${DESKTOP_SIZE.width / 2};y=${DESKTOP_SIZE.height - 31}"/>
      <property name="length" type="uint" value="1"/>
      <property name="length-adjust" type="bool" value="true"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="48"/>
      <property name="icon-size" type="uint" value="32"/>
      <property name="plugin-ids" type="array">
${ids.map((id) => `        <value type="int" value="${id}"/>`).join("\n")}
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu">
      <property name="button-icon" type="string" value="${xmlEscape(`${home}/${LOOK_DIR}/mark.png`)}"/>
      <property name="show-button-title" type="bool" value="false"/>
    </property>
    <property name="plugin-2" type="string" value="separator">
      <property name="style" type="uint" value="1"/>
    </property>
${own}  </property>
</channel>
`;
};

/**
 * docklike's own settings: Browser, Files and Terminal pinned; a click on one with windows brings them up (or
 * down), a middle click opens another (1; 0 would close them all); icons at the mark's 32 px. Its own marks off
 * (style 5): it draws them at the very bottom of its buttons, inside the margin the look gives them, which GTK
 * leaves out of what a button draws. The look's CSS marks the apps with windows instead (`GTK_CSS`).
 */
const dockSettings = (apps: DockApp[]) => `[user]
pinned=${apps.map((app) => `${app.id};`).join("")}
forceIconSize=true
iconSize=32
noWindowsListIfSingle=true
showPreviews=false
middleButtonBehavior=1
indicatorStyle=5
inactiveIndicatorStyle=5
`;

/** One workspace, the wallpaper zoomed (an image of the screen's size: 1:1) over the bottom band's tone, no icons. */
const backdrop = (home: string) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-desktop" version="1.0">
  <property name="last-settings-migration-version" type="uint" value="1"/>
  <property name="backdrop" type="empty">
    <property name="single-workspace-mode" type="bool" value="true"/>
    <property name="single-workspace-number" type="int" value="0"/>
    <property name="screen0" type="empty">
      <property name="monitorVNC-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="color-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0.811765"/>
            <value type="double" value="0.901961"/>
            <value type="double" value="1.000000"/>
            <value type="double" value="1.000000"/>
          </property>
          <property name="image-style" type="int" value="5"/>
          <property name="last-image" type="string" value="${xmlEscape(`${home}/${LOOK_DIR}/wallpaper.png`)}"/>
        </property>
      </property>
    </property>
  </property>
  <property name="desktop-icons" type="empty">
    <property name="style" type="int" value="0"/>
  </property>
</channel>
`;

/**
 * vblank_mode off as desktop-session.ts's PREPARE keeps it; no shadow around the dock's square window. New windows
 * centered: xfwm4 centers only those under `placement_ratio` percent of the screen and fits the rest into corners.
 */
const windowManager = (theme: LookTheme) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="vblank_mode" type="string" value="off"/>
    <property name="theme" type="string" value="${theme === "orchis" ? "Orchis-Light" : "Default"}"/>
    <property name="title_font" type="string" value="Noto Sans Bold 10"/>
    <property name="title_alignment" type="string" value="center"/>
    <property name="button_layout" type="string" value="|HMC"/>
    <property name="workspace_count" type="int" value="1"/>
    <property name="placement_mode" type="string" value="center"/>
    <property name="placement_ratio" type="int" value="100"/>
    <property name="show_dock_shadow" type="bool" value="false"/>
    <property name="show_frame_shadow" type="bool" value="true"/>
    <property name="show_popup_shadow" type="bool" value="true"/>
    <property name="tile_on_move" type="bool" value="true"/>
    <property name="margin_bottom" type="int" value="60"/>
  </property>
</channel>
`;

/** Grayscale antialiasing: subpixel colors only add noise to what viewers receive. */
const settings = (theme: LookTheme) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="${theme === "orchis" ? "Orchis-Light" : "Adwaita"}"/>
    <property name="IconThemeName" type="string" value="elementary-xfce"/>
  </property>
  <property name="Xft" type="empty">
    <property name="Antialias" type="int" value="1"/>
    <property name="Hinting" type="int" value="1"/>
    <property name="HintStyle" type="string" value="hintslight"/>
    <property name="RGBA" type="string" value="none"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="FontName" type="string" value="Noto Sans 10"/>
    <property name="MonospaceFontName" type="string" value="Noto Mono 10"/>
    <property name="CursorThemeName" type="string" value="Adwaita"/>
    <property name="DecorationLayout" type="string" value="menu:minimize,maximize,close"/>
  </property>
</channel>
`;

/** The prompt's own startup file, under HOME. */
const BASHRC = `${LOOK_DIR}/bashrc`;

/**
 * The design system's dark tokens, also for the 16 colors programs print in (the shell's prompt among them). With
 * bash, each new terminal runs it on the look's own startup file (`BASHRC`).
 */
const terminal = (home: string, bash: string | null) => `<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-terminal" version="1.0">
  <property name="color-use-theme" type="bool" value="false"/>
  <property name="color-background" type="string" value="#1c1c1b"/>
  <property name="color-foreground" type="string" value="#efefec"/>
  <property name="color-cursor-use-default" type="bool" value="false"/>
  <property name="color-cursor" type="string" value="#5aa8ff"/>
  <property name="color-bold-use-default" type="bool" value="true"/>
  <property name="color-palette" type="string" value="#242423;#f08a80;#5fc48a;#e0a84a;#5aa8ff;#c9a2f5;#6cc7d6;#d6d6d2;#71716c;#f5a69e;#7fd3a2;#ebbd6a;#8cc3ff;#d9bdfa;#92d8e3;#efefec"/>
${
  bash
    ? `  <property name="run-custom-command" type="bool" value="true"/>
  <property name="custom-command" type="string" value="${xmlEscape(`${shQuote(bash)} --rcfile ${shQuote(`${home}/${BASHRC}`)}`)}"/>
`
    : ""
}</channel>
`;

/** A Terminal the runner opens again (`desktop-session.ts`) carries its one-line note in this variable. */
export const TERMINAL_NOTE_ENV = "AGENTES_TERMINAL_NOTE";

/**
 * `~/.bashrc` first (`--rcfile` reads this file in its place; Debian's and Ubuntu's bash still read
 * `/etc/bash.bashrc` before it), then the agent's name, green, in the prompt and in the window's title. The prompt
 * names it through a variable it expands, never in its own text, so no character of the name runs anything or
 * takes a prompt escape. A Terminal opened again says its note (`TERMINAL_NOTE_ENV`) above its first prompt, once.
 * Each command goes to the history file at the next prompt (`history -a`), so a shell killed with its computer keeps
 * what was typed.
 */
const bashrc = (name: string) =>
  [
    "# The desktop's Terminal: the shell's own setup, then the agent's name in the prompt and the window's title.",
    "[ -r ~/.bashrc ] && . ~/.bashrc",
    `AGENTES_NAME=${shQuote(name)}`,
    "shopt -s promptvars",
    String.raw`PS1='\[\e]0;$AGENTES_NAME: \w\a\]\[\e[1;32m\]$AGENTES_NAME\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '`,
    `[ -n "\${${TERMINAL_NOTE_ENV}-}" ] && printf '%s\\n\\n' "$${TERMINAL_NOTE_ENV}"; unset ${TERMINAL_NOTE_ENV}`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameters, not a template literal
    'PROMPT_COMMAND="history -a${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
    "",
  ].join("\n");

/** The keeper's settings: which windows are the agent's Chrome and which are Browser's notes. */
const keeperSettings = () =>
  `${JSON.stringify({ browserClass: BROWSER_WM_CLASS, notes: [WAIT_WM_CLASS, NOTE_WM_CLASS] }, null, 2)}\n`;

/** XFCE starts the keeper with the session, on its display and with its environment. */
const keeperAutostart = (home: string) =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=agentes.chat",
    "Comment=Lists the windows open on this desktop, to open them again after its computer restarted or moved",
    `Exec=python3 -I ${execArg(`${home}/${KEEPER_FILE}`)} ${execArg(`${home}/${KEEPER_SETTINGS}`)}`,
    "NoDisplay=true",
    "",
  ].join("\n");

const GTK_CSS = `/* The dock: the design system's glass, rounded, with a hairline that still shows on the sky's pale band. */
.xfce4-panel.background {
  background-color: rgba(255, 255, 255, 0.88);
  background-image: none;
  border: 1px solid rgba(${INK}, 0.18);
  border-radius: ${DOCK_RADIUS}px;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.9);
}

/*
 * docklike draws in a window of its own process that fills the dock's right end inside the frame's 1 px, and the
 * dock's own drawing never shows under it: there that window is the dock. The glass and its light, no frame of its
 * own; its right corners rounded like the dock's, and the hairline around them a 1 px ring outside it (only the
 * corners fall inside the window; the dock draws the straight edges itself), in the hairline's tone over the glass,
 * since the ring lies on the wallpaper. GTK's CSS can't tell docklike's window from another plugin's that runs in a
 * process of its own: one added to the dock gets these corners too.
 */
#XfcePanelWindowWrapper.xfce4-panel.background {
  border: none;
  border-radius: 0 ${DOCK_RADIUS - 1}px ${DOCK_RADIUS - 1}px 0;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.9), 0 0 0 1px ${HAIRLINE_ON_GLASS};
}

.xfce4-panel.background button {
  background-image: none;
  background-color: transparent;
  border: none;
  border-radius: 10px;
  box-shadow: none;
  margin: 4px 2px;
  padding: 0;
}

.xfce4-panel.background button:hover {
  background-color: rgba(${INK}, 0.07);
}

.xfce4-panel.background button:active,
.xfce4-panel.background button:checked,
.xfce4-panel.background button.active_group {
  background-color: rgba(${INK}, 0.11);
}

#separator-2 {
  color: rgba(${INK}, 0.16);
}

/* A minimized window's icon as bright as the others' (faded, it reads as disabled). */
.tasklist {
  -XfceTasklist-minimized-icon-lucency: 100;
}

/*
 * A short bar under the icon of each app with windows, a longer, darker one under the active window's: docklike's
 * launchers say which by their classes, the panel's own dock has a button for each window.
 */
.xfce4-panel.background .tasklist button,
.xfce4-panel.background button.open_group {
  background-image: linear-gradient(rgba(${INK}, 0.65), rgba(${INK}, 0.65));
  background-size: 8px 3px;
  background-repeat: no-repeat;
  background-position: 50% 100%;
}

.xfce4-panel.background .tasklist button:checked,
.xfce4-panel.background button.active_group {
  background-image: linear-gradient(rgb(${INK}), rgb(${INK}));
  background-size: 16px 3px;
}
`;

/**
 * The apps menu: XFCE's own in a layout of ours. Browser, Files and Terminal first; then the menus of whatever
 * else is installed, then Settings, so no separator is left alone at the end when there are none. Thunar, its bulk
 * renamer and XFCE's own terminal leave Accessories and System, which listed them again: those menus show only
 * with something else in them. Run Program, About and Log Out are missing or hidden here.
 */
const menu = (
  apps: DockApp[],
) => `<!DOCTYPE Menu PUBLIC "-//freedesktop//DTD Menu 1.0//EN" "http://www.freedesktop.org/standards/menu-spec/1.0/menu.dtd">

<Menu>
  <Name>Xfce</Name>
  <MergeFile type="parent"/>
  <Layout>
${apps.map((app) => `    <Filename>${app.id}.desktop</Filename>`).join("\n")}
    <Separator/>
    <Merge type="all"/>
    <Menuname>Settings</Menuname>
  </Layout>
  <Menu>
    <Name>Accessories</Name>
    <Exclude>
      <Filename>thunar.desktop</Filename>
      <Filename>thunar-bulk-rename.desktop</Filename>
    </Exclude>
  </Menu>
  <Menu>
    <Name>System</Name>
    <Exclude>
      <Filename>thunar.desktop</Filename>
      <Filename>xfce4-terminal.desktop</Filename>
    </Exclude>
  </Menu>
</Menu>
`;

/**
 * Out of the apps menu: XFCE's web browser and mail reader, which open nothing here, Log Out (it ends the
 * desktop), and its generic Terminal Emulator and File Manager, which Terminal and Files replace.
 */
const HIDDEN: Record<string, string> = {
  "xfce4-web-browser": "Web Browser",
  "xfce4-mail-reader": "Mail Reader",
  "xfce4-session-logout": "Log Out",
  "xfce4-terminal-emulator": "Terminal Emulator",
  "xfce4-file-manager": "File Manager",
};
const hidden = (name: string) => `[Desktop Entry]\nType=Application\nName=${name}\nHidden=true\n`;

/**
 * XFCE's Internet menu (there once some other network app is installed) has Browser's globe for its icon: it gets
 * the theme's network sphere instead, a purple one, at every size in elementary-xfce 0.16 to 0.21. The file takes
 * the place of XFCE's own (`xfce-network.directory`), with its name and comment.
 */
const INTERNET_MENU =
  "[Desktop Entry]\nVersion=1.0\nType=Directory\nName=Internet\nComment=Applications for Internet access\nIcon=preferences-system-network\n";

interface LookFile {
  /** Under HOME. */
  path: string;
  data: Buffer;
}

/** Every file of the look, by its path under HOME. */
export function lookFiles(home: string, o: LookOptions): LookFile[] {
  const apps = dockApps(o.browser);
  const bash = path.basename(o.shell) === "bash" ? o.shell : null;
  const dock: [string, string][] =
    o.dock === "docklike"
      ? [[`.config/xfce4/panel/docklike-${DOCKLIKE_PLUGIN}.rc`, dockSettings(apps)]]
      : LAUNCHERS.map((l, i) => [
          `.config/xfce4/panel/launcher-${l.plugin}/${l.file}`,
          desktopEntry(apps[i] as DockApp),
        ]);
  const files: [string, string | Buffer][] = [
    [`${XFCONF}/xfce4-panel.xml`, panel(home, o.dock)],
    [`${XFCONF}/xfce4-desktop.xml`, backdrop(home)],
    [`${XFCONF}/xfwm4.xml`, windowManager(o.theme)],
    [`${XFCONF}/xsettings.xml`, settings(o.theme)],
    [`${XFCONF}/xfce4-terminal.xml`, terminal(home, bash)],
    ...dock,
    [".config/gtk-3.0/gtk.css", GTK_CSS],
    ...(o.shared
      ? [[".config/gtk-3.0/bookmarks", `${pathToFileURL(o.shared).href} Shared\n`] as [string, string]]
      : []),
    [".config/menus/xfce-applications.menu", menu(apps)],
    [".local/share/desktop-directories/xfce-network.directory", INTERNET_MENU],
    ...apps.map((app): [string, string] => [`.local/share/applications/${app.id}.desktop`, desktopEntry(app)]),
    [`.local/share/applications/${WAIT_WM_CLASS}.desktop`, noteEntry(apps[0] as DockApp, WAIT_WM_CLASS, BROWSER_ICON)],
    [`.local/share/applications/${NOTE_WM_CLASS}.desktop`, noteEntry(apps[0] as DockApp, NOTE_WM_CLASS, NOTE_ICON)],
    ...Object.entries(HIDDEN).map(([id, name]): [string, string] => [
      `.local/share/applications/${id}.desktop`,
      hidden(name),
    ]),
    ...(bash ? [[BASHRC, bashrc(desktopName(o.agent))] as [string, string]] : []),
    [KEEPER_FILE, KEEPER_SOURCE],
    [KEEPER_SETTINGS, keeperSettings()],
    [KEEPER_AUTOSTART, keeperAutostart(home)],
    [`${LOOK_DIR}/wallpaper.png`, WALLPAPER],
    [`${LOOK_DIR}/mark.png`, MARK],
  ];
  return files.map(([file, data]) => ({ path: file, data: Buffer.isBuffer(data) ? data : Buffer.from(data) }));
}

/** What the marker says: the look's version, theme and dock, and a hash of every file it writes, paths and all. */
const idOf = (o: LookOptions, files: LookFile[]) => {
  const hash = createHash("sha256");
  for (const f of files) hash.update(f.path).update("\0").update(f.data).update("\0");
  return `${LOOK_VERSION}:${o.theme}:${o.dock}:${hash.digest("hex").slice(0, 16)}`;
};

export const lookId = (home: string, o: LookOptions) => idOf(o, lookFiles(home, o));

const TAG = /<(\/?)(property|value)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g;
const ATTR = /([\w-]+)="([^"]*)"/g;

/** One channel's settings (`lookSettings`), read from the file the look writes for it. */
function channelSettings(xml: string): string[][] {
  const channel = /<channel name="([^"]+)"/.exec(xml)?.[1] ?? "";
  const out: string[][] = [];
  const open: { path: string; type: string; value: string; items: string[] }[] = [];
  const close = () => {
    const p = open.pop();
    if (p?.type === "array") out.push(["-c", channel, "-p", p.path, "-n", "-a", ...p.items]);
    else if (p && p.type !== "empty") out.push(["-c", channel, "-p", p.path, "-n", "-t", p.type, "-s", p.value]);
  };
  for (const [, ending, tag, attrs = "", selfClosing] of xml.matchAll(TAG)) {
    const a = Object.fromEntries([...attrs.matchAll(ATTR)].map(([, k, v]) => [k, xmlUnescape(v ?? "")]));
    if (tag === "value") open.at(-1)?.items.push("-t", a.type ?? "", "-s", a.value ?? "");
    else if (ending) close();
    else {
      open.push({
        path: `${open.at(-1)?.path ?? ""}/${a.name}`,
        type: a.type ?? "empty",
        value: a.value ?? "",
        items: [],
      });
      if (selfClosing) close();
    }
  }
  return out;
}

/** The wallpaper's setting (`backdrop`): the screen's one monitor and workspace. */
const WALLPAPER_SETTING = "/backdrop/screen0/monitorVNC-0/workspace0/last-image";

const settingsOf = (files: LookFile[]) =>
  files
    .flatMap((f) => (f.path.startsWith(`${XFCONF}/`) ? channelSettings(f.data.toString()) : []))
    .flatMap((args) =>
      args[1] === "xfce4-desktop" && args[3] === WALLPAPER_SETTING
        ? [["-c", "xfce4-desktop", "-p", WALLPAPER_SETTING, "-r"], args]
        : [args],
    );

/**
 * The look's xfconf settings for a running session, each as the arguments of the `xfconf-query` call that sets it
 * (made where it isn't there): every property of its channels' files that has a value, an array with each item's
 * type. A running session's xfconfd holds its channels in memory and writes them over their files, and the
 * session's programs (xfwm4, xfsettingsd, xfdesktop, the terminal) follow what it says changed: set through it,
 * they show at once. xfconfd says nothing of a value set again as it was, and xfdesktop loads the wallpaper's
 * image again only when it hears its setting change, where a new look's image keeps its path: that setting is
 * unset right before it is set, so a run stopped part-way doesn't leave the screen without its wallpaper.
 */
export const lookSettings = (home: string, o: LookOptions) => settingsOf(lookFiles(home, o));

/**
 * Run as the agent (`lookCommand`), the files on its stdin, a `<path under HOME> <base64>` line each: unless the
 * marker already names this look, each file is written (0600, its folders 0700) and renamed into place, and the
 * marker last. As the agent's own process it writes nothing the agent couldn't itself: a link the agent made in its
 * home leads only to the agent's own files. What sits at a temporary name goes first and only a plain file is read
 * as the marker, so a pipe left in the home can't hold the desktop's start.
 *
 * Live (`$5`, where the processes are listed: `/proc`), on a desktop that runs, with its `DISPLAY`: between the
 * files and the marker, the settings (`lookSettings`, a line each after the files: the arguments, each ended by a
 * NUL, in base64) go through the session's own xfconfd, on the bus of its session or panel on exactly that display
 * (in single-user mode one user runs every agent's desktop: the display tells them apart), then the panel starts
 * over to read its new settings, gtk.css and docklike's file, which a panel reads only as it starts. That is the
 * panel's D-Bus Terminate, the call `xfce4-panel --restart` makes, which runs the restart from the panel's main
 * loop: its SIGUSR1 runs it inside a plain signal handler (XFCE 4.16 to 4.20), and `--restart` itself opens a
 * dialog on the agent's screen when it fails. The agent's apps and their windows stay as they are. Then the desktop's
 * keeper starts in that session, detached so the look's run doesn't wait on it, where none runs yet (one already
 * there holds its lock: ADR 0168). A marker that
 * names this look already means the session shows it (it started with it, or took it here), and nothing is set
 * again. A run stopped part-way leaves the marker as it was, so the desktop's next start writes every file again,
 * over what xfconfd wrote back. Exits 1: a file wasn't written; 2: no session on that display; 3: a setting wasn't
 * taken; 4: the panel didn't start over.
 */
export const LOOK_SCRIPT = [
  'h=$1 v=$2 m="$1/$3" n=$4 && umask 077',
  '[ -f "$m" ] && [ "$(cat "$m")" = "$v" ] && exit 0',
  'while [ "$n" -gt 0 ] && read -r p b; do f="$h/$p" && mkdir -p "$(dirname "$f")" && rm -f "$f.new" && printf %s "$b" | base64 -d > "$f.new" && mv -f "$f.new" "$f" || exit 1; n=$((n - 1)); done',
  '[ "$n" -eq 0 ] || exit 1',
  'if [ -n "$5" ]; then',
  "  s= q=",
  '  for d in "$5"/[0-9]*; do',
  '    read -r c 2>/dev/null < "$d/comm" || continue',
  "    case $c in xfce4-session|xfce4-panel) ;; *) continue ;; esac",
  String.raw`    e=$(tr '\0' '\n' 2>/dev/null < "$d/environ") || continue`,
  String.raw`    printf '%s\n' "$e" | grep -qxF "DISPLAY=$DISPLAY" || continue`,
  '    [ "$c" = xfce4-panel ] && q=1',
  String.raw`    [ -n "$s" ] || s=$(printf '%s\n' "$e" | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p')`,
  "  done",
  '  [ -n "$DISPLAY" ] && [ -n "$s" ] || exit 2',
  '  export DBUS_SESSION_BUS_ADDRESS="$s"',
  '  while read -r l; do printf %s "$l" | base64 -d | xargs -0 xfconf-query || exit 3; done',
  '  [ -z "$q" ] || dbus-send --session --print-reply --dest=org.xfce.Panel /org/xfce/Panel org.xfce.Panel.Terminate boolean:true > /dev/null || exit 4',
  `  setsid -f python3 -I "$h/${KEEPER_FILE}" "$h/${KEEPER_SETTINGS}" < /dev/null > /dev/null 2>&1 || true`,
  "fi",
  'mkdir -p "$(dirname "$m")" && rm -f "$m.new" && printf "%s\\n" "$v" > "$m.new" && mv -f "$m.new" "$m"',
].join("\n");

/**
 * `sh -c LOOK_SCRIPT agentes-look <HOME> <look id> <marker> <file count> [/proc]`, the files (live, then the
 * settings) as its input, and the look's id. Not as arguments: in system mode systemd-run names the agent's scope
 * after its command line, and the journal logs it.
 */
export function lookCommand(home: string, o: LookOptions, live = false): { argv: string[]; input: string; id: string } {
  const files = lookFiles(home, o);
  const id = idOf(o, files);
  const lines = files.map((f) => `${f.path} ${f.data.toString("base64")}\n`);
  if (live) {
    for (const args of settingsOf(files)) {
      lines.push(`${Buffer.from(args.map((a) => `${a}\0`).join("")).toString("base64")}\n`);
    }
  }
  return {
    argv: [
      "/bin/sh",
      "-c",
      LOOK_SCRIPT,
      "agentes-look",
      home,
      id,
      LOOK_MARKER,
      String(files.length),
      ...(live ? ["/proc"] : []),
    ],
    input: lines.join(""),
    id,
  };
}
