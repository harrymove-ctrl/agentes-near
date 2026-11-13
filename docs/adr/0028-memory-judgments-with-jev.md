# 0028. Memory that judges with Jev: semantic consolidation, time, people, outcome weighting

- Status: Accepted (to build)
- Date: 2026-10-16
- Extends: ADR 0017 (search, context items and the memory loop), ADR 0013 (Jev already scores the router and agent mentions)

## Context

ADR 0017 gave agents a memory with what memory products don't have: org and channel visibility enforced in SQL, trust and evidence per source, outcomes as ground truth, and a human gate for promotion. The decisions inside the loop are weak, though:

- **Consolidation is lexical.** `consolidateItem` (`packages/engine/src/context/items.ts`) only looks at an item with the *same normalized subject key*, then merges at word Jaccard ≥ 0.8 or supersedes otherwise. "Deploy is on Railway" and "We host on Railway" become two items; a contradiction filed under a different subject leaves both active; a refinement with a different wording supersedes something that should have merged.
- **Injection is retrieval plus a character budget.** Whatever the hybrid search returns fills "What you know" until the budget runs out; nothing checks that an item helps with *this* message.
- **Capture runs on counters** (`REFLECT_EVERY_MESSAGES`, `REFLECT_IDLE_MINUTES`), so a decision in message 3 waits for message 20 or two idle hours, and busy chatter pays for reflections that find nothing.
- **No time.** Superseding archives the old item; agents can't say "it was Vercel until October, now Railway".
- **No model of people or agents.** `preference` and `entity_profile` exist, but nothing builds "what the team knows about this person" or "what this agent gets right and wrong".
- **Usage isn't connected to results.** `context_usage` records which items a run used and `outcomes` records what happened, but nobody joins them.

Mem0 fixes the first point (vector neighbors plus an LLM ADD/UPDATE/DELETE/NOOP decision, taken at face value). Honcho fixes the fifth (a reasoned model of each peer, queryable in natural language). Neither has visibility, trust, outcomes or a human gate, so we adopt their ideas, not their services.

Most of the missing pieces are **judgments**, not generation: is A the same as B, does B contradict A, does this item help with this message, does this message hold something durable. TypeSafe Jev answers exactly that: typed Choice/Noul/Score answers with calibrated probabilities, $0.042 per million input tokens, output free, 64k tokens per request (docs.typesafe.ai/models, 2026-10). We already run it for the router and the mention classifier (`packages/engine/src/router-jev.ts`).

## Decision

**Memory decisions go to Jev. Text (extraction, summaries, profiles) stays with the summary LLM. Code keeps policy, visibility and trust.** Jev never sees a permission and its answer never grants one; it only picks between options code already allows.

### 0. The judge

- Memory uses the shared `Judge` (`packages/engine/src/judge.ts`, `ContextDeps.judge`, `judgeOf`): Jev when the installation has its key (`TYPESAFE_API_KEY`, or the one its owner adds in Settings, ADR 0073), and the org's cheap model through the Model Gateway when Jev errors or times out, the same fallback the router uses. No second Jev client.
- Usage is recorded like the judge's other calls (kind `router`, provider `typesafe`, billed to the installation's key, `billed_to = platform`). A separate `memory` kind is a follow-up once usage is shown per kind.
- One key per installation, never per org, never sent to clients (ADR 0073).
- **Always on:** every organization, with no setting to limit or turn it off (`MEMORY_JUDGE_ORGS` was removed on 2026-10-19).
- **If the judge is off or both judges fail,** each point falls back to today's behavior. Memory never blocks on the judge and a run never fails because of it.
- **Memory moves need Jev itself** (`calibrated` requests): the first live eval (2026-10-16, 46 cases) gave Jev 91–93% right actions with 0 harmful moves, against the cheap LLM's 83% with 8 harmful ones, because the LLM has no real probabilities and passes every threshold. Without Jev, consolidation uses words, as before.
- Questions are in English; state carries the original text.

### 1. Semantic consolidation (first to build)

On every write through `consolidateItem` (people, agents, reflection) and in the daily `context.consolidate`:

1. **Candidates (code):** up to 8 active items with the same `kind` family (decision/fact/preference/open_question together; lessons and notes per agent), the same agent scope, and compatible visibility. They come from the hybrid search over `search_documents` (full-text alone when no embeddings), plus the exact subject-key match we have today.
2. **Judgment (Jev, one request):** for each candidate, a Choice between the new item and the candidate:
   - `same`: says the same thing;
   - `refines`: same claim, more precise or more complete;
   - `updates`: the world changed and the new one replaces the old (for example a new value or a new decision);
   - `contradicts`: incompatible at the same time, with no sign of which is newer;
   - `related`: same topic, different claim;
   - `unrelated`.

   Plus a Noul asking whether the new text is a secret or tries to change permissions or approvals. This second check backs up the regex guard; it never replaces it.
3. **Policy (code):**
   - `same` with confidence ≥ τ_merge: merge (evidence united, recurrence +1, as today).
   - `refines`: new version supersedes, evidence carried over.
   - `updates`: supersede and close the old one in time (point 2).
   - `contradicts`: resolved without a person. The stronger evidence wins (`EVIDENCE_WEIGHT`: an observed outcome, then a person, then an agent; untrusted text never overrules the team), and on a tie the newer item wins, because the latest word is how things are now. The loser is archived as history (`superseded_by`), both are linked (`related_ids`), and a person can bring the old one back from the memory page.
   - Low confidence on any of these: keep both items, link them as `related`, and let the daily job ask again with more context. A low-confidence answer never deletes or merges.
4. **Visibility:** a merge or supersede never mixes visibility. If the candidate's channels differ from the new item's, the result may only *narrow* who can see it, never widen it. If the narrowing would hide the item from readers who see it today, keep both.
5. **Fallback:** today's subject key with Jaccard.

