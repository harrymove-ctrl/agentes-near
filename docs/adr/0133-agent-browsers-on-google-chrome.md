# 0133. Agent browsers run the computer's Google Chrome stable, updated like anyone's

- Status: Accepted (built); amended by 0153 (Linux on ARM runs Chromium)
- Date: 2026-11-03
- Amends: ADR 0040 (agent browser: §2 "Chrome" and "System mode", which pinned Chrome for Testing), 0110 (browser profiles run on the same Chrome)
- Extends: ADR 0104 (error reports)
- Code: runner `apps/server/runner/browser.ts` (`findChrome`, `chromeCandidates`, `chromeVersion`, `chromeLaunchArgs`, `chromeUserAgent`, `prepareProfile`, `profileChromeVersion`, `BrowserManager.sweep`/`updateDue`/`restartOnUpdate`, `pageCrashed`), `start-page.ts` (`startPageHtml`, `prepareStartPage`), `assets/start/*`, `install-script.ts` (`GOOGLE_CHROME_LINUX`, `GOOGLE_APT`, `get_chrome`, `install_chrome`, `chrome_key`, `forget_testing_chrome`), `worker.ts` (`installedByRoot`); adapters `browser-start.ts` (`START_FILE`, `NEW_TAB_URL`, `isStartPage`), `machine-protocol.ts` (`CHROME_FAILURES`, `chromeFailureKind`, `CHROME_NEEDED`, `CHROME_DOWNLOAD_URL`, `RunnerBrowserInfo.chromeMissing`); runner `main.ts` (`update`), `install-script.ts` (`chrome_or_warn`); engine `browser/tools.ts` (`reportChromeFailure`, `errors` dep), `machine-hub.ts` (`chromeWentMissing`), `notification-producers.ts` (`notifyComputerNoChrome`, kind `computer_no_chrome`); server `engine.ts`

## Context

Agents' browsers ran Chrome for Testing: pinned by the installer on Linux servers (`install.sh --system`, Cloud included) and downloaded per user by `agent-browser install` elsewhere. That build calls itself "Chromium" in its client hints, shows a "for testing" bar, never updates by itself (a pin moved by hand) and is a second browser to ship and patch. Google Chrome stable is what people browse with: its brands match, it updates itself, and Google keeps it patched.

## Decision

### 1. One browser: Google Chrome stable, no fallback

