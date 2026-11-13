"""
The desktop's keeper (ADR 0168): the list of the app windows open on an agent's desktop, which the runner keeps with
the rest of what is open there (`recordOpen` in apps/server/runner/desktop-session.ts) and opens again when a restart
or a move of the computer ended the desktop.

- Only an X client can tell which process owns a window, and the runner runs as root in system mode: it never talks
  to an agent's X server. So the keeper runs in the desktop's session, as the agent: XDG autostart starts it with
  the session (`~/.config/autostart/agentes-keeper.desktop`, which the look writes: desktop-look.ts), and a desktop
  that takes a new look while it runs starts it too. One per session: a second one finds the lock taken and exits.
- It writes STATE_FILE (its folder 0700, the file 0600) on every change of the window manager's list of windows
  (`_NET_CLIENT_LIST`), and looks again every POLL_S. For each app with a normal window: its program, arguments and
  folder, from /proc and only of this user's own processes, never their environment (where secrets are); Files'
  windows one each (they belong to Thunar's own process); whether the agent's Chrome (the runner's) showed there.
  The Terminals are the runner's to list (their shells' folders, from /proc), and Browser's notes, dialogs and the
  session's own programs are left out.
- A list that lost windows is written only once it stayed so for STABLE_S: a session that ends closes its windows
  one by one, and its keeper may hear that before its own signal comes. The end never becomes the list.
- The pure parts come first; test_desktop_keeper.py runs them without X. Xlib is imported only by XWindows: where
  python3-xlib isn't installed the keeper exits at once, and the desktop's other windows aren't kept.
"""

import fcntl
import json
import os
import select
import sys
import time

VERSION = 1
STATE_DIR = os.path.join("~", ".local", "state", "agentes")
STATE_FILE = "windows.json"
LOCK_FILE = "keeper.lock"
POLL_S = 30
STABLE_S = 3
APPS_MAX = 20
ARGS_MAX = 64
ARGV_CHARS_MAX = 4096
PATH_MAX = 1024
TERMINAL = "xfce4-terminal"
FILES = "thunar"
FILES_WINDOWS_MAX = 4
# The session's own programs and XFCE's settings dialogs: the session starts them, or nobody would want them back.
SESSION_PROGRAMS = {
    "xfce4-session",
    "xfwm4",
    "xfce4-panel",
    "wrapper-2.0",
    "xfdesktop",
    "xfsettingsd",
    "xfce4-notifyd",
    "xfce4-appfinder",
    "xfce4-settings-manager",
    "xfce4-session-logout",
    "xfce4-popup-applicationsmenu",
}


def program(argv):
    return os.path.basename(argv[0]) if argv else ""


def is_session_program(name):
    return name in SESSION_PROGRAMS or (name.startswith("xfce4-") and name.endswith("-settings"))


def capped_argv(argv):
    """An app's arguments, or None when there are too many or they are too long to keep."""
    if not argv or len(argv) > ARGS_MAX or sum(len(a) for a in argv) > ARGV_CHARS_MAX:
        return None
    return list(argv)


class Proc:
    """This user's processes as /proc has them (`root`: another folder in tests)."""

    def __init__(self, root="/proc", uid=None):
        self.root = root
        self.uid = os.getuid() if uid is None else uid

    def mine(self, pid):
        try:
            return os.stat(os.path.join(self.root, str(pid))).st_uid == self.uid
        except OSError:
            return False

    def argv(self, pid):
        try:
            with open(os.path.join(self.root, str(pid), "cmdline"), "rb") as f:
                raw = f.read(ARGV_CHARS_MAX * 2)
        except OSError:
            return None
        parts = raw.split(b"\0")
        if parts and parts[-1] == b"":
            parts.pop()
        return [p.decode("utf-8", "replace") for p in parts] or None

    def cwd(self, pid):
        try:
            folder = os.readlink(os.path.join(self.root, str(pid), "cwd"))
        except OSError:
            return None
        # A folder deleted since says " (deleted)" after its path: it can't be opened again.
        if folder.endswith(" (deleted)") or len(folder) > PATH_MAX or not folder.startswith("/"):
            return None
        return folder


