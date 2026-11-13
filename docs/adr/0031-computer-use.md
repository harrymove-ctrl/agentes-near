# 0031. Computer use: screens of the agent's own, model-agnostic tools, and (opt-in) the owner's real desktop

- Status: Proposed (after missions, ADR 0029, and runner isolation level 1, ADR 0030)
- Date: 2026-10-16, revised 2026-10-18 (model-agnostic layers, intent tools, simulator, take over, several agents per machine)
- First slice: ADR 0040 (the agent browser on connected computers, on `agent-browser`), which supersedes §4 and the browser parts of §8, §9 and §14
- Desktop slice: ADR 0058 (a desktop per agent on connected Linux computers that people watch and control, and a terminal), which supersedes the connected-Linux line of §6, the virtual desktop's part of §8 and the shared OS user of §10 in system mode
- Desktop computer use: ADR 0062 (ADR 0054's screen layer on the agent's desktop), which supersedes §1, §1a and §6 for the agent's desktop on a connected Linux computer
- Cloud computers: ADR 0077, which supersedes every Daytona line here: an agent's screens are on connected computers only
- Extends: ADR 0021 (code sandbox), ADR 0025 (connected computers), ADR 0027 (secrets), ADR 0030 (runner isolation), ADR 0036 (desktop app)

## Context

Agents can run commands and move files on their computer (Daytona or a connected machine), but they can't see or drive a screen. Many tasks need one: a web app without an API, a login or checkout flow to test, a phone app in a simulator, an admin panel, a desktop program, checking that a UI the agent just built actually works.

Computer use is, in short, a remote-control tool given to the agent: the computer captures the screen and executes clicks and keys, the model looks and decides. It is turn by turn (a frame, a decision, an action), not continuous video, so each step costs a model call.

**We are model-agnostic.** An agent may run on Claude, GPT or another model through our gateway, and on a connected machine its work may go to Claude Code or Codex (ADR 0029). Screen tools can't depend on one provider's computer-use tool.

What exists today:

- The runner has six ops (`exec`, `read`, `write`, `list`, `push`, `secret`); nothing captures the screen or sends input. Tool results in our gateway are text only (`packages/providers/src/anthropic.ts`, `openai.ts`); no image results, no provider-defined tools.
- On a connected machine, a Claude Code task can already browse with Playwright through its shell, drive an iOS simulator with `xcrun simctl` and `idb`, and read the screenshots it saves. Personal MCP servers (Playwright MCP, Claude in Chrome) are off by default: the brain runs with `--strict-mcp-config` unless `personalMcp` is on (`apps/server/runner/brain.ts`).
- The same task could improvise control of the owner's real desktop (`screencapture`, `osascript`), without any of the safeguards below and only if macOS permissions were granted to whatever launched it. We don't rely on it (§15).

Comparable products give each bot a cloud computer (browser, files, terminal), use connectors where they exist and computer use otherwise, let the person watch and take over to log in, and keep working with the person's laptop off. That is our virtual desktop on Daytona plus take over (§6, §8).

Model side (checked 2026-10-16/18):

- Anthropic: computer use is a client-side tool, current shape the **computer toolset** `computer_toolset_20260801` (one `tools` entry; calls come back as `tool_use` blocks named after the action with `"toolset_name": "computer"`, often several per turn; every `tool_result` echoes `toolset_name`; only `screenshot` and `zoom` return an image). Opus 5.5 and Sonnet 5.5 accept only the toolset. A **browser toolset** `browser_toolset_20260801` exists for work inside web pages. Coordinates are in the pixel space of our screenshots; screenshots must already fit the image limits. Don't prune old screenshots: editing earlier turns invalidates later thinking blocks; use server-side tool result clearing.
- OpenAI: has its own computer-use tool; shape and fit to confirm against their docs when the adapter is built.
- Jev (TypeSafe, System One): accepts PNG/JPEG images (Jev 1.13+) and has a **Box** question (Jev 1.14) that returns one bounding box as fractions of the image (0–1 from the top-left) with a confidence. Both are preview: opt-in header `TypeSafe-Danger-Zone-Images: true`, format and accuracy may change. Each side of an image must be 280–1568 px (rejected, never resized). Box always returns a box, even when the target is absent, so it is paired with a Noul ("is it there?"). Accuracy on app screens and latency are not documented.

