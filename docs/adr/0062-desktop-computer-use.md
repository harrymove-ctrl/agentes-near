# 0062. Desktop computer use: the screen layer on the agent's desktop

- Status: Proposed
- Date: 2026-10-24
- Builds on: ADR 0054 (the screen layer: plans, targets in words, checks), ADR 0058 (a desktop per agent, the `desktop` handoff, the switches, `desktop:use` only with `sandbox:run`), ADR 0057 (system mode: each agent its own OS user, its worker), ADR 0027 (secrets and redaction), ADR 0040 (the agent browser)
- Supersedes, for the agent's desktop on a connected Linux computer: ADR 0031 §1 (one `computer_*` tool family under `computer:use`), §1a (`agents.screen`) and §6 (the virtual desktop's tools). None of them was built.
- Changes ADR 0054 for the browser too (§5, §8): a box taller than half the screenshot or wider than 80% of it is refused; words that can't be undone are never taken at a bare point; more words count as costly; an unsure check is judged once more with an image when the judge sees images
- Code: `packages/engine/src/screen/*` (desktop verbs, `ScreenSurface.kind`, `capture(region)` and `regions`, the close-up, `dismiss: false`); then the desktop surface and tools, and the runner's `desktop.ts`, `desktop-tree.ts` and `desktop-helper.py`
- Protocol: 21 (`DESKTOP_USE_PROTOCOL`), after ADR 0058's 18 and ADR 0059's 19 and 20

## Context

Agents need to work in apps that have no API or MCP: sign in, click and type in a native app, an OS or file dialog, a program with no web version. ADR 0058 gives each agent a desktop that people watch and control. ADR 0054 built a screen layer (look → find → act → check) over a `ScreenSurface`, with the browser as its first surface and the desktop left for later.

Driving a desktop runs commands. It has a terminal and "Open Terminal Here", and it reaches any site, outside the browser's site allowlist. The reverse holds too: code the agent runs has the display's cookie and can drive the screen. So desktop use is gated like running commands, not like the browser.

### Measured (a 4-vCPU, 8 GB VPS; Debian 13, XFCE 4.20, at-spi2-core 2.56; Xvfb at 1440×900 and Xtigervnc at 1280×800; Jev answering as `jev-1.14.0`, called from the same region)

