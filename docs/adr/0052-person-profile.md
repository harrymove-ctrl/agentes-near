# 0052. A profile per person, shared by every agent that talks to them

- Status: Proposed
- Date: 2026-10-21
- Extends: ADR 0017 (context items), ADR 0028 (memory judgments; its §3, people and agents as subjects)

## Context

Memory is organized around the organization's work (`context_items`: facts, decisions, preferences, lessons, summaries). What an agent learns about a person (how they like answers, their role, what they own, when they work) lands in that pool as a generic `preference` or `fact`, competes for the 3,500-char memory budget with everything else, and only shows up when retrieval happens to match the message. A new agent knows nobody. ADR 0028 §3 plans profiles of people and agents; they aren't built.

## Decision

### The profile

- New context item kind `person_profile`, one row per `(org_id, user_id)`, holding up to 30 facts. Each fact: `text` (≤ 200 chars), `source_message_ids`, `visibility` (inherited from the most restrictive source, as for every context item), `created_at`, `confirmed_at`.
- Total ≤ 1,200 chars in the prompt. It goes into every run whose person behind it (`personBehindRun`) is that user, as "# About <name>", after the frozen sections (ADR 0050 freezes it per thread like memory).
- Only facts visible in the current conversation are rendered: a fact learned in a DM appears only in DMs with that person.

### What goes in

- Only what the person said or did: preferences, role and areas, recurring projects, working hours, how they want to be addressed. Never what an agent inferred about them from someone else's message, never sensitive categories (health, religion, politics, finances), filtered by the extraction prompt and a Jev check.
- **After each run with a person** (job `profile.extract`, priority 2, at most once per thread every 10 min): one cheap call proposes at most 3 candidate facts from the person's own messages in that run.
- Each candidate is judged against the existing facts with the memory judgments (ADR 0028: equal / refines / updates / contradicts / none, same thresholds). Equal is dropped, refines and updates replace with history kept, contradicts resolves to the newer statement by the person.

### Nightly review

Once a day per org, a consolidation agent with exactly four tools (read excerpts of the day's conversations with the person, search memory, write a fact, remove a fact), no connectors and no other tools, reviews profiles changed that day: merges duplicates, drops facts older than 90 days that were never confirmed, keeps the 30-fact cap.

### The person decides

- Settings → "O que os agentes sabem de você": list of facts with where each came from, edit, delete, and a switch to turn the profile off.
- A deleted fact is stored as a tombstone (hash) for 1 year so extraction doesn't bring it back.
- Admins can't read other people's profiles in the UI; agents see them only as described above.

## Consequences

- Every agent starts each conversation knowing the person, at a fixed, small token cost.
- Privacy: facts never cross the visibility of their source. The settings page makes the profile inspectable and deletable (LGPD: access and erasure).
- New migration (kind + tombstones). `eval:memory` gains profile cases: preference kept across agents, DM fact not shown in a channel, deleted fact not re-learned.
- Out of scope: agent profiles (what an agent is good at), and ADR 0028 §2 (time on facts), §4 (outcome weighting), §5 (choosing what goes into the prompt) and §6 (capture on signal).
