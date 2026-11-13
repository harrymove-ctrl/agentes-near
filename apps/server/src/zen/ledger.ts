import { type Database, rowsOf, sql } from "@agenteschat/db";
import {
  generatePqIdentity,
  hashCanonical,
  signCanonicalPayload,
  verifyCanonicalPayload,
} from "./crypto";

export type ZenDecisionState = "pending" | "agree" | "adjust";

export interface ZenPqEntity {
  entityId: string;
  entityKind: "person" | "agent" | "machine";
  displayName: string;
  roleLabel: string;
  fingerprint: string;
  publicKeyHex: string;
  createdAt: string;
}

export interface ZenPqReceipt {
  seq: number;
  receiptId: string;
  orgId: string;
  actorId: string;
  actorKind: "person" | "agent" | "machine";
  actorName: string;
  actorFingerprint: string;
  actionType: string;
  epicRef: string;
  targetRef: string;
  summary: string;
  payloadHash: string;
  prevHash: string;
  receiptHash: string;
  signatureShort: string;
  createdAt: string;
}

export interface ZenLedgerVerification {
  ok: boolean;
  algorithm: "ML-DSA-65 (NIST FIPS 204)";
  totalReceipts: number;
  verifiedReceipts: number;
  m5ProvenanceRate: string;
  headHash: string;
  brokenAtSeq: number | null;
  reason: string | null;
}

export interface ZenTamperSimulationResult {
  tamperDetected: boolean;
  mutatedSeq: number;
  originalPayloadHash: string;
  tamperedPayloadHash: string;
  verificationAfterTamper: ZenLedgerVerification;
  liveLedgerIntact: boolean;
}

export interface ZenTechLeadDecision {
  decisionId: string;
  epicRef: string;
  title: string;
  proposal: string;
  status: ZenDecisionState;
  note: string;
  decidedBy: string | null;
  receiptId: string | null;
  updatedAt: string;
}

export const INITIAL_ZEN_DECISIONS: Array<{
  decisionId: string;
  epicRef: string;
  title: string;
  proposal: string;
}> = [
  {
    decisionId: "D1",
    epicRef: "E8 + OQ2 + OQ5",
    title: "Channel Adapters & Signed Handle Linking",
    proposal:
      "Ship Slack, Telegram, and Email in Wave 1; require 1-click ML-DSA signed binding between external chat handles and E1 identities before privileged writes.",
  },
  {
    decisionId: "D2",
    epicRef: "E9 + OQ12",
    title: "Monotonic Policy Lattice & Zero Session Memory Bleed",
    proposal:
      "Scope every context memory to its origin channel ACL so private DM context never leaks into shared channels on the same agent instance; broker vault secrets outside prompts.",
  },
  {
    decisionId: "D3",
    epicRef: "E10",
    title: "Journaled Durable State Machine Execution",
    proposal:
      "Journal every step in Postgres outbox + agent_run_steps with idempotency keys in workspace timezone (F2.11) so crashes or multi-day approval waits resume cleanly.",
  },
  {
    decisionId: "D4",
    epicRef: "E11",
    title: "Typed Multi-Agent Delegation & Anti-Escalation",
    proposal:
      "Cap agent-to-agent consultation chains with bounded budgets, carry caller lineage (Human -> Agent A -> Agent B), and enforce Agent B's own scopes and guardrails.",
  },
  {
    decisionId: "D5",
    epicRef: "E12",
    title: "5-Gear Supervision & Laptop-to-Cloud Handoff",
    proposal:
      "Support mid-run steering via live run inboxes plus background agent_works handoff so tasks keep running with zero client devices online.",
  },
  {
    decisionId: "D6",
    epicRef: "E13 + M5",
    title: "Fail-Closed ML-DSA-65 Hash-Chained Action Receipts",
    proposal:
      "Sign every human approval, agent turn, and policy change with NIST FIPS 204 ML-DSA-65 (100% M5 guardrail) and chain workspace receipts via prev_hash.",
  },
  {
    decisionId: "D7",
    epicRef: "E14",
    title: "Payload-Hash-Bound Approvals & Offline Verifier",
    proposal:
      "Bind Hold-to-Approve checkpoints to canonical SHA-256 action_hash of proposed tool arguments (TOCTOU defense) and allow standalone receipt verification.",
  },
  {
    decisionId: "D8",
    epicRef: "E15",
    title: "Open .ergo-bundle Export & Capability-Checked Model Swap",
    proposal:
      "Export agent blueprints, SKILL.md files, scoped memories, and signed receipts with zero raw vault secrets; validate model capabilities before hot-swapping.",
  },
  {
    decisionId: "D9",
    epicRef: "E16 + Q1..Q6",
    title: "Day-2 Outbound-Only BYOC Compute & R1 Quality Gate",
    proposal:
      "Keep Day-0 zero-setup; pair self-hosted BYOC machines over outbound-only WebSocket/mTLS tunnels (0 inbound VPC ports) gated by sub-5-minute enrollment.",
  },
];

