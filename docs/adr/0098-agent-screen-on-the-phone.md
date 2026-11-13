# 0098. The agent's screen on the phone

- Status: Accepted (built: the server's page, the phone app; §2's session in a WebView still needs a test on a real phone)
- Date: 2026-11-01
- Amends: ADR 0058 §13 (a request on the agent's desktop is never taken from the phone), ADR 0065 (what the phone's computer view shows)
- Code: `apps/web/screen.html`, `apps/web/src/screen/*` (`ScreenSession`), `apps/mobile/src/features/computer/AgentScreen.tsx`, `screen-page.ts`, `screen-view.ts`, `pixel-cursor.ts`, `apps/mobile/src/features/browser/useFinishHandoff.tsx`, `packages/client/src/browser/index.ts` (`takeover` with a screen)

## Context

An agent stops when it needs a person: a check only a person can pass, a code sent to a phone, a sign-in. Those requests reach people through the phone, often away from a laptop. For the agent's browser the phone already helps (ADR 0040). For the agent's desktop it doesn't: the request says "Ajude pelo notebook" ("Help from a laptop"), and while the agent works in another app the view points to a laptop to watch it. So the agent waits, up to the request's whole time, for a person who was reachable all along. It also splits one idea in two: the same person can help with Chrome when it runs headless, and can't once the same Chrome runs on the agent's desktop.

ADR 0058 §13 kept the phone out because taking a request "would hold the desktop for someone who can't see it". Seeing it is what this ADR adds.

### What is already there

Nothing on the server needs to change for a first version:

- `/api/desktop` is a person's socket, and `personUpgrade` takes either our own Origin or the phone app's session.
- `GET …/desktop` gives the state, `canControl` and the open handoff. Starting on the first viewer means there is no "start the screen" step.
- Control is a handoff on the `desktop` screen (ADR 0058 §5): `…/desktop/takeover`, the request routes, the note on hand back, the rule on who may (`drivesComputer`), the audit.
- A socket changes mode in place (ADR 0058 §17), and `@agenteschat/client` already has the close codes, states, retries and `desktopMode`.
- `CONTROL_GRACE_MS` gives a person who drops 2 minutes to come back.
- The web's `DesktopLink` hands noVNC a channel of its own, so noVNC doesn't care what carries its bytes.
- The phone has the entry (`AgentComputerButton`, beside Conversar on the agent's profile), the full-screen view (`/computer/<agentId>`), the request card, the push that opens it, the live steps of the run, and the keyboard on the screen (key by key, with `TypeBar` for a password and the system's autofill).

### Why the phone is not a small laptop

The desktop is 1280×900 (`DESKTOP_SIZE`). At a phone's 336 pt it is drawn at 0.26: a 20 px target is 5 pt, far below what a finger hits. Tapping the picture as the browser card does isn't enough here, so control needs zoom, a trackpad, or both.

## Decision

### 1. One view, the same entries

`/computer/<agentId>` shows the agent's screen wherever the computer serves one, and the page as today where it doesn't. The stages `otherApp` and `laptop` go. `cardStateOf` loses `computer`, `phoneEntryButton` and `screenRequest` stop treating a request on the screen as something else, and "Ajude pelo notebook" leaves the app. The request card opens the view for a request on the screen. The agent's browser card in the conversation stays as it is.

### 2. noVNC in a WebView, on a page of the server's

The app shows `/screen.html`, a second entry of the web app's build, the precedent being `/human-check.html`: a WebView on the server's own origin. It holds noVNC 1.7.0 and `DesktopLink`, takes commands from the app (pointer, keys, text) and sends its state back. noVNC only draws, at the desktop's own size: the WebView is as large as the desktop, in points, and the UI thread moves and scales it, so pinching and following the cursor never cross the bridge. The pointer goes straight onto the session's channel as an RFB message, since noVNC reads one only from a mouse over its canvas. The web's code is the only implementation of the protocol, a self-hosted server serves the page that matches it, and a fix to it needs no app release.

The page's origin is `PUBLIC_URL`, which `allowedOrigins` already accepts, so its socket opens directly, with no bridge through React Native. What it lacks is the session: the app sets its cookie in a WebView with no persistent storage (`incognito`), which only ever loads this page and leaves with it. The cookie is readable by the page there, unlike the browser's `HttpOnly` one, which is why nothing else may load in that WebView.

If that doesn't hold on a real phone, the fallback changes one piece: the app opens the socket (it already sends the session's headers, `createSocketFactory`) and passes the bytes to the page, base64 over the WebView's bridge, with a cost in latency that has to be measured.

Rejected:

- **An RFB client in React Native, drawn with Skia.** No WebView, and gestures and drawing in one place. But it is a second implementation of the protocol, and Tight's zlib streams in the app's JavaScript engine, which has no JIT, are the risky part. If the WebView is too slow, this is the next thing to measure.
- **A picture stream from the runner, as the browser has.** It would need a new protocol version and capture on the computer, for what RFB already does with its own flow control.

### 3. A trackpad under the screen

Swipe moves a cursor, tap clicks, hold drags, two fingers scroll, and the view follows the cursor near its edges. A slow swipe aims and a fast one travels (`cursorGain`). Touch on the screen itself (tap to click, as the browser card) and a landscape view were tried against it; the trackpad was picked as the friendlier of the three, and it never covers what it points at.

