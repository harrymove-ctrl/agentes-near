import {
  baseName,
  cronTrigger,
  type Draft,
  dirName,
  durationMinutes,
  everyMinutes,
  frontmatter,
  ImportError,
  type ImportFile,
  join,
  jsonOf,
  list,
  obj,
  resolvePath,
  section,
  sha256,
  slug,
  str,
  templateHash,
  yamlOf,
} from "./shared";

/**
 * OpenClaw (github.com/openclaw/openclaw, MIT) and the agents that share its
 * workspace layout:
 * - a workspace (`docs/concepts/agent-workspace.md`): SOUL.md (persona),
 *   AGENTS.md (operating rules), IDENTITY.md (`- Name: value` lines), USER.md,
 *   MEMORY.md, memory/*.md, TOOLS.md, HEARTBEAT.md, skills/<…>/SKILL.md; or the
 *   state folder (~/.openclaw) with `openclaw.json` (JSON5; only the keys read
 *   below) and `workspace`, `workspace-<agent>` folders
 *   (`docs/concepts/multi-agent.md`);
 * - a Claw package (`docs/cli/claws.md`, `src/claws/schema.ts`): CLAW.md, YAML
 *   frontmatter with `schemaVersion: 1`, the body is the SOUL.md.
 * Files left as OpenClaw seeds them carry nothing of the person, so they are dropped.
 */

/** SHA-256 (`templateHash`) of the workspace files OpenClaw seeds, from `docs/reference/templates` (and the `.dev` set). */
const DEFAULTS = new Set([
  "83cef4a9616298c9946376a665da9046277826c108e9a4f13af24562f5f0354b",
  "d32c19d966b04080c90dffaac5cb4b046f953ad4b13554f5c39254ee423c74d7",
  "f6ff0147694bed5eb24d9fe8f5475b327dcc6af811afc95f32d8580899056081",
  "f0d3a7f599d4d917a78b25e7eee91e469feae0cb8c573f012fcc13e2035e4df1",
  "78b9555b5ebfeeb68c839579eecd8d6059849c4368ac37cb3440e16a9b8d14fe",
  "6951d03f2cc8c5814b56d0a22a8c4791e146d16f32063da35281a13a45041264",
  "554a80af10364e293d8d922fcd83090257742c8015c957fb1ab95192b8ad80fb",
  "6ed5d8bf2f1106d240fc1ba070f9268e2020a44a2b0dc5f781a22890f0eaf8da",
  "b1f101dfcedcf6e0e0c19b4da0d406a5e7c7544086e138f9bc61fa4e3476d3b5",
  "440b95537181bf5991c02fd656b512581fd78a3373a684185db2e767e3de1333",
  "7d5747db37d1d5237cfafc72bc3e3d34c6c0ebabb3ec7b08ce7665094545a6eb",
  "4a617eac18e3de873defb9b02b6ce2e9e628138723f7f208515edea41c9b7291",
]);
/** Earlier seeds, as OpenClaw lists them (RETIRED_GENERATED_TEMPLATE_SHA256 in src/agents/workspace.ts): exact bytes. */
const RETIRED = new Set([
  "1e17784e422c0e47e44c5214d0b37092f7b378bb2d3746976032be3075203c88",
  "490fc2b32865dd310a3af1225a409ac5c942d89ba456167feb0fd95e2807aaff",
  "4f9042f259b076e429d0f01ce39340030f47ea5b7f5befe306296c36baf1f60f",
  "59b223766c8dd978162044e333a684c72e22af753d1ba3dc3bff4b2d915c54e2",
]);
/** An AGENTS.md seeded with a purpose is `# Agent purpose`, the purpose, then the AGENTS.md seed (this long, this hash). */
const AGENTS_SEED = { length: 7144, hash: "83cef4a9616298c9946376a665da9046277826c108e9a4f13af24562f5f0354b" };

