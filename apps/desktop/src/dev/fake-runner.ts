/**
 * An in-browser runner for design work (`bun run dev`, ADR 0036 §10): it speaks the same control
 * protocol as `agentes-runner app` (packages/adapters/src/runner-control.ts) with realistic data
 * (two organizations, one with a logo, agents at work, a folder request), so every screen can be seen
 * without the Tauri shell. Never part of the real app's behaviour: the host picks it only outside Tauri.
 */
import type { RunnerAccess, RunnerAccountInfo, RunnerPause, RunnerPhone } from "@agenteschat/adapters/machine-protocol";
import {
  type ActivityEntry,
  CONTROL_PROTOCOL_VERSION,
  type ControlAccessRequest,
  type ControlAgent,
  type ControlConfig,
  type ControlEvent,
  type ControlIphoneSetup,
  type ControlJob,
  type ControlOut,
  type ControlStatus,
  parseControlIn,
} from "@agenteschat/adapters/runner-control";

/** The fake runners' server: one of the person's own, on a Tailscale network. */
export const FAKE_SERVER = "https://agentes.tail1234.ts.net";
const VERSION = "0.1.0";
const MACHINE_PROTOCOL = 10;

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const rid = () => Math.random().toString(36).slice(2, 10);

export interface FakeOrgSeed {
  org: { id: string; name: string };
  slug: string;
  /** The organization's logo as `org.logo` returns it; absent: the initial tile. */
  logo?: string;
  agents: ControlAgent[];
  jobs: ControlJob[];
  access: RunnerAccess;
  activity: ActivityEntry[];
  requests: ControlAccessRequest[];
}

const agent = (id: string, name: string, color: string, eyes: string, accessory: string): ControlAgent => ({
  id,
  handle: name.toLowerCase(),
  name,
  look: { color, eyes, accessory },
});

export const ACME_AGENTS = [
  agent("ag_dev", "Dev", "indigo", "wide", "headphones"),
  agent("ag_bento", "Bento", "amber", "round", "cap"),
  agent("ag_ada", "Ada", "green", "happy", "none"),
];
export const HORIZONTE_AGENTS = [
  agent("ag_lia", "Lia", "rose", "round", "flower"),
  agent("ag_nino", "Nino", "teal", "dots", "beanie"),
];

const who = (a: ControlAgent | undefined) => (a ? { id: a.id, name: a.name } : undefined);

export function acmeSeed(): FakeOrgSeed {
  const [dev, bento, ada] = ACME_AGENTS;
  return {
    org: { id: "org_acme", name: "Acme" },
    slug: "acme",
    agents: ACME_AGENTS,
    jobs: [
      {
        id: "j1",
        agent: who(dev),
        kind: "exec",
        summary: "Rodando os testes",
        where: "loja-v5",
        command: "bun test",
        startedAt: minutesAgo(2),
      },
      {
        id: "j2",
        agent: who(bento),
        kind: "write",
        summary: "Escrevendo o roteiro",
        where: "Roteiros",
        startedAt: minutesAgo(0),
      },
    ],
    access: {
      folders: [
        { path: "/Users/voce/Projects/Personal/loja-v5", agents: ["ag_dev"] },
        { path: "/Users/voce/Documents/Roteiros", agents: ["ag_bento"] },
      ],
      tools: { claude: true, codex: false, commands: true },
    },
    activity: [
      {
        at: minutesAgo(2),
        agent: who(dev),
        kind: "command",
        summary: "bun test",
        command: "bun test",
        where: "loja-v5",
        result: "running",
      },
      {
        at: minutesAgo(4),
        agent: who(bento),
        kind: "file",
        summary: "write roteiro-curitiba.md",
        where: "Roteiros",
        result: "running",
      },
      { at: minutesAgo(43), kind: "access", summary: "Roteiros allowed for Bento", result: "ok" },
      {
        at: minutesAgo(82),
        agent: who(ada),
        kind: "command",
        summary: "git diff main…feat/checkout",
        command: "git diff main…feat/checkout",
        where: "loja-v5",
        result: "ok",
      },
      {
        at: minutesAgo(60 * 22),
        agent: who(bento),
        kind: "access",
        summary: "asked for Notas: refused",
        result: "refused",
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        at: minutesAgo(60 * 26 + i * 37),
        agent: who(i % 2 ? dev : ada),
        kind: "file" as const,
        summary: `read src/file-${i}.ts`,
        where: "loja-v5",
        result: "ok" as const,
      })),
    ],
    requests: [
      {
        requestId: "req_1",
        agent: { id: "ag_bento", name: "Bento" },
        path: "/Users/voce/Projects/Personal/loja-v5/roteiros",
        reason: "Preciso dos roteiros que estão no loja-v5 para montar o vídeo de Curitiba.",
        at: minutesAgo(1),
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      },
    ],
  };
}