| What | Result |
| --- | --- |
| Box, first pass, on 13 desktop targets × 5 | 39 of 65. Large targets 15/15. Boxes are quantized to 1% of the image (14 × 9 px cells at 1440×900); small targets near the top drift 10–35 px down; menu items spill into the next 27 px row |
| Box again on a 480×300 close-up at native size, around a small first box | 27 of 30 small targets, about 250–300 ms more. It hurts targets wider than the crop (an address bar: 1 of 3), so only small first boxes get it |
| Absent targets | reported absent 10/10 (present 0.18–0.34) |
| Choice over the tree (123 elements, text only) | 16/16 sensible picks, median 222 ms |
| Checks on the image | 15/15 right, median 348 ms |
| A 1600×1000 screen downscaled | 16/27 at 1280×800, 21/27 at 1568×980: native size is best |
| The accessibility tree | `Cache.GetItems` per app plus `GetExtents` sent together: Thunar 97 items in 10–20 ms, the panel 26 ms, Chromium 1,065 items about 300 ms with the Python unpack; the whole desktop 0.37–0.42 s. A libatspi walk: 0.5–2.1 s, no faster warm |
| Gaps in the tree | Thunar's icon view, xfwm4's title-bar buttons; Qt's `GetItems` is empty by design; GTK4 reports screen extents as (0, 0), and its cache holds only elements a client already asked about (the focused one and its ancestors); Chromium is absent without `ACCESSIBILITY_ENABLED=1` |
| GTK4 and Qt 5 windows on XFCE (Debian 13, `gir1.2-gtk-4.0` 4.18, PyQt5 5.15) | GTK4 with and without a header bar: boxes from window coordinates plus the window's origin past its shadow, the cache's missing buttons read node by node; Qt's tree walked from its root (5 nodes). Every button clicked at its box's center reached it. A look with either in front: 73–145 ms after the first (500–700 ms, the helper connecting) |
| Settling | comparing frames never settled with an animated page on screen; XDamage with busy tiles masked settled in 165–1006 ms over 6 actions |
| Capture | scrot JPEG q70: the whole screen 33–49 ms (about 140 KB), a region 11–21 ms |
| Input | xdotool 6–13 ms a call. `xdotool type` lost capitals and letters of pt-BR text at `--delay 3` (`ÁÉÍÓÚ` came out lowercase with letters dropped), and every non-ASCII letter without a UTF-8 locale |
| The helper's start | Python with Gio, Xlib and the bus: 186 ms, 28 MB |
| The helper on Xtigervnc at 1280×800 (`--self-check`) | a look with a native app in front 62–88 ms (p50), with Chromium's whole tree (950 items) 296 ms; capture 29–49 ms, a region 12–21 ms; act and settle 409–650 ms; a 2,000-character fill 130 ms; the pt-BR and symbol strings above typed and filled exactly |
| Apps' caches | at-spi2-core 2.56's apps answer `GetItems` only once some client listens for an event; until then the method doesn't exist |
| The runner's `desktop-check` on Xtigervnc at 1280×800 | a desktop's first look 4–5 s after it starts (its session coming up: the panel's window shows about half a second before its elements answer); then a look with the panel only 138 ms; an action checked, done, settled and looked at 0.55–0.9 s (the Applications menu opened 566 ms); launching the terminal, waiting for its window, 1.3 s; a screenshot 59 ms, a close-up 37 ms; a pt-BR line with capitals and `Ç` typed into the terminal exactly; the panel's Log Out refused |
| `eval:desktop:micro` on three scenes recorded on Xtigervnc at 1280×800 (the helper's JPEGs and the runner's looks; close-ups cut from them at q70), 3 trials | Box on 13 small targets: first pass 22/39, with the close-up 35/39; the close-up misses are the title bars' × (2–8 px left of or below it), so the agent's guidance says to close windows with their keys. 4 large targets 12/12 first pass; 4 absent targets said absent 12/12. Choice over the tree 14/14 (p50 199 ms). Checks: 5/7 on the text, 7/7 with the image; a check only the image can answer (a terminal behind another window) fails on the text with p 0.15, so the image re-check, which only follows an unsure answer, never sees it |
| The close-up enlarged: the same scenes, 4 trials, two runs; and 20 other small targets on them (12 the tree has, 8 only on the image), 2 trials | With the native 480×300 close-up: 42/52 and 44/52. On a title bar its box covered the × and the button beside it, or sat on that button (the dialog's ^, the window's maximize); on the menu it sat a row off ("the Settings submenu" on Web Browser or Accessories). The 240×150 around the first box enlarged twice, sent at 480×300: 52/52 in both runs, each of the 13 targets 8 of 8; the 20 others 38/40 (30/40 with the native close-up; both put "the maximize button" on minimize). Large 16/16, absent 16/16, Choice 14/14. Jev's p50 167 ms with the same calls (one more for a small target); enlarging (`Bun.Image`, lanczos3, JPEG q70) 3 ms. Jev refuses an image under 280 px a side, so the smaller region can't go as it is. A 480×300 region enlarged to 960×600 missed the window's × at the screen's edge (0/2); naming icons in the close-up's prompt didn't help (22/26) |
| The close-up sized from the first box: the eval with three small targets that a 240×150 close-up can't hold whole (two folders with their names, a 115×112 picture), three runs of 4 trials; a fixed 480×300, a fixed 240×150 and this side by side on 12 targets of that size, 4 trials, and on 4 of them, 8 trials; the 20 other small targets again, 2 trials | A fixed 240×150 refused those up close whenever Jev boxed them whole, over half the close-up's height (7 of 48 answers; the picture 0 of 4). Sized from the first box: the eval's small targets 185/192 (the 13 before 155/156, the folders 24/24, the picture 6/12: on any close-up Jev may box it with the dark card it overlaps, refused as not one control, while its first pass is 12/12), large 48/48 and absent 48/48 with the close-up, Choice 42/42; the 4 targets × 8 32/32 (a fixed 480×300 27/32: the picture boxed down to the image's bottom and refused 4 times); the 20 others 39/40 (30/40 with a fixed 480×300). Jev's p50 168–172 ms (max 442 ms), the same calls |

### Alternatives considered

