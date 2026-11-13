import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DESKTOP_SIZE } from "@agenteschat/adapters/machine-protocol";
import {
  BROWSER_WM_CLASS,
  desktopName,
  execArg,
  KEEPER_FILE,
  KEEPER_SETTINGS,
  LOOK_DIR,
  LOOK_MARKER,
  LOOK_SCRIPT,
  LOOK_VERSION,
  type LookOptions,
  lookCommand,
  lookDock,
  lookFiles,
  lookId,
  lookSettings,
  lookTheme,
  TERMINAL_NOTE_ENV,
} from "../../runner/desktop-look";
import { removeDirs, tempDir } from "./helpers";

// Each case runs real shell scripts and waits on fake desktop processes: under a full-suite load they pass 5 s.
setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const ASSETS = path.join(import.meta.dir, "..", "..", "runner", "assets");
const XFCONF = ".config/xfce4/xfconf/xfce-perchannel-xml";
const RUNNER = ["/opt/agentes-runner/bin/bun", "/opt/agentes-runner/agentes-runner.mjs"];
const SOCKET = "/run/agentes-desktop/20001/browser.sock";

/** A desktop's look as system mode writes it for Ada (bash, the panel's own dock, the stock theme), changed by `over`. */
const look = (over: Partial<LookOptions> = {}): LookOptions => ({
  theme: "stock",
  dock: "panel",
  agent: { handle: "ada", name: "Ada" },
  shell: "/bin/bash",
  browser: [...RUNNER, "desktop-browser", SOCKET],
  ...over,
});

const fileOf = (home: string, o: LookOptions, name: string) => {
  const found = lookFiles(home, o).find((f) => f.path === name);
  if (!found) throw new Error(`no ${name}`);
  return found.data;
};
const textOf = (home: string, o: LookOptions, name: string) => fileOf(home, o, name).toString();
const paths = (home: string, o: LookOptions) => lookFiles(home, o).map((f) => f.path);

/** A PNG's size from its header (IHDR). */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** The look's script as the runner runs it (as the agent there), in `home`; null when it didn't end within 5 s. */
function apply(home: string, o: LookOptions = look(), cut = 0) {
  const { argv, input } = lookCommand(home, o);
  const run = spawnSync(argv[0] as string, argv.slice(1), {
    env: { PATH: "/usr/bin:/bin" },
    input: input.slice(0, input.length - cut),
    timeout: 5000,
  });
  return run.status;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full, base) : [path.relative(base, full)];
  });
}

/** The plugins of the dock's panel, in its order, as `<plugin>-<id>`. */
function dockPlugins(panel: string) {
  const names = new Map(
    [...panel.matchAll(/<property name="plugin-(\d+)" type="string" value="([a-z]+)"/g)].map(([, id, name]) => [
      id,
      name,
    ]),
  );
  const ids = /name="plugin-ids" type="array">([\s\S]*?)<\/property>/.exec(panel)?.[1] ?? "";
  return [...ids.matchAll(/value="(\d+)"/g)].map(([, id]) => `${names.get(id ?? "")}-${id}`);
}

test("the dock without docklike: the mark's apps menu, Browser, Files and Terminal, then the windows; floating at the bottom center", () => {
  const home = "/home/ag-01a142cb";
  const panel = textOf(home, look(), `${XFCONF}/xfce4-panel.xml`);
  // Files and Terminal keep the folders they had before Browser came.
  expect(dockPlugins(panel)).toEqual([
    "applicationsmenu-1",
    "separator-2",
    "launcher-6",
    "launcher-3",
    "launcher-4",
    "tasklist-5",
  ]);
  expect(panel).toContain(`<property name="button-icon" type="string" value="${home}/.local/share/agentes/mark.png"/>`);
  expect(panel).toContain(`value="p=0;x=${DESKTOP_SIZE.width / 2};y=${DESKTOP_SIZE.height - 31}"`);
  expect(panel).toContain('<property name="show-labels" type="bool" value="false"/>');
  expect(panel).not.toContain("docklike");
  // The panel's own launchers carry the names an agent reads on the dock's buttons (ADR 0062).
  const launcher = (dir: string) => textOf(home, look(), `.config/xfce4/panel/${dir}`);
  expect(launcher("launcher-6/browser.desktop")).toContain("Name=Browser\n");
  expect(launcher("launcher-3/files.desktop")).toContain("Name=Files\nExec=thunar\n");
  expect(launcher("launcher-4/terminal.desktop")).toContain("Name=Terminal\nExec=xfce4-terminal\n");
  for (const app of ["browser", "files", "terminal"]) {
    expect(launcher(`launcher-${{ browser: 6, files: 3, terminal: 4 }[app]}/${app}.desktop`)).toBe(
      textOf(home, look(), `.local/share/applications/agentes-${app}.desktop`),
    );
  }
  // Maximized windows stop above it: it floats, so it reserves no room itself. New windows open centered.
  const wm = textOf(home, look(), `${XFCONF}/xfwm4.xml`);
  expect(wm).toContain('<property name="margin_bottom" type="int" value="60"/>');
  expect(wm).toContain('<property name="placement_mode" type="string" value="center"/>');
  expect(wm).toContain('<property name="placement_ratio" type="int" value="100"/>');
  expect(textOf(home, look(), ".config/gtk-3.0/gtk.css")).toContain(".xfce4-panel.background {");
});

