# 0153. Agent browsers on Linux ARM run Chromium; the self-host setup's simple mode and requirements

- Status: Accepted
- Date: 2026-11-07
- Amends: 0133 §1 ("One browser: Google Chrome stable, no fallback"), on Linux on ARM only; the self-host setup's
  agents' computer, which needed systemd's BPF_FRAMEWORK on Linux
- Code: adapters `machine-protocol.ts` (`CHROMIUM_LINUX`, `usesChromium`, `CHROMIUM_NEEDED`, `browserNeeded`,
  `CHROME_FAILURES.missingChromium`); runner `browser.ts` (`chromeCandidates`, `findChrome`, `chromeName`,
  `confinedChrome`, `readableDisplay`, `BrowserManager.startDir`), `main.ts` (`update`, `hostSystemMode`,
  `installHost`), `host.ts` (`writeHome`), `install-script.ts` (`on_arm_linux`, `get_browser`, `get_chromium`,
  `install_chromium`, `update_timer`, `chrome_or_warn`, `CHROMIUM_DESKTOP_ENTRY`, `REQUIREMENTS`,
  `install_requirements`, `install_claude`, `install_codex`, `get_cli`, `desktop_packages`); setup `lib.ts`
  (`computerOffer`, `SIMPLE_*`, `computerInstall`, `computerFiles`, `REQUIREMENTS`, `parseRequirements`,
  `checkRequirements`, `askableRequirements`, `planSteps`), `cli.ts` (`chooseRequirements`, `prepareSimpleUser`,
  `setUpComputer`)

## Context

ADR 0133 made the agents' browser the computer's own Google Chrome stable, with no fallback. Google publishes no
Chrome for Linux on ARM (no `google-chrome-stable` for arm64 in its apt repository), so an arm64 Linux computer,
such as a free ARM cloud VM running a self-hosted instance, connected fine but its agents had no browser at all:
the runner looked only at `/opt/google/chrome/chrome`, and the installer pinned agent-browser's x86_64 build.
agent-browser itself ships an arm64 Linux build (already pinned in `AGENT_BROWSER_SHA256`).

## Decision

### 1. Linux on ARM drives Chromium

- `usesChromium(platform, arch)` is true on Linux on arm64 only. There, after Google Chrome's path (kept first in
  case Google ever ships one), the runner looks at `CHROMIUM_LINUX`: Debian's package (`/usr/bin/chromium`), then
  Ubuntu's snap (`/snap/bin/chromium`), Ubuntu having no Chromium package of its own. x86_64 Linux, macOS and
  Windows keep 0133 as it is: Google Chrome stable and nothing else.
- It is still the computer's own browser, never a copy of ours: updated by the distribution (Debian's security
  updates, or snap refreshes), version read with `--version` ("Chromium 157.0.8103.38 …"), and restarted on a new
  version exactly as 0133 §4 does for Chrome. The same flags and the same per-agent profile apply.
- What people see names it: `hello.browser.chrome` says "Chromium <version>" (`chromeName`), and the runner's log
  says the agent's browser "restarts on Chromium …".

### 2. The snap reads no hidden folder at the top of the home

The snap's confinement denies hidden entries directly under `$HOME`, so it can't open the agent's start page in
`~/.agentes-runner/start/…` (checked on Ubuntu 24.04 arm64 with Chromium 157: the page doesn't load, while a
profile in the agent's folder works). With a snap browser (`confinedChrome`: under `/snap/`) the start page is
written beside the agent's profile instead, in its own folder (`<agent>/.agentes/start/agentes-start.html`). Every
other browser keeps it under the runner's home. System mode is unchanged (its start pages are root's, and system
mode needs Debian, which has no snap Chromium).

### 3. The installer

- `--system` on arm64 installs agent-browser's `linux-arm64` build, checked against its own SHA-256, in the same
  shared folder.
- `--system` on arm64 without Chrome installs Debian's `chromium` with apt (no Google repository or key), puts the
  computer's default browser back, upgrades it with the same 6-hour timer (`agentes-chrome-update.timer`, now
  written by `update_timer` for either package), and with `--desktop` hides its menu entry
  (`/usr/local/share/applications/chromium.desktop`), as for Chrome.