- **One `computer` tool for every screen** (ADR 0031 §1): screens differ in verbs, availability, secrets and handoffs, and models pick better between named tools.
- **Screenshots only**, the way providers' computer-use loops work: a model turn per action and no exact targets. The tree gives exact names and boxes for most of a desktop.
- **A node-by-node walk of the tree**: 5 to 20 times slower than `GetItems`.
- **A D-Bus and X11 client in TypeScript**: two unmaintained dependencies in the compiled runner, against distro packages present on any XFCE machine.

## Decision

### 1. The desktop is a `ScreenSurface`

- Plans, targets in words, checks, `find`, reports and the target memory are ADR 0054's, unchanged. The surface says which screen it is (`kind: "desktop"`): plans and reports say "screen" where the browser's say "page", and the judge is asked about a desktop.
- Web pages go to `browser_do`, with its refs, DOM settle, site allowlist and site-bound secrets. The desktop's look collapses the agent browser's window into one line (`window "…" [agent browser: use browser_do]`), and `open` with a web address is refused with that hint. The desktop is for native apps, OS and file dialogs, and programs with no web version. Shell work stays in commands.

### 2. Tools and verbs

- `desktop_do` (a plan of up to 15 steps), `desktop_read` (a look, or `find`), `desktop_screenshot` (a JPEG saved in the agent's folder through `desktop.capture` and the existing `write`, for brains that read images themselves; with `share`, also sent to the Drive and shown with the reply, as `browser_screenshot` does), and ADR 0058's `desktop_ask_person`.
- The browser's verbs, plus:
  - `focus`: a window. Only window lines and the panel's window buttons are offered, never another element in their place.
  - `double_click` and `right_click`.
  - `drag`: `target` to `to`, both found on the screen as it is.
  - `type`: into a target, or wherever the focus is.
  - `scroll` over a target (else over the active window).
  - `open` with `app` (its exact name, else the closest by words, with the app list in the error) or `path` (inside the agent's home).

### 3. Desktop use is running commands

- Its tools use ADR 0058's `desktop:use` and are offered, and allowed on each call, only with `sandbox:run`, the org's sandbox setting on, and the machine's `commands` and `desktop` switches on. No new scope and no migration. Routines follow ADR 0058 §8.
- `hello.desktopUse` is available only when the agent runs as its own OS user (system mode, ADR 0057), different from the runner's and from every other agent's. A desktop as the runner's user would put a terminal in reach of every agent's delivered secrets and the machine's token, on a machine that self-hosters share across workspaces. The helper runs as the process that serves the agent, and the runner checks the rule on every request too; a runner where every agent works as the runner's own user reports it unavailable, with the reason.
- In system mode `desktop.look`, `desktop.act`, `desktop.capture` and `desktop.apps` are the agent's worker's ops (`OP_ROUTES`), so the helper runs as the agent's own user, next to its secrets, its folder and its browser. The desktop itself is root's (ADR 0058 §10): the worker asks the supervisor for it over their link (`desktop.ensure`), the supervisor starts it when it isn't running and answers with its display, cookie and home, never its VNC passwords, and only while that worker serves a desktop use request the server sent it, with the machine's `desktop` and `commands` switches on. The same frame puts the agent's Chrome on its desktop, with `use` saying which (ADR 0058 §14). `agentes-runner desktop-check`, run as root there, starts the helper through the agent's launcher.
- The runner also needs the machine's `desktop` and `commands` switches on for every desktop use request.
- Mac and Windows runners have none: the reason says it needs a Linux machine with the agents' desktops.

### 4. What the agent sees: the accessibility tree of what is in front

- One `org.a11y.atspi.Cache.GetItems` per app plus all `GetExtents` at once. Never a node-by-node walk, except a capped one (about 500 nodes or 300 ms) for an app whose cache comes back empty (Qt) and below a showing element whose cache holds fewer children than it has (GTK caches only what a client asked about); past the cap the app is found on the image only. Lists that make their children on demand (`MANAGES_DESCENDANTS`) aren't walked.
- In front: the active window, the windows and popups above it (the root's children from `XQueryTree`, so override-redirect menus count; tooltips never cover), and the panel. A menu's items may be drawn in a popup of their app above the menu's window (GTK3's menu bars): they are checked against that popup. Windows behind are one line each (to focus them), and a window in front with nothing readable says to find targets on the screen image.
- Lines like `agent-browser`'s: two spaces per level, one-word roles, attributes in brackets, `[ref=eN]`. Roles are mapped (`push button` → button, `menu item` → menuitem, `frame` → window, `dialog` and `file chooser` → dialog, …). Nodes that aren't showing, are off the screen, have no size or are covered at their center are dropped. Text is read for terminals, entries and text (capped, a terminal's last lines), never for password text.
- The address is `desktop://<app>/<main|dialog>`: the target memory is kept per app, and another app or a dialog is a new screen. The window title is the report's head ("Now in … — <title>"). An element reads with its window: `button "Save" — in dialog "Save As" › window "Report.odt - Writer"`.
- GTK4 apps report screen extents as (0, 0): their boxes come from window coordinates plus the X window's origin, past the shadow a window that draws its own decorations has (`_GTK_FRAME_EXTENTS`).
- Screen text is untrusted, and so are window titles, which a web page sets. Every name and text is written on one escaped line (newlines and control characters as spaces, `\` and `"` escaped, `ref=` neutralized, text lines quoted). The parser reads a ref only from the attribute bracket right after the role and the quoted name, so a title like `Invoice ref=e9` can't relabel another element; this closes the same gap in the browser, whose names come from pages.
- The look is redacted like command output (ADR 0027) before it leaves the machine, so a delivered secret a terminal prints reaches neither the model nor Jev. Images can't be redacted.

### 5. Targets: the same order, and a close-up for small ones

Ref → exact name → target memory → the judge's Choice over the tree's elements → Jev's Box on a screenshot. On the image:

- A box taller than half of it or wider than 80% of it isn't one control: nothing is found. This applies to the browser too.
- On a surface that takes regions, a first box no larger than 15% of each side is boxed again on a close-up of the screen around it, kept inside the screen: three times the box's height and 1.5 times its width, never less than 240×150, in the 480×300 shape. The server resizes it to 480×300 before the judge sees it, so a glyph's 240×150 is enlarged twice and a folder's tile is seen at about its own size. At native size Jev's box on a control of about 14 px lands on its neighbor, and Jev refuses images under 280 px a side, so a small region is enlarged rather than sent as it is. The room is for Jev boxing the target whole up close (a folder with its name, a picture): up to 1.5 times the first box's height and 1.2 times its width stays one control by the rule above. The close-up's answer is taken when the judge says it's there (≥ 0.6) and it is one control; otherwise nothing is found, since the first box was most likely on a neighbor. A close-up that can't be taken or resized leaves the first answer.
- The point lands on the smallest marked element (the tree's boxes) that contains it, so the action is as exact as a ref.
- Words that can't be undone are never acted on at a bare point; the plan stops and says so. This applies to the browser too.
- Screens up to 1568 px a side go at native size, the 1280×900 desktop included; a larger one is downscaled for the first Box only.

The costly words that need a 0.85 pick gain what a desktop throws away, for the browser too: trash, discard, don't save, close without saving, overwrite, replace, empty, uninstall, format, and in pt-BR lixeira, descartar, não salvar, sair or fechar sem salvar, sobrescrever, substituir, esvaziar, desinstalar, formatar.

### 6. A dialog in the way is never closed on a guess

The browser closes a covering banner once (ADR 0054 §5). On a desktop what covers is usually a real dialog ("Save changes before closing?") whose buttons throw work away, and the dismiss pool would include the panel and other windows. Desktop plans run with `dismiss: false`: the plan stops, names what covers the target, and looks again so its report shows it. A window is named by the number its line has in a look (`covered by window e14`), never by its title: the stop reason reaches the agent outside the untrusted screen text, and a title is screen text (a web page sets its window's). The agent's browser, a menu or popup and the panel are named as such.

### 7. Acting and settling, in one round trip

- `desktop.act` does the action, waits for the screen to settle and looks again, in one runner op, like `browser.batch`. Right before it acts, the runner asks for the element's box and the window stack again: an element that is gone or moved since the look is a stale ref (the plan finds it again on a new look), one under another window is `covered by window e14` (§6), and an action on a desktop that started again since the look is stale too. A desktop that starts again numbers its elements after every ref the agent was given before, also across the runner's reconnections: a number kept from before is stale, never another element.
- Settling by XDamage: changed rectangles arrive as events; 32 px tiles that were already changing in the 150 ms before the action (clocks, animations) are ignored; quiet after 120 ms, up to 400 ms for a late first change, 2 s at most. Starting an app or opening a file first waits for a new window or a change of the active one, up to about 10 s. A double click doesn't: it mostly opens a folder in place, where no window comes and the step would always wait the whole time; a step that starts an app that way says what it waits for with `expect`.
- The damage is what the screen shows only because the desktop's compositor doesn't wait for a vblank (ADR 0058 §1). While it waited, with nobody watching, an app's new window was in the look, listed and active, while the image taken after the settle still lacked it: Thunar reached the screen 1.8–2.3 s after its launch and the first image search failed 8 times of 8; without the wait, 0.38–0.59 s and 14 of 14. An app that paints its window longer than the quiet time after mapping it, with nothing else changing meanwhile, can still be captured blank. X reports no first paint: a new window may also get damage as it shows, before its app draws anything, and whether it does depended on the order in which the window manager mapped it and its frame, so a per-window wait for the first paint was measured and left out. A target looked for on that image is not found, and the step can be retried.
- A desktop that just started has nothing to act on until its session is up: its first look waits for the panel's elements (seconds, at most 20 s after the start).
- Input goes through xdotool; windows are focused by their id, not by pixels, and closed with their keys (the title bar's × is only on the image). A panel's button stands for a window only when no other window has its title.
- Text: a field with `EditableText` is set with `SetTextContents` and read back. Other text goes as keys, at least 12 ms apart, when it is ASCII, and through the clipboard when it isn't. A read-back that doesn't match fails the step ("the text didn't come out as written"). The helper runs with `LC_ALL=C.UTF-8`. At most 4,000 characters a step.
- Targets that would end the session (Log Out, Shut Down, Restart, Suspend, Lock, Switch User, and their pt-BR names) are refused inside the session's and the panel's own apps, with `bad_request` (`not_allowed` stays for a switch that is off). This is a convenience: the real guard is the session's own config (no logout actions or shortcuts) and ADR 0058's supervisor.

### 8. Checks

`expect` and `wait until` are judged on the text first. When the judge is unsure (0.35–0.6) and sees images, it judges once more with an image of the screen: much on a desktop only shows (a progress bar, a window that drew). The browser does the same.

### 9. The helper

- A small Python program per agent desktop, run as the agent's OS user with `python3 -I -c <source>`: no file to read from a home that is 0700, and `-I` keeps the agent's own site-packages and `.pth` files out. It uses `python3-gi` (Gio's D-Bus for AT-SPI), `python3-xlib` (the window stack, XDamage, XTEST), `xdotool` and `scrot`: distro packages, nothing added to the compiled runner.
- It finds the accessibility bus from the root window's `AT_SPI_BUS`, takes both `GetItems` signatures (at-spi2 2.56's and the older one), speaks JSON lines on stdin and stdout and never logs what it is sent. Apps start with the session's environment (read from the session's process) and in the agent's home, so they show in the tree like apps opened from the menu.
- Apps keep no cache to give until a client listens for an event, so the helper registers one cheap event (`window:activate`) when it connects; every app on the bus, and every one started later, then answers `GetItems`.
- Pasted text is the helper's own: it owns the clipboard and the primary selection (text fields paste the first on Shift+Insert, terminals the second) and sends the next keys only once the focused app took the text, so they land after it. It keeps the selections between pastes: taking them again makes the VNC server and the session's clipboard managers read them each time.
- Filtering, refs, occlusion and guards live in the runner's TypeScript, where they are tested; the helper's pure parts (both `GetItems` formats, the settle state machine) have Python unit tests.
- The runner treats it as the agent's process: replies capped and checked, a restart on any violation or after 3 failures in a row, a stop after 15 idle minutes.

### 10. Protocol

```ts
RunnerInfo (hello): desktopUse?: { available: boolean; reason?: string }
MachineRequest (each carries `agent`):
  { op: "desktop.look" }                                    // → { snapshot, refs, address, title, screen: { width, height } }
  { op: "desktop.act"; action: DesktopAction; settle }      // → { look?, settled? } (false: still changing at the cap)
  { op: "desktop.capture"; region?: { x, y, width, height } } // → { data (JPEG q70), width, height, screen, region, marks }
  { op: "desktop.apps" }                                    // → { apps: { id, name, generic? }[] }
DesktopAction:
  { kind: "click" | "double_click" | "right_click" | "hover" | "focus" | "check" | "uncheck"; at: { ref } | { x, y } }
  { kind: "drag"; from; to }   { kind: "fill"; at; text }   { kind: "type"; text; at? }   { kind: "select"; at: { ref }; value }
  { kind: "press"; key }   { kind: "scroll"; direction; pixels; at? }   { kind: "launch"; app }   { kind: "open_file"; path }   { kind: "pause"; ms }
DESKTOP_LIMITS: text 4,000 characters, key 64, path 1,024, pause 10 s
```

Errors keep the plan's wording: `stale ref: e12 is no longer on the screen` and `stale ref: e12 moved since the last look` (the target is found again once), `covered by window e14` (§6), `the text didn't come out as written`, a refused session ending as `bad_request`, and `desktop_unavailable` when the session or the helper is gone (ADR 0058's supervisor starts the session again, the runner the helper).

### 11. Safety and its limits

- Screen text reaches the model only inside the untrusted block; reports name elements by role and number.
- The judge only points. Costly picks need 0.85, nothing on the screen grants anything, and approvals are the agent's to ask for, as before.
- X11 doesn't isolate programs on one display, and `ptrace` is open within one user: code the agent runs can read its desktop's screen and keys and the helper's memory. Typing a delivered secret into a native app is therefore not offered; logins go through ADR 0058's take control, and the session stays in the agent's home.
- Every Jev call is recorded with `org_id` and `agent_id`.
- Each step goes on the message the run posts next (`meta.desktop.steps`, as the browser's `meta.browser`): the tool it stands for (`desktop_click`, `desktop_open`…), the app an `open` started in the agent's words, when, and whether it failed; never what was typed or read. The chat shows it in the browser's card, with the app in place of the site and no link.
- Each app and file a plan opens is in the org's audit log (`desktop.app_opened` with its desktop entry, `desktop.file_opened` with its path; the agent as actor, the computer as target), for whoever watches what agents run.

### 12. Without Jev, and on the Cloud

No new server env vars: availability comes from the machine and the scope, and Jev uses `TYPESAFE_API_KEY` and `JEV_VISION_MODEL`. Without Jev, refs and exact names work, checks use the org's cheap model on the text, and nothing is found on images. All of it is public code, and the Cloud runs the same.

### 13. A person-only step is handed over (2026-11-03)

`desktop_ask_person` and the desktop guidance follow the browser's hand-off (ADR 0040 §6 addendum): an app that needs the person's sign-in, a QR code, a code or a captcha is opened and brought to that step, then handed over; it is never a reason to stop. Without `desktop_ask_person`, the agent says the one step the person must do.

## Order

1. This ADR, and the screen layer's part: the desktop verbs, `kind`, region captures and the close-up, box sanity, the costly words, `dismiss: false`, image re-checks (done here).
2. The Python helper, with its unit tests and a check on a real desktop.
3. The tree as screen text in the runner (escaping, occlusion, GTK4 boxes, the Qt walk), and the parser's strict ref.
4. The protocol, the runner's desktop manager (one helper per agent, refs, guards, redaction) and `agentes-runner desktop-check`.
5. The desktop surface, its status and tools, gated under `sandbox:run`, and the agent's guidance.
6. The trail on the message, an eval (`eval:desktop:micro`) and `SELF_HOSTING.md`.
7. End to end on a real Linux machine: a folder made in the file manager, a command's output read from a terminal, a costly dialog, Log Out refused, an icon found only on the image, a person taking control mid-plan, pt-BR text, an app started, a forged window title.

## Consequences

- An agent works in any desktop app in one or two turns of its model, with the browser's targets, checks and reports.
- A small target costs a second Box (about 170–300 ms, plus 3 ms to resize the close-up); a step takes about 0.6–1.2 s.
- The browser changes a little: oversized boxes and costly bare points are refused, more words are costly, and an unsure check gets one look at the image when the judge sees images.
- Desktop use needs Linux, system mode and a few distro packages; Mac and Windows runners keep the browser only.
- Secrets typed into native apps wait; X11's lack of isolation is a stated limit, not something this fixes.