test("the dock with docklike: Browser, Files and Terminal pinned, each app's windows on its own launcher", () => {
  const home = "/home/ag-01a142cb";
  const o = look({ dock: "docklike" });
  const panel = textOf(home, o, `${XFCONF}/xfce4-panel.xml`);
  expect(dockPlugins(panel)).toEqual(["applicationsmenu-1", "separator-2", "docklike-7"]);
  expect(panel).not.toContain('value="launcher"');
  expect(panel).not.toContain('value="tasklist"');
  // The whole panel, as the desktop reads it.
  expect(panel).toBe(`<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="false"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=0;x=640;y=869"/>
      <property name="length" type="uint" value="1"/>
      <property name="length-adjust" type="bool" value="true"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="48"/>
      <property name="icon-size" type="uint" value="32"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="7"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu">
      <property name="button-icon" type="string" value="/home/ag-01a142cb/.local/share/agentes/mark.png"/>
      <property name="show-button-title" type="bool" value="false"/>
    </property>
    <property name="plugin-2" type="string" value="separator">
      <property name="style" type="uint" value="1"/>
    </property>
    <property name="plugin-7" type="string" value="docklike"/>
  </property>
</channel>
`);
  expect(textOf(home, o, ".config/xfce4/panel/docklike-7.rc")).toBe(
    [
      "[user]",
      "pinned=agentes-browser;agentes-files;agentes-terminal;",
      "forceIconSize=true",
      "iconSize=32",
      "noWindowsListIfSingle=true",
      "showPreviews=false",
      "middleButtonBehavior=1",
      // Its own marks fall in its buttons' margin, which GTK doesn't draw: the look's CSS marks them instead.
      "indicatorStyle=5",
      "inactiveIndicatorStyle=5",
      "",
    ].join("\n"),
  );
  // No launcher folders: docklike's own launchers are the menu's entries, matched to windows by their class.
  expect(paths(home, o).some((p) => p.includes("/launcher-"))).toBe(false);
  for (const [app, wmClass] of [
    ["browser", BROWSER_WM_CLASS],
    ["files", "Thunar"],
    ["terminal", "Xfce4-terminal"],
  ]) {
    expect(textOf(home, o, `.local/share/applications/agentes-${app}.desktop`)).toContain(
      `\nStartupWMClass=${wmClass}\n`,
    );
  }
});

test("the dock's CSS: glass and a hairline rounded at both ends, a mark under each app with windows", () => {
  const css = textOf("/home/ag-01a142cb", look({ dock: "docklike" }), ".config/gtk-3.0/gtk.css");
  expect(textOf("/home/ag-01a142cb", look(), ".config/gtk-3.0/gtk.css")).toBe(css);
  // docklike's window fills the dock's right end inside its 1 px frame: its corners' radius is the dock's less that
  // pixel, and the ring around them is where the frame's hairline goes, in the tone the frame shows: the ink at 0.18
  // over the glass's white at 0.88 is one colour, at 1 - 0.12 × 0.82 ≈ 0.9 alpha. docklike's launchers carry
  // `open_group` while their app has windows and `active_group` while one of them is active; the panel's own dock
  // has a button for each window instead, checked while it is active.
  expect([4, 32, 63].map((ink) => Math.round((ink * 0.18 + 255 * 0.88 * 0.82) / (1 - 0.12 * 0.82)))).toEqual([
    205, 210, 217,
  ]);
  expect(
    css,
  ).toBe(`/* The dock: the design system's glass, rounded, with a hairline that still shows on the sky's pale band. */
.xfce4-panel.background {
  background-color: rgba(255, 255, 255, 0.88);
  background-image: none;
  border: 1px solid rgba(4, 32, 63, 0.18);
  border-radius: 16px;
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
  border-radius: 0 15px 15px 0;
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.9), 0 0 0 1px rgba(205, 210, 217, 0.9);
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
  background-color: rgba(4, 32, 63, 0.07);
}

.xfce4-panel.background button:active,
.xfce4-panel.background button:checked,
.xfce4-panel.background button.active_group {
  background-color: rgba(4, 32, 63, 0.11);
}

#separator-2 {
  color: rgba(4, 32, 63, 0.16);
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
  background-image: linear-gradient(rgba(4, 32, 63, 0.65), rgba(4, 32, 63, 0.65));
  background-size: 8px 3px;
  background-repeat: no-repeat;
  background-position: 50% 100%;
}

.xfce4-panel.background .tasklist button:checked,
.xfce4-panel.background button.active_group {
  background-image: linear-gradient(rgb(4, 32, 63), rgb(4, 32, 63));
  background-size: 16px 3px;
}
`);
});