let tablesReady = false;

export async function ensureZenTables(db: Database): Promise<void> {
  if (tablesReady) return;
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
  tablesReady = true;
}

export async function upsertPqEntity(
  db: Database,
  input: {
    entityId: string;
    orgId: string;
    entityKind: "person" | "agent" | "machine";
    displayName: string;
    roleLabel: string;
    seedText?: string;
  },
): Promise<ZenPqEntity> {
  await ensureZenTables(db);
  const existing = rowsOf<{
    entity_id: string;
    entity_kind: "person" | "agent" | "machine";
    display_name: string;
    role_label: string;
    fingerprint: string;
    public_key_hex: string;
    created_at: string | Date;
  }>(
    await db.execute(
      sql`SELECT entity_id, entity_kind, display_name, role_label, fingerprint, public_key_hex, created_at FROM zen_pq_entities WHERE entity_id = ${input.entityId} LIMIT 1`,
    ),
  );
  if (existing[0]) {
    const r = existing[0];
    return {
      entityId: r.entity_id,
      entityKind: r.entity_kind,
      displayName: r.display_name,
      roleLabel: r.role_label,
      fingerprint: r.fingerprint,
      publicKeyHex: r.public_key_hex,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
  const kp = generatePqIdentity(input.seedText ?? `ergo-zen:${input.orgId}:${input.entityId}`);
  const nowIso = new Date().toISOString();
  await db.execute(sql`
    INSERT INTO zen_pq_entities (
      entity_id, org_id, entity_kind, display_name, role_label, fingerprint, public_key_hex, secret_key_hex, created_at
    ) VALUES (
      ${input.entityId}, ${input.orgId}, ${input.entityKind}, ${input.displayName}, ${input.roleLabel},
      ${kp.fingerprint}, ${kp.publicKeyHex}, ${kp.secretKeyHex}, ${nowIso}::timestamptz
    )
    ON CONFLICT (entity_id) DO NOTHING
  `);
  return {
    entityId: input.entityId,
    entityKind: input.entityKind,
    displayName: input.displayName,
    roleLabel: input.roleLabel,
    fingerprint: kp.fingerprint,
    publicKeyHex: kp.publicKeyHex,
    createdAt: nowIso,
  };
}

function envelopeOf(row: {
  orgId: string;
  actorId: string;
  actorKind: string;
  actionType: string;
  epicRef: string;
  targetRef: string;
  payloadHash: string;
  prevHash: string;
  createdAt: string;
}) {
  return {
    v: 1,
    alg: "ML-DSA-65",
    orgId: row.orgId,
    actorId: row.actorId,
    actorKind: row.actorKind,
    actionType: row.actionType,
    epicRef: row.epicRef,
    targetRef: row.targetRef,
    payloadHash: row.payloadHash,
    prevHash: row.prevHash,
    createdAt: row.createdAt,
  };
}

export async function appendZenReceipt(
  db: Database,
  input: {
    orgId: string;
    actorId: string;
    actorKind: "person" | "agent" | "machine";
    actionType: string;
    epicRef: string;
    targetRef: string;
    summary: string;
    payload: unknown;
    createdAt?: Date;
  },
): Promise<{ receiptId: string; receiptHash: string; payloadHash: string }> {
  await ensureZenTables(db);
  const entityRows = rowsOf<{ public_key_hex: string; secret_key_hex: string }>(
    await db.execute(
      sql`SELECT public_key_hex, secret_key_hex FROM zen_pq_entities WHERE entity_id = ${input.actorId} LIMIT 1`,
    ),
  );
  const entity = entityRows[0];
  if (!entity) {
    throw new Error(`ZEN M5 fail-closed: missing ML-DSA-65 identity for actor ${input.actorId}`);
  }

  const headRows = rowsOf<{ receipt_hash: string }>(
    await db.execute(
      sql`SELECT receipt_hash FROM zen_pq_receipts WHERE org_id = ${input.orgId} ORDER BY seq DESC LIMIT 1`,
    ),
  );
  const prevHash = headRows[0]?.receipt_hash ?? "GENESIS_ERGO_ZEN_V1";
  const payloadHash = hashCanonical(input.payload);
  const createdAtIso = (input.createdAt ?? new Date()).toISOString();
  const envelope = envelopeOf({
    orgId: input.orgId,
    actorId: input.actorId,
    actorKind: input.actorKind,
    actionType: input.actionType,
    epicRef: input.epicRef,
    targetRef: input.targetRef,
    payloadHash,
    prevHash,
    createdAt: createdAtIso,
  });

  const signatureHex = signCanonicalPayload(entity.secret_key_hex, envelope);
  if (!verifyCanonicalPayload(entity.public_key_hex, envelope, signatureHex)) {
    throw new Error("ZEN M5 fail-closed: ML-DSA-65 self-verification failed before commit");
  }
  const receiptHash = hashCanonical({ envelope, signatureHex });
  const receiptId = `rcpt_${receiptHash.slice(0, 12)}`;

  await db.execute(sql`
    INSERT INTO zen_pq_receipts (
      receipt_id, org_id, actor_id, actor_kind, action_type, epic_ref, target_ref,
      summary, payload_hash, prev_hash, receipt_hash, signature_hex, created_at
    ) VALUES (
      ${receiptId}, ${input.orgId}, ${input.actorId}, ${input.actorKind}, ${input.actionType},
      ${input.epicRef}, ${input.targetRef}, ${input.summary}, ${payloadHash}, ${prevHash},
      ${receiptHash}, ${signatureHex}, ${createdAtIso}::timestamptz
    )
    ON CONFLICT (receipt_id) DO NOTHING
  `);

  return { receiptId, receiptHash, payloadHash };
}

interface RawReceiptRow {
  seq: number;
  receipt_id: string;
  org_id: string;
  actor_id: string;
  actor_kind: "person" | "agent" | "machine";
  display_name: string;
  fingerprint: string;
  public_key_hex: string;
  action_type: string;
  epic_ref: string;
  target_ref: string;
  summary: string;
  payload_hash: string;
  prev_hash: string;
  receipt_hash: string;
  signature_hex: string;
  created_at: string | Date;
}

async function loadRawReceipts(db: Database, orgId: string): Promise<RawReceiptRow[]> {
  await ensureZenTables(db);
  return rowsOf<RawReceiptRow>(
    await db.execute(sql`
      SELECT
        r.seq, r.receipt_id, r.org_id, r.actor_id, r.actor_kind,
        e.display_name, e.fingerprint, e.public_key_hex,
        r.action_type, r.epic_ref, r.target_ref, r.summary,
        r.payload_hash, r.prev_hash, r.receipt_hash, r.signature_hex,
        to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM zen_pq_receipts r
      JOIN zen_pq_entities e ON e.entity_id = r.actor_id
      WHERE r.org_id = ${orgId}
      ORDER BY r.seq ASC
    `),
  );
}

function normalizeIso(value: string | Date): string {
  return new Date(value).toISOString();
}

function verifyRows(rows: RawReceiptRow[]): ZenLedgerVerification {
  let expectedPrev = "GENESIS_ERGO_ZEN_V1";
  let verified = 0;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        algorithm: "ML-DSA-65 (NIST FIPS 204)",
        totalReceipts: rows.length,
        verifiedReceipts: verified,
        m5ProvenanceRate: rows.length ? `${Math.round((verified / rows.length) * 100)}%` : "100%",
        headHash: expectedPrev,
        brokenAtSeq: row.seq,
        reason: `Hash chain break at seq #${row.seq}: expected prev_hash ${expectedPrev.slice(0, 12)}, got ${row.prev_hash.slice(0, 12)}`,
      };
    }
    const createdAt = normalizeIso(row.created_at);
    const envelope = envelopeOf({
      orgId: row.org_id,
      actorId: row.actor_id,
      actorKind: row.actor_kind,
      actionType: row.action_type,
      epicRef: row.epic_ref,
      targetRef: row.target_ref,
      payloadHash: row.payload_hash,
      prevHash: row.prev_hash,
      createdAt,
    });
    if (!verifyCanonicalPayload(row.public_key_hex, envelope, row.signature_hex)) {
      return {
        ok: false,
        algorithm: "ML-DSA-65 (NIST FIPS 204)",
        totalReceipts: rows.length,
        verifiedReceipts: verified,
        m5ProvenanceRate: `${Math.round((verified / rows.length) * 100)}%`,
        headHash: expectedPrev,
        brokenAtSeq: row.seq,
        reason: `ML-DSA-65 signature invalid at seq #${row.seq} (${row.receipt_id}): payload_hash was altered after signing`,
      };
    }
    const computedHash = hashCanonical({ envelope, signatureHex: row.signature_hex });
    if (computedHash !== row.receipt_hash) {
      return {
        ok: false,
        algorithm: "ML-DSA-65 (NIST FIPS 204)",
        totalReceipts: rows.length,
        verifiedReceipts: verified,
        m5ProvenanceRate: `${Math.round((verified / rows.length) * 100)}%`,
        headHash: expectedPrev,
        brokenAtSeq: row.seq,
        reason: `Receipt digest mismatch at seq #${row.seq}`,
      };
    }
    expectedPrev = row.receipt_hash;
    verified += 1;
  }
  return {
    ok: true,
    algorithm: "ML-DSA-65 (NIST FIPS 204)",
    totalReceipts: rows.length,
    verifiedReceipts: verified,
    m5ProvenanceRate: "100%",
    headHash: expectedPrev,
    brokenAtSeq: null,
    reason: null,
  };
}