/** The person's part of a workspace file: "" when it is OpenClaw's seed. */
export function ownText(text: string): string {
  const lf = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const trimmed = lf.trim();
  if (!trimmed || DEFAULTS.has(templateHash(trimmed)) || RETIRED.has(sha256(lf))) return "";
  if (trimmed.length > AGENTS_SEED.length && sha256(trimmed.slice(-AGENTS_SEED.length)) === AGENTS_SEED.hash) {
    return trimmed
      .slice(0, -AGENTS_SEED.length)
      .replace(/^#\s*Agent purpose\s*/i, "")
      .trim();
  }
  return trimmed;
}

/** IDENTITY.md: `- Name: value` lines (bold labels too); placeholders in parentheses don't count. */
export function identityOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*-\s*(?:\*\*|__)?([A-Za-z]+)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?(.*)$/.exec(line);
    if (!m) continue;
    const value = (m[2] ?? "").replace(/^[\s*_`]+|[\s*_`]+$/g, "");
    if (value && !(value.startsWith("(") && value.endsWith(")"))) out[(m[1] ?? "").toLowerCase()] = value;
  }
  return out;
}

const CONFIGS = ["openclaw.json", "clawdbot.json", "moltbot.json"];
const configOf = (files: ImportFile[]) => files.find((f) => CONFIGS.includes(f.name) && jsonOf(f));

function clawOf(files: ImportFile[]) {
  const pkg = files.find((f) => f.name === "package.json");
  const declared = pkg ? str(obj(obj(jsonOf(pkg)).openclaw).claw) : "";
  const path = (declared && resolvePath("", declared)) || "CLAW.md";
  const file = files.find((f) => f.name === path);
  const fm = file ? frontmatter(file.text) : null;
  if (!file || !fm || fm.data.schemaVersion === undefined || !str(obj(fm.data.agent).id)) return null;
  if (fm.data.schemaVersion !== 1) throw new ImportError("newerVersion");
  return { file, pkg: declared ? pkg : undefined, ...fm };
}

const has = (files: ImportFile[], dir: string, name: string) =>
  files.some((f) => f.name === (dir ? `${dir}/${name}` : name));
const looksLikeWorkspace = (files: ImportFile[], dir: string) =>
  has(files, dir, "SOUL.md") &&
  (["IDENTITY.md", "USER.md", "MEMORY.md"].some((n) => has(files, dir, n)) ||
    files.some((f) => f.name.startsWith(dir ? `${dir}/memory/` : "memory/")));

/** The workspace folders: the root, and `workspace`/`workspace-<agent>` beside a config. */
function workspaceDirs(files: ImportFile[], stateFolder: boolean): string[] {
  const tops = [...new Set(files.filter((f) => f.name.includes("/")).map((f) => f.name.split("/")[0] as string))];
  const nested = tops.filter(
    (t) =>
      (stateFolder &&
        /^workspace(-|$)/.test(t) &&
        ["SOUL.md", "AGENTS.md", "IDENTITY.md"].some((n) => has(files, t, n))) ||
      looksLikeWorkspace(files, t),
  );
  return looksLikeWorkspace(files, "") ? ["", ...nested] : nested;
}

export const detect = (files: ImportFile[]) =>
  clawOf(files) !== null || configOf(files) !== undefined || workspaceDirs(files, false).length > 0;

