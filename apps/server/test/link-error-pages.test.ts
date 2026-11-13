import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { causeOf, errorPageHtml, isPageRequest } from "../src/http/error-page";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

/** What a browser sends when a person opens an address: a typed or clicked link, a page, no program. */
const OPENED = {
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "sec-fetch-site": "none",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** The page's title, its words and its one way out, as a browser reads them. */
function pageOf(html: string) {
  const text = (s: string | undefined) =>
    s
      ?.replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const action = /<a class="btn btn--primary" href="([^"]*)">([^<]*)<\/a>/.exec(html);
  return {
    title: text(/<h1>([^<]*)<\/h1>/.exec(html)?.[1]),
    text: text(/<p>([^<]*)<\/p>/.exec(html)?.[1]),
    action: action ? [text(action[1]), text(action[2])] : undefined,
  };
}

/** The owner (an administrator) and Bia, a member whose DM with the agent holds a report. */
async function world() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const base = `/api/app/organizations/${orgId}`;
  const dm = ((await (await bia(`${base}/dms`, { json: { agentId } })).json()) as { channelId: string }).channelId;
  const create = async (title: string) =>
    (await (
      await bia(`${base}/artifacts`, {
        json: { title, channelId: dm, content: { kind: "document", markdown: `# ${title}` } },
      })
    ).json()) as { id: string };
  const report = await create("Relatório");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  return { owner, bia, orgId, base, report, create, ownerId };
}

const open = (b: Browser, path: string, headers: Record<string, string> = {}) =>
  b(path, { origin: null, headers: { ...OPENED, ...headers } });

