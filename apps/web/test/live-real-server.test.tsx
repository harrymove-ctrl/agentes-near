import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

/*
 * The web app against the real server: its HTTP client, its own WebSocket, the server's routes, events and presence.
 * What someone else does while my app is open must show at once, without a reload.
 */

/** What these tests use of the server's test harness (apps/server/test/harness.ts). */
type Browser = ((path: string, init?: { method?: string; json?: unknown }) => Promise<Response>) & {
  cookie: () => string;
};
interface TestServer {
  close: () => Promise<void>;
}
interface Harness {
  ORIGIN: string;
  createTestServer: (options: { env: Record<string, string> }) => Promise<TestServer>;
  listen: (t: TestServer) => { port: number; stop: (force: boolean) => Promise<void> };
  browser: (t: TestServer) => Browser;
  signUp: (b: Browser, email: string) => Promise<Response>;
  seedOrg: (b: Browser) => Promise<{ orgId: string; channelId: string }>;
  joinByInvitation: (
    t: TestServer,
    admin: Browser,
    orgId: string,
    email: string,
    options?: { role?: "member" | "admin" },
  ) => Promise<Browser>;
}
// Loaded at run time, so the web app's type check never compiles the server.
const HARNESS = "../../server/test/harness";
const { ORIGIN, browser, createTestServer, joinByInvitation, listen, seedOrg, signUp } = (await import(
  HARNESS
)) as Harness;

let t: TestServer;
let server: ReturnType<Harness["listen"]>;
// The server and its database start before the DOM is attached (PGlite looks for `window`).
beforeAll(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  server = listen(t);
});
afterAll(async () => {
  await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t.close();
});

import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { createHttpApi, UNREAD_REFRESH_MS } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { DESKTOP_QUERY } from "@/components/NavDrawer";
import { renderApp, settle } from "./render";

type SocketFactory = NonNullable<Parameters<typeof renderApp>[1]["createSocket"]>;

let media: { mockRestore: () => void } | null = null;
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

type OrgApi = (path: string, init?: Parameters<Browser>[1]) => Promise<Response>;
const orgApi =
  (b: Browser, orgId: string): OrgApi =>
  (path, init) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
const userId = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

let seq = 0;
/** Me (the owner, my app open in #general), an admin and a member. */
async function workspace(options: AppOptions = {}) {
  const n = ++seq;
  const me = browser(t);
  await signUp(me, `me${n}@example.com`);
  const { orgId, channelId } = await seedOrg(me);
  // Set up already, as a workspace in use is: opening it doesn't go through the onboarding and its arrival (ADR 0160).
  await me(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json: { finished: true } });
  const admin = await joinByInvitation(t, me, orgId, `admin${n}@example.com`, { role: "admin" });
  const member = await joinByInvitation(t, me, orgId, `member${n}@example.com`);
  const ids = { me: await userId(me), admin: await userId(admin), member: await userId(member) };
  const names = { me: `me${n}`, admin: `admin${n}`, member: `member${n}` };
  await openApp(me, `/org/${orgId}/c/${channelId}`, options);
  await real();
  const people = { me, admin, member };
  return { orgId, general: channelId, ids, names, people, as: { admin: orgApi(admin, orgId), me: orgApi(me, orgId) } };
}

type Http = ReturnType<typeof createHttpApi>;
interface AppOptions {
  /** The socket dials once this settles. */
  socketOpens?: Promise<void>;
  /** Changes the app's HTTP client (a read held on its way back). */
  api?: (http: Http) => void;
  /** Every frame the app's socket gets, before the app does. */
  onFrame?: (frame: { type?: string; event?: { type?: string; userId?: string } }) => void;
}