export function parse(files: ImportFile[], d: Draft) {
  const claw = clawOf(files);
  if (claw) return fromClaw(claw, d);
  const config = configOf(files);
  if (config) d.used.add(config.name);
  const cfg = config ? (jsonOf(config) ?? {}) : {};

  const agentsCfg = obj(cfg.agents);
  const defaults = obj(agentsCfg.defaults);
  const entries = [
    ...Object.entries(obj(agentsCfg.entries)).map(([id, e]) => ({ id, e: obj(e) })),
    // The roster before `agents.entries`; `openclaw doctor` moves it.
    ...list(agentsCfg.list)
      .map(obj)
      .map((e) => ({ id: str(e.id), e })),
  ].filter((x) => x.id);
  const main = entries.find((x) => x.e.default === true)?.id ?? "main";
  const dirs = workspaceDirs(files, config !== undefined);
  const taken = new Set<string>();
  for (const { id, e } of entries) {
    const wanted = [baseName(str(e.workspace)), id === main ? "workspace" : `workspace-${id}`, id];
    let dir = wanted.find((w) => w && dirs.includes(w) && !taken.has(w));
    if (dir === undefined && id === main && dirs.includes("") && !taken.has("")) dir = "";
    if (dir !== undefined) taken.add(dir);
    workspaceAgent(id, e, dir ?? null, defaults, d);
  }
  for (const dir of dirs) {
    if (taken.has(dir)) continue;
    const id = dir === "workspace" ? main : dir.startsWith("workspace-") ? dir.slice("workspace-".length) : dir;
    workspaceAgent(id || null, {}, dir, defaults, d);
  }

  // Skills in the state folder (~/.openclaw/skills) are every agent's.
  const shared = dirs.includes("") ? [] : d.skillsUnder("skills");
  for (const a of d.agents) a.skills = [...new Set([...a.skills, ...shared])];
  const [only] = d.agents;
  d.name = d.agents.length === 1 && only ? only.name : d.options.root || "OpenClaw";
  d.ref = d.agents.length === 1 && only ? `openclaw:${only.key}` : slug(d.options.root ?? "") || "openclaw";

  const agents = d.agents.map((a) => a.key);
  for (const [name, server] of Object.entries(obj(obj(cfg.mcp).servers))) {
    d.connection(name, str(obj(server).url), agents);
  }
  // Chat apps (WhatsApp, Telegram, Slack…) reach the agent through OpenClaw's gateway; we have no bridge.
  for (const platform of Object.keys(obj(cfg.channels))) d.left("messaging", platform);
}

/** One agent from its config entry and its workspace folder (either may be missing). */
function workspaceAgent(
  id: string | null,
  entry: Record<string, unknown>,
  dir: string | null,
  defaults: Record<string, unknown>,
  d: Draft,
) {
  const path = (name: string) => (dir === null ? null : dir ? `${dir}/${name}` : name);
  const own = (name: string) => ownText(d.file(path(name))?.text ?? "");
  const identity = identityOf(own("IDENTITY.md"));
  const configured = obj(entry.identity);
  const name = identity.name || str(configured.name) || str(entry.name) || id || "OpenClaw";
  // A workspace without a config is OpenClaw's single agent, `main`, unless it named itself.
  const key = id ?? (slug(identity.name ?? "") || "main");
  for (const seed of ["BOOTSTRAP.md", "BOOT.md"]) {
    const file = d.files.find((f) => f.name === path(seed));
    if (file && !ownText(file.text)) d.used.add(file.name);
  }
  const model = entry.model ?? defaults.model;
  d.agent({
    key,
    name,
    role: identity.theme || identity.creature || identity.vibe || str(configured.theme),
    instructions: join([own("SOUL.md"), own("AGENTS.md") || own("AGENT.md"), section("Tools", [own("TOOLS.md")])]),
    model: str(model) || str(obj(model).primary) || undefined,
    skills:
      dir === null
        ? []
        : [...d.skillsUnder(path("skills") ?? "skills"), ...d.skillsUnder(path(".agents/skills") ?? "")],
  });
  const avatar = identity.avatar || str(configured.avatar);
  if (avatar) {
    const file = dir === null ? null : resolvePath(dir, avatar);
    if (file) d.used.add(file);
    d.left("picture", name);
  }
  d.note({ key: `${key}/USER.md`, agent: key, kind: "preference", content: own("USER.md") });
  for (const file of dir === null ? [] : d.under(path("memory") ?? "memory")) {
    if (!/\.md$/i.test(file.name)) continue;
    d.used.add(file.name);
    d.note({ key: `${key}/${file.name}`, agent: key, kind: "note", content: file.text });
  }
  d.note({ key: `${key}/MEMORY.md`, agent: key, kind: "note", content: own("MEMORY.md") });
  heartbeat(key, name, own("HEARTBEAT.md"), str(obj(entry.heartbeat).every) || str(obj(defaults.heartbeat).every), d);
  // The rest of the workspace is what the agent made there: it can go to its folder in the Drive.
  if (dir !== null) d.filesIn(key, dir, ["skills", ".agents"]);
}

