/**
 * What every window knows about the runners: one entry per organization home with its status,
 * live jobs, pending folder requests, access and the organization's logo, kept current from the
 * control protocol's events.
 * A tiny external store (`useSyncExternalStore`), no framework.
 */
import type { RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlAccessRequest,
  type ControlEvent,
  type ControlJob,
  type ControlReplies,
  type ControlRequest,
  type ControlStatus,
} from "@agenteschat/adapters/runner-control";
import type { Host, RunnerInfo } from "../host/types";
import { ControlClient, type HelloLine } from "./client";

export interface Home {
  homeId: string;
  dir: string;
  running: boolean;
  hello: HelloLine | null;
  status: ControlStatus | null;
  jobs: ControlJob[];
  requests: ControlAccessRequest[];
  access: RunnerAccess | null;
  /** The organization's logo as a `data:` URL (asked again when `status.org.logoEtag` changes); null: the initial. */
  logo: string | null;
}

export interface Snapshot {
  loaded: boolean;
  homes: Home[];
}

/** The runner speaks a control protocol this app doesn't know (development builds only). */
export const isIncompatible = (h: Home) => !!h.hello && h.hello.control !== CONTROL_PROTOCOL_VERSION;
export const isPairedHome = (h: Home) => h.status?.paired === true;
/** A home whose runner said it is paired with nothing: one still starting is neither (it may be paired). */
export const isUnpairedHome = (h: Home) => h.status?.paired === false;
export const orgName = (h: Home) => h.status?.org?.name ?? "";

/**
 * The organization refused this computer (it was removed there, or its token revoked or taken over):
 * "Reconnect this Mac" opens its Computers settings, where pairing again brings that home back as the same
 * computer.
 */
export const isRefusedHome = (h: Home) => isPairedHome(h) && h.status?.connection === "refused";

/** Paired homes, sorted by organization name (the order everything is shown in). */
export function pairedHomes(snap: Snapshot): Home[] {
  return snap.homes.filter(isPairedHome).sort((a, b) => orgName(a).localeCompare(orgName(b)));
}

export type StoreEventListener = (homeId: string, event: ControlEvent) => void;

export interface StoreOptions {
  /** A new folder request arrived (the popover window raises the macOS notification). */
  onAccessRequested?: (home: Home, request: ControlAccessRequest) => void;
  idPrefix?: string;
}

const emptyHome = (info: Pick<RunnerInfo, "homeId" | "dir" | "running" | "hello">): Home => ({
  homeId: info.homeId,
  dir: info.dir,
  running: info.running,
  hello: info.hello,
  status: null,
  jobs: [],
  requests: [],
  access: null,
  logo: null,
});

export class DesktopStore {
  readonly client: ControlClient;
  private snap: Snapshot = { loaded: false, homes: [] };
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<StoreEventListener>();
  private stops: (() => void)[] = [];
  /** Logos already fetched, by `homeId + etag` (a new etag means a new logo). */
  private readonly logos = new Map<string, string | null>();
  private readonly askingLogo = new Set<string>();
  /**
   * The newest `status.seq` seen per home (runner process). A reply asked before an event can be
   * read after it; whatever is older than what we have is dropped. Forgotten when the runner restarts.
   */
  private readonly statusSeq = new Map<string, number>();

  constructor(
    private readonly host: Host,
    private readonly options: StoreOptions = {},
  ) {
    this.client = new ControlClient(
      { send: (homeId, line) => host.send(homeId, line) },
      { idPrefix: options.idPrefix ?? `${host.window}-${Math.random().toString(36).slice(2, 8)}` },
    );
  }

