import { requestLocale } from "@agenteschat/engine";
import { serverText } from "@agenteschat/i18n";
import { type AppLocale, appLocale } from "@agenteschat/i18n/locale";
import { dark, light, type ThemeColors } from "@agenteschat/tokens";
import { filePath } from "@agenteschat/tokens/message-links";
import { bodyPath, bodySvg, eyeShapes } from "@agenteschat/ui/agent/engine";
import type { Context, MiddlewareHandler } from "hono";
import { signInPage } from "../routes/app/context";

/**
 * A link a person opens in a browser (a file, a download, an export, an invite, a provider's return) that the API
 * answers with an error: a page in the product's look and the person's language, with the real cause and one way
 * out, in place of the JSON (ADR 0157). Same status. Programs (the apps, agents, scripts) keep the JSON.
 */

/** A person's browser opening an address (a link, the address bar), never a program reading JSON or a download. */
export function isPageRequest(headers: Headers, method: string): boolean {
  if (method !== "GET") return false;
  const mode = headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate" && (headers.get("sec-fetch-dest") ?? "document") === "document";
  const accept = headers.get("accept") ?? "";
  const html = accept.indexOf("text/html");
  const json = accept.indexOf("application/json");
  return html >= 0 && (json < 0 || html < json);
}

export type PageCause = "signIn" | "file" | "link" | "version" | "format" | "busy" | "server" | "other";

/** What went wrong, from the API's answer: a file's absence and no access to it are one cause, as the API keeps them. */
export function causeOf(status: number, code: string, path: string): PageCause {
  if (status === 401) return "signIn";
  if (code === "artifact.version_not_found") return "version";
  if (code === "artifact.format_unavailable") return "format";
  if (status === 429) return "busy";
  if (status >= 500) return "server";
  if (status === 403 || status === 404 || status === 410) return /\/artifacts\//.test(path) ? "file" : "link";
  return "other";
}

/** The page's language: the person's saved one when signed in, else the landing's cookie, else the browser's. */
export function pageLocale(c: Context): AppLocale {
  const saved = (c.var as { user?: { locale?: string | null } }).user?.locale;
  const cookie = /(?:^|;\s*)agentes_locale=([\w-]+)/.exec(c.req.header("cookie") ?? "")?.[1];
  return appLocale([saved, cookie]) ?? requestLocale(c.req.header("accept-language")) ?? "en";
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

const BODY = bodyPath(2, 2, 28);
const EYES = eyeShapes("round")
  .map((e) => {
    const [x, y, w, h] = [2 + e.x * 28, 2 + e.y * 28, e.w * 28, e.h * 28];
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}"/>`;
  })
  .join("");
/** The app's logo (`Logo` in packages/ui): the agent mark in the sky's dither and its white eyes, then the word. */
const LOGO = `<span class="logo" role="img" aria-label="agentes"><svg viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="m"><path d="${BODY}"/></clipPath></defs><path class="body" d="${BODY}"/><image href="data:image/svg+xml,${encodeURIComponent(bodySvg("sky", 12))}" x="2" y="2" width="28" height="28" preserveAspectRatio="none" clip-path="url(#m)"/><g fill="#fff">${EYES}</g></svg><span aria-hidden="true">agentes</span></span>`;

const vars = (t: ThemeColors) =>
  `--bg:${t.bg};--raised:${t.raised};--ink:${t.ink};--muted:${t.muted};--faint:${t.faint};--line:${t.line};--agent:${t.agent};--agent2:${t.agent2};--agent-soft:${t.agentSoft}`;

/** The sky at the foot of the sign-in pages, drawn with masks as apps/web/public/unavailable.html draws it. */
const SKY_MASKS = [
  "M0 0h4v13H0zM0 13h2v1h-2zM3 13h1v1h-1zM0 14h4v1H0zM1 15h1v1h-1zM3 15h1v1h-1zM0 16h1v1h-1zM2 16h1v1h-1zM1 17h1v1h-1zM0 18h1v1h-1zM2 18h1v1h-1zM0 20h1v1h-1z",
  "M0 0h4v7H0zM1 7h1v1h-1zM3 7h1v1h-1zM0 8h3v1h-3zM1 9h1v1h-1zM3 9h1v1h-1zM0 10h1v1h-1zM2 10h1v1h-1zM0 12h1v1h-1z",
  "M0 0h4v1H0zM0 1h2v1h-2zM3 1h1v1h-1zM0 2h1v1h-1zM2 2h2v1h-2zM1 3h1v1h-1zM3 3h1v1h-1zM0 4h1v1h-1zM2 4h1v1h-1z",
].map(
  (d) =>
    `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 22' shape-rendering='crispEdges'><path d='${d}'/></svg>`)}")`,
);

