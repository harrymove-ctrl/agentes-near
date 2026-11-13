import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import {
  limitOffers,
  type OfferAccount,
  PLAN_TONE,
  PlanMeter,
  type PlanMeterText,
  type PlanMeterUsage,
  planLevel,
  planLine,
  planState,
  planWindows,
} from "../src";

afterEach(() => cleanup());

const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const text: PlanMeterText = {
  window: (w) => (w.kind === "five_hour" ? "5 horas" : w.kind === "seven_day" ? "Semana" : (w.label ?? "Outro")),
  short: (w) => (w.kind === "five_hour" ? "5h" : w.kind === "seven_day" ? "semana" : (w.label ?? "outro")),
  resets: (iso) => `renova ${iso.slice(11, 16)}`,
  almost: "Quase no limite",
  limited: (until) => (until ? `No limite até ${until.slice(11, 16)}` : "No limite"),
  updated: (iso) => `Atualizado ${iso.slice(11, 16)}`,
  ago: (iso) => `atualizado ${iso.slice(11, 16)}`,
  stale: (iso) => `números antigos, de ${iso.slice(11, 16)}`,
};

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll(".ac-planmeter__window")].map((li) => [
    li.querySelector(".ac-planmeter__name")?.textContent,
    li.querySelector(".ac-planmeter__pct")?.textContent,
    li.querySelector(".ac-planmeter__reset")?.textContent ?? null,
  ]);

test("a bar per window, tightest first, each with its percentage and reset; how old the numbers are", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "seven_day", usedPercent: 35, resetsAt: at(48 * HOUR) },
      { kind: "five_hour", usedPercent: 62, resetsAt: at(2 * HOUR) },
      { kind: "other", label: "Fable", usedPercent: 35 },
    ],
    at: at(-5 * 60_000),
  };
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} />);
  const el = container.querySelector(".ac-planmeter") as HTMLElement;
  expect(el.dataset.state).toBe("ok");
  expect(el.querySelector(".ac-planmeter__state")).toBeNull();
  // The same share: the shorter window first.
  expect(rows(el)).toEqual([
    ["5 horas", "62%", "renova 14:00"],
    ["Semana", "35%", "renova 12:00"],
    ["Fable", "35%", null],
  ]);
  const meters = [...el.querySelectorAll("[role=meter]")];
  expect(meters.map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
    ["5 horas", "62"],
    ["Semana", "35"],
    ["Fable", "35"],
  ]);
  expect(el.querySelector(".ac-planmeter__at")?.textContent).toBe("Atualizado 11:55");
});

test("from 80% it says so; at 100% it is at the limit until every full window resets", () => {
  const almost = render(
    <PlanMeter usage={{ windows: [{ kind: "five_hour", usedPercent: 80 }], at: at(0) }} text={text} now={NOW} />,
  ).container;
  expect(almost.querySelector(".ac-planmeter")?.getAttribute("data-state")).toBe("almost");
  expect(almost.querySelector(".ac-planmeter__state")?.textContent).toBe("Quase no limite");
  cleanup();
  const full: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 100, resetsAt: at(HOUR) },
      { kind: "seven_day", usedPercent: 100, resetsAt: at(30 * HOUR) },
    ],
    limited: true,
    at: at(0),
  };
  const limited = render(<PlanMeter usage={full} text={text} now={NOW} />).container;
  expect(limited.querySelector(".ac-planmeter__state")?.textContent).toBe("No limite até 18:00");
  expect(planState(full, NOW)).toEqual({ state: "limited", until: at(30 * HOUR), used: 100 });
  // Refused without saying which window: at the limit, until unknown.
  expect(planState({ windows: [{ kind: "five_hour", usedPercent: 40 }], limited: true, at: at(0) }, NOW)).toEqual({
    state: "limited",
    until: null,
    used: 40,
  });
});

