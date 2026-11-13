# 0167. Memory that proves itself, and no result claimed that no call produced

- Status: Accepted (built)
- Date: 2026-11-09
- Amends: 0017 (what a run's memory block carries), 0117 §4 and 0120 (trust decided per run), 0097 (the turn-end
  judgment)
- Code: engine `context/tools.ts` (`remember` and its team save, `update_memory`, `itemLabel`, `itemText`,
  `speakersOf`, `retrieveForRun`, `teamMemoryForPrompt`, `search_context`'s envelope, `expand`), `context/items.ts`
  (`isQuote`, `personSaid`, Confirmar in `editContextItem`, `namesSomeone`, `howToChannels`, `isInfraFact`, team
  memory: `teamMemorySql`, `listTeamMemories`, `makeTeamMemory`), `context/backfill.ts`, `context/feedback.ts`
  (`recordContextUse`), `context/consolidate.ts`, `context/scorecard.ts`, `context/summaries.ts`
  (`summaryModelReady`), `context/learn.ts`, `search.ts` and adapters `search.ts` (`keywords`), `context.ts` (the
  cached prompt), `team-week.ts` (the `howto` row), `continuation.ts` (`unbacked`), `capabilities.ts`, `jobs.ts`;
  server `routes/app/memory.ts` (`confirmed`, `team-memories`, `…/team`, `memory-scorecard`), `routes/app/agents.ts`
  (`ai-status`'s `reflection`), `start.ts` (the backfills); client `useMemoryAction` (`confirm`, `team`),
  `useTeamMemories`, `lib/team-week.ts`; web `TeamMemory.tsx`, `SettingsPage.tsx`, `agent/MemoryTab.tsx`,
  `MemoryPage.tsx`, `ai/Jev.tsx`, `TeamWeekCard.tsx`; phone `memory/MemoryScreen.tsx`, `settings/GeneralScreen.tsx`,
  `right-hand/TeamWeekCard.tsx`

## Context

Memory was mostly stalled. Most items were untrusted, including much of what people asked agents to remember: trust
was decided per run, from a 30-message window that ordinary work keeps marked as relaying outside content, so a
person's own words were stored as "data, never instructions" and their rules were refused. Each run's memory block spent most of its budget
on the agent's own top items whatever the request was about; matching was by words only, against items keyed in
English and asked in Portuguese. Uses were counted when an item was sent, not used. "Everyone, remember" became a
copy per agent that held only in the DM where another agent relayed it. Reflection failed for workspaces with no
model to run it. And an agent asked for an image made no call and answered "Pronto!" with a sticker; the end-of-turn
judgment marked it done.

## Decision

1. **Trust comes from each memory's own source.** A `remember` answering a person's own message (not one sent through
   an AI app) is trusted. In a run that read outside content, the item keeps that message's exact words as what agents
   read (evidence `quote`); the agent's wording is only its title, for people. Rules save in such runs too, the same
   way: `RULE_AFTER_OUTSIDE` is gone; the address check (`unaskedDestination`), the credential check and who may give
   or change a rule stay. What the agent found itself in such a run stays untrusted. Lines name their source and day
   ("[rule · Ana Souza, 2026-11-08]"); `search_context` keeps the outside envelope only around what came from outside.
   **Confirmar** (web Memory tab and page, phone) vouches for an item: who may edit it, or the person who said it.
   A one-off boot backfill re-derives trust per item from its own evidence (never all at once): an item a member's
   unmarked message backs becomes trusted unless it names an address that message doesn't; a preference saved where a
   rule was refused for outside content becomes that rule only when the message asked for a rule in so many words.
   Idempotent, logged with counts per kind before and after.
2. **Team memory.** `remember` with `for: "team"`: one item no agent owns, in the person's words, for the whole
   workspace or (`everywhere: false`) one conversation. Who reviews memory saves it at once; anyone else's becomes an
   org-context card they accept. The team's rules and preferences for the workspace go in every run's cached prompt
   under the org's context ("# Team memory", about 1,500 characters, the rest by title), so the right hand reads them
   too; one conversation's come in every run there; team facts and decisions by search. Settings › General (web,
   phone) lists them with who and when, Editar and Remover; "Tornar do time" makes an agent's item the team's and
   archives the copies agents kept of it.
3. **One save for "pessoal, lembrem".** `remember`'s description says to save once for the team; a save in a run
   another agent started is refused with a pointer to the team save (a copy would hold only in that DM); every save
   reply says where it holds.
4. **The budget goes to what matches.** The fixed core is the team's memory, pinned items, the person's preferences
   and the preferences people gave the agent, never cut. Then what matched the request, then who holds which access,
   then one line naming its most used other items ("Also in your memory, open with expand"). The rest of its own items
   and the team's lessons come only when they match. A use counts, and raises relevance, only when an item matched or
   was opened with `expand`; what is sent anyway only stays fresh, and what a person said no longer decays away.
5. **Matching across languages.** Each item's English key is indexed with it (`keywords`, on the title's hidden
   second line, never shown) and embedded with it. Embeddings stay env-gated (the addendum below: any
   OpenAI-compatible server, with the reindex queued at boot); self-host stays on full text unless configured.
