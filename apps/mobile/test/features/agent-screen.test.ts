import { describe, expect, mock, test } from "bun:test";
import { CURSOR_CELLS, cursorCells } from "../../src/features/computer/pixel-cursor";
import {
  BUTTON,
  POINTER_MS,
  PointerLine,
  pageCall,
  screenCall,
  screenEvent,
  screenPageStays,
  screenPageUrl,
  screenWaits,
  sessionAnswer,
  sessionCookieScript,
  typedSince,
} from "../../src/features/computer/screen-page";
import {
  atDesktopEdge,
  boundCamera,
  controlScale,
  cursorGain,
  DEFAULT_DESKTOP,
  DRAG_REST,
  type Drag,
  type DragEvent,
  dragStep,
  dragView,
  fitScale,
  followCursor,
  keepView,
  lookAt,
  MAX_SCALE,
  TAP_DRAG_MS,
  toDesktop,
  zoomCamera,
} from "../../src/features/computer/screen-view";

const SERVER = "https://app.example";
const PHONE = { width: 336, height: 320 };

describe("the page behind the agent's screen", () => {
  test("only the server's own page loads in the WebView that holds the session", () => {
    const url = screenPageUrl(SERVER, "org", "ada");
    expect(url).toBe("https://app.example/screen.html?o=org&a=ada");
    expect(screenPageStays(SERVER, url)).toBe(true);
    expect(screenPageStays(SERVER, "https://app.example/")).toBe(false);
    expect(screenPageStays(SERVER, "https://app.example.evil.example/screen.html")).toBe(false);
    expect(screenPageStays(SERVER, "https://app.example@evil.example/screen.html")).toBe(false);
    expect(screenPageStays(SERVER, "not a url")).toBe(false);
  });

  test("a browser card's page only watches, and is still the server's own page (ADR 0058 §7)", () => {
    const url = screenPageUrl(SERVER, "org", "ada", { preview: true });
    expect(url).toBe("https://app.example/screen.html?o=org&a=ada&p=1");
    expect(screenPageStays(SERVER, url)).toBe(true);
    expect(screenPageUrl(SERVER, "org", "ada", { preview: false })).toBe(screenPageUrl(SERVER, "org", "ada"));
  });

  test("a message counts only from the server's page, and only as what it can say", () => {
    const url = screenPageUrl(SERVER, "org", "ada");
    const heard = (data: unknown, from = url) => screenEvent(SERVER, { url: from, data: JSON.stringify(data) });
    expect(heard({ type: "ready" })).toEqual({ type: "ready" });
    expect(heard({ type: "view", state: "live" })).toEqual({ type: "view", state: "live" });
    expect(heard({ type: "size", width: 1280, height: 900 })).toEqual({ type: "size", width: 1280, height: 900 });
    expect(heard({ type: "ready" }, "https://evil.example/screen.html")).toBeNull();
    expect(heard({ type: "view", state: "nonsense" })).toBeNull();
    expect(heard({ type: "size", width: 0, height: 900 })).toBeNull();
    expect(heard({ type: "session", mode: "control" })).toEqual({ type: "session", mode: "control" });
    expect(heard({ type: "session", mode: "drive" })).toBeNull();
    expect(screenEvent(SERVER, { url, data: "{" })).toBeNull();
    expect(screenEvent(SERVER, { url, data: "null" })).toBeNull();
  });

  test("the session cookie is set only on what the server's address allows", () => {
    const script = sessionCookieScript("; a=1; __Secure-b=2%3D", SERVER);
    expect(script).toContain('document.cookie="a=1; path=/; samesite=strict; secure";');
    expect(script).toContain('document.cookie="__Secure-b=2%3D; path=/; samesite=strict; secure";');
    expect(sessionCookieScript("a=1", "http://localhost:3000")).not.toContain("secure");
    expect(sessionCookieScript("", SERVER)).toBe("true;");
  });

  test("the session goes into the page's own document before each socket it may open", () => {
    // Android runs the start script where it may not reach this document: the cookie comes again from the page's
    // own events, before the first `set` (ready) and before every reopen after a close (changed).
    const cookie = "__Secure-s=tok%3D";
    const jar: string[] = [];
    const runInPage = (js: string) =>
      new Function("document", js)({
        set cookie(v: string) {
          jar.push(v);
        },
      });
    for (const type of ["ready", "changed"] as const) {
      const js = sessionAnswer({ type }, cookie, SERVER);
      expect(js).not.toBeNull();
      jar.length = 0;
      runInPage(js ?? "");
      expect(jar).toEqual(["__Secure-s=tok%3D; path=/; samesite=strict; secure"]);
    }
    expect(sessionAnswer({ type: "view", state: "live" }, cookie, SERVER)).toBeNull();
    expect(sessionAnswer({ type: "size", width: 1, height: 1 }, cookie, SERVER)).toBeNull();
  });

  test("a call the page may open its socket on sets the session in its document first", () => {
    // Coming back to the app, a mode switch or Tentar de novo open a socket with no page event before it: another
    // incognito WebView mounting meanwhile (a browser card's) clears every cookie on Android.
    const session = { cookie: "__Secure-s=tok%3D", server: SERVER };
    const order: string[] = [];
    const runInPage = (js: string) =>
      new Function("document", "window", js)(
        {
          set cookie(v: string) {
            order.push(`cookie ${v}`);
          },
        },
        {
          agentScreen: { set: () => order.push("set"), retry: () => order.push("retry"), key: () => order.push("key") },
        },
      );
    for (const js of [pageCall(session, "set", { connect: true, mode: "watch" }), pageCall(session, "retry")]) {
      order.length = 0;
      runInPage(js);
      expect(order).toHaveLength(2);
      expect(order[0]).toBe("cookie __Secure-s=tok%3D; path=/; samesite=strict; secure");
    }
    expect(pageCall(session, "key", "Enter")).toBe(screenCall("key", "Enter"));
    expect(pageCall(session, "pointer", 1, 2, 0)).toBe(screenCall("pointer", 1, 2, 0));
  });

  test("an agent's screen whose state never comes still says it can't be shown, as one whose socket never opens", () => {
    expect(screenWaits({ active: true, shown: "connecting", switching: false })).toBe(true);
    expect(screenWaits({ active: true, shown: "live", switching: true })).toBe(true);
    expect(screenWaits({ active: true, shown: "live", switching: false })).toBe(false);
    expect(screenWaits({ active: true, shown: "hidden", switching: false })).toBe(false);
    expect(screenWaits({ active: false, shown: "connecting", switching: false })).toBe(false);
  });

  test("what a person typed stays a value, never code", () => {
    const js = screenCall("type", `"); fetch("https://evil.example`);
    expect(js).toBe(`window.agentScreen?.type("\\"); fetch(\\"https://evil.example");true;`);
    expect(screenCall("pointer", 10, 20, BUTTON.left)).toBe("window.agentScreen?.pointer(10,20,1);true;");
    expect(screenCall("set", { connect: true, mode: "control" })).toBe(
      'window.agentScreen?.set({"connect":true,"mode":"control"});true;',
    );
  });
});