  /** Starts listening; returns the stop function. */
  start(): () => void {
    this.stops.push(
      this.host.onLine((homeId, line) => this.client.receive(homeId, line)),
      this.host.onRunnerState((c) => {
        if (c.removed) {
          this.statusSeq.delete(c.homeId);
          this.client.closeHome(c.homeId);
          this.set({ homes: this.snap.homes.filter((h) => h.homeId !== c.homeId) });
          return;
        }
        if (!c.running) {
          this.statusSeq.delete(c.homeId);
          this.client.closeHome(c.homeId);
        }
        const known = this.home(c.homeId);
        if (known) this.patch(c.homeId, { running: c.running, ...(c.running ? {} : { jobs: [] }) });
        else
          this.set({
            homes: [...this.snap.homes, emptyHome({ homeId: c.homeId, dir: "", running: c.running, hello: null })],
          });
      }),
      this.client.subscribe((homeId, message) => {
        if (message.kind === "hello") {
          // A new runner process: its seq starts over.
          this.statusSeq.delete(homeId);
          if (!this.home(homeId))
            this.set({ homes: [...this.snap.homes, emptyHome({ homeId, dir: "", running: true, hello: null })] });
          this.patch(homeId, { hello: message.hello, running: true });
          void this.refresh(homeId);
          return;
        }
        this.apply(homeId, message.event);
      }),
    );
    // Brought up (windows start hidden and stay alive): read everything again, so nothing missed
    // while hidden or before this window was listening stays on screen.
    if (typeof this.host.onShown === "function") {
      this.stops.push(
        this.host.onShown((name) => {
          if (name === this.host.window) void this.reload();
        }),
      );
    }
    void this.reload();
    return () => {
      for (const s of this.stops) s();
      this.stops = [];
      // No reply can reach a request still open now: it fails at once, not on its timer seconds after its window.
      this.client.close();
    };
  }

  /** Reads the homes from the shell and refreshes each running one. */
  async reload(): Promise<void> {
    let list: RunnerInfo[] = [];
    try {
      list = await this.host.listRunners();
    } catch {
      list = [];
    }
    const homes = list.map((info) => {
      const prev = this.home(info.homeId);
      return prev
        ? { ...prev, running: info.running, hello: info.hello ?? prev.hello, dir: info.dir }
        : emptyHome(info);
    });
    this.set({ loaded: true, homes });
    await Promise.all(homes.filter((h) => h.running).map((h) => this.refresh(h.homeId)));
  }

  /** Status, jobs, requests and access of one home. */
  async refresh(homeId: string): Promise<void> {
    try {
      const reply = await this.client.request(homeId, { type: "status" });
      if (this.acceptStatus(homeId, reply)) {
        this.patch(homeId, { status: reply, access: reply.access ?? this.home(homeId)?.access ?? null });
        void this.syncLogo(homeId, reply);
      }
      // A newer status may have arrived meanwhile: go on with whichever is current.
      const status = this.home(homeId)?.status ?? reply;
      if (!status.paired) {
        this.patch(homeId, { jobs: [], requests: [] });
        return;
      }
      const [jobs, pending] = await Promise.allSettled([
        this.client.request(homeId, { type: "jobs" }),
        this.client.request(homeId, { type: "access.pending" }),
      ]);
      if (jobs.status === "fulfilled") this.patch(homeId, { jobs: jobs.value.jobs });
      if (pending.status === "fulfilled") this.patch(homeId, { requests: pending.value.requests });
      if (!status.access) {
        const access = await this.client.request(homeId, { type: "access.get" }).catch(() => null);
        if (access) this.patch(homeId, { access });
      }
    } catch {
      // The runner is starting or gone: its `hello` or state change triggers another refresh.
    }
  }

  request<R extends ControlRequest>(homeId: string, req: R): Promise<ControlReplies[R["type"]]> {
    return this.client.request(homeId, req);
  }

  /** The same request to every paired home (pause, tools, limits are for the whole computer). */
  async requestAll<R extends ControlRequest>(req: R): Promise<void> {
    const homes = pairedHomes(this.snap);
    const results = await Promise.allSettled(homes.map((h) => this.client.request(h.homeId, req)));
    const failed = results.find((r) => r.status === "rejected");
    if (failed && failed.status === "rejected") throw failed.reason;
  }

