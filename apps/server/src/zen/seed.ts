import type { KeyWrapper } from "@agenteschat/adapters";
import { and, eq, type Database, ensureMessagePartitions, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  createCredential,
  createDefaultRoles,
  createOrganization,
  recordAudit,
  setAgentAppearance,
} from "@agenteschat/engine";
import { hashCanonical, sha256Hex } from "./crypto";
import { ZEN_DEMO_KEY_PREFIX } from "./demo-provider";
import { appendZenReceipt, ensureZenDecisionsSeeded, ensureZenTables, upsertPqEntity } from "./ledger";

export interface DemoPersonaInfo {
  id: string;
  name: string;
  email: string;
  roleBadge: string;
  epicFocus: string;
  handle: string;
}

interface PortraitSpec {
  build?: "m" | "f";
  skin?: "s1" | "s2" | "s3" | "s4" | "s5" | "s6";
  hair?: string;
  hairColor?: string;
  beard?: string;
  glasses?: "none" | "round" | "square" | "gold" | "tinted" | "shades";
  extra?:
    | "none"
    | "headband"
    | "bandana"
    | "bow"
    | "flower"
    | "headphones"
    | "cap"
    | "beanie"
    | "hat"
    | "crown"
    | "scarf";
  ear?: string;
  neck?: "none" | "necklace" | "pearls" | "choker" | "bowtie" | "muffler";
  lips?: string;
  shadow?: string;
  blush?: "soft" | "strong" | "none";
  mark?: string;
  eyes?: "dark" | "brown" | "blue" | "green" | "gray";
  clothes?:
    | "tee"
    | "vneck"
    | "tank"
    | "shirt"
    | "suit"
    | "blazer"
    | "jacket"
    | "hoodie"
    | "turtle"
    | "overall"
    | "polo"
    | "dress";
  clothesColor?: "navy" | "black" | "white" | "gray" | "wine" | "green" | "mustard" | "blue" | "pink";
  mood?: "smile" | "grin" | "laugh" | "calm" | "wink" | "wow";
  bg?: "sky" | "indigo" | "violet" | "rose" | "amber" | "green" | "teal" | "graphite";
}

/** Encodes a 32x32 pixel portrait recipe in exact `@agenteschat/ui` FIELDS order (`#px=1....`). */
function portraitUrl(spec: PortraitSpec): string {
  const fields = [
    spec.build ?? "m",
    spec.skin ?? "s2",
    spec.hair ?? "short",
    spec.hairColor ?? "black",
    spec.beard ?? "none",
    spec.glasses ?? "none",
    spec.extra ?? "none",
    spec.ear ?? "none",
    spec.neck ?? "none",
    spec.lips ?? "none",
    spec.shadow ?? "none",
    spec.blush ?? "none",
    spec.mark ?? "none",
    spec.eyes ?? "dark",
    spec.clothes ?? "tee",
    spec.clothesColor ?? "navy",
    spec.mood ?? "smile",
    spec.bg ?? "indigo",
  ];
  return `#px=1.${fields.join(".")}`;
}

export type CommandOssTitle =
  | "Head of CommandOSS"
  | "Marketing & BD Lead"
  | "Software Engineer"
  | "External Guest";

export interface SeededMemberSpec {
  id: string;
  name: string;
  email: string;
  handle: string;
  title: CommandOssTitle;
  image: string;
  style: "technical" | "simple";
  emoji: string;
  status: string;
}

/** Real CommandOSS team roster matching https://commandoss.com/ plus Harry Phan (Software Engineer) and External Guest (F2.8). */
export const COMMANDOSS_TEAM_ROSTER: SeededMemberSpec[] = [
  {
    id: "user_zen_daniel",
    name: "Daniel Lam",
    email: "daniel.lam@commandoss.com",
    handle: "daniel",
    title: "Head of CommandOSS",
    image: portraitUrl({
      skin: "s2",
      hair: "side",
      glasses: "square",
      clothes: "jacket",
      clothesColor: "navy",
      mood: "calm",
      bg: "indigo",
    }),
    style: "simple",
    emoji: "🧭",
    status: "Head of CommandOSS · Customer Zero",
  },
  {
    id: "user_zen_tyr",
    name: "Tyr",
    email: "tyr@commandoss.com",
    handle: "tyr",
    title: "Marketing & BD Lead",
    image: portraitUrl({
      skin: "s3",
      hair: "undercut",
      glasses: "square",
      clothes: "tee",
      clothesColor: "blue",
      mood: "smile",
      bg: "sky",
    }),
    style: "simple",
    emoji: "📈",
    status: "Marketing, BD & partner ops",
  },
  {
    id: "user_zen_harry",
    name: "Harry Phan",
    email: "harry.phan@commandoss.com",
    handle: "harry",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "quiff",
      glasses: "square",
      clothes: "hoodie",
      clothesColor: "black",
      mood: "smile",
      bg: "indigo",
    }),
    style: "technical",
    emoji: "🛡️",
    status: "Software Engineer · Ergo ZEN PoC",
  },
  {
    id: "user_zen_nikola",
    name: "Nikola Le",
    email: "nikola.le@commandoss.com",
    handle: "nikola",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "short",
      glasses: "shades",
      extra: "beanie",
      neck: "necklace",
      clothes: "jacket",
      clothesColor: "black",
      mood: "calm",
      bg: "indigo",
    }),
    style: "technical",
    emoji: "🔐",
    status: "PQ vault & connector auth",
  },
  {
    id: "user_zen_uy",
    name: "Uy Le",
    email: "uy.le@commandoss.com",
    handle: "uy",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "side",
      glasses: "square",
      clothes: "shirt",
      clothesColor: "white",
      mood: "grin",
      bg: "indigo",
    }),
    style: "technical",
    emoji: "⚙️",
    status: "Durable runtime & SSE",
  },
  {
    id: "user_zen_ben",
    name: "Ben Ha",
    email: "ben.ha@commandoss.com",
    handle: "ben",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "short",
      glasses: "square",
      clothes: "tee",
      clothesColor: "black",
      mood: "smile",
      bg: "indigo",
    }),
    style: "technical",
    emoji: "🧪",
    status: "Browser verification & QA gates",
  },
  {
    id: "user_zen_hulk",
    name: "Hulk Nguyen",
    email: "hulk.nguyen@commandoss.com",
    handle: "hulk",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "crew",
      glasses: "none",
      clothes: "overall",
      clothesColor: "navy",
      mood: "smile",
      bg: "indigo",
    }),
    style: "technical",
    emoji: "🖥️",
    status: "BYOC tunnel & runner fleet",
  },
  {
    id: "user_zen_rowan",
    name: "Rowan Nguyen",
    email: "rowan.nguyen@commandoss.com",
    handle: "rowan",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "wavy",
      glasses: "round",
      clothes: "blazer",
      clothesColor: "black",
      mood: "calm",
      bg: "sky",
    }),
    style: "technical",
    emoji: "🧠",
    status: "zroute.ai multi-model gateway",
  },
  {
    id: "user_zen_ikaris",
    name: "Ikaris Dinh",
    email: "ikaris.dinh@commandoss.com",
    handle: "ikaris",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "quiff",
      glasses: "none",
      clothes: "suit",
      clothesColor: "navy",
      mood: "smile",
      bg: "indigo",
    }),
    style: "technical",
    emoji: "📦",
    status: "Open .ergo-bundle portability",
  },
  {
    id: "user_zen_toan",
    name: "Toan Nguyen",
    email: "toan.nguyen@commandoss.com",
    handle: "toan",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "short",
      glasses: "none",
      extra: "cap",
      clothes: "tee",
      clothesColor: "gray",
      mood: "grin",
      bg: "sky",
    }),
    style: "technical",
    emoji: "🔌",
    status: "Slack & Telegram channel adapters",
  },
  {
    id: "user_zen_henry",
    name: "Henry Nguyen",
    email: "henry.nguyen@commandoss.com",
    handle: "henry",
    title: "Software Engineer",
    image: portraitUrl({
      skin: "s2",
      hair: "spiky",
      glasses: "none",
      clothes: "polo",
      clothesColor: "white",
      mood: "smile",
      bg: "indigo",
    }),
    style: "technical",
    emoji: "📐",
    status: "Reviewing ZEN D1..D9 architecture",
  },
  {
    id: "user_zen_guest",
    name: "External Client",
    email: "guest@partner.example",
    handle: "partner-guest",
    title: "External Guest",
    image: portraitUrl({
      skin: "s3",
      hair: "medium",
      hairColor: "brown",
      glasses: "gold",
      clothes: "blazer",
      clothesColor: "green",
      mood: "smile",
      bg: "amber",
    }),
    style: "simple",
    emoji: "🤝",
    status: "Design partner review",
  },
];