/** The web app, signed in as `b`. */
async function openApp(b: Browser, path: string, { socketOpens, api, onFrame }: AppOptions = {}) {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === DESKTOP_QUERY,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const http = createHttpApi({
    baseUrl: `http://127.0.0.1:${server.port}`,
    headers: () => ({ cookie: b.cookie(), origin: ORIGIN }),
  });
  const dial = (url: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws${url.slice(url.indexOf("?"))}`, {
      headers: { cookie: b.cookie(), origin: ORIGIN },
    } as unknown as string[]);
    if (onFrame) ws.addEventListener("message", (e) => onFrame(JSON.parse(String(e.data))));
    sockets.push(ws);
    return ws;
  };
  api?.(http);
  const createSocket = (socketOpens ? slowSocket(dial, socketOpens) : dial) as unknown as SocketFactory;
  return renderApp(path, { api: http, createSocket });
}

/** Another socket of `b`'s (the phone, another tab), open once the server says it's ready. */
async function otherDevice(b: Browser, orgId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`, {
    headers: { cookie: b.cookie(), origin: ORIGIN },
  } as unknown as string[]);
  sockets.push(ws);
  await new Promise<void>((resolve) => {
    ws.onmessage = (e) => {
      if ((JSON.parse(String(e.data)) as { type?: string }).type === "ready") resolve();
    };
  });
  return ws;
}

/** A socket that says nothing until `opens` settles (a slow handshake), then is the real one. */
function slowSocket(dial: (url: string) => WebSocket, opens: Promise<void>) {
  return (url: string) => {
    const handlers: Partial<Pick<WebSocket, "onopen" | "onmessage" | "onclose" | "onerror">> = {};
    let real: WebSocket | null = null;
    const proxy = {
      get readyState() {
        return real?.readyState ?? 0;
      },
      send: (data: string) => real?.send(data),
      close: () => real?.close(),
    } as unknown as WebSocket;
    for (const key of ["onopen", "onmessage", "onclose", "onerror"] as const) {
      Object.defineProperty(proxy, key, {
        set: (fn) => {
          handlers[key] = fn;
          if (real) real[key] = fn;
        },
        get: () => handlers[key],
      });
    }
    void opens.then(() => {
      real = dial(url);
      Object.assign(real, handlers);
    });
    return proxy;
  };
}

/** Time for the real server, the socket and the app's reads. */
const real = async (ms = 400) => {
  await act(() => new Promise((r) => setTimeout(r, ms)));
  await settle(8);
};
/** Past the gap between two reads of a list (`READ_GAP_MS`). */
const live = () => real(900);
/** Past the wait of a list read again on a new message or task (`UNREAD_REFRESH_MS`: a burst is one read). */
const burst = () => real(UNREAD_REFRESH_MS + 300);

const column = () => document.querySelector("aside.members-side");
const memberNames = () =>
  [...(column()?.querySelectorAll(".members-side__label") ?? [])].map((l) => l.textContent ?? "").sort();
/** The badge on a face in the members column, by name. */
const rowPresence = (name: string) =>
  [...(column()?.querySelectorAll(".members-side__inner") ?? [])]
    .find((r) => r.querySelector(".members-side__label")?.textContent === name)
    ?.querySelector(".ac-presence")
    ?.getAttribute("data-presence");
/** The badge on my face in the sidebar's account button. */
const footerPresence = () =>
  document.querySelector(".sidebar__user .ac-presence")?.getAttribute("data-presence") ?? null;
const links = () => [...document.querySelectorAll<HTMLAnchorElement>("a.sidebar__item")];
const label = (a: HTMLAnchorElement) => a.querySelector(".sidebar__item-label")?.textContent?.trim().replace(/^#/, "");
const link = (name: string) => links().find((a) => label(a) === name);
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => fireEvent.click(el as Element));
  await real();
};
const mainText = () => document.querySelector("main")?.textContent ?? "";
const navText = () => document.querySelector("nav")?.textContent ?? "";

