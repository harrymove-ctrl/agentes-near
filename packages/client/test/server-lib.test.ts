import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/api/http";
import {
  APP_API,
  appPairsWith,
  checkServer,
  connectLink,
  helpUrl,
  isLoopback,
  isTailnet,
  normalizeServer,
  pairLink,
  parseConnectLink,
  readInstance,
  serverHost,
} from "../src/lib/server";

const instance = (over: Record<string, unknown> = {}) => ({
  name: "agentes.chat",
  version: "1.2.0",
  api: APP_API,
  minApi: APP_API,
  url: "https://box.tail1234.ts.net",
  signIn: { email: true, google: false, github: false, apple: false },
  signup: "invite",
  ...over,
});

/** Answers per origin; a string throws that error message instead. */
function fakeFetch(answers: Record<string, { status: number; body?: unknown } | string>): FetchLike {
  return async (url) => {
    const answer = answers[new URL(url).origin];
    if (answer === undefined || typeof answer === "string") throw new TypeError(answer ?? "Network request failed");
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  };
}

describe("server addresses", () => {
  test("a host or a full URL becomes the server's origin", () => {
    expect(normalizeServer("agentes.tail1234.ts.net")).toBe("https://agentes.tail1234.ts.net");
    expect(normalizeServer("  https://Chat.Example.com/login?x=1 ")).toBe("https://chat.example.com");
    expect(normalizeServer("box.tail1234.ts.net:8443")).toBe("https://box.tail1234.ts.net:8443");
    expect(normalizeServer("https://app.agentes.chat/")).toBe("https://app.agentes.chat");
  });

  test("https only; http just for a development build on the local network", () => {
    expect(normalizeServer("http://chat.example.com")).toBeNull();
    expect(normalizeServer("http://chat.example.com", { allowHttp: true })).toBeNull();
    expect(normalizeServer("http://192.168.0.12:3000")).toBeNull();
    expect(normalizeServer("http://192.168.0.12:3000", { allowHttp: true })).toBe("http://192.168.0.12:3000");
    expect(normalizeServer("http://localhost:3000", { allowHttp: true })).toBe("http://localhost:3000");
    expect(normalizeServer("http://mac-mini.local:3000", { allowHttp: true })).toBe("http://mac-mini.local:3000");
  });

  test("the desktop app: plain http only on this computer itself", () => {
    const loopback = { allowHttp: "loopback" } as const;
    expect(normalizeServer("http://127.0.0.1:4310", loopback)).toBe("http://127.0.0.1:4310");
    expect(normalizeServer("http://localhost:3000/login", loopback)).toBe("http://localhost:3000");
    expect(normalizeServer("http://[::1]:4310", loopback)).toBe("http://[::1]:4310");
    expect(normalizeServer("agentes.tail1234.ts.net", loopback)).toBe("https://agentes.tail1234.ts.net");
    // Typed without its scheme, as Preferences shows it: plain http on this computer.
    expect(normalizeServer("127.0.0.1:4310", loopback)).toBe("http://127.0.0.1:4310");
    expect(normalizeServer("localhost:3000/login", loopback)).toBe("http://localhost:3000");
    expect(normalizeServer("127.0.0.1:4310")).toBe("https://127.0.0.1:4310");
    for (const other of ["http://192.168.1.20:3000", "http://mac-mini.local:3000", "http://chat.example.com"])
      expect(normalizeServer(other, loopback)).toBeNull();
    expect(isLoopback("http://127.0.0.1:4310")).toBe(true);
    expect(isLoopback("http://localhost:3000")).toBe(true);
    expect(isLoopback("https://agentes.tail1234.ts.net")).toBe(false);
    expect(isLoopback("not a url")).toBe(false);
  });

  test("not a server address", () => {
    for (const bad of ["", "   ", "agentes chat", "ftp://files.example.com", "https://ana:segredo@chat.example.com"])
      expect(normalizeServer(bad)).toBeNull();
  });

  test("a space anywhere isn't an address (some URL parsers keep it in a host as %20)", () => {
    for (const bad of ["https://box.tail1234.ts.net/ x", "box.tail1234.ts.net\tx", "http://localhost:3000/ a"])
      expect(normalizeServer(bad, { allowHttp: "loopback" })).toBeNull();
  });

  test("the host to show, and whether it is on a tailnet", () => {
    expect(serverHost("https://box.tail1234.ts.net")).toBe("box.tail1234.ts.net");
    expect(serverHost("https://chat.example.com:8443")).toBe("chat.example.com:8443");
    expect(isTailnet("https://box.tail1234.ts.net")).toBe(true);
    expect(isTailnet("https://app.agentes.chat")).toBe(false);
  });
});