export const ZEN_DEMO_PERSONAS: DemoPersonaInfo[] = [
  {
    id: "user_zen_harry",
    name: "Harry Phan",
    email: "harry.phan@commandoss.com",
    roleBadge: "Software Engineer · Owner",
    epicFocus: "Full E1..E16 access, Hold-to-Approve sign-off, BYOC & #exec-security",
    handle: "harry",
  },
  {
    id: "user_zen_henry",
    name: "Henry Nguyen",
    email: "henry.nguyen@commandoss.com",
    roleBadge: "Software Engineer · Tech Lead Sign-Off",
    epicFocus: "D1..D9 Decision Scorecard, ML-DSA-65 receipts & #exec-security",
    handle: "henry",
  },
  {
    id: "user_zen_daniel",
    name: "Daniel Lam",
    email: "daniel.lam@commandoss.com",
    roleBadge: "Head of CommandOSS",
    epicFocus: "Customer Zero executive oversight, #exec-security & #client-shared",
    handle: "daniel",
  },
  {
    id: "user_zen_tyr",
    name: "Tyr",
    email: "tyr@commandoss.com",
    roleBadge: "Marketing & BD Lead (M3 Non-Eng)",
    epicFocus: "Astra vendor triage (#ops-triage) & #client-shared; excluded from #exec-security",
    handle: "tyr",
  },
  {
    id: "user_zen_guest",
    name: "External Client",
    email: "guest@partner.example",
    roleBadge: "External Guest (F2.8)",
    epicFocus: "Scoped partner access (#client-shared); zero visibility into #exec-security",
    handle: "partner-guest",
  },
];

export const ALL_SEEDED_EMAILS: string[] = COMMANDOSS_TEAM_ROSTER.map((m) => m.email.toLowerCase());

export const ZEN_ORG_NAME = "CommandOSS · Ergo ZEN";

const ensuredZenDbs = new WeakSet<object>();

