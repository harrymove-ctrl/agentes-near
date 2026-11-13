import type { BrowserTraffic, MachineLoad, MachineSize } from "@agenteschat/adapters";
import { type CombinedTraffic, combineLoads, combineTraffic, type LoadSample } from "@agenteschat/adapters/host-stats";
import { type Database, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { catalogModelOf } from "@agenteschat/providers";
import { WEB_USAGE_PROVIDER } from "./web-tools";

const { instanceTelemetry } = schema;

/**
 * The usage report (ADR 0060 §5): counts and sizes about this installation, sent once a day to agentes.chat.
 * Never content: no messages, files, names, emails, hostnames, paths, prompts, IPs, or ids of
 * organizations, people or computers. The only id is the random `instance` made at first start.
 */
export interface TelemetryReport {
  report: 1;
  instance: string;
  version: string;
  edition: "selfhost" | "cloud";
  install: "docker" | "native" | "desktop";
  os: string;
  arch: string;
  uptimeHours: number;
  host: { size: MachineSize; container: boolean; load: MachineLoad | null };
  organizations: number;
  people: { total: number; active1d: number; active7d: number; active30d: number };
  agents: number;
  computers: TelemetryComputer[];
  lastDay: {
    runs: number;
    toolCalls: number;
    /** People watching or controlling agents' desktops, and terminals open on agents' computers. */
    desktopMinutes: number;
    terminalMinutes: number;
    models: { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number }[];
  };
}

/** Computers of one kind, system and size, seen in the last 30 days (the Cloud has hundreds alike). */
export interface TelemetryComputer {
  kind: schema.MachineKind;
  os: string;
  arch: string;
  /** Null: their runner is older than protocol 22 and nobody else said. */
  size: MachineSize | null;
  count: number;
  agents: number;
  /** Their last day: the averages averaged and the highest peaks, of those that said in the last day. */
  load: MachineLoad | null;
  /**
   * What their agents' browsers sent and received over the last day, summed (protocol 23), with the hours
   * counted on average and how many said in the last day; null when none did. Never the rest of the machine.
   */
  browserTraffic: CombinedTraffic | null;
}

/** What only the server process knows about itself. */
export type TelemetryFacts = Pick<TelemetryReport, "version" | "edition" | "install" | "os" | "arch"> & {
  host: { size: MachineSize; container: boolean };
};

const DAY_MS = 24 * 3600_000;
const ARCHES = new Set(["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64", "loong64"]);
/** Ids, not text: anything else is reported as `other`. */
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** Both lists capped, so a report stays well under the 32 KB telemetry.agentes.chat takes. */
const MAX_MODELS = 50;
const MAX_COMPUTERS = 50;

/** agentes.chat's own servers: their report always goes out, and nobody there has the switch. */
export function isAgentesCloud(publicUrl: string) {
  const host = new URL(publicUrl).hostname;
  return host === "agentes.chat" || host.endsWith(".agentes.chat");
}

/** Whether the report goes out: always on agentes.chat's own servers; elsewhere unless `TELEMETRY=off` or the switch is off. */
export function telemetrySends(config: { TELEMETRY: "on" | "off"; PUBLIC_URL: string }, enabled: boolean) {
  return isAgentesCloud(config.PUBLIC_URL) || (config.TELEMETRY === "on" && enabled);
}

/** The installation's row, made on first use with its random id. */
export async function telemetryState(db: Database) {
  await db.insert(instanceTelemetry).values({}).onConflictDoNothing();
  const [row] = await db.select().from(instanceTelemetry).where(eq(instanceTelemetry.id, 1));
  if (!row) throw new Error("instance_telemetry has no row");
  return row;
}

/** At boot: the uptime counts from now. The row as it is, with what the last process kept. */
export async function markServerStarted(db: Database, now = new Date()) {
  const [row] = await db
    .insert(instanceTelemetry)
    .values({ startedAt: now })
    .onConflictDoUpdate({ target: instanceTelemetry.id, set: { startedAt: now } })
    .returning();
  if (!row) throw new Error("instance_telemetry has no row");
  return row;
}

export async function setNextReport(db: Database, at: Date) {
  await db
    .insert(instanceTelemetry)
    .values({ nextReportAt: at })
    .onConflictDoUpdate({ target: instanceTelemetry.id, set: { nextReportAt: at } });
}

/** The owner's switch in Settings. */
export async function setTelemetryEnabled(db: Database, enabled: boolean) {
  await db
    .insert(instanceTelemetry)
    .values({ enabled })
    .onConflictDoUpdate({ target: instanceTelemetry.id, set: { enabled } });
}

/**
 * The host's last day as its newest sample leaves it, with the samples behind it; kept in the row so
 * `agentes telemetry` prints it too and a restart keeps the day.
 */
export async function saveHostLoad(
  db: Database,
  window: { summary(): MachineLoad | null; samples: readonly LoadSample[] },
  now = new Date(),
) {
  const load = window.summary();
  if (!load) return;
  const set = { hostLoad: { ...load, at: now.toISOString() }, hostSamples: [...window.samples] };
  await db.insert(instanceTelemetry).values(set).onConflictDoUpdate({ target: instanceTelemetry.id, set });
}

/** A summary from over a day ago says nothing about the last day. */
const fresh = <T extends { at: string }>(record: T | null, now: Date): Omit<T, "at"> | null => {
  if (!record || now.getTime() - Date.parse(record.at) > DAY_MS) return null;
  const { at: _at, ...rest } = record;
  return rest;
};
const int = (v: unknown) => Math.round(Number(v ?? 0));
const archOf = (arch: string) => (ARCHES.has(arch) ? arch : "other");

/** The next report, exactly as it would be sent now. */
export async function buildTelemetryReport(
  db: Database,
  facts: TelemetryFacts,
  now = new Date(),
): Promise<TelemetryReport> {
  const state = await telemetryState(db);
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const day = since(1);

  const [counts] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        (select count(*) from organizations) as organizations,
        (select count(*) from users) as people,
        (select count(*) from agents where archived_at is null and builtin is null) as agents,
        (select count(*) from agent_runs where created_at >= ${day}) as runs,
        (select count(*) from agent_run_steps where kind = 'tool_call' and created_at >= ${day}) as tool_calls,
        (select coalesce(sum((details->>'seconds')::numeric), 0) from audit_log
          where action in ('desktop.watched', 'desktop.controlled') and created_at >= ${day}
            -- A browser card's view of the screen (ADR 0058 §7) is no one using the desktop.
            and coalesce(details->>'preview', 'false') <> 'true') as desktop_seconds,
        (select coalesce(sum((details->>'seconds')::numeric), 0) from audit_log
          where action = 'terminal.session' and created_at >= ${day}) as terminal_seconds`),
  );
  // Active: their app was open (a socket to a workspace) or their session was used.
  const [active] = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select
        count(*) filter (where seen >= ${since(1)}) as d1,
        count(*) filter (where seen >= ${since(7)}) as d7,
        count(*) filter (where seen >= ${since(30)}) as d30
      from (
        select user_id, max(at) as seen from (
          select user_id, last_seen_at as at from organization_members where last_seen_at is not null
          union all
          select user_id, updated_at from sessions
        ) seen group by user_id
      ) people`),
  );
  const machines = rowsOf<{
    kind: schema.MachineKind;
    os: string;
    arch: string;
    size: MachineSize | null;
    specs: MachineSize | null;
    load: schema.MachineLoadRecord | null;
    browser_traffic: schema.MachineTrafficRecord | null;
    agents: unknown;
  }>(
    await db.execute(sql`
      select m.kind, m.os, m.arch, m.size, p.specs, m.load, m.browser_traffic,
        (select count(*) from agents a where a.machine_id = m.id and a.archived_at is null) as agents
      from machines m
      left join machine_provisioning p on m.kind = 'managed' and p.org_id = m.org_id
      where m.deleted_at is null and m.last_seen_at >= ${since(30)}
      order by m.created_at`),
  );
  type One = Omit<TelemetryComputer, "count" | "browserTraffic"> & { traffic: BrowserTraffic | null };
  const each: One[] = [];
  let host: One | undefined;
  for (const m of machines) {
    const c = {
      kind: m.kind,
      os: m.os,
      arch: archOf(m.arch),
      size: m.size ?? m.specs ?? null,
      agents: int(m.agents),
      load: fresh(m.load, now),
      traffic: fresh(m.browser_traffic, now),
    };
    // The server's own computer has a row for each organization it serves: one machine all the same, its
    // load said by each, while each row's runner counts only its own organization's browsers.
    if (m.kind === "host" && host) {
      host.agents += c.agents;
      host.size ??= c.size;
      host.load ??= c.load;
      const [a, b] = [host.traffic, c.traffic];
      host.traffic = a && b ? { up: a.up + b.up, down: a.down + b.down, hours: Math.max(a.hours, b.hours) } : (a ?? b);
      continue;
    }
    if (m.kind === "host") host = c;
    each.push(c);
  }
  const alike = new Map<
    string,
    { computer: TelemetryComputer; loads: (MachineLoad | null)[]; traffic: (BrowserTraffic | null)[] }
  >();
  for (const { load, traffic, ...c } of each) {
    const s = c.size;
    const key = JSON.stringify([c.kind, c.os, c.arch, s?.cpus, s?.memoryGb, s?.diskGb, s?.limit]);
    const group = alike.get(key);
    if (group) {
      group.computer.count += 1;
      group.computer.agents += c.agents;
      group.loads.push(load);
      group.traffic.push(traffic);
    } else {
      alike.set(key, {
        computer: { ...c, count: 1, load: null, browserTraffic: null },
        loads: [load],
        traffic: [traffic],
      });
    }
  }
  const computers = [...alike.values()]
    .map(({ computer, loads, traffic }) => ({
      ...computer,
      load: combineLoads(loads),
      browserTraffic: combineTraffic(traffic),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_COMPUTERS);

  const usage = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select provider, model, count(*) as calls,
        sum(input_tokens + cache_read_tokens + cache_write_tokens) as input_tokens, sum(output_tokens) as output_tokens
      from usage_records
      where created_at >= ${day} and provider <> ${WEB_USAGE_PROVIDER}
      group by provider, model`),
  );
  const byModel = new Map<string, TelemetryReport["lastDay"]["models"][number]>();
  for (const r of usage) {
    const provider = PROVIDER_ID.test(String(r.provider)) ? String(r.provider) : "other";
    // Only the catalog's ids: a model name someone typed (a deployment, a fine-tune, an ARN) can name a
    // company or carry an account id.
    const model = catalogModelOf(String(r.model).toLowerCase()) ?? "other";
    const key = `${provider} ${model}`;
    const row = byModel.get(key) ?? { provider, model, calls: 0, inputTokens: 0, outputTokens: 0 };
    row.calls += int(r.calls);
    row.inputTokens += int(r.input_tokens);
    row.outputTokens += int(r.output_tokens);
    byModel.set(key, row);
  }
  const models = [...byModel.values()]
    .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
    .slice(0, MAX_MODELS);

  return {
    report: 1,
    instance: state.instanceId,
    version: facts.version,
    edition: facts.edition,
    install: facts.install,
    os: facts.os,
    arch: archOf(facts.arch),
    uptimeHours: Math.max(0, Math.round((now.getTime() - state.startedAt.getTime()) / 360_000) / 10),
    host: { size: facts.host.size, container: facts.host.container, load: fresh(state.hostLoad, now) },
    organizations: int(counts?.organizations),
    people: {
      total: int(counts?.people),
      active1d: int(active?.d1),
      active7d: int(active?.d7),
      active30d: int(active?.d30),
    },
    agents: int(counts?.agents),
    computers,
    lastDay: {
      runs: int(counts?.runs),
      toolCalls: int(counts?.tool_calls),
      desktopMinutes: int(Number(counts?.desktop_seconds) / 60),
      terminalMinutes: int(Number(counts?.terminal_seconds) / 60),
      models,
    },
  };
}