test("each bar by how close its window is to the limit: ink, amber from 80, red from 90 and at the limit", () => {
  expect([0, 79, 80, 89, 90, 99, 100].map((used) => planLevel(used))).toEqual([
    "ok",
    "ok",
    "almost",
    "almost",
    "critical",
    "critical",
    "limited",
  ]);
  // A plan that refused a request is at its limit whatever its windows read.
  expect(planLevel(40, true)).toBe("limited");
  expect(PLAN_TONE).toEqual({ ok: "ink", almost: "warn", critical: "danger", limited: "danger" });
  const levels = (el: Element) =>
    [...el.querySelectorAll(".ac-planmeter__window")].map((li) => li.getAttribute("data-level"));
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 96 },
      { kind: "seven_day", usedPercent: 85 },
      { kind: "monthly", usedPercent: 20 },
    ],
    at: at(0),
  };
  const meter = render(<PlanMeter usage={usage} text={text} now={NOW} />).container.querySelector(".ac-planmeter");
  expect(meter?.getAttribute("data-level")).toBe("critical");
  expect(levels(meter as Element)).toEqual(["critical", "almost", "ok"]);
  cleanup();
  // Refused at 40%: red words over ink bars.
  const refused = render(
    <PlanMeter
      usage={{ windows: [{ kind: "five_hour", usedPercent: 40 }], limited: true, at: at(0) }}
      text={text}
      now={NOW}
    />,
  ).container.querySelector(".ac-planmeter");
  expect(refused?.getAttribute("data-level")).toBe("limited");
  expect(levels(refused as Element)).toEqual(["ok"]);
  cleanup();
  // Compact: its one bar and its words by the tightest window.
  const compact = render(
    <PlanMeter
      usage={{
        windows: [
          { kind: "seven_day", usedPercent: 85 },
          { kind: "five_hour", usedPercent: 10 },
        ],
        at: at(0),
      }}
      text={text}
      now={NOW}
      compact
    />,
  ).container.querySelector(".ac-planmeter--compact");
  expect(compact?.getAttribute("data-level")).toBe("almost");
});

test("a window whose reset already passed is empty again, and the limit with it", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 100, resetsAt: at(-HOUR) },
      { kind: "seven_day", usedPercent: 70, resetsAt: at(24 * HOUR) },
    ],
    limited: true,
    at: at(-2 * HOUR),
  };
  expect(planWindows(usage, NOW).map((w) => [w.kind, w.used])).toEqual([
    ["seven_day", 70],
    ["five_hour", 0],
  ]);
  expect(planState(usage, NOW).state).toBe("ok");
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} />);
  expect(rows(container)[1]).toEqual(["5 horas", "0%", null]);
});

test("compact: the two tightest windows in one line after the account's name, one bar for the fullest, every window on hover", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 12, resetsAt: at(2 * HOUR) },
      { kind: "seven_day", usedPercent: 40, resetsAt: at(48 * HOUR) },
      { kind: "other", label: "Fable", usedPercent: 3 },
    ],
    at: at(0),
  };
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} compact label="Claude Team" />);
  const el = container.querySelector(".ac-planmeter--compact") as HTMLElement;
  expect(el.querySelector(".ac-planmeter__line")?.textContent).toBe("Claude Team · semana 40% · 5h 12%");
  const meters = [...el.querySelectorAll("[role=meter]")];
  expect(meters.map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
    ["Semana", "40"],
  ]);
  expect(el.title).toBe("Semana 40% · renova 12:00\n5 horas 12% · renova 14:00\nFable 3%");
  // Far from the limit: no state line, no reset, no age.
  expect(el.dataset.state).toBe("ok");
  expect(el.querySelector(".ac-planmeter__state")).toBeNull();
  expect(el.querySelector(".ac-planmeter__at")).toBeNull();
  expect(el.querySelector(".ac-planmeter__window")).toBeNull();
  cleanup();
  // Where the name is the row's own title (Contas de IA): the windows alone.
  const bare = render(<PlanMeter usage={usage} text={text} now={NOW} compact />).container;
  expect(bare.querySelector(".ac-planmeter__line")?.textContent).toBe("semana 40% · 5h 12%");
});

test("compact near the limit says when it renews, and at the limit until when", () => {
  const almost = render(
    <PlanMeter
      usage={{
        windows: [
          { kind: "seven_day", usedPercent: 91, resetsAt: at(HOUR) },
          { kind: "five_hour", usedPercent: 20 },
        ],
        at: at(0),
      }}
      text={text}
      now={NOW}
      compact
    />,
  ).container;
  expect(almost.querySelector(".ac-planmeter__line")?.textContent).toBe("semana 91% · 5h 20%");
  expect(almost.querySelector(".ac-planmeter__state")?.textContent).toBe("Quase no limite · renova 13:00");
  cleanup();
  const full = render(
    <PlanMeter
      usage={{ windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: at(HOUR) }], limited: true, at: at(0) }}
      text={text}
      now={NOW}
      compact
    />,
  ).container;
  expect(full.querySelector(".ac-planmeter")?.getAttribute("data-state")).toBe("limited");
  expect(full.querySelector(".ac-planmeter__state")?.textContent).toBe("No limite até 13:00");
});

