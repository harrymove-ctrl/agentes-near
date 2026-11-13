import {
  cronTrigger,
  type Draft,
  dirName,
  everyMinutes,
  frontmatter,
  type ImportFile,
  join,
  list,
  num,
  obj,
  section,
  slug,
  str,
  yamlOf,
} from "./shared";

/**
 * Paperclip (github.com/paperclipai/paperclip, MIT): an Agent Companies
 * package (`agentcompanies/v1`, docs/companies/companies-spec.md): COMPANY.md;
 * agents/<slug>/AGENTS.md (or AGENT.md) with frontmatter, the body being the
 * instructions, beside SOUL.md, HEARTBEAT.md and TOOLS.md; skills/<slug>/SKILL.md;
 * tasks/<slug>/TASK.md (a recurring one is a routine); projects and teams; and
 * the vendor sidecar .paperclip.yaml (models, secret inputs, routine triggers,
 * heartbeat).
 */

const AGENT_FILE = /^agents\/([^/]+)\/AGENTS?\.md$/;
const TASK_FILE = /^(?:projects\/[^/]+\/)?tasks\/([^/]+)\/TASK\.md$/;

export const detect = (files: ImportFile[]) =>
  files.some(
    (f) =>
      f.name === ".paperclip.yaml" ||
      ((f.name === "COMPANY.md" || AGENT_FILE.test(f.name)) && frontmatter(f.text) !== null),
  );

export function parse(files: ImportFile[], d: Draft) {
  const company = d.file("COMPANY.md");
  const head = company ? frontmatter(company.text) : null;
  const sidecar = d.file(".paperclip.yaml");
  const vendor = sidecar ? (yamlOf(sidecar) ?? {}) : {};
  const info = head?.data ?? {};
  d.name = str(info.name) || d.options.root || "Paperclip";
  d.ref = str(info.slug) || slug(d.name);

  // A bare skill name resolves to skills/<name>/SKILL.md, or a skill declaring that name.
  const skillKeys = new Map<string, string>();
  for (const dir of [
    ...new Set(files.filter((f) => /^skills\/.+\/SKILL\.md$/.test(f.name)).map((f) => dirName(f.name))),
  ]) {
    const key = d.skillDir(dir);
    if (key) {
      skillKeys.set(dir.slice("skills/".length), key);
      skillKeys.set(key, key);
    }
  }

  const agentDirs = new Map<string, ImportFile>();
  for (const f of files) {
    const m = AGENT_FILE.exec(f.name);
    // AGENTS.md is what the exporter writes; the guide says AGENT.md.
    if (m?.[1] && (!agentDirs.has(m[1]) || f.name.endsWith("AGENTS.md"))) agentDirs.set(m[1], f);
  }
  for (const [key, file] of agentDirs) {
    d.used.add(file.name);
    const fm = frontmatter(file.text) ?? { data: {}, body: file.text.trim() };
    const sibling = (name: string) => d.file(`agents/${key}/${name}`)?.text.trim() ?? "";
    const own = obj(obj(vendor.agents)[key]);
    const name = str(fm.data.name) || key;
    d.agent({
      key,
      name,
      role: str(fm.data.title),
      instructions: join([sibling("SOUL.md"), fm.body, section("Tools", [sibling("TOOLS.md")])]),
      model: str(obj(obj(own.adapter).config).model) || undefined,
      skills: list(fm.data.skills)
        .map(str)
        .flatMap((s) => {
          const k = skillKeys.get(s) ?? skillKeys.get(slug(s));
          if (!k) d.left("skill", s);
          return k ? [k] : [];
        }),
    });
    for (const [env, input] of Object.entries(obj(obj(own.inputs).env))) {
      if (str(obj(input).kind) === "secret") d.need("secret", env, [key]);
    }
    const heartbeat = sibling("HEARTBEAT.md");
    const seconds = num(obj(obj(own.runtime).heartbeat).intervalSec);
    if (heartbeat) {
      d.routine({
        key: `${key}/heartbeat`,
        name: "Heartbeat",
        agent: key,
        prompt: heartbeat,
        trigger: seconds ? everyMinutes(Math.round(seconds / 60)) : null,
        label: `HEARTBEAT.md (${name})`,
      });
    }
  }

  const agents = d.agents.map((a) => a.key);
  const about = join([
    str(info.description),
    list(info.goals)
      .map((g) => `- ${str(g)}`)
      .join("\n"),
    head?.body ?? "",
  ]);
  d.note({ key: "COMPANY.md", agent: null, kind: "note", content: about });
  for (const secret of list(obj(info.requirements).secrets)) d.need("secret", str(secret), agents);

  for (const file of files) {
    const m = TASK_FILE.exec(file.name);
    if (!m?.[1]) continue;
    d.used.add(file.name);
    const fm = frontmatter(file.text) ?? { data: {}, body: file.text.trim() };
    const title = str(fm.data.name) || m[1];
    if (fm.data.recurring !== true) {
      d.left("task", title);
      continue;
    }
    // The schedule lives in the vendor sidecar; without one the routine stays behind.
    const assignee = agents.includes(str(fm.data.assignee)) ? str(fm.data.assignee) : "";
    const triggers = list(obj(obj(vendor.routines)[m[1]]).triggers)
      .map(obj)
      .filter((t) => str(t.kind) === "schedule");
    for (const [i, t] of (triggers.length ? triggers : [{}]).entries()) {
      d.routine({
        key: i ? `${m[1]}-${i + 1}` : m[1],
        name: title,
        agent: assignee,
        prompt: fm.body || title,
        trigger: cronTrigger(str(t.cronExpression), str(t.timezone) || null),
        label: title,
      });
    }
  }
  for (const file of files) {
    const kind = /^projects\/[^/]+\/PROJECT\.md$/.test(file.name)
      ? "task"
      : /^teams\/[^/]+\/TEAM\.md$/.test(file.name)
        ? "team"
        : null;
    if (!kind) continue;
    d.used.add(file.name);
    d.left(kind, str(frontmatter(file.text)?.data.name) || (dirName(file.name).split("/")[1] ?? file.name));
  }
}