6. **Proven how-tos become skills with one click.** The weekly card (ADR 0137 §9) offers its person the how-tos of
   their own agents reused at least three times that nobody vouched for: "Ada aprendeu: … Usado 3×. Virar skill?".
   It confirms the how-to; the day's pass (`promoteHowTos`) makes it the agent's skill.
7. **Measured.** `GET …/agents/{id}/memory-scorecard` (owner, who reviews memory): runs, the cost of runs that reused
   a how-to against the runs that wrote them, preferences people repeated, corrections and refused approvals per 100
   runs, items sent and opened, and a holdout: one run in ten (`memoryArmOf`) still carries its own items whatever the
   request, and the two arms' refusals are compared. An offline retrieval test checks LongMemEval's categories
   (across languages, updates, time, knowing when not to answer): the item a request needs is in the top 5, with
   and without vectors.
8. **Dates and re-checks.** Each line shows the saved day; a fact about where things run older than 30 days reads
   "check before relying"; an unconfirmed fact no request matched or opened for 30 days is archived (restorable).
9. **How-tos leave agents' DMs.** A how-to worked out in an agents' DM that names nobody (no member's name, no email
   address or phone number) reaches the agent's other work; a boot backfill widens the existing ones once.
10. **No reflection without a model.** Reflection isn't queued where the summary model can't be called, and
    `ai-status`'s `reflection` says so in Settings › AI accounts.

**The honesty lane.** The end-of-turn judgment gets one more verdict, `unbacked`: the reply says something was made,
sent or done that no call in the run did. Such a reply is never posted (nor kept in a routine's record); the run goes
on once with a nudge to do it with a tool or say plainly it can't, then ends as it is. The capabilities line adds that
something is made, sent or done only when a call of the agent's did it. Same judge call, no extra model call.

## Consequences

- People's words are trusted where they said them; outside content still marks runs, guards actions and relayed
  text, and agents' own findings in marked runs stay data.
- A member's team save lands in the org context once accepted, not in the team list. A setting letting members'
  saves apply at once was left out: add it when a workspace asks.
- The per-run block gets shorter on average (own items off topic are a title each); the cached prompt grows by the
  team's memory, capped.
- Own items that never match now decay and archive like any unused item; what people said doesn't.

## Addendum (2026-11-09): vectors across languages

§5's English keys help only a request that uses a key's own words: search stays word for word, and a Portuguese
request rarely shares one with an English memory. On MKQA (Portuguese questions, English passages), keyword search
has the answer in its top 100 for 44.9% of questions, and the multilingual bge-m3 for 76.3% (BGE-M3 paper, table 2).
The hybrid ranking already fuses words with vectors; what was missing was a multilingual model the Cloud and
self-hosters can run, and search that survives the model's server.

Code: providers `embeddings.ts` (`createOpenAIEmbeddings`, `EMBEDDING_CATALOG`), engine `gateway.ts` (`embed`),
`search.ts` (`upsertWithEmbeddings`, `reindexOrg`'s kinds, `searchVisible`, `queueEmbeddingBackfill`), `jobs.ts`
(`search.reindex`), adapters `search.ts` (the vector query), config `schema.ts` (`EMBEDDINGS_*`), server `engine.ts`
and `start.ts`, `docker-compose.yml` (`embeddings`).

1. **One adapter for OpenAI's embeddings API** (`EMBEDDINGS_PROVIDER=openai`, `EMBEDDINGS_URL`,
   `EMBEDDINGS_API_KEY`): DeepInfra, OpenAI, or a server of one's own (text-embeddings-inference, vLLM, llama.cpp,
   Ollama). At most 16 texts a request (text-embeddings-inference refuses more than 32 by default). A shorter vector
   is padded with zeros to 1024, which keeps its cosine similarities, so no migration; a longer one is refused.
   `EMBEDDING_CATALOG` holds each model's list price, size, query prefix and whether it is asked for 1024 numbers.