describe("the pointer on its way to the page", () => {
  const line = () => {
    const sent: number[][] = [];
    let run: (() => void) | null = null;
    const schedule = mock((fn: () => void, _ms: number) => {
      run = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const l = new PointerLine(
      (x, y, b) => sent.push([x, y, b]),
      schedule,
      () => {
        run = null;
      },
    );
    return { l, sent, schedule, tick: () => run?.() };
  };

  test("the first move goes at once; after it, only the newest goes at each tick", () => {
    const { l, sent, schedule, tick } = line();
    l.move(1, 1);
    l.move(2, 2);
    l.move(3, 3);
    expect(sent).toEqual([[1, 1, 0]]);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[1]).toBe(POINTER_MS);
    tick();
    expect(sent).toEqual([
      [1, 1, 0],
      [3, 3, 0],
    ]);
  });

  test("a move after a quiet tick doesn't wait", () => {
    const { l, sent, tick } = line();
    l.move(1, 1);
    tick();
    l.move(2, 2);
    expect(sent).toEqual([
      [1, 1, 0],
      [2, 2, 0],
    ]);
  });

  test("a click lands after the move before it, down and then up", () => {
    const { l, sent } = line();
    l.move(5, 6);
    l.click(5, 6);
    expect(sent).toEqual([
      [5, 6, 0],
      [5, 6, BUTTON.left],
      [5, 6, 0],
    ]);
  });

  test("a drag keeps the button held on every move until it lets go", () => {
    const { l, sent, tick } = line();
    l.press(1, 1, BUTTON.left);
    l.move(9, 9);
    tick();
    l.press(9, 9, BUTTON.none);
    expect(sent).toEqual([
      [1, 1, 1],
      [9, 9, 1],
      [9, 9, 0],
    ]);
  });

  test("the wheel's notch doesn't let go of a held button", () => {
    const { l, sent } = line();
    l.press(1, 1, BUTTON.left);
    l.click(1, 1, BUTTON.wheelDown);
    expect(sent.at(-2)).toEqual([1, 1, BUTTON.left | BUTTON.wheelDown]);
    expect(sent.at(-1)).toEqual([1, 1, BUTTON.left]);
  });

  test("nothing goes after the view leaves", () => {
    const { l, sent, tick } = line();
    l.move(1, 1);
    l.move(2, 2);
    l.stop();
    tick();
    expect(sent).toEqual([[1, 1, 0]]);
  });
});

describe("the camera over the agent's screen", () => {
  const desk = DEFAULT_DESKTOP;

  test("watching shows it all; control fills the box, closer upright, never past what stays sharp", () => {
    expect(fitScale(PHONE, desk)).toBeCloseTo(336 / 1280);
    // Upright (narrower than the desktop) it starts close enough to read a field; sideways, just past the fit.
    expect(controlScale(PHONE, desk)).toBeCloseTo((336 / 1280) * 2.2);
    expect(controlScale({ width: 932, height: 430 }, desk)).toBeCloseTo(Math.max(932 / 1280, (430 / 900) * 1.25));
    expect(controlScale({ width: 2000, height: 4000 }, desk)).toBe(MAX_SCALE);
  });

  test("the camera stays on the desktop, centered on a side the box is larger than it", () => {
    const s = fitScale(PHONE, desk);
    const whole = boundCamera(50, 50, s, PHONE, desk);
    expect(whole.x).toBeCloseTo(0);
    expect(whole.y).toBeLessThan(0);
    expect(boundCamera(-100, -100, 1, PHONE, desk)).toEqual({ x: 0, y: 0 });
    expect(boundCamera(9999, 9999, 1, PHONE, desk)).toEqual({ x: 1280 - 336, y: 900 - 320 });
    expect(lookAt({ x: 640, y: 450 }, 1, PHONE, desk)).toEqual({ x: 640 - 168, y: 450 - 160 });
  });

  test("a pinch keeps the point under the fingers", () => {
    const before = { x: 200, y: 100 };
    const focal = { x: 100, y: 80 };
    const at = toDesktop(focal, before, 1, desk);
    const after = zoomCamera(before, 1, 2, focal, PHONE, desk);
    const still = toDesktop(focal, after, 2, desk);
    expect(still.x).toBeCloseTo(at.x);
    expect(still.y).toBeCloseTo(at.y);
  });

  test("a tap on the screen maps to the desktop, and stays on it", () => {
    expect(toDesktop({ x: 10, y: 20 }, { x: 100, y: 200 }, 0.5, desk)).toEqual({ x: 120, y: 240 });
    expect(toDesktop({ x: 5000, y: 5000 }, { x: 0, y: 0 }, 1, desk)).toEqual({ x: 1280, y: 900 });
  });

  test("the view moves only once the cursor nears its edge, and just enough", () => {
    const camera = { x: 300, y: 200 };
    expect(followCursor(camera, 1, { x: 460, y: 360 }, PHONE, desk)).toEqual(camera);
    const margin = 320 * 0.2;
    const right = followCursor(camera, 1, { x: 300 + 336, y: 360 }, PHONE, desk);
    expect((300 + 336 - right.x) * 1).toBeCloseTo(336 - margin);
    expect(right.y).toBe(200);
  });

  test("slow swipes aim, fast ones travel, and zooming in keeps a swipe's size on the screen", () => {
    expect(cursorGain(1.6, 0.4)).toBeGreaterThan(cursorGain(0.05, 0.4) * 2);
    expect(cursorGain(99, 0.4)).toBe(cursorGain(1.6, 0.4));
    expect(cursorGain(0.5, 0.8)).toBeCloseTo(cursorGain(0.5, 0.4) / 2);
  });

  test("an easy swipe across the trackpad crosses the view", () => {
    const s = controlScale(PHONE, desk);
    expect(300 * cursorGain(0.6, s) * s).toBeGreaterThan(PHONE.width);
  });

  test("a finger rolls the view first, and what's left goes to the page", () => {
    const wide = { width: 932, height: 430 };
    const s = controlScale(wide, desk);
    const middle = { x: 0, y: 100 };
    const inside = dragView(middle, s, { x: 0, y: -30 }, wide, desk);
    expect(inside.camera.y).toBeCloseTo(100 + 30 / s);
    expect(inside.left).toBeCloseTo(0);
    const bottom = { x: 0, y: 900 - 430 / s };
    const past = dragView(bottom, s, { x: 0, y: -30 }, wide, desk);
    expect(past.camera.y).toBeCloseTo(bottom.y);
    expect(past.left).toBeCloseTo(30);
    expect(dragView({ x: 0, y: 0 }, s, { x: 0, y: 30 }, wide, desk).left).toBeCloseTo(-30);
  });

  test("the keyboard coming keeps the zoom the person had, and the cursor in sight", () => {
    const tall = { width: 336, height: 520 };
    const short = { width: 336, height: 220 };
    const camera = { x: 400, y: 300 };
    // Near the bottom of the tall view: the shorter one moves down just enough to keep it inside its margin.
    const cursor = { x: 500, y: 300 + 480 / 1.6 };
    const kept = keepView(camera, 1.6, cursor, short, desk);
    expect(kept.s).toBe(1.6);
    expect(kept.camera.x).toBe(400);
    const py = (cursor.y - kept.camera.y) * kept.s;
    expect(py).toBeCloseTo(220 - 220 * 0.2);
    // Already in sight, nothing moves; going back to the tall box keeps the zoom too.
    expect(keepView(camera, 1.6, { x: 500, y: 340 }, short, desk)).toEqual({ s: 1.6, camera });
    expect(keepView(kept.camera, 1.6, cursor, tall, desk).s).toBe(1.6);
    // Never smaller than the whole screen, nor past what stays sharp.
    expect(keepView(camera, 0.01, cursor, short, desk).s).toBeCloseTo(fitScale(short, desk));
    expect(keepView(camera, 99, cursor, short, desk).s).toBe(MAX_SCALE);
  });

  test("the cursor knows when it has reached the desktop's edge", () => {
    expect(atDesktopEdge({ x: 0, y: 300 }, desk)).toBe(true);
    expect(atDesktopEdge({ x: 1280, y: 300 }, desk)).toBe(true);
    expect(atDesktopEdge({ x: 640, y: 900 }, desk)).toBe(true);
    expect(atDesktopEdge({ x: 640, y: 300 }, desk)).toBe(false);
  });
});

describe("the person's cursor", () => {
  test("its tip is the first cell, where a click lands, and it stays inside its box", () => {
    const cells = cursorCells();
    expect(cells[0]).toEqual({ x: 0, y: 0, tone: "rim" });
    for (const c of cells) {
      expect(c.x).toBeLessThan(CURSOR_CELLS.width);
      expect(c.y).toBeLessThan(CURSOR_CELLS.height);
    }
  });

  test("its body is dithered: both tones, and always the same drawing", () => {
    const tones = new Set(cursorCells().map((c) => c.tone));
    expect(tones).toEqual(new Set(["rim", "body", "light"]));
    expect(cursorCells()).toEqual(cursorCells());
  });
});

describe("pressing and dragging with one finger", () => {
  /** The acts a run of finger events sends, from rest. */
  const acts = (events: [DragEvent, number][], from: Drag = DRAG_REST) => {
    let d = from;
    const out: string[] = [];
    for (const [event, at] of events) {
      const next = dragStep(d, event, at);
      d = next.drag;
      if (next.act) out.push(next.act);
    }
    return out;
  };
  /** A tap at 0..100, its finger off at 100. */
  const tapped: [DragEvent, number][] = [
    ["touch", 0],
    ["tap", 100],
    ["lift", 100],
  ];

  test("a tap clicks; a swipe only moves", () => {
    expect(acts(tapped)).toEqual(["click"]);
    expect(
      acts([
        ["touch", 0],
        ["move", 50],
        ["lift", 400],
      ]),
    ).toEqual([]);
  });

  test("a hold presses, and the lift lets go however far the finger went after", () => {
    // The hold's own gesture ends a few points into the move: only the lift lets go.
    expect(
      acts([
        ["touch", 0],
        ["hold", 320],
        ["move", 400],
        ["lift", 900],
      ]),
    ).toEqual(["press", "release"]);
  });

  test("tap, then touch again soon and move: pressed from the move to the lift", () => {
    const again = 100 + TAP_DRAG_MS - 50;
    const run: [DragEvent, number][] = [...tapped, ["touch", again], ["move", again + 60], ["lift", 900]];
    expect(acts(run)).toEqual(["click", "press", "release"]);
  });

  test("tap, then a second tap soon is a double click, never a press left down", () => {
    expect(acts([...tapped, ["touch", 200], ["tap", 280], ["lift", 280]])).toEqual(["click", "click"]);
  });

  test("a touch long after a tap that moves only moves the cursor", () => {
    const late = 101 + TAP_DRAG_MS;
    expect(acts([...tapped, ["touch", late], ["move", late + 60], ["lift", 900]])).toEqual(["click"]);
  });

  test("a touch that pressed and lifted quickly lets go once and never also clicks, whichever comes first", () => {
    const armed = dragStep(dragStep(DRAG_REST, "tap", 0).drag, "touch", 100).drag;
    const pressed = dragStep(armed, "move", 120).drag;
    expect(
      acts(
        [
          ["tap", 180],
          ["lift", 180],
        ],
        pressed,
      ),
    ).toEqual(["release"]);
    expect(
      acts(
        [
          ["lift", 180],
          ["tap", 180],
        ],
        pressed,
      ),
    ).toEqual(["release"]);
    // That tap doesn't arm the next touch: a third quick touch that moves only moves.
    const third: [DragEvent, number][] = [
      ["tap", 180],
      ["lift", 180],
      ["touch", 200],
      ["move", 220],
      ["lift", 300],
    ];
    expect(acts(third, pressed)).toEqual(["release"]);
  });

  test("a press whose lift never came is let go by the next touch", () => {
    const held = dragStep(dragStep(DRAG_REST, "touch", 0).drag, "hold", 320).drag;
    expect(dragStep(held, "touch", 2000).act).toBe("release");
  });
});

describe("typing straight onto the screen", () => {
  test("what came is typed, what went is Backspaces", () => {
    expect(typedSince("", "a")).toEqual({ back: 0, typed: "a" });
    expect(typedSince("ab", "abc")).toEqual({ back: 0, typed: "c" });
    expect(typedSince("abc", "ab")).toEqual({ back: 1, typed: "" });
    expect(typedSince("ab", "ab")).toEqual({ back: 0, typed: "" });
    // A swiped word or a pasted text comes whole.
    expect(typedSince("oi ", "oi tudo bem")).toEqual({ back: 0, typed: "tudo bem" });
  });

  test("an emoji is one character, and a change in the middle leaves the same text there", () => {
    expect(typedSince("ok 👍", "ok ")).toEqual({ back: 1, typed: "" });
    expect(typedSince("ok", "ok 👍")).toEqual({ back: 0, typed: " 👍" });
    // The caret went back to "he" and typed "x": the screen's "hello" becomes "hexllo" too.
    const { back, typed } = typedSince("hello", "hexllo");
    expect("hello".slice(0, 5 - back) + typed).toBe("hexllo");
  });
});