export async function verifyZenLedger(db: Database, orgId: string): Promise<ZenLedgerVerification> {
  const rows = await loadRawReceipts(db, orgId);
  return verifyRows(rows);
}

export async function listZenReceipts(db: Database, orgId: string, limit = 25): Promise<ZenPqReceipt[]> {
  const rows = await loadRawReceipts(db, orgId);
  return rows
    .slice(-limit)
    .reverse()
    .map((r) => ({
      seq: Number(r.seq),
      receiptId: r.receipt_id,
      orgId: r.org_id,
      actorId: r.actor_id,
      actorKind: r.actor_kind,
      actorName: r.display_name,
      actorFingerprint: r.fingerprint,
      actionType: r.action_type,
      epicRef: r.epic_ref,
      targetRef: r.target_ref,
      summary: r.summary,
      payloadHash: r.payload_hash,
      prevHash: r.prev_hash,
      receiptHash: r.receipt_hash,
      signatureShort: `${r.signature_hex.slice(0, 16)}..${r.signature_hex.slice(-10)}`,
      createdAt: normalizeIso(r.created_at),
    }));
}

export async function listZenEntities(db: Database, orgId: string): Promise<ZenPqEntity[]> {
  await ensureZenTables(db);
  const rows = rowsOf<{
    entity_id: string;
    entity_kind: "person" | "agent" | "machine";
    display_name: string;
    role_label: string;
    fingerprint: string;
    public_key_hex: string;
    created_at: string | Date;
  }>(
    await db.execute(
      sql`SELECT entity_id, entity_kind, display_name, role_label, fingerprint, public_key_hex, created_at FROM zen_pq_entities WHERE org_id = ${orgId} ORDER BY entity_kind ASC, display_name ASC`,
    ),
  );
  return rows.map((r) => ({
    entityId: r.entity_id,
    entityKind: r.entity_kind,
    displayName: r.display_name,
    roleLabel: r.role_label,
    fingerprint: r.fingerprint,
    publicKeyHex: r.public_key_hex,
    createdAt: normalizeIso(r.created_at),
  }));
}