## Decision

### 1. Four kinds of screen, one tool family

| Screen | Where | What the agent reaches | Isolation |
|---|---|---|---|
| **Agent browser** | Daytona computer or connected machine | A Chromium the runner starts, with a profile per agent in the agent's folder. Not logged in to anything of the owner's. | Works with every isolation level |
| **Simulator** | Connected Mac with Xcode (iOS) or any machine with the Android emulator | A simulator or emulator per agent, driven through its own command-line tools, not the mouse | The app runs in a box; commands still run as the OS user (§5) |
| **Virtual desktop** | Daytona computer, or a VM/container on a connected machine | A full desktop on a virtual display, inside the box | The box is the boundary |
| **Owner's desktop** | Connected machine that supports it (`--desktop`), given to one agent at a time by the machine's owner | The real screen, mouse and keyboard of the person logged in | None: acts as the owner (§7) |

The agent sees one tool family, `computer_*` (scope `computer:use`, outside "all tools", like `sandbox:run`). `computer_status` (already exists) says which screen it has, if any.

Two preferences guide every case:

- **Structure before pixels.** A web page (DOM, accessibility tree) and a simulator (accessibility tree) can be read as text: faster, cheaper and more accurate than screenshots. Pixels are for what has no structure (canvas, maps, games, arbitrary desktop programs) and for visual checks.
- **The agent's own screen before the owner's.** Login, checkout and app testing belong in the agent browser or a simulator. The owner's desktop is for what only exists there.

Only the owner's desktop rules out the sandbox (§12). An agent with a terminal and the agent browser, a simulator or a virtual desktop keeps protected mode.

### 1a. Chosen per agent

Each agent has two settings on its page, next to the computer it uses (`agents.machine_id`, ADR 0025):

- **Screen** (`agents.screen`): `none` (default) · `browser` · `simulator` · `virtual_desktop` · `owner_desktop`.
- **Protected mode** (`agents.protected`, ADR 0030 level 2): on or off.

What can be chosen depends on the computer, and options that don't apply are shown disabled with the reason:

| Screen | Cloud (Daytona) | Connected machine |
|---|---|---|
| `none` | yes | yes |
| `browser` | yes | yes (runner protocol 4 with the `browser` capability) |
| `simulator` | no | a Mac with Xcode (iOS) or a machine with the Android SDK, reported as the `simulator` capability |
| `virtual_desktop` | yes | Linux (the runner starts a virtual display), or a VM/container that reports one |
| `owner_desktop` | no | only on a machine paired with `--desktop`, and only set by the person who paired it (not even an admin) |

- `owner_desktop` forces protected mode off for that agent; the page says "this agent acts as you on this computer". Turning protected mode on moves the screen back to `browser`.
- The screen is a ceiling: the agent can't raise it, and the server only offers the tools it allows. Changes are audited.
- Changing the agent's computer resets the screen to `none` if the new computer can't serve it.
- Machine side, `--desktop` only means "this machine can offer its desktop" (permissions granted). It gives nothing to any agent by itself.

### 2. Model-agnostic: three layers

#### 2.1 The actions are ours

The runner (and the Daytona image) implement one action set, unaware of which model asked: `screenshot`, `zoom`, `click` (left/right/double/middle), `move`, `drag`, `scroll`, `type`, `key`, `wait`; structure reads `read_page` (agent browser: text snapshot with element refs) and `read_ui` (accessibility tree of a simulator or desktop); and for the agent browser `navigate` and `back`. Actions can target an element ref from a structure read instead of coordinates. Safeguards (locks, caps, Stop, pausing when the person moves the mouse) live here, so they hold whatever the model or door.

#### 2.2 Each adapter translates

| Who drives | How it gets the actions |
|---|---|
| Claude through our gateway | The Anthropic computer or browser toolset (`anthropic.ts`): Claude is trained on it and places coordinates best with it. Batches run in order, stop on the first failure, one result each |
| GPT through our gateway | OpenAI's computer-use tool if it fits (to confirm), in `openai.ts` |
| Any other model that reads images | Plain function tools (`click(x, y)`, `screenshot`, …) with the image in the tool result |
| Claude Code or Codex on a connected machine | The runner's `agentes` MCP server (`apps/server/runner/mcp.ts`, already allowed as `mcp__agentes`), with images as MCP image content. Codex's handling of MCP images to confirm |

