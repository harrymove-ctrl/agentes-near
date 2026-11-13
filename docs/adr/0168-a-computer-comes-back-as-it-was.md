# 0168. A computer comes back as it was: what was open opens again after a restart or a move

- Status: Accepted
- Date: 2026-11-11
- Builds on: ADR 0029 (background tasks), ADR 0040 (the agent browser), ADR 0058 (the agents' desktops, their look in
  §15), ADR 0065 (§1: a desktop stays on once started), ADR 0161 (computers that sleep)
- Code: runner `desktop-session.ts` (`OpenOnDesktop`, `recordOpen`, `keeperList`, `reopen`, `terminalNote`, `close`),
  `desktop-keeper.py` (the keeper), `desktop-look.ts` (`KEEPER_FILE`, `KEEPER_SETTINGS`, `KEEPER_STATE`, the keeper's
  autostart entry, `LOOK_SCRIPT`'s live start, the Terminal's `bashrc`, `LOOK_VERSION` 7), `json-file.ts`
  (`readSmallJson`'s owner); engine `machine-tasks.ts` (`resumesByItself`, `settleInterruptedTask`), `sandbox-tools.ts`
  (what `start_task` and `task_status` say); i18n `machine_task_restarted`; tests `desktop-session.test.ts`,
  `desktop-look.test.ts`, `test_desktop_keeper.py` (through `desktop-keeper.test.ts`), engine `machine-tasks.test.ts`

## Context

A computer stops under its agents more often than it looks: the nightly reboot that takes the system's updates, a
host's restart, a sleep that ends in a real stop (ADR 0161), a crash, and an operator moving the workspace's computer
to another server (copying the workspace's folders, then pairing the new machine as the same computer, ADR 0056).
What lives on disk comes back: the agents' files, their sign-ins, their browsers' profiles. What ran doesn't. A move
held a workspace's agents for a few minutes, and a terminal open before it wasn't there after it.

Some of it already comes back:

- a run cut mid-turn waits for its computer and sends the turn again when it is back (`waitForDroppedComputer` in the
  executor), told what it had done already;
- a Claude Code background task resumes its session in its folder (`settleInterruptedTask`, ADR 0029);
- Chrome opens the tabs of its last session from the agent's profile (`--restore-last-session`), which travels with
  the agent's home. The runner closes its Chromes when it stops, and a Chrome sent `SIGTERM` by its scope's stop shuts
  down cleanly too, so its session files are whole. A start no longer hands a start page to a Chrome still on the
  profile, so restarts don't pile them up (fix/busy-tabs-terminals);
- the desktop's Terminals: each desktop keeps what is open on it beside its state (`<id8>.open`, `recordOpen`, at each
  sweep), and a desktop that a restart or a move ended opens its Terminals again at its next start, as new shells in
  the same folders, each saying why (fix/busy-tabs-terminals). That record and its `reopen` are the one place this ADR
  builds on.

What doesn't: the desktop's other windows (its Files windows, any other app), the browser shown on the desktop, a
shell command running in the background (a dev server), and a Terminal's history since its shell started.

Keeping the running programs themselves would mean keeping the computer's memory: a stateful stop or a live
migration of its VM, where it is one. That isn't a way for every computer. Incus, for one, starts QEMU from saved or
migrated state as root and drops its privileges only on a cold start; a running VM can't move between processors of
different vendors; and a computer that isn't a VM of the operator's own can't move at all. So what comes back is
rebuilt at the app level, on every computer: what was open opens again, fresh, and says so.

## Decision

### 1. The desktop's record holds everything open on it

`OpenOnDesktop` (`<runner home>/desktop/<id8>.open`, the runner's own file, written at each sweep while the desktop
runs) keeps:

- its Terminals, as the folders their shells were in (fix/busy-tabs-terminals);
- its other apps, each as its command line and its folder, from the keeper's list (§2): at most 20, a command line of
  at most 64 arguments and 4,096 characters, a folder that is absolute;
- whether the agent's Chrome showed there;
- the computer it was kept on (`/etc/machine-id`).

The runner's home travels with a move (the operator copies it with the workspace), and a reboot keeps it.

### 2. The keeper lists the desktop's app windows

Only an X client can tell which process owns a window, and the runner runs as root in system mode: it never talks to
an agent's X server. So each desktop runs a small program of its own in its session, as the agent: the keeper
(`desktop-keeper.py`). The look (ADR 0058 §15) writes it into the agent's home with its settings and an XDG autostart
entry, so XFCE starts it with every session, on the session's display and with its environment; a desktop that takes
a new look while it runs (the look's live mode) starts it there too. One per session: a second one finds the lock
taken and exits.

It writes `~/.local/state/agentes/windows.json` (its folder 0700, the file 0600) each time the window manager's list of
windows changes (`_NET_CLIENT_LIST`), and looks again every 30 seconds: each app with a normal window, its program and
arguments and its folder, read from `/proc` and only from this user's own processes; Files' windows one each (they
belong to Thunar's own process, often its daemon); whether the agent's Chrome showed there. Never a process's
environment, where secrets are. Left out: the Terminals (the record lists their shells itself), the session's own
programs (the window manager, the panel, the desktop, the settings daemon, XFCE's settings dialogs), dialogs (their
app is kept), Browser's notes, and another user's processes.

A list that lost windows is written only once it stayed so for 3 seconds. A session that ends closes its windows one
by one, and its keeper may see that before its own signal comes: the end never becomes the list.

The runner reads the list at each sweep (`keeperList`) only as a plain file of the HOME's owner, never through a link
(`readSmallJson`'s `owner`), so another user's list never becomes this agent's, and checks every entry: the file is
the agent's own, so anything may be in it.

### 3. The desktop's next start opens it again

The desktop starts as it does today, when it is wanted: someone opens it, or the agent's screen or browser needs it.
When its record survived (the desktop ended without the runner seeing it end: a restart, a move), it opens what the
record holds once its session settled, on the session's bus:

- the agent's Chrome through Browser's own way, the runner's Chrome on that desktop, which opens its last tabs;
- each Terminal as before, its note saying "The computer restarted: this is a new shell in the same folder.", or
  "moved to another server" when the record was kept on another computer;
- each other app with its command line in its folder. The agent's own shell changes into the folder (`sh -c 'cd "$1"
  || cd; …'`, its home where the folder is gone): root never enters a folder the agent could swap for a link.

A command that was running in a Terminal is never run again: it may have been halfway through anything.

### 4. A reboot keeps the record

A desktop that ends while the runner runs (stopped, parked, crashed) forgets what was open on it. A reboot stops the
runner and every desktop at once, and the runner's own stop takes seconds (its browsers close first): its desktops
used to end before it did, and their records went with them, so nothing opened again after the nightly reboot. Once
the runner is stopping (`close`), a desktop that ends is left as it is, its record kept, and isn't started again.

### 5. A terminal's history is kept as it is typed

The Terminal's startup file (the look's `bashrc`) appends each command to the history file at the next prompt
(`history -a` in `PROMPT_COMMAND`, before whatever the system already runs there). A shell killed with its computer
used to lose what was typed since it started; a Terminal opened again now has it under the up arrow.

### 6. Background commands start again

An agent's shell task (ADR 0029) cut by its computer stopping (`interrupted`: the scope stopped under it, or the
journal no longer has it once the computer is back) starts again when the computer is back, as Claude Code tasks
resume: the same command in the folder it ran in (a branch's worktree is already there), at most 3 times in a row,
never one a person stopped, never a mission's (its queue keeps its own order), and not on a computer whose tasks don't
resume (`machines.resume_tasks`). The thread hears `machine_task_restarted` ("MacBook is back: “Dev server” started
again"), and nobody is woken. Its environment is what the runner gives any start; nothing of it is stored. A person's
approval of the first start isn't the second's: a command the computer holds is refused then, and the agent is woken
to tell the people, as before. Codex tasks still stop and wake the agent.

### 7. Sleep, reboots and moves

- A paused computer (ADR 0161) keeps everything: there is nothing to open again.
- A stop after the pause: the runner was stopped before the pause, so the record is the desktop's as it was; its next
  start opens it ("restarted"), and the background commands start again once the computer is back.
- A reboot, a host's restart or a crash of the whole computer: the same (§4).
- A move: the old computer's runner stops first, then its agents' processes, and the record goes with the runner's
  home. On the new computer the first start of the desktop opens it ("moved to another server"); the commands start
  again when its runner pairs.

### 8. What can't come back

Only a process's memory would bring these, and nothing here keeps it:

- what wasn't saved: an editor's unsaved text, a REPL's state, a build halfway;
- a Terminal's scrollback: the Terminal holds it inside its own process (and in temporary files only it can read).
  Keeping it would mean recording every terminal's output through a wrapper of our own around each shell;
- the folder a Files window was browsing: its windows belong to Thunar's daemon, whose folder `/proc` doesn't show
  and whose title names only the folder, not its path. A window opens again on the folder it was opened on, else in
  the home folder;
- where each window was and its size: the window manager places them again;
- an app whose program lived on a mount that is gone (an AppImage), or whose command line runs past the record's
  limits.

## Consequences

- The look changes (`LOOK_VERSION` 7): a desktop gets the keeper at its next start, or while it runs once its look is
  refreshed (with nobody watching it and its agent idle for a minute). Until then the record has its Terminals and
  nothing else.
- One more Python process per running desktop, idle between window changes, with a `/proc` read every 30 seconds. It
  needs python3-xlib, which desktop use (ADR 0062) already installs; without it the keeper exits, and only the
  Terminals and nothing else come back.
- The runner changes (the record, the look it writes): computers get it with their runner's next update.
- The keeper's list is the agent's own file: whatever the agent lists opens as the agent, which could run it anyway.
- A shell task that does something once (a deploy, a migration) runs again after a restart, unless the computer holds
  it for a person: the thread says it started again, and its Stop ends it.