test("Browser: the runner's own command with the desktop's socket, nothing else; Exec quoted as the spec says", () => {
  expect(textOf("/home/ag-01a142cb", look(), ".local/share/applications/agentes-browser.desktop")).toBe(
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Browser",
      `Exec=${RUNNER.join(" ")} desktop-browser ${SOCKET}`,
      // The theme's globe: its web browser's (org.xfce.webbrowser) has a mouse pointer drawn into it.
      "Icon=applications-internet",
      "StartupWMClass=agentes-browser",
      "StartupNotify=false",
      "Categories=X-Xfce-Toplevel;",
      "",
    ].join("\n"),
  );
  // Browser's two notes have classes of their own, so a click on Browser reaches the runner: each one's entry, out of
  // the menu, gives the dock its icon (Browser's for the wait), and opened it is Browser's command.
  expect(textOf("/home/ag-01a142cb", look(), ".local/share/applications/agentes-wait.desktop")).toBe(
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Browser",
      `Exec=${RUNNER.join(" ")} desktop-browser ${SOCKET}`,
      "Icon=applications-internet",
      "StartupWMClass=agentes-wait",
      "StartupNotify=false",
      "NoDisplay=true",
      "",
    ].join("\n"),
  );
  expect(textOf("/home/ag-01a142cb", look(), ".local/share/applications/agentes-note.desktop")).toBe(
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Browser",
      `Exec=${RUNNER.join(" ")} desktop-browser ${SOCKET}`,
      "Icon=dialog-warning",
      "StartupWMClass=agentes-note",
      "StartupNotify=false",
      "NoDisplay=true",
      "",
    ].join("\n"),
  );
  // A path with spaces or reserved characters: in double quotes, escaped twice (the string's escape, then the
  // quoting's), and `%` doubled.
  expect(execArg("/home/joe/.agentes-runner/runtime/bun")).toBe("/home/joe/.agentes-runner/runtime/bun");
  expect(execArg("/home/Joe Doe/bun")).toBe('"/home/Joe Doe/bun"');
  expect(execArg('/srv/a"b')).toBe('"/srv/a\\\\"b"');
  expect(execArg("/srv/$HOME/`x`")).toBe('"/srv/\\\\$HOME/\\\\`x\\\\`"');
  expect(execArg("/srv/a\\b")).toBe('"/srv/a\\\\\\\\b"');
  expect(execArg("/srv/100%")).toBe('"/srv/100%%"');
  const spaced = look({ browser: ["/home/Joe Doe/.agentes-runner/runtime/bun", "/x.mjs", "desktop-browser", "/s"] });
  expect(textOf("/h", spaced, ".local/share/applications/agentes-browser.desktop")).toContain(
    'Exec="/home/Joe Doe/.agentes-runner/runtime/bun" /x.mjs desktop-browser /s\n',
  );
});

test("the apps menu: Browser, Files and Terminal first, then whatever else is installed, then Settings; nothing twice", () => {
  const home = "/srv/work/dev-01a142cb/.agentes/home";
  const menu = textOf(home, look(), ".config/menus/xfce-applications.menu");
  expect(menu).toContain('<MergeFile type="parent"/>');
  expect(
    menu
      .slice(menu.indexOf("<Layout>"), menu.indexOf("</Layout>"))
      .trim()
      .split(/\s*\n\s*/),
  ).toEqual([
    "<Layout>",
    "<Filename>agentes-browser.desktop</Filename>",
    "<Filename>agentes-files.desktop</Filename>",
    "<Filename>agentes-terminal.desktop</Filename>",
    "<Separator/>",
    '<Merge type="all"/>',
    "<Menuname>Settings</Menuname>",
  ]);
  // XFCE's own lists Thunar in Accessories (Core) and System, and its terminal in System too.
  const excluded = (name: string) =>
    [
      ...(new RegExp(`<Name>${name}</Name>\\s*<Exclude>([\\s\\S]*?)</Exclude>`).exec(menu)?.[1] ?? "").matchAll(
        /<Filename>([^<]+)<\/Filename>/g,
      ),
    ].map(([, f]) => f);
  expect(excluded("Accessories")).toEqual(["thunar.desktop", "thunar-bulk-rename.desktop"]);
  expect(excluded("System")).toEqual(["thunar.desktop", "xfce4-terminal.desktop"]);
  // Short names of its own, top level only (no category lists them again); XFCE's generic ones hidden.
  for (const [app, name] of [
    ["browser", "Browser"],
    ["files", "Files"],
    ["terminal", "Terminal"],
  ]) {
    const entry = textOf(home, look(), `.local/share/applications/agentes-${app}.desktop`);
    expect(entry).toContain(`\nName=${name}\n`);
    expect(entry).toContain("\nCategories=X-Xfce-Toplevel;\n");
  }
  for (const entry of [
    "xfce4-session-logout",
    "xfce4-web-browser",
    "xfce4-mail-reader",
    "xfce4-terminal-emulator",
    "xfce4-file-manager",
  ]) {
    expect(textOf(home, look(), `.local/share/applications/${entry}.desktop`)).toContain("Hidden=true");
  }
  // XFCE's Internet menu (once another network app is installed): its own icon is Browser's globe.
  expect(textOf(home, look(), ".local/share/desktop-directories/xfce-network.directory").split("\n")).toEqual([
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Directory",
    "Name=Internet",
    "Comment=Applications for Internet access",
    "Icon=preferences-system-network",
    "",
  ]);
});

test("the rest: one workspace, the wallpaper 1:1, no desktop icons, the theme the computer has, the terminal's colors", () => {
  const home = "/srv/work/dev-01a142cb/.agentes/home";
  const desktop = textOf(home, look(), `${XFCONF}/xfce4-desktop.xml`);
  expect(desktop).toContain(
    `<property name="last-image" type="string" value="${home}/.local/share/agentes/wallpaper.png"/>`,
  );
  expect(desktop).toContain('<property name="image-style" type="int" value="5"/>');
  expect(desktop).toMatch(/name="desktop-icons" type="empty">\n {4}<property name="style" type="int" value="0"\/>/);
  for (const theme of ["orchis", "stock"] as const) {
    const wm = textOf(home, look({ theme }), `${XFCONF}/xfwm4.xml`);
    expect(wm).toContain('<property name="vblank_mode" type="string" value="off"/>');
    expect(wm).toContain('<property name="workspace_count" type="int" value="1"/>');
    expect(wm).toContain(
      `<property name="theme" type="string" value="${theme === "orchis" ? "Orchis-Light" : "Default"}"/>`,
    );
    const gtk = theme === "orchis" ? "Orchis-Light" : "Adwaita";
    expect(textOf(home, look({ theme }), `${XFCONF}/xsettings.xml`)).toContain(
      `<property name="ThemeName" type="string" value="${gtk}"/>`,
    );
  }
  // The terminal's 16 colors too: the shell's prompt prints in them.
  const palette = /name="color-palette" type="string" value="([^"]+)"/.exec(
    textOf(home, look(), `${XFCONF}/xfce4-terminal.xml`),
  )?.[1];
  expect(palette?.split(";")).toHaveLength(16);
  // A home path is an attribute's text, whatever it holds.
  const odd = '/srv/a&b "c"/.agentes/home';
  expect(textOf(odd, look(), `${XFCONF}/xfce4-desktop.xml`)).toContain(
    'value="/srv/a&amp;b &quot;c&quot;/.agentes/home/.local/share/agentes/wallpaper.png"',
  );
});

