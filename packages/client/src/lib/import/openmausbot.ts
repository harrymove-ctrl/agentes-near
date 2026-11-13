import type { AgentColor } from "@agenteschat/tokens/look";
import {
  atTime,
  baseName,
  cronTrigger,
  type Draft,
  dirName,
  everyMinutes,
  first,
  frontmatter,
  ImportError,
  type ImportFile,
  join,
  jsonOf,
  list,
  num,
  obj,
  resolvePath,
  section,
  slug,
  str,
  type Trigger,
  yamlOf,
} from "./shared";

/**
 * OpenMausBot (github.com/milind-soni/OpenMausBot, Apache-2.0):
 * - the team package from "Share team…", `openmaus.package` version 2
 *   (`<team>-<version>.openmaus.json`), or version 1 (the same JSON, or the
 *   BotMRR Markdown playbook: YAML frontmatter with `botmrr: 1`). Format:
 *   `shared/package-format.ts`, `docs/team-sharing.md`. Never holds keys,
 *   model choices or chat history.
 * - the headless team file (`openmausbot team export`, `version: 1`, YAML or
 *   JSON): `server/headless/team-file.ts`, `docs/headless-cli.md`. Engine keys
 *   are `{ env: NAME }` or `{ file: PATH }` and are never read.
 * - the Grok Bot reply to its export prompt, `openmaus.grok/1` (or
 *   `grokbot-bundle/v1`), pasted fenced or bare: `shared/grok-import.ts`.
 */

const PACKAGE_FORMAT = "openmaus.package";
const GROK_FORMATS = ["openmaus.grok/1", "grokbot-bundle/v1"];
const TEAM_FILE_KEYS = new Set(["version", "engines", "defaults", "teams", "bots", "rooms"]);

/** OpenMausBot's colors (package-format.ts COLORS) in our palette. */
const MAUS_COLORS: Record<string, AgentColor> = {
  green: "green",
  blue: "indigo",
  red: "rose",
  orange: "amber",
  purple: "violet",
  cyan: "sky",
  pink: "rose",
  yellow: "amber",
  teal: "teal",
  coral: "rose",
};

type Found =
  | { kind: "package"; file: ImportFile; pkg: Record<string, unknown> }
  | { kind: "team" | "grok"; file: ImportFile; doc: Record<string, unknown> };

const isTeamFile = (doc: Record<string, unknown> | null): doc is Record<string, unknown> =>
  doc !== null &&
  doc.version === 1 &&
  list(doc.bots).length > 0 &&
  list(doc.bots).every((b) => str(obj(b).name)) &&
  Object.keys(doc).every((k) => TEAM_FILE_KEYS.has(k));

function find(file: ImportFile): Found | null {
  const json = jsonOf(file);
  if (json) {
    if (json.format === PACKAGE_FORMAT) {
      if (typeof json.version !== "number") return null;
      if (json.version > 2) throw new ImportError("newerVersion");
      return { kind: "package", file, pkg: obj(json.package) };
    }
    if (GROK_FORMATS.includes(str(json.format))) return { kind: "grok", file, doc: json };
    return isTeamFile(json) ? { kind: "team", file, doc: json } : null;
  }
  if (/\.ya?ml$/i.test(file.name)) {
    const doc = yamlOf(file);
    return isTeamFile(doc) ? { kind: "team", file, doc } : null;
  }
  const fm = frontmatter(file.text);
  if (!fm || fm.data.botmrr === undefined) return null;
  if (fm.data.botmrr !== 1) throw new ImportError("newerVersion");
  const { botmrr: _version, ...pkg } = fm.data;
  return { kind: "package", file, pkg };
}

export const detect = (files: ImportFile[]) => files.some((f) => find(f) !== null);

export function parse(files: ImportFile[], d: Draft) {
  let found: Found | null = null;
  for (const file of files) {
    found = find(file);
    if (found) break;
  }
  if (!found) throw new ImportError("unknown");
  d.used.add(found.file.name);
  if (found.kind === "package") fromPackage(found.pkg, d);
  else if (found.kind === "team") fromTeamFile(found.doc, found.file, d);
  else fromGrok(found.doc, d);
}

