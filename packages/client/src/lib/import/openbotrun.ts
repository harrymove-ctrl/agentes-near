import {
  atTime,
  baseName,
  cronOf,
  cronTrigger,
  type Draft,
  everyMinutes,
  ImportError,
  type ImportFile,
  join,
  jsonOf,
  list,
  num,
  obj,
  onceAt,
  slug,
  str,
  type Trigger,
} from "./shared";

/**
 * OpenBot.run (Synthetify Labs, github.com/nightly-labs/openbot), read from
 * its documented formats only:
 * - `openbot-import.json` (`openbot-agent-import` v1), the archive "Migrator
 *   by OpenBot" writes for Grok Bot users (its skill:
 *   `resources/agent-import/grok-bot/SKILL.md`): agents with instructions,
 *   skill folders, routines and memories; group chats; optional files.
 * - `openbot-transfer.json` (`openbot-instance-transfer` v1), a server's
 *   transfer file (`docs/architecture/agents.md`, "Instance transfer"): the
 *   same per agent plus its model, and the server's MCP servers with every
 *   value already emptied.
 * Agent paths are always inside `agents/<key>/`.
 */

const IMPORT = "openbot-agent-import";
const TRANSFER = "openbot-instance-transfer";
const APPS: Record<string, string> = { "grok-bot": "Grok Bot" };

function manifest(files: ImportFile[]) {
  for (const file of files) {
    const doc = jsonOf(file);
    if (doc && (doc.format === IMPORT || doc.format === TRANSFER)) return { file, doc };
  }
  return null;
}

export const detect = (files: ImportFile[]) => manifest(files) !== null;

export function parse(files: ImportFile[], d: Draft) {
  const found = manifest(files);
  if (!found) throw new ImportError("unknown");
  const { file, doc } = found;
  if (doc.version !== 1) throw new ImportError("newerVersion");
  d.used.add(file.name);
  const source = obj(doc.source);
  const app = str(source.app);
  d.name = APPS[app] ?? app;
  d.ref = app || "openbot";
  const transfer = doc.format === TRANSFER;

  const names = new Map<string, string>();
  for (const a of list(doc.agents).map(obj)) {
    const key = str(a.key);
    const name = str(a.name) || key;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(key)) continue;
    names.set(key, name);
    const folder = (path: unknown) => {
      const p = str(path).replace(/\/+$/, "");
      return p.startsWith(`agents/${key}/`) ? p : "";
    };
    // Instructions longer than the manifest allows are written whole to files/INSTRUCTIONS.md.
    const files = folder(a.files);
    const full = files ? d.file(`${files}/INSTRUCTIONS.md`)?.text : undefined;
    const skills = list(a.skills).flatMap((path) => {
      const k = d.skillDir(folder(path), baseName(str(path)) || str(path));
      return k ? [k] : [];
    });
    d.agent({
      key,
      name,
      role: str(a.title),
      instructions: full?.trim() || str(a.description),
      ...(transfer ? { model: [str(a.provider), str(a.model)].filter(Boolean).join("/") } : {}),
      seed: str(a.avatarSeed) || key,
      skills,
    });
    if (folder(a.avatar)) {
      d.used.add(folder(a.avatar));
      d.left("picture", name);
    }
    // The rest of the folder is the agent's own files: they can go to its folder in the Drive.
    if (files) d.filesIn(key, files);
    for (const r of [...list(a.routines), ...list(a.oneTimeRoutines)].map(obj)) routine(r, key, null, name, d);
    list(a.memories).forEach((m, i) => {
      d.note({ key: `${key}/memory-${i + 1}`, agent: key, kind: "fact", content: str(m) || str(obj(m).text) });
    });
  }

  for (const c of list(doc.channels).map(obj)) {
    const key = str(c.key);
    const members = list(c.members)
      .map(str)
      .filter((k) => names.has(k));
    if (!key || members.length === 0) continue;
    const lead = members.includes(str(c.lead)) ? str(c.lead) : "";
    // A group chat with a lead answers through it; without one, every member may answer.
    d.channel({
      key,
      name: str(c.name) || key,
      topic: join([str(c.title), str(c.instructions)]),
      agents: members.map((k) => ({ key: k, autoReply: !lead || k === lead })),
    });
    for (const r of list(c.routines).map(obj)) routine(r, lead || (members[0] as string), key, str(c.name) || key, d);
    list(c.memories).forEach((m, i) => {
      d.note({ key: `${key}/memory-${i + 1}`, agent: null, kind: "fact", content: str(m) });
    });
  }

  const settings = obj(doc.settings);
  for (const server of list(settings.mcpServers).map(obj)) {
    const http = str(server.transport) === "http";
    d.connection(str(server.name) || str(server.id), http ? str(server.url) : "");
  }
  for (const p of list(settings.customProviders).map(obj)) d.left("model", str(p.name) || str(p.id));
  for (const a of list(settings.customAgents).map(obj)) d.left("remote", str(a.name) || str(a.id));
  for (const f of list(settings.routineFlows).map(obj)) {
    d.left(
      "routine",
      `${names.get(str(f.fromAgentKey)) ?? str(f.fromAgentKey)} → ${names.get(str(f.toAgentKey)) ?? str(f.toAgentKey)}`,
    );
  }
}