test("the terminal: the agent's name in the prompt and the title, from the look's own file, only with bash", () => {
  const home = "/home/ag-01a142cb";
  const terminal = textOf(home, look(), `${XFCONF}/xfce4-terminal.xml`);
  expect(terminal).toContain('<property name="run-custom-command" type="bool" value="true"/>');
  expect(terminal).toContain(
    `<property name="custom-command" type="string" value="'/bin/bash' --rcfile '${home}/.local/share/agentes/bashrc'"/>`,
  );
  expect(textOf(home, look(), `${LOOK_DIR}/bashrc`)).toBe(
    [
      "# The desktop's Terminal: the shell's own setup, then the agent's name in the prompt and the window's title.",
      "[ -r ~/.bashrc ] && . ~/.bashrc",
      "AGENTES_NAME='Ada'",
      "shopt -s promptvars",
      String.raw`PS1='\[\e]0;$AGENTES_NAME: \w\a\]\[\e[1;32m\]$AGENTES_NAME\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '`,
      `[ -n "\${AGENTES_TERMINAL_NOTE-}" ] && printf '%s\\n\\n' "$AGENTES_TERMINAL_NOTE"; unset AGENTES_TERMINAL_NOTE`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameters, not a template literal
      'PROMPT_COMMAND="history -a${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
      "",
    ].join("\n"),
  );
  // Another shell keeps its own prompt and startup files: nothing of bash's goes in.
  const zsh = look({ shell: "/usr/bin/zsh" });
  expect(textOf(home, zsh, `${XFCONF}/xfce4-terminal.xml`)).not.toContain("custom-command");
  expect(paths(home, zsh)).not.toContain(`${LOOK_DIR}/bashrc`);
  // The name viewers see, without control characters.
  expect(desktopName({ handle: "ada", name: "Ada\u001b]0;x\u0007 Lovelace\n" })).toBe("Ada ]0;x  Lovelace");
  expect(desktopName({ handle: "ada", name: "" })).toBe("ada");
});

test.if(posix && existsSync("/bin/bash"))(
  "the prompt's name is only text: quotes, $(…) and backticks in it run nothing",
  () => {
    const home = tempDir("look-");
    dirs.push(home);
    const name = 'Ana\'s $(touch pwned) `touch pwned2` \\u "x"';
    const file = path.join(home, "bashrc");
    writeFileSync(file, fileOf(home, look({ agent: { handle: "ana", name } }), `${LOOK_DIR}/bashrc`));
    // The computer's own /etc/bash.bashrc may greet an interactive shell: the answer is what follows the marks.
    writeFileSync(path.join(home, ".hushlogin"), "");
    const run = spawnSync("/bin/bash", ["--rcfile", file, "-i", "-c", 'printf "@@%s@@%s" "$AGENTES_NAME" "$PS1"'], {
      cwd: home,
      env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb" },
      encoding: "utf8",
      timeout: 5000,
    });
    const [, said, ps1 = ""] = /@@([\s\S]*)@@([\s\S]*)$/.exec(run.stdout) ?? [];
    expect(said).toBe(name);
    expect(ps1).toContain("$AGENTES_NAME");
    expect(ps1).not.toContain("pwned");
    expect(existsSync(path.join(home, "pwned"))).toBe(false);
    expect(existsSync(path.join(home, "pwned2"))).toBe(false);
  },
);

test.if(posix && existsSync("/bin/bash"))(
  "a Terminal opened again says its note above its first prompt, and its shell keeps nothing of it",
  () => {
    const home = tempDir("look-");
    dirs.push(home);
    const file = path.join(home, "bashrc");
    writeFileSync(file, fileOf(home, look(), `${LOOK_DIR}/bashrc`));
    writeFileSync(path.join(home, ".hushlogin"), "");
    const shell = (env: Record<string, string>) =>
      spawnSync("/bin/bash", ["--rcfile", file, "-i", "-c", `printf "@@%s" "\${${TERMINAL_NOTE_ENV}-gone}"`], {
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb", ...env },
        encoding: "utf8",
        timeout: 5000,
      }).stdout;
    const reopened = shell({ [TERMINAL_NOTE_ENV]: "The computer restarted: this is a new shell in the same folder." });
    expect(reopened).toContain("The computer restarted: this is a new shell in the same folder.\n\n");
    expect(reopened.endsWith("@@gone")).toBe(true);
    // Any other Terminal says nothing.
    expect(shell({}).endsWith("@@gone")).toBe(true);
    expect(shell({})).not.toContain("restarted");
  },
);

