# 0054. A fast browser: plans in one call, targets in words, a judge that checks, one layer for computer use

- Status: Proposed
- Date: 2026-10-23
- Builds on: ADR 0040 (the agent browser on `agent-browser`), ADR 0031 (computer use), ADR 0032 (one engine, the runner as a bridge), ADR 0053 (who is behind a run, the policy table)
- Changes in ADR 0040: §5 (tools answer with what changed; targets in words) and the "later" row "Intent tools with Jev", done here in another shape
- Desktop surface: ADR 0062, which also changes this one for the browser: boxes over half the screenshot's height or 80% of its width are refused (§2), words that can't be undone are never taken at a bare point and more words are costly (§2), and an unsure check is judged once more on the image (§4)
- Code: `packages/engine/src/screen/*` (the layer), `browser/surface.ts`, `browser/tools.ts`, `judge.ts` (images, Box), runner `browser.ts` (`browser.batch`, `browser.capture`), protocol 17

## Context

### Where the time goes today

Every page action of an agent costs two turns of its own model. The agent reads the page (`browser_read`, up to 40,000 characters), picks an element number, calls `browser_click`, and the tool answers "Clicked. Read the page to see the result". The agent reads again before it decides anything. A sign-in (open, read, fill, type the password, click, read) is six model turns and two full pages in the context.

