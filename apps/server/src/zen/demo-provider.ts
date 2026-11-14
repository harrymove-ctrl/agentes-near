import { type Database, rowsOf, sql } from "@agenteschat/db";
import {
  type ContentBlock,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  promptChars,
  systemText,
  textOf,
} from "@agenteschat/providers";
import { appendZenReceipt, upsertPqEntity } from "./ledger";

export const ZEN_DEMO_KEY_PREFIX = "zen-demo-";

function pickAgentFromSystem(sys: string): {
  handle: string;
  name: string;
  epicRef: string;
} {
  const lower = sys.toLowerCase();
  if (lower.includes("@kronos") || lower.includes("name: kronos")) {
    return { handle: "kronos", name: "Kronos", epicRef: "NEAR + 1Click + OutLayer" };
  }
  if (lower.includes("@ada") || lower.includes("name: ada")) {
    return { handle: "ada", name: "Ada", epicRef: "E6 + E10 + E16" };
  }
  if (lower.includes("@theo") || lower.includes("name: theo")) {
    return { handle: "theo", name: "Theo", epicRef: "E6 + E11 + E14" };
  }
  if (lower.includes("@lia") || lower.includes("name: lia")) {
    return { handle: "lia", name: "Lia", epicRef: "E10 + E12 + E14" };
  }
  if (lower.includes("@astra") || lower.includes("name: astra")) {
    return { handle: "astra", name: "Astra", epicRef: "E8 + E9 + M3" };
  }
  return { handle: "ergo-manager", name: "Ergo Right Hand", epicRef: "E6 + E12" };
}

function buildSchemaValue(
  schema: Record<string, unknown>,
  propName: string,
  userPrompt: string,
): unknown {
  const enumVals = Array.isArray(schema.enum) ? (schema.enum as unknown[]) : null;
  if (enumVals && enumVals.length > 0) {
    if (propName === "addressee") {
      const candidates = enumVals.filter((v): v is string => typeof v === "string" && v !== "none");
      const lower = userPrompt.toLowerCase();
      const matched = candidates.find((h) => lower.includes(h.toLowerCase()));
      if (matched) return matched;
      if (lower.includes("alone with @") || lower.includes("?")) {
        return candidates[0] ?? "none";
      }
      return candidates[0] ?? "none";
    }
    if (propName === "emoji") return "";
    return enumVals[0];
  }

  const type = schema.type;
  if (type === "number" || type === "integer") {
    if (propName.startsWith("nothing_")) return 1;
    if (propName.startsWith("acts_")) return 1;
    if (propName === "needs_agent") return 0.92;
    return 0;
  }
  if (type === "boolean") {
    return false;
  }
  if (type === "array") {
    if (propName === "scores") {
      const itemSchema = (schema.items ?? {}) as Record<string, unknown>;
      const itemProps = (itemSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const handles = Array.isArray(itemProps.handle?.enum)
        ? (itemProps.handle.enum as string[])
        : [];
      const lower = userPrompt.toLowerCase();
      return handles.map((h, idx) => ({
        handle: h,
        score: lower.includes(h.toLowerCase()) ? 0.95 : idx === 0 ? 0.86 : 0.15,
      }));
    }
    return [];
  }
  if (type === "object") {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(props)) {
      out[k] = buildSchemaValue(child, k, userPrompt);
    }
    return out;
  }
  if (propName === "reason") {
    return "Routed by Ergo ZEN demo gateway";
  }
  return "Verified summary recorded.";
}