/** A 24×24 PNG: a white "H" on coral. */
const HORIZONTE_LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAALElEQVR42mP4n+1FFcQwatDAGgQHpEiNGkShQXjAABk0Gmu0N2i0PBrsBgEAgBRBMV74eN0AAAAASUVORK5CYII=";

export function horizonteSeed(): FakeOrgSeed {
  const [lia, nino] = HORIZONTE_AGENTS;
  return {
    org: { id: "org_horizonte", name: "Horizonte" },
    slug: "horizonte",
    logo: HORIZONTE_LOGO,
    agents: HORIZONTE_AGENTS,
    jobs: [
      {
        id: "j3",
        agent: who(lia),
        kind: "task",
        summary: "Build do site",
        where: "site",
        command: "bun run build",
        startedAt: minutesAgo(12),
        background: true,
      },
    ],
    access: {
      folders: [{ path: "/Users/voce/Projects/Horizonte/site", agents: ["ag_lia", "ag_nino"] }],
      tools: { claude: true, codex: false, commands: true },
    },
    activity: [
      {
        at: minutesAgo(12),
        agent: who(lia),
        kind: "task",
        summary: "bun run build",
        command: "bun run build",
        where: "site",
        result: "running",
      },
      {
        at: minutesAgo(60 * 20),
        agent: who(nino),
        kind: "command",
        summary: "bun test: 2 of 148 failed",
        command: "bun test",
        where: "site",
        result: "failed",
      },
      { at: minutesAgo(60 * 23), kind: "pair", summary: "connected to Horizonte", result: "ok" },
    ],
    requests: [],
  };
}

/** A workspace this computer just joined, with nothing in it yet. */
const joinedSeed = (org: { id: string; name: string }): FakeOrgSeed => ({
  org,
  slug: org.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  agents: [agent("ag_iris", "Íris", "violet", "round", "bow")],
  jobs: [],
  access: { folders: [], tools: { claude: false, codex: false, commands: false } },
  activity: [],
  requests: [],
});

/** Pair links the fake knows: the live one joins Estúdio Norte, the other one's maker says no. */
export const FAKE_LINKS = { live: "ABCDEFGH", denied: "HGFEDCBA" } as const;
const LINK_ORG = { id: "o-norte", name: "Estúdio Norte" };

/** Organizations a fake sign-in can land in, in order. */
const SIGN_IN_POOL: (() => FakeOrgSeed)[] = [
  acmeSeed,
  horizonteSeed,
  () => joinedSeed({ id: `org_${rid()}`, name: "Estúdio Norte" }),
];

const DEFAULT_CONFIG = { maxConcurrentTasks: 3, taskMaxSeconds: 4 * 3600, brainIdleMinutes: 3, brainMaxProcesses: 1 };