export async function simulateZenTamperCheck(
  db: Database,
  orgId: string,
): Promise<ZenTamperSimulationResult> {
  const rows = await loadRawReceipts(db, orgId);
  if (rows.length === 0) {
    throw new Error("No receipts available to simulate tamper verification");
  }
  const targetIdx = Math.min(2, rows.length - 1);
  const cloned = rows.map((r) => ({ ...r }));
  const originalPayloadHash = cloned[targetIdx].payload_hash;
  const flippedNibble = originalPayloadHash[0] === "a" ? "b" : "a";
  const tamperedPayloadHash = `${flippedNibble}${originalPayloadHash.slice(1)}`;
  cloned[targetIdx].payload_hash = tamperedPayloadHash;

  const afterTamper = verifyRows(cloned);
  const liveCheck = verifyRows(rows);
  return {
    tamperDetected: !afterTamper.ok,
    mutatedSeq: Number(cloned[targetIdx].seq),
    originalPayloadHash,
    tamperedPayloadHash,
    verificationAfterTamper: afterTamper,
    liveLedgerIntact: liveCheck.ok,
  };
}

export async function ensureZenDecisionsSeeded(db: Database, orgId: string): Promise<void> {
  await ensureZenTables(db);
  for (const item of INITIAL_ZEN_DECISIONS) {
    await db.execute(sql`
      INSERT INTO zen_tech_lead_decisions (decision_id, org_id, epic_ref, title, proposal, status, note)
      VALUES (${item.decisionId}, ${orgId}, ${item.epicRef}, ${item.title}, ${item.proposal}, 'pending', '')
      ON CONFLICT (decision_id) DO NOTHING
    `);
  }
}