test("compact says how old its numbers are from 10 minutes, and out of date past 6 hours", () => {
  const read = (ago: number) =>
    render(
      <PlanMeter
        usage={{ windows: [{ kind: "five_hour", usedPercent: 30 }], at: at(-ago) }}
        text={text}
        now={NOW}
        compact
      />,
    ).container.querySelector(".ac-planmeter--compact") as HTMLElement;
  expect(read(9 * 60_000).querySelector(".ac-planmeter__line")?.textContent).toBe("5h 30%");
  cleanup();
  const old = read(51 * 60_000);
  expect(old.querySelector(".ac-planmeter__line")?.textContent).toBe("5h 30% · atualizado 11:09");
  expect(old.dataset.stale).toBeUndefined();
  cleanup();
  const stale = read(7 * HOUR);
  expect(stale.querySelector(".ac-planmeter__line")?.textContent).toBe("5h 30% · números antigos, de 05:00");
  expect(stale.dataset.stale).toBe("true");
  expect(planLine({ windows: [{ kind: "five_hour", usedPercent: 30 }], at: at(-6 * HOUR) }, text, NOW)).toMatchObject({
    stale: false,
    age: "atualizado 06:00",
  });
});

test("compact with no window known yet shows nothing, never 0%", () => {
  const unknown: PlanMeterUsage = { windows: [], at: at(0) };
  expect(planLine(unknown, text, NOW)).toBeNull();
  const { container } = render(<PlanMeter usage={unknown} text={text} now={NOW} compact label="Claude Max" />);
  expect(container.textContent).toBe("");
});

test("compact: a plan that refused a request before any window was known says it is at the limit, with no bar", () => {
  const refused: PlanMeterUsage = { windows: [], limited: true, at: at(0) };
  expect(planLine(refused, text, NOW)).toMatchObject({ state: "limited", line: "", alert: "No limite" });
  const { container } = render(<PlanMeter usage={refused} text={text} now={NOW} compact label="Claude Max" />);
  const el = container.querySelector(".ac-planmeter--compact") as HTMLElement;
  expect(el.dataset.state).toBe("limited");
  expect(el.querySelector(".ac-planmeter__line")?.textContent).toBe("Claude Max");
  expect(el.querySelector(".ac-planmeter__state")?.textContent).toBe("No limite");
  expect(el.querySelector("[role=meter]")).toBeNull();
  cleanup();
  // Without the account's name (Contas de IA): the state alone.
  const bare = render(<PlanMeter usage={refused} text={text} now={NOW} compact />).container;
  expect(bare.querySelector(".ac-planmeter__line")).toBeNull();
  expect(bare.textContent).toBe("No limite");
});

test("an agent's part: in full ink inside its window's bar, with its words; none once the window reset", () => {
  const usage: PlanMeterUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 60, resetsAt: at(HOUR), part: 45, note: "Ada ≈ 45%" },
      { kind: "seven_day", usedPercent: 50, resetsAt: at(-HOUR), part: 20, note: "Ada ≈ 20%" },
    ],
    at: at(0),
  };
  const { container } = render(<PlanMeter usage={usage} text={text} now={NOW} />);
  const [hours, week] = [...container.querySelectorAll(".ac-planmeter__window")];
  expect(hours?.querySelector(".ac-meter--parts .ac-meter__part")?.getAttribute("style")).toContain("width: 45%");
  expect(hours?.querySelector(".ac-planmeter__note")?.textContent).toBe("Ada ≈ 45%");
  expect(week?.querySelector(".ac-meter__part")).toBeNull();
  expect(week?.querySelector(".ac-planmeter__note")).toBeNull();
});

test("at the limit, the owner's other free accounts of the same kind and maker, most headroom first", () => {
  const usage = (used: number): PlanMeterUsage => ({
    windows: [{ kind: "five_hour", usedPercent: used, resetsAt: at(HOUR) }],
    at: at(0),
  });
  const account = (id: string, over: Partial<OfferAccount> = {}): OfferAccount => ({
    id,
    kind: "claude_code",
    provider: null,
    mine: true,
    status: "active",
    usedBy: [],
    usage: null,
    ...over,
  });
  const accounts = [
    account("now", { usage: usage(100), usedBy: ["Dev"] }),
    account("busy", { usage: usage(10) }),
    account("unknown"),
    account("calm", { usage: usage(5) }),
    account("full", { usage: usage(100) }),
    account("theirs", { mine: false, usage: usage(0) }),
    account("taken", { usedBy: ["Infra"], usage: usage(0) }),
    account("out", { status: "signed_out", usage: usage(0) }),
    account("codex", { kind: "codex", usage: usage(0) }),
    account("glm", { provider: "zai", usage: usage(0) }),
  ];
  expect(limitOffers(accounts, "claude_code", "now", NOW).map((o) => [o.account.id, o.used])).toEqual([
    ["calm", 5],
    ["busy", 10],
    ["unknown", null],
  ]);
  // A coding plan offers only that maker's other keys.
  expect(limitOffers([...accounts, account("glm2")], "claude_code", "glm", NOW)).toEqual([]);
  // One made for all of the owner's agents there is offered though another agent thinks with it.
  const all = account("all", { usedBy: ["Infra"], usage: usage(1), shared: true });
  expect(limitOffers([...accounts, all], "claude_code", "now", NOW)[0]?.account.id).toBe("all");
});