export class FakeRunner {
  private seed: FakeOrgSeed | null;
  private paused: RunnerPause = { paused: false };
  private connection: ControlStatus["connection"];
  private config: ControlConfig;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pairTimers: ReturnType<typeof setTimeout>[] = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private machineName = "MacBook de Você";
  /** Added Claude/Codex accounts (ADR 0041) and sign-ins in progress: done ~6 s after `account.begin`. */
  private accounts: RunnerAccountInfo[] = [
    {
      id: "4b1f2c3d-0000-4000-8000-000000000001",
      kind: "claude_code",
      loggedIn: true,
      email: "voce@acme.com",
      plan: "team",
    },
  ];
  private logins = new Map<string, { kind: RunnerAccountInfo["kind"]; doneAt: number }>();

  /** The server this home is paired with (the server here's homes point at its loopback address). */
  server = FAKE_SERVER;
  /** The code of a pairing in progress, for the fake site's confirm. */
  pendingCode: string | null = null;
  /** The phones plugged into this computer: a Pixel an agent uses, an iPhone that needs Developer Mode. */
  phones: RunnerPhone[] = [
    {
      platform: "android",
      serial: "38021FDH2000AB",
      kind: "device",
      model: "Pixel 8",
      osVersion: "16",
      state: "ready",
      transport: "usb",
      holder: {
        runId: "run_1",
        agentId: "ag_ada",
        userId: "u_rui",
        label: "Recording a test video",
        since: minutesAgo(10),
      },
    },
    {
      platform: "ios",
      serial: "00008110-000A1B2C3D4E5F60",
      kind: "device",
      model: "iPhone 16",
      name: "Sam's iPhone 16",
      osVersion: "27.1",
      state: "needs_you",
      reason: "developer_mode_off",
      transport: "usb",
    },
  ];
  /** The Mac's side of an iPhone's setup; `iphone.download` fills the platform in about a second. */
  iphone: ControlIphoneSetup = {
    xcode: "27.0",
    platform: { state: "missing" },
    account: { name: "Sam Rivera", personal: true },
  };

  constructor(
    readonly homeId: string,
    seed: FakeOrgSeed | null,
    private readonly out: (line: string) => void,
    private readonly signInIndex: () => number,
  ) {
    this.seed = seed;
    this.connection = seed ? "online" : "unpaired";
    this.config = {
      ...DEFAULT_CONFIG,
      name: this.machineName,
      workspace: `/Users/voce/agentes/${seed?.slug ?? "nova"}`,
      managedBy: "desktop",
    };
  }

  start() {
    this.write({
      type: "hello",
      control: CONTROL_PROTOCOL_VERSION,
      version: VERSION,
      protocol: MACHINE_PROTOCOL,
      home: `/Users/voce/.agentes-runner/orgs/${this.homeId}`,
    });
    this.tick = setInterval(() => this.simulate(), 7000);
  }

  stop() {
    for (const t of [...this.timers, ...this.pairTimers]) clearTimeout(t);
    if (this.tick) clearInterval(this.tick);
  }

  /** Dev controls: flip the connection to see the offline banner. */
  setOnline(online: boolean) {
    if (!this.seed) return;
    this.connection = online ? "online" : "offline";
    this.emit({ kind: "status", status: this.status() });
  }

