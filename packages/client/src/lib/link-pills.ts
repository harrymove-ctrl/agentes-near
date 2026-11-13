import type { TFunction } from "i18next";
import type { ConnectorDef } from "../api/types";

export type LinkPillWord =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "file"
  | "folder"
  | "customer"
  | "payment"
  | "invoice"
  | "subscription";
export type LinkPillKind = "pull" | "merge" | "issue";

/** How a bare address of a known service shows in a message: its logo and a few words, all read from the address. */
export interface LinkPill extends Pick<ConnectorDef, "iconUrl" | "brandColor"> {
  /** The service's name, for who can't see the logo. */
  service: string;
  /** What holds it: a repository, a project, a page's title. */
  name?: string;
  /** Which one in there: "#148", "!12", "a1b2c3d", "ENG-123". */
  ref?: string;
  /** Said in the reader's language when the address has no title (`linkPills.{word}`). */
  word?: LinkPillWord;
  /** What a number points at: drawn as an icon beside it, since "#148" alone can be either. */
  kind?: LinkPillKind;
}

type Said = Pick<LinkPill, "name" | "ref" | "word" | "kind">;
type Rule = [path: RegExp, say: (groups: string[]) => Said];

interface Service {
  host: RegExp;
  service: string;
  /** `apps/web/public/connectors/{mark}.svg`. */
  mark: string;
  /** The catalog's color for that mark (`CONNECTOR_BRANDS`); null draws it in the ink. */
  color: string | null;
  rules: Rule[];
}

/** A part of an address as it reads, without characters that would reorder the line it shows on. */
function decoded(segment: string): string {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // A stray "%" is not an escape: as written.
  }
  return text.replace(/[\p{Cc}\p{Cf}]/gu, "");
}

/** A title kept in an address ("Plano-de-Q4", "Plano%20de%20Q4") as words. */
const titleOf = (slug: string) =>
  decoded(slug)
    .replace(/[-_+\s]+/g, " ")
    .trim();

const shortSha = (sha: string) => sha.slice(0, 7);
const DOC_ID = String.raw`(?:u\/\d+\/)?d\/[\w-]+`;
const STRIPE_WORDS: Record<string, LinkPillWord> = {
  customers: "customer",
  payments: "payment",
  invoices: "invoice",
  subscriptions: "subscription",
};
/** github.com's own pages at two segments, which read like `owner/repo`. */
const GITHUB_PAGES =
  "about|account|apps|codespaces|collections|contact|copilot|customer-stories|dashboard|enterprise|explore|features|issues|join|login|marketplace|mobile|new|notifications|open-source|orgs|organizations|pricing|pulls|readme|resources|search|security|sessions|settings|site|solutions|sponsors|stars|team|topics|trending|users|watching";

/** A project under any number of groups, by whole segments: anything looser takes seconds on a long address. */
const GITLAB_PROJECT = String.raw`\/(?:[^/]+\/)*([\w.-]+)`;

/**
 * Every service whose addresses have a fixed shape. A path that fits no rule stays a plain link, so a page of a
 * service that doesn't say what it is keeps its address in full.
 */