function fromPackage(pkg: Record<string, unknown>, d: Draft) {
  const team = obj(pkg.team);
  d.name = str(team.name) || str(pkg.name);
  d.ref = str(pkg.id);
  const brief = str(team.brief);
  const playbooks = new Map(
    list(pkg.playbooks)
      .map(obj)
      .map((p) => [str(p.key), p] as const),
  );
  const skills = new Map<string, string>();
  for (const s of list(obj(pkg.skills).entries).map(obj)) {
    const key = d.skill(str(s.instructions), str(s.name), str(s.description));
    if (key) skills.set(str(s.name), key);
  }

  const names = new Map<string, string>();
  const connectionUsers = new Map<string, string[]>();
  for (const raw of list(pkg.agents).map(obj)) {
    const key = str(raw.key);
    const name = str(raw.name);
    if (!key || !name) continue;
    names.set(key, name);
    const appearance = obj(raw.appearance);
    const own = list(raw.playbooks)
      .map((k) => playbooks.get(str(k)))
      .filter((p): p is Record<string, unknown> => p !== undefined);
    d.agent({
      key,
      name,
      role: str(raw.title),
      // The soul (or the description), its playbooks, then the team's shared instructions.
      instructions: join([
        str(raw.soul) || str(raw.description),
        ...own.map((p) => section(str(p.name), [str(p.summary), str(p.instructions)])),
        brief ? section(d.name, [brief]) : "",
      ]),
      color: MAUS_COLORS[str(appearance.color)],
      skills: list(raw.skills)
        .map(str)
        .flatMap((n) => {
          const k = skills.get(n);
          if (!k) d.left("skill", n);
          return k ? [k] : [];
        }),
    });
    if (obj(appearance.avatar).data) d.left("picture", name);
    for (const c of list(raw.connections).map(str)) connectionUsers.set(c, [...(connectionUsers.get(c) ?? []), key]);
    for (const [path, text] of Object.entries(obj(obj(raw.seed).memory))) {
      d.note({ key: `${key}/${path}`, agent: key, kind: "note", content: str(text) });
    }
  }

  for (const room of list(pkg.rooms).map(obj)) {
    const key = str(room.key);
    const members = list(room.members)
      .map(str)
      .filter((k) => names.has(k));
    const responder = obj(room.defaultResponder);
    const kind = str(responder.kind);
    // Everyone or Auto: every member may answer; one agent: only the lead; mentions: nobody unasked.
    const lead =
      kind === "agent" ? str(responder.agent) : ["everyone", "auto", "mentions"].includes(kind) ? "" : members[0];
    d.channel({
      key,
      name: str(room.name) || key,
      topic: str(room.bulletin),
      agents: members.map((k) => ({ key: k, autoReply: kind === "everyone" || kind === "auto" || k === lead })),
    });
  }

  for (const r of list(pkg.routines).map(obj)) {
    const name = str(r.name) || str(r.key);
    const owner = names.get(str(r.agent));
    d.routine({
      key: str(r.key),
      name,
      agent: owner ? str(r.agent) : "",
      prompt: str(r.prompt),
      channel: str(r.room) || null,
      trigger: schedule(obj(r.schedule)),
      label: owner ? `${name} (${owner})` : name,
    });
  }

  for (const c of list(pkg.connections).map(obj)) {
    const mcp = obj(c.mcp);
    d.connection(str(c.label) || str(c.key), str(mcp.url), connectionUsers.get(str(c.key)) ?? []);
  }
  for (const app of list(obj(pkg.requirements).apps).map(obj)) d.need("app", str(app.label) || str(app.slug));
  for (const preset of list(pkg.presets).map(obj)) d.left("preset", str(preset.name));
}

/** package-format.ts `packageRoutineScheduleSchema`: weekdays are 0 (Sunday) to 6, instants epoch ms. */
function schedule(s: Record<string, unknown>): Trigger | null {
  switch (str(s.type)) {
    case "cron":
      return cronTrigger(str(s.expression), str(s.timeZone) || null);
    case "once": {
      const at = new Date(num(s.at) ?? Number.NaN);
      return Number.isNaN(at.getTime()) ? null : { at: at.toISOString() };
    }
    case "daily":
      return atTime(str(s.time), null, list(s.weekdays).map(Number));
    case "interval": {
      const every = num(s.everyMinutes) ?? 0;
      const days = list(s.weekdays).map(Number);
      const span = obj(s.window);
      if (days.length === 0 && !str(span.start)) return everyMinutes(every, num(s.anchorAt));
      // Weekdays and a window are local wall-clock times: a cadence that divides an hour, a window on the hour.
      const from = /^(\d{2}):00$/.exec(str(span.start));
      const to = /^(\d{2}):00$/.exec(str(span.end));
      if (every < 1 || every >= 60 || 60 % every !== 0 || (str(span.start) && !(from && to))) return null;
      const hours = from && to ? `${Number(from[1])}-${Number(to[1]) - 1}` : "*";
      const dow = days.length > 0 && days.length < 7 ? [...new Set(days)].sort((a, b) => a - b).join(",") : "*";
      return cronTrigger(`*/${every} ${hours} * * ${dow}`, null);
    }
    default:
      return null;
  }
}