describe("a link opened in a browser that the API refuses: our page, same status (ADR 0157)", () => {
  test("a file only a DM sees: the page with its cause and one way out, never the JSON", async () => {
    const { owner, base, report } = await world();
    const res = await open(owner, `${base}/artifacts/${report.id}/file?version=1&format=pdf`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).not.toContain("Artifact not found");
    expect(pageOf(html)).toEqual({
      title: "Este arquivo não está disponível para você",
      text: "Ele pode ter sido apagado ou estar só numa conversa em que você não está. Peça a quem enviou para compartilhar com você pelo botão Compartilhar do arquivo.",
      action: ["http://localhost:3000/", "Abrir o agentes.chat"],
    });
    // The product's look: the logo and the sky of the sign-in pages.
    expect(html).toContain('class="logo"');
    expect(html).toContain('class="sky"');
    expect(html).toContain("prefers-color-scheme:dark");
  });

  test("a deleted file and an out-of-reach one give the same page", async () => {
    const { owner, bia, base, report, create } = await world();
    const gone = await create("Rascunho");
    expect((await bia(`${base}/artifacts/${gone.id}`, { method: "DELETE" })).status).toBe(204);
    const deleted = await open(bia, `${base}/artifacts/${gone.id}/file`);
    const outOfReach = await open(owner, `${base}/artifacts/${report.id}/file`);
    expect([deleted.status, outOfReach.status]).toEqual([404, 404]);
    expect(await deleted.text()).toBe(await outOfReach.text());
  });

  test("not signed in: sign in, and the sign-in page comes back to the same link", async () => {
    const { base, report } = await world();
    const stranger = browser(t);
    const res = await open(stranger, `${base}/artifacts/${report.id}/file?version=1&format=pdf`, {
      "accept-language": "en-US,en;q=0.9",
    });
    expect(res.status).toBe(401);
    const back = `${base}/artifacts/${report.id}/file?version=1&format=pdf`;
    expect(pageOf(await res.text())).toEqual({
      title: "Sign in to open this link",
      text: "Once you're in, you come right back here.",
      action: [`http://localhost:3000/login?redirect=${encodeURIComponent(back).replace(/%20/g, "+")}`, "Sign in"],
    });
  });

  test("any other API address opened in a browser: the link page, same status", async () => {
    const res = await open(browser(t), "/api/app/invitations/not-a-real-token-123", { "accept-language": "pt-BR" });
    expect(res.status).toBe(404);
    expect(pageOf(await res.text())).toEqual({
      title: "Este link não está disponível para você",
      text: "Ele pode ter expirado, já ter sido usado ou levar a um lugar em que você não está. Peça um novo a quem enviou.",
      action: ["http://localhost:3000/", "Abrir o agentes.chat"],
    });
  });

  test("the person's saved language wins over the browser's", async () => {
    const { owner, base, report } = await world();
    const res = await open(owner, `${base}/artifacts/${report.id}/file`, { "accept-language": "en" });
    expect(pageOf(await res.text()).title).toBe("Este arquivo não está disponível para você");
  });

  test("a version or a format the file doesn't have: said so, and the latest version in the app", async () => {
    const { bia, base, orgId, report } = await world();
    const version = await open(bia, `${base}/artifacts/${report.id}/file?version=9`);
    expect(version.status).toBe(404);
    expect(pageOf(await version.text())).toEqual({
      title: "Esta versão do arquivo não existe",
      text: "O link pede uma versão que o arquivo não tem.",
      action: [`http://localhost:3000/org/${orgId}/drive?artifact=${report.id}`, "Abrir a versão mais recente"],
    });
    const format = await open(bia, `${base}/artifacts/${report.id}/file?format=patch`);
    expect(format.status).toBe(400);
    expect(pageOf(await format.text())).toEqual({
      title: "Este arquivo não sai nesse formato",
      text: "O link pede um formato em que este arquivo não pode ser salvo.",
      action: [`http://localhost:3000/org/${orgId}/drive?artifact=${report.id}`, "Abrir o arquivo"],
    });
    // A link cut or garbled where its version is: that version doesn't exist, never a failure of ours.
    const garbled = await open(bia, `${base}/artifacts/${report.id}/file?version=2%26for&format=pdf`);
    expect(garbled.status).toBe(404);
    expect(pageOf(await garbled.text()).title).toBe("Esta versão do arquivo não existe");
  });

  test("programs keep the JSON exactly: the apps' fetches, the phone, scripts and a download started in the app", async () => {
    const { owner, base, report } = await world();
    const path = `${base}/artifacts/${report.id}/file?version=1&format=pdf`;
    const callers: Record<string, string>[] = [
      { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "application/json" },
      { accept: "application/json" },
      { accept: "*/*" },
      { "sec-fetch-mode": "navigate", "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" },
    ];
    for (const headers of callers) {
      const res = await owner(path, { origin: ORIGIN, headers });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Artifact not found" } });
    }
  });

  test("shared from Compartilhar, the same link opens for the owner", async () => {
    const { owner, bia, base, report, ownerId } = await world();
    const shared = await bia(`${base}/artifacts/${report.id}/sharing`, {
      method: "PUT",
      json: { mode: "people", userIds: [ownerId] },
    });
    expect(shared.status).toBe(200);
    expect(((await shared.json()) as { sharing: unknown }).sharing).toEqual({
      mode: "people",
      userIds: [ownerId],
      roleIds: [],
    });
    const res = await open(owner, `${base}/artifacts/${report.id}/file?version=1&format=pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    // The owner reads it through the sharing: he can't pass it on.
    const refused = await owner(`${base}/artifacts/${report.id}/sharing`, {
      method: "PUT",
      json: { mode: "everyone" },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("artifact.sharing_forbidden");
  });
});

describe("the page's pieces", () => {
  test("which requests are a person opening a page", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(isPageRequest(h(OPENED), "GET")).toBe(true);
    expect(isPageRequest(h({ accept: "text/html" }), "GET")).toBe(true);
    expect(isPageRequest(h(OPENED), "POST")).toBe(false);
    expect(isPageRequest(h({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "empty" }), "GET")).toBe(false);
    expect(isPageRequest(h({ accept: "application/json, text/html" }), "GET")).toBe(false);
    expect(isPageRequest(h({ accept: "*/*" }), "GET")).toBe(false);
  });

  test("each cause, from the API's answer", () => {
    const file = "/api/app/organizations/o/artifacts/a/file";
    expect(causeOf(401, "unauthorized", file)).toBe("signIn");
    expect(causeOf(404, "not_found", file)).toBe("file");
    expect(causeOf(403, "forbidden", file)).toBe("file");
    expect(causeOf(404, "not_found", "/api/app/invitations/x")).toBe("link");
    expect(causeOf(404, "artifact.version_not_found", file)).toBe("version");
    expect(causeOf(400, "artifact.format_unavailable", file)).toBe("format");
    expect(causeOf(429, "too_many", file)).toBe("busy");
    expect(causeOf(500, "internal_error", file)).toBe("server");
    expect(causeOf(400, "invalid_request", "/api/app/x")).toBe("other");
  });

  test("a failure of ours: try again, with the error's code, and never a support channel", () => {
    const html = errorPageHtml({ cause: "server", locale: "pt-BR", action: "https://x.test/a", errorId: "req-42" });
    expect(pageOf(html).title).toBe("Algo falhou do nosso lado");
    expect(html).toContain("Código do erro: req-42");
    expect(html).toContain(">Tentar de novo</a>");
    expect(html.toLowerCase()).not.toContain("suporte");
    // Every language through i18n: the title in Japanese, escaped where it goes.
    expect(pageOf(errorPageHtml({ cause: "file", locale: "ja", action: "/" })).title).toBe(
      "このファイルはあなたには公開されていません",
    );
  });
});
