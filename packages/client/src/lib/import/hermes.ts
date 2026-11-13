import {
  baseName,
  cronTrigger,
  type Draft,
  everyMinutes,
  type ImportFile,
  jsonOf,
  list,
  num,
  obj,
  slug,
  str,
  type Trigger,
  templateHash,
  yamlOf,
} from "./shared";

/**
 * Hermes Agent (github.com/NousResearch/hermes-agent, MIT): one profile is one
 * agent. A profile export (`hermes profile export`, a .tar.gz whose root
 * folder is the profile's name), a profile distribution (a repo with
 * `distribution.yaml`), or ~/.hermes itself with `profiles/<name>/`
 * (`website/docs/user-guide/profile-distributions.md`, `hermes_cli/profiles.py`):
 * config.yaml (model, mcp_servers), SOUL.md, memories/MEMORY.md and USER.md
 * (entries split by §), skills/<category>/<skill>/SKILL.md, cron/jobs.json,
 * profile.yaml (display name, description), mcp.json.
 */

/** `templateHash` of the SOUL.md Hermes seeds, now and before (DEFAULT_SOUL_MD, _LEGACY_TEMPLATE_SOULS in hermes_cli/default_soul.py). */
const SEEDED_SOULS = new Set([
  "36c1f5a2e92cd1d018311eaf4c8f1e8886672eae78212e033c681d0e3d5d506f",
  "82fa3438d86f8b95c6e96be89d853c8b561b3e6973ed61c90e70e0231dd24a7e",
  "6bc146a50e8fe3bd555e89a77e93af1f781cece8cf549f0d7a02ee2389811c72",
  "2765a846e1bb371d78d3b93b403dfb0f8d1ba1a9895edb5f608367abfe81194d",
  "731f9a403cdc6a5c5c0e5c956a9238f54dae8b6e253bc29f9e47efb38eb6081a",
]);

const at = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isProfile = (files: ImportFile[], dir: string) => {
  const names = new Set(files.map((f) => f.name));
  return (
    names.has(at(dir, "distribution.yaml")) || (names.has(at(dir, "SOUL.md")) && names.has(at(dir, "config.yaml")))
  );
};

export const detect = (files: ImportFile[]) => isProfile(files, "");

export function parse(files: ImportFile[], d: Draft) {
  const named = [
    ...new Set(files.map((f) => /^profiles\/([^/]+)\//.exec(f.name)?.[1]).filter((n): n is string => !!n)),
  ].filter((n) => isProfile(files, `profiles/${n}`));
  for (const dir of ["", ...named.map((n) => `profiles/${n}`)]) profile(dir, d);
  const [only] = d.agents;
  d.name = d.agents.length === 1 && only ? only.name : d.options.root || "Hermes";
  d.ref = slug(d.options.root ?? "") || (only ? only.key : "hermes");
}

function profile(dir: string, d: Draft) {
  const read = (name: string) => d.file(at(dir, name));
  const yaml = (name: string) => {
    const file = read(name);
    return file ? (yamlOf(file) ?? {}) : {};
  };
  const dist = yaml("distribution.yaml");
  const meta = yaml("profile.yaml");
  const config = yaml("config.yaml");
  const id = dir ? baseName(dir) : (d.options.root ?? "");
  // The root profile of ~/.hermes is the default one: its folder's name (".hermes") is no agent's.
  const named = id && id !== "default" && !id.startsWith(".");
  const name =
    str(meta.display_name) ||
    str(obj(obj(meta.ui_meta)["hermes-bots"]).title) ||
    str(dist.name) ||
    (named ? id : "Hermes");
  const key = slug(id && id !== "default" ? id : name) || "hermes";
  const soul = read("SOUL.md")?.text ?? "";
  const model = config.model;
  d.agent({
    key,
    name,
    role: str(meta.description) || str(dist.description),
    instructions: SEEDED_SOULS.has(templateHash(soul)) ? "" : soul,
    model: str(model) || str(obj(model).default) || str(obj(model).model) || undefined,
    skills: d.skillsUnder(at(dir, "skills")),
  });

  // The default profile's export keeps MEMORY.md and USER.md at its root.
  for (const [file, kind] of [
    ["memories/MEMORY.md", "note"],
    ["MEMORY.md", "note"],
    ["memories/USER.md", "preference"],
    ["USER.md", "preference"],
  ] as const) {
    const text = read(file)?.text ?? "";
    text.split("§").forEach((entry, i) => {
      d.note({ key: `${key}/${file}#${i + 1}`, agent: key, kind, content: entry });
    });
  }

  const mcpJson = read("mcp.json");
  const servers = { ...obj(config.mcp_servers), ...obj(mcpJson ? jsonOf(mcpJson)?.mcpServers : undefined) };
  for (const [server, spec] of Object.entries(servers)) {
    d.connection(server, str(obj(spec).url), [key]);
  }
  for (const env of list(dist.env_requires).map(obj)) d.need("secret", str(env.name), [key]);

  const cron = read("cron/jobs.json");
  const jobs = cron ? list(obj(jsonOf(cron)).jobs).map(obj) : [];
  const agent = d.agents.find((a) => a.key === key);
  for (const job of jobs) {
    const title = str(job.name) || str(job.id);
    const skills = list(job.skills)
      .map(str)
      .filter((s) => d.skills.some((k) => k.key === s));
    if (agent) agent.skills = [...new Set([...agent.skills, ...skills])];
    d.routine({
      key: `${key}/${str(job.id) || slug(title)}`,
      name: title,
      agent: key,
      // A script-only job runs code on the machine; there is no prompt to bring.
      prompt: str(job.prompt),
      trigger: schedule(obj(job.schedule)),
      label: `${title} (${name})`,
    });
  }
}

/** cron/jobs.py `parse_schedule`: `{kind: cron, expr}`, `{kind: interval, minutes}` or `{kind: once, run_at}`. */
function schedule(s: Record<string, unknown>): Trigger | null {
  if (s.kind === "cron") return cronTrigger(str(s.expr), null);
  if (s.kind === "interval") return everyMinutes(num(s.minutes) ?? 0);
  const at = Date.parse(str(s.run_at));
  return s.kind === "once" && !Number.isNaN(at) ? { at: new Date(at).toISOString() } : null;
}