test.if(posix && existsSync("/bin/bash"))(
  "each command goes to the history file once it ran, while the shell still runs: a terminal killed with its computer keeps it",
  async () => {
    const home = tempDir("look-");
    dirs.push(home);
    const file = path.join(home, "bashrc");
    writeFileSync(file, fileOf(home, look(), `${LOOK_DIR}/bashrc`));
    writeFileSync(path.join(home, ".hushlogin"), "");
    const shell = Bun.spawn(["/bin/bash", "--rcfile", file, "-i"], {
      cwd: home,
      env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "dumb" },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      shell.stdin.write("echo first-command\n");
      await shell.stdin.flush();
      const history = path.join(home, ".bash_history");
      const deadline = Date.now() + 10_000;
      while (!(existsSync(history) && readFileSync(history, "utf8").includes("echo first-command"))) {
        if (Date.now() > deadline) throw new Error("the command never reached the history file");
        await Bun.sleep(50);
      }
      expect(shell.exitCode).toBeNull();
    } finally {
      shell.kill("SIGKILL");
    }
  },
);

test("the keeper: its source, its settings and its autostart entry, so it starts with the session (ADR 0168)", () => {
  const home = "/home/ag-01a142cb";
  const source = readFileSync(path.join(import.meta.dir, "..", "..", "runner", "desktop-keeper.py"));
  expect(fileOf(home, look(), KEEPER_FILE).equals(source)).toBe(true);
  expect(JSON.parse(textOf(home, look(), KEEPER_SETTINGS))).toEqual({
    browserClass: BROWSER_WM_CLASS,
    notes: ["agentes-wait", "agentes-note"],
  });
  expect(textOf(home, look(), ".config/autostart/agentes-keeper.desktop")).toBe(
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=agentes.chat",
      "Comment=Lists the windows open on this desktop, to open them again after its computer restarted or moved",
      `Exec=python3 -I ${home}/.local/share/agentes/keeper.py ${home}/.local/share/agentes/keeper.json`,
      "NoDisplay=true",
      "",
    ].join("\n"),
  );
  // Whatever the shell, and a home with spaces quoted as the spec says.
  expect(paths(home, look({ shell: "/usr/bin/zsh" }))).toContain(KEEPER_FILE);
  expect(textOf("/srv/a b/home", look(), ".config/autostart/agentes-keeper.desktop")).toContain(
    'Exec=python3 -I "/srv/a b/home/.local/share/agentes/keeper.py" "/srv/a b/home/.local/share/agentes/keeper.json"',
  );
});

test("the images ship as committed (their base64 text is the PNGs): the wallpaper the desktop's size, the mark the dock's icon size", () => {
  const wallpaper = fileOf("/h", look(), ".local/share/agentes/wallpaper.png");
  const mark = fileOf("/h", look(), ".local/share/agentes/mark.png");
  expect(wallpaper.equals(readFileSync(path.join(ASSETS, "desktop-wallpaper.png")))).toBe(true);
  expect(mark.equals(readFileSync(path.join(ASSETS, "desktop-mark.png")))).toBe(true);
  // Shown 1:1: a desktop of another size needs the wallpaper rendered again (docs/design/desktop/render.sh).
  expect(pngSize(wallpaper)).toEqual({ ...DESKTOP_SIZE });
  expect(pngSize(mark)).toEqual({ width: 32, height: 32 });
});

test("the command line: the script and a few words, the files on its input (systemd-run's scope is named after it)", () => {
  const home = "/home/ag-01a142cb";
  const o = look({ theme: "orchis" });
  const { argv, input } = lookCommand(home, o);
  const files = lookFiles(home, o);
  expect(argv).toEqual([
    "/bin/sh",
    "-c",
    LOOK_SCRIPT,
    "agentes-look",
    home,
    lookId(home, o),
    LOOK_MARKER,
    String(files.length),
  ]);
  expect(input.split("\n")).toEqual([...files.map((f) => `${f.path} ${f.data.toString("base64")}`), ""]);
  // Live, on a desktop that runs: where its processes are listed, and its settings after the files, a line each.
  const running = lookCommand(home, o, true);
  expect(running.argv).toEqual([...argv, "/proc"]);
  expect(running.id).toBe(lookId(home, o));
  const settings = lookSettings(home, o).map((args) =>
    Buffer.from(args.map((a) => `${a}\0`).join("")).toString("base64"),
  );
  expect(running.input).toBe(`${input}${settings.map((line) => `${line}\n`).join("")}`);
});

test("files that change come with a new LOOK_VERSION: desktops that have the look get it again only then", () => {
  const hash = createHash("sha256");
  for (const theme of ["orchis", "stock"] as const) {
    for (const dock of ["docklike", "panel"] as const) {
      for (const f of lookFiles("/HOME", look({ theme, dock }))) hash.update(f.path).update(f.data);
    }
  }
  // Changed the look on purpose? Bump LOOK_VERSION and put the new hash here.
  expect({ version: LOOK_VERSION, files: hash.digest("hex").slice(0, 16) }).toEqual({
    version: 7,
    files: "dd23e758f11b0aa7",
  });
});

test("the theme and the dock: what the computer has (Orchis with gdk-pixbuf's SVG loader; docklike's entry and module)", () => {
  const theme = "/usr/share/themes/Orchis-Light/xfwm4/themerc";
  const loader = "/usr/lib/aarch64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader-svg.so";
  const has = (...files: string[]) => lookTheme((f) => files.includes(f));
  expect(has(theme, loader)).toBe("orchis");
  expect(has(theme)).toBe("stock");
  expect(has(loader)).toBe("stock");
  const entry = "/usr/share/xfce4/panel/plugins/docklike.desktop";
  const module = "/usr/lib/x86_64-linux-gnu/xfce4/panel/plugins/libdocklike.so";
  const dock = (...files: string[]) => lookDock((f) => files.includes(f));
  expect(dock(entry, module)).toBe("docklike");
  expect(dock(entry, "/usr/lib/aarch64-linux-gnu/xfce4/panel/plugins/libdocklike.so")).toBe("docklike");
  expect(dock(entry)).toBe("panel");
  expect(dock(module)).toBe("panel");
  // The marker names the version, the theme and the dock, and a hash of everything written.
  expect(lookId("/home/ag-01a142cb", look({ theme: "orchis", dock: "docklike" }))).toMatch(
    new RegExp(`^${LOOK_VERSION}:orchis:docklike:[0-9a-f]{16}$`),
  );
});