def snapshot(windows, proc, config, home):
    """
    The list of what `windows` (the window manager's: xid, pid, class, types, transient) show of this user's apps.
    """
    browser_class = config.get("browserClass") or ""
    notes = set(config.get("notes") or [])
    browser = False
    by_pid = {}
    for w in windows:
        classes = set(w.get("class") or [])
        if browser_class and browser_class in classes:
            browser = True
            continue
        if classes & notes or w.get("transient"):
            continue
        if "normal" not in set(w.get("types") or ["normal"]):
            continue
        pid = w.get("pid")
        if isinstance(pid, int) and pid > 0 and proc.mine(pid):
            by_pid[pid] = by_pid.get(pid, 0) + 1
    apps = []
    for pid in sorted(by_pid):
        argv = proc.argv(pid)
        name = program(argv)
        if not argv or name == TERMINAL or is_session_program(name):
            continue
        folder = proc.cwd(pid) or home
        if name.lower() == FILES:
            # Files' windows belong to Thunar's own process (its daemon's, often): each opens again as a window of its
            # own, on the folder its command named, if any.
            folders = [a for a in argv[1:] if a.startswith("/") and len(a) <= PATH_MAX][:1]
            apps.extend({"argv": ["thunar"] + folders, "cwd": folder} for _ in range(min(by_pid[pid], FILES_WINDOWS_MAX)))
            continue
        kept = capped_argv(argv)
        if kept:
            apps.append({"argv": kept, "cwd": folder})
    return {"v": VERSION, "browser": browser, "apps": apps[:APPS_MAX]}


def size(state):
    """How many things the list would open: a shorter one lost windows."""
    return len(state.get("apps") or []) + (1 if state.get("browser") else 0)


class Writer:
    """When a new list goes to the file: at once, unless it lost windows (then once it stayed so for STABLE_S)."""

    def __init__(self, last=None):
        self.last = last
        self.pending = None
        self.since = 0.0

    def offer(self, state, now):
        """The list to write now, or None."""
        if state == self.last:
            self.pending = None
            return None
        if self.last is None or size(state) >= size(self.last):
            self.pending = None
            self.last = state
            return state
        if self.pending != state:
            self.pending, self.since = state, now
            return None
        if now - self.since >= STABLE_S:
            self.pending = None
            self.last = state
            return state
        return None

    def wait(self, now):
        """How long to wait for the next look: sooner while a shorter list waits to be written."""
        if self.pending is None:
            return POLL_S
        return max(0.05, min(POLL_S, self.since + STABLE_S - now))


def read_json(path, limit=64 * 1024):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "rb") as f:
            raw = f.read(limit + 1)
    except OSError:
        return None
    if len(raw) > limit:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        return None


def write_state(folder, state):
    os.makedirs(folder, mode=0o700, exist_ok=True)
    final = os.path.join(folder, STATE_FILE)
    temp = final + ".new"
    try:
        os.unlink(temp)
    except OSError:
        pass
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(temp, final)


class XWindows:
    """The window manager's list of windows on this session's display, and its changes."""

    def __init__(self):
        from Xlib import X, display, error

        self.X, self.error = X, error
        self.d = display.Display()
        self.root = self.d.screen().root
        self.root.change_attributes(event_mask=X.PropertyChangeMask)
        self.atoms = {}
        self.client_list = self.atom("_NET_CLIENT_LIST")

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.d.intern_atom(name)
        return self.atoms[name]

    def prop(self, w, name):
        p = w.get_full_property(self.atom(name), self.X.AnyPropertyType)
        return p.value if p else None

    def windows(self):
        out = []
        for xid in self.prop(self.root, "_NET_CLIENT_LIST") or []:
            w = self.d.create_resource_object("window", int(xid))
            try:
                pid = self.prop(w, "_NET_WM_PID")
                types = self.prop(w, "_NET_WM_WINDOW_TYPE") or []
                out.append(
                    {
                        "xid": int(xid),
                        "pid": int(pid[0]) if pid is not None and len(pid) else None,
                        "class": list(w.get_wm_class() or ()),
                        "types": [self.d.get_atom_name(t).replace("_NET_WM_WINDOW_TYPE_", "").lower() for t in types],
                        "transient": w.get_wm_transient_for() is not None,
                    }
                )
            except self.error.XError:
                continue
        return out

    def wait(self, seconds):
        """Waits up to `seconds` for the list to change; raises once the display is gone."""
        if not self.d.pending_events() and not select.select([self.d], [], [], seconds)[0]:
            return
        while self.d.pending_events():
            self.d.next_event()


def main(args):
    config = read_json(args[0]) if args else None
    config = config if isinstance(config, dict) else {}
    try:
        windows = XWindows()
    except Exception:
        # No python3-xlib, or no display: nothing to keep.
        return 0
    home = os.path.expanduser("~")
    folder = os.path.expanduser(STATE_DIR)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    lock = open(os.path.join(folder, LOCK_FILE), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0
    writer = Writer()
    while True:
        try:
            ready = writer.offer(snapshot(windows.windows(), Proc(), config, home), time.monotonic())
            if ready is not None:
                write_state(folder, ready)
            windows.wait(writer.wait(time.monotonic()))
        except OSError:
            time.sleep(POLL_S)
        except Exception:
            # The display went away with its session: the list written last stays for the runner.
            return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