- A turn of a frontier model on a browser task takes 3–9 s: Navi-Bench measures 6.2–9.0 s per step for computer-use models, and Browser Use's own model about 3 s ([Yutori n1](https://yutori.com/blog/introducing-n1), [browser-use](https://browser-use.com/posts/speed-matters)).
- In desktop agents, planning and reflection by the big model take 75–94% of the task time. Grounding takes 3–6%, screenshots 1–4% and executing actions 1–2% ([arXiv 2506.16042](https://arxiv.org/html/2506.16042v1)).
- Every command is also a round trip from our server to the runner on the person's computer (one `browser.act`, one `agent-browser` process). The look after an action, a wait and a settle check would be three more round trips.

The lever is fewer turns of the big model and a smaller context, not faster clicks.

### What others do (October 2026)

- **State with each action.** Playwright MCP returns a snapshot after every action, and the Anthropic and OpenAI computer-use loops attach the screen to the action's result ([Playwright MCP](https://github.com/microsoft/playwright-mcp), [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)). Full state every time bloats the context: Skyvern 3.0 got 2.3× faster by sending less, not more ([Skyvern](https://www.skyvern.com/blog/deleting-rag-from-our-web-agent-made-it-2-3x-faster/)).
- **Several actions per turn.** browser-use runs up to 5 actions per step "until the page changes" ([docs](https://docs.browser-use.com/open-source/customize/agent/all-parameters.md)). UFO2 plans several actions in one call and halved its steps on OSWorld-W ([arXiv 2504.14603](https://arxiv.org/html/2504.14603v2)). OpenAI's `computer_call` returns an ordered list of actions.
- **A small model for grounding.** Magnitude pairs a big planner with Moondream as the executor, and Surfer-H pairs one with Holo1 as localizer and validator (92.2% on WebVoyager at a quarter of the cost) ([Holo1](https://huggingface.co/Hcompany/Holo1-7B)).
- **Verification.** Skyvern's validator, which catches false "added to cart" successes, added 17 points ([Skyvern 2.0](https://www.skyvern.com/blog/skyvern-2-0-webvoyager-benchmark-results/)). Pass/fail judges are noisy; graded answers and escalation help ([browser-use](https://browser-use.com/posts/benchmark-behind-the-benchmark)).
- **Caching known flows.** Stagehand caches actions behind a DOM hash and self-heals once ([caching](https://browserbase.com/changelog/stagehand-caching)). Blind replay misfires; only verified programs should replay ([arXiv 2606.17929](https://arxiv.org/html/2606.17929)).
- **Set-of-marks** doesn't help a web agent plan ([SeeAct](https://arxiv.org/abs/2401.01614)). It is useful to map a vision model's answer onto an element.
- **OpenMausBot and OpenBot** (our two references) use Jev for one decision only, who answers in a room. OpenMausBot lists "browser clicks, tool selection and where work runs" as "coming soon". Neither has targets in words, checks, or plans. Skyvern looked at "system one models like Jev" and found that version limited (64K context, no images).

Vendor numbers come from different harnesses and judges. They show a direction, not a measurement of ours.

### What `agent-browser` 0.39.1 and Jev give us

- **`agent-browser` 0.39.1:**
  - `snapshot --json` returns the page text plus a `refs` map (role and name per ref). Refs survive same-document changes.
  - `batch` runs several commands in one process.
  - `screenshot --annotate` numbers the interactive elements and returns each one's box (CSS pixels).
  - `mouse move/down/up` clicks a point.
  - `eval` awaits a promise.
  - A covered click fails before dispatch and names the element in the way.
- **TypeSafe Jev:**
  - **Choice:** over up to 255 options.
  - **Noul:** a calibrated probability.
  - **Many questions on one state, in one request:** 13 questions over a 54,000-character article took 0.27 s and cost $0.0005 ([cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)). The price is $0.042 per million input tokens, and output is free.
  - **Images and Box:** take still images and **Box**, the box of a target on an image (`jev-1.14.0`/`jev-preview`, with the `TypeSafe-Danger-Zone-Images` header). These are "Dreamer-ready": not called production-ready yet.

## Decision

### 1. A screen layer, not a browser feature (`packages/engine/src/screen/`)

One layer does observe → find → act → check, over a `ScreenSurface`:

- `observe()`: the screen as text, one node per line, with refs.
- `perform(action, { settle })`: one action, then waiting for the screen to settle and looking again.
- `capture()`: an image with marked elements, when the surface can take one.

The browser is the first surface (`browser/surface.ts`). A desktop surface fills the same interface later, from the OS accessibility tree and screenshots, with mouse and keyboard. Targets, checks, plans and reports are reused as they are; that is the way into computer use (ADR 0031).

### 2. Targets in words, cheapest first (`targets.ts`)

The agent names what it acts on, as a number (`e12`) or in words ("the Sign in button", "Edit in the row for invoice 42"):

1. **A ref**, as given. The browser checks it; a stale one fails and says so.
2. **Exactly one element with that name** and a fitting role, preferring a control over text with the same name (the heading "Sign in" next to the button). No judge.
3. **The target memory:** what the same words found on the same page of the same site before, kept per agent (an LRU in the process, by host and generalized path, `/orders/:id`). It is found again by role, name **and place**: the Edit of the row for invoice 42 is found again only in that row, wherever the row moved, and when nothing or several things match the judge decides again. A costly one (delete, pay, send…) is never taken from memory, since its place is kept only in part (a row's text is cut short): the judge decides it each time, at 0.85.
4. **The judge** picks among the page's fitting elements: only fields for a fill, boxes for a tick. Each element is described with where it sits (`button "Delete" — in row "Invoice 42 · R$ 42,00"`). A table row has no name of its own in `agent-browser`'s snapshot (the invoice number is a sibling cell), so a row is named by its other cells. One request carries a Choice over refs (plus "none") and a Noul for whether it's there at all. Rules:
   - The pick is taken at p ≥ 0.55, at least 0.2 ahead of the next.
   - An element whose wrong pick costs (pay, delete, send, confirm…) needs 0.85. So does a plain "Yes" or "OK" inside a dialog that asks for one ("Delete project Acme?").
   - Two elements that read the same are never picked, however sure the judge is.
   - Below that, the three closest go back to the agent, which picks by number.
   - Only a calibrated judge picks: the request is marked `calibrated`, so without Jev (or when it fails) the cheap model, whose probabilities are all 1, is never asked. The closest by their words go back instead, and the agent is told to give the element's number or its exact name.
5. **An image of the page** (`browser.capture`, protocol 17), when the text has nothing that fits: an icon without a name, a canvas. The judge boxes the target and confirms it's there (≥ 0.6). A box over most of the image is refused. The point lands on a marked element's ref when there is one, so the action stays as exact as a ref; otherwise it is a click at the point. Passwords are only typed into elements found on the page, never at a point.

### 3. Every action answers with what changed

After an action the runner waits until the page has settled:

- the DOM has been quiet for 120 ms since the wait began (at most 2 s). One `MutationObserver` per document remembers when the DOM last changed. After a click or a key, nothing may change at first (a submit the server answers later): the wait then gives the page up to 400 ms for its first change. A choice or a tick changes a property, not the DOM, so it doesn't wait for one;
- the document has loaded (`wait --load domcontentloaded`, at most 8 s, tolerated);
- the DOM is quiet again, counted from its last change: on a page that didn't navigate this returns at once, and on a new document it starts fresh.

Then it looks once, at the whole tree (`snapshot`, not `-c`: on a page of plain paragraphs the compact tree drops the text; measured, 3 lines of 290 on a long cart page, the total among the lost ones). The tool answers with:

- **on the same page:** the lines added and removed, counted from what the agent last saw (up to 3,500 characters);
- **on a new page:** what can be acted on, meaning lines with a ref plus headings, dialogs and alerts (up to 6,000 characters);
- **in both cases:** the address.

Page text stays inside the untrusted `page_content` block. `browser_open` answers with the new page's controls, so the agent acts at once. `browser_read` is for reading text. With `find` it returns only the lines that answer a question ("the order total"), with three lines of context. The page goes in windows of at most 200 lines and 20,000 characters. Each window is its own request, with a Choice over its lines and a Noul for whether they answer the question, and all of them are asked at once. Jev reads at most 32k tokens per question and 64k per request, so a long page in one request fails. Past 12 windows, the ones with the question's words are asked, and the answer says how much of the page was searched.

### 4. Plans: `browser_do`

`browser_do({ steps })` takes up to 15 steps: open, click, fill, select, check, uncheck, press, type_secret, scroll, hover, wait, back, read. Each step's target is found on the page as it is at that moment, so a plan crosses pages whose elements the agent never saw. `read` with `find` ("the status message") brings what the page says at that point into the answer, so a plan can end by reporting.

A step may carry `expect` ("signed in", "the cart has 2 items"); the judge checks it on the settled page (≥ 0.6 true, < 0.35 false, unsure counts as not shown). An `expect` that isn't true yet gets up to 2 s to become true (a form that navigates after its submit), looked at again every 300 ms and judged only when the page changed; it gives up sooner when the page stays the same for 1 s (counted from when the judge answered). A look or a judgment that fails once, as the page navigates, doesn't end it; three in a row do.

The plan stops at the first step that fails, can't find its target, or doesn't show what it expected. A step whose action went through but whose `expect` didn't hold says so ("Clicked Export, but the page doesn't show … It was done: don't do it again"), so the agent never repeats an action it can't confirm; nor is such an answer marked as an error, which would read as "it didn't happen". It answers with:

- what ran;
- where it stopped and why, with the closest elements when a target wasn't clear;
- the page at the end.

A person taking over the browser stops the plan before its next step, and the run waits on them as before. A take over that began and ended within one step stops it too, and the page isn't counted as read: the agent reads it before acting again. The single tools (`browser_click`, `browser_fill`…) are one-step plans: the same finding, settling and answer.

`wait` takes `until` in words ("the export finished"). It is polled about every 0.7 s, and the judge looks again only when the page changed (a fingerprint of the snapshot).

### 5. A banner in the way

When a click fails because something covers its target, the plan looks once. The judge picks the control that only closes it: Close, ×, Not now, Reject optional cookies. Never one that buys, subscribes, accepts terms or grants anything. The pick is taken at ≥ 0.7; then the step runs again. This happens once per plan, and the report says what was closed.

### 6. One round trip per action (protocol 17)

- **`browser.batch`:** several `browser.act` commands back to back in the agent's session, with nothing else in between. Each command goes through the same checks: known command, no flag the runner sets, paths in the agent's folder, URLs on the allowed sites, the allowlist checked after each action. A command that wouldn't pass refuses the whole batch before anything runs. A failure stops it unless the command tolerates failing (the settle and load waits).
- **`browser.capture`:** `screenshot --annotate` as a JPEG (quality 70), read and deleted at once, only of a page on the agent's allowed sites (like every read). A file a timed-out capture left is removed by the next one. It returns the image's size, the page's size in CSS pixels and the numbered elements with their boxes.

Older runners get the same commands one `browser.act` at a time, and no images. Everything else works.

### 7. The judge sees images (`judge.ts`)

`JudgeRequest.images` (placeholder → JPEG or PNG) and Box questions go to Jev's vision model, with the images header:

- **Model:** `JEV_VISION_MODEL`, default `jev-preview`. The release can change without code; 1.14 takes images.
- **Timeout:** 6 s.
- **Size limits:** the runner's 1280×800 window fits Jev's limits (each side 280–1568 px). An image outside them isn't sent.
- **Fallback:** the org's cheap model refuses images and boxes. A target the text lacks is then reported as not found.

Text questions keep `jev-latest`, with the cheap model as fallback.

### 8. Safety

- **Page text stays in the untrusted block:** the report names elements by role and number (`button (e7)`); their names, the closest candidates and what `find` returned go with the page, inside `page_content`.
- **The judge only points:** at something already on the page, or says whether something is true there. It never grants anything, and an approval is still the agent's to ask for (`ask_user`). Element names it reads are page text; the costly-pick threshold and the dismiss rule keep a hostile name from turning into a payment or a consent.
- **Secrets:** `type_secret` is typed by the runner from what `request_secret` delivered, only on the site the person answered for, and only into a password or one-time-code field found on the page.
- **Routines:** the policy table (ADR 0053) applies to `browser_do` as to every browser tool: `browser:use` is an internal area, refused to "only look" routines.

### 9. Cost and what is recorded

- **Usage and cost:** every judge call is recorded with `org_id` and `agent_id` like the other judgments (kind `router`, provider `typesafe`). A target is 1,500–2,500 input tokens, about a hundredth of a cent. A plan's report carries each step's time (`data.timing`).
- **Jev's price was recorded 1,000× too low** (`JEV_NANO_USD_PER_INPUT_TOKEN` was 0.042; the catalog's unit is USD per million × 1,000, so $0.042 per million is 42). Fixed here, for every Jev judgment.
- **The chat's trail:** each step goes on the trail as the tool it stands for (`meta.browser.steps`), so the card of where the agent browsed is unchanged.

### Measured (2026-10-23, `bun run eval:browser` and `eval:browser:micro`)

The setup: real Claude, real Chrome for Testing through `agent-browser` 0.39.1 and real Jev, on local Acme pages, with a simulated 100 ms server↔runner trip.

- **Old:** the tools and guidance from before this ADR, verbatim.
- **New:** these.
- **Done** means the page shows the result **and** the answer says so.

**A/B, last round (every fix below in)**

| | Old | New |
|---|---|---|
| Sign-in + export, Sonnet 5.5 (2 runs) | done 2/2 · 15.1–16.6 s · 7–8 turns · 22–25k input tokens | done 2/2 · **11.3–11.7 s · 2 turns · 7.3k** |
| Settings behind an icon on a 150-row dashboard, Sonnet 5.5 | done **0/2** · 27.9–28.2 s · 8–11 turns · 130–185k | done 2/2 · **13.6–13.7 s · 3 turns · 11.8k** |
| The same, Opus 5.5 | done 1/2 · 17.8–36.4 s · 7–11 turns · 102–207k | done 2/2 · **17.1–18.3 s · 3 turns · 12.2k** |

**Again after the two reviews of the PR** (Sonnet 5.5, 2 runs each):

| | Old | New |
|---|---|---|
| Sign-in + export | done 2/2 · 16.7–17.5 s · 7–8 turns · 22–25k | done 2/2 · **11.2–13.2 s · 2–3 turns · 7.2–11.9k** |
| Settings behind an icon | done 2/2 · 24.4–25.5 s · 6 turns · 77–78k | done 2/2 · **14.1–14.6 s · 3–4 turns · 11.7–25.1k** |

One new run's `read` with `find` on the 150-row dashboard failed: Jev answered 400 `max_tokens_exceeded`. The page was 1,526 lines, 121 KB in one request, over Jev's 64k tokens per request. The run went on with a click, one turn more. Each window is now its own request (below).

**All rounds, scored the same way:** the old tools got **13 of 26** tasks done, the new ones **26 of 26**.

- **Why the old one failed:** in each miss it told the person it "couldn't confirm" the result. It reads the page before the site's answer has rendered.
- **Turns:** with a `read` step the model plans the whole sign-in-and-export (open, fill, fill, click, click, wait, read) in one `browser_do`.
- **Time:** time per turn varies a lot from run to run, depending on the API. The steady gains are fewer turns and much less context: 72–94% fewer input tokens, and so cheaper too.

**Parts (microbenchmark)**

- **Jev, a target in words:** 0.2 s at the median (worst 0.6 s), 9 of 9 right on the test pages, 0 ms from the site memory the second time. It got 2 table targets wrong until rows were named by their cells.
- **Jev's Box on a screenshot:** found the icon without a name in 0.22–0.25 s, at 0.98.
- **Checks:** right both ways in 0.2 s.
- **`find`:** on a 290-line cart page (14.7k characters) it answered with 203 characters in 0.28 s.
- **One action on the runner** (click, settle, look): 187 ms. It was 428 ms before the settle kept its observer across waits.
- **The sign-in plan of 6 steps** (with the cookie banner, the `expect` and the export wait, 2.5 s of it the page's own): 7.0 s on protocol 17 against 10.3 s on protocol 12.

**What the measurements changed in this ADR**

- The look is the whole tree, not `-c`.
- Table rows are named by their cells, and elements that read the same are never picked.
- The settle has one observer per document and waits up to 400 ms for a first change after a click or a key.
- An `expect` that isn't true yet gets up to 2 s, and stops when the page stays the same for 1 s.
- A step whose action ran but whose `expect` failed says it was done, so it isn't done twice. A run repeated an export because of this before the fix.
- The Box looks for controls that may be only an icon.
- There is a `read` step with `find`: the model asked for one at the end of a plan.
- Jev's recorded price is fixed.
- `find` asks each window of the page in its own request, all at once: one request for a whole long page went over Jev's limit.

## Order

| Stage | What | Difficulty |
|---|---|---|
| 1. Done in this PR | Screen layer, judge with images, targets in words, settle and changes, `browser_do`, `find`, `until`, banner dismiss, protocol 17 runner ops, tests | Medium |
| 2. Eval gate | ADR 0040's 20 pages × 5 targets with real Jev: accuracy of each threshold, vision on icons, cost and time per target. Thresholds move only on that. | Easy |
| 3. Desktop app release | Runner 17 in the Mac app (batch and images); until then, one round trip per command | Easy |
| 4. Verified replay | A plan that worked is kept per site with each step's role and name and its `expect`; a routine replays it with no judge and stops at the first difference. Payments and sends never replay. | Medium |
| 5. Prompt cache | A stable prefix (ADR 0050), so the turns that remain start fast | Medium |
| 6. Desktop surface | The same layer on the OS accessibility tree and screenshots (ADR 0031) | Hard |

Also worth trying, each when measured:

- warming the agent's Chrome when the judge loads the browser tools for a run;
- `snapshot --delta` on the runner instead of our diff;
- zooming into a region before a Box on small targets.

## Consequences

- An agent signs in, fills a form or checks a dashboard in one or two turns of its model instead of six or more, on any model.
- Targets in words work across pages the agent never read. Numbers still work and are the way for anything costly.
- A judge call sits between the agent and many actions. When it is unsure, the agent gets the closest elements instead of a guess, and a wrong pick is caught by the step's `expect` or the next look.
- Vision depends on a preview feature of Jev. It is off when the runner is older or Jev isn't configured, and everything else works without it.
- Runner protocol 17: the Mac app needs a release for the one-round-trip path and images.
- The same layer is the base for desktop computer use.