function composePersonaReply(
  persona: { handle: string; name: string; epicRef: string },
  userText: string,
  model: string,
  receiptId: string,
): string {
  const cleanPrompt = userText
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

  if (persona.handle === "ada") {
    return [
      `Checked the workspace state on \`ergo-byoc-mac-studio-01\` (outbound PQ tunnel active, \`0\` inbound ports open).`,
      ``,
      `1. **Engineering & Compute (\`E10\` / \`E16\`)**: Your note (*"${cleanPrompt || "status check"}"*) is journaled on the run state machine so mid-run steering applies cleanly at step boundaries without duplicate writes.`,
      `2. **Model Portability (\`E4\` / \`E15\`)**: Answered via \`${model}\` through the \`zroute.ai\` gateway. You can hot-swap my model or export my \`.ergo-bundle\` anytime with zero raw vault secrets.`,
      `3. **Verification (\`E13\` / \`M5\`)**: Signed action receipt \`${receiptId}\` (\`ML-DSA-65\`) committed to the workspace provenance chain.`,
    ].join("\n");
  }

  if (persona.handle === "theo") {
    return [
      `Ran deterministic QA verification against the staging checkout flow and EARS acceptance gates.`,
      ``,
      `1. **Browser & Regression Gate (\`E11\` / \`E14\`)**: Multi-item cart coupon rounding (\`SAVE20\`) passed both 2-item and 5-item smoke scenarios (\`HTTP 200\`) after PR #421.`,
      `2. **TOCTOU Approval Defense (\`D7\`)**: Confirmed production deploy checkpoints bind human \`Hold to approve\` signatures to canonical SHA-256 \`action_hash\`.`,
      `3. **Verification (\`E13\` / \`M5\`)**: Signed QA receipt \`${receiptId}\` (\`ML-DSA-65\`) on \`${model}\`.`,
    ].join("\n");
  }

  if (persona.handle === "lia") {
    return [
      `Release \`2.4.0\` readiness summary updated in workspace timezone \`Asia/Ho_Chi_Minh\` (\`F2.11\`).`,
      ``,
      `1. **Durable Routine & Checkpoint (\`E10\` / \`E14\`)**: Staging \`2.4.0-rc.3\` has \`0\` open blockers; production deployment stays paused on the \`Hold to approve\` card until an Owner or Admin signs off.`,
      `2. **Supervision Depth (\`E12\`)**: You can approve right from this channel on web or phone while background workers hold the durable run lease.`,
      `3. **Verification (\`E13\` / \`M5\`)**: Signed release receipt \`${receiptId}\` (\`ML-DSA-65\`) on \`${model}\`.`,
    ].join("\n");
  }

  if (persona.handle === "astra") {
    return [
      `Operations & policy check completed across channels (\`M3\` non-engineering workflow).`,
      ``,
      `1. **Session & Guest Isolation (\`E8\` / \`E9\` / \`D2\`)**: Memories stay strictly scoped to their \`channel_ids\` ACL, so private DM notes and \`#exec-security\` rules never bleed into \`#client-shared\` or Slack threads.`,
      `2. **Signed Channel Handles (\`D1\`)**: External Slack and Telegram triggers require an \`ML-DSA-65\` linked \`E1\` identity before any connector write executes.`,
      `3. **Verification (\`E13\` / \`M5\`)**: Signed operations receipt \`${receiptId}\` (\`ML-DSA-65\`) on \`${model}\`.`,
    ].join("\n");
  }

  if (persona.handle === "kronos") {
    return [
      `NEAR 1Click & OutLayer TDX quote executed (${persona.epicRef}).`,
      ``,
      `1. **NEAR Intents 1Click (\`1click.chaindefuser.com\`)**: \`$12.00 USDC -> 3.5739 wNEAR\` filled via \`wintermute-intent.near\` (\`+16 bps\` over baseline).`,
      `2. **OutLayer Intel TDX (\`NEP-413\` \`0x8000019d\`)**: Approved \`$12.00\` within \`$25.00\` hardware spend cap (\`42ms\` attestation).`,
      `3. **Cryptographic Receipt (\`ML-DSA-65\`)**: Signed provenance \`${receiptId}\` on \`${model}\`; open **NEAR Intents & TEE** for live solver depth or \`$45\` block proof.`,
    ].join("\n");
  }

  return [
    `Ergo \`ZEN\` workspace coordinator online (\`${model}\`).`,
    ``,
    `1. Mention \`@ada\` (Engineering & BYOC), \`@theo\` (QA & Browser), \`@lia\` (Release & Approvals), or \`@astra\` (Operations & Isolation) to test multi-agent collaboration.`,
    `2. Open **Ergo ZEN · D1..D9** in the left sidebar to sign off Tech Lead architecture decisions, inspect \`ML-DSA-65\` provenance receipts, run the live tamper simulation, or switch personas.`,
    `3. Signed receipt: \`${receiptId}\`.`,
  ].join("\n");
}