/** HEARTBEAT.md is what the agent checks on every heartbeat: a routine at the configured cadence. */
function heartbeat(key: string, name: string, prompt: string, every: string, d: Draft) {
  if (!prompt) return;
  const minutes = every ? durationMinutes(every) : null;
  d.routine({
    key: `${key}/heartbeat`,
    name: "Heartbeat",
    agent: key,
    prompt,
    trigger: minutes ? everyMinutes(minutes) : null,
    label: `HEARTBEAT.md (${name})`,
  });
}

function fromClaw(claw: NonNullable<ReturnType<typeof clawOf>>, d: Draft) {
  d.used.add(claw.file.name);
  if (claw.pkg) d.used.add(claw.pkg.name);
  const dir = dirName(claw.file.name);
  const manifest = claw.data;
  const agent = obj(manifest.agent);
  const identity = obj(agent.identity);
  const id = str(agent.id);
  const workspace = obj(manifest.workspace);
  const boot = obj(workspace.bootstrapFiles);
  const read = (name: string) => {
    const source = str(obj(boot[name]).source);
    if (!source) return "";
    const file = d.file(resolvePath(dir, source));
    if (!file?.text) d.left("file", source);
    return ownText(file?.text ?? "");
  };
  const fromFile = identityOf(read("IDENTITY.md"));
  const name = str(agent.name) || str(identity.name) || fromFile.name || id;
  d.name = name;
  d.ref = `claw:${id}`;
  d.agent({
    key: id,
    name,
    role: str(identity.theme) || fromFile.theme || fromFile.creature || fromFile.vibe || str(agent.description),
    instructions: join([
      ownText(claw.body) || read("SOUL.md"),
      read("AGENTS.md"),
      section("Tools", [read("TOOLS.md")]),
    ]),
  });
  if (str(identity.avatar) || fromFile.avatar) d.left("picture", name);
  const profile = d.file(resolvePath(dir, "profiles/openclaw.yml"));
  const every = str(obj(obj(obj(profile ? yamlOf(profile) : null).agent).heartbeat).every);
  heartbeat(id, name, read("HEARTBEAT.md"), every, d);

  // ClawHub packages are fetched by OpenClaw at install time: we only name them.
  for (const p of list(manifest.packages).map(obj)) {
    d.left(str(p.kind) === "plugin" ? "plugin" : "skill", [str(p.ref), str(p.version)].filter(Boolean).join("@"));
  }
  // Files the package puts in the agent's workspace are its own: they can go to its folder in the Drive.
  for (const f of list(workspace.files).map(obj)) {
    const source = resolvePath(dir, str(f.source));
    const to = resolvePath("", str(f.path) || baseName(str(f.source)));
    if (source && to) d.fileAt(id, source, to);
    else d.left("file", str(f.path) || str(f.source));
  }
  for (const [server, spec] of Object.entries(obj(manifest.mcpServers))) {
    d.connection(server, str(obj(spec).url), [id]);
  }
  for (const job of list(manifest.cronJobs).map(obj)) {
    const schedule = obj(job.schedule);
    d.routine({
      key: str(job.id),
      name: str(job.name) || str(job.id),
      agent: id,
      prompt: str(job.message),
      trigger: cronTrigger(str(schedule.cron), str(schedule.timezone) || null),
    });
  }
}