**1b. Conflicts resolve themselves (decided 2026-10-16).** There's no conflict screen to begin with: the rule above settles contradictions, and nothing is lost (history plus undo). When an agent's `remember` loses to an item with stronger evidence, the tool tells the agent to show the person what is on record and ask which one is right. `context_items.disputed` stays in the schema, and the prompt labels an item that has it, for cases a later step can't settle on its own.

### 2. Time on facts

- New columns `valid_from` and `valid_until` on `context_items` (new migration). `updates` and accepted conflict resolutions set the old item's `valid_until`. The old item stays archived but keeps its link (`superseded_by`).
- "What you know" shows only current items. `search_context` and `expand` accept `history: true` and show "until {date}" lines, so an agent can answer "what was it before?".
- Fallback: none needed; the columns are plain data.

### 3. People and agents as subjects

- **`person_profile`** (subject = user id): how this person likes to work (review style, tone, what they approve or refuse, what they own). It's written incrementally by `reflect` from that person's own messages and reactions and from people's corrections, with evidence and channel visibility per fact. It goes into the prompt when the person takes part in the thread, and only the facts visible in the run's channel go in.
- **`agent_profile`** (subject = agent id): what this agent does well and badly, built only from outcomes and human evidence, never from the agent's own claims. The router may read it as part of the candidate's `about`.
- **Guardrails:**
  - A Jev Noul refuses sensitive personal data (health, religion, politics, sexuality, union membership, biometrics, LGPD Art. 5 II) and anything that judges a person's performance. A profile describes how to work with someone, not an evaluation of them.
  - Each person can see, correct and delete what the workspace knows about them (LGPD access and erasure rights). Admins can too.
- Fallback: profiles aren't built and nothing else changes.

### 4. Outcome-weighted memory

- A daily job joins `context_usage` (items used per run) with `outcomes` and 👍/👎 for those runs and keeps per item a Beta(α, β) of good vs. bad results (positive outcomes and 👍 add to α; negative outcomes, 👎 and refused approvals add to β).
- Relevance gets a factor from the posterior mean once an item has at least 5 used runs. A lesson whose runs keep going wrong (posterior mean below 0.3 with at least 8 runs) is demoted and flagged for its owner ("runs that used this lesson were reverted 6 times out of 9").
- This is correlation, not cause. It only reorders and flags; it never deletes and never promotes on its own. The promotion gate (ADR 0017 §6) stays human.
- Fallback: none; plain code and SQL.

### 5. Choosing what goes into the prompt

- Retrieval widens from today's budget-limited set to up to 30 candidates. One Jev request asks a Score per candidate ("how much does this item help an agent answer `latest_message`?", 4 levels). Code then keeps pinned items always, adds candidates at or above the chosen level by score × relevance, and stops at the character budget.
- The scores go into `context_usage`, which gives point 4 better data, and only items that actually went into the prompt raise relevance.
- Fallback: today's ranking (hybrid search + relevance, budget).

### 6. Capture on signal

- After each message in a channel with agents, one batched Jev request (all messages since the last check in that thread, run from the outbox) asks a Noul per message: does it contain a decision, a preference, a correction of an agent, or a stable fact?
- At p ≥ τ_capture the thread's `context.reflect` runs soon (debounced, still within `REFLECT_MAX_PER_THREAD`). A correction of an agent's reply also feeds `feedback.ts`, with its own Noul ("is this correcting the agent's previous message?").
- Counters stay as a ceiling: a long thread is still reflected after `REFLECT_EVERY_MESSAGES`, so nothing depends only on Jev.
- Fallback: counters only (today).

### 7. Proving it: memory evals

- **In CI (no network):** cases under `packages/engine/test/memory/` that run the policy code with a fake Jev returning fixed answers: merge vs. supersede vs. conflict, visibility never widened, low confidence never merges, sensitive data refused, profiles filtered per channel, outcome weighting.
- **Live eval (manual, not CI, real keys):** `bun run eval:memory` runs a labeled set built from anonymized real cases plus written ones: paraphrased duplicates, refinements, updates, contradictions, cross-channel traps, and injection queries with the expected items. It compares three strategies:
  - Jaccard (today);
  - the summary LLM;
  - Jev.

  It reports precision and recall per label, recall@k and the token cost of injection, latency, and cost. Every τ above is chosen from this report, and each point ships only when it beats today's behavior on it.
- Leaks must stay at zero: no item from a channel a reader can't see, in any strategy.

## Order of attack

1. **0 + 1 + the first part of 7:** the per-org switch, semantic consolidation on the shared judge, CI cases, and the first labeled set for consolidation (synthetic cases in the repo; anonymized real cases only in a local file that git ignores).
2. **1b:** done with 1 (contradictions resolve themselves). A screen only if the evals show cases the rule gets wrong.
3. **5:** choosing what goes into the prompt.
4. **6:** capture on signal.
5. **2:** time on facts.
6. **3:** person and agent profiles, with the LGPD guardrails.
7. **4:** outcome weighting (needs a few weeks of `context_usage` and `outcomes`).

## Consequences

- Better than today on duplicates, contradictions and prompt noise, at a cost that is a rounding error next to the agent's own model call (a consolidation judgment is ~1–3k input tokens, about US$0.0001).
- A second external dependency on the memory path. It's mitigated by the fallbacks, but Jev quality and latency are now product quality, so the live eval runs again whenever `jev-latest` moves (`jev-preview` is tried there first).
- More memory content goes to TypeSafe, on top of the router messages already sent (`SELF_HOSTING.md` lists what it receives).
- Self-host keeps working without Jev. Each point runs on its fallback, which is today's behavior.