  /** A new organization home (sign-in follows with `pair.start`). */
  async addHome(): Promise<string> {
    const homeId = await this.host.addRunner();
    if (!this.home(homeId)) {
      this.set({ homes: [...this.snap.homes, emptyHome({ homeId, dir: "", running: true, hello: null })] });
    }
    return homeId;
  }

  async removeHome(homeId: string): Promise<void> {
    await this.host.removeRunner(homeId);
    this.set({ homes: this.snap.homes.filter((h) => h.homeId !== homeId) });
  }

  onEvent(listener: StoreEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  home(homeId: string): Home | undefined {
    return this.snap.homes.find((h) => h.homeId === homeId);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): Snapshot => this.snap;

  private apply(homeId: string, event: ControlEvent) {
    const home = this.home(homeId);
    switch (event.kind) {
      case "status":
        if (!this.acceptStatus(homeId, event.status)) return; // older than what is on screen
        this.patch(homeId, { status: event.status, ...(event.status.access ? { access: event.status.access } : {}) });
        void this.syncLogo(homeId, event.status);
        if (!event.status.paired) this.patch(homeId, { jobs: [], requests: [] });
        break;
      case "job.started":
        if (home) this.patch(homeId, { jobs: [...home.jobs.filter((j) => j.id !== event.job.id), event.job] });
        break;
      case "job.finished":
        if (home) this.patch(homeId, { jobs: home.jobs.filter((j) => j.id !== event.jobId) });
        break;
      case "access.requested":
        if (home && !home.requests.some((r) => r.requestId === event.request.requestId)) {
          this.patch(homeId, { requests: [...home.requests, event.request] });
          const fresh = this.home(homeId);
          if (fresh) this.options.onAccessRequested?.(fresh, event.request);
        }
        break;
      case "access.resolved":
        if (home) this.patch(homeId, { requests: home.requests.filter((r) => r.requestId !== event.requestId) });
        break;
      case "access.changed":
        this.patch(homeId, { access: event.access });
        break;
      case "pair.done":
        void this.refresh(homeId);
        break;
      default:
        break;
    }
    for (const l of [...this.eventListeners]) {
      try {
        l(homeId, event);
      } catch {
        // Keep the others going.
      }
    }
  }

  /** True when `status` is not older than the newest this home reported (and records it). */
  private acceptStatus(homeId: string, status: ControlStatus): boolean {
    if (typeof status.seq !== "number") return true; // an older runner: no order to keep
    const last = this.statusSeq.get(homeId);
    if (last !== undefined && status.seq < last) return false;
    this.statusSeq.set(homeId, status.seq);
    return true;
  }

  /** Asks the runner for the logo when its etag is one this store hasn't fetched for the home. */
  private async syncLogo(homeId: string, status: ControlStatus) {
    const etag = status.paired ? status.org?.logoEtag : undefined;
    if (!etag) {
      if (this.home(homeId)?.logo) this.patch(homeId, { logo: null });
      return;
    }
    const key = `${homeId}\n${etag}`;
    if (this.logos.has(key)) {
      const logo = this.logos.get(key) ?? null;
      if (this.home(homeId)?.logo !== logo) this.patch(homeId, { logo });
      return;
    }
    if (this.askingLogo.has(key)) return;
    this.askingLogo.add(key);
    try {
      const { logo } = await this.client.request(homeId, { type: "org.logo" });
      const safe = typeof logo === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(logo) ? logo : null;
      this.logos.set(key, safe);
      // Still the logo the runner reports (another may have arrived meanwhile).
      if (this.home(homeId)?.status?.org?.logoEtag === etag) this.patch(homeId, { logo: safe });
    } catch {
      // Asked again on the next status with this etag.
    } finally {
      this.askingLogo.delete(key);
    }
  }

  private patch(homeId: string, changes: Partial<Home>) {
    let changed = false;
    const homes = this.snap.homes.map((h) => {
      if (h.homeId !== homeId) return h;
      changed = true;
      return { ...h, ...changes };
    });
    if (changed) this.set({ homes });
  }

  private set(changes: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...changes };
    for (const l of [...this.listeners]) l();
  }
}
