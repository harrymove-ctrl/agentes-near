import { describe, expect, test } from "bun:test";
import {
  type CalItem,
  collapseRoutines,
  dayEntries,
  dayRuns,
  dragRange,
  HOUR_PX,
  initialScrollMinutes,
  layoutBars,
  layoutDay,
  onDay,
  rangeLabel,
  runStacks,
  toItems,
  upcomingItems,
  viewDays,
} from "../src/lib/calendar";

const day = new Date(2026, 9, 14);
const at = (h: number, m = 0, d = day) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
const item = (key: string, start: Date, end: Date, allDay = false): CalItem => ({
  key,
  kind: "event",
  source: "person",
  title: key,
  start,
  end,
  allDay,
  recurring: false,
  people: [],
});

const run = (key: string, start: Date): CalItem => ({
  ...item(key, start, new Date(start.getTime() + 15 * 60_000)),
  kind: "routine",
  source: "routine",
  routineId: key,
});
/** A stack as the grid shows it: its first run's minute, its runs, the rows it shows and how many go behind "+N". */
const stacked = (list: ReturnType<typeof runStacks>) =>
  list.map((s) => [Math.round(s.top), s.runs.map((r) => r.key), s.shown, s.more]);

describe("calendar layout", () => {
  test("runs that would meet stack (earliest first): two rows, then +N; events and bands stay out", () => {
    const band: CalItem = { ...run("band", at(0)), allDay: true, end: at(0, 0, new Date(2026, 9, 15)), runs: [at(1)] };
    const stacks = runStacks(
      [
        run("b", at(9, 30)),
        run("a", at(9, 10)),
        run("c", at(9, 45)),
        run("d", at(9, 50)),
        run("e", at(18)),
        run("other-day", at(9, 0, new Date(2026, 9, 15))),
        item("event", at(9), at(10)),
        band,
      ],
      day,
    );
    expect(stacked(stacks)).toEqual([
      [9 * 60 + 10, ["a", "b", "c", "d"], 2, 2],
      [18 * 60, ["e"], 1, 0],
    ]);
    expect(stacks[0]?.kind).toBe("runs");
  });

  test("a stack shows only the rows that fit before the next item under it, at least one", () => {
    // A meeting 40 minutes after three runs: room for one row and "+2" (40px), not two rows and "+1" (62px).
    const runs = [run("a", at(7)), run("b", at(7, 1)), run("c", at(7, 2))];
    expect(stacked(runStacks([...runs, item("meeting", at(7, 40), at(8, 40))], day))).toEqual([
      [7 * 60, ["a", "b", "c"], 1, 2],
    ]);
    // A run an hour later starts its own stack, under the first one's line and "+2".
    expect(stacked(runStacks([...runs, run("d", at(8))], day))).toEqual([
      [7 * 60, ["a", "b", "c"], 1, 2],
      [8 * 60, ["d"], 1, 0],
    ]);
    // Ten minutes after the first run there's no room even for one line: it still shows one.
    expect(stacked(runStacks([run("a", at(7)), item("soon", at(7, 10), at(8))], day))).toEqual([[7 * 60, ["a"], 1, 0]]);
  });

  test("a stack drawn taller than a line (a name that wraps) takes in the run that would start inside it", () => {
    const runs = [run("a", at(7)), run("b", at(7, 40))];
    expect(stacked(runStacks(runs, day))).toEqual([
      [7 * 60, ["a"], 1, 0],
      [7 * 60 + 40, ["b"], 1, 0],
    ]);
    const tall = new Map([["runs-a", 3 * 16 + 4]]);
    expect(stacked(runStacks(runs, day, tall))).toEqual([[7 * 60, ["a", "b"], 2, 0]]);
  });

  test("a stack is one item beside the meetings it meets; a block drawn past its slot pushes the next beside it", () => {
    const runs = [run("a", at(7)), run("b", at(7, 1)), run("c", at(7, 2))];
    const meeting = item("meeting", at(7, 40), at(8, 40));
    const stacks = runStacks([...runs, meeting], day);
    const placed = layoutDay([meeting], day, stacks);
    expect(placed.map((p) => [p.item.key, p.col, p.cols])).toEqual([
      ["runs-a", 0, 2],
      ["meeting", 1, 2],
    ]);
    // The runs' column is the narrow one: the meeting keeps room for its name.
    expect(placed.map((p) => [p.thin, p.thins, p.thinBefore])).toEqual([
      [true, 1, 0],
      [false, 1, 1],
    ]);
    // A stack alone takes the column, and meetings beside meetings share it evenly.
    const two = runStacks([run("x", at(7)), run("y", at(7, 1)), run("z", at(7, 2)), item("m", at(7, 50), at(9))], day);
    expect(layoutDay([], day, two).map((p) => p.thins)).toEqual([0]);
    expect(layoutDay([item("p", at(9), at(10)), item("q", at(9), at(10))], day).map((p) => p.thins)).toEqual([0, 0]);
    // 09:00–09:30 drawn 50px tall (its title wraps) reaches 10:08: the 09:45 meeting goes beside it.
    const short = item("short", at(9), at(9, 30));
    const next = item("next", at(9, 45), at(10, 15));
    expect(layoutDay([short, next], day).map((p) => p.cols)).toEqual([1, 1]);
    expect(layoutDay([short, next], day, [], new Map([["short", 50]])).map((p) => [p.col, p.cols])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    // Its own slot stays its slot: only what it reaches into moves.
    expect(layoutDay([short], day, [], new Map([["short", 50]]))[0]?.height).toBe(30);
  });

  test("a day's rows for the month and the agenda: all day first, then by time, a frequent routine once", () => {
    const band: CalItem = {
      ...run("band", at(0)),
      allDay: true,
      end: at(0, 0, new Date(2026, 9, 15)),
      runs: [at(6), at(12), at(18)],
    };
    const rows = dayEntries(
      [
        run("late", at(18, 30)),
        item("lunch", at(12), at(13)),
        item("holiday", at(0), at(0, 0, new Date(2026, 9, 15)), true),
        band,
      ],
      day,
    );
    expect(rows.map((r) => [r.key, r.day?.count])).toEqual([
      ["holiday", undefined],
      [`band@${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`, 3],
      ["lunch", undefined],
      ["late", undefined],
    ]);
  });

  test("a day's routine runs: a mark per single run, one per frequent routine with its count; time-ordered", () => {
    const run = (key: string, start: Date): CalItem => ({
      ...item(key, start, new Date(start.getTime() + 15 * 60_000)),
      kind: "routine",
      source: "routine",
      routineId: key,
    });
    const next = new Date(2026, 9, 15);
    const band: CalItem = {
      ...run("band", at(0)),
      allDay: true,
      end: at(0, 0, new Date(2026, 9, 16)),
      runs: [...Array.from({ length: 24 }, (_, h) => at(h, 30)), at(1, 30, next), at(2, 30, next)],
      pastRuns: [
        { at: at(3, 30), status: "ok" },
        { at: at(2, 30), status: "failed" },
      ],
    };
    const entries = dayRuns(
      [
        run("late", at(18)),
        { ...run("early", at(0, 10)), result: "ok" },
        run("tomorrow", at(9, 0, next)),
        item("event", at(9), at(10)),
        band,
      ],
      day,
    );
    expect(entries.map((e) => [e.item.key, e.count, e.status])).toEqual([
      ["early", 1, "ok"],
      ["band", 24, "failed"],
      ["late", 1, undefined],
    ]);
    expect(dayRuns([band], next).map((e) => [e.count, e.status])).toEqual([[2, undefined]]);
  });

  test("a reminder late at night stays on its day, in the grid, tall enough to read", () => {
    const [late] = toItems({
      events: [],
      routines: [],
      deadlines: [],
      proposals: [],
      reminders: [
        {
          id: "r",
          message: "m",
          at: at(23, 50).toISOString(),
          forUserId: "u",
          channelId: "c",
          threadId: null,
          agentId: "a",
          createdBy: "u",
          canCancel: true,
        },
      ],
    });
    const reminder = late as CalItem;
    const next = new Date(2026, 9, 15);
    expect(onDay(reminder, day)).toBe(true);
    expect(onDay(reminder, next)).toBe(false);
    expect(layoutDay([reminder], day).map((p) => [p.top, p.height])).toEqual([[1430, 10]]);
    expect(layoutDay([{ ...reminder, start: at(9), end: at(9, 1) }], day).map((p) => p.height)).toEqual([30]);
  });

  test("each item knows whose it is: who made an event, a run's and a reminder's agent, who has a task", () => {
    const event = (id: string, createdBy: { type: "person" | "agent"; id: string }) => ({
      id,
      title: id,
      description: "",
      start: at(10).toISOString(),
      end: at(11).toISOString(),
      allDay: false,
      timezone: "UTC",
      recurrence: "none" as const,
      participants: [],
      rsvp: [],
      channelId: null,
      issueId: null,
      createdBy,
    });
    const items = toItems({
      events: [event("by-person", { type: "person", id: "u-ana" }), event("by-agent", { type: "agent", id: "ag-ada" })],
      routines: [
        { routineId: "r1", name: "Diária", agentId: "ag-atlas", at: at(7).toISOString(), target: { type: "dm" } },
      ],
      reminders: [
        {
          id: "rem",
          message: "m",
          at: at(9).toISOString(),
          forUserId: "u-ana",
          channelId: "c",
          threadId: null,
          agentId: "ag-ada",
          createdBy: "u-ana",
          canCancel: true,
        },
      ],
      deadlines: [
        { issueId: "i1", number: 128, title: "Login", date: "2026-10-14", assignee: { type: "agent", id: "ag-ada" } },
        { issueId: "i2", number: 129, title: "Nobody", date: "2026-10-14", assignee: null },
        { issueId: "i3", number: 130, title: "Older server", date: "2026-10-14" },
      ],
      proposals: [],
    });
    expect(items.map((it) => [it.key, it.owner])).toEqual([
      ["by-person", { type: "person", id: "u-ana" }],
      ["by-agent", { type: "agent", id: "ag-ada" }],
      [`r1@${at(7).toISOString()}`, { type: "agent", id: "ag-atlas" }],
      ["reminder-rem", { type: "agent", id: "ag-ada" }],
      ["deadline-i1", { type: "agent", id: "ag-ada" }],
      ["deadline-i2", undefined],
      ["deadline-i3", undefined],
    ]);
  });

  test("overlapping events sit side by side; a later one gets the full width again", () => {
    const placed = layoutDay(
      [
        item("a", at(9), at(10)),
        item("b", at(9, 30), at(11)),
        item("c", at(10), at(10, 30)),
        item("d", at(14), at(15)),
      ],
      day,
    );
    const by = Object.fromEntries(placed.map((p) => [p.item.key, [p.col, p.cols, p.top, p.height]]));
    expect(by).toEqual({
      a: [0, 2, 540, 60],
      b: [1, 2, 570, 90],
      c: [0, 2, 600, 30],
      d: [0, 1, 840, 60],
    });
  });

  test("all-day and multi-day items become bars in lanes", () => {
    const days = viewDays("week", day);
    const bars = layoutBars(
      [
        item("trip", at(0, 0, days[1] as Date), at(0, 0, days[4] as Date), true),
        item("deadline", at(0, 0, days[2] as Date), at(0, 0, days[3] as Date), true),
        item("late", at(22, 0, days[5] as Date), at(2, 0, days[6] as Date)),
      ],
      days,
    );
    expect(bars.map((b) => [b.item.key, b.from, b.span, b.lane])).toEqual([
      ["trip", 1, 3, 0],
      ["deadline", 2, 1, 1],
      ["late", 5, 2, 0],
    ]);
  });

  test("drag to create: snapped to 15 minutes; a click gives 30 minutes", () => {
    const r = dragRange(day, 9 * HOUR_PX + 5, 10.5 * HOUR_PX + 3);
    expect([r.start.getHours(), r.start.getMinutes(), r.end.getHours(), r.end.getMinutes()]).toEqual([9, 0, 10, 30]);
    const click = dragRange(day, 14 * HOUR_PX, 14 * HOUR_PX);
    expect([click.start.getHours(), click.end.getHours(), click.end.getMinutes()]).toEqual([14, 14, 30]);
  });

  test("the grid opens around 07:00, or a little before an earlier event", () => {
    expect(initialScrollMinutes([], [day])).toBe(7 * 60);
    expect(initialScrollMinutes([item("early", at(6), at(7))], [day])).toBe(5 * 60 + 30);
  });

  test("week of 7 days, or only business days; the header range", () => {
    expect(viewDays("week", day)).toHaveLength(7);
    expect(viewDays("week", day, true).map((d) => d.getDay())).toEqual([1, 2, 3, 4, 5]);
    const week = rangeLabel("pt-BR", "week", viewDays("week", day), day);
    expect(week).toContain("12");
    expect(week).toContain("18");
    expect(week).toContain("2026");
    expect(rangeLabel("pt-BR", "month", [], day)).toBe("outubro de 2026");
  });
});

describe("hour labels", () => {
  test("12-hour locales: 1 AM … 12 PM; 24-hour: 01:00 … 23:00", async () => {
    const { hourLabel, uses12h } = await import("../src/lib/calendar");
    expect(uses12h("en")).toBe(true);
    expect(uses12h("pt-BR")).toBe(false);
    expect([1, 12, 13].map((h) => hourLabel("en", h).replace(/\s/g, " "))).toEqual(["1 AM", "12 PM", "1 PM"]);
    expect([1, 13, 23].map((h) => hourLabel("pt-BR", h))).toEqual(["01:00", "13:00", "23:00"]);
  });
});

describe("routines on the calendar", () => {
  const run = (routineId: string, start: Date): CalItem => ({
    ...item(`${routineId}@${start.getTime()}`, start, new Date(start.getTime() + 15 * 60_000)),
    kind: "routine",
    source: "routine",
    recurring: true,
    routineId,
    agentId: "a1",
  });
  const week = viewDays("week", day);
  const hourly = week.flatMap((d) => Array.from({ length: 24 }, (_, h) => run("hourly", at(h, 0, d))));

  test("a routine that runs often is one band over the week, with its runs and cadence", () => {
    const sparse = run("daily", at(9));
    const out = collapseRoutines([...hourly, sparse, item("meet", at(10), at(11))], week);
    const bands = out.filter((it) => it.runs);
    expect(bands).toHaveLength(1);
    const band = bands[0] as CalItem;
    expect(band.allDay).toBe(true);
    expect(band.runs).toHaveLength(24 * 7);
    expect(band.every).toBe(60);
    expect(layoutBars(bands, week)[0]).toMatchObject({ from: 0, span: 7 });
    // Sparse runs and events stay as they are.
    expect(out.map((it) => it.key)).toContain(sparse.key);
    expect(out.map((it) => it.key)).toContain("meet");
  });

  test("a band only spans days that follow each other; a light day breaks it", () => {
    const light = new Date((week[2] as Date).getTime());
    const runs = hourly.filter((r) => !(r.start.toDateString() === light.toDateString() && r.start.getHours() > 1));
    const bands = collapseRoutines(runs, week).filter((it) => it.runs);
    expect(bands.map((b) => b.runs?.length)).toEqual([48, 96]);
    const businessWeek = viewDays("week", day, true);
    expect(collapseRoutines(hourly, businessWeek).filter((it) => it.runs)).toHaveLength(1);
  });

  test("Próximos shows a routine only by its next run", () => {
    const now = at(8, 30);
    const next = upcomingItems([...hourly, item("meet", at(10), at(11))], now);
    expect(next.filter((it) => it.routineId)).toHaveLength(1);
    expect(next.map((it) => it.key)).toContain("meet");
  });
});
