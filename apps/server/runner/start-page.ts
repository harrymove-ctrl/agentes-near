import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { START_FILE } from "@agenteschat/adapters/browser-start";
import type { AgentScope, MachineEgress } from "@agenteschat/adapters/machine-protocol";
import { countryFlagUrl } from "@agenteschat/ui/brand/flags";
import { type AgentUser, agentGid } from "./agent-users";
import MARK from "./assets/desktop-mark.png.b64" with { type: "text" };
import DOTO from "./assets/start/doto.woff2.b64" with { type: "text" };
import CSS from "./assets/start/start.css.txt" with { type: "text" };
import HTML from "./assets/start/start.html.txt" with { type: "text" };
import JS from "./assets/start/start.js.txt" with { type: "text" };
import { desktopName } from "./desktop-look";
import { SYSTEM_BROWSER_DIR } from "./install-script";

export const systemStartPage = (uid: number) => path.join(SYSTEM_BROWSER_DIR, "start", String(uid));
export const startLocale = (locale?: string | null): "pt-BR" | "en" =>
  /^pt(?:-|$)/i.test(locale ?? "") ? "pt-BR" : "en";
export interface StartPageData {
  locale?: string;
  egress?: MachineEgress | null;
}

/**
 * The agent's start page as one file: Chrome opens `file://` pages, where it loads nothing beside them reliably, so
 * its style, script, font, picture and the agent's details are all inside. The details are JSON with `<` escaped, so
 * no name closes the script they sit in. Its language is in the markup, not only set by its script: Chrome judges
 * the page's language from what it loaded, and an `en` page in Portuguese gets the Translate bubble. `notranslate`
 * keeps that bubble off this page alone; real sites still get it.
 */
export function startPageHtml(agent: Pick<AgentScope, "name" | "handle">, data: StartPageData = {}): string {
  const locale = startLocale(data.locale);
  const json = JSON.stringify({
    name: desktopName(agent),
    locale,
    egress: data.egress ?? null,
    flag: countryFlagUrl(data.egress?.country),
  }).replace(/</g, "\\u003c");
  const parts: Record<string, string> = {
    CSS: CSS.replace("{{DOTO}}", () => `data:font/woff2;base64,${DOTO.trim()}`),
    JS,
    DATA: json,
    MARK: `data:image/png;base64,${MARK.trim()}`,
    LANG: locale,
  };
  return HTML.replace(/\{\{(CSS|JS|DATA|MARK|LANG)\}\}/g, (_, key: string) => parts[key] ?? "");
}

/**
 * Whether the start page's folder could be someone else's or written by others: not a folder, not this user's, or
 * writable by its group or everyone. Windows reports a mode made up from the read-only attribute alone (0o666 for any
 * ordinary folder) and no owner id, so neither says anything there, where access is in the folder's ACL.
 */
export function unsafeStartFolder(
  st: { isDirectory(): boolean; uid: number; mode: number },
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
) {
  if (!st.isDirectory()) return true;
  if (platform === "win32") return false;
  return (uid !== undefined && st.uid !== uid) || (st.mode & 0o022) !== 0;
}

/**
 * Writes the agent's start page (`START_FILE`) in `directory` and returns its path. It holds no credentials. System
 * mode writes it as root outside the agent's writable home, readable by the agent's group alone.
 */
export function prepareStartPage(
  directory: string,
  agent: Pick<AgentScope, "name" | "handle">,
  data: StartPageData = {},
  gid?: number,
) {
  mkdirSync(path.dirname(directory), { recursive: true, mode: 0o755 });
  mkdirSync(directory, { recursive: true, mode: gid === undefined ? 0o755 : 0o750 });
  const st = lstatSync(directory);
  if (unsafeStartFolder(st)) throw new Error("Unsafe start page folder");
  if (gid !== undefined) {
    if (st.gid !== gid) chownSync(directory, 0, gid);
    if ((st.mode & 0o777) !== 0o750) chmodSync(directory, 0o750);
  }
  const html = startPageHtml(agent, data);
  const dest = path.join(directory, START_FILE);
  if (!existsSync(dest) || readFileSync(dest, "utf8") !== html) {
    writeFileSync(`${dest}.tmp`, html, { mode: 0o644 });
    renameSync(`${dest}.tmp`, dest);
  }
  return dest;
}

const agentGroups = new Map<number, number>();
export function prepareSystemStartPage(
  user: AgentUser,
  agent: Pick<AgentScope, "name" | "handle">,
  data: StartPageData,
) {
  let gid = agentGroups.get(user.uid);
  if (gid === undefined) {
    gid = agentGid(user.user);
    agentGroups.set(user.uid, gid);
  }
  return prepareStartPage(systemStartPage(user.uid), agent, data, gid);
}