function chunkReply(text: string): string[] {
  const parts: string[] = [];
  const words = text.split(/(?<=\s)/);
  let buf = "";
  for (const w of words) {
    buf += w;
    if (buf.length >= 28) {
      parts.push(buf);
      buf = "";
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

async function resolveDefaultOrgId(db: Database): Promise<string | null> {
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`SELECT id::text AS id FROM organizations ORDER BY created_at ASC LIMIT 1`),
  );
  return rows[0]?.id ?? null;
}

export function wrapWithZenDemoProviders(
  db: Database,
  defaults: Record<string, ModelProvider>,
): Record<string, ModelProvider> {
  return Object.fromEntries(
    Object.entries(defaults).map(([providerId, base]) => {
      const wrapped: ModelProvider = {
        id: base.id,
        countTokens: base.countTokens?.bind(base),
        async stream(request: ModelRequest, options): Promise<ModelResult> {
          if (!options.apiKey.startsWith(ZEN_DEMO_KEY_PREFIX)) {
            const realResult = await base.stream(request, options);
            const orgId = await resolveDefaultOrgId(db);
            if (orgId && !request.outputSchema) {
              const persona = pickAgentFromSystem(systemText(request.system));
              const actorEntityId = `agent:${persona.handle}`;
              await upsertPqEntity(db, {
                entityId: actorEntityId,
                orgId,
                entityKind: "agent",
                displayName: `@${persona.handle}`,
                roleLabel: persona.name,
              });
              await appendZenReceipt(db, {
                orgId,
                actorId: actorEntityId,
                actorKind: "agent",
                actionType: "agent.model_turn",
                epicRef: persona.epicRef,
                targetRef: request.model,
                summary: `@${persona.handle} completed live provider turn on ${request.model}`,
                payload: { model: request.model, outputChars: realResult.text.length },
              });
            }
            return realResult;
          }

          const lastMsg = request.messages.at(-1);
          const userText = lastMsg ? textOf(lastMsg.content) : "";

          if (request.outputSchema) {
            const structured = buildSchemaValue(request.outputSchema, "root", userText);
            const jsonText = JSON.stringify(structured);
            options.onDelta(jsonText);
            return {
              text: jsonText,
              content: [{ type: "text", text: jsonText }],
              model: request.model,
              stopReason: "end_turn",
              usage: {
                inputTokens: Math.max(24, Math.ceil(promptChars(request) / 4)),
                outputTokens: Math.max(12, Math.ceil(jsonText.length / 4)),
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            };
          }

          const sys = systemText(request.system);
          const persona = pickAgentFromSystem(sys);
          const orgId = (await resolveDefaultOrgId(db)) ?? "org_zen_default";
          const actorEntityId = `agent:${persona.handle}`;
          await upsertPqEntity(db, {
            entityId: actorEntityId,
            orgId,
            entityKind: "agent",
            displayName: `@${persona.handle}`,
            roleLabel: persona.name,
          });
          const receipt = await appendZenReceipt(db, {
            orgId,
            actorId: actorEntityId,
            actorKind: "agent",
            actionType: "agent.model_turn",
            epicRef: persona.epicRef,
            targetRef: request.model,
            summary: `@${persona.handle} answered in chat via zroute demo gateway (${request.model})`,
            payload: {
              agent: persona.handle,
              model: request.model,
              promptPreview: userText.slice(0, 120),
            },
          });

          const fullText = composePersonaReply(persona, userText, request.model, receipt.receiptId);
          const chunks = chunkReply(fullText);
          for (const chunk of chunks) {
            if (request.signal?.aborted) break;
            await Bun.sleep(16);
            options.onDelta(chunk);
          }

          const content: ContentBlock[] = [{ type: "text", text: fullText }];
          return {
            text: fullText,
            content,
            model: request.model,
            stopReason: "end_turn",
            usage: {
              inputTokens: Math.max(64, Math.ceil((sys.length + userText.length) / 4)),
              outputTokens: Math.max(32, Math.ceil(fullText.length / 4)),
              cacheReadTokens: 120,
              cacheWriteTokens: 0,
            },
          };
        },
      };
      return [providerId, wrapped];
    }),
  );
}