const CSS = `:root{color-scheme:light dark;${vars(light)};--font-sans:Onest,"Segoe UI",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root{${vars(dark)}}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;justify-content:center;padding:96px 16px 34vh;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}
.logo{position:absolute;top:24px;left:28px;display:inline-flex;align-items:center;gap:.16em;font-size:24px;font-weight:300;letter-spacing:-.02em;line-height:1}
.logo svg{width:1.25em;height:1.25em;flex:none}
.logo .body{fill:var(--agent)}
.logo image{image-rendering:pixelated}
main{display:flex;flex-direction:column;align-items:flex-start;gap:12px;width:min(100%,460px);margin:auto 0}
h1{margin:0;font-size:24px;line-height:30px;font-weight:700;letter-spacing:-.03em;text-wrap:balance}
p{margin:0;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-self:stretch;margin-top:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 14px;border-radius:12px;border:1px solid var(--line);background:var(--raised);color:var(--ink);font-size:14px;font-weight:600;line-height:normal;text-decoration:none}
.btn--primary{border-color:transparent;background:var(--ink);color:var(--bg)}
.btn:hover{opacity:.88}
.btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--raised),0 0 0 4px var(--ink)}
.id{font-size:13px;color:var(--faint);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.sky{position:fixed;left:0;right:0;bottom:0;z-index:-1;height:132px;transform:scaleY(-1);pointer-events:none}
.sky i{position:absolute;inset:0;-webkit-mask:var(--mask) repeat-x 0 0/24px 132px;mask:var(--mask) repeat-x 0 0/24px 132px}
.sky i:nth-child(1){background:var(--agent-soft);--mask:${SKY_MASKS[0]}}
.sky i:nth-child(2){background:color-mix(in srgb,var(--agent2) 22%,var(--agent-soft));--mask:${SKY_MASKS[1]}}
.sky i:nth-child(3){background:color-mix(in srgb,var(--agent2) 44%,var(--agent-soft));--mask:${SKY_MASKS[2]}}
@media (max-width:639px){body{padding-top:72px}.logo{top:20px;left:16px}.btn{flex:1 1 100%}}`;

/** Only its own styles and the logo's picture: nothing else loads, nothing runs. */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface ErrorPageInput {
  cause: PageCause;
  locale: AppLocale;
  /** Where its one way out goes: sign in and come back, the latest version, this address again, the app. */
  action: string;
  /** The request's id, said on a failure of ours. */
  errorId?: string;
}

/** The button each cause offers. */
const ACTION_KEY: Record<PageCause, string> = {
  signIn: "signIn",
  file: "open",
  link: "open",
  version: "latest",
  format: "file",
  busy: "retry",
  server: "retry",
  other: "open",
};

export function errorPageHtml({ cause, locale, action, errorId }: ErrorPageInput): string {
  const say = (key: string, vars?: Record<string, string>) => escapeHtml(serverText(locale, `linkErrors.${key}`, vars));
  const title = say(`${cause}.title`);
  const id = cause === "server" && errorId ? `<p class="id">${say("errorId", { id: errorId })}</p>` : "";
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
${LOGO}
<main>
<h1>${title}</h1>
<p>${say(`${cause}.text`)}</p>
${id}<div class="actions"><a class="btn btn--primary" href="${escapeHtml(action)}">${say(`action.${ACTION_KEY[cause]}`)}</a></div>
</main>
<i class="sky" aria-hidden="true"><i></i><i></i><i></i></i>
</body>
</html>`;
}

/** The app's address of a file (the Drive with it open), from a file route's path: `/api/app/organizations/<org>/artifacts/<id>/…`. */
function fileAppLink(base: string, path: string): string | null {
  const m = /^\/api\/app\/organizations\/([0-9a-f-]{36})\/artifacts\/([0-9a-f-]{36})(?:\/|$)/i.exec(path);
  return m?.[1] && m[2] ? `${base}${filePath(m[1], m[2])}` : null;
}

/**
 * After every API route: a browser's navigation answered with an API error gets the page instead, with the same
 * status. The JSON's code says the cause; the request decides the way out.
 */
export function errorPages(publicUrl: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status < 400 || !isPageRequest(c.req.raw.headers, c.req.method)) return;
    const base = (publicUrl ?? new URL(c.req.url).origin).replace(/\/$/, "");
    if (!res.headers.get("content-type")?.startsWith("application/json")) return;
    const code = await res
      .clone()
      .json()
      .then((b: unknown) => {
        const said = (b as { error?: { code?: unknown } } | null)?.error?.code;
        return typeof said === "string" ? said : "";
      })
      .catch(() => "");
    const cause = causeOf(res.status, code, c.req.path);
    const file = fileAppLink(base, c.req.path);
    const here = `${base}${c.req.path}${new URL(c.req.url).search}`;
    const action =
      cause === "signIn"
        ? signInPage(base, here)
        : cause === "version" || cause === "format"
          ? (file ?? `${base}/`)
          : cause === "busy" || cause === "server"
            ? here
            : `${base}/`;
    const html = errorPageHtml({ cause, locale: pageLocale(c), action, errorId: c.get("requestId") as string });
    c.res = new Response(html, {
      status: res.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PAGE_CSP,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        vary: "accept, sec-fetch-mode, cookie",
      },
    });
  };
}
