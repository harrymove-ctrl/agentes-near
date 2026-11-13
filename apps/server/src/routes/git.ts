import { type GitProxyDeps, handleGitProxy } from "@agenteschat/engine";
import type { OpenAPIHono } from "@hono/zod-openapi";

/**
 * The git proxy for agents' computers (docs/adr/0024-git-proxy.md):
 * `/api/git/{orgId}/{connectionId}/{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}`.
 * No session cookie: the computer signs in with its own short-lived git
 * credential (HTTP Basic). Bodies are passed through as bytes.
 */
export function registerGitProxy(api: OpenAPIHono, deps: GitProxyDeps) {
  api.on(["GET", "POST"], "/git/:orgId/:connectionId/*", async (c) => {
    const { orgId, connectionId } = c.req.param();
    const prefix = `/api/git/${orgId}/${connectionId}/`;
    const pathname = new URL(c.req.url).pathname;
    if (!pathname.startsWith(prefix)) return c.text("not found", 404);
    return handleGitProxy(deps, c.req.raw, { orgId, connectionId, path: pathname.slice(prefix.length) });
  });
}