- The runner drives the computer's own Google Chrome at its standard path (`chromeCandidates`): Linux `/opt/google/chrome/chrome` (the `google-chrome-stable` package), macOS `/Applications/Google Chrome.app` then `~/Applications/…`, Windows `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%` + `\Google\Chrome\Application\chrome.exe`.
- Chrome for Testing is gone everywhere: no download in the installer, no `agent-browser install`, no lookup of its folders, no flag only it needed. Nothing falls back to it.
- Each agent keeps its own profile (`--user-data-dir` in its folder, or the profile's own folder), so the person's own Chrome profile is never read or changed.

### 2. Logins carry over

The key that protects an agent's cookies and saved logins comes from flags we already pass, and Google Chrome reads it exactly as Chrome for Testing wrote it (Chromium 156 source): `--password-store=basic` on Linux (a fixed key, no branding check), `--use-mock-keychain` on macOS (the fake keychain ignores the "Chrome"/"Chromium Safe Storage" service name), and on Windows the per-user DPAPI key in the profile's Local State (App-Bound encryption needs Chrome's default profile folder, which we never use). Local Storage and IndexedDB aren't encrypted. So no agent is signed out by the switch, and these flags never go: dropping `--use-mock-keychain` would sign out every Mac agent.

Moving the Cloud's Chrome for Testing 156.0.8078.80 to Linux stable 156.0.8078.79 is a patch-level step back in the same milestone, which Chrome treats as harmless; Mac and Windows stable are newer. On Mac and Windows, Chrome stable resets the "protected" preferences a Chrome for Testing profile signed with an empty seed (home page, startup pages); we use none of them.

If a manual check on a copied real profile ever shows a platform losing sign-ins, the runner would tell the server which agents need a sign-in again and the server would say so once in each agent's DM. It isn't built, since the source shows no platform loses them.

### 3. The start page is a local file

Google Chrome ignores `--load-extension`, so the start page can't be an extension's new tab page anymore. Enterprise policies (`NewTabPageLocation`, a force-installed extension) were ruled out: they apply to the whole computer, so they would change the person's own Chrome on a self-hosted desktop, carry no per-agent data, show "Managed by your organization", and unmanaged Macs and Windows ignore them.

- `prepareStartPage` writes one self-contained `agentes-start.html` per agent (the same folders as before: `<runner home>/start/<suffix>/`, or `/opt/agentes-runner/browser/start/<uid>/` in system mode, root's and the agent's group's, 0750): its style, script, font and picture are `data:` URLs and the agent's details (name, language, exit IP, flag) a JSON block with `<` escaped, under a CSP that allows nothing from the network. Chrome opens it as the first page (`file://…`), where it opened `chrome://newtab/` before. When the exit IP changes the file is rewritten, and an open start page reloads when its tab comes back into view.
- New tabs are Chrome's own new tab page. `isStartPage` lets the start file and `chrome://newtab/` / `chrome://new-tab-page/` past the site allowlist; agents still can't open `file:` or `chrome:` pages themselves (`isWebPage`).
- `prepareProfile` runs before every start (headless too, so a Chrome signed in to google.com never offers to sign in to the browser) and drops the old extension's `extensions.chrome_url_overrides.newtab` entry.

### 4. Chrome updates itself, and the runner follows

- **Linux:** a normal apt install from Google's repository, set up exactly as the package's own postinst sets it up (`/usr/share/keyrings/google-chrome.gpg`, `/etc/apt/sources.list.d/google-chrome.sources`, `https://dl.google.com/linux/chrome-stable/deb/`), so the package rewrites the same files and apt never sees the repository twice with two keyrings. The installer downloads Google's key and refuses it unless its fingerprint is `EB4C 1BFD 4F04 2F6D DDCC EC91 7721 F63B D38B 4796`; apt then checks the signed index and every package. When the installer installed Chrome itself, it adds a systemd timer of its own (`agentes-chrome-update.timer`, every 6 hours with up to an hour's random delay) that upgrades `google-chrome-stable` alone: a Debian without unattended upgrades would otherwise never update it, and nothing else of the computer's packages changes with it. A Chrome the admin already had keeps its own update habits. Chrome's sandbox helper (`chrome-sandbox`) never lands set-user-id root, for the install and every upgrade (`dpkg-statoverride`): the agents are users of their own, and Chrome sandboxes with user namespaces, which `--system`'s Debian has. The package makes itself the default web browser (`x-www-browser`, `gnome-www-browser`): the computer's choice is put back. With `--desktop`, a `NoDisplay` entry hides Chrome's own menu item, so the agents' menus offer no second Chrome on the default profile. No version is pinned.
- **macOS, Windows:** the person's Google Chrome, which Google's updater keeps current. Every launch passes `--disable-updater-scheduler`, so our Chrome never starts Google's updater as a child of our app (what made macOS say "agentes was prevented from modifying apps"); the person's updater keeps working.
- **A new version on disk:** `chromeVersion` reads it without starting Chrome where it can (macOS: the app's Info.plist; Windows: the newest version folder next to `chrome.exe`, whose `--version` prints nothing; Linux: `chrome --version`). The runner reads it at each launch (stored on the session) and again at most every 5 minutes. An agent's running Chrome older than the one on disk restarts on it, on the page it showed, where it was (its desktop or headless), with its profile, once per version, and only when nobody needs it: no command, nobody watching it and no person's turn for 10 minutes (an agent may pause a few minutes mid-task, for a build or a reply, and must find its page as it left it; the idle stop comes at 15); the restart runs in the agent's queue, so never under a command, and isn't counted as a use. A browser that idles out first simply starts on the new version next time.
- **A page that dies while a newer Chrome waits on disk** died because the update replaced Chrome's files under it: Chrome restarts on the new version on that page instead of reopening the tab, and the agent's next action is told its page changed, as for any crash.

### 5. Flags

- Kept: `--password-store=basic` / `--use-mock-keychain` (logins), `--disable-component-update`, `--disable-blink-features=AutomationControlled`, the rest of `CHROME_ARGS`.
- Changed: headed launches use `--test-type` (hides the bar about the automation flag) instead of `--test-type=gpu`, whose value only hid Chrome for Testing's own bar.
- Removed: `--load-extension`.
- Added: `--disable-updater-scheduler`, and `--disable-search-engine-choice-screen` (Google Chrome asks a new profile to choose a search engine in some countries, the EU's among them, where Cloud computers run).
- User agent: only headless launches override it (with the major version from `chromeVersion`), since a headless Chrome stable calls itself "HeadlessChrome" and Google's sign-in and search refuse that (ADR 0040 §2). Headed launches, the Cloud desktops among them, keep Chrome's own user agent, which matches its client hints.

### 6. Failures are told and tracked

- The runner answers a Chrome failure with `browser_unavailable` and one of `CHROME_FAILURES`, in plain words: Chrome missing ("Install it from google.com/chrome", or in system mode "Its admin should run the agentes.chat installer on it again"), Chrome not starting (plus the system libraries it lacks, when that is why), the agent's profile not opening (another Chrome holds it), or the computer's Chrome a major version older than the one that last ran on the agent's profile (`extensions.last_chrome_version` in its Preferences; "Update Google Chrome on it"), which isn't started on it: an older Chrome can't open what a newer one wrote, and the agent would seem signed out. A step back within a major version (Chrome for Testing 156.0.8078.80 to Google Chrome 156.0.8078.79) starts. Chrome's own output stays in the runner's log. The engine passes it to the agent with "Tell the person".
- `hello.browser` stays available without a Chrome, so the agent tries, tells, and a Chrome installed later works at the next command with no reconnect; `chrome` says `Google Chrome <version>` when there is one, `chromeMissing` when there is none.
- A computer whose `hello` says `chromeMissing` while its last one didn't (a runner that updated itself onto this one, a Chrome removed) is told without waiting for an agent to try: on a person's or a self-hosted computer with the browser switched on, a `computer_no_chrome` notification ("<computer> needs Google Chrome for the agents' browser. Get it at google.com/chrome", opening the computer) goes once to who connected it, else to who configures the workspace; on one of the Cloud's (`managed`), nobody in the workspace can install it, so it is an error report like the rest of this section's (`missing`), once. It comes again only after a `hello` with a Chrome.
- The engine reports each such failure (`chromeFailureKind`) to the error reports of ADR 0104, once per computer and kind every 10 minutes, tagged with the organization, agent, run, computer, its system, its Chrome (from `hello.browser`), the kind and the runner's sentence, so operators see it in their error inbox and alerts. Other `browser_unavailable` answers (a busy computer, an older runner's words) aren't reported.
- The machine protocol is unchanged: the contract is the message's first words.

### 7. Rollout

- Linux servers (`--system`, the Cloud included) get Chrome stable when the installer runs again; once the runner restarted on it, the installer removes the old Chrome for Testing folders (`/opt/agentes-runner/browser/chrome-*`), and leaves them while the old runner may still run (`--no-start`).
- A runner outside system mode needs Google Chrome installed; before, it downloaded Chrome for Testing silently. Mac and Windows get it with the next desktop app release. How each kind of computer updates onto this runner, and what it does about Chrome:
  - system mode (Linux servers, the Cloud, the self-hosted server's own computer): only the installer updates it (`agentes-runner update` refuses, and the self-host setup runs the installer when the server serves a newer runner), and the installer installs Chrome as above;
  - a person's runner (`agentes-runner update`, or the installer run again without root): nothing can install Chrome, so both end with `CHROME_NEEDED` (where to get it) when none is at the standard paths;
  - the desktop app updates itself with its runner: the `computer_no_chrome` notice above.
- The Cloud's own image (in its private repository) stops pinning Chrome for Testing, removes the old Chrome for Testing folders and the agents' own `~/.agent-browser/browsers` once its runner restarted (it installs with `--no-start`) and converges the whole fleet at once.

## Consequences

- One browser, current with Google's releases, with its real brands; no pin to move by hand.
- A self-hosted computer without Google Chrome has no agent browser until someone installs it; the agent says so, and the operator sees it.
- Ctrl+T shows Google's new tab page, and the address bar on the agent's desktop shows a `file://` path for the first page.
- Not verified by hand yet: sign-ins surviving on a copied real profile (Linux, Mac; Windows untested), a page crashing when apt replaces Chrome under it, whether the Cloud's `needrestart` restarts agents' Chromes after an upgrade, and whether Chrome drops the stale new tab override by itself.
