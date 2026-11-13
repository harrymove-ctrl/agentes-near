# 0076. Screening people's sessions on Cloud computers

- Status: Accepted (built: the server, the runner and the web app; sampling and judging are left to the operator's own service)
- Date: 2026-10-27
- Amends: ADR 0058 (§4, §6, §12), ADR 0056 (§5, §6)
- Code: `packages/engine/src/session-screening.ts`, `packages/engine/src/streams.ts` (`onReady`), `packages/engine/src/operator-review.ts` (`session`), `apps/server/src/engine.ts`, `apps/server/src/operator/events.ts`, `apps/server/runner/desktop.ts` (`desktop.text`), `apps/web/src/components/desktop/DesktopView.tsx`

## Context

A person in control of an agent's screen acts as the agent's OS user (ADR 0058 §4). The network rules bind them as they bind the agent, but the content judge that reviews the agents' runs and tasks (ADR 0056 §6) never saw what a person did there. The apps have no terminal view (ADR 0065 §1): in control, the desktop's own Terminal app is on the screen, so the screen's text covers it too.

## Decision

1. **Off by default.** `SESSION_SCREENING` turns it on, for agentes.chat Cloud. It needs `OPERATOR_API_TOKEN`, the only way the text can be read, and the server refuses to start without it. A self-hosted server leaves it unset and screens nothing. It is public code switched on by an env var (ADR 0002).
2. **The screen's text every 30 s, read on the computer, never an image.** While a person is in control (a `control` desktop stream that got its data socket), the server asks the computer for `desktop.text` (protocol 25) every 30 seconds, one read at a time. The runner captures the screen as `desktop.capture` does and answers `same` when the capture is the one it read last. Otherwise tesseract reads it (`eng+por`, at `nice -n 19`, 10 s at most) as the agent's own OS user, in the agent's worker, and only the text comes back, trimmed and cut to 16,000 characters. It takes no look, so the agent's refs stay as they were. Without tesseract it answers `desktop_unavailable`. It goes through desktop use's helper and switches (ADR 0062), is never refused as busy, and isn't new work: a hold or a pause that begins while a person is in control doesn't stop it.
3. **Never captured:** the image, keys, the clipboard, the pointer, what the screen doesn't show (a password typed at a prompt), and watch-only streams.
4. **Memory only, for up to 20 minutes.** The text stays in the server's memory, in segments of up to 10 minutes. A screen whose text didn't change is kept once, and a segment keeps its first screen and the latest ones, 48 KB at most. A segment ends after 10 minutes or when the stream closes, and a new one starts while the person stays in control. It is dropped 10 minutes after it ends, read or not. Nothing of it goes to the database, a log line or an event. A segment that read something ends with `desktop_control.ended` (ADR 0056 §5): ids, times and how many screens.
5. **Only the review door reads it.** `GET /review/session/{segmentId}` (ADR 0056 §6) builds a block from the live segment: who was in control, of which agent and workspace, from when to when, how many screens, then the screens' text, credentials masked and inside `<external_data>`, cut to 12,000 bytes keeping the first screen and the latest. Each read is a `content.viewed` event. Once the segment is gone, a 404.
6. **The operator's service samples and judges.** It draws segments from `desktop_control.ended` as it draws the agents' actions, reads the drawn ones through the review door, and Jev judges them with the same questions. A confident verdict flags and pages, a new workspace may be held, and nobody is suspended or wiped automatically.
7. **No terminal socket where sessions are screened.** `/api/terminal` closes with 4404 (`no_terminal`) before the computer is asked anything: a shell nobody screens would be the way around it.
8. **Cost.** About US$ 0.0002 a judged segment, 0.1 cent an hour of a drawn session. The CPU is the computer's: one OCR of a screen that changed, every 30 s.
9. **What people see.** On agentes.chat Cloud the take-control line keeps its words and gets an ⓘ: "We may check the text on this screen for abuse. We keep only the result. What the screen doesn't show, like a password at a prompt, is never captured." It says "may", so it holds whether or not the switch is on, and no field tells the apps. Self-hosted computers show no ⓘ. The phone and the desktop app open no control stream of their own.
10. **Older computers, and refusals.** A runner older than protocol 25 gets no segment, logged once per computer. A computer that refuses a read (no tesseract, desktop use off, its desktop helper stopped) is logged once too and asked again 30 s later. A refusal never stops the reads, so a segment still ends after 10 minutes, and one that read nothing ends without an event.

## Consequences

- Operators can't browse past sessions: 20 minutes after a segment began, at most, there is nothing left to read.
- OCR misses abuse that is only an image (a logo with no text), mangles some scripts and dense layouts, and misses what happened between two reads. Jev could read the image, at about 6 times the cost, once the privacy policy says images leave the computer.
- The person in control acts as the same OS user that reads the screen, so they could get in its way. The network rules are the control that holds regardless; this adds evidence.
- The segments live in one process. A second server replica would need them elsewhere: the operator API's review door must reach the replica that holds the computer's socket.
- Self-hosted servers send nothing anywhere and keep their terminal socket.

## Alternatives considered

- The accessibility tree (`desktop.look`): it shows the agent's own browser window as one line, so it can't see the page a person browses in control, the case that matters most.
- Reading the terminal's output at its PTY: no app opens that terminal any more, and closing its socket where screening is on leaves no shell unscreened.
- Sending the image to Jev's vision model: 6 times the cost, and the image would leave the computer.
- One event when a session starts and another when it ends: one per segment, when it ends, is all the sampling needs, and `session.*` already names sign-ins.
