/** A GitHub issue or pull request address (mirrors `GITHUB_LINK`, packages/engine/src/issues.ts). */
const GITHUB_LINK = /^https:\/\/(?:www\.)?github\.com\/[^/\s]+\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#]\S*)?$/;

export const isGithubLink = (url: string) => GITHUB_LINK.test(url);

/** What a task's chip says for its link: `repo#12`. */
export function githubLinkLabel(url: string) {
  const m = GITHUB_LINK.exec(url);
  return m ? `${m[1]}#${m[2]}` : url;
}
