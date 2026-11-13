import type { BrainEffort } from "@agenteschat/adapters";
import { type ModelMessage, modelProvider, type SystemBlock, type ToolSpec } from "@agenteschat/providers";
import type { Agent } from "../agents";
import { turnNotes } from "../context";
import { cutOldToolSteps } from "../context-budget";
import type { GatewayResult, ModelGateway } from "../gateway";
import type { Brain, BrainEvent, BrainIO, BrainTurn } from "./types";

/**
 * The full conversation of the run as the model sees it (`Transcript.system`
 * and `.messages`): system blocks with cache breakpoints, and messages with
 * every block (tool calls, tool results, opaque provider blocks such as
 * thinking). `BrainTurn` carries a flattened text view of it for computer
 * brains; the model brain needs the exact blocks so resumes and prompt caches
 * stay valid, so it reads them here.
 */
export interface ModelConversation {
  system: SystemBlock[];
  messages: ModelMessage[];
  /** The trigger's message: the per-turn notes follow its text there (`turnNotes`); absent: in the system. */
  notesAt?: number;
}

export interface ModelBrainOptions {
  gateway: ModelGateway;
  /** The agent row (saves the gateway a lookup). */
  agent: Agent;
  maxOutputTokens: number;
  /** Read at the start of every turn (the engine appends to the same transcript between turns). */
  conversation(): ModelConversation;
  /** The agent's conversation, the same on each of its calls (`StreamOptions.session`). */
  session?: string;
}

/**
 * Today's model step behind the `Brain` interface (ADR 0032): one call to the
 * Model Gateway per turn — budget reserved before the call, usage and cost
 * recorded by the gateway with `org_id`, `agent_id` and `run_id`, deltas
 * streamed — turned into neutral events.
 *
 * One `run()` is one model call. Tool calls are yielded without `executed`:
 * the engine runs them through the Tool Gateway, appends the results to the
 * transcript and calls `run()` again (the loop, its limits and pauses live in
 * the engine). `io.executeTool` is not used by this brain.
 *
 * Failures are thrown, not yielded as `error` events, so the engine classifies
 * them exactly as before the refactor (budget, credential, permanent provider
 * errors fail the run; transient ones retry the job).
 *
 * The gateway's full result (content blocks, stop reason, usage record and
 * cost) is kept in `last` for the engine: the transcript and the `model_call`
 * step need more than the neutral events carry.
 */
export class ModelBrain implements Brain {
  readonly kind = "model" as const;
  /** The gateway result of the last completed `run()`. */
  last: GatewayResult | null = null;

  constructor(private readonly options: ModelBrainOptions) {}

  run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent> {
    return this.turn(turn, io);
  }

  /** The gateway call a turn makes, as sent (a pre-warm sends the same with no output). */
  private request(turn: BrainTurn) {
    const { agent } = this.options;
    const conversation = this.options.conversation();
    const { system, notesAt } = conversation;
    const messages = cutOldToolSteps(conversation.messages, turn.tools);
    const laid = turnNotes(system, notesAt, messages);
    const specs: ToolSpec[] = turn.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.stable ? { stable: true } : {}),
    }));
    return {
      orgId: turn.orgId,
      agentId: turn.agentId,
      agent,
      runId: turn.runId,
      personId: turn.personId ?? null,
      system: laid.system,
      messages: laid.messages ?? messages,
      ...(laid.notes ? { notes: laid.notes } : {}),
      tools: specs.length > 0 ? specs : undefined,
      // Only "Automático" sets an effort for the API; the API takes low, medium and high.
      ...(turn.effort ? { effort: apiEffort(turn.effort) } : {}),
      // The prompt up to the conversation stays cached for an hour: a message after a pause reads it.
      cacheTtl: "1h" as const,
      ...(this.options.session ? { session: this.options.session } : {}),
    };
  }

  /**
   * Writes the first turn's prompt to the provider's cache while the run waits for the person's next message
   * (token-trim B10): Claude's own API only, through the gateway (budget, usage and cost recorded), never failing.
   */
  async prewarm(turn: BrainTurn): Promise<void> {
    if (modelProvider(this.options.agent.model) !== "anthropic") return;
    await this.options.gateway.stream({ ...this.request(turn), maxTokens: 0, onDelta: () => {} }).catch(() => {});
  }

  private async *turn(turn: BrainTurn, io: BrainIO): AsyncGenerator<BrainEvent> {
    const { gateway, maxOutputTokens } = this.options;
    this.last = null;
    const deltas = eventQueue<BrainEvent>();
    const call = gateway
      .stream({
        ...this.request(turn),
        maxTokens: maxOutputTokens,
        onDelta: (text) => deltas.push({ type: "text_delta", text }),
        signal: io.signal,
      })
      .then(
        (result) => {
          deltas.end();
          return result;
        },
        (error: unknown) => {
          deltas.fail(error);
          throw error;
        },
      );
    // The failure reaches the consumer through the queue (after the deltas streamed before it).
    call.catch(() => {});
    yield* deltas.drain();
    const result = await call;
    this.last = result;
    yield {
      type: "usage",
      input: result.usage.inputTokens,
      output: result.usage.outputTokens,
      source: "api",
      model: result.model,
    };
    for (const block of result.content) {
      if (block.type === "tool_use") yield { type: "tool_call", id: block.id, name: block.name, input: block.input };
    }
    yield { type: "done", text: result.text };
  }
}

/** A brain effort as the providers take it (`ModelRequest.effort`): `xhigh` and `max` are `high`. */
export const apiEffort = (effort: BrainEffort): "low" | "medium" | "high" =>
  effort === "low" || effort === "medium" ? effort : "high";

/**
 * Callback → async iterator bridge: pushed items are yielded in order; after
 * `fail` the buffered items are still yielded, then the error is thrown.
 */
function eventQueue<T>() {
  const items: T[] = [];
  let closed = false;
  let failure: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(item: T) {
      if (closed) return;
      items.push(item);
      notify();
    },
    end() {
      closed = true;
      notify();
    },
    fail(error: unknown) {
      failure = { error };
      closed = true;
      notify();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (items.length > 0) yield items.shift() as T;
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const failed = failure as { error: unknown } | null;
      if (failed) throw failed.error;
    },
  };
}