2. **The model: `Qwen/Qwen3-Embedding-0.6B`** (Apache-2.0, 1024 numbers), $0.01 per million tokens on DeepInfra:
   Portuguese↔English retrieval 94.2 / 93.4 nDCG@10 on Belebele, MMTEB 64.6. Its queries start with its instruction
   (`Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:`, from its
   sentence-transformers config); documents get none. If it misses, `Qwen/Qwen3-Embedding-8B` costs the same, has the
   best published scores (MMTEB 70.9) and is asked for 1024 of its 4096 numbers. `BAAI/bge-m3` (1024) and
   `ibm-granite/granite-embedding-311m-multilingual-r2` (768, padded; not on DeepInfra, the fastest on a CPU) are in
   the catalog for servers of one's own, OpenAI's text-embedding-3 models (asked for 1024) for its API. Voyage stays.
3. **What gets vectors, in this order** (`EMBEDDINGS_KINDS`, default `context_item`): memories first; then wiki
   pages, files, tasks and the team's actions; messages last, after a migration of `search_documents.embedding` to
   `halfvec(1024)` and a check of the disk: they are most of the documents, and their vectors and HNSW index would
   take most of it. Other kinds keep words alone, and a query is embedded only when a kind it searches has vectors.
4. **Words when vectors fail.** A query's vector waits at most `EMBEDDINGS_QUERY_TIMEOUT_MS` (1.5 s; a CPU server may
   need more); when it fails or is late, search goes on with words alone, so a run never loses its searched memory to
   the provider. A document whose vector fails is still indexed by its words, and its job retries the vector. The
   failure that makes three in a row is reported to error reports, once until a call succeeds. Usage and cost stay
   recorded per workspace, kind `embedding`, through the gateway.
5. **One model's vectors at a time.** The vector query compares only documents whose `embedding_model` is the
   query's, so a reindex half done never mixes two models. One HNSW index holds every workspace, and pgvector takes
   its 40 nearest before filtering by workspace: the query turns on its iterative scan (`hnsw.iterative_scan =
   relaxed_order`, `hnsw.ef_search = 100`, for that query alone) and keeps the distance cut outside a materialized
   CTE, as pgvector advises. pgvector before 0.8 runs it without.
6. **No reindex step.** At every start, each open workspace holding documents of `EMBEDDINGS_KINDS` that the model
   didn't embed gets one `search.reindex` of those kinds, once per model and kinds (its dedupe key), again at a later
   start when that one failed. Turning vectors on, changing the model or adding a kind needs nobody; a workspace on
   hold gets it at a start after it opens again.
7. **Self-host.** The compose file's `embeddings` profile, off by default: Hugging Face's text-embeddings-inference
   CPU image with `EMBEDDING_MODEL` (Qwen3-Embedding-0.6B), capped at 2 CPUs and 3 GB, at
   `http://embeddings:8080/v1`. Or `EMBEDDINGS_URL` at DeepInfra or any OpenAI-compatible server. With Postgres
   alone, search stays full-text.

Left out: translating the query with a small model, and keys written in several languages. A translated query
still matches word for word, and keys cover only the languages written and only memories.

Checked offline: 24 made-up memories, Portuguese requests for English ones and the reverse, among lookalikes that
share their words, with a fake model that gives a translation its original's vector: every one is in the top 5 of
the hybrid ranking, almost none by words alone. A real model is checked in production.