describe("a channel someone else makes while my app is open", () => {
  test("private, made with me in it: it shows up, and opening it lists who is in it", async () => {
    const w = await workspace();
    const { id } = (await (
      await w.as.admin("/channels", { json: { name: "humans", visibility: "private" } })
    ).json()) as { id: string };
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.member } });
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.me } });
    await live();
    await click(link("humans"));
    expect(memberNames()).toEqual([w.names.admin, w.names.me, w.names.member].sort());
  });

  test("public, opened before I'm in it: the column fills when I'm added", async () => {
    const w = await workspace();
    const { id } = (await (await w.as.admin("/channels", { json: { name: "humans" } })).json()) as { id: string };
    await live();
    await click(link("humans"));
    // I own the workspace, so I read the channel and its members before I'm in it.
    expect(memberNames()).toEqual([w.names.admin]);
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.me } });
    await live();
    expect(memberNames()).toEqual([w.names.admin, w.names.me].sort());
  });

  test("opened at first sight, in the middle of its creator's burst", async () => {
    const w = await workspace();
    const { id } = (await (
      await w.as.admin("/channels", { json: { name: "humans", visibility: "private" } })
    ).json()) as { id: string };
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.me } });
    for (let k = 0; k < 100 && !link("humans"); k++) await real(10);
    await click(link("humans"));
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.member } });
    await live();
    expect(memberNames()).toEqual([w.names.admin, w.names.me, w.names.member].sort());
  });
  test("someone added while the column's first read is on its way", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let channelId = "";
    let reading = () => {};
    const read = new Promise<void>((r) => (reading = r));
    const w = await workspace({
      api: (http) => {
        const members = http.chat.members;
        http.chat.members = async (orgId, id) => {
          const list = await members(orgId, id);
          if (id !== channelId) return list;
          channelId = "";
          reading();
          await held;
          return list;
        };
      },
    });
    const { id } = (await (await w.as.admin("/channels", { json: { name: "humans" } })).json()) as { id: string };
    channelId = id;
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.me } });
    await live();
    await click(link("humans"));
    await read;
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.member } });
    await live();
    release();
    await live();
    expect(memberNames()).toEqual([w.names.admin, w.names.me, w.names.member].sort());
  });
});

describe("what changes on a channel elsewhere shows at once", () => {
  test("renamed: the sidebar and the open channel", async () => {
    const w = await workspace();
    const { id } = (await (await w.as.admin("/channels", { json: { name: "humans" } })).json()) as { id: string };
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.me } });
    await live();
    await click(link("humans"));
    expect((await w.as.admin(`/channels/${id}`, { method: "PATCH", json: { name: "people" } })).status).toBe(200);
    await live();
    expect(link("people")).toBeTruthy();
    expect(link("humans")).toBeUndefined();
    expect(mainText()).toContain("#people");
  });

  test("made private while I'm not in it: it leaves my sidebar", async () => {
    const w = await workspace();
    const { id } = (await (await w.as.admin("/channels", { json: { name: "humans" } })).json()) as { id: string };
    await live();
    expect(link("humans")).toBeTruthy();
    await w.as.admin(`/channels/${id}`, { method: "PATCH", json: { visibility: "private" } });
    await live();
    expect(link("humans")).toBeUndefined();
  });

  test("someone taken out: my column drops them", async () => {
    const w = await workspace();
    const { id } = (await (await w.as.admin("/channels", { json: { name: "humans" } })).json()) as { id: string };
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.me } });
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.member } });
    await live();
    await click(link("humans"));
    expect(memberNames()).toContain(w.names.member);
    await w.as.admin(`/channels/${id}/members/people/${w.ids.member}`, { method: "DELETE" });
    await live();
    expect(memberNames()).toEqual([w.names.admin, w.names.me].sort());
  });

  test("me taken out of a private channel: it leaves my sidebar", async () => {
    const w = await workspace();
    const { id } = (await (
      await w.as.admin("/channels", { json: { name: "humans", visibility: "private" } })
    ).json()) as { id: string };
    await w.as.admin(`/channels/${id}/members`, { json: { userId: w.ids.me } });
    await live();
    expect(link("humans")).toBeTruthy();
    await w.as.admin(`/channels/${id}/members/people/${w.ids.me}`, { method: "DELETE" });
    await live();
    expect(link("humans")).toBeUndefined();
  });
});

describe("other things that appear after my socket connected", () => {
  test("a DM someone opens with me, and their first message", async () => {
    const w = await workspace();
    const { channelId } = (await (await w.as.admin("/dms", { json: { userId: w.ids.me } })).json()) as {
      channelId: string;
    };
    await w.as.admin(`/channels/${channelId}/messages`, { json: { body: "oi, tudo bem?" } });
    await burst();
    await click(link(w.names.admin));
    expect(mainText()).toContain("oi, tudo bem?");
  });

  test("a new agent is listed", async () => {
    const w = await workspace();
    const made = await w.as.admin("/agents", {
      json: { name: "Iara", handle: "iara", model: "claude-sonnet-5-5", monthlyBudgetUsd: 10 },
    });
    expect(made.status).toBe(201);
    await live();
    expect(navText()).toContain("Iara");
  });

  test("a task someone else creates shows on my board", async () => {
    const w = await workspace();
    await click(links().find((a) => a.getAttribute("href")?.endsWith("/issues")));
    expect((await w.as.admin("/issues", { json: { title: "Revisar contrato" } })).status).toBe(201);
    await burst();
    expect(mainText()).toContain("Revisar contrato");
  });

  test("a thread someone starts under my message in the open channel", async () => {
    const w = await workspace();
    await click(link("general"));
    const root = (await (await w.as.me(`/channels/${w.general}/messages`, { json: { body: "pergunta" } })).json()) as {
      id: string;
    };
    await live();
    await w.as.admin(`/channels/${w.general}/messages`, { json: { body: "resposta", threadId: root.id } });
    await burst();
    expect(mainText()).toMatch(/1 repl/i);
  });
});

