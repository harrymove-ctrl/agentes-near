"""
Unit tests for the desktop keeper's pure parts (no X): python3 -I this_file.py.
desktop-keeper.test.ts runs them in the test suite.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
KEEPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "runner", "desktop-keeper.py")
spec = importlib.util.spec_from_file_location("desktop_keeper", KEEPER)
k = importlib.util.module_from_spec(spec)
spec.loader.exec_module(k)

HOME = "/home/ag-1a2b3c4d"
CONFIG = {"browserClass": "agentes-browser", "notes": ["agentes-wait", "agentes-note"]}


class FakeProc:
    """A /proc of folders: <pid>/cmdline, environ, and cwd as a link."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="keeper-proc-")

    def add(self, pid, argv, cwd=HOME, env=None):
        d = os.path.join(self.root, str(pid))
        os.makedirs(d)
        with open(os.path.join(d, "cmdline"), "wb") as f:
            f.write(b"".join(a.encode() + b"\0" for a in argv))
        with open(os.path.join(d, "environ"), "wb") as f:
            f.write(b"".join(("%s=%s" % kv).encode() + b"\0" for kv in (env or {}).items()))
        os.symlink(cwd, os.path.join(d, "cwd"))

    def proc(self, others=()):
        p = k.Proc(self.root)
        mine = p.mine
        p.mine = lambda pid: pid not in others and mine(pid)
        return p

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)


def window(xid, pid, cls, types=("normal",), transient=False):
    return {"xid": xid, "pid": pid, "class": list(cls), "types": list(types), "transient": transient}


class Desktop(unittest.TestCase):
    """A desktop as XFCE shows it: the session's own windows, the agent's Chrome, notes, Terminals, Files and apps."""

    def setUp(self):
        f = self.fake = FakeProc()
        f.add(100, ["xfce4-panel"])
        f.add(101, ["xfdesktop"])
        f.add(102, ["/usr/bin/Thunar", "--daemon"])
        f.add(103, ["xfce4-settings-manager"])
        f.add(200, ["/opt/google/chrome/chrome", "--class=agentes-browser"])
        f.add(201, ["xfce4-terminal", "--disable-server", "--class=agentes-note"])
        f.add(300, ["mousepad", HOME + "/notes/todo.txt"], cwd=HOME + "/notes", env={"API_TOKEN": "t0ps3cret"})
        f.add(301, ["someone-elses"])
        f.add(400, ["xfce4-terminal"])
        self.windows = [
            window(1, 100, ("xfce4-panel", "Xfce4-panel"), ("dock",)),
            window(2, 101, ("xfdesktop", "Xfdesktop"), ("desktop",)),
            window(3, 102, ("Thunar", "Thunar")),
            window(4, 102, ("Thunar", "Thunar")),
            window(5, 102, ("Thunar", "Thunar"), ("dialog",), transient=True),
            window(6, 103, ("xfce4-settings-manager", "Xfce4-settings-manager")),
            window(7, 200, ("google-chrome", "agentes-browser")),
            window(8, 201, ("xfce4-terminal", "agentes-note")),
            window(9, 300, ("mousepad", "Mousepad")),
            window(10, 301, ("someone-elses", "Someone-elses")),
            window(11, 400, ("xfce4-terminal", "Xfce4-terminal")),
        ]

    def tearDown(self):
        self.fake.close()

    def state(self):
        return k.snapshot(self.windows, self.fake.proc(others={301}), CONFIG, HOME)

    def test_the_list_keeps_the_apps_and_the_browser_and_leaves_out_the_rest(self):
        # Files' two windows as two; its dialog, the session's programs, the note, the Terminal (the runner lists its
        # shells) and another user's app left out.
        self.assertEqual(
            self.state(),
            {
                "v": 1,
                "browser": True,
                "apps": [
                    {"argv": ["thunar"], "cwd": HOME},
                    {"argv": ["thunar"], "cwd": HOME},
                    {"argv": ["mousepad", HOME + "/notes/todo.txt"], "cwd": HOME + "/notes"},
                ],
            },
        )
        self.assertEqual(k.size(self.state()), 4)

    def test_nothing_of_a_process_environment_is_kept(self):
        self.assertNotIn("t0ps3cret", json.dumps(self.state()))

    def test_files_opened_on_a_folder_open_on_it_again(self):
        self.fake.add(500, ["thunar", HOME + "/photos"])
        self.windows.append(window(12, 500, ("Thunar", "Thunar")))
        self.assertIn({"argv": ["thunar", HOME + "/photos"], "cwd": HOME}, self.state()["apps"])

    def test_an_app_whose_arguments_are_too_long_or_whose_folder_is_gone_is_kept_as_it_can_be(self):
        self.fake.add(600, ["big"] + ["x" * 100] * 50)
        self.fake.add(601, ["gone-folder"], cwd=HOME + "/old (deleted)")
        self.windows += [window(13, 600, ("big", "Big")), window(14, 601, ("gone", "Gone"))]
        apps = self.state()["apps"]
        self.assertNotIn("big", [a["argv"][0] for a in apps])
        self.assertIn({"argv": ["gone-folder"], "cwd": HOME}, apps)

    def test_at_most_twenty_apps(self):
        for i in range(30):
            self.fake.add(1000 + i, ["app%d" % i])
            self.windows.append(window(2000 + i, 1000 + i, ("app", "App")))
        self.assertEqual(len(self.state()["apps"]), k.APPS_MAX)


