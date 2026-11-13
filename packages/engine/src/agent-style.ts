import { and, type Executor, eq, schema } from "@agenteschat/db";
import { personBehindCall } from "./requester";
import type { ToolDefinition, ToolSource } from "./tools/types";

const { organizationMembers } = schema;

/** How agents talk to a person in a workspace (ADR 0147). No choice yet reads as `simple`. */
export const AGENT_STYLES = ["simple", "technical"] as const;
export type AgentStyle = (typeof AGENT_STYLES)[number];

export const isAgentStyle = (v: unknown): v is AgentStyle => AGENT_STYLES.includes(v as AgentStyle);

/** The person's choice here, or null when they never made one (or nobody is behind the run). */
export async function agentStyleOf(db: Executor, orgId: string, userId: string | null): Promise<AgentStyle | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ style: organizationMembers.agentStyle })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return isAgentStyle(row?.style) ? row.style : null;
}

/** Saves it; false when the person is not a member here. */
export async function saveAgentStyle(db: Executor, orgId: string, userId: string, style: AgentStyle) {
  const rows = await db
    .update(organizationMembers)
    .set({ agentStyle: style })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .returning({ userId: organizationMembers.userId });
  return rows.length > 0;
}

/**
 * The turn's note for a person who chose `technical`. Simple is the rule every agent already reads ("# How to reply",
 * `PLAIN_WORDS_LINE`), so the default costs nothing per turn and stays in the cached prefix.
 */
export const TECHNICAL_STYLE_LINE =
  "# How to talk to this person\nTechnical, their choice: paths, codes, ids and tool names are welcome, and details can go in the text. What you write with an approval or a card stays plain.";

export const agentStyleLine = (style: AgentStyle | null) => (style === "technical" ? TECHNICAL_STYLE_LINE : null);

export const SET_REPLY_STYLE_TOOL = "set_reply_style";

/**
 * `set_reply_style`: the person behind the run says how they want agents to talk to them ("fala mais simples", "pode
 * ser técnico"), saved for every agent in this workspace. Nobody behind the run (a routine's), nothing to save.
 */
export function createAgentStyleToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: SET_REPLY_STYLE_TOOL,
    description:
      "Save how the person talking to you wants every agent here to talk to them, when they ask ('fala mais simples', 'pode ser técnico', 'less jargon'): simple (plain words, what to do first) or technical (paths, codes and ids welcome). Then answer in that style.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: { style: { type: "string", enum: [...AGENT_STYLES] } },
      required: ["style"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: input.style === "technical" ? "Technical replies" : "Simple replies" }),
    async execute(input, ctx) {
      if (!isAgentStyle(input.style)) return { content: "style must be simple or technical.", isError: true };
      const person = await personBehindCall(ctx);
      if (!person || !(await saveAgentStyle(ctx.db, ctx.orgId, person, input.style))) {
        return { content: "No person is behind this request: nothing to save.", isError: true };
      }
      return { content: `Saved: agents here now talk to them in the ${input.style} style.` };
    },
  };
  return { name: "agent-style", tools: async () => [tool] };
}