describe("my own presence", () => {
  test("my socket counted while the people's first read was on its way: online, in the column and the button", async () => {
    // The server answers the people before it counts my socket (offline), and the answer reaches the app only after
    // the server announced my arrival (`member.status`) on that socket.
    let answered = () => {};
    let announced = () => {};
    const heard = new Promise<void>((r) => (announced = r));
    let me = "";
    const w = await workspace({
      socketOpens: new Promise<void>((r) => (answered = r)),
      api: (http) => {
        const people = http.orgs.people;
        let first = true;
        http.orgs.people = async (orgId) => {
          const list = await people(orgId);
          if (!first) return list;
          first = false;
          me = list.find((p) => p.availability !== undefined)?.presence ?? "";
          answered();
          await heard;
          return list;
        };
      },
      onFrame: (f) => {
        if (f.event?.type === "member.status") setTimeout(announced, 50);
      },
    });
    expect(me).toBe("offline");
    await click(link("general"));
    await live();
    expect(rowPresence(w.names.me)).toBe("online");
    expect(footerPresence()).toBe("online");
  });

  test("invisible stays invisible: hidden to me in both places, offline to the others", async () => {
    const w = await workspace();
    await click(link("general"));
    expect((await w.as.me("/me/status", { method: "PUT", json: { availability: "hidden" } })).status).toBe(200);
    await live();
    expect(rowPresence(w.names.me)).toBe("hidden");
    expect(footerPresence()).toBe("hidden");
    const theirs = (await (await w.as.admin("/people")).json()) as { people: { userId: string; presence: string }[] };
    expect(theirs.people.find((p) => p.userId === w.ids.me)?.presence).toBe("offline");
  });

  test("someone who came while my socket was down shows when it's back", async () => {
    const w = await workspace();
    await click(link("general"));
    // My phone keeps me connected, so my tab's return isn't announced to anyone, me included.
    await otherDevice(w.people.me, w.orgId);
    expect(rowPresence(w.names.member)).toBe("offline");
    sockets[0]?.close();
    await otherDevice(w.people.member, w.orgId);
    await real(2000);
    expect(rowPresence(w.names.member)).toBe("online");
  });
});

describe("a conversation shown again after another page", () => {
  /** "Reply" on a message of the open channel: its thread in the panel. */
  const openThread = async (rootId: string) => {
    const row = document.querySelector(`article[data-message-id="${rootId}"]`) as HTMLElement;
    await act(async () => fireEvent.mouseEnter(row));
    await click(within(within(row).getByRole("toolbar")).getByRole("button", { name: "Reply" }));
    return document.querySelector("aside.thread-panel") as HTMLElement;
  };

  test("a thread open, the approvals page, a reply meanwhile, back and the thread again: the reply, and its header counts it", async () => {
    const w = await workspace();
    await click(link("general"));
    const root = (await (
      await w.as.me(`/channels/${w.general}/messages`, { json: { body: "pergunta no general" } })
    ).json()) as { id: string };
    await w.as.admin(`/channels/${w.general}/messages`, { json: { body: "primeira resposta", threadId: root.id } });
    await burst();
    const first = await openThread(root.id);
    expect(first.textContent).toContain("primeira resposta");
    await click(links().find((a) => a.getAttribute("href")?.endsWith("/approvals")));
    await w.as.admin(`/channels/${w.general}/messages`, {
      json: { body: "resposta enquanto eu aprovava", threadId: root.id },
    });
    await live();
    await click(link("general"));
    const again = await openThread(root.id);
    await live();
    expect(again.textContent).toContain("resposta enquanto eu aprovava");
    expect(again.querySelector(".thread-head__meta")?.textContent).toMatch(/2 replies/i);
  });
});
