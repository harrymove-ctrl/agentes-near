"""
The desktop helper (ADR 0062 section 9): what an agent's desktop shows, read from its accessibility
tree (AT-SPI over D-Bus), input through xdotool and screenshots through scrot, as the agent's own OS
user.

- JSON lines: each request on stdin, {"id": n, "op": ...}, gets one line on stdout,
  {"id": n, "ok": true, "data": ...} or {"id": n, "ok": false, "code": ..., "error": ...}
  (apps/server/runner/desktop-helper.ts has the types). Nothing else is written anywhere, so what
  it is sent (text to type) stays in the pipe.
- The runner starts it as `python3 -I -c <this source>` with LC_ALL=C.UTF-8: agents' homes are 0700,
  so there is no file of it for the agent's user to read, and -I keeps that user's own site-packages
  and .pth files out. The source stays ASCII, since an argument is decoded with whatever locale the
  computer has.
- `python3 -I desktop-helper.py --self-check` prints timings and a typing check on $DISPLAY.
- gi and Xlib are imported only by the I/O classes (XDisplay, A11y): the pure parts above them run in
  unit tests on machines with neither.
"""

import base64
import itertools
import json
import math
import os
import platform
import random
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

# AT-SPI states (in the low word of a node's states).
SHOWING = 1 << 25
MANAGES_DESCENDANTS = 1 << 31
TEXT_MAX = 4000
KEY_MAX = 64
PATH_MAX = 1024
NAME_MAX = 300
NODES_MAX = 4000
PAUSE_MAX_MS = 10000
SCROLL_MAX = 50
# One app's answer on the accessibility bus; an app slower than this is left out of the look.
CALL_MS = 2000
# What an app's cache doesn't give (Qt's is empty by design; GTK's holds what a client asked about) is
# read node by node, up to this much per app.
WALK_NODES = 500
WALK_S = 0.3
# AT-SPI coordinate types: on the screen, or from the element's window.
SCREEN_COORDS, WINDOW_COORDS = 0, 1
# Damage is tracked per tile of this many pixels. Tiles that changed in the BUSY_S before an action
# (a clock, a spinner) are already changing on their own: their damage isn't the action's effect.
TILE = 32
BUSY_S = 0.15
# Below about 12 ms between keys xdotool drops letters and capitals of accented text.
KEY_DELAY_MS = 12
# Long text goes to xdotool this many characters at a time: a person taking control stops it between two.
EVEN_CHUNK = 16
# Keys sent right after a click can reach the window that had the focus before it.
STEP_GAP_S = 0.05
# A paste is answered by the app that has the focus; nothing asking for it this long means nothing took it.
PASTE_S = 1.5
TEXT_ROLES = ("terminal", "entry", "text")
NULL_PATH = "/org/a11y/atspi/null"
ROOT_PATH = "/org/a11y/atspi/accessible/root"
ATSPI = "org.a11y.atspi."
TOOLS = ("xdotool", "scrot")
KEY = re.compile(r"[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*\Z")
APP_ID = re.compile(r"[A-Za-z0-9_.+-]+\.desktop\Z")
POINTER_STEPS = ("move", "click", "drag", "scroll")
KEY_STEPS = ("key", "type")
STEPS = ("move", "click", "drag", "key", "type", "fill", "scroll", "activate", "launch", "open", "pause")
TEXT_TARGETS = ("UTF8_STRING", "text/plain;charset=utf-8", "TEXT", "STRING")
# How the agent's pointer and keys move, so apps and pages see a person's rhythm (apps/server/runner/human-input.ts
# has the same model and numbers for the agent browser: keep the two in step). Times in ms, ranges [low, high].
HUMAN = {
    "fittsA": 50, "fittsB": 100, "minMs": 150, "maxMs": 450,
    "stepMs": 16, "stepJitterMs": 4,
    "bend": 0.2, "bendMaxPx": 120, "jitterPx": 0.7,
    "overshootOverPx": 300, "overshootChance": 0.3, "overshootShare": (0.03, 0.07), "overshootMaxPx": 28,
    "correctShare": 0.2, "correctMinMs": 60,
    "dragSlowdown": 1.4, "dragHoldMs": (60, 140),
    "holdMs": (40, 120), "clickGapMs": (70, 150),
    "wheelGapMs": (30, 110), "wheelPauseChance": 0.15, "wheelPauseMs": (150, 300),
    "firstKeyMs": (120, 260), "keyMs": (38, 100), "afterSpaceMs": (10, 40), "afterPunctuationMs": (40, 120),
    "pauseChance": 0.02, "pauseMs": (200, 450),
    # How long a key stays down: xdotool's `type --delay` holds it a quarter of the delay, then waits as long (measured).
    "keyHoldMs": (25, 45),
    "typeMaxChars": 200,
}