test("applied: a new home gets every file and the marker; the same look again keeps what a person changed", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  expect(apply(home)).toBe(0);
  for (const f of lookFiles(home, look())) {
    expect(readFileSync(path.join(home, f.path)).equals(f.data)).toBe(true);
    expect(statSync(path.join(home, f.path)).mode & 0o777).toBe(0o600);
  }
  expect(statSync(path.join(home, ".config")).mode & 0o777).toBe(0o700);
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId(home, look())}\n`);

  const terminal = path.join(home, XFCONF, "xfce4-terminal.xml");
  writeFileSync(terminal, "a person's own colors");
  expect(apply(home)).toBe(0);
  expect(readFileSync(terminal, "utf8")).toBe("a person's own colors");
});

test("applied again once: a home with an older look, another theme or dock, a new name, or moved, gets this one", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  expect(apply(home)).toBe(0);
  const wm = path.join(home, XFCONF, "xfwm4.xml");
  writeFileSync(wm, "changed");
  // Orchis installed since.
  expect(apply(home, look({ theme: "orchis" }))).toBe(0);
  expect(readFileSync(wm, "utf8")).toContain('value="Orchis-Light"');
  writeFileSync(wm, "changed");
  writeFileSync(path.join(home, LOOK_MARKER), `${LOOK_VERSION - 1}:orchis:/home/ag-01a142cb\n`);
  expect(apply(home, look({ theme: "orchis" }))).toBe(0);
  expect(readFileSync(wm, "utf8")).toContain('value="Orchis-Light"');
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId(home, look({ theme: "orchis" }))}\n`);

  // docklike installed since: the dock is its plugin now.
  const panel = path.join(home, XFCONF, "xfce4-panel.xml");
  expect(apply(home, look({ theme: "orchis", dock: "docklike" }))).toBe(0);
  expect(readFileSync(panel, "utf8")).toContain('value="docklike"');

  // The agent renamed: its prompt says the new name.
  const rcfile = path.join(home, LOOK_DIR, "bashrc");
  expect(apply(home, look({ theme: "orchis", dock: "docklike", agent: { handle: "ada", name: "Ada L." } }))).toBe(0);
  expect(readFileSync(rcfile, "utf8")).toContain("AGENTES_NAME='Ada L.'\n");

  // Single-user mode moves an agent's folder with its handle: the settings name the images where they are now.
  const moved = path.join(path.dirname(home), "moved");
  renameSync(home, moved);
  expect(apply(moved, look({ theme: "orchis" }))).toBe(0);
  for (const name of ["xfce4-panel.xml", "xfce4-desktop.xml"]) {
    const text = readFileSync(path.join(moved, XFCONF, name), "utf8");
    expect(text).toContain(`${moved}/${LOOK_DIR}/`);
    expect(text).not.toContain(`${home}/`);
  }
});

test("nothing outside the HOME: relative paths only, and the script writes under HOME alone", () => {
  for (const dock of ["docklike", "panel"] as const) {
    for (const f of lookFiles("/h", look({ theme: "orchis", dock }))) {
      expect(path.isAbsolute(f.path)).toBe(false);
      expect(path.normalize(f.path)).toBe(f.path);
      expect(f.path.split("/")).not.toContain("..");
    }
  }
  const root = tempDir("look-");
  dirs.push(root);
  const home = path.join(root, "home");
  expect(apply(home)).toBe(0);
  expect(filesUnder(root).every((f) => f.startsWith(`home${path.sep}`))).toBe(true);
  expect(filesUnder(root)).toHaveLength(lookFiles(home, look()).length + 1);
});

test("a file it can't write, or files that didn't all come, stop the script before the marker: the next start tries again", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  expect(apply(home)).toBe(0);
  writeFileSync(path.join(home, LOOK_MARKER), "0:stock\n");
  // A folder where the wallpaper's new file goes: writing it fails, for root too.
  mkdirSync(path.join(home, LOOK_DIR, "wallpaper.png.new"));
  expect(apply(home)).not.toBe(0);
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe("0:stock\n");
  // The input cut short: the last file (the mark) never came.
  const mark = fileOf(home, look(), `${LOOK_DIR}/mark.png`).toString("base64");
  expect(apply(path.join(path.dirname(home), "other"), look(), mark.length + 1)).not.toBe(0);
  expect(filesUnder(path.join(path.dirname(home), "other")).some((f) => f.endsWith("look"))).toBe(false);
});

test("pipes left in the home (at a file's temporary name, at the marker) never hold the script", () => {
  const home = path.join(tempDir("look-"), "home");
  dirs.push(path.dirname(home));
  const pipes = [`${home}/.config/gtk-3.0/gtk.css.new`, `${home}/${LOOK_MARKER}`];
  for (const pipe of pipes) {
    mkdirSync(path.dirname(pipe), { recursive: true });
    expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
  }
  expect(apply(home)).toBe(0);
  expect(readFileSync(path.join(home, ".config/gtk-3.0/gtk.css"), "utf8")).toContain(".xfce4-panel.background");
  expect(statSync(path.join(home, LOOK_MARKER)).isFile()).toBe(true);
  expect(apply(home)).toBe(0);
});

