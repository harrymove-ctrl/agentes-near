import { parse as parseYaml } from "yaml";
import { baseName, type Draft, type ImportFile, list, obj, str } from "./shared";

/**
 * OpenBot by CopilotKit (github.com/CopilotKit/OpenBot, MIT): a tenant package
 * (`docs/configuration.md`, "Tenant package"; `examples/fintech/`):
 * `agents.yaml` (an `agents:` list) and `agents/*.yaml` (one coworker, or the
 * same list), `model.yaml` (the package's model and the name of its
 * credential), `skills.yaml` (not SKILL.md: slug, title, summary,
 * instructions, tools), `channels.yaml`, `knowledge.yaml` (Drive and OneDrive
 * roots) and `brand.yaml` (the tenant's id and product name).
 */

const TYPES = new Set(["built-in", "remote-ag-ui", "remote-mastra"]);
const KNOWLEDGE: Record<string, string> = { "google-drive": "Google Drive", "microsoft-onedrive": "OneDrive" };

/** `${NAME:-fallback}` → fallback, `${NAME}` → "" (OpenBot reads them from its own environment). */
export function interpolateEnv(text: string): string {
  return text.replace(
    /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-([^}]*))?\}/g,
    (_, fallback: string | undefined) => fallback ?? "",
  );
}

const docs = new WeakMap<ImportFile, Record<string, unknown> | null>();
function docOf(file: ImportFile): Record<string, unknown> | null {
  if (!/\.ya?ml$/i.test(file.name)) return null;
  if (!docs.has(file)) {
    let doc: Record<string, unknown> | null = null;
    try {
      const v: unknown = parseYaml(interpolateEnv(file.text));
      doc = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {}
    docs.set(file, doc);
  }
  return docs.get(file) ?? null;
}

const fileName = (file: ImportFile) => baseName(file.name).replace(/\.yml$/i, ".yaml");
const agentRows = (doc: Record<string, unknown>) =>
  Array.isArray(doc.agents) ? list(doc.agents).map(obj) : doc.id && doc.type ? [doc] : [];

function role(file: ImportFile): "model" | "brand" | "skills" | "channels" | "knowledge" | "agents" | null {
  const doc = docOf(file);
  if (!doc) return null;
  const name = fileName(file);
  if (name === "model.yaml" && (obj(doc.model).provider || obj(doc.model).default_model)) return "model";
  if (name === "brand.yaml" && obj(doc.tenant).id) return "brand";
  if (name === "skills.yaml" && Array.isArray(doc.skills)) return "skills";
  if (name === "channels.yaml" && Array.isArray(doc.channels)) return "channels";
  if (name === "knowledge.yaml" && Array.isArray(doc.sources)) return "knowledge";
  return agentRows(doc).some((r) => str(r.id) && TYPES.has(str(r.type))) ? "agents" : null;
}

export const detect = (files: ImportFile[]) => files.some((f) => role(f) !== null);

export function parse(files: ImportFile[], d: Draft) {
  const rows: Record<string, unknown>[] = [];
  const channels: Record<string, unknown>[] = [];
  let model: unknown;
  let credential = "";
  const knowledge: string[] = [];
  for (const file of files) {
    const kind = role(file);
    const doc = docOf(file);
    if (!kind || !doc) continue;
    d.used.add(file.name);
    if (kind === "model") {
      const m = obj(doc.model);
      model = [str(m.provider), str(m.default_model)].filter(Boolean).join("/") || undefined;
      credential = str(m.credential_secret_ref);
    } else if (kind === "brand") {
      d.name = str(obj(doc.tenant).product_name);
      d.ref = str(obj(doc.tenant).id);
    } else if (kind === "skills") {
      for (const s of list(doc.skills).map(obj)) {
        const tools = list(s.tools).map(str).filter(Boolean);
        d.skill(str(s.instructions), str(s.slug), str(s.summary) || str(s.title), {
          ...(str(s.title) ? { title: str(s.title) } : {}),
          ...(tools.length ? { tools } : {}),
        });
      }
    } else if (kind === "channels") channels.push(...list(doc.channels).map(obj));
    else if (kind === "knowledge") {
      for (const source of list(doc.sources).map(obj)) {
        const app = KNOWLEDGE[str(source.type)] ?? str(source.type);
        const roots = list(source.roots).map(str).filter(Boolean);
        knowledge.push(roots.length ? `${app}: ${roots.join(", ")}` : app);
      }
    } else rows.push(...agentRows(doc));
  }

  const skills = new Set(d.skills.map((s) => s.key));
  for (const row of rows) {
    const id = str(row.id);
    const name = str(row.name) || id;
    const type = str(row.type);
    const own = list(row.skills).map(str).filter(Boolean);
    for (const s of own) if (!skills.has(s)) d.left("skill", s);
    // A remote coworker runs on its own server (AG-UI / Mastra): only its endpoint, nothing to bring.
    if (type !== "built-in") {
      if (id) d.left("remote", TYPES.has(type) ? `${name} (${type})` : name);
      continue;
    }
    // Two rows with one id stop OpenBot's server; here the first wins.
    d.agent({
      key: id,
      name,
      role: str(row.title),
      instructions: str(row.system_prompt) || str(row.role_description),
      model,
      seed: str(row.avatar_seed) || id,
      skills: own.filter((s) => skills.has(s)),
    });
  }
  const agents = d.agents.map((a) => a.key);
  // The permitted coworkers that came along join, answering when mentioned.
  for (const c of channels) {
    d.channel({
      key: str(c.id),
      name: str(c.name) || str(c.id),
      topic: str(c.description),
      agents: list(c.permitted_agents)
        .map(str)
        .filter((k) => agents.includes(k))
        .map((key) => ({ key, autoReply: false })),
    });
  }
  if (credential) d.need("secret", credential, agents);
  for (const k of knowledge) d.need("app", k, agents);
}