describe("help links", () => {
  test("a page on agentes.chat in the reader's language, with only the section after it", () => {
    expect(helpUrl("memory", "en")).toBe("https://agentes.chat/docs/memory");
    expect(helpUrl("computers", "pt-BR", "folders")).toBe("https://agentes.chat/pt/docs/computers#folders");
    expect(helpUrl("wiki", "en-GB")).toBe("https://agentes.chat/docs/wiki");
    // Any language of the app, in the docs site's folders.
    expect(helpUrl("wiki", "fr-CA")).toBe("https://agentes.chat/fr/docs/wiki");
    expect(helpUrl("wiki", "zh-TW")).toBe("https://agentes.chat/zh/docs/wiki");
    expect(helpUrl("wiki", "ko")).toBe("https://agentes.chat/ko/docs/wiki");
    expect(helpUrl("wiki", "xx")).toBe("https://agentes.chat/docs/wiki");
  });
});

describe("connect links", () => {
  const token = "Qm9vdHN0cmFwLXRva2VuLTEyMzQ1Njc4OTBhYmNkZWY";
  const claim = "b3duZXItY2xhaW0tYWJjZGVmZ2hpamtsbW5vcHFyc3R1";

  test("round trip, with and without a sign-in token", () => {
    const link = connectLink("https://box.tail1234.ts.net", { token });
    expect(link).toBe(`agenteschat://connect?server=https%3A%2F%2Fbox.tail1234.ts.net&token=${token}`);
    expect(parseConnectLink(link)).toEqual({ server: "https://box.tail1234.ts.net", token });
    expect(parseConnectLink(connectLink("https://app.agentes.chat"))).toEqual({ server: "https://app.agentes.chat" });
    expect(parseConnectLink("agenteschat:///connect?server=https://app.agentes.chat")).toEqual({
      server: "https://app.agentes.chat",
    });
  });

  test("the owner claim the setup prints, and other parameters ignored", () => {
    const link = connectLink("https://agentes.tail1234.ts.net", { claim });
    expect(parseConnectLink(link)).toEqual({ server: "https://agentes.tail1234.ts.net", claim });
    expect(parseConnectLink(`${link}&utm=qr&token=${token}`)).toEqual({
      server: "https://agentes.tail1234.ts.net",
      token,
      claim,
    });
    const local = connectLink("http://127.0.0.1:4310", { claim });
    expect(parseConnectLink(local, { allowHttp: "loopback" })).toEqual({ server: "http://127.0.0.1:4310", claim });
    expect(parseConnectLink(local)).toBeNull();
  });

  test("a token or claim that isn't one, or a link that is too long, is no link", () => {
    const base = "agenteschat://connect?server=https%3A%2F%2Fapp.agentes.chat";
    expect(parseConnectLink(`${base}&token=short`)).toBeNull();
    expect(parseConnectLink(`${base}&claim=${"x".repeat(19)}`)).toBeNull();
    expect(parseConnectLink(`${base}&claim=${encodeURIComponent("<script>alert(1)</script>xxxxxxxxxx")}`)).toBeNull();
    expect(parseConnectLink(`${base}&token=${"a".repeat(201)}`)).toBeNull();
    expect(parseConnectLink(`${base}&x=${"a".repeat(2048)}`)).toBeNull();
    expect(parseConnectLink(`${base}&token=`)).toEqual({ server: "https://app.agentes.chat" });
  });

  test("anything else is not a connect link", () => {
    for (const other of [
      "https://app.agentes.chat",
      "agenteschat://chat/123",
      "agenteschat://connect",
      "agenteschat://connect?server=",
      "agenteschat://connect?server=http%3A%2F%2Fchat.example.com",
      "WIFI:S:office;T:WPA;P:secret;;",
    ])
      expect(parseConnectLink(other)).toBeNull();
  });

  test("the desktop app's pair link: the server and the connect link's code", () => {
    expect(pairLink("https://app.agentes.chat", "K7QM-4ZPA")).toBe(
      "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=K7QM-4ZPA",
    );
    expect(parseConnectLink(pairLink("https://app.agentes.chat", "K7QM-4ZPA"))).toBeNull();
    // Only where the app takes it: https, not on this computer.
    expect(["https://app.agentes.chat", "https://chat.example.com:8443"].map(appPairsWith)).toEqual([true, true]);
    for (const other of [
      "http://192.168.1.20:3000",
      "http://chat.example.com",
      "http://localhost:3000",
      "https://localhost",
    ])
      expect(appPairsWith(other)).toBe(false);
  });
});