test("its settings for a running session: every property its channels give a value, as xfconf-query sets it", () => {
  const home = '/srv/a&b "c"/.agentes/home';
  const o = look({ theme: "orchis", dock: "docklike" });
  const settings = lookSettings(home, o);
  const set = (channel: string, property: string, type: string, value: string) => [
    "-c",
    channel,
    "-p",
    property,
    "-n",
    "-t",
    type,
    "-s",
    value,
  ];
  const ints = (...values: number[]) => values.flatMap((v) => ["-t", "int", "-s", String(v)]);
  expect(settings).toContainEqual(["-c", "xfce4-panel", "-p", "/panels", "-n", "-a", ...ints(1)]);
  expect(settings).toContainEqual([
    "-c",
    "xfce4-panel",
    "-p",
    "/panels/panel-1/plugin-ids",
    "-n",
    "-a",
    ...ints(1, 2, 7),
  ]);
  expect(settings).toContainEqual(set("xfce4-panel", "/panels/panel-1/position", "string", "p=0;x=640;y=869"));
  expect(settings).toContainEqual(set("xfce4-panel", "/plugins/plugin-1", "string", "applicationsmenu"));
  // The values as written, read back from the file's XML.
  expect(settings).toContainEqual(
    set("xfce4-panel", "/plugins/plugin-1/button-icon", "string", `${home}/.local/share/agentes/mark.png`),
  );
  expect(settings).toContainEqual(set("xfce4-panel", "/plugins/plugin-7", "string", "docklike"));
  expect(settings).toContainEqual([
    "-c",
    "xfce4-desktop",
    "-p",
    "/backdrop/screen0/monitorVNC-0/workspace0/rgba1",
    "-n",
    "-a",
    ...["0.811765", "0.901961", "1.000000", "1.000000"].flatMap((v) => ["-t", "double", "-s", v]),
  ]);
  expect(settings).toContainEqual(set("xfwm4", "/general/theme", "string", "Orchis-Light"));
  expect(settings).toContainEqual(set("xfwm4", "/general/margin_bottom", "int", "60"));
  expect(settings).toContainEqual(set("xsettings", "/Net/ThemeName", "string", "Orchis-Light"));
  expect(settings).toContainEqual(
    set("xfce4-terminal", "/custom-command", "string", `'/bin/bash' --rcfile '${home}/.local/share/agentes/bashrc'`),
  );
  // Each property with a value once, in its own channel; a container (`empty`) is only part of a path.
  for (const f of lookFiles(home, o).filter((file) => file.path.startsWith(`${XFCONF}/`))) {
    const xml = f.data.toString();
    const channel = /<channel name="([^"]+)"/.exec(xml)?.[1];
    const valued = xml.match(/<property [^>]*type="(?!empty")/g) ?? [];
    expect(settings.filter((args) => args[1] === channel && args.includes("-n"))).toHaveLength(valued.length);
  }
  expect(settings.flat()).not.toContain("empty");
  // The wallpaper's setting unset right before it is set: its image keeps its path, and xfdesktop loads it again only
  // on a change. Nothing comes between, so a run stopped part-way doesn't leave it unset.
  const wallpaper = "/backdrop/screen0/monitorVNC-0/workspace0/last-image";
  const at = settings.findIndex((args) => args[3] === wallpaper && args.includes("-s"));
  expect(settings[at]).toEqual(set("xfce4-desktop", wallpaper, "string", `${home}/.local/share/agentes/wallpaper.png`));
  expect(settings[at - 1]).toEqual(["-c", "xfce4-desktop", "-p", wallpaper, "-r"]);
  expect(settings.filter((args) => args.includes("-r"))).toHaveLength(1);
  // The panel's own dock: a launcher's items too.
  expect(lookSettings(home, look())).toContainEqual([
    "-c",
    "xfce4-panel",
    "-p",
    "/plugins/plugin-6/items",
    "-n",
    "-a",
    "-t",
    "string",
    "-s",
    "browser.desktop",
  ]);
});

/**
 * A computer for the look's live mode: its processes as `/proc` lists them (a folder each, its `comm` and its
 * `environ`), and an `xfconf-query` and a `dbus-send` that note their name, the bus they were given and their
 * arguments, a line a call: from the call number `failsAt` on, counted over every run, each exits 1.
 */
