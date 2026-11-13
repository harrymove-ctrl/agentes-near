import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { linkPill, linkPillLabel, linkPillText } from "../src/lib/link-pills";

const t = ((key: string) => key) as unknown as TFunction;

describe("linkPill", () => {
  test.each([
    ["https://github.com/agentes-chat/agentes.chat/pull/148", "agentes.chat #148", "github"],
    ["https://github.com/agentes-chat/agentes.chat/pull/148/files#diff-1", "agentes.chat #148", "github"],
    ["https://www.github.com/agentes-chat/agentes.chat/issues/7?x=1", "agentes.chat #7", "github"],
    ["https://github.com/agentes-chat/agentes.chat/commit/a1b2c3d4e5f60718", "agentes.chat a1b2c3d", "github"],
    ["https://github.com/agentes-chat/agentes.chat/releases/tag/v1.2.0", "agentes.chat v1.2.0", "github"],
    [
      "https://github.com/agentes-chat/agentes.chat/blob/main/apps/web/src/main.tsx#L10",
      "agentes.chat main.tsx",
      "github",
    ],
    ["https://github.com/agentes-chat/agentes.chat", "agentes-chat/agentes.chat", "github"],
    ["https://gitlab.com/acme/tools/app/-/merge_requests/12", "app !12", "gitlab"],
    ["https://gitlab.com/acme/app/-/issues/3", "app #3", "gitlab"],
    ["https://gitlab.com/acme/app/-/commit/a1b2c3d4", "app a1b2c3d", "gitlab"],
    ["https://linear.app/acme/issue/ENG-123/fix-the-login", "ENG-123", "linear"],
    ["https://acme.atlassian.net/browse/PROJ-123", "PROJ-123", "jira"],
    ["https://www.figma.com/design/AbC123/Plano-de-Q4?node-id=1-2", "Plano de Q4", "figma"],
    ["https://www.figma.com/board/AbC123", "linkPills.file", "figma"],
    ["https://www.notion.so/acme/Plano-de-Q4-0123456789abcdef0123456789abcdef", "Plano de Q4", "notion"],
    ["https://acme.notion.site/Roadmap-0123456789abcdef0123456789abcdef", "Roadmap", "notion"],
    ["https://docs.google.com/document/d/1AbC_d-e/edit", "linkPills.document", "googledocs"],
    ["https://docs.google.com/spreadsheets/u/1/d/1AbC/edit#gid=0", "linkPills.spreadsheet", "googlesheets"],
    ["https://docs.google.com/presentation/d/1AbC/edit", "linkPills.presentation", "googleslides"],
    ["https://drive.google.com/file/d/1AbC/view", "linkPills.file", "googledrive"],
    ["https://drive.google.com/drive/u/0/folders/1AbC", "linkPills.folder", "googledrive"],
    ["https://dashboard.stripe.com/customers/cus_Abc123", "linkPills.customer", "stripe"],
    ["https://dashboard.stripe.com/test/invoices/in_Abc123", "linkPills.invoice", "stripe"],
    ["https://vercel.com/acme/site/FakeDeploymentId0000000000", "site", "vercel"],
  ])("%s", (href, text, mark) => {
    const pill = linkPill(href);
    expect(pill && linkPillText(t, pill)).toBe(text);
    expect(pill?.iconUrl).toBe(`/connectors/${mark}.svg`);
  });

  test.each([
    ["an unknown site", "https://example.com/a/b/pull/1"],
    ["a service's page with no fixed shape", "https://github.com/agentes-chat/agentes.chat/actions/runs/1"],
    ["github.com's own pages", "https://github.com/orgs/agentes-chat"],
    ["github.com's own pages", "https://github.com/settings/profile"],
    ["github.com itself", "https://github.com/"],
    ["an account", "https://github.com/agentes-chat"],
    ["a project's own page on Vercel", "https://vercel.com/acme/site/settings"],
    ["a Notion page with no title", "https://www.notion.so/acme/0123456789abcdef0123456789abcdef"],
    ["a lookalike host", "https://github.com.evil.example/a/b/pull/1"],
    ["a host named in the path", "https://evil.example/github.com/a/b/pull/1"],
    ["a user name before the host", "https://github.com@evil.example/a/b/pull/1"],
    ["a user name on the real host", "https://user@github.com/a/b/pull/1"],
    ["a backslash in the host", "https://evil.example\\.github.com/a/b/pull/1"],
    ["another port", "https://github.com:8443/a/b/pull/1"],
    ["Google Forms", "https://docs.google.com/forms/d/1AbC/edit"],
    [
      "a path the browser resolves elsewhere",
      "https://docs.google.com/document/d/x/../../../url?q=https://evil.example",
    ],
    ["the same, escaped", "https://docs.google.com/document/d/x/%2E%2e/%2e./.%2e/url?q=https://evil.example"],
    ["the same, with backslashes", "https://docs.google.com/document/d/x\\..\\..\\..\\url?q=https://evil.example"],
    ["the same, to another repository", "https://github.com/a/b/pull/1/../../../../c/d/pull/2"],
    ["dots for a repository", "https://github.com/../.."],
    ["a clone address", "https://github.com/agentes-chat/agentes.chat.git"],
    ["github.com's own pages", "https://github.com/search/advanced"],
    ["github.com's own pages", "https://github.com/pulls/assigned"],
    ["mail", "mailto:ana@acme.com"],
    ["not an address", "github.com/a/b/pull/1"],
  ])("stays a plain link: %s", (_why, href) => {
    expect(linkPill(href)).toBeNull();
  });

  test("a name that starts with a dot is no path trick", () => {
    expect(linkPill("https://github.com/a/b/blob/main/.github/ci.yml")?.ref).toBe("ci.yml");
    expect(linkPill("https://github.com/a/.github")?.name).toBe("a/.github");
  });

  test.each(["gitlab.com", "github.com", "www.notion.so", "www.figma.com", "linear.app", "vercel.com"])(
    "a very long address of %s reads at once",
    (host) => {
      for (const path of ["a".repeat(50_000), "a/".repeat(25_000), "a-".repeat(25_000)]) {
        const started = performance.now();
        linkPill(`https://${host}/${path}`);
        expect(performance.now() - started).toBeLessThan(100);
      }
    },
  );

  test("the words in the address never reorder the line", () => {
    expect(linkPill("https://www.figma.com/design/AbC/Plano%E2%80%AEde%0AQ4")?.name).toBe("PlanodeQ4");
    expect(linkPill("https://www.figma.com/design/AbC/100%-pronto")?.name).toBe("100% pronto");
  });

  test("a screen reader hears the service and what the icon shows", () => {
    const pill = linkPill("https://github.com/agentes-chat/agentes.chat/pull/148");
    expect(pill && linkPillLabel(t, pill)).toBe("GitHub linkPills.pull agentes.chat #148");
  });
});