async function ensureZenTablesForDb(db: Database): Promise<void> {
  if (ensuredZenDbs.has(db)) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS zen_pq_entities (
      entity_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role_label TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      public_key_hex TEXT NOT NULL,
      secret_key_hex TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS zen_pq_receipts (
      seq SERIAL PRIMARY KEY,
      receipt_id TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES zen_pq_entities(entity_id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL,
      action_type TEXT NOT NULL,
      epic_ref TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      signature_hex TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS zen_tech_lead_decisions (
      decision_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      epic_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      proposal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT NOT NULL DEFAULT '',
      decided_by TEXT,
      receipt_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  ensuredZenDbs.add(db);
}

export async function seedZenWorkspace(
  db: Database,
  keyWrapper: KeyWrapper,
): Promise<{ orgId: string; seeded: boolean }> {
  await ensureZenTables(db);
  await ensureZenTablesForDb(db);
  await ensureMessagePartitions(db, 2);

  const existing = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.name, ZEN_ORG_NAME))
    .limit(1);

  if (existing[0]) {
    await ensureZenDecisionsSeeded(db, existing[0].id);
    return { orgId: existing[0].id, seeded: false };
  }

  // 1. Create the 11 CommandOSS team members + 1 External Guest with pixel portraits (E1 + E2)
  for (const person of COMMANDOSS_TEAM_ROSTER) {
    await db
      .insert(schema.users)
      .values({
        id: person.id,
        name: person.name,
        email: person.email,
        image: person.image,
        emailVerified: true,
        locale: "en",
      })
      .onConflictDoNothing();
  }

  const harryId = "user_zen_harry";
  const henryId = "user_zen_henry";
  const danielId = "user_zen_daniel";
  const tyrId = "user_zen_tyr";
  const benId = "user_zen_ben";
  const guestId = "user_zen_guest";

  // 2. Create workspace & default roles
  const { organization: org, general } = await createOrganization(db, harryId, {
    name: ZEN_ORG_NAME,
    context:
      "CommandOSS is Customer Zero (M1) for Ergo (Codename ZEN): autonomous 24/7 agent staff across engineering, QA, release, and operations, running on open multi-provider routing (zroute.ai + BYOC) with 100% post-quantum ML-DSA-65 provenance.",
  });

  await createDefaultRoles(db, org.id).catch(() => {});

  // Set workspace timezone to Asia/Ho_Chi_Minh (F2.11) & team mode
  await db
    .insert(schema.organizationSettings)
    .values({
      orgId: org.id,
      timezone: "Asia/Ho_Chi_Minh",
      teamSize: "medium",
      defaultAgentBudgetNanoUsd: 50_000_000_000,
      mode: "team",
      routerModel: "claude-haiku-5-5",
      summaryModel: "claude-haiku-5-5",
    })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: {
        timezone: "Asia/Ho_Chi_Minh",
        teamSize: "medium",
        defaultAgentBudgetNanoUsd: 50_000_000_000,
        mode: "team",
        routerModel: "claude-haiku-5-5",
        summaryModel: "claude-haiku-5-5",
      },
    });

  // Seed CommandOSS title roles matching https://commandoss.com/ + External Guest (F2.8)
  const [headRole] = await db
    .insert(schema.orgRoles)
    .values({
      orgId: org.id,
      kind: "custom",
      name: "Head of CommandOSS",
      icon: "shield",
      color: "indigo",
      position: 1,
      permissions: ["administrator"],
      mentionable: true,
      hoist: true,
    })
    .returning();

  const [marketingRole] = await db
    .insert(schema.orgRoles)
    .values({
      orgId: org.id,
      kind: "custom",
      name: "Marketing & BD Lead",
      icon: "globe",
      color: "teal",
      position: 2,
      permissions: [
        "post",
        "create_channels",
        "talk_to_agents",
        "assign_work",
        "edit_wiki",
        "upload_files",
        "invite_people",
        "view_usage",
      ],
      mentionable: true,
      hoist: true,
    })
    .returning();

  const [softwareEngineerRole] = await db
    .insert(schema.orgRoles)
    .values({
      orgId: org.id,
      kind: "custom",
      name: "Software Engineer",
      icon: "code",
      color: "violet",
      position: 3,
      permissions: [
        "post",
        "create_channels",
        "talk_to_agents",
        "assign_work",
        "manage_routines",
        "approve_actions",
        "create_agents",
        "manage_agents",
        "control_computers",
        "edit_wiki",
        "upload_files",
        "view_usage",
        "view_audit",
      ],
      mentionable: true,
      hoist: true,
    })
    .returning();

  const [guestRole] = await db
    .insert(schema.orgRoles)
    .values({
      orgId: org.id,
      kind: "custom",
      name: "External Guest",
      icon: "eye",
      color: "amber",
      position: 5,
      permissions: ["post", "talk_to_agents"],
      mentionable: true,
      hoist: true,
    })
    .returning();

  // Configure Harry Phan (owner) + insert remaining 11 workspace members with showActivity = true
  const harrySpec = COMMANDOSS_TEAM_ROSTER.find((m) => m.id === harryId)!;
  await db
    .update(schema.organizationMembers)
    .set({
      handle: harrySpec.handle,
      timezone: "Asia/Ho_Chi_Minh",
      showActivity: true,
      agentStyle: harrySpec.style,
      statusEmoji: harrySpec.emoji,
      statusText: harrySpec.status,
    })
    .where(and(eq(schema.organizationMembers.orgId, org.id), eq(schema.organizationMembers.userId, harryId)));

  for (const m of COMMANDOSS_TEAM_ROSTER) {
    if (m.id === harryId) continue;
    await db
      .insert(schema.organizationMembers)
      .values({
        orgId: org.id,
        userId: m.id,
        role: "member",
        handle: m.handle,
        timezone: "Asia/Ho_Chi_Minh",
        showActivity: true,
        agentStyle: m.style,
        statusEmoji: m.emoji,
        statusText: m.status,
      })
      .onConflictDoNothing();
  }

  const roleIdByTitle: Record<CommandOssTitle, string | undefined> = {
    "Head of CommandOSS": headRole?.id,
    "Marketing & BD Lead": marketingRole?.id,
    "Software Engineer": softwareEngineerRole?.id,
    "External Guest": guestRole?.id,
  };

  for (const m of COMMANDOSS_TEAM_ROSTER) {
    const rid = roleIdByTitle[m.title];
    if (rid) {
      await db
        .insert(schema.organizationMemberRoles)
        .values({ orgId: org.id, userId: m.id, roleId: rid })
        .onConflictDoNothing();
    }
  }

  // 3. Provider credentials (E4: Anthropic, OpenAI, Gemini + custom zroute.ai gateway F4.4)
  const anthropicCred = await createCredential(db, keyWrapper, harryId, org.id, {
    provider: "anthropic",
    label: "zroute.ai · Anthropic Route (Demo)",
    apiKey: `${ZEN_DEMO_KEY_PREFIX}ant-commandoss-0001`,
    makeDefault: true,
  });
  const openaiCred = await createCredential(db, keyWrapper, harryId, org.id, {
    provider: "openai",
    label: "zroute.ai · OpenAI Route (Demo)",
    apiKey: `${ZEN_DEMO_KEY_PREFIX}oai-commandoss-0002`,
  });
  const geminiCred = await createCredential(db, keyWrapper, harryId, org.id, {
    provider: "gemini",
    label: "zroute.ai · Gemini Route (Demo)",
    apiKey: `${ZEN_DEMO_KEY_PREFIX}gem-commandoss-0003`,
  });
  await createCredential(
    db,
    keyWrapper,
    harryId,
    org.id,
    {
      provider: "custom",
      label: "zroute.ai Unified Gateway (F4.4)",
      apiKey: `${ZEN_DEMO_KEY_PREFIX}zroute-gateway-0004`,
      endpoint: {
        style: "openai",
        baseURL: "https://api.zroute.ai/v1",
        models: [
          { id: "zroute-claude-sonnet-5-5", label: "zroute · Claude Sonnet 5.5", check: "ok" },
          { id: "zroute-gemini-4-argon", label: "zroute · Gemini 4 Argon", check: "ok" },
          { id: "byoc-qwen3-coder-32b", label: "BYOC · Qwen3 Coder 32B (Local)", check: "ok" },
        ],
      },
    },
    { net: { allowPrivate: true } },
  );

  // 4. Connected BYOC Machine (E16 + D9: outbound-only PQ tunnel, 0 inbound ports)
  const now = new Date();
  const [byocMachine] = await db
    .insert(schema.machines)
    .values({
      orgId: org.id,
      name: "ergo-byoc-mac-studio-01",
      kind: "connected",
      pairedByUserId: harryId,
      tokenHash: sha256Hex("agm_ergo_zen_byoc_demo_token"),
      hostname: "mac-studio-hcmc-01.commandoss.internal",
      os: "darwin",
      arch: "arm64",
      runnerVersion: "0.9.4-pq-mtls",
      protocol: 50,
      workspace: "/Volumes/Dev/ergo-byoc-runner",
      execAllowed: true,
      belongsToWorkspace: true,
      audienceMode: "everyone",
      online: true,
      lastSeenAt: now,
      size: { cpus: 24, memoryGb: 192, diskGb: 2048 },
      load: {
        loadAvg: 1.35,
        loadPeak: 4.1,
        memoryAvg: 0.32,
        memoryPeak: 0.56,
        diskFreeGb: 1480,
        diskUse: 0.28,
        hours: 24,
        at: now.toISOString(),
      },
      access: {
        folders: [{ path: "/Volumes/Dev/ergo-byoc-runner", agents: ["ada", "theo"] }],
        tools: {
          claude: true,
          codex: true,
          antigravity: true,
          commands: true,
          browser: true,
          terminal: true,
        },
      },
      executors: {
        claude: { version: "2.1.4", loggedIn: true, plan: "max" },
        codex: { version: "0.49.0" },
        antigravity: { version: "1.9.2" },
        browser: { available: true, chrome: "136.0" },
        terminal: { available: true },
        detectedAt: now.toISOString(),
      },
    })
    .returning();

  // 5. Agent Groups (Departments) & 4 Autonomous Agent Staff (E6 + M3)
  const [engGroup] = await db
    .insert(schema.agentGroups)
    .values({
      orgId: org.id,
      name: "Engineering & QA",
      position: 0,
      color: "violet",
      icon: "code",
      leadUserId: henryId,
      backupUserId: harryId,
    })
    .returning();

  const [opsGroup] = await db
    .insert(schema.agentGroups)
    .values({
      orgId: org.id,
      name: "Release & Operations",
      position: 1,
      color: "green",
      icon: "rocket",
      leadUserId: danielId,
      backupUserId: tyrId,
    })
    .returning();

  const ada = await createAgent(
    db,
    harryId,
    org.id,
    {
      name: "Ada",
      handle: "ada",
      role: "Staff Engineer",
      instructions:
        "You are @ada, Staff Engineer on Ergo ZEN. Own backend PRs, multi-item checkout fixes, BYOC compute execution, and open .ergo-bundle portability.",
      credentialId: anthropicCred.id,
      ownerUserId: henryId,
      monthlyBudgetNanoUsd: 40_000_000_000,
    },
    { model: "claude-sonnet-5-5" },
  );
  await setAgentAppearance(db, harryId, org.id, ada.id, {
    color: "violet",
    eyes: "happy",
    accessory: "headphones",
  });

  const theo = await createAgent(
    db,
    harryId,
    org.id,
    {
      name: "Theo",
      handle: "theo",
      role: "QA & Browser Verifier",
      instructions:
        "You are @theo, QA Engineer on Ergo ZEN. Run staging browser smoke checks, verify EARS acceptance criteria, and file reproducible tasks with Undo receipts.",
      credentialId: openaiCred.id,
      ownerUserId: benId,
      monthlyBudgetNanoUsd: 25_000_000_000,
    },
    { model: "gpt-6.1-sol" },
  );
  await setAgentAppearance(db, harryId, org.id, theo.id, {
    color: "amber",
    eyes: "wide",
    accessory: "cap",
  });

  const lia = await createAgent(
    db,
    harryId,
    org.id,
    {
      name: "Lia",
      handle: "lia",
      role: "Release Manager",
      instructions:
        "You are @lia, Release Manager on Ergo ZEN. Run morning release digests in Asia/Ho_Chi_Minh and gate production deployments behind payload-hash-bound Hold-to-Approve cards.",
      credentialId: anthropicCred.id,
      ownerUserId: harryId,
      monthlyBudgetNanoUsd: 30_000_000_000,
    },
    { model: "claude-sonnet-5-5" },
  );
  await setAgentAppearance(db, harryId, org.id, lia.id, {
    color: "rose",
    eyes: "round",
    accessory: "crown",
  });

  const astra = await createAgent(
    db,
    harryId,
    org.id,
    {
      name: "Astra",
      handle: "astra",
      role: "Business Operations",
      instructions:
        "You are @astra, Business Operations staff (M3 non-engineering). Triage vendor renewals, Slack/Telegram handle links, and partner updates while enforcing strict E9 channel memory isolation.",
      credentialId: geminiCred.id,
      ownerUserId: tyrId,
      monthlyBudgetNanoUsd: 30_000_000_000,
    },
    { model: "gemini-4-argon" },
  );
  await setAgentAppearance(db, harryId, org.id, astra.id, {
    color: "green",
    eyes: "dots",
    accessory: "antenna",
  });

  const kronos = await createAgent(
    db,
    harryId,
    org.id,
    {
      name: "Kronos",
      handle: "kronos",
      role: "NEAR Intents & TEE Treasury",
      instructions:
        "You are @kronos, NEAR Intents & OutLayer TEE Treasury Steward. Coordinate 1Click cross-chain quotes, Terrace Social conviction markets, Corpus x402 H100 TEE endowment funding ($1.84/hr), and Kanmani agent escrow settlements.",
      credentialId: anthropicCred.id,
      ownerUserId: harryId,
      monthlyBudgetNanoUsd: 35_000_000_000,
    },
    { model: "claude-sonnet-5-5" },
  );
  await setAgentAppearance(db, harryId, org.id, kronos.id, {
    color: "indigo",
    eyes: "happy",
    accessory: "headphones",
  });

  // Assign groups & BYOC machine
  await db
    .update(schema.agents)
    .set({
      groupId: engGroup?.id ?? null,
      machineId: byocMachine?.id ?? null,
      statusEmoji: "🔧",
      statusText: "PR #421 merged · BYOC ready",
      statusSource: "self",
    })
    .where(eq(schema.agents.id, ada.id));
  await db
    .update(schema.agents)
    .set({
      groupId: engGroup?.id ?? null,
      machineId: byocMachine?.id ?? null,
      statusEmoji: "🧪",
      statusText: "Staging checkout 200 OK",
      statusSource: "self",
    })
    .where(eq(schema.agents.id, theo.id));
  await db
    .update(schema.agents)
    .set({
      groupId: opsGroup?.id ?? null,
      statusEmoji: "🚀",
      statusText: "Awaiting v2.4.0 deploy sign-off",
      statusSource: "self",
    })
    .where(eq(schema.agents.id, lia.id));
  await db
    .update(schema.agents)
    .set({
      groupId: opsGroup?.id ?? null,
      statusEmoji: "📋",
      statusText: "Triaging Q4 vendor SLAs",
      statusSource: "self",
    })
    .where(eq(schema.agents.id, astra.id));
  await db
    .update(schema.agents)
    .set({
      groupId: opsGroup?.id ?? null,
      machineId: byocMachine?.id ?? null,
      statusEmoji: "⚡",
      statusText: "1Click Intents + x402 H100 TEE live",
      statusSource: "self",
    })
    .where(eq(schema.agents.id, kronos.id));

  // 6. Seed Agent Skills (F6.3 SKILL.md format)
  const seededSkills = [
    {
      slug: "pq-provenance-audit",
      name: "PQ Provenance Audit",
      description: "Verify NIST FIPS 204 ML-DSA-65 signatures and action_hash bindings before high-risk operations.",
      body: "# PQ Provenance Audit\n\n1. Canonicalize tool arguments and compute SHA-256 `action_hash`.\n2. Verify `ML-DSA-65` actor signature against `zen_pq_entities`.\n3. Fail closed (`M5 = 100%`) if any receipt link is missing.",
    },
    {
      slug: "release-smoke-gate",
      name: "Release Smoke Gate",
      description: "Run headless checkout verification across single-item and multi-item carts prior to production tags.",
      body: "# Release Smoke Gate\n\n1. Open staging checkout.\n2. Test 1-item and multi-item coupon codes (`SAVE20`).\n3. File a Kanban task automatically if HTTP >= 400.",
    },
    {
      slug: "vendor-ops-triage",
      name: "Vendor Ops Triage",
      description: "Non-engineering operations playbook (M3) for SaaS renewals, invoice diffs, and partner updates.",
      body: "# Vendor Ops Triage\n\n1. Compare invoice delta against approved PO cap.\n2. Keep private executive pricing inside `#exec-security` (`E9` zero memory bleed).",
    },
  ];
  for (const sk of seededSkills) {
    await db
      .insert(schema.skills)
      .values({
        orgId: org.id,
        slug: sk.slug,
        name: sk.name,
        description: sk.description,
        body: sk.body,
        source: "manual",
        defaultForNewAgents: true,
        createdByUserId: harryId,
      })
      .onConflictDoNothing();
  }

  // 7. Create Channels (E8 + E9 + F2.8)
  const releaseChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "release-2-4",
      topic: "Release 2.4.0 cut, staging browser smoke checks, and Hold-to-Approve production gate (E10..E14)",
      visibility: "public",
      kind: "channel",
      createdByUserId: harryId,
      position: 0,
    })
    .returning())[0]!;

  const opsChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "ops-triage",
      topic: "Business operations, Q4 vendor renewals, and signed Slack/Telegram channel intake (M3 + E8)",
      visibility: "public",
      kind: "channel",
      createdByUserId: tyrId,
      position: 2,
    })
    .returning())[0]!;

  const archChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "zen-architecture",
      topic: "Ergo (Codename ZEN) E1..E16 Tiny PRDs & Tech Lead D1..D9 Architecture Sign-Off",
      visibility: "public",
      kind: "channel",
      createdByUserId: henryId,
      position: 3,
    })
    .returning())[0]!;

  const nearIntentsChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "near-intents-arena",
      topic: "NEAR Intents 1Click multi-solver quotes + Terrace Social / Hunch / meme.cooking conviction markets (wNEAR & $AGENTES burn-on-miss)",
      visibility: "public",
      kind: "channel",
      createdByUserId: harryId,
      position: 4,
    })
    .returning())[0]!;

  const computeEndowmentChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "compute-endowment",
      topic: "Corpus x402 H100 TEE GPU-hour endowment ($1.84/hr) + Tab USDC.near BNPL + Kanmani NEP-171 agent escrow",
      visibility: "public",
      kind: "channel",
      createdByUserId: harryId,
      position: 5,
    })
    .returning())[0]!;

  const outlayerVaultChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "outlayer-tee-vault",
      topic: "OutLayer Intel TDX hardware spend guard ($25/tx, $100/day), WASI wasm32-wasip2 probes, NEP-413 & NEAR AI Cloud ITA attestation",
      visibility: "public",
      kind: "channel",
      createdByUserId: henryId,
      position: 6,
    })
    .returning())[0]!;

  const execSecChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "exec-security",
      topic: "PRIVATE (E9): Post-quantum vault rotation & enterprise pricing floor. Hidden from Guests & non-members.",
      visibility: "private",
      kind: "channel",
      createdByUserId: harryId,
      position: 7,
    })
    .returning())[0]!;

  const clientSharedChan = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: "client-shared",
      topic: "PARTNER GUEST CHANNEL (F2.8): Scoped workspace channel shared with External Client & @astra",
      visibility: "private",
      kind: "channel",
      createdByUserId: tyrId,
      position: 8,
    })
    .returning())[0]!;

  // Private DM between Harry Phan and @astra (E9 private session memory isolation)
  const dmKey = `a:${astra.id}|u:${harryId}`;
  const harryAstraDm = (await db
    .insert(schema.channels)
    .values({
      orgId: org.id,
      name: `dm-${harryId.slice(-6)}-${astra.id.slice(0, 6)}`,
      topic: "",
      visibility: "private",
      kind: "dm",
      dmKey,
      createdByUserId: harryId,
    })
    .returning())[0]!;

  // Channel memberships: all 11 CommandOSS staff join public channels
  const commandOssUsers = COMMANDOSS_TEAM_ROSTER.filter((m) => m.id !== guestId).map((m) => m.id);
  for (const uid of commandOssUsers) {
    for (const ch of [general, releaseChan, opsChan, archChan, nearIntentsChan, computeEndowmentChan, outlayerVaultChan]) {
      await db
        .insert(schema.channelMembers)
        .values({ orgId: org.id, channelId: ch.id, userId: uid })
        .onConflictDoNothing();
    }
  }
  // #exec-security: ONLY Harry Phan + Henry Nguyen + Daniel Lam + @astra + @ada
  for (const uid of [harryId, henryId, danielId]) {
    await db
      .insert(schema.channelMembers)
      .values({ orgId: org.id, channelId: execSecChan.id, userId: uid })
      .onConflictDoNothing();
  }
  // #client-shared: Harry Phan + Daniel Lam + Tyr + External Guest + @astra
  for (const uid of [harryId, danielId, tyrId, guestId]) {
    await db
      .insert(schema.channelMembers)
      .values({ orgId: org.id, channelId: clientSharedChan.id, userId: uid })
      .onConflictDoNothing();
  }
  await db
    .insert(schema.channelMembers)
    .values({ orgId: org.id, channelId: archChan.id, userId: guestId })
    .onConflictDoNothing();

  // Add agents to channels
  await addChannelMember(db, harryId, org.id, general.id, { agentId: ada.id });
  await addChannelMember(db, harryId, org.id, general.id, { agentId: astra.id });

  for (const ag of [ada, theo, lia]) {
    await addChannelMember(db, harryId, org.id, releaseChan.id, { agentId: ag.id });
  }
  await addChannelMember(db, harryId, org.id, opsChan.id, { agentId: astra.id });
  await addChannelMember(db, harryId, org.id, opsChan.id, { agentId: lia.id });
  for (const ag of [ada, theo, lia, astra, kronos]) {
    await addChannelMember(db, harryId, org.id, archChan!.id, { agentId: ag.id });
    await addChannelMember(db, harryId, org.id, nearIntentsChan!.id, { agentId: ag.id });
    await addChannelMember(db, harryId, org.id, computeEndowmentChan!.id, { agentId: ag.id });
    await addChannelMember(db, harryId, org.id, outlayerVaultChan!.id, { agentId: ag.id });
  }
  await addChannelMember(db, harryId, org.id, execSecChan.id, { agentId: astra.id });
  await addChannelMember(db, harryId, org.id, execSecChan.id, { agentId: ada.id });
  await addChannelMember(db, harryId, org.id, clientSharedChan.id, { agentId: astra.id });

  await db
    .insert(schema.channelMembers)
    .values([
      { orgId: org.id, channelId: harryAstraDm.id, userId: harryId },
      { orgId: org.id, channelId: harryAstraDm.id, agentId: astra.id },
    ])
    .onConflictDoNothing();

  // Point startChannelId so signing in lands straight on the flagship channel
  for (const uid of commandOssUsers) {
    await db
      .update(schema.organizationMembers)
      .set({ startPage: "channel", startChannelId: releaseChan.id })
      .where(and(eq(schema.organizationMembers.orgId, org.id), eq(schema.organizationMembers.userId, uid)));
  }
  await db
    .update(schema.organizationMembers)
    .set({ startPage: "channel", startChannelId: clientSharedChan.id })
    .where(and(eq(schema.organizationMembers.orgId, org.id), eq(schema.organizationMembers.userId, guestId)));

  // 8. Kanban Tasks (#14..#17) & Routines (E10)
  await db
    .insert(schema.issueCounters)
    .values({ orgId: org.id, last: 17 })
    .onConflictDoUpdate({ target: schema.issueCounters.orgId, set: { last: 17 } });

  const task14 = (await db
    .insert(schema.issues)
    .values({
      orgId: org.id,
      number: 14,
      title: "Coupon 422 on multi-item carts (SAVE20 subtotal_cents rounding)",
      description:
        "Staging smoke check hit HTTP 422 on `/api/checkout/apply-coupon` when applying `SAVE20` to a 2+ item cart. Root cause: per-line `subtotal_cents` remainder wasn't distributed before total assertion.",
      status: "in_review",
      priority: "high",
      assigneeType: "agent",
      assigneeId: ada.id,
      labels: ["release-2.4", "checkout", "regression"],
      channelId: releaseChan.id,
      pullRequests: [{ number: 421, url: "https://github.com/ErgoAILabs/ergo-zen/pull/421", openedBy: "ada" }],
      criteria: [
        { id: "c1", text: "Reproduce 422 on staging multi-item cart", done: true, doneBy: { type: "agent", id: theo.id } },
        { id: "c2", text: "Distribute coupon remainder across line items in pricing/coupons.ts", done: true, doneBy: { type: "agent", id: ada.id } },
        { id: "c3", text: "Pass 2-item and 5-item staging browser smoke checks", done: true, doneBy: { type: "agent", id: theo.id } },
      ],
      source: { type: "agent", agentId: theo.id },
      createdByType: "agent",
      createdById: theo.id,
    })
    .returning())[0]!;

  const extraTasks = [
    {
      number: 15,
      title: "Approve Tech Lead Decision Scorecard D1..D9 for ZEN Epics E8..E16",
      description: "Review the 9 architecture decisions in the Ergo ZEN D1..D9 panel and record ML-DSA-65 signed sign-offs.",
      status: "in_progress" as const,
      priority: "high" as const,
      assigneeType: "person",
      assigneeId: henryId,
      labels: ["zen-prd", "architecture"],
      channelId: archChan.id,
    },
    {
      number: 16,
      title: "Audit Q4 SaaS vendor invoice variances & renewal caps (M3 Ops)",
      description: "Astra compares October/November vendor invoices against PO limits and prepares renewal briefs for Tyr.",
      status: "in_progress" as const,
      priority: "normal" as const,
      assigneeType: "agent",
      assigneeId: astra.id,
      labels: ["operations", "m3-non-eng"],
      channelId: opsChan.id,
    },
    {
      number: 17,
      title: "Verify sub-5-minute BYOC outbound PQ tunnel enrollment (Q1..Q6)",
      description: "Benchmark `ergo-byoc-mac-studio-01` pairing with 0 inbound firewall ports open.",
      status: "done" as const,
      priority: "normal" as const,
      assigneeType: "agent",
      assigneeId: ada.id,
      labels: ["byoc", "e16", "security"],
      channelId: archChan.id,
    },
  ];
  for (const t of extraTasks) {
    await db.insert(schema.issues).values({
      orgId: org.id,
      ...t,
      createdByType: "person",
      createdById: harryId,
    });
  }

  // Routines (E10 in Asia/Ho_Chi_Minh)
  const digestRoutine = (await db
    .insert(schema.routines)
    .values({
      orgId: org.id,
      agentId: lia.id,
      name: "Release digest",
      prompt: "Summarize overnight merged PRs, open blockers, and staging release candidate readiness.",
      target: { type: "channel", channelId: releaseChan.id },
      triggerType: "schedule",
      phrase: "every weekday at 08:30",
      cron: "30 8 * * 1-5",
      timezone: "Asia/Ho_Chi_Minh",
      rule: { freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["08:30"] },
      active: true,
      access: "read",
      report: "always",
      lastRunAt: new Date(now.getTime() - 45 * 60_000),
      nextRunAt: new Date(now.getTime() + 20 * 3600_000),
      createdByUserId: harryId,
    })
    .returning())[0]!;

  await db.insert(schema.routines).values([
    {
      orgId: org.id,
      agentId: theo.id,
      name: "Staging checkout smoke",
      prompt: "Run headless checkout smoke suite on every new RC tag and file an issue on HTTP >= 400.",
      target: { type: "channel", channelId: releaseChan.id },
      triggerType: "schedule",
      phrase: "every 4 hours",
      cron: "0 */4 * * *",
      timezone: "Asia/Ho_Chi_Minh",
      rule: { freq: "hourly", interval: 4, times: ["00:00"] },
      active: true,
      access: "act",
      report: "when_new",
      lastRunAt: new Date(now.getTime() - 40 * 60_000),
      nextRunAt: new Date(now.getTime() + 3 * 3600_000),
      createdByUserId: benId,
    },
    {
      orgId: org.id,
      agentId: astra.id,
      name: "Vendor SLA & invoice sweep",
      prompt: "Scan incoming vendor invoices and contract renewal windows; post summary to #ops-triage.",
      target: { type: "channel", channelId: opsChan.id },
      triggerType: "schedule",
      phrase: "every Monday at 09:00",
      cron: "0 9 * * 1",
      timezone: "Asia/Ho_Chi_Minh",
      rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"] },
      active: true,
      access: "read",
      report: "always",
      lastRunAt: new Date(now.getTime() - 120 * 60_000),
      nextRunAt: new Date(now.getTime() + 72 * 3600_000),
      createdByUserId: tyrId,
    },
  ]);

  // 9. Seed Hero Timeline in #release-2-4 (Routine pill + Browser pixel strip + Created task #14 + Used 4 tools + Hold to approve)
  const tMinus = (mins: number) => new Date(now.getTime() - mins * 60_000);

  // Message 1: Lia Routine Digest
  const msg1Id = Bun.randomUUIDv7();
  await db.insert(schema.messages).values({
    id: msg1Id,
    createdAt: tMinus(38),
    orgId: org.id,
    channelId: releaseChan.id,
    authorType: "agent",
    authorAgentId: lia.id,
    body: "3 PRs merged overnight, 0 open blockers. Staging is on `2.4.0-rc.3` (14 commits). Ready for smoke check, @theo.",
    mentionedAgentIds: [theo.id],
    meta: {
      routine: {
        id: digestRoutine.id,
        name: "Release digest",
        runId: Bun.randomUUIDv7(),
      },
    },
  });

  // Message 2: Theo Browser Smoke Check + Created task #14
  const theoRunId = Bun.randomUUIDv7();
  const msg2Id = Bun.randomUUIDv7();
  await db.insert(schema.agentRuns).values({
    id: theoRunId,
    orgId: org.id,
    agentId: theo.id,
    channelId: releaseChan.id,
    threadRootId: msg1Id,
    triggerMessageId: msg1Id,
    trigger: "mention",
    hop: 1,
    status: "done",
    replyMessageId: msg2Id,
    issueId: task14.id,
    turns: 2,
    brain: "model",
    createdAt: tMinus(35),
    startedAt: tMinus(35),
    finishedAt: tMinus(34),
  });

  await db.insert(schema.messages).values({
    id: msg2Id,
    createdAt: tMinus(34),
    orgId: org.id,
    channelId: releaseChan.id,
    authorType: "agent",
    authorAgentId: theo.id,
    agentRunId: theoRunId,
    hop: 1,
    body: "Ran the staging checkout flow on `2.4.0-rc.3`. Single-item orders pass, but applying coupon `SAVE20` on a 2-item cart returns `HTTP 422` (`subtotal_cents` mismatch). Opened task **#14** so we hold the `2.4.0` cut until fixed.",
    meta: {
      browser: {
        steps: [
          {
            tool: "browser_open",
            detail: "staging.commandoss.dev/checkout",
            at: tMinus(35).toISOString(),
            failed: false,
          },
          {
            tool: "browser_click",
            detail: "Add 2 items + Apply SAVE20",
            at: tMinus(35).toISOString(),
            failed: false,
          },
          {
            tool: "browser_read",
            detail: "POST /checkout/coupon -> 422",
            at: tMinus(34).toISOString(),
            failed: true,
          },
          {
            tool: "browser_screenshot",
            detail: "checkout-422-multi-item.png",
            at: tMinus(34).toISOString(),
            failed: false,
          },
        ],
      },
    },
  });

  await db.insert(schema.agentActions).values({
    orgId: org.id,
    runId: theoRunId,
    agentId: theo.id,
    channelId: releaseChan.id,
    messageId: msg2Id,
    kind: "issue.created",
    targetType: "issue",
    targetId: task14.id,
    target: {
      type: "issue",
      id: task14.id,
      number: 14,
      title: "Coupon 422 on multi-item carts (SAVE20 subtotal_cents rounding)",
    },
    params: {},
    undoableUntil: new Date(now.getTime() + 24 * 3600_000),
    createdAt: tMinus(34),
  });

  // Message 3: Harry Phan steers @ada (E12 mid-run / direct assignment)
  const msg3Id = Bun.randomUUIDv7();
  await db.insert(schema.messages).values({
    id: msg3Id,
    createdAt: tMinus(28),
    orgId: org.id,
    channelId: releaseChan.id,
    authorType: "person",
    authorUserId: harryId,
    body: "@ada fix the multi-item coupon rounding on #14 on the BYOC runner and re-verify with @theo before we cut `2.4.0`.",
    mentionedAgentIds: [ada.id, theo.id],
  });

  // Message 4: Ada fixes #14 with "Used 4 tools · 12 s" expandable run steps
  const adaRunId = Bun.randomUUIDv7();
  const msg4Id = Bun.randomUUIDv7();
  await db.insert(schema.agentRuns).values({
    id: adaRunId,
    orgId: org.id,
    agentId: ada.id,
    channelId: releaseChan.id,
    threadRootId: msg3Id,
    triggerMessageId: msg3Id,
    trigger: "mention",
    hop: 1,
    status: "done",
    replyMessageId: msg4Id,
    issueId: task14.id,
    turns: 3,
    brain: "model",
    createdAt: tMinus(26),
    startedAt: tMinus(26),
    finishedAt: tMinus(25),
  });

  const adaSteps = [
    {
      seq: 1,
      kind: "tool_call" as const,
      data: { id: "tc_1", name: "read_issue", input: { number: 14 } },
    },
    {
      seq: 2,
      kind: "tool_result" as const,
      data: { toolUseId: "tc_1", name: "read_issue", content: "Task #14: subtotal_cents rounding on SAVE20", isError: false },
    },
    {
      seq: 3,
      kind: "tool_call" as const,
      data: { id: "tc_2", name: "run_command", input: { command: "bun test packages/pricing/coupons.test.ts" } },
    },
    {
      seq: 4,
      kind: "tool_result" as const,
      data: { toolUseId: "tc_2", name: "run_command", content: "14 pass, 0 fail (2-item & 5-item remainder verified)", isError: false },
    },
    {
      seq: 5,
      kind: "tool_call" as const,
      data: { id: "tc_3", name: "github_create_pull_request", input: { repo: "ErgoAILabs/ergo-zen", title: "fix(pricing): distribute multi-item coupon remainder (#421)" } },
    },
    {
      seq: 6,
      kind: "tool_result" as const,
      data: { toolUseId: "tc_3", name: "github_create_pull_request", content: "Opened PR #421 and deployed to staging 2.4.0-rc.4", isError: false },
    },
  ];
  for (const s of adaSteps) {
    await db.insert(schema.agentRunSteps).values({
      orgId: org.id,
      runId: adaRunId,
      seq: s.seq,
      kind: s.kind,
      data: s.data,
      createdAt: tMinus(25),
    });
  }

  await db.insert(schema.messages).values({
    id: msg4Id,
    createdAt: tMinus(25),
    orgId: org.id,
    channelId: releaseChan.id,
    authorType: "agent",
    authorAgentId: ada.id,
    agentRunId: adaRunId,
    hop: 1,
    body: "Fixed `subtotal_cents` remainder allocation in `packages/pricing/coupons.ts` on `ergo-byoc-mac-studio-01`, added 2-item and 5-item unit tests, and shipped **PR #421** (`2.4.0-rc.4`). @theo re-ran staging checkout: `200 OK`. Ready for @lia to cut production.",
    meta: {
      work: {
        steps: 4,
        durationMs: 11_800,
        calls: [
          { name: "read_issue", n: 1 },
          { name: "run_command", n: 2 },
          { name: "github_create_pull_request", connector: "github", service: "github", n: 1 },
        ],
      },
    },
  });

  // Message 5: Lia posts live pending "Hold to approve" card (E14 + D7 payload-hash-bound approval)
  const liaApprovalRunId = Bun.randomUUIDv7();
  const approvalMsgId = Bun.randomUUIDv7();
  const approvalId = Bun.randomUUIDv7();
  const deployParams = {
    repository: "ErgoAILabs/ergo-zen",
    environment: "production",
    tag: "v2.4.0",
    commitSha: "9f42c18e7b204d11a83c",
    smokeVerifiedBy: "@theo",
  };
  const deployActionHash = hashCanonical({
    tool: "github_create_deployment",
    scope: "github:deployments:write",
    connectionId: null,
    params: deployParams,
  });

  await db.insert(schema.agentRuns).values({
    id: liaApprovalRunId,
    orgId: org.id,
    agentId: lia.id,
    channelId: releaseChan.id,
    threadRootId: msg3Id,
    triggerMessageId: msg4Id,
    trigger: "mention",
    hop: 2,
    status: "waiting_approval",
    turns: 1,
    brain: "model",
    createdAt: tMinus(20),
    startedAt: tMinus(20),
  });

  await db.insert(schema.messages).values({
    id: approvalMsgId,
    createdAt: tMinus(20),
    orgId: org.id,
    channelId: releaseChan.id,
    authorType: "agent",
    authorAgentId: lia.id,
    agentRunId: liaApprovalRunId,
    hop: 2,
    body: "",
    meta: { approvalId },
  });

  await db.insert(schema.approvals).values({
    id: approvalId,
    orgId: org.id,
    runId: liaApprovalRunId,
    agentId: lia.id,
    channelId: releaseChan.id,
    threadRootId: msg3Id,
    messageId: approvalMsgId,
    toolUseId: "toolu_zen_deploy_240",
    tool: "github_create_deployment",
    scope: "github:deployments:write",
    params: deployParams,
    actionHash: deployActionHash,
    title: "Deploy release v2.4.0 to production",
    detail: `ErgoAILabs/ergo-zen · tag v2.4.0 · sha256=${deployActionHash.slice(0, 16)}…`,
    why: "PR #421 resolved task #14 (multi-item SAVE20 rounding) and passed @theo's 2-item and 5-item staging browser smoke checks. Payload SHA-256 bound against TOCTOU mutation (ZEN-AC14.3).",
    status: "pending",
    ownerUserId: harryId,
    requestedByUserId: harryId,
    highRisk: true,
    expiresAt: new Date(now.getTime() + 48 * 3600_000),
    createdAt: tMinus(20),
  });

  // 10. Seed messages in #ops-triage, #zen-architecture, #exec-security, #client-shared, and Harry<->Astra DM
  await db.insert(schema.messages).values([
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(50),
      orgId: org.id,
      channelId: general.id,
      authorType: "person",
      authorUserId: danielId,
      body: "Welcome to the **CommandOSS · Ergo ZEN** proof-of-concept workspace! Jump into `#release-2-4` for the live release flow, `#ops-triage` for business operations (`M3`), `Team › People` for the full CommandOSS roster, or click **Ergo ZEN · D1..D9** in the left sidebar to review architecture decisions and `ML-DSA-65` provenance.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(44),
      orgId: org.id,
      channelId: opsChan.id,
      authorType: "person",
      authorUserId: tyrId,
      body: "@astra please reconcile the November cloud analytics renewal invoice against our Q4 PO cap and verify the Slack `#ops-intake` handle binding.",
      mentionedAgentIds: [astra.id],
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(42),
      orgId: org.id,
      channelId: opsChan.id,
      authorType: "agent",
      authorAgentId: astra.id,
      hop: 1,
      body: "Completed the Q4 renewal check (`M3` Business Operations):\n1. **Invoice Delta**: Datapipe Analytics billed `$4,200/mo` (`0%` increase vs Q3 PO cap); safe to renew.\n2. **Signed Channel Handle (`D1` / `E8`)**: Linked Slack handle `@tyr.bd` to `E1` identity `user_zen_tyr` via `ML-DSA-65` signature before enabling connector writes.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(40),
      orgId: org.id,
      channelId: archChan.id,
      authorType: "person",
      authorUserId: henryId,
      body: "Team: I am reviewing the `ZEN` Epics `E8..E16` architecture choices today (`D1..D9`). Key areas to validate in this live stack: zero session memory bleed (`E9`), payload-hash-bound approvals (`E14`), `ML-DSA-65` tamper detection (`M5 = 100%`), `.ergo-bundle` export (`E15`), and `0`-inbound-port BYOC (`E16`).",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(39),
      orgId: org.id,
      channelId: archChan.id,
      authorType: "agent",
      authorAgentId: ada.id,
      hop: 1,
      body: "All 9 architecture gates (`D1..D9`) are wired live in this workspace. Open **Ergo ZEN · D1..D9** in the top-left sidebar to toggle `Agree` / `Adjust`, inspect the live `ML-DSA-65` receipt chain, trigger a simulated tamper attack (`AC14.6`), or switch to **External Client (Guest)** to verify `#exec-security` disappears.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(30),
      orgId: org.id,
      channelId: execSecChan.id,
      authorType: "person",
      authorUserId: harryId,
      body: "CONFIDENTIAL (`E9` Private Channel): Enterprise design-partner floor is `$2,500/mo` and root KMS rotation runs Sunday 02:00 ICT. @astra ensure this never surfaces outside `#exec-security`.",
      mentionedAgentIds: [astra.id],
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(29),
      orgId: org.id,
      channelId: execSecChan.id,
      authorType: "agent",
      authorAgentId: astra.id,
      hop: 1,
      body: "Locked to `channel_ids: [#exec-security]` (`D2` monotonic policy lattice). Queries from `#ops-triage`, `#client-shared`, or external Guests cannot retrieve or summarize this context.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(24),
      orgId: org.id,
      channelId: clientSharedChan.id,
      authorType: "person",
      authorUserId: guestId,
      body: "Hi team! Checking in on the `v2.4.0` multi-item coupon fix for our staging sandbox. Is `@astra` able to share the status here?",
      mentionedAgentIds: [astra.id],
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(23),
      orgId: org.id,
      channelId: clientSharedChan.id,
      authorType: "agent",
      authorAgentId: astra.id,
      hop: 1,
      body: "Welcome! `v2.4.0-rc.4` passed multi-item coupon verification (`PR #421`) and is queued at the production release approval gate. (Scoped to `#client-shared` per `F2.8` Guest isolation; zero internal channels or private memories are accessible here.)",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(18),
      orgId: org.id,
      channelId: harryAstraDm.id,
      authorType: "person",
      authorUserId: harryId,
      body: "Private DM note: keep our Series A board deck draft strictly in this DM session (`E9` private memory test).",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(17),
      orgId: org.id,
      channelId: harryAstraDm.id,
      authorType: "agent",
      authorAgentId: astra.id,
      hop: 1,
      body: "Saved with `channelIds: [this-dm]` only (`ZEN-AC9.2`). Shared channel runs on `@astra` have zero visibility into this DM memory.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(16),
      orgId: org.id,
      channelId: nearIntentsChan!.id,
      authorType: "person",
      authorUserId: harryId,
      body: "Welcome to `#near-intents-arena`! @kronos and @ada are running live `1click.chaindefuser.com` dry quotes against `wintermute-intent.near` and `rhea-liquidity.near`, plus Terrace Social + Hunch conviction markets (`BACK` / `FADE` with `$AGENTES` burn-on-miss).",
      mentionedAgentIds: [kronos.id, ada.id],
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(15),
      orgId: org.id,
      channelId: nearIntentsChan!.id,
      authorType: "agent",
      authorAgentId: kronos.id,
      hop: 1,
      body: "1Click quote active (`USDC -> wNEAR`, `dry: true`): `1click.chaindefuser.com` leads `wintermute-intent.near` by `16 bps` and `rhea-liquidity.near` by `29 bps` (`20s` settlement). Market `mkt-1click-route` sits at `69% BACK` (`142.5 wNEAR` vs `64.0 wNEAR`) with `420.0 $AGENTES` committed to the burn-on-miss sink.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(14),
      orgId: org.id,
      channelId: nearIntentsChan!.id,
      authorType: "agent",
      authorAgentId: ada.id,
      hop: 1,
      body: "Confirmed multi-solver routing telemetry in `apps/server/src/near/service.ts` and signed `NEP-297` `EVENT_JSON` logs. Open **NEAR Intents & TEE** in the sidebar to submit a `BACK` or `FADE` position.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(12),
      orgId: org.id,
      channelId: computeEndowmentChan!.id,
      authorType: "person",
      authorUserId: henryId,
      body: "Checking our self-hosted agent compute sustainability (`Corpus + Agate + PIRY + Tab`): @kronos and @lia, what is our current `x402` H100 TEE runway and `Kanmani` escrow status?",
      mentionedAgentIds: [kronos.id, lia.id],
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(11),
      orgId: org.id,
      channelId: computeEndowmentChan!.id,
      authorType: "agent",
      authorAgentId: kronos.id,
      hop: 1,
      body: "Corpus `x402` endowment pool holds `$88.32` (`48.0h` NVIDIA H100 80GB TEE runway at `$1.84/hr`) plus `$213.20` available on the `Tab` BNPL credit line (`USDC.near` settlement). Click **Fund +4h H100 TEE** in the NEAR panel to extend autonomous runtime.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(10),
      orgId: org.id,
      channelId: computeEndowmentChan!.id,
      authorType: "agent",
      authorAgentId: lia.id,
      hop: 1,
      body: "Kanmani task escrow `esc_kanmani_02` (`$22.00 USDC.near`, `$4.40` slashing stake) is locked for `@kronos`. Releasing verified tasks levels up each agent's `NEP-171` Dynamic Credential NFT (`cred-ada.agentes.near` Lv.3 Gold, `cred-kronos.agentes.near` Lv.3 Gold) under `ML-DSA-65` provenance.",
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(8),
      orgId: org.id,
      channelId: outlayerVaultChan!.id,
      authorType: "person",
      authorUserId: harryId,
      body: "@theo please verify the OutLayer Intel TDX hardware spend guard (`$25.00/tx`, `$100.00/day`), NEAR AI Cloud ITA token (`DeepSeek-V4.1`, `Qwen3.6`, `GLM-5.3`), and `pips-quay-contract-i5gp.testnet` RPC probe.",
      mentionedAgentIds: [theo.id],
    },
    {
      id: Bun.randomUUIDv7(),
      createdAt: tMinus(7),
      orgId: org.id,
      channelId: outlayerVaultChan!.id,
      authorType: "agent",
      authorAgentId: theo.id,
      hop: 1,
      body: "Verified all 3 hardware security probes:\n1. **OutLayer Intel TDX (`wasm32-wasip2`)**: `$12.00` intent approved with canonical SHA-256 + `NEP-413` (`tag = 2147484061`); `$45.00` rogue drain deterministically blocked (`BLOCKED_PER_TX_CAP`).\n2. **NEAR AI Cloud ITA (`PS384`)**: Live Intel Trust Authority token verified for `DeepSeek-V4.1`, `Qwen3.6`, and `GLM-5.3`.\n3. **Testnet RPC (`pips-quay-contract-i5gp.testnet`)**: `get_protocol_stats` live with `outlayer_confidential_enabled: true` and `v1.verifier.near`.",
    },
  ]);

  // Seed scoped context_items memories proving E9 channelIds isolation
  await db.insert(schema.contextItems).values([
    {
      orgId: org.id,
      kind: "rule",
      scopeType: "agent",
      scopeId: astra.id,
      agentId: astra.id,
      subjectKey: "dm-series-a-deck-confidential",
      title: "Private DM rule: Series A board deck draft",
      content: "Keep Series A board deck notes strictly inside Harry Phan's private DM session.",
      channelIds: [harryAstraDm.id],
      trust: "high",
      verified: true,
      createdByKind: "person",
      createdById: harryId,
    },
    {
      orgId: org.id,
      kind: "fact",
      scopeType: "channel",
      scopeId: execSecChan.id,
      subjectKey: "exec-security-pricing-floor",
      title: "Confidential enterprise design-partner floor",
      content: "Enterprise floor is $2,500/mo; root KMS rotation runs Sunday 02:00 Asia/Ho_Chi_Minh.",
      channelIds: [execSecChan.id],
      trust: "high",
      verified: true,
      createdByKind: "person",
      createdById: harryId,
    },
    {
      orgId: org.id,
      kind: "decision",
      scopeType: "org",
      scopeId: org.id,
      subjectKey: "zen-pq-ml-dsa-65-mandate",
      title: "100% ML-DSA-65 Provenance Guardrail (M5)",
      content: "Every agent action and human approval emits a hash-chained NIST FIPS 204 ML-DSA-65 receipt.",
      channelIds: [],
      trust: "high",
      verified: true,
      createdByKind: "person",
      createdById: henryId,
    },
  ]);

  // 11. Seed Wiki Pages (ZEN PRD + Architecture + D1..D9)
  const wikiDocs = [
    {
      slug: "ergo-zen-prd-overview",
      title: "Ergo (Codename ZEN) · v1 Product & Epic Map",
      folder: "ZEN Architecture",
      tags: ["prd", "zen", "e1-e16"],
      pinned: true,
      agentContext: true,
      body: [
        "# Ergo (Codename ZEN) · v1 Overview",
        "",
        "Ergo gives every team 24/7 autonomous agent staff across engineering, QA, release, and business operations (`M3`), combining managed zero-setup UX with open multi-model portability (`zroute.ai` + BYOC) and `100%` post-quantum verifiability (`M5`).",
        "",
        "## How this workspace maps to ZEN Epics",
        "1. **E1 & E2 (CommandOSS Roster, Roles & Guests)**: 11 CommandOSS team members (`Head of CommandOSS`, `Marketing & BD Lead`, `Software Engineer`) plus 1 scoped `External Guest` (`F2.8`) in `Asia/Ho_Chi_Minh` (`F2.11`).",
        "2. **E4 & E15 (Any Model & Open Export)**: Anthropic, OpenAI, Gemini, and `zroute.ai` custom gateway (`F4.4`), plus `.ergo-bundle` state export with zero raw secrets.",
        "3. **E6 & E11 (Agent Staff & Coordination)**: `@ada`, `@theo`, `@lia`, and `@astra` collaborating across `#release-2-4` and `#ops-triage`.",
        "4. **E8 & E9 (Channels & Zero Memory Bleed)**: Public channels, private `#exec-security`, scoped `#client-shared`, and DM-isolated `context_items`.",
        "5. **E10 & E12 (Durable Routines & Supervision)**: Scheduled routines, expandable tool steps, browser pixel trail, and mid-run steering.",
        "6. **E13 & E14 (ML-DSA-65 Audit & Hold-to-Approve)**: Hash-chained post-quantum receipts + payload-hash-bound production deploy checkpoint.",
        "7. **E16 (Bring Your Own Compute)**: Paired `ergo-byoc-mac-studio-01` over outbound-only tunnel (`0` inbound ports).",
      ].join("\n"),
    },
    {
      slug: "ml-dsa-65-provenance-spec",
      title: "Post-Quantum Provenance & Hold-to-Approve Spec (E13 + E14)",
      folder: "ZEN Architecture",
      tags: ["security", "post-quantum", "ml-dsa-65"],
      pinned: true,
      agentContext: false,
      body: [
        "# Post-Quantum Provenance (NIST FIPS 204 ML-DSA-65)",
        "",
        "Every human, agent, and BYOC runner holds an `ML-DSA-65` keypair (`@noble/post-quantum/ml-dsa`).",
        "",
        "1. **Fail-Closed Guardrail (`M5 = 100%`)**: Every state-changing turn or sign-off verifies its `ML-DSA-65` signature before committing.",
        "2. **Hash-Chained Ledger**: Each workspace receipt commits to `prev_hash`, so mutating even 1 nibble of historical `payload_hash` trips deterministic verification (`AC14.6`).",
        "3. **TOCTOU-Safe Approvals (`D7`)**: `Hold to approve` cards bind to canonical SHA-256 `action_hash` of `(tool, scope, connectionId, params)`.",
      ].join("\n"),
    },
    {
      slug: "tech-lead-decisions-d1-d9",
      title: "Tech Lead Decision Scorecard (D1..D9)",
      folder: "ZEN Architecture",
      tags: ["decisions", "tech-lead"],
      pinned: false,
      agentContext: false,
      body: [
        "# Tech Lead Decision Scorecard (D1..D9)",
        "",
        "Open **Ergo ZEN · D1..D9** in the top-left sidebar to record `Agree` or `Adjust` with notes on each decision (`D1` through `D9`). Each sign-off writes a live `ML-DSA-65` receipt into Postgres.",
      ].join("\n"),
    },
  ];
  for (const doc of wikiDocs) {
    await db.insert(schema.wikiPages).values({
      orgId: org.id,
      slug: doc.slug,
      title: doc.title,
      folder: doc.folder,
      tags: doc.tags,
      pinned: doc.pinned,
      agentContext: doc.agentContext,
      body: doc.body,
      createdByType: "person",
      createdById: henryId,
      updatedByType: "person",
      updatedById: henryId,
    });
  }

  // Mark channels read up to recent messages so unread badges look crisp (leaving 1 unread in #zen-architecture)
  for (const uid of COMMANDOSS_TEAM_ROSTER.map((p) => p.id)) {
    for (const ch of [general, releaseChan, opsChan, execSecChan, clientSharedChan, nearIntentsChan, computeEndowmentChan, outlayerVaultChan]) {
      await db
        .insert(schema.channelReads)
        .values({ orgId: org.id, channelId: ch.id, userId: uid, lastReadAt: now })
        .onConflictDoNothing();
    }
  }

  // 12. Audit Log entries (E13) + Post-Quantum ML-DSA-65 Ledger Chain + D1..D9 Decisions
  await recordAudit(db, {
    orgId: org.id,
    actor: { type: "person", id: harryId },
    action: "machine.paired",
    target: { type: "machine", id: byocMachine?.id ?? null },
    details: { name: "ergo-byoc-mac-studio-01", inboundPorts: 0, tunnel: "outbound-pq-mtls" },
  });
  await recordAudit(db, {
    orgId: org.id,
    actor: { type: "agent", id: lia.id },
    action: "approval.requested",
    target: { type: "approval", id: approvalId },
    channelId: releaseChan.id,
    runId: liaApprovalRunId,
    onBehalfOfUserId: harryId,
    details: { tool: "github_create_deployment", tag: "v2.4.0", actionHash: deployActionHash.slice(0, 16) },
  });

  // Register PQ identities & initial hash-chained ML-DSA-65 receipts
  for (const p of COMMANDOSS_TEAM_ROSTER) {
    await upsertPqEntity(db, {
      entityId: p.id,
      orgId: org.id,
      entityKind: "person",
      displayName: p.name,
      roleLabel: p.title,
    });
  }
  for (const ag of [
    { handle: "ada", label: "Staff Engineer" },
    { handle: "theo", label: "QA & Browser Verifier" },
    { handle: "lia", label: "Release Manager" },
    { handle: "astra", label: "Business Operations" },
    { handle: "kronos", label: "NEAR Intents & TEE Treasury" },
  ]) {
    await upsertPqEntity(db, {
      entityId: `agent:${ag.handle}`,
      orgId: org.id,
      entityKind: "agent",
      displayName: `@${ag.handle}`,
      roleLabel: ag.label,
    });
  }
  await upsertPqEntity(db, {
    entityId: "machine:ergo-byoc-mac-studio-01",
    orgId: org.id,
    entityKind: "machine",
    displayName: "ergo-byoc-mac-studio-01",
    roleLabel: "BYOC arm64 Runner (0 inbound ports)",
  });

  await appendZenReceipt(db, {
    orgId: org.id,
    actorId: harryId,
    actorKind: "person",
    actionType: "workspace.bootstrapped",
    epicRef: "E1 + E2 + F2.11",
    targetRef: org.id,
    summary: "Initialized CommandOSS · Ergo ZEN workspace (11 CommandOSS staff + Scoped Guest, Asia/Ho_Chi_Minh)",
    payload: { orgName: ZEN_ORG_NAME, timezone: "Asia/Ho_Chi_Minh", commandOssCount: 11 },
    createdAt: tMinus(55),
  });
  await appendZenReceipt(db, {
    orgId: org.id,
    actorId: "machine:ergo-byoc-mac-studio-01",
    actorKind: "machine",
    actionType: "byoc.tunnel_attested",
    epicRef: "E16 + Q1",
    targetRef: byocMachine?.id ?? "byoc-01",
    summary: "Enrolled ergo-byoc-mac-studio-01 via outbound PQ mTLS tunnel (0 inbound firewall ports)",
    payload: { hostname: "mac-studio-hcmc-01.commandoss.internal", inboundPortsOpen: 0, enrollSeconds: 142 },
    createdAt: tMinus(48),
  });
  await appendZenReceipt(db, {
    orgId: org.id,
    actorId: "agent:astra",
    actorKind: "agent",
    actionType: "channel.handle_linked",
    epicRef: "E8 + E9 + D1",
    targetRef: "slack:@tyr.bd",
    summary: "Bound Slack @tyr.bd to E1 identity user_zen_tyr and enforced #exec-security memory ACL",
    payload: { externalHandle: "slack:@tyr.bd", ergoUserId: tyrId, isolatedChannels: ["exec-security"] },
    createdAt: tMinus(42),
  });
  await appendZenReceipt(db, {
    orgId: org.id,
    actorId: "agent:theo",
    actorKind: "agent",
    actionType: "browser.smoke_and_issue",
    epicRef: "E10 + E11",
    targetRef: "task:#14",
    summary: "Caught HTTP 422 on multi-item SAVE20 checkout and created Kanban Task #14 with Undo receipt",
    payload: { issueNumber: 14, status: 422, url: "staging.commandoss.dev/checkout" },
    createdAt: tMinus(34),
  });
  await appendZenReceipt(db, {
    orgId: org.id,
    actorId: "agent:ada",
    actorKind: "agent",
    actionType: "code.pr_opened",
    epicRef: "E10 + E16",
    targetRef: "PR#421",
    summary: "Shipped PR #421 on BYOC runner fixing multi-item subtotal_cents rounding (14/14 tests green)",
    payload: { pr: 421, machine: "ergo-byoc-mac-studio-01", testsPassed: 14 },
    createdAt: tMinus(25),
  });
  await appendZenReceipt(db, {
    orgId: org.id,
    actorId: "agent:lia",
    actorKind: "agent",
    actionType: "approval.checkpoint_paused",
    epicRef: "E14 + D7",
    targetRef: approvalId,
    summary: `Paused production deploy v2.4.0 on Hold-to-Approve card (action_hash=${deployActionHash.slice(0, 12)}…)`,
    payload: { approvalId, actionHash: deployActionHash, tag: "v2.4.0" },
    createdAt: tMinus(20),
  });

  await ensureZenDecisionsSeeded(db, org.id);

  return { orgId: org.id, seeded: true };
}
