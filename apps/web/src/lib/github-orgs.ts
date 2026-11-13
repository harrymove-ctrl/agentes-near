/** The organizations shown before leaving for GitHub's sign-in, read on the way back to say what changed. */
const KEY = "agentes.github-orgs";

export function keepGithubOrgs(orgs: readonly string[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(orgs));
  } catch {}
}

export function readGithubOrgs(): string[] | null {
  try {
    const list: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    return Array.isArray(list) ? list.filter((o) => typeof o === "string") : null;
  } catch {
    return null;
  }
}

export function forgetGithubOrgs() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}