function routine(r: Record<string, unknown>, agent: string, channel: string | null, owner: string, d: Draft) {
  const name = str(r.name);
  d.routine({
    key: `${channel ?? agent}/${str(r.key) || slug(name)}`,
    name,
    agent,
    prompt: str(r.instruction),
    channel,
    trigger: schedule(obj(r.schedule), str(r.timezone) || null),
    label: `${name} (${owner})`,
  });
}

/** `RoutineSchedule` (packages/contracts/src/ipc-routines.ts): times "HH:MM" in the routine's zone, weekdays 0 = Sunday. */
function schedule(s: Record<string, unknown>, timezone: string | null): Trigger | null {
  const time = str(s.time);
  switch (str(s.kind)) {
    case "hourly":
      return cronTrigger(`${num(s.minute) ?? 0} * * * *`, timezone);
    case "daily":
      return atTime(time, timezone);
    case "weekdays":
      return atTime(time, timezone, [1, 2, 3, 4, 5]);
    case "weekly": {
      const day = num(s.weekday) ?? -1;
      return day >= 0 && day <= 6 ? atTime(time, timezone, [day]) : null;
    }
    case "monthly": {
      const day = num(s.day) ?? 0;
      return day >= 1 && day <= 31 ? atTime(time, timezone, [], [day]) : null;
    }
    case "interval": {
      const unit = { minutes: 1, hours: 60, days: 1440 }[str(s.unit)] ?? 0;
      const anchor = Date.parse(str(s.anchorAt));
      return everyMinutes((num(s.amount) ?? 0) * unit, Number.isNaN(anchor) ? null : anchor);
    }
    case "custom":
      return cronTrigger(str(s.expression), timezone);
    case "once":
      return onceAt(str(s.date), time, timezone);
    case "advanced":
      return advanced(s, timezone);
    default:
      return null;
  }
}

function advanced(s: Record<string, unknown>, timezone: string | null): Trigger | null {
  const months = list(s.months).map(Number);
  const days = obj(s.days);
  const t = obj(s.time);
  const picked = list(days.days).map(Number).join(",");
  const [dom, dow] =
    str(days.kind) === "days-of-week" ? ["*", picked] : str(days.kind) === "days-of-month" ? [picked, "*"] : ["*", "*"];
  const month = months.length && months.length < 12 ? months.join(",") : "*";
  let clock = "";
  if (str(t.kind) === "at-time") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(str(t.time));
    if (m) clock = `${Number(m[2])} ${Number(m[1])}`;
  } else if (str(t.kind) === "every") {
    const n = num(t.amount) ?? 0;
    if (str(t.unit) === "minutes" && n > 0 && n < 60 && 60 % n === 0) clock = `*/${n} *`;
    if (str(t.unit) === "hours" && n > 0 && n < 24 && 24 % n === 0) clock = `0 */${n}`;
  }
  const cron = clock && dom && dow ? cronOf(`${clock} ${dom} ${month} ${dow}`) : null;
  return cron ? { cron, timezone } : null;
}