const SERVICES: readonly Service[] = [
  {
    host: /^github\.com$/,
    service: "GitHub",
    mark: "github",
    color: null,
    rules: [
      [/^\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/, ([repo, n]) => ({ name: repo, ref: `#${n}`, kind: "pull" })],
      [/^\/[\w.-]+\/([\w.-]+)\/issues\/(\d+)(?:\/|$)/, ([repo, n]) => ({ name: repo, ref: `#${n}`, kind: "issue" })],
      [
        /^\/[\w.-]+\/([\w.-]+)\/commit\/([0-9a-f]{7,40})(?:\/|$)/,
        ([repo, sha]) => ({ name: repo, ref: shortSha(sha ?? "") }),
      ],
      [/^\/[\w.-]+\/([\w.-]+)\/releases\/tag\/([^/]+)\/?$/, ([repo, tag]) => ({ name: repo, ref: decoded(tag ?? "") })],
      [/^\/[\w.-]+\/([\w.-]+)\/blob\/.*\/([^/]+)$/, ([repo, file]) => ({ name: repo, ref: decoded(file ?? "") })],
      [
        new RegExp(String.raw`^\/((?!(?:${GITHUB_PAGES})\/)[\w.-]+\/[\w.-]+)(?<!\.git)\/?$`),
        ([repo]) => ({ name: repo as string }),
      ],
    ],
  },
  {
    host: /^gitlab\.com$/,
    service: "GitLab",
    mark: "gitlab",
    color: "#FC6D26",
    rules: [
      [
        new RegExp(String.raw`^${GITLAB_PROJECT}\/-\/merge_requests\/(\d+)(?:\/|$)`),
        ([p, n]) => ({ name: p, ref: `!${n}`, kind: "merge" }),
      ],
      [
        new RegExp(String.raw`^${GITLAB_PROJECT}\/-\/issues\/(\d+)(?:\/|$)`),
        ([p, n]) => ({ name: p, ref: `#${n}`, kind: "issue" }),
      ],
      [
        new RegExp(String.raw`^${GITLAB_PROJECT}\/-\/commit\/([0-9a-f]{7,40})(?:\/|$)`),
        ([p, sha]) => ({ name: p, ref: shortSha(sha ?? "") }),
      ],
    ],
  },
  {
    host: /^linear\.app$/,
    service: "Linear",
    mark: "linear",
    color: "#5E6AD2",
    rules: [[/^\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/, ([id]) => ({ ref: (id ?? "").toUpperCase() })]],
  },
  {
    host: /^[a-z0-9-]+\.atlassian\.net$/,
    service: "Jira",
    mark: "jira",
    color: "#0052CC",
    rules: [[/^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/, ([id]) => ({ ref: id as string })]],
  },
  {
    host: /^figma\.com$/,
    service: "Figma",
    mark: "figma",
    color: null,
    rules: [
      [/^\/(?:file|design|board|slides|proto)\/\w+\/([^/]+)\/?$/, ([slug]) => ({ name: titleOf(slug ?? "") })],
      [/^\/(?:file|design|board|slides|proto)\/\w+\/?$/, () => ({ word: "file" })],
    ],
  },
  {
    host: /^(?:notion\.so|[a-z0-9-]+\.notion\.site)$/,
    service: "Notion",
    mark: "notion",
    color: null,
    rules: [[/^\/(?:[^/]+\/)?([^/]+)-[0-9a-f]{32}\/?$/, ([slug]) => ({ name: titleOf(slug ?? "") })]],
  },
  {
    host: /^docs\.google\.com$/,
    service: "Google Docs",
    mark: "googledocs",
    color: "#4285F4",
    rules: [[new RegExp(String.raw`^\/document\/${DOC_ID}`), () => ({ word: "document" })]],
  },
  {
    host: /^docs\.google\.com$/,
    service: "Google Sheets",
    mark: "googlesheets",
    color: "#34A853",
    rules: [[new RegExp(String.raw`^\/spreadsheets\/${DOC_ID}`), () => ({ word: "spreadsheet" })]],
  },
  {
    host: /^docs\.google\.com$/,
    service: "Google Slides",
    mark: "googleslides",
    color: "#FBBC04",
    rules: [[new RegExp(String.raw`^\/presentation\/${DOC_ID}`), () => ({ word: "presentation" })]],
  },
  {
    host: /^drive\.google\.com$/,
    service: "Google Drive",
    mark: "googledrive",
    color: "#4285F4",
    rules: [
      [/^\/file\/(?:u\/\d+\/)?d\/[\w-]+/, () => ({ word: "file" })],
      [/^\/drive\/(?:u\/\d+\/)?folders\/[\w-]+/, () => ({ word: "folder" })],
    ],
  },
  {
    host: /^dashboard\.stripe\.com$/,
    service: "Stripe",
    mark: "stripe",
    color: "#635BFF",
    rules: [
      [
        /^(?:\/acct_\w+)?(?:\/test)?\/(customers|payments|invoices|subscriptions)\/\w+\/?$/,
        ([kind]) => ({ word: STRIPE_WORDS[kind ?? ""] as LinkPillWord }),
      ],
    ],
  },
  {
    host: /^vercel\.com$/,
    service: "Vercel",
    mark: "vercel",
    color: null,
    // A deployment's id, long and without dashes, unlike a project's own pages (`/settings`, `/logs`).
    rules: [[/^\/[\w-]+\/([\w.-]+)\/[A-Za-z0-9]{20,}\/?$/, ([project]) => ({ name: project as string })]],
  },
];

/** Parsed by hand, not with `URL`: this runs on the phone too, whose `URL` is partial. */
const ADDRESS = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i;
/** What a browser resolves before leaving: `/document/d/x/../../../url` opens `/url`, so the shape it shows isn't where it goes. */
const REWRITTEN = /\\|(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;

/**
 * The pill of a bare address, or null when it stays a plain link. Only from the address: nothing is fetched. Only
 * the exact host earns a logo (`github.com.evil.example`, `evil.example/github.com` don't), and an address with a
 * user name or a port keeps showing them, and a path that a browser rewrites keeps showing where it really goes.
 */
export function linkPill(href: string): LinkPill | null {
  const [, authority, pathname = "/"] = href.match(ADDRESS) ?? [];
  if (!authority || REWRITTEN.test(pathname)) return null;
  const host = authority.toLowerCase().replace(/^www\./, "");
  for (const s of SERVICES) {
    if (!s.host.test(host)) continue;
    for (const [path, say] of s.rules) {
      const found = pathname.match(path);
      if (!found) continue;
      const said = say(found.slice(1));
      if (!said.name && !said.ref && !said.word) continue;
      return { service: s.service, iconUrl: `/connectors/${s.mark}.svg`, brandColor: s.color, ...said };
    }
  }
  return null;
}

/** What a pill says, as one line. */
export const linkPillText = (t: TFunction, pill: LinkPill): string =>
  pill.word ? t(`linkPills.${pill.word}`) : [pill.name, pill.ref].filter(Boolean).join(" ");

/** A pill as a screen reader says it: the service and what its icon shows, then its words. */
export const linkPillLabel = (t: TFunction, pill: LinkPill): string =>
  [pill.service, pill.kind ? t(`linkPills.${pill.kind}`) : "", linkPillText(t, pill)].filter(Boolean).join(" ");
