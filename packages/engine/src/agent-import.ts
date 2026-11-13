import type { Database } from "@agenteschat/db";
import { ValidationError } from "./errors";
import { requirePermission } from "./organizations";
import { encodePath, fetchGithub, type GithubFetchDeps, parseGithubUrl } from "./skills";

/**
 * Bringing agents from another app: the web app parses the files (a team
 * file, a package, an agent workspace); the backend only reads them from
 * GitHub for a link, because the browser shouldn't call third parties. Only
 * GitHub hosts, the SSRF guard on every request, no redirects, and these
 * limits (`fileBytes` is the parser's own per-file limit).
 */
export const AGENT_IMPORT_LIMITS = { maxFiles: 200, maxBytes: 8 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 };

/**
 * What a folder link reads, relative to the folder, in this order when the
 * limits cut: its own Markdown/JSON/YAML (team files, packages, `SOUL.md`,
 * `CLAW.md`, `distribution.yaml`, `COMPANY.md`…), agent definitions
 * (`agents/x.yaml`, `agents/x/AGENTS.md`), skills with their references,
 * the legacy OpenClaw cron jobs, then memory, newest first. Nothing else.
 */
const ALLOWED = [
  /^[^/]+\.(md|markdown|json|ya?ml)$/i,
  /^agents\/([^/]+\/)?[^/]+\.(md|markdown|json|ya?ml)$/i,
  /^(\.agents\/)?skills\/([^/]+\/){1,4}[^/]+\.(md|markdown)$/i,
  /^cron\/jobs\.json$/i,
  /^memor(y|ies)\/[^/]+\.md$/i,
];
const MEMORY = ALLOWED.length - 1;
/** Where other apps keep keys and sign-ins: never read, even when the name fits the list. */
const SECRET_FILE =
  /^(\.env.*|auth(-profiles)?\.json|credentials?\..*|secrets?\..*|mcp-(oauth|tokens).*|cursor-session\.json)$/i;
/** Requests to GitHub at a time. */
const PARALLEL = 8;

export interface AgentImportDeps extends GithubFetchDeps {
  db: Database;
}

export interface ImportedFile {
  /** Relative to the linked folder (or the file's own name). */
  path: string;
  text: string;
}

interface TreeEntry {
  path: string;
  type: string;
  mode: string;
  size?: number;
}

/**
 * The text files behind a GitHub link: one file (`/blob/…` or raw), or the
 * allowlisted files under a folder (`/tree/…` or the repo), listed with one
 * recursive tree request. `skipped`: files that fit the list but not the
 * limits. Never runs or stores anything.
 */
export async function readGithubImport(
  deps: AgentImportDeps,
  actorId: string,
  orgId: string,
  url: string,
): Promise<{ files: ImportedFile[]; skipped?: string[] }> {
  await requirePermission(deps.db, actorId, orgId, "create_agents");
  let target: ReturnType<typeof parseGithubUrl>;
  try {
    target = parseGithubUrl(url);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError("Unrecognized GitHub URL");
  }
  const read = async (path: string) => {
    const raw = `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${encodePath(target.ref)}/${encodePath(path)}`;
    const data = await fetchGithub(deps, raw, "text/plain", {
      maxBytes: AGENT_IMPORT_LIMITS.fileBytes,
      tooLarge: "The file is too large (max 4 MB)",
    });
    return new TextDecoder().decode(data);
  };
  if (target.kind === "file") {
    const name = target.path.split("/").pop() ?? target.path;
    if (!ALLOWED[0]?.test(name) || SECRET_FILE.test(name))
      throw new ValidationError("Link a Markdown, JSON or YAML file");
    return { files: [{ path: name, text: await read(target.path) }] };
  }

  const listing = JSON.parse(
    new TextDecoder().decode(
      await fetchGithub(
        deps,
        `https://api.github.com/repos/${target.owner}/${target.repo}/git/trees/${encodeURIComponent(target.ref)}?recursive=1`,
        "application/vnd.github+json",
        { maxBytes: 8 * 1024 * 1024, tooLarge: "The repository is too large to list. Link a file instead." },
      ),
    ),
  ) as { tree?: TreeEntry[]; truncated?: boolean };
  if (!Array.isArray(listing.tree)) throw new ValidationError("That URL is not a folder");
  if (listing.truncated) throw new ValidationError("The repository is too large to list. Link a file instead.");
  const base = target.path.replace(/^\/+|\/+$/g, "");
  const prefix = base ? `${base}/` : "";
  const found = listing.tree.flatMap((entry) => {
    // Symbolic links (mode 120000) could point anywhere in the repository.
    if (entry.type !== "blob" || entry.mode === "120000" || !entry.path.startsWith(prefix)) return [];
    const path = entry.path.slice(prefix.length);
    const group = ALLOWED.findIndex((pattern) => pattern.test(path));
    if (group < 0 || SECRET_FILE.test(path.split("/").pop() ?? "")) return [];
    return [{ path, group, size: entry.size ?? 0 }];
  });
  if (found.length === 0) throw new ValidationError("No Markdown, JSON or YAML files in that folder");
  // Daily memory files are named by date: the newest go first when the limits cut.
  found.sort((a, b) => a.group - b.group || (a.group === MEMORY ? b.path.localeCompare(a.path) : 0));

  const chosen: typeof found = [];
  const skipped: string[] = [];
  let total = 0;
  for (const file of found) {
    const fits =
      chosen.length < AGENT_IMPORT_LIMITS.maxFiles &&
      file.size <= AGENT_IMPORT_LIMITS.fileBytes &&
      total + file.size <= AGENT_IMPORT_LIMITS.maxBytes;
    if (!fits) {
      skipped.push(file.path);
      continue;
    }
    chosen.push(file);
    total += file.size;
  }
  const files: ImportedFile[] = [];
  for (let i = 0; i < chosen.length; i += PARALLEL) {
    const batch = chosen.slice(i, i + PARALLEL);
    const texts = await Promise.all(batch.map((file) => read(prefix + file.path)));
    batch.forEach((file, j) => {
      files.push({ path: file.path, text: texts[j] ?? "" });
    });
  }
  return skipped.length > 0 ? { files, skipped } : { files };
}