export async function listZenDecisions(db: Database, orgId: string): Promise<ZenTechLeadDecision[]> {
  await ensureZenDecisionsSeeded(db, orgId);
  const rows = rowsOf<{
    decision_id: string;
    epic_ref: string;
    title: string;
    proposal: string;
    status: ZenDecisionState;
    note: string;
    decided_by: string | null;
    receipt_id: string | null;
    updated_at: string | Date;
  }>(
    await db.execute(
      sql`SELECT decision_id, epic_ref, title, proposal, status, note, decided_by, receipt_id, updated_at FROM zen_tech_lead_decisions WHERE org_id = ${orgId} ORDER BY decision_id ASC`,
    ),
  );
  return rows.map((r) => ({
    decisionId: r.decision_id,
    epicRef: r.epic_ref,
    title: r.title,
    proposal: r.proposal,
    status: r.status,
    note: r.note,
    decidedBy: r.decided_by,
    receiptId: r.receipt_id,
    updatedAt: normalizeIso(r.updated_at),
  }));
}

export async function updateZenDecision(
  db: Database,
  input: {
    orgId: string;
    decisionId: string;
    status: ZenDecisionState;
    note: string;
    actorUserId: string;
    actorName: string;
  },
): Promise<{ decision: ZenTechLeadDecision; receiptId: string }> {
  await ensureZenDecisionsSeeded(db, input.orgId);
  await upsertPqEntity(db, {
    entityId: input.actorUserId,
    orgId: input.orgId,
    entityKind: "person",
    displayName: input.actorName,
    roleLabel: "Decision Reviewer",
  });

  const receipt = await appendZenReceipt(db, {
    orgId: input.orgId,
    actorId: input.actorUserId,
    actorKind: "person",
    actionType: "decision.sign_off",
    epicRef: "E13 + E14",
    targetRef: input.decisionId,
    summary: `${input.actorName} marked ${input.decisionId} as ${input.status.toUpperCase()}${input.note ? ` (${input.note.slice(0, 60)})` : ""}`,
    payload: {
      decisionId: input.decisionId,
      status: input.status,
      note: input.note,
      actorUserId: input.actorUserId,
    },
  });

  const nowIso = new Date().toISOString();
  await db.execute(sql`
    UPDATE zen_tech_lead_decisions
    SET status = ${input.status},
        note = ${input.note},
        decided_by = ${input.actorName},
        receipt_id = ${receipt.receiptId},
        updated_at = ${nowIso}::timestamptz
    WHERE decision_id = ${input.decisionId} AND org_id = ${input.orgId}
  `);

  const updated = (await listZenDecisions(db, input.orgId)).find(
    (d) => d.decisionId === input.decisionId,
  );
  if (!updated) throw new Error(`Decision ${input.decisionId} not found`);
  return { decision: updated, receiptId: receipt.receiptId };
}