- Without root (a person's install, `agentes-runner update`), an arm64 Linux computer without Chromium is told how
  to install it (`CHROMIUM_NEEDED`: `sudo apt install chromium` on Debian, `sudo snap install chromium` on Ubuntu),
  not to get Chrome from google.com.

### 4. What the agent is told

On Linux on ARM a missing browser is `CHROME_FAILURES.missingChromium`. It starts like `missing`, so
`chromeFailureKind` and the reports stay as they are.

### 5. Simple mode where agents can't each be a user of their own

System mode (each agent its own OS user) needs systemd built with BPF_FRAMEWORK, which keeps each agent's user off
the others' browser ports. Ubuntu's isn't, so the setup skipped the agents' computer there, and a self-hosted
Ubuntu server (a free ARM VM, say) had none. Now, as root on Linux without BPF_FRAMEWORK, the setup offers simple
mode, saying what it means: every agent works as one user, `agentes` (`SIMPLE_USER`), made without sudo or a
password, so agents see each other's folders but not the person's or the server's. It is yes by default (with
apt-get and 4 GB of memory, as system mode), since a self-hosted server is one team's.

- The setup makes the user when missing, keeps its services running without a login (`loginctl enable-linger`),
  copies the token to `/home/agentes/host-computer-token` (owner only), and runs the computers' installer as that
  user (`runuser`), with `--host-token-file` alone. The installer took `--host-token-file` alone only on a Mac; now
  also on Linux as a user other than root, and as root it still needs `--system`.
- The runner's `host` runs as that user in user mode (as on a Mac): `hostSystemMode` is Linux as root only, and
  `service install --host` writes a user unit there. Its journal is read with `_SYSTEMD_USER_UNIT`, and whether it
  runs with `systemctl --user -M agentes@`.
- A machine whose `agentes` user already runs a connected runner is refused, as system mode refuses a connected
  root runner.

### 6. The setup checks what the agents need, and asks

After the agents' computer, on Linux, the setup checks the agents' browser (where the runner looks: Google Chrome,
and on ARM Chromium), the packages for their screens (`Xtigervnc`, `xfce4-session`), Claude Code and Codex (on an
agent's PATH, `/usr/local/bin` or `/usr/bin`), says what's there, and asks about each one missing, yes by default.
System mode's own installer brings the browser and the screens, so only the coding CLIs are asked about there.
`--requirements all|none|<list>` answers for all; without a terminal the answers are yes.

What it installs goes through the computers' installer, as root: `install.sh --requirements <list>`, alone, which
installs only those and stops (it works by hand too). The browser is `get_chrome` (Google's apt repository, or on
ARM Debian's `chromium`, else Ubuntu's snap, which refreshes itself, so no timer); the screens are
`DESKTOP_APT_PACKAGES` and the extras, without system mode's isolation packages; Claude Code is Anthropic's installer
run in a home that is thrown away, its binary copied to `/usr/local/bin/claude`; Codex is the latest release's static
build for the processor (`codex-<arch>-unknown-linux-musl.tar.gz` from GitHub), to `/usr/local/bin/codex`. Neither
is pinned: Claude's installer checks what it downloads against its own manifest, and Codex's release is fetched over
HTTPS from OpenAI's repository. One already there is kept.

The organizations' homes of the server's own computer now start with the agents' screens on (`access.tools.desktop`),
with the browser: the setup offered each agent its own screen, and before this the person had to run
`agentes-runner tools enable desktop` on the machine to see one. Homes made before keep what they have.

A snap's Chromium on an agent's screen can't read the screen's Xauthority either (it lives under the runner's
hidden home), so it gets a copy beside the agent's profile (`readableDisplay`, `.agentes/Xauthority`, owner only),
made at each start.

## Consequences

- An arm64 Linux computer (a Debian server, an Ubuntu VM in user mode) gives its agents a browser.
- An Ubuntu server becomes its agents' computer from the setup, in simple mode, with what they need installed,
  where before it was skipped. Its agents aren't kept apart from each other: the question says so.
- Chromium's client hints say "Chromium" where Chrome's say "Google Chrome"; the emulated brands
  (`browser-traffic.ts`) are unchanged.
- The notice people get when a computer has no browser (`machines.chromeMissingNotice`) still names Google Chrome;
  on an ARM computer it should name Chromium. Left for later: it needs the computer's architecture on the
  notification and the text in every language.