Gateway changes: image blocks in tool results (stored in file storage, §3); provider-defined tools; old-screenshot handling per adapter (Anthropic: server-side clearing, never editing earlier turns; others: their provider's rule). A model without image input gets only the structure reads and the intent tools.

#### 2.3 Intent tools, the default path for any model

The main model says *what*; structure reads, a small vision judge and code resolve *where* and *whether it worked*:

- `click_on(target)`: "the Save button".
- `type_into(target, text | secret)`: "the E-mail field".
- `wait_until(condition, timeout)`: "the list finished loading"; polled about once a second without the main model.
- `check(condition)`: "an error message is visible"; returns yes/no with a probability.
- `run_steps(steps[])`: a short plan of the above, executed in order; returns at the end or at the first step that fails, with a screenshot (or structure read) of that moment.

Resolution order: first the structure (choose among the elements of `read_page` / `read_ui`), then vision on a screenshot. Vision goes through our own interface, `ScreenJudge`: `locate(image, target) → { box, present, confidence }` and `judge(image, question) → probability`. The first implementation is Jev (Choice over listed elements, Box + Noul for locating, Noul for conditions); swapping it for another vision model touches one place.

- The judge is called by the server, never by the runner with a key: the runner sends the screenshot, the server calls the judge, usage and cost are recorded with `org_id` and `agent_id` like any model call.
- Low confidence or not present: the step fails and the main model gets the screen to decide. Nothing on the screen can grant permissions or skip an approval.
- The judge's name never appears in the UI ("the agent clicked Save").
- A text-only model can drive a screen this way; a model with images can still ask for a screenshot when it needs one.

**Validation gate:** before intent tools become the default for vision, measure about 20 real screens × 5 targets (our app, a Stripe test checkout, an iOS simulator) for hit rate, latency and cost. Until then the structure path ships first and vision uses the raw actions of §2.1–2.2.

### 3. Screenshots

- Captured on the computer, downscaled there (long edge up to 1920 px for the main model, 1280×800 by default for virtual desktops; for the judge, each side within 280–1568 px), PNG or JPEG. The runner keeps the scale factor and translates coordinates to real screen pixels (Retina, HiDPI, simulator points vs pixels, several monitors: one chosen monitor per session).
- Stored in the org's file storage, not inline in the transcript: the transcript keeps a reference, the gateway loads the bytes when it builds the request. Retention 7 days by default (org setting), then the transcript shows "screenshot expired".
- Visible only to who can see the run. They may contain other people's personal data (LGPD): short retention, never indexed by search, never used for memory.
- Screen content is untrusted input (prompt injection). The system prompt says so.

### 4. Agent browser

- One Chromium per agent, profile and downloads in the agent's folder (`<handle>-<id8>/.agentes/browser`), headless; closed after it sits idle.
- The runner drives it over the DevTools protocol (CDP) directly, using the Chrome already installed: no Playwright inside the compiled runner (`bun build --compile`, ADR 0036). Playwright's Chromium is the fallback when no Chrome is found (to test under the compiled binary). Daytona's image ships Chromium.
- `read_page` returns a text snapshot of the page with numbered element refs (fields, buttons, links, messages); actions take a ref. Screenshots are for visual checks.
- `file://` and the owner's paths are blocked; an optional site allowlist per agent; page text is untrusted.
- Logins: a test account with its password delivered through `request_secret` and typed by `type_into(…, secret)`; codes by e-mail through a test inbox the agent can read; "Sign in with Google" and similar through take over (§8). Checkout only in test mode (Stripe test cards for approve, decline, 3-D Secure); a real payment is a sensitive action and becomes an approval card.

### 5. Simulator

- **iOS** (Mac with Xcode): `xcrun simctl` to boot headless (no Simulator window), install, launch, open deep links (`openurl`), take screenshots, pre-grant permissions (`privacy grant`), send pushes, set location and appearance; `idb` for taps, swipes, text, hardware buttons and the accessibility tree (`describe-all`). Apple Pay works with test cards; in-app purchases through a StoreKit configuration file.
- **Android**: `adb shell input` and `uiautomator dump`, on any OS with the SDK.
- One simulator per agent (its own device ID) so two agents never install over each other's app; per-agent build caches (`xcodebuild -derivedDataPath` in the agent's folder).
- Logins: a password test account in test builds; "Sign in with Apple" needs an Apple ID signed in to the simulator, so it is avoided in tests.
- Isolation: the app runs inside the simulator, but `xcodebuild`, `simctl` and `idb` run as the OS user, and the Seatbelt profile of level 2 likely breaks them (they talk to system services; to test). For a QA agent the recommendation is a dedicated OS user, a rented Mac, or a **macOS VM** (Tart or UTM on Apple's Virtualization framework, at most two macOS VMs per Mac) with Xcode and the runner inside, reporting `simulator`. We document an image; we don't manage the VM.
- Daytona can't run the iOS simulator.

### 6. Virtual desktop

- **Daytona:** Xvfb + a window manager in our image, actions via `xdotool`. Network follows the org's mode.
- **Connected Linux:** the runner starts one virtual display per agent (`:1`, `:2`…) without touching the person's screen.
- **Connected Mac or Windows:** only inside a VM or container (macOS VM with Tart/UTM; Linux through OrbStack or Lima; Hyper-V or WSL2 on Windows), with the runner inside reporting the virtual display.
- To evaluate: run our runner inside Daytona computers too, so one screen implementation serves both kinds of computer through the channel of ADR 0025.

### 7. The owner's real desktop

What it means: the agent does whatever the owner's session can do, with their logins, files and open apps. Treat it like giving someone remote control.

- **Two opt-ins:** the machine offers it (`--desktop` at pairing, or later from the machine page, by the person who paired it), then that person gives it to a specific agent (§1a). The pairing screen spells out the consequence.
- **Native part:** the runner is a JavaScript bundle and can't capture the screen or inject input. In the desktop app (ADR 0036) this lives in its Rust side, signed and notarized with the app, so permissions attach to the agentes.chat app and are asked once under our name. CLI-only installs download a small signed helper (`agentes-desktop`) when desktop mode is turned on.
  - macOS: ScreenCaptureKit + CGEvent. Needs Screen Recording and Accessibility, granted by hand in System Settings (we show how). Unsigned builds lose them on every update, so this waits for signing.
  - Linux X11: `xdotool` + `xwd`/`import`, or the helper. Wayland: the RemoteDesktop/ScreenCast portal, which asks the user each session; documented as limited.
  - Windows: helper with `SendInput` and Desktop Duplication.
- **Limits:** nothing happens with the screen locked or the machine asleep; admin password prompts stop the agent (it is never given that password); macOS ignores synthetic clicks on some security dialogs by design.
- **One controller at a time:** a machine-wide lock; a second agent asking for the desktop waits or is told it is busy.
- **The person wins:** if the helper sees local input it didn't send (system idle time; whether this needs an extra permission is to confirm), the agent's session pauses and the agent is told. An on-screen indicator shows "<Agent> is using this computer" with a Stop button.
- **Two modes, chosen by the owner:** *watched* (runs only while someone with access has the live view open) and *alone* (runs unattended within the caps). Default: watched.
- **Session approval:** starting a desktop session is an approval card in the chat (who, what for, how long), approved by the machine owner. Other screens don't need it.
- **Approvals are not binding here.** With the owner's logins, the agent could click "Merge" or "Pay" in a browser where the owner is signed in. Same limit as ADR 0030 states for credentials; the docs say it plainly and recommend the other screens for anything that matters.
- **A rented Mac is one option, not the recommendation.** A Mac rented in the cloud (MacinCloud and similar) is just another connected machine: the runner needs outbound HTTPS/WebSocket and a user-level launchd agent (no admin). For the owner's desktop it also needs a logged-in graphical session (automatic login) and the two permissions granted once over remote access. Plans without admin rights or that end background processes at logout may not work; the docs list these checks. Whatever logins are left open on that Mac still apply to the agent.

### 8. Take over (a person drives, no model)

Take over is remote control by a person, of one agent's screen. The agent pauses while it lasts.

- **Agent browser:** frames from `Page.startScreencast` go over the WebSocket to the person's app (10–15 fps while controlling, about 1 fps while only watching); the person's input comes back and the runner injects it (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`; touch events from the phone app). Typed text goes through `insertText` so accents and IMEs work; only special keys go as key events. Paste is forwarded; popups and new tabs (OAuth windows) are followed. Coordinates are mapped from the displayed frame to the page.
- **Virtual desktop and simulator:** the same, with their own frames and input (`xdotool`, `idb`).
- **Done:** the login stays in the agent's own profile (cookies) and the agent continues from there, also next time.
- **Nothing reaches the model** during take over: no frames, no keys. The audit records who took over and when, not what was typed.
- **One person per agent screen** at a time (others watch: "Ana is in control"). It is per agent, not per machine: two people can take over two agents' browsers on the same computer.
- **Shortcut on a connected PC** with the person in front of it: the runner opens a visible Chrome window with the agent's profile; the person logs in normally and closes it. Passkeys, password managers and the home IP all work. Remote take over is for Daytona and for people away from the machine.
- **Limits:** passkeys and hardware keys stay on the person's device and don't work in a remote browser (they choose another method); datacenter IPs (Daytona) can trigger extra verification on Google, banks and shops.
- We never import cookies from the owner's own browser: that would hand the agent their sessions to everything.

### 9. Watching and stopping

- **Live view** on the run and on the machine page: the latest frames over the WebSocket (about 1 fps, only while someone is watching), the action log next to them.
- **Stop** ends the session at once (cancel to the runner, lock released). **Take over** pauses the agent until the person hands back (§8).
- Every action is audited (`computer.action`, with the action, not the typed text when it goes into a password field we can detect).
- The machine page lists who uses what ("Dev is testing the app in the simulator · iPhone 16", "QA is in the browser · shop.example/checkout"), each with Watch and Stop.

### 10. Several agents on one machine

- Screens of their own run in parallel: one browser, one simulator, one virtual display per agent. Only the owner's desktop is one at a time.
- **Ports:** each agent gets a port range from the runner (`PORT` and a range in its environment), so two dev servers don't collide.
- **Build caches:** per agent (Xcode DerivedData and similar caches in the agent's folder).
- **Heavy sessions cap per machine** (owner setting, default from the machine's memory): over it, sessions queue and the agent sees "waiting for the computer".
- Agents share the OS user, so one can read another's folder and browser profile unless both run protected (ADR 0030), as separate users, or in separate VMs.

### 11. Secrets on screen

`type_into(target, secret)` (raw form: `type_secret(name)`) types a secret already delivered with `request_secret` (ADR 0027) into the focused field. The model never sees the value; the runner reads it locally. A screenshot can still show it if the field isn't masked; the tool warns when the focused element (agent browser and simulator, from the structure) isn't a password field.

### 12. How this fits the isolation levels (ADR 0030)

| | Agent browser | Simulator | Virtual desktop | Owner's desktop |
|---|---|---|---|---|
| **Level 1** (environment per agent) | Yes. Profile and downloads in the agent's folder. | Yes. Own device, own build caches. | n/a (lives in a box) | Yes, but level 1 isolates git, not the screen: every agent with desktop access sees everything. |
| **Level 2** (Seatbelt / bubblewrap) | Yes, with an adjusted profile: Chromium needs its own cache dir, GPU/shm access and network (allowlist works). Chromium's sandbox inside ours needs testing on each OS; fall back to `--no-sandbox` only inside our sandbox. | Likely not (system services); to test. | n/a | **No.** Driving the real screen escapes any process sandbox: one click opens Terminal and types a command as the owner. So an agent has either the owner's desktop or protected mode, never both (§1a). Other agents on the same machine can still be protected. |
| **Level 3** (dedicated user / VM / container) | Yes. | **Best fit**: a dedicated user, a rented Mac, or a macOS VM with Xcode. | **Best fit**: a VM or container with a virtual display. We document the images. | A dedicated OS user has no graphical session unless one is logged in; possible, not something we manage. |
| **Daytona** | Yes (Chromium in the image). | No. | Yes. | n/a |

So the safe default is: agent browser everywhere, simulator for phone apps, virtual desktop for full computer use, owner's desktop only as an explicit, per-agent, watched-by-default choice.

Protected mode limits what *that* agent reaches. It doesn't hide a protected agent's folder from an unprotected agent on the same machine (one with the owner's desktop, or just a shell without the sandbox), since those act as the owner. Agents that must not see each other's work need protected mode on both, or separate machines.

### 13. Explorations become tests

The first run of a flow is exploration with the model. Then the agent saves the path as a test in the project (Playwright for web, Maestro for phone apps) and a routine reruns it on every deploy with almost no model: the judge only for visual checks, the main model only when something breaks (it looks, then fixes the test or opens an issue with the screenshots). A QA agent gets cheaper with use.

### 14. Runner protocol 4

New ops, each with a `target` (a monitor, a browser id, a simulator device): `screen.info` (monitors, scale), `screen.capture { target, maxEdge, format }`, `ui.tree { target }` (accessibility tree), `input { target, actions[] }` (batch, stops on first error), `browser.start | browser.stop | browser.snapshot | browser.act | browser.screencast`, `simulator.list | simulator.boot | simulator.shutdown`. The runner advertises `capabilities: ["browser", "simulator", "virtual_display", "desktop"]` in `hello` (only what it can serve); the server only offers tools a machine can serve. Older runners get no screen tools.

### 15. Until this ships

- On connected machines, Claude Code tasks can browse with Playwright through the shell and drive a simulator with `simctl`/`idb`, reading the screenshots they save. Good for trying flows now; no live view, no take over, model cost on the person's plan.
- Agents' instructions: when asked to "use my computer", offer the browser or the simulator; never improvise control of the owner's desktop (`screencapture`, `osascript`, `cliclick`), which would act as the owner with none of §7's safeguards.
- Amended with ADR 0165: a screenshot of a person's own Mac is allowed through commands (`screencapture -x` into the agent's folder there, then uploaded to the chat), since the app pairing asks for Screen Recording up front. Control (`osascript`, `cliclick`) stays out.

## Order

1. Agent browser, structure first: CDP on the runner and Chromium on Daytona, `read_page` with refs, intent tools resolved by structure, `type_into` with secrets, the MCP door for Claude Code and Codex, caps and Stop. No images needed yet. (A first try in hours: Playwright MCP in the config Claude Code tasks receive.)
2. Gateway images: image tool results in file storage, the generic adapter, the Anthropic toolset mapping, OpenAI after checking its tool; live view. Then the validation gate and `ScreenJudge` (Jev) for `click_on`, `wait_until`, `check` on pixels.
3. Take over: the visible window on a connected PC, then remote take over over CDP (web and phone).
4. Simulator on a connected Mac (iOS), Android emulator; the documented macOS VM image.
5. Virtual desktop: Daytona image, virtual displays on connected Linux, documented VM images.
6. Explorations saved as tests and rerun by routines.
7. Owner's desktop: macOS in the desktop app (after signing), then Windows, then Linux X11; per-agent choice that turns protected mode off; session approval card.

Test cases:

- A QA agent on a connected Mac tests the phone app's sign-up and first conversation in the simulator, sends screenshots of each step, and saves the flow as a Maestro test.
- The same agent runs a checkout in the agent browser against a Stripe test account, with a person taking over once to log in.
- A rented Mac (MacinCloud) paired as a connected machine runs the owner's-desktop path end to end (pairing, `--desktop`, permissions, automatic login, an agent with `owner_desktop`, live view, Stop, local input pausing the agent, reconnection after the provider restarts the Mac).

## Consequences

- Agents use web apps, phone apps and desktop programs whatever model they run on, with people able to watch, take over and stop them.
- Most screen work happens in places we or the owner isolate (agent browser, simulator, virtual desktop); acting as the owner is rare, explicit and visible.
- Intent tools and structure reads keep the main model out of most steps, which makes runs faster and cheaper and lets text-only models drive screens; this depends on the vision judge passing the validation gate.
- Computer use with pixels is expensive (an image per step); caps and the budget keep it bounded.
- We ship native code for desktop mode (in the desktop app, or a signed helper), which the rest of the runner avoided so far, and it depends on code signing.
- Approvals stay binding everywhere except the owner's desktop, and we say that out loud.
- Screenshots add personal data we store; short retention and no indexing limit it.