describe("checking a server", () => {
  test("an agentes.chat server the app can use", () => {
    expect(readInstance("https://box.tail1234.ts.net", instance())).toMatchObject({ ok: true });
  });

  test("not ours, or a version that doesn't match", () => {
    const x = "https://x";
    expect(readInstance(x, { status: "ok" })).toEqual({ ok: false, server: x, problem: "not-agentes" });
    expect(readInstance(x, null)).toEqual({ ok: false, server: x, problem: "not-agentes" });
    expect(readInstance(x, instance({ api: APP_API - 1, minApi: APP_API - 1 }))).toEqual({
      ok: false,
      server: x,
      problem: "server-too-old",
    });
    expect(readInstance(x, instance({ api: APP_API + 2, minApi: APP_API + 1 }))).toEqual({
      ok: false,
      server: x,
      problem: "app-too-old",
    });
  });

  test("asks GET /api/instance", async () => {
    const box = "https://box.tail1234.ts.net";
    const ok = await checkServer(box, fakeFetch({ [box]: { status: 200, body: instance() } }));
    expect(ok).toMatchObject({ ok: true, server: box, instance: { signup: "invite" } });
    expect(await checkServer(box, fakeFetch({ [box]: { status: 404, body: { error: "nope" } } }))).toEqual({
      ok: false,
      server: box,
      problem: "not-agentes",
    });
    expect(await checkServer(box, fakeFetch({ [box]: { status: 502 } }))).toEqual({
      ok: false,
      server: box,
      problem: "unreachable",
    });
  });

  test("a name not found reads as unreachable; a bad certificate is said as such", async () => {
    const box = "https://box.tail1234.ts.net";
    const unknownHost = 'fetch failed: Unable to resolve host "box.tail1234.ts.net"';
    expect(await checkServer(box, fakeFetch({ [box]: unknownHost }))).toEqual({
      ok: false,
      server: box,
      problem: "unreachable",
    });
    for (const tls of [
      "fetch failed: The certificate for this server is invalid.",
      "fetch failed: O certificado deste servidor é inválido.",
      "fetch failed: javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found.",
    ])
      expect(await checkServer(box, fakeFetch({ [box]: tls }))).toEqual({
        ok: false,
        server: box,
        problem: "certificate",
      });
  });

  test("gives up after the timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted."))),
      );
    expect(await checkServer("https://box.tail1234.ts.net", hang, 10)).toMatchObject({
      ok: false,
      problem: "unreachable",
    });
  });

  test("a server is used at its own address, or not at all", async () => {
    const typed = "https://chat.internal.example.com";
    const own = "https://box.tail1234.ts.net";
    const both = fakeFetch({ [typed]: { status: 200, body: instance() }, [own]: { status: 200, body: instance() } });
    expect(await checkServer(typed, both)).toMatchObject({ ok: true, server: own });
    // Its own address doesn't answer here: its realtime and pairing page wouldn't either, so the host named is that one.
    const onlyTyped = fakeFetch({ [typed]: { status: 200, body: instance() } });
    expect(await checkServer(typed, onlyTyped)).toEqual({ ok: false, server: own, problem: "unreachable" });
    // A server that calls itself by an http address keeps the one typed.
    const local = fakeFetch({ [typed]: { status: 200, body: instance({ url: "http://localhost:3000" }) } });
    expect(await checkServer(typed, local)).toMatchObject({ ok: true, server: typed });
  });

  test("a server on this computer is used at its own name for it (it accepts sign-ins only from there)", async () => {
    const asked = "http://127.0.0.1:3000";
    const own = "http://localhost:3000";
    const both = fakeFetch({
      [asked]: { status: 200, body: instance({ url: own }) },
      [own]: { status: 200, body: instance({ url: own }) },
    });
    expect(await checkServer(asked, both)).toMatchObject({ ok: true, server: own });
    // Its own name points off this computer over plain http: never followed.
    const away = fakeFetch({ [asked]: { status: 200, body: instance({ url: "http://192.168.1.20:3000" }) } });
    expect(await checkServer(asked, away)).toMatchObject({ ok: true, server: asked });
  });
});
