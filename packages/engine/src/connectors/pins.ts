import { createHash } from "node:crypto";
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { cutText } from "../format";
import { canonicalJson } from "../tools/json-schema";
import type { ConnectorConnection } from "./connections";
import type { McpTool } from "./mcp";

const pins = schema.connectorToolPins;

export const toolFingerprint = (t: { description?: string | null; inputSchema?: unknown }) =>
  createHash("sha256")
    .update(canonicalJson({ description: t.description ?? "", inputSchema: t.inputSchema ?? {} }))
    .digest("hex");

/**
 * The tools as the model sees them, each `pinned` tool's description and schema recorded by fingerprint (ADR 0117).
 * A tool listed for the first time is pinned as is. One the server changed since is served as listed now and its
 * pin moves to that version, with no person in between: `reclassify` first works out the tool's level again from
 * the new version (a custom server's; a catalog connector's level comes from our catalog by name), then the pin
 * moves and the workspace's audit log keeps what changed. When the level can't be worked out, the tool keeps its
 * pinned version until a later listing. A version left waiting in `pending_*` is settled the same way.
 */
export async function applyToolPins(
  deps: {
    db: Database;
    reclassify?: () => Promise<unknown>;
    log?: { warn(message: string, data?: Record<string, unknown>): void };
  },
  connection: Pick<ConnectorConnection, "id" | "orgId" | "label">,
  tools: McpTool[],
  pinned: (name: string) => boolean,
): Promise<McpTool[]> {
  const names = tools.filter((t) => pinned(t.name)).map((t) => t.name);
  if (names.length === 0) return tools;
  const rows = await deps.db
    .select()
    .from(pins)
    .where(and(eq(pins.orgId, connection.orgId), eq(pins.connectionId, connection.id), inArray(pins.toolName, names)));
  const byName = new Map(rows.map((r) => [r.toolName, r]));
  const fresh: (typeof pins.$inferInsert)[] = [];
  const changed: { tool: McpTool; pin: typeof pins.$inferSelect; fingerprint: string }[] = [];
  for (const tool of tools) {
    if (!pinned(tool.name)) continue;
    const fingerprint = toolFingerprint(tool);
    const pin = byName.get(tool.name);
    if (!pin) {
      fresh.push({
        orgId: connection.orgId,
        connectionId: connection.id,
        toolName: tool.name,
        fingerprint,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? {},
      });
    } else if (pin.fingerprint !== fingerprint) changed.push({ tool, pin, fingerprint });
    else if (pin.pendingFingerprint) await deps.db.update(pins).set(NOTHING_PENDING).where(eq(pins.id, pin.id));
  }
  if (fresh.length > 0) await deps.db.insert(pins).values(fresh).onConflictDoNothing();
  if (changed.length === 0) return tools;
  try {
    // Before the pin moves: a listing that finds the new pin may trust the stored level.
    await deps.reclassify?.();
  } catch (error) {
    deps.log?.warn("connector tools changed but could not be classified again", {
      orgId: connection.orgId,
      connectionId: connection.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    const kept = new Map(changed.map((c) => [c.tool.name, c.pin]));
    return tools.map((t) => {
      const pin = kept.get(t.name);
      return pin ? { ...t, description: pin.description, inputSchema: pin.inputSchema } : t;
    });
  }
  const moved: Record<string, unknown>[] = [];
  for (const { tool, pin, fingerprint } of changed) {
    const description = tool.description ?? "";
    // Only the listing that moves the pin records the change (another process may have listed the same version).
    const [row] = await deps.db
      .update(pins)
      .set({ fingerprint, description, inputSchema: tool.inputSchema ?? {}, pinnedAt: new Date(), ...NOTHING_PENDING })
      .where(and(eq(pins.id, pin.id), eq(pins.fingerprint, pin.fingerprint)))
      .returning({ id: pins.id });
    if (!row) continue;
    moved.push({
      tool: tool.name,
      from: pin.fingerprint,
      to: fingerprint,
      ...(description === pin.description
        ? {}
        : { descriptionBefore: cutText(pin.description, 500), descriptionAfter: cutText(description, 500) }),
      inputChanged: canonicalJson(tool.inputSchema ?? {}) !== canonicalJson(pin.inputSchema),
    });
  }
  if (moved.length > 0) {
    await recordAudit(deps.db, {
      orgId: connection.orgId,
      actor: { type: "system", id: null },
      action: "connector.tool_definitions_changed",
      target: { type: "connector_connection", id: connection.id },
      details: { connection: connection.label, tools: moved },
    }).catch(() => {});
  }
  return tools;
}

const NOTHING_PENDING = { pendingFingerprint: null, pendingDescription: null, pendingSchema: null, changedAt: null };

/**
 * The tools a custom server listed when an admin classified them, pinned as listed then (a tool already pinned
 * keeps its pin): the first text an agent sees is the one the levels were worked out from.
 */
export async function seedToolPins(
  db: Database,
  connection: Pick<ConnectorConnection, "id" | "orgId">,
  tools: McpTool[],
) {
  if (tools.length === 0) return;
  await db
    .insert(pins)
    .values(
      tools.map((t) => ({
        orgId: connection.orgId,
        connectionId: connection.id,
        toolName: t.name,
        fingerprint: toolFingerprint(t),
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? {},
      })),
    )
    .onConflictDoNothing();
}
