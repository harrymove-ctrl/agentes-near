import { expect, test } from "bun:test";
import { CLOUD_SERVER } from "@agenteschat/client/lib/server";
import { serverLabel, workspaceGroups } from "@/lib/workspaces";

const OWN = "https://agentes.exemplo.com.br";

test("this server's workspaces first with their unread counts, then every other server the app is signed in to", () => {
  const groups = workspaceGroups({
    here: CLOUD_SERVER,
    orgs: [
      { id: "acme", name: "Acme", logo: "/api/app/org-logos/acme/a.png" },
      { id: "norte", name: "Estúdio Norte" },
    ],
    currentOrgId: "acme",
    unread: [
      { orgId: "acme", unread: 2 },
      { orgId: "norte", unread: 3 },
    ],
    others: [
      { server: CLOUD_SERVER, signedIn: true, orgs: [{ id: "dup", name: "Dup", logo: null, unread: 9, waiting: 0 }] },
      { server: OWN, signedIn: true, orgs: [{ id: "oficina", name: "Oficina", logo: null, unread: 1, waiting: 0 }] },
      { server: "https://sem-login.example.com", signedIn: false, orgs: [] },
      { server: "https://vazio.example.com", signedIn: true, orgs: [] },
    ],
  });
  expect(groups.map((g) => [g.name, g.here, g.cloud, g.state])).toEqual([
    ["agentes.chat", true, true, "ok"],
    ["agentes.exemplo.com.br", false, false, "ok"],
    // Signed out there: listed, with no workspaces, to sign in again.
    ["sem-login.example.com", false, false, "signedOut"],
  ]);
  expect(groups[2]?.rows).toEqual([]);
  expect(groups[0]?.rows).toEqual([
    { id: "acme", name: "Acme", logo: "/api/app/org-logos/acme/a.png", unread: 2, current: true },
    { id: "norte", name: "Estúdio Norte", logo: null, unread: 3, current: false },
  ]);
  expect(groups[1]?.rows).toEqual([{ id: "oficina", name: "Oficina", logo: null, unread: 1, current: false }]);
});

test("an older server without counts: its workspaces show with none", () => {
  const [mine] = workspaceGroups({
    here: OWN,
    orgs: [{ id: "oficina", name: "Oficina" }],
    currentOrgId: "oficina",
    unread: null,
    others: [],
  });
  expect(mine).toMatchObject({ name: "agentes.exemplo.com.br", cloud: false, rows: [{ id: "oficina", unread: 0 }] });
  expect(serverLabel(CLOUD_SERVER)).toBe("agentes.chat");
});

test("a server not answering keeps its last workspaces, marked; this computer's server says so at any address", () => {
  const groups = workspaceGroups({
    here: CLOUD_SERVER,
    orgs: [{ id: "acme", name: "Acme" }],
    currentOrgId: "acme",
    unread: null,
    others: [
      {
        server: "https://ana-mac.tail1234.ts.net",
        signedIn: true,
        here: true,
        offlineSince: 1_700_000_000_000,
        orgs: [{ id: "oficina", name: "Oficina", logo: null, unread: 0, waiting: 0 }],
      },
    ],
  });
  expect(groups[1]).toMatchObject({ thisComputer: true, state: "offline", offlineSince: 1_700_000_000_000 });
  expect(groups[1]?.rows.map((r) => r.id)).toEqual(["oficina"]);
  const [mine] = workspaceGroups({
    here: "http://127.0.0.1:4310",
    thisComputer: true,
    orgs: [],
    currentOrgId: "",
    unread: null,
    others: [],
  });
  expect(mine).toMatchObject({ thisComputer: true, state: "ok" });
});