/** `openmausbot team export`: bots, teams and rooms by name; souls, briefs and skills may be files beside it. */
function fromTeamFile(doc: Record<string, unknown>, file: ImportFile, d: Draft) {
  const dir = dirName(file.name);
  const read = (value: unknown): string => {
    if (typeof value === "string") return value.trim();
    const path = str(obj(value).file);
    if (!path) return "";
    const found = d.file(resolvePath(dir, path));
    if (!found?.text) d.left("file", path);
    return found?.text.trim() ?? "";
  };
  const teams = list(doc.teams).map(obj);
  const teamNamed = (name: string) => teams.find((t) => name && str(t.name).toLowerCase() === name.toLowerCase());
  d.name = teams.length === 1 ? str(teams[0]?.name) : "";
  d.ref = slug(baseName(file.name).replace(/\.[^.]+$/, ""));

  const defaults = obj(doc.defaults);
  const keys = new Map<string, string>();
  for (const raw of list(doc.bots).map(obj)) {
    const bot = { ...defaults, ...raw };
    const name = str(bot.name);
    const base = slug(name) || "bot";
    let key = base;
    for (let n = 2; [...keys.values()].includes(key); n++) key = `${base}-${n}`;
    keys.set(name.toLowerCase(), key);
    const team = teamNamed(str(bot.team));
    const brief = team ? read(team.brief) : "";
    const skills = list(bot.skills)
      .map(obj)
      .flatMap((s) => {
        const path = str(s.file);
        const found = d.file(resolvePath(dir, path));
        if (!found?.text) {
          d.left("skill", path);
          return [];
        }
        const k = d.skill(found.text, baseName(dirName(path)) || path);
        return k && s.enabled !== false ? [k] : [];
      });
    d.agent({
      key,
      name,
      role: str(bot.title),
      instructions: join([read(bot.soul) || str(bot.description), brief ? section(str(team?.name), [brief]) : ""]),
      model: bot.model,
      skills,
    });
  }

  for (const room of list(doc.rooms).map(obj)) {
    const name = str(room.name);
    const members = list(room.members)
      .map((m) => keys.get(str(m).toLowerCase()))
      .filter((k): k is string => k !== undefined);
    const responder = str(room.responder).toLowerCase();
    // A room without a responder answers through its first member, as OpenMausBot does.
    const lead = responder ? keys.get(responder) : members[0];
    d.channel({
      key: slug(name) || "room",
      name,
      topic: read(room.brief),
      agents: members.map((k) => ({ key: k, autoReply: responder === "everyone" || k === lead })),
    });
  }

  // Keys stay where they are ({ env: NAME } or { file: PATH }): only what to add here is listed.
  for (const [engine, spec] of Object.entries(obj(doc.engines))) {
    for (const field of ["key", "baseUrl"]) {
      const ref = obj(obj(spec)[field]);
      if (str(ref.env)) d.need("secret", str(ref.env));
      else if (str(ref.file)) d.need("secret", `${engine} ${field}`);
    }
  }
}

/** One Grok Bot, as its reply to OpenMausBot's export prompt describes it. */
function fromGrok(root: Record<string, unknown>, d: Draft) {
  const persona = obj(root.persona);
  const name = first(root.name, persona.name, root.botName) || "Grok Bot";
  const key = slug(name) || "grok-bot";
  d.name = name;
  d.ref = `grok:${key}`;
  const skills = list(root.skills).flatMap((s) => {
    if (typeof s === "string") {
      d.left("skill", s);
      return [];
    }
    const o = obj(s);
    const k = d.skill(
      first(o.body, o.instructions, o.content, o.text),
      first(o.name, o.title),
      first(o.description, o.summary),
    );
    return k ? [k] : [];
  });
  d.agent({
    key,
    name,
    role: first(root.title, persona.title),
    instructions:
      first(root.instructions, root.soul, root.systemPrompt, persona.instructions, persona.description) ||
      str(root.description),
    skills,
  });
  for (const r of list(root.routines).map(obj)) {
    const title = first(r.name, r.title);
    const cron = first(r.cron, r.cronExpression);
    d.routine({
      key: slug(title),
      name: title,
      agent: key,
      prompt: first(r.prompt, r.instructions, r.task),
      // A routine that starts on an event has no cron: it stays behind, with its description.
      trigger: cron ? cronTrigger(cron, first(r.timeZone, r.timezone, r.tz) || null) : null,
      label: [title, first(r.schedule, r.when, r.trigger)].filter(Boolean).join(" · "),
    });
  }
  for (const p of list(root.plugins ?? root.apps ?? root.integrations)) {
    d.need("app", typeof p === "string" ? p : first(obj(p).name, obj(p).label, obj(p).id, obj(p).slug), [key]);
  }
  list(root.memories).forEach((m, i) => {
    d.note({ key: `${key}/memory-${i + 1}`, agent: key, kind: "fact", content: first(m, obj(m).text, obj(m).content) });
  });
}