On the screen, pinch zooms and a drag moves the view, and a tap brings the cursor there without clicking. The view starts by filling its space in control, and shows the whole desktop while watching.

The app draws the cursor over the screen, since a remote pointer doesn't show under a finger, or at all where a desktop draws none. It is ours rather than a circle or the system's: a pixel arrow in the brand's dither, with a light rim and a soft shadow so it reads on any window, whose tip is where a click lands. It shrinks a little on a click and grows while dragging.

Sideways, in control, the trade changes, so the phone gets the other answer. Lying down, the picture fills the phone's width at 0.73, a 20 px target is 15 pt, and there is no room for a pad beside it that doesn't shrink the picture back. So the finger is the mouse: a tap clicks where it lands, a drag rolls the view and then the page under it (`dragView`), a hold presses and drags, two fingers move and zoom the view. The cursor stays out of the way; a ring and a spot under the finger say what happened. A dock over the picture keeps the notice's ⓘ, the keyboard and handing back, and rests faint between touches. Only this view turns, and only in control (`useSideways`): the rest of the app stays upright, and a button on the trackpad lies it down when the phone's own rotation lock is on.

### 4. Typing

Straight onto the screen, key by key, as on a computer: the keyboard button opens the phone's keyboard over the screen and each key goes there as it is pressed, with nothing typed twice and no draft in between. The keys go to a field nobody sees, as the web's `useScreenKeys` does, read as what changed in it (`typedSince`: Backspaces for what went, then what came), so a swiped word or the keyboard's own paste arrives whole; on an empty field Backspace changes nothing, so the key itself is read; Return is Enter. A row over the keyboard has what a phone keyboard lacks (Esc, Tab and the arrows), Paste, and Password. While typing, a tap on the screen clicks where it lands, since the trackpad is under the keyboard, so another field can be picked without closing it. The keyboard coming or going keeps the zoom the person had and moves the view only as much as keeps the cursor in sight (`keepView`); the view frames the screen again only when control, the phone's side or the desktop's size changes.

Password opens the app's `TypeBar` in its password mode instead: a whole text to the field in focus, the same words as the browser, so the system's saved passwords work and a password never lands in the conversation. Text goes as on the web (ADR 0058 §16): typed as characters where noVNC can, pasted otherwise.

At first typing was `TypeBar` alone, a whole text sent with a button, chosen for the system's autofill. In use it read as a chat box rather than the computer's keyboard: nothing showed on the screen until sending, and each correction was a round trip. Key by key with the password field one tap away keeps both.

### 5. Watching

The space under the screen isn't empty: the run's live steps, the same ones as the view's sub-line, and the composer, so a person can tell the agent something while watching (ADR 0029 covers what happens to it). In control, that space belongs to the control.

### 6. Leaving and handing back

"Devolver" is the same call and the same optional note. iOS closes a backgrounded app's socket, so leaving the app in control starts the 2 minutes of `CONTROL_GRACE_MS`; coming back reopens the socket in control as `desktopMode` says, and the grace ending hands back as it does on the web. `useBrowserHandoffActions.takeover` gains its `screen`: the route and the API client already have it.

### 7. What doesn't change

Who may watch and control, the scope, the audit, nothing stored of what's shown. Watching at quality 3 and control at 6 stay, unless the test on a real phone over a mobile network says otherwise. No terminal (ADR 0065 §1).

## Open questions

To answer on a real phone before building past the test:

- Does a WebView's socket send a cookie set from the page, on iOS and Android, and does `incognito` keep it from staying?
- Time from a touch to the picture answering, on Wi-Fi and on a mobile network.
- Data per minute watching and in control: a person on a phone pays for it.
- Memory and heat over ten minutes in control.

- A phone that reaches a self-hosted server by another address than `PUBLIC_URL`: the page's Origin is refused. It reads as a screen that doesn't open (30 s, then "Tentar de novo"), and the fallback in §2 is what would fix it.

Later, if it's wanted: a request that says where on the screen it is, so the view opens on it (the handoff doesn't carry that today, though the agent's screen layer knows its windows and regions, ADR 0062); the computer's clipboard on the phone; right click.

## Consequences

- A request on the agent's desktop can be answered wherever the person is, and the agent waits less.
- The browser and the desktop stop being two stories on the phone.
- A person can now hold a desktop from a phone on a bad network. The grace bounds that, as it does for a laptop.
- The app has a WebView that holds a session. It is narrow by design, but it deserves its own review.
- Testing needs a real connected Linux computer and a real phone: the simulator says nothing about touch or a mobile network.

## Addendum (2026-11-07): the cookie on Android

The first open question, on Android: not reliably from the start script. react-native-webview runs `injectedJavaScriptBeforeContentLoaded` there at `onPageStarted`, where it may still reach the document before the page, and every `incognito` WebView clears all WebViews' cookies as it mounts. A socket opened with no session is refused before the upgrade and closes with no code, so the screen stays on "Abrindo o computador…" until it says it can't be shown, while the web shows it: what a phone on Android saw after the update. The app now sets the cookie again in the page's own document whenever its socket may open next: on `ready` and on `changed`, before the page opens again after a close (`sessionAnswer`), and just before each `set` or `retry` it calls (`pageCall`: coming back to the app, a mode switch, Tentar de novo), in one WebView both views share (`ScreenPage`). A view that never opens is reported (ADR 0104), and so is one whose state (`GET …/desktop`) never comes, which used to stay on opening with no end (`screenWaits`).