class Writing(unittest.TestCase):
    def state(self, n, folder=HOME, browser=False):
        return {"v": 1, "browser": browser, "apps": [{"argv": ["a%d" % i], "cwd": folder} for i in range(n)]}

    def test_a_first_list_and_one_that_grows_or_changes_folder_go_at_once(self):
        w = k.Writer()
        self.assertEqual(w.offer(self.state(0), 0), self.state(0))
        self.assertEqual(w.offer(self.state(2), 1), self.state(2))
        self.assertIsNone(w.offer(self.state(2), 2))
        self.assertEqual(w.offer(self.state(2, "/tmp"), 3), self.state(2, "/tmp"))
        self.assertEqual(w.wait(3), k.POLL_S)

    def test_a_shorter_list_waits_until_it_stays_so(self):
        w = k.Writer(self.state(3))
        self.assertIsNone(w.offer(self.state(1), 10))
        self.assertAlmostEqual(w.wait(10), k.STABLE_S)
        self.assertIsNone(w.offer(self.state(1), 10 + k.STABLE_S - 0.1))
        self.assertEqual(w.offer(self.state(1), 10 + k.STABLE_S), self.state(1))

    def test_a_session_ending_mid_wait_writes_nothing(self):
        w = k.Writer(self.state(2, browser=True))
        self.assertIsNone(w.offer(self.state(2), 10))
        # Another window closed: the wait starts over.
        self.assertIsNone(w.offer(self.state(1), 11))
        self.assertIsNone(w.offer(self.state(1), 10 + k.STABLE_S))


class Files(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="keeper-files-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_the_list_is_the_users_alone_and_its_settings_are_never_read_through_a_link(self):
        folder = os.path.join(self.dir, "state")
        k.write_state(folder, {"v": 1, "apps": []})
        path = os.path.join(folder, k.STATE_FILE)
        self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual(k.read_json(path), {"v": 1, "apps": []})
        link = os.path.join(self.dir, "link.json")
        os.symlink(path, link)
        self.assertIsNone(k.read_json(link))

    def test_with_no_display_it_ends_at_once_and_keeps_nothing(self):
        env = {"HOME": self.dir, "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "DISPLAY": ""}
        run = subprocess.run([sys.executable, "-I", KEEPER], env=env, capture_output=True, timeout=30)
        self.assertEqual(run.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.dir, ".local", "state", "agentes")))


if __name__ == "__main__":
    unittest.main()