function liveComputer() {
  const root = tempDir("look-live-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  const proc = path.join(root, "proc");
  const calls = path.join(root, "calls");
  mkdirSync(bin);
  for (const name of ["xfconf-query", "dbus-send", "setsid"]) {
    writeFileSync(
      path.join(bin, name),
      [
        "#!/bin/sh",
        `{ printf '%s %s' ${name} "$DBUS_SESSION_BUS_ADDRESS"; for a; do printf ' [%s]' "$a"; done; echo; } >> "$CALLS"`,
        'n=$(wc -l < "$CALLS")',
        '[ $n -lt "$FAILS_AT" ]',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  const process = (pid: number, comm: string, env?: Record<string, string>) => {
    const dir = path.join(proc, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "comm"), `${comm}\n`);
    if (env) {
      writeFileSync(
        path.join(dir, "environ"),
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}\0`)
          .join(""),
      );
    }
  };
  /** The look's script, live, as the runner runs it on `display`'s desktop. */
  const run = (home: string, o: LookOptions, display: string, failsAt = 1_000_000) => {
    const { argv, input } = lookCommand(home, o, true);
    const done = spawnSync(argv[0] as string, [...argv.slice(1, -1), proc], {
      env: { PATH: `${bin}:/usr/bin:/bin`, DISPLAY: display, CALLS: calls, FAILS_AT: String(failsAt) },
      input,
      timeout: 10_000,
    });
    return done.status;
  };
  const called = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : []);
  return { root, process, run, called };
}

/** What the fake `setsid` notes for the keeper started in the session on `bus`. */
const keeperStarted = (bus: string, home: string) =>
  `setsid ${bus} [-f] [python3] [-I] [${home}/${KEEPER_FILE}] [${home}/${KEEPER_SETTINGS}]`;

/** What the fake `xfconf-query` notes for each setting given on `bus`. */
const noted = (bus: string, settings: string[][]) =>
  settings.map((args) => `xfconf-query ${bus}${args.map((a) => ` [${a}]`).join("")}`);

/** What the fake `dbus-send` notes for the panel's restart on `bus`: its D-Bus Terminate, as `xfce4-panel -r` asks. */
const restarted = (bus: string) =>
  `dbus-send ${bus} [--session] [--print-reply] [--dest=org.xfce.Panel] [/org/xfce/Panel] [org.xfce.Panel.Terminate] [boolean:true]`;

test.if(posix)(
  "live, on a desktop that runs: the files, its settings through its own session's bus, its panel's restart, the marker; another display's left alone",
  () => {
    const c = liveComputer();
    const home = path.join(c.root, "home");
    const bus = "unix:path=/tmp/dbus-ada";
    // Its session and panel; a program of its own that isn't XFCE's; another desktop's panel (single-user mode runs
    // them all as one user); a session whose environment can't be read (another user's).
    c.process(1, "bash", { DISPLAY: ":77", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/not-xfce" });
    c.process(41, "xfce4-session", { DISPLAY: ":77", DBUS_SESSION_BUS_ADDRESS: bus });
    c.process(42, "xfce4-panel", { DISPLAY: ":77", DBUS_SESSION_BUS_ADDRESS: bus, SESSION_MANAGER: "x" });
    c.process(43, "xfce4-panel", { DISPLAY: ":7", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-ops" });
    c.process(44, "xfce4-session");
    const o = look({ dock: "docklike" });
    expect(c.run(home, o, ":77")).toBe(0);
    for (const f of lookFiles(home, o)) expect(readFileSync(path.join(home, f.path)).equals(f.data)).toBe(true);
    expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId(home, o)}\n`);
    // Then the panel's restart, from its own main loop: it reads its settings, gtk.css and docklike's file again. Then
    // the keeper starts in that session (ADR 0168).
    expect(c.called()).toEqual([...noted(bus, lookSettings(home, o)), restarted(bus), keeperStarted(bus, home)]);

    // A session whose panel isn't running: its settings go, no panel is started, and its keeper starts.
    const other = path.join(c.root, "other");
    c.process(51, "xfce4-session", { DISPLAY: ":78", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-eve" });
    expect(c.run(other, o, ":78")).toBe(0);
    expect(c.called().slice(lookSettings(home, o).length + 2)).toEqual([
      ...noted("unix:path=/tmp/dbus-eve", lookSettings(other, o)),
      keeperStarted("unix:path=/tmp/dbus-eve", other),
    ]);
  },
);

test.if(posix)(
  "live, with the look already in its home: its session shows it (it started with it, or took it live), so nothing is set again",
  () => {
    const c = liveComputer();
    const home = path.join(c.root, "home");
    expect(apply(home)).toBe(0);
    const css = path.join(home, ".config/gtk-3.0/gtk.css");
    writeFileSync(css, "a person's own");
    c.process(42, "xfce4-panel", { DISPLAY: ":77", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-ada" });
    expect(c.run(home, look(), ":77")).toBe(0);
    expect(readFileSync(css, "utf8")).toBe("a person's own");
    // What a person changed in the session stays, and the dock doesn't start over.
    expect(c.called()).toEqual([]);
  },
);

test.if(posix)(
  "live, stopped part-way (no session there: 2; a setting refused: 3; the panel not restarted: 4): the marker stays as it was, so the next start writes the look again",
  () => {
    const c = liveComputer();
    const home = path.join(c.root, "home");
    const bus = "unix:path=/tmp/dbus-ada";
    const marker = path.join(home, LOOK_MARKER);
    const settings = lookSettings(home, look());
    c.process(42, "xfce4-panel", { DISPLAY: ":77", DBUS_SESSION_BUS_ADDRESS: bus });
    // No session on that display: its files are written, nothing is set.
    expect(c.run(home, look(), ":79")).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(c.called()).toEqual([]);
    // The third setting refused: none after it is set (the wallpaper's isn't unset), and the panel goes on as it is.
    expect(c.run(home, look(), ":77", 3)).toBe(3);
    expect(c.called()).toEqual(noted(bus, settings.slice(0, 3)));
    expect(c.called().join("\n")).not.toContain("[-r]");
    expect(existsSync(marker)).toBe(false);
    // Every setting taken, the panel's restart refused.
    expect(c.run(home, look(), ":77", 3 + settings.length + 1)).toBe(4);
    expect(c.called().at(-1)).toBe(restarted(bus));
    expect(existsSync(marker)).toBe(false);

    // xfconfd wrote what it held over the files it read: the desktop's next start writes the look again.
    const desktop = path.join(home, XFCONF, "xfce4-desktop.xml");
    writeFileSync(desktop, "what xfconfd held");
    expect(apply(home)).toBe(0);
    expect(readFileSync(desktop).equals(fileOf(home, look(), `${XFCONF}/xfce4-desktop.xml`))).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe(`${lookId(home, look())}\n`);
  },
);