class HelperError(Exception):
    """A request that fails with a code for the runner: bad_request, unavailable, stale, failed, mismatch, stopped."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Stopped(HelperError):
    """A person took control: an `input` ends at its next key or step, and the runner tells the agent."""

    def __init__(self):
        super().__init__("stopped", "a person took control")


def bad(message):
    return HelperError("bad_request", message)


def is_int(v, lo, hi):
    return type(v) is int and lo <= v <= hi


def ms_since(t0):
    return round((time.monotonic() - t0) * 1000)


def first_line(e):
    text = e.decode("utf-8", "replace") if isinstance(e, bytes) else str(e)
    return (text.strip().splitlines() or [""])[0][:200]


# ---------------------------------------------------------------- pure parts (unit tested)


def normalize_items(items):
    """
    One app's Cache.GetItems as nodes. at-spi2-core 2.56 sends ((so)(so)(so)iiassusau), the index in
    the parent and a child count; older ones ((so)(so)(so)a(so)assusau), the children themselves. A
    parent on another bus (the desktop, for an app's root) or the null path is no parent.
    """
    nodes, index_of = [], {}
    for item in items:
        (bus, path), (pbus, ppath) = item[0], item[2]
        if type(item[3]) is int:
            index, count, ifaces, name, role, _desc, states = item[3:]
        else:
            children, ifaces, name, role, _desc, states = item[3:]
            index, count = None, len(children)
            for i, child in enumerate(children):
                index_of[child[1]] = i
        nodes.append(
            {
                "path": path,
                "parent": ppath if pbus == bus and ppath != NULL_PATH else None,
                "index": index,
                "children": count,
                "role": role,
                "name": name[:NAME_MAX],
                "states": list(states[:2]),
                "ifaces": [i.rsplit(".", 1)[-1] for i in ifaces],
            }
        )
    for node in nodes:
        if node["index"] is None:
            node["index"] = index_of.get(node["path"], -1)
    return nodes


def cap_text(text, role, limit):
    """At most `limit` characters: a terminal's last ones (what it printed last), any other field's first."""
    if len(text) <= limit:
        return text
    return text[len(text) - limit :] if role == "terminal" else text[:limit]


def front_pids(windows):
    """
    The apps in front, by pid: the active window's, every window stacked above it (dialogs, menus,
    notifications) and the panels. With no active window, every window's. Windows go bottom to top.
    """
    active = next((i for i, w in enumerate(windows) if w["active"]), 0)
    return {w["pid"] for i, w in enumerate(windows) if w["pid"] and (i >= active or "dock" in w["types"])}


def on_screen(box, screen):
    x, y, w, h = box
    return w > 0 and h > 0 and x < screen[0] and y < screen[1] and x + w > 0 and y + h > 0


def misplaced(nodes, pid, windows):
    """
    GTK4 answers every screen position as (0, 0), with sizes right: a top-level whose box and every box
    under it start at (0, 0), while its window doesn't or it holds more than one element. For each,
    its X window (the app's own closest in size) and its nodes that have a box, itself included: their
    boxes then come from window coordinates plus that window's origin.
    """
    mine = [w for w in windows if pid is not None and w["pid"] == pid]
    kids = {}
    for n in nodes:
        kids.setdefault(n["parent"], []).append(n)
    out = []
    for top in kids.get(ROOT_PATH, []) if mine else []:
        box = top.get("box")
        if not box or box[0] or box[1]:
            continue
        members, todo, seen = [], [top], set()
        while todo:
            n = todo.pop()
            if n["path"] in seen:
                continue
            seen.add(n["path"])
            if "box" in n:
                members.append(n)
            todo.extend(kids.get(n["path"], []))
        if any(m["box"][0] or m["box"][1] for m in members):
            continue
        win = min(mine, key=lambda w: abs(w["box"][2] - box[2]) + abs(w["box"][3] - box[3]))
        if len(members) > 1 or win["box"][0] or win["box"][1]:
            out.append((win, members))
    return out


def incomplete(nodes):
    """
    Where an app's cache left elements out: showing nodes with fewer cached children than they have,
    as walk_tree's starts. GTK caches only elements some client asked about (GTK4: the focused one
    and its ancestors), so their siblings are read node by node. Lists that make their children on
    demand (MANAGES_DESCENDANTS) stay as they are: they can hold thousands.
    """
    cached = {}
    for n in nodes:
        cached[n["parent"]] = cached.get(n["parent"], 0) + 1
    out = []
    for n in nodes:
        states = (n["states"] or [0])[0]
        if n["children"] > cached.get(n["path"], 0) and states & SHOWING and not states & MANAGES_DESCENDANTS:
            out.append((n["path"], n["parent"], n["index"]))
    return out


def walk_tree(ask, start=((ROOT_PATH, None, -1),), known=(), max_nodes=WALK_NODES, max_s=WALK_S, clock=time.monotonic):
    """
    An app's tree read node by node, for what its cache doesn't give (Qt's is empty): breadth first
    from `start` ((path, parent, index), its root by default), each level's questions sent together,
    below showing nodes only, never into `known` paths, at most `max_nodes` nodes or `max_s` seconds
    (past that the app is found on the screen image). `ask(paths)` answers per path (role, states,
    name, ifaces, child paths), or None for one that's gone.
    """
    t0 = clock()
    nodes, level = [], list(start)
    seen = set(known) | {path for path, _, _ in level}
    while level and len(nodes) < max_nodes and clock() - t0 < max_s:
        level = level[: max_nodes - len(nodes)]
        below = []
        for (path, parent, index), got in zip(level, ask([p for p, _, _ in level])):
            if got is None:
                continue
            role, states, name, ifaces, children = got
            nodes.append(
                {
                    "path": path,
                    "parent": parent,
                    "index": index,
                    "children": len(children),
                    "role": role,
                    "name": name[:NAME_MAX],
                    "states": list(states[:2]),
                    "ifaces": ifaces,
                }
            )
            if path != ROOT_PATH and not (states and states[0] & SHOWING):
                continue
            for i, child in enumerate(children):
                if child not in seen:
                    seen.add(child)
                    below.append((child, path, i))
        level = below
    return nodes


def tiles(x, y, w, h):
    """The tiles a rectangle touches."""
    if w <= 0 or h <= 0:
        return set()
    xs = range(x // TILE, (x + w - 1) // TILE + 1)
    ys = range(y // TILE, (y + h - 1) // TILE + 1)
    return {(tx, ty) for tx in xs for ty in ys}


class Damage:
    """When each tile last changed, to tell what was already changing before an action."""

    def __init__(self):
        self.last = {}

    def add(self, rect, now):
        changed = tiles(*rect)
        for t in changed:
            self.last[t] = now
        return changed

    def busy(self, now, window=BUSY_S):
        return {t for t, at in self.last.items() if now - at <= window}


class Settle:
    """
    When the screen counts as settled after an action: quiet for `quiet` ms after its first change, or
    nothing changed within `late` ms; at most `cap` ms. With `window` ms, a new window or a change of
    the active one is waited for first (an app starting), up to that long: what changes before it (a
    menu closing, a button's highlight) doesn't end the wait.
    """

    def __init__(self, now, late=400, quiet=120, cap=2000, window=0):
        self.late, self.quiet, self.cap, self.window_s = late / 1000, quiet / 1000, cap / 1000, window / 1000
        self.waiting = window > 0
        self.first = None
        self.last = None
        self.changed = False
        self.start(now)

    def start(self, now):
        """The wait starts (again) now, once the action is done; what changed during it still counts."""
        self.t0 = now
        self.until = now + self.window_s

    def damage(self, now):
        self.changed = True
        self.last = now
        if not self.waiting and self.first is None:
            self.first = now

    def window(self, now):
        self.changed = True
        self.last = now
        if self.waiting:
            self.waiting = False
            self.t0 = self.first = now
        elif self.first is None:
            self.first = now

    def done(self, now):
        """None while it isn't over; else True when the screen settled, False when the cap ended the wait."""
        if self.waiting:
            if now < self.until:
                return None
            self.waiting = False
            self.t0 = now
            if self.last is None:
                return True
            self.first = self.last
        if self.first is None:
            if now - self.t0 >= self.late:
                return True
        elif now - self.last >= self.quiet:
            return True
        if now - self.t0 >= self.cap:
            return False
        return None

    def wake(self, now):
        """Seconds until done() can change with no new event."""
        if self.waiting:
            return max(0.0, self.until - now)
        end = self.t0 + self.late if self.first is None else self.last + self.quiet
        return max(0.0, min(end, self.t0 + self.cap) - now)


def is_key(ch):
    """What xdotool types exactly: printable ASCII, newlines and tabs."""
    return ch in "\n\t" or " " <= ch <= "~"


def text_runs(text):
    """Text cut for typing: runs that go as keys, and runs of anything else, which are pasted."""
    return [(keys, "".join(chars)) for keys, chars in itertools.groupby(text, key=is_key)]


def between(rng, span):
    return span[0] + rng.random() * (span[1] - span[0])


def move_ms(distance, size, rng):
    """How long a pointer move of `distance` to a target `size` wide takes (Fitts), +-10%."""
    fitts = HUMAN["fittsA"] + HUMAN["fittsB"] * math.log2(distance / max(size, 1) + 1)
    return min(max(fitts, HUMAN["minMs"]), HUMAN["maxMs"]) * (0.9 + 0.2 * rng.random())


def segment(a, b, ms, rng, screen, straight=False):
    """One curved stretch from a to b: a cubic Bezier walked at minimum-jerk speed, [(x, y, wait ms)]."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    d = math.hypot(dx, dy)
    nx, ny = (-dy / d, dx / d) if d else (0.0, 0.0)
    side = -1 if rng.random() < 0.5 else 1
    reach = 0 if straight else min(d * HUMAN["bend"], HUMAN["bendMaxPx"])
    o1 = side * reach * (0.3 + 0.7 * rng.random())
    o2 = side * reach * (0.1 + 0.6 * rng.random())
    c1 = (a[0] + dx * 0.3 + nx * o1, a[1] + dy * 0.3 + ny * o1)
    c2 = (a[0] + dx * 0.7 + nx * o2, a[1] + dy * 0.7 + ny * o2)
    steps = max(2, round(ms / HUMAN["stepMs"]))
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        s = t * t * t * (10 - 15 * t + 6 * t * t)
        u = 1 - s
        x = u * u * u * a[0] + 3 * u * u * s * c1[0] + 3 * u * s * s * c2[0] + s * s * s * b[0]
        y = u * u * u * a[1] + 3 * u * u * s * c1[1] + 3 * u * s * s * c2[1] + s * s * s * b[1]
        if i < steps:
            x += (rng.random() * 2 - 1) * HUMAN["jitterPx"]
            y += (rng.random() * 2 - 1) * HUMAN["jitterPx"]
        else:
            x, y = b
        p = [min(max(round(x), 0), screen[0] - 1), min(max(round(y), 0), screen[1] - 1)]
        gap = max(1, round(ms / steps + (rng.random() * 2 - 1) * HUMAN["stepJitterMs"]))
        if out and out[-1][0] == p[0] and out[-1][1] == p[1]:
            out[-1][2] += gap
        else:
            out.append(p + [gap])
    return out


def pointer_path(a, b, rng, screen, size=24, held=False, straight=False):
    """
    The pointer events from a to b, ending exactly on b, each [x, y, wait ms after it], on the screen. A long
    move sometimes ends a little past b and comes back; `held` (a drag) goes slower and never overshoots;
    `straight` (inside a menu a hover opened) neither curves nor overshoots: a line into a box stays in it.
    """
    d = math.hypot(b[0] - a[0], b[1] - a[1])
    if d < 1:
        return [[b[0], b[1], HUMAN["stepMs"]]]
    ms = move_ms(d, size, rng)
    if held:
        ms = max(ms * HUMAN["dragSlowdown"], HUMAN["minMs"] * 2)
    elif not straight and d > HUMAN["overshootOverPx"] and rng.random() < HUMAN["overshootChance"]:
        past = min(d * between(rng, HUMAN["overshootShare"]), HUMAN["overshootMaxPx"])
        ux, uy = (b[0] - a[0]) / d, (b[1] - a[1]) / d
        wobble = (rng.random() * 2 - 1) * 3
        over = (b[0] + ux * past - uy * wobble, b[1] + uy * past + ux * wobble)
        over = (min(max(over[0], 0), screen[0] - 1), min(max(over[1], 0), screen[1] - 1))
        back = max(ms * HUMAN["correctShare"], HUMAN["correctMinMs"])
        return segment(a, over, ms - back, rng, screen) + segment(over, b, back, rng, screen)
    return segment(a, b, ms, rng, screen, straight)


def typing_delays(text, rng):
    """The wait (ms) before each character of `text` is typed."""
    out = []
    for i, ch in enumerate(text):
        if i == 0:
            out.append(round(between(rng, HUMAN["firstKeyMs"])))
            continue
        prev = text[i - 1]
        ms = between(rng, HUMAN["keyMs"])
        if prev == " ":
            ms += between(rng, HUMAN["afterSpaceMs"])
        if prev in ".,;:!?":
            ms += between(rng, HUMAN["afterPunctuationMs"])
        if rng.random() < HUMAN["pauseChance"]:
            ms += between(rng, HUMAN["pauseMs"])
        out.append(round(ms))
    return out


def sleep_arg(ms):
    return "%.3f" % (ms / 1000)


def path_args(path):
    """A path as xdotool commands: each move, then its wait."""
    out = []
    for x, y, ms in path:
        out += ["mousemove", str(x), str(y), "sleep", sleep_arg(ms)]
    return out


def press_args(button, count, rng):
    """A button held a moment, `count` times with a person's gap between."""
    out = []
    for i in range(count):
        if i:
            out += ["sleep", sleep_arg(between(rng, HUMAN["clickGapMs"]))]
        out += ["mousedown", button, "sleep", sleep_arg(between(rng, HUMAN["holdMs"])), "mouseup", button]
    return out


def pointer_args(kind, step, start, screen, rng, straight=False):
    """A pointer step (move, click, drag, scroll) from `start` as one xdotool command line, and its total wait (ms)."""
    v = step[kind]
    args = path_args(pointer_path(start, v[:2], rng, screen, straight=straight))
    if kind == "click":
        args += press_args(str(step.get("button", 1)), step.get("count", 1), rng)
    elif kind == "drag":
        args += ["mousedown", "1", "sleep", sleep_arg(between(rng, HUMAN["dragHoldMs"]))]
        # Toolkits start a drag only after the pointer moves past a threshold while the button is down: a path does.
        args += path_args(pointer_path(v[:2], v[2:], rng, screen, held=True))
        args += ["sleep", sleep_arg(between(rng, HUMAN["dragHoldMs"])), "mouseup", "1"]
    elif kind == "scroll":
        for amount, back, forth in ((step.get("dy", 0), "4", "5"), (step.get("dx", 0), "6", "7")):
            for _ in range(abs(amount)):
                gap = between(rng, HUMAN["wheelGapMs"])
                if rng.random() < HUMAN["wheelPauseChance"]:
                    gap += between(rng, HUMAN["wheelPauseMs"])
                args += ["click", forth if amount > 0 else back, "sleep", sleep_arg(gap)]
    waited = sum(float(args[i + 1]) for i, a in enumerate(args) if a == "sleep") * 1000
    return args, waited


def clamp_region(region, screen):
    """A region kept inside the screen."""
    if not isinstance(region, dict) or not all(type(region.get(k)) is int for k in ("x", "y", "width", "height")):
        raise bad("region: x, y, width and height in pixels")
    x0, y0 = max(0, region["x"]), max(0, region["y"])
    x1 = min(screen[0], region["x"] + region["width"])
    y1 = min(screen[1], region["y"] + region["height"])
    if x1 - x0 < 1 or y1 - y0 < 1:
        raise bad("the region is off the screen")
    return {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0}


def check_point(v, screen, n=2):
    if not isinstance(v, list) or len(v) != n or not all(type(c) is int for c in v):
        raise bad("a point is [x, y] in pixels")
    for i in range(0, n, 2):
        if not (0 <= v[i] < screen[0] and 0 <= v[i + 1] < screen[1]):
            raise bad("the point (%d, %d) is off the screen" % (v[i], v[i + 1]))


def check_node(v):
    if not isinstance(v, list) or len(v) != 2 or not all(isinstance(s, str) and s for s in v):
        raise bad("an element is [bus, path]")


def check_step(step, screen):
    """An input step's kind, once its fields are right."""
    kinds = [k for k in STEPS if isinstance(step, dict) and k in step]
    if len(kinds) != 1:
        raise bad("a step is one of: " + ", ".join(STEPS))
    kind = kinds[0]
    v = step[kind]
    if kind in ("move", "click", "scroll"):
        check_point(v, screen)
    if kind == "click" and not (is_int(step.get("button", 1), 1, 3) and is_int(step.get("count", 1), 1, 3)):
        raise bad("click: button 1 to 3, count 1 to 3")
    if kind == "drag":
        check_point(v, screen, 4)
    if kind == "key" and not (isinstance(v, str) and len(v) <= KEY_MAX and KEY.match(v)):
        raise bad("key: X key names joined by +, like ctrl+s or Return")
    if kind == "type" and not (isinstance(v, str) and 0 < len(v) <= TEXT_MAX):
        raise bad("type: 1 to %d characters" % TEXT_MAX)
    if kind == "fill":
        check_node(v)
        if not (isinstance(step.get("text"), str) and len(step["text"]) <= TEXT_MAX):
            raise bad("fill: a text of at most %d characters" % TEXT_MAX)
    if kind == "scroll":
        dx, dy = step.get("dx", 0), step.get("dy", 0)
        if not (is_int(dx, -SCROLL_MAX, SCROLL_MAX) and is_int(dy, -SCROLL_MAX, SCROLL_MAX) and (dx or dy)):
            raise bad("scroll: dx and dy in wheel clicks, up to %d" % SCROLL_MAX)
    if kind == "activate" and not is_int(v, 1, 2**32 - 1):
        raise bad("activate: a window id")
    if kind == "launch" and not (isinstance(v, str) and len(v) <= PATH_MAX and APP_ID.match(v)):
        raise bad("launch: a desktop entry id, like thunar.desktop")
    if kind == "open" and not (isinstance(v, str) and 1 < len(v) <= PATH_MAX and v.startswith("/") and "\0" not in v):
        raise bad("open: an absolute path")
    if kind == "pause" and not is_int(v, 0, PAUSE_MAX_MS):
        raise bad("pause: 0 to %d ms" % PAUSE_MAX_MS)
    return kind


def check_settle(spec):
    """The settle spec as Settle's arguments (ms), or None for no settle."""
    if spec is None:
        return None
    limits = {"lateMs": ("late", 5000), "quietMs": ("quiet", 2000), "capMs": ("cap", 15000), "windowMs": ("window", 15000)}
    if not isinstance(spec, dict) or any(k not in limits for k in spec):
        raise bad("settle: lateMs, quietMs, capMs, windowMs")
    out = {}
    for key, value in spec.items():
        name, hi = limits[key]
        if not is_int(value, 0, hi):
            raise bad("settle: %s is 0 to %d" % (key, hi))
        out[name] = value
    return out


def parse_environ(raw):
    """A /proc/<pid>/environ as a dict."""
    env = {}
    for entry in raw.split(b"\0"):
        key, sep, value = entry.partition(b"=")
        if sep and key:
            env[os.fsdecode(key)] = os.fsdecode(value)
    return env


class Lines:
    """Bytes as they come on a pipe, out as whole lines."""

    def __init__(self):
        self.rest = b""

    def feed(self, chunk):
        *lines, self.rest = (self.rest + chunk).split(b"\n")
        return lines


# ---------------------------------------------------------------- I/O: X (python-xlib)


class XDisplay:
    """
    The X display: the screen, its windows, and what changes on it as it comes (damage, a new window,
    the active one). It also holds pasted text as the clipboard and primary selection owner.
    """

    def __init__(self):
        from Xlib import X, Xatom, display, error
        from Xlib.ext import damage
        from Xlib.protocol import event

        self.X, self.Xatom, self.error, self.event = X, Xatom, error, event
        self.d = display.Display()
        self.root = self.d.screen().root
        geometry = self.root.get_geometry()
        self.screen = [geometry.width, geometry.height]
        self.atoms, self.names, self.static = {}, {}, {}
        self.tracker = Damage()
        self.watch = None
        self.damage = self.d.has_extension("DAMAGE")
        if self.damage:
            self.d.damage_query_version()
            self.root.damage_create(damage.DamageReportRawRectangles)
            self.damage_event = self.d.extension_event.DamageNotify
        self.window_atoms = {self.atom("_NET_CLIENT_LIST"), self.atom("_NET_ACTIVE_WINDOW")}
        self.root.change_attributes(event_mask=X.PropertyChangeMask)
        self.since = time.monotonic()
        self.owner_window = None
        self.owned = set()
        self.clip = None
        self.served = 0
        self.paste_from = None
        self.client_mask = ~self.d.display.info.resource_id_mask
        self.d.sync()

    def fileno(self):
        return self.d.fileno()

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = self.d.intern_atom(name)
        return self.atoms[name]

    def atom_name(self, atom):
        if atom not in self.names:
            self.names[atom] = self.d.get_atom_name(atom)
        return self.names[atom]

    def prop(self, w, name, typ=None):
        p = w.get_full_property(self.atom(name), self.X.AnyPropertyType if typ is None else typ)
        return p.value if p else None

    def card(self, w, name):
        v = self.prop(w, name)
        return int(v[0]) if v is not None and len(v) else None

    def pump(self, timeout=0.0):
        """Takes in the events that came, waiting up to `timeout` seconds for the first one."""
        d = self.d
        if not d.pending_events() and (timeout <= 0 or not select.select([d], [], [], timeout)[0]):
            return
        while d.pending_events():
            ev = d.next_event()
            now = time.monotonic()
            if self.damage and ev.type == self.damage_event:
                a = ev.area
                changed = self.tracker.add((a.x, a.y, a.width, a.height), now)
                if self.watch and changed - self.watch[1]:
                    self.watch[0].damage(now)
            elif ev.type == self.X.PropertyNotify:
                if self.watch and ev.atom in self.window_atoms:
                    self.watch[0].window(now)
            elif ev.type == self.X.SelectionRequest:
                self.serve(ev)
            elif ev.type == self.X.SelectionClear:
                self.owned.discard(ev.atom)

    def busy(self):
        """Tiles that changed in the last BUSY_S (on a fresh connection it first watches that long)."""
        self.pump()
        while True:
            left = self.since + BUSY_S - time.monotonic()
            if left <= 0:
                return self.tracker.busy(time.monotonic())
            self.pump(left)

    def settle(self, settle):
        """Waits until `settle` (the one being watched) is over; True when the screen settled."""
        wait = 0.0
        while True:
            self.pump(wait)
            now = time.monotonic()
            result = settle.done(now)
            if result is not None:
                return result
            wait = max(settle.wake(now), 0.001)

    def windows(self):
        """
        The windows on the screen, bottom to top: the root's mapped children (XQueryTree), so
        override-redirect ones (menus, tooltips, notifications) count too, each with its client's
        class, title, pid and types (a window manager's frame holds the client).
        """
        X = self.X
        active = self.card(self.root, "_NET_ACTIVE_WINDOW")
        out, seen = [], set()
        for w in self.root.query_tree().children:
            try:
                a = w.get_attributes()
                if a.map_state != X.IsViewable or a.win_class != X.InputOutput:
                    continue
                g = w.get_geometry()
                box = [g.x, g.y, g.width, g.height]
                if not on_screen(box, self.screen):
                    continue
                seen.add(w.id)
                known = self.static.get(w.id) or self.describe(w, bool(a.override_redirect))
                if known is None:
                    continue
                self.static[w.id] = known
                client = self.d.create_resource_object("window", known["xid"])
                out.append(dict(known, stack=len(out), active=known["xid"] == active, title=self.title(client), box=box))
            except self.error.XError:
                continue
        self.static = {k: v for k, v in self.static.items() if k in seen}
        return out

    def describe(self, w, override):
        """What doesn't change about a top-level window; None for the window manager's own."""
        client = w if override or self.prop(w, "WM_STATE") is not None else None
        if client is None:
            client = next((c for c in w.query_tree().children if self.prop(c, "WM_STATE") is not None), None)
        if client is None:
            return None
        types = self.prop(client, "_NET_WM_WINDOW_TYPE") or []
        return {
            "xid": client.id,
            "override": override,
            "class": list(client.get_wm_class() or ("", "")),
            "pid": self.card(client, "_NET_WM_PID"),
            "types": [self.atom_name(t).replace("_NET_WM_WINDOW_TYPE_", "").lower() for t in types],
        }

    def origin(self, xid):
        """
        Where a client window's content starts on the screen: its own corner, past the invisible
        shadow GTK draws around a window that decorates itself (_GTK_FRAME_EXTENTS: left, right, top,
        bottom).
        """
        w = self.d.create_resource_object("window", xid)
        try:
            at = self.root.translate_coords(w, 0, 0)
            shadow = self.prop(w, "_GTK_FRAME_EXTENTS")
        except self.error.XError:
            return None
        left, top = (int(shadow[0]), int(shadow[2])) if shadow is not None and len(shadow) == 4 else (0, 0)
        return at.x + left, at.y + top

    def title(self, w):
        v = self.prop(w, "_NET_WM_NAME", self.atom("UTF8_STRING"))
        if v is None:
            v = self.prop(w, "WM_NAME")
        if isinstance(v, bytes):
            v = v.decode("utf-8", "replace")
        return (v or "")[:NAME_MAX]

    def pointer(self):
        """Where the pointer is now (a person in control moves it too)."""
        at = self.root.query_pointer()
        return [at.root_x, at.root_y]

    def a11y_address(self):
        v = self.prop(self.root, "AT_SPI_BUS")
        return v.decode("utf-8", "replace") if isinstance(v, bytes) and v else None

    def hold(self, text):
        """
        `text` becomes what a paste gets, from both the clipboard (text fields) and the primary
        selection (terminals). The selections are taken once and kept: taking them again makes the VNC
        server and the session's clipboard managers read them each time.

        A paste counts once the app with the input focus took it (`served`): a requestor is that app's
        when its window id has the focused window's client bits. Anyone else reading the selection
        meanwhile (a viewer's clipboard through the VNC server) isn't the paste.
        """
        X = self.X
        self.clip = text.encode("utf-8")
        if self.owner_window is None:
            self.owner_window = self.root.create_window(0, 0, 1, 1, 0, 0, window_class=X.InputOnly)
        for selection in (self.atom("CLIPBOARD"), self.Xatom.PRIMARY):
            if selection not in self.owned:
                self.owner_window.set_selection_owner(selection, X.CurrentTime)
                self.owned.add(selection)
        focus = getattr(self.d.get_input_focus().focus, "id", None)
        self.paste_from = focus & self.client_mask if focus else None

    def serve(self, ev):
        """Answers a request for a held selection: what it can be (TARGETS) or the text."""
        X, Xatom = self.X, self.Xatom
        prop = ev.property or ev.target
        target = self.atom_name(ev.target)
        if self.clip is None or ev.selection not in self.owned:
            prop = X.NONE
        elif target == "TARGETS":
            offered = [self.atom(t) for t in ("TARGETS",) + TEXT_TARGETS]
            ev.requestor.change_property(prop, Xatom.ATOM, 32, offered)
        elif target in TEXT_TARGETS:
            data = self.clip.decode("utf-8").encode("latin-1", "replace") if target == "STRING" else self.clip
            kind = Xatom.STRING if target == "STRING" else self.atom("UTF8_STRING")
            ev.requestor.change_property(prop, kind, 8, data)
            client = ev.requestor.id & self.client_mask
            if client == self.paste_from or (self.paste_from is None and client):
                self.served += 1
        else:
            prop = X.NONE
        notify = self.event.SelectionNotify(
            time=ev.time, requestor=ev.requestor, selection=ev.selection, target=ev.target, property=prop
        )
        ev.requestor.send_event(notify)
        # A round trip: the app has the answer queued before any key sent after it.
        self.d.sync()


# ---------------------------------------------------------------- I/O: the accessibility bus (Gio)


class A11y:
    """The desktop's accessibility bus: one GetItems per app for its tree, everything else sent at once."""

    def __init__(self, address):
        from gi.repository import Gio, GLib

        self.Gio, self.GLib = Gio, GLib
        flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
        self.bus = Gio.DBusConnection.new_for_address_sync(address, flags, None, None)
        self.pids, self.roles = {}, {}
        # Apps keep no cache to give (GetItems doesn't exist) until a client listens for an event:
        # one cheap event makes every app on the bus, and every app started later, keep one.
        self.call(
            "org.a11y.atspi.Registry",
            "/org/a11y/atspi/registry",
            ATSPI + "Registry",
            "RegisterEvent",
            GLib.Variant("(sass)", ("window:activate", [], "")),
        )
        self.iterate(0.2)

    def closed(self):
        return self.bus.is_closed()

    def iterate(self, seconds):
        ctx, end = self.GLib.MainContext.default(), time.monotonic() + seconds
        while time.monotonic() < end:
            if not ctx.iteration(False):
                time.sleep(0.005)

    def call(self, dest, path, iface, method, args=None):
        flags = self.Gio.DBusCallFlags.NONE
        return self.bus.call_sync(dest, path, iface, method, args, None, flags, CALL_MS, None).unpack()

    def batch(self, calls):
        """Sends every call at once and waits for all of them: each answer (a Variant), or the error."""
        GLib = self.GLib
        results = [None] * len(calls)
        left = [len(calls)]

        def done(conn, res, i):
            try:
                results[i] = conn.call_finish(res)
            except GLib.Error as e:
                results[i] = e
            left[0] -= 1

        flags = self.Gio.DBusCallFlags.NONE
        for i, (dest, path, iface, method, args) in enumerate(calls):
            self.bus.call(dest, path, iface, method, args, None, flags, CALL_MS, None, done, i)
        ctx = GLib.MainContext.default()
        tick = GLib.timeout_add(100, lambda: True)
        deadline = time.monotonic() + CALL_MS / 1000 + 1
        try:
            while left[0] and time.monotonic() < deadline:
                ctx.iteration(True)
        finally:
            GLib.source_remove(tick)
        return results

    def answers(self, calls):
        """Like batch, with each answer unpacked, or None."""
        return [r.unpack() if isinstance(r, self.GLib.Variant) else None for r in self.batch(calls)]

    def apps(self):
        """The bus name of every app on the desktop."""
        children = self.call("org.a11y.atspi.Registry", ROOT_PATH, ATSPI + "Accessible", "GetChildren")[0]
        return [bus for bus, _path in children]

    def pids_of(self, buses):
        """Each app's pid (the bus knows its connection's), asked once per app."""
        V = self.GLib.Variant
        missing = [b for b in buses if b not in self.pids]
        dbus = ("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus")
        for bus, answer in zip(missing, self.answers([dbus + ("GetConnectionUnixProcessID", V("(s)", (b,))) for b in missing])):
            self.pids[bus] = answer[0] if answer else None
        self.pids = {b: self.pids[b] for b in buses}
        return self.pids

    def trees(self, buses):
        """Each app's nodes, or the reason there are none ("no tree", "didn't answer")."""
        out = []
        for bus, r in zip(buses, self.batch([(b, "/org/a11y/atspi/cache", ATSPI + "Cache", "GetItems", None) for b in buses])):
            got = normalize_items(r.unpack()[0]) if isinstance(r, self.GLib.Variant) else None
            if got:
                missing = incomplete(got)
                if missing:
                    have = {n["path"] for n in got}
                    got += [n for n in self.walk(bus, missing, have) if n["path"] not in have]
                out.append(got)
            elif got is not None or "UnknownMethod" in str(r) or "UnknownInterface" in str(r):
                # No cache to give (Qt's is always empty): node by node, capped.
                out.append(self.walk(bus) or "no tree")
            else:
                out.append("didn't answer")
        return out

    def walk(self, bus, start=None, known=()):
        """One app's tree node by node (walk_tree): from its root, or from where its cache left elements out."""
        V = self.GLib.Variant
        acc = ATSPI + "Accessible"
        name = ("org.freedesktop.DBus.Properties", "Get", V("(ss)", (acc, "Name")))
        asks = [(acc, "GetRole", None), (acc, "GetState", None), name, (acc, "GetInterfaces", None), (acc, "GetChildren", None)]

        def ask(paths):
            got = self.answers([(bus, p) + a for p in paths for a in asks])
            out = []
            for i in range(len(paths)):
                role, states, label, ifaces, children = got[5 * i : 5 * i + 5]
                if role is None or states is None:
                    out.append(None)
                    continue
                kids = [p for b, p in (children[0] if children else []) if b == bus and p != NULL_PATH]
                faces = [f.rsplit(".", 1)[-1] for f in (ifaces[0] if ifaces else [])]
                out.append((role[0], list(states[0]), (label[0] if label else "") or "", faces, kids))
            return out

        return walk_tree(ask, start, known) if start else walk_tree(ask)

    def role_names(self, wanted):
        """Role numbers' names ({number: (bus, path) of a node with it}), asked once per number."""
        missing = [(r, ref) for r, ref in wanted.items() if r not in self.roles]
        calls = [(bus, path, ATSPI + "Accessible", "GetRoleName", None) for _, (bus, path) in missing]
        for (role, _), answer in zip(missing, self.answers(calls)):
            if answer:
                self.roles[role] = answer[0]
        return self.roles

    def extents(self, nodes, coords=SCREEN_COORDS):
        """Boxes of [bus, path] nodes, [x, y, w, h], on the screen or from their window; None for one that's gone."""
        V = self.GLib.Variant
        calls = [(bus, path, ATSPI + "Component", "GetExtents", V("(u)", (coords,))) for bus, path in nodes]
        return [list(a[0]) if a else None for a in self.answers(calls)]

    def texts(self, nodes, limit):
        """The text of (bus, path, role) nodes, capped: a terminal's last characters, a field's first."""
        V = self.GLib.Variant
        props = ("org.freedesktop.DBus.Properties", "Get", V("(ss)", (ATSPI + "Text", "CharacterCount")))
        counts = self.answers([(bus, path) + props for bus, path, _ in nodes])
        calls, which = [], []
        for i, ((bus, path, role), count) in enumerate(zip(nodes, counts)):
            if count:
                n = count[0]
                start = max(0, n - limit) if role == "terminal" else 0
                calls.append((bus, path, ATSPI + "Text", "GetText", V("(ii)", (start, min(n, start + limit)))))
                which.append(i)
        out = [None] * len(nodes)
        for i, answer in zip(which, self.answers(calls)):
            if answer:
                out[i] = cap_text(answer[0], nodes[i][2], limit)
        return out

    def set_text(self, bus, path, text):
        """A field's whole text set through EditableText and read back: exact, whatever the keyboard."""
        V = self.GLib.Variant
        try:
            done = self.call(bus, path, ATSPI + "EditableText", "SetTextContents", V("(s)", (text,)))[0]
            got = self.call(bus, path, ATSPI + "Text", "GetText", V("(ii)", (0, -1)))[0]
        except self.GLib.Error as e:
            if "UnknownMethod" in str(e) or "UnknownInterface" in str(e):
                raise HelperError("failed", "that element doesn't take text")
            raise HelperError("stale", "that element is no longer on the screen")
        if not done or got != text:
            raise HelperError("mismatch", "the text didn't come out as written")


# ---------------------------------------------------------------- the desktop and its ops


def missing_packages(tools):
    """The Debian packages a desktop helper needs and this computer lacks."""
    missing = [t for t in TOOLS if not tools.get(t)]
    for module, package in (("gi", "python3-gi"), ("Xlib", "python3-xlib")):
        try:
            __import__(module)
        except ImportError:
            missing.append(package)
    return missing


class Desktop:
    """The agent's desktop: its X display and accessibility bus, connected on first use, and the tools."""

    def __init__(self):
        self.x = None
        self.a11y = None
        self.tools = {t: shutil.which(t) for t in TOOLS}
        self.session_env = None
        self.shots = None
        self.rng = random.Random()
        self.stopping = False
        self.on_path = False
        self.hovered = None

    def close(self):
        if self.shots:
            shutil.rmtree(self.shots, ignore_errors=True)

    def display(self):
        if self.x is None:
            try:
                self.x = XDisplay()
            except ImportError:
                raise HelperError("unavailable", "python3-xlib isn't installed")
            except Exception as e:
                where = os.environ.get("DISPLAY") or "(no DISPLAY)"
                raise HelperError("unavailable", "can't open the display %s: %s" % (where, first_line(e)))
        return self.x

    def bus(self):
        if self.a11y is not None and self.a11y.closed():
            self.a11y = None
        if self.a11y is None:
            address = self.display().a11y_address()
            if not address:
                raise HelperError("unavailable", "the desktop has no accessibility bus (at-spi2-core)")
            try:
                self.a11y = A11y(address)
            except ImportError:
                raise HelperError("unavailable", "python3-gi isn't installed")
            except Exception as e:
                raise HelperError("unavailable", "can't reach the accessibility bus: %s" % first_line(e))
        return self.a11y

    def hello(self, _req=None):
        info = {"screen": None, "a11y": False, "damage": False, "python": platform.python_version()}
        info.update({t: bool(self.tools[t]) for t in TOOLS})
        info["missing"] = missing_packages(self.tools)
        try:
            x = self.display()
            info["screen"], info["damage"] = x.screen, x.damage
            self.bus()
            info["a11y"] = True
        except HelperError as e:
            info["problem"] = str(e)
        return info

    def snapshot(self, req):
        scope = req.get("scope", "front")
        limit = req.get("textMax", TEXT_MAX)
        skip = req.get("skip", [])
        if scope not in ("front", "all") or not is_int(limit, 0, TEXT_MAX):
            raise bad("snapshot: scope front or all, textMax 0 to %d" % TEXT_MAX)
        if not isinstance(skip, list) or not all(type(p) is int for p in skip):
            raise bad("snapshot: skip is a list of pids")
        t0 = time.monotonic()
        x, a11y = self.display(), self.bus()
        windows = x.windows()
        buses = a11y.apps()
        pids = a11y.pids_of(buses)
        front = front_pids(windows) if scope == "front" else None
        chosen = [b for b in buses if pids[b] not in skip and (front is None or pids[b] in front)]
        trees = a11y.trees(chosen)
        wanted = {}
        for bus, nodes in zip(chosen, trees):
            for n in nodes if isinstance(nodes, list) else []:
                wanted.setdefault(n["role"], (bus, n["path"]))
        roles = a11y.role_names(wanted)
        apps, boxed, texted = [], [], []
        for bus, nodes in zip(chosen, trees):
            app = {"bus": bus, "pid": pids[bus], "name": ""}
            apps.append(app)
            if not isinstance(nodes, list):
                app["error"] = nodes
                continue
            app["nodes"] = nodes
            for n in nodes:
                n["role"] = roles.get(n["role"], "unknown")
                if n["path"] == ROOT_PATH:
                    app["name"] = n["name"]
                if not n["states"] or not n["states"][0] & SHOWING:
                    continue
                if "Component" in n["ifaces"]:
                    boxed.append((bus, n))
                if limit and n["role"] in TEXT_ROLES and "Text" in n["ifaces"]:
                    texted.append((bus, n))
        for (_, n), box in zip(boxed, a11y.extents([(b, n["path"]) for b, n in boxed])):
            if box is not None:
                n["box"] = box
        for app in apps:
            for win, members in misplaced(app.get("nodes") or [], app["pid"], windows):
                origin = x.origin(win["xid"])
                if origin is None:
                    continue
                ox, oy = origin
                boxes = a11y.extents([(app["bus"], n["path"]) for n in members], WINDOW_COORDS)
                for n, box in zip(members, boxes):
                    if box is not None:
                        n["box"] = [box[0] + ox, box[1] + oy, box[2], box[3]]
        for (_, n), text in zip(texted, a11y.texts([(b, n["path"], n["role"]) for b, n in texted], limit)):
            if text is not None:
                n["text"] = text
        return {"screen": x.screen, "windows": windows, "apps": apps, "ms": ms_since(t0)}

    def extents(self, req):
        nodes = req.get("nodes")
        if not isinstance(nodes, list) or len(nodes) > NODES_MAX:
            raise bad("extents: nodes is a list of [bus, path]")
        for node in nodes:
            check_node(node)
        boxes = self.bus().extents(nodes) if nodes else []
        # The window stack as it is now, so the runner sees what covers an element right before acting on it.
        windows = self.display().windows()
        return {"boxes": {"%s %s" % (bus, path): box for (bus, path), box in zip(nodes, boxes)}, "windows": windows}

    def input(self, req):
        t0 = time.monotonic()
        steps = req.get("steps")
        if not isinstance(steps, list) or not 0 < len(steps) <= 40:
            raise bad("input: 1 to 40 steps")
        x = self.display()
        kinds = [check_step(s, x.screen) for s in steps]
        spec = check_settle(req.get("settle"))
        settle = Settle(time.monotonic(), **spec) if spec is not None else None
        out = {}
        if settle is not None:
            x.watch = (settle, x.busy())
        try:
            for i, (kind, step) in enumerate(zip(kinds, steps)):
                if i and kinds[i - 1] in POINTER_STEPS and kind in KEY_STEPS:
                    time.sleep(STEP_GAP_S)
                self.check_stopped()
                self.step(kind, step)
            if settle is not None:
                settle.start(time.monotonic())
                out["settled"] = x.settle(settle)
                out["changed"] = settle.changed
        finally:
            x.watch = None
            self.stopping = False
        out["ms"] = ms_since(t0)
        return out

    def stop_input(self, *_):
        """SIGUSR1: the runner's word that a person took control. A pointer's xdotool line dies now (`step`)."""
        self.stopping = True
        if self.on_path:
            self.on_path = False
            raise Stopped()

    def check_stopped(self):
        if self.stopping:
            raise Stopped()

    def step(self, kind, s):
        v = s[kind]
        if kind in POINTER_STEPS:
            x = self.display()
            start = x.pointer()
            # ponytail: a hover stands for "a menu is open": the accessibility tree could tell for sure.
            args, waited = pointer_args(kind, s, start, x.screen, self.rng, straight=start == self.hovered)
            self.hovered = v if kind == "move" else None
            self.on_path = True
            try:
                self.xdotool(*args, timeout=10 + waited / 1000)
            except Stopped:
                # Killed between its press and release, the button would stay down under the person's pointer.
                self.xdotool("mouseup", str(s.get("button", 1)))
                raise
            finally:
                self.on_path = False
        elif kind == "key":
            self.xdotool("key", "--delay", str(KEY_DELAY_MS), "--", v)
        elif kind == "type":
            self.type_text(v)
        elif kind == "fill":
            self.bus().set_text(v[0], v[1], s["text"])
        elif kind == "activate":
            self.xdotool("windowactivate", "--sync", str(v), timeout=3)
        elif kind in ("launch", "open"):
            self.launch(kind, v)
        elif kind == "pause":
            time.sleep(v / 1000)

    def xdotool(self, *args, stdin=None, timeout=10):
        path = self.tools["xdotool"]
        if not path:
            raise HelperError("unavailable", "xdotool isn't installed")
        try:
            r = subprocess.run([path] + list(args), input=stdin, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise HelperError("failed", "xdotool didn't finish in time")
        if r.returncode != 0:
            raise HelperError("failed", "xdotool: %s" % first_line(r.stderr))

    def type_text(self, text):
        """
        Keys for what a keyboard types exactly (text on stdin, never in an argument), one by one at a person's
        pace up to typeMaxChars and evenly past it; the rest is pasted.
        """
        if len(text) <= HUMAN["typeMaxChars"]:
            waits = iter(typing_delays(text, self.rng))
            due = time.monotonic()
            for keys, run in text_runs(text):
                for ch in run if keys else [run]:
                    due += next(waits) / 1000
                    time.sleep(max(0.0, due - time.monotonic()))
                    self.check_stopped()
                    if keys:
                        hold = round(between(self.rng, HUMAN["keyHoldMs"]))
                        self.xdotool("type", "--delay", str(4 * hold), "--file", "-", stdin=ch.encode("utf-8"))
                    else:
                        self.paste(run)
                        due = time.monotonic()
            return
        for keys, run in text_runs(text):
            self.check_stopped()
            if keys:
                for i in range(0, len(run), EVEN_CHUNK):
                    self.check_stopped()
                    self.xdotool("type", "--delay", str(KEY_DELAY_MS), "--file", "-", stdin=run[i : i + EVEN_CHUNK].encode("utf-8"))
            else:
                self.paste(run)

    def paste(self, text):
        """
        Pastes text with Shift+Insert, which text fields take from the clipboard and terminals from the
        primary selection, and waits for the app to ask for it, so later keys land after it.
        """
        x = self.display()
        x.hold(text)
        x.pump()
        served = x.served
        self.xdotool("key", "--delay", str(KEY_DELAY_MS), "shift+Insert")
        deadline = time.monotonic() + PASTE_S
        while x.served == served:
            left = deadline - time.monotonic()
            if left <= 0:
                raise HelperError("failed", "nothing took the pasted text (is a text field focused?)")
            x.pump(left)

    def launch(self, kind, target):
        """Starts an app (a desktop entry id) or opens a file with its app, in the session's environment."""
        from gi.repository import Gio, GLib

        ctx = Gio.AppLaunchContext()
        for key, value in self.session().items():
            ctx.setenv(key, value)
        try:
            if kind == "launch":
                app = Gio.DesktopAppInfo.new(target)
                if app is None:
                    raise HelperError("failed", "there is no app %s" % target)
                app.launch([], ctx)
            else:
                if not os.path.exists(target):
                    raise HelperError("failed", "there is no file %s" % target)
                Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(target).get_uri(), ctx)
        except GLib.Error as e:
            raise HelperError("failed", "it didn't start: %s" % first_line(e.message))

    def session(self):
        """
        The desktop session's environment (its D-Bus, the accessibility switches), from its
        xfce4-session process: apps started from here then show in the tree like ones from the menu.
        """
        if self.session_env is None:
            self.session_env = {}
            uid, display = os.getuid(), os.environ.get("DISPLAY")
            for pid in filter(str.isdigit, os.listdir("/proc")):
                try:
                    if os.stat("/proc/" + pid).st_uid != uid:
                        continue
                    with open("/proc/%s/comm" % pid) as f:
                        if f.read().strip() != "xfce4-session":
                            continue
                    with open("/proc/%s/environ" % pid, "rb") as f:
                        env = parse_environ(f.read())
                except OSError:
                    continue
                if env.get("DISPLAY") == display:
                    self.session_env = env
                    break
        return self.session_env

    def capture(self, req):
        """A JPEG of the screen or a region of it (scrot), from a 0700 folder of the helper's own."""
        x = self.display()
        quality = req.get("quality", 70)
        if not is_int(quality, 30, 95):
            raise bad("capture: quality 30 to 95")
        region = clamp_region(req["region"], x.screen) if req.get("region") is not None else None
        if not self.tools["scrot"]:
            raise HelperError("unavailable", "scrot isn't installed")
        if self.shots is None:
            self.shots = tempfile.mkdtemp(prefix="agentes-desktop-")
        path = os.path.join(self.shots, "shot.jpg")
        argv = [self.tools["scrot"], "--silent", "--overwrite", "--quality", str(quality)]
        if region:
            argv += ["--autoselect", "%(x)d,%(y)d,%(width)d,%(height)d" % region]
        try:
            r = subprocess.run(argv + [path], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
            if r.returncode != 0:
                raise HelperError("failed", "scrot: %s" % first_line(r.stderr))
            with open(path, "rb") as f:
                data = f.read()
        except subprocess.TimeoutExpired:
            raise HelperError("failed", "scrot didn't finish in time")
        finally:
            if os.path.exists(path):
                os.unlink(path)
        size = (region["width"], region["height"]) if region else tuple(x.screen)
        return {"jpeg": base64.b64encode(data).decode("ascii"), "width": size[0], "height": size[1], "region": region}

    def apps(self, _req=None):
        """The apps a person could start from the menu."""
        try:
            from gi.repository import Gio
        except ImportError:
            raise HelperError("unavailable", "python3-gi isn't installed")
        out = []
        for app in Gio.AppInfo.get_all():
            if app.should_show():
                generic = app.get_generic_name() if hasattr(app, "get_generic_name") else None
                keywords = app.get_keywords() if hasattr(app, "get_keywords") else []
                out.append({"id": app.get_id(), "name": app.get_name(), "generic": generic, "keywords": list(keywords or [])})
        return out


OPS = {
    "hello": Desktop.hello,
    "snapshot": Desktop.snapshot,
    "extents": Desktop.extents,
    "input": Desktop.input,
    "capture": Desktop.capture,
    "apps": Desktop.apps,
}


def handle(desktop, line):
    """One request line to its reply."""
    try:
        req = json.loads(line)
    except ValueError:
        return {"id": None, "ok": False, "code": "bad_request", "error": "a request is one JSON object per line"}
    rid = req.get("id") if isinstance(req, dict) else None
    if type(rid) is not int:
        return {"id": None, "ok": False, "code": "bad_request", "error": "a request needs a numeric id"}
    op = OPS.get(req.get("op")) if isinstance(req.get("op"), str) else None
    if op is None:
        return {"id": rid, "ok": False, "code": "bad_request", "error": "ops: " + ", ".join(OPS)}
    try:
        return {"id": rid, "ok": True, "data": op(desktop, req)}
    except HelperError as e:
        return {"id": rid, "ok": False, "code": e.code, "error": str(e)}
    except Exception as e:
        if desktop.x is not None and isinstance(e, desktop.x.error.ConnectionClosedError):
            desktop.x = None
            return {"id": rid, "ok": False, "code": "unavailable", "error": "the desktop's display is gone"}
        return {"id": rid, "ok": False, "code": "internal", "error": "%s: %s" % (type(e).__name__, first_line(e))}


def serve(desktop, stdin=None, stdout=None):
    """Requests from stdin until it closes; X events are taken in between, so damage history stays current."""
    stdin = stdin if stdin is not None else sys.stdin.buffer.fileno()
    stdout = stdout if stdout is not None else sys.stdout.buffer
    lines = Lines()
    while True:
        # Events read while a request ran wait in Xlib's queue, where select can't see them.
        if desktop.x:
            try:
                desktop.x.pump()
            except Exception:
                desktop.x = None
        fds = [stdin] + ([desktop.x.fileno()] if desktop.x else [])
        if stdin not in select.select(fds, [], [])[0]:
            continue
        chunk = os.read(stdin, 65536)
        if not chunk:
            return
        for line in lines.feed(chunk):
            if line.strip():
                reply = handle(desktop, line)
                stdout.write(json.dumps(reply, separators=(",", ":")).encode("ascii") + b"\n")
                stdout.flush()


# ---------------------------------------------------------------- --self-check

# Strings that xdotool alone gets wrong (capitals with accents, curly quotes, symbols, CJK).
CHECK_STRINGS = [
    "\u00c1\u00c9\u00cd\u00d3\u00da \u00c2\u00ca\u00d4 \u00c3\u00d5 \u00c0 \u00c7",
    "\u00e1\u00e9\u00ed\u00f3\u00fa \u00e2\u00ea\u00f4 \u00e3\u00f5 \u00e0 \u00e7",
    "S3nh@!#$%^&*()_+-=[]{}|;:'\",.<>/?`~\\",
    "\u201ccurly\u201d \u2018single\u2019 \u2014 \u2013 \u2026 \u20ac \u00a3 \u2713 \u65e5\u672c",
    "Jo\u00e3o Concei\u00e7\u00e3o da Silva, S\u00e3o Paulo",
]

ENTRY_WINDOW = """
import json, sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
w = Gtk.Window(title="agentes-desktop-self-check")
e = Gtk.Entry()
def done(entry):
    sys.stdout.write(json.dumps(entry.get_text()) + "\\n")
    sys.stdout.flush()
    entry.set_text("")
e.connect("activate", done)
w.add(e)
w.set_default_size(900, 40)
w.connect("destroy", Gtk.main_quit)
w.show_all()
Gtk.main()
"""


def median(values):
    s = sorted(values)
    return s[len(s) // 2] if s else None


def timed(fn, rounds):
    """fn's result and its p50 and max over `rounds` runs, in ms."""
    times, result = [], None
    for _ in range(rounds):
        t0 = time.monotonic()
        result = fn()
        times.append((time.monotonic() - t0) * 1000)
    return result, round(median(times)), round(max(times))


def typing_check(desktop):
    """Types and fills CHECK_STRINGS into a GTK entry of its own; what the entry got, per string."""
    x = desktop.display()
    env = dict(os.environ, **desktop.session())
    child = subprocess.Popen([sys.executable, "-I", "-c", ENTRY_WINDOW], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    results = []
    try:
        deadline = time.monotonic() + 10
        window = None
        while window is None and time.monotonic() < deadline:
            window = next((w for w in x.windows() if w["pid"] == child.pid), None)
            time.sleep(0.1)
        if window is None:
            return [("window", "didn't open")]
        desktop.step("activate", {"activate": window["xid"]})
        time.sleep(0.3)

        def entered():
            ready = select.select([child.stdout], [], [], 3)[0]
            return json.loads(child.stdout.readline()) if ready else None

        for text in CHECK_STRINGS:
            desktop.type_text(text)
            desktop.step("key", {"key": "Return"})
            results.append(("type", text, entered()))
        a11y = desktop.bus()
        bus = next((b for b, p in a11y.pids_of(a11y.apps()).items() if p == child.pid), None)
        trees = a11y.trees([bus]) if bus else ["no app"]
        field = next((n for n in trees[0] if "EditableText" in n["ifaces"]), None) if isinstance(trees[0], list) else None
        for text in CHECK_STRINGS:
            if field is None:
                results.append(("fill", text, "no editable field"))
                continue
            try:
                a11y.set_text(bus, field["path"], text)
                desktop.step("key", {"key": "Return"})
                results.append(("fill", text, entered()))
            except HelperError as e:
                results.append(("fill", text, str(e)))
    finally:
        child.kill()
    return results


def self_check(rounds=10):
    """Timings on $DISPLAY: a look, extents, capture, act + settle; then the typing check."""
    desktop = Desktop()
    try:
        info = desktop.hello()
        print("hello:", json.dumps(info))
        if not info["screen"] or not info["a11y"]:
            return 1
        x = desktop.display()
        windows, p50, top = timed(x.windows, rounds)
        print("windows: %d on the screen, p50 %d ms (max %d)" % (len(windows), p50, top))
        for scope in ("front", "all"):
            snap, p50, top = timed(lambda: desktop.snapshot({"scope": scope}), rounds)
            apps = ["%s:%s" % (a["name"] or a["bus"], len(a.get("nodes", []))) for a in snap["apps"]]
            print("look (%s): p50 %d ms (max %d); apps %s" % (scope, p50, top, " ".join(apps)))
        nodes = [[a["bus"], n["path"]] for a in snap["apps"] for n in a.get("nodes", []) if "box" in n]
        _, p50, top = timed(lambda: desktop.extents({"nodes": nodes}), rounds)
        print("extents of %d elements: p50 %d ms (max %d)" % (len(nodes), p50, top))
        shot, p50, top = timed(lambda: desktop.capture({}), rounds)
        print("capture, whole screen: p50 %d ms (max %d), %d KB" % (p50, top, len(shot["jpeg"]) * 3 // 4 // 1024))
        region = {"x": 400, "y": 250, "width": 480, "height": 300}
        _, p50, top = timed(lambda: desktop.capture({"region": region}), rounds)
        print("capture, 480x300: p50 %d ms (max %d)" % (p50, top))
        w, h = x.screen
        moves = itertools.cycle([[w // 2, h // 2], [w // 2 + 1, h // 2]])
        acted, p50, top = timed(lambda: desktop.input({"steps": [{"move": next(moves)}], "settle": {}}), rounds)
        print("act + settle (pointer move): p50 %d ms (max %d); last %s" % (p50, top, json.dumps(acted)))
        _, p50, top = timed(lambda: desktop.apps(), 3)
        print("apps: p50 %d ms" % p50)
        failed = 0
        for how, text, got in typing_check(desktop):
            ok = got == text
            failed += not ok
            print("%s %-4s %s -> %s" % ("ok  " if ok else "DIFF", how, json.dumps(text), json.dumps(got)))
        return 1 if failed else 0
    finally:
        desktop.close()


def main(argv):
    # xdotool reads text in the locale's encoding: anything but UTF-8 drops every accented letter.
    os.environ["LC_ALL"] = "C.UTF-8"
    # Apps it starts open where the menu's would, in the agent's home.
    try:
        os.chdir(os.environ.get("HOME") or "/")
    except OSError:
        pass
    if "--self-check" in argv:
        return self_check()
    desktop = Desktop()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGUSR1, desktop.stop_input)
    try:
        serve(desktop)
    except BrokenPipeError:
        pass
    finally:
        desktop.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