  /** Dev controls: an agent asks for a folder now. */
  raiseRequest() {
    const s = this.seed;
    const a = s?.agents[0];
    if (!s || !a) return;
    const request: ControlAccessRequest = {
      requestId: `req_${rid()}`,
      agent: { id: a.id, name: a.name },
      path: "/Users/voce/Documents/Notas",
      reason: "Quero ler as notas da reunião de ontem para escrever o resumo.",
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    s.requests.push(request);
    this.emit({ kind: "access.requested", request });
  }

  handle(line: string) {
    const msg = parseControlIn(line);
    if (!msg) return;
    const reply = (data: unknown) => this.later(() => this.write({ type: "reply", id: msg.id, ok: true, data }), 120);
    const fail = (
      code: "not_paired" | "already_paired" | "invalid_path" | "not_found" | "bad_request",
      message: string,
    ) => this.later(() => this.write({ type: "reply", id: msg.id, ok: false, error: { code, message } }), 120);
    const s = this.seed;
    switch (msg.type) {
      case "status":
      case "executors.check":
        return reply(this.status());
      case "jobs":
        return reply({ jobs: s?.jobs ?? [] });
      case "pause":
        this.paused = { paused: true, until: msg.until };
        this.emit({ kind: "status", status: this.status() });
        return reply({ paused: this.paused });
      case "resume":
        this.paused = { paused: false };
        this.emit({ kind: "status", status: this.status() });
        return reply({ paused: this.paused });
      case "reconnect":
        if (!s) return fail("not_paired", "not paired");
        this.emit({ kind: "status", status: this.status() });
        return reply({ reconnecting: true });
      case "activity": {
        const all = (s?.activity ?? [])
          .filter((e) => !msg.agentId || e.agent?.id === msg.agentId)
          .filter((e) => !msg.before || Date.parse(e.at) < Date.parse(msg.before))
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        const limit = msg.limit ?? 50;
        return reply({ entries: all.slice(0, limit), more: all.length > limit });
      }
      case "config.get":
        return reply(this.config);
      case "config.set":
        this.config = { ...this.config, ...msg.patch };
        if (msg.patch.name) this.machineName = msg.patch.name;
        this.emit({ kind: "status", status: this.status() });
        return reply(this.config);
      case "pair.start": {
        if (s && this.connection !== "refused") return fail("already_paired", "already paired");
        reply({ started: true });
        const code = Array.from(
          { length: 6 },
          () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)],
        ).join("");
        this.pairTimers.push(
          setTimeout(() => {
            this.pendingCode = code;
            this.emit({
              kind: "pair.code",
              userCode: code,
              verificationUrl: `${FAKE_SERVER}/conectar?code=${code}`,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            });
          }, 500),
          // A link's maker answers; a plain code is confirmed by the site, or by nobody here (the fake signs in alone).
          setTimeout(
            () => {
              if (msg.link === FAKE_LINKS.denied) {
                this.pendingCode = null;
                this.emit({ kind: "pair.failed", code: "denied", message: "The connection was refused on the site" });
                return;
              }
              const make = SIGN_IN_POOL[Math.min(this.signInIndex(), SIGN_IN_POOL.length - 1)] ?? acmeSeed;
              this.join(msg.link ? joinedSeed(LINK_ORG) : make());
            },
            msg.link ? 1500 : 5500,
          ),
        );
        return;
      }
      case "pair.cancel": {
        const had = this.pairTimers.length > 0;
        for (const t of this.pairTimers) clearTimeout(t);
        this.pairTimers = [];
        this.pendingCode = null;
        return reply({ canceled: had });
      }
      case "unpair":
        this.seed = null;
        this.connection = "unpaired";
        this.emit({ kind: "status", status: this.status() });
        return reply({ unpaired: true });
      case "org.logo":
        return reply({ logo: s?.logo ?? null });
      case "diagnostics":
        return reply({
          text: `agentes ${VERSION}\nmacOS 15.1 arm64\nhome ${this.homeId}\nconnection ${this.connection}\n(no secrets)`,
        });
      case "access.get":
        return s ? reply(s.access) : fail("not_paired", "not paired");
      case "folders.add": {
        if (!s) return fail("not_paired", "not paired");
        if (
          !msg.path.startsWith("/") ||
          msg.path === "/" ||
          msg.path === "/Users/voce" ||
          msg.path.startsWith("/System")
        )
          return fail("invalid_path", "system folder");
        const found = s.access.folders.find((f) => f.path === msg.path);
        if (found) found.agents = [...new Set([...found.agents, ...msg.agents])];
        else s.access.folders.push({ path: msg.path, agents: [...msg.agents] });
        return this.accessChanged(reply);
      }
      case "folders.remove": {
        if (!s) return fail("not_paired", "not paired");
        if (msg.agentId) {
          const f = s.access.folders.find((x) => x.path === msg.path);
          if (f) f.agents = f.agents.filter((a) => a !== msg.agentId);
        } else s.access.folders = s.access.folders.filter((f) => f.path !== msg.path);
        return this.accessChanged(reply);
      }
      case "folders.setAgents": {
        if (!s) return fail("not_paired", "not paired");
        const f = s.access.folders.find((x) => x.path === msg.path);
        if (!f) return fail("not_found", "no such folder");
        f.agents = [...msg.agents];
        return this.accessChanged(reply);
      }
      case "tools.set":
        if (!s) return fail("not_paired", "not paired");
        s.access.tools = { ...s.access.tools, [msg.tool]: msg.on };
        return this.accessChanged(reply);
      case "access.pending":
        return reply({ requests: s?.requests ?? [] });
      case "access.answer": {
        if (!s) return fail("not_paired", "not paired");
        const r = s.requests.find((x) => x.requestId === msg.requestId);
        if (!r) return fail("not_found", "no such request");
        s.requests = s.requests.filter((x) => x !== r);
        if (msg.decision === "granted") {
          const agents = msg.scope === "all" ? s.agents.map((a) => a.id) : [r.agent.id];
          const f = s.access.folders.find((x) => x.path === r.path);
          if (f) f.agents = [...new Set([...f.agents, ...agents])];
          else s.access.folders.push({ path: r.path, agents });
        }
        this.emit({ kind: "access.resolved", requestId: r.requestId, decision: msg.decision });
        this.emit({ kind: "access.changed", access: s.access });
        return reply({ access: s.access });
      }
      case "accounts.list":
        return reply({ accounts: this.accounts });
      case "account.begin": {
        const loginId = crypto.randomUUID();
        this.logins.set(loginId, { kind: msg.kind, doneAt: Date.now() + 6000 });
        return reply(
          msg.kind === "codex"
            ? { loginId, url: "https://auth.openai.com/codex/device", userCode: "K7QF-4ZPXM" }
            : { loginId, url: "https://claude.ai/oauth/authorize?code=true" },
        );
      }
      case "account.status": {
        const login = this.logins.get(msg.loginId);
        if (!login) return fail("not_found", "no such sign-in");
        if (Date.now() < login.doneAt) return reply({ state: "waiting" });
        this.logins.delete(msg.loginId);
        const account: RunnerAccountInfo = {
          id: msg.loginId,
          kind: login.kind,
          loggedIn: true,
          email: login.kind === "codex" ? "voce@exemplo.com" : "voce.freela@exemplo.com",
          plan: login.kind === "codex" ? "plus" : "pro",
        };
        this.accounts.push(account);
        return reply({ state: "done", account });
      }
      case "account.cancel":
        return reply({ canceled: this.logins.delete(msg.loginId) });
      case "account.remove": {
        const before = this.accounts.length;
        this.accounts = this.accounts.filter((a) => !(a.id === msg.accountId && a.kind === msg.kind));
        return reply({ removed: this.accounts.length < before });
      }
      case "iphone.setup":
        return reply(this.iphone);
      case "iphone.download":
        if (this.iphone.platform.state === "missing" || this.iphone.platform.state === "failed") this.download();
        return reply(this.iphone);
      case "iphone.open":
        console.info("[fake] open", msg.app);
        return reply({ opened: true });
      case "shutdown":
        return reply({ stopping: true });
    }
  }

  /** The site confirmed this runner's code for `org`: it joins now. */
  confirm(org: { id: string; name: string }) {
    for (const t of this.pairTimers) clearTimeout(t);
    this.pairTimers = [];
    this.join(joinedSeed(org));
    return { machineId: `m_${this.homeId}`, name: this.machineName };
  }

  private join(seed: FakeOrgSeed) {
    seed.jobs = [];
    seed.requests = [];
    this.pendingCode = null;
    this.seed = seed;
    this.connection = "online";
    this.config.workspace = `/Users/voce/agentes/${seed.slug}`;
    this.emit({ kind: "pair.done", org: seed.org, machine: { id: `m_${this.homeId}`, name: this.machineName } });
    this.emit({ kind: "status", status: this.status() });
  }

  /** The workspace and machine this home is paired as (the fake server's devices list names them). */
  ids(): { orgId: string; machineId: string; name: string } | null {
    return this.seed ? { orgId: this.seed.org.id, machineId: `m_${this.homeId}`, name: this.machineName } : null;
  }

  private download() {
    let percent = 0;
    const step = () => {
      percent += 25;
      this.iphone = {
        ...this.iphone,
        platform:
          percent >= 100
            ? { state: "installed", version: "27.1" }
            : { state: "downloading", percent, done: `${((8.4 * percent) / 100).toFixed(1)} GB`, total: "8.4 GB" },
      };
      if (percent < 100) this.later(step, 300);
    };
    this.iphone = { ...this.iphone, platform: { state: "downloading", percent: null } };
    this.later(step, 300);
  }

  private accessChanged(reply: (data: unknown) => void) {
    const access = this.seed?.access;
    if (!access) return;
    this.emit({ kind: "access.changed", access });
    reply(access);
  }

  private status(): ControlStatus {
    const s = this.seed;
    return {
      paired: !!s,
      server: this.server,
      org: s ? { ...s.org, ...(s.logo ? { logoEtag: `"${s.org.id}.png"` } : {}) } : undefined,
      machine: s ? { id: `m_${this.homeId}`, name: this.machineName } : undefined,
      connection: this.connection,
      version: VERSION,
      protocol: MACHINE_PROTOCOL,
      paused: this.paused,
      executors: {
        claude: { version: "2.1.4 (Claude Code)", loggedIn: true, authMethod: "claude.ai", plan: "max" },
        codex: { version: "codex-cli 0.46.0" },
      },
      workspace: this.config.workspace,
      agents: s?.agents ?? [],
      access: s?.access,
      ...(s ? { phones: this.phones, user: "sam" } : {}),
    };
  }

  /** Agents come and go: a job finishes, another starts. */
  private simulate() {
    const s = this.seed;
    if (!s || this.connection !== "online" || this.paused.paused) return;
    const fg = s.jobs.filter((j) => !j.background);
    if (fg.length > 0 && Math.random() < 0.5) {
      const done = fg[0];
      if (!done) return;
      s.jobs = s.jobs.filter((j) => j !== done);
      this.emit({ kind: "job.finished", jobId: done.id, result: "ok" });
      this.emit({
        kind: "activity",
        entry: {
          at: new Date().toISOString(),
          agent: done.agent,
          kind: "command",
          summary: done.summary,
          where: done.where,
          command: done.command,
          result: "ok",
        },
      });
      return;
    }
    const a = s.agents[Math.floor(Math.random() * s.agents.length)];
    if (!a) return;
    const folder = s.access.folders[0]?.path.split("/").pop() ?? s.slug;
    const options = [
      { kind: "read" as const, summary: "Lendo o README", command: undefined },
      { kind: "exec" as const, summary: "Rodando os testes", command: "bun test" },
      { kind: "write" as const, summary: "Escrevendo notas.md", command: undefined },
    ];
    const o = options[Math.floor(Math.random() * options.length)] ?? options[0];
    if (!o) return;
    const job: ControlJob = {
      id: `j_${rid()}`,
      agent: { id: a.id, name: a.name },
      kind: o.kind,
      summary: o.summary,
      where: folder,
      command: o.command,
      startedAt: new Date().toISOString(),
    };
    s.jobs.push(job);
    this.emit({ kind: "job.started", job });
  }

  /** The phones change (plugged in, unplugged, a step further): the app hears a new status, as the runner sends. */
  setPhones(phones: RunnerPhone[]) {
    this.phones = phones;
    this.emit({ kind: "status", status: this.status() });
  }

  private emit(event: ControlEvent) {
    this.later(() => this.write({ type: "event", event }), 40);
  }

  private write(out: ControlOut) {
    this.out(JSON.stringify(out));
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(setTimeout(fn, ms));
    if (this.timers.length > 200) this.timers = this.timers.slice(-100);
  }
}
