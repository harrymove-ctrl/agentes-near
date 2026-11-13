# 0063. Usage views: each plan account by computer, an agent's month, and its part of a limit

- Status: Accepted. Amended 2026-10-30: §5 (a plan's limits where the budget was). Amended 2026-10-31: §5 (your plans' limits in Sua conta and, near a limit, in the account menu; the workspace's budget only where it uses the API; a budget counts only its agent's own calls; the compact bar's color), §6 (the agent sees its own usage)
- Date: 2026-10-24
- Extends: ADR 0026 (budget visibility), ADR 0059 (AI accounts belong to people; §7 usage limits)

## Context

ADR 0059 shows each plan account's limits where the account is chosen: the windows the CLIs report (`machine_accounts.usage`, and `machines.executors.ownUsage` for a computer's own sign-in), tightest first. Two questions stay open: how much of an account's limit each agent took, and, for an agent, where its month went (which account, which day, how much through the API). The limit belongs to the account, an agent can move between accounts during a month, and a computer's own sign-in can serve several of its pairer's agents. Plan tokens were recorded per run and agent, but not per account.

## Decision

### 1. Plan tokens say which account they spent

`usage_records.machine_id` and `usage_records.brain_account_id` (nullable, no foreign keys so the history outlives a removed account or computer): set on every plan row, `machine_id` with a null account meaning that computer's own sign-in. API rows keep both null; plan rows from before this have no machine and read as "before accounts were recorded". An account is keyed `machine:kind:account` (`…:computer` for the own sign-in).

### 2. An agent's part of a window is an estimate, and says so

Providers only give the whole account's percentage. An agent's part of a window = the window's percentage × the agent's share of what the account spent since the window started (`resetsAt` minus the window's length: 5 hours, a week, 30 days for a month). Each row weighs what it would cost through the API (catalog prices, so Opus weighs more than Haiku; summed tokens at the base prices, since a sum crosses no long-context threshold); a model without a price (Codex with no model chosen) weighs its tokens at the window's average priced rate, or one each when nothing in the window has a price. A model's own week (`seven_day_opus`, `seven_day_sonnet`) counts only that model. A provider's own window (`other`) has no known length, so it has no estimate. The screens draw an agent's part in full ink inside the account's bar and say in one line that it is an estimate.

### 3. Two views

- **Configurações › IA e uso**, for every member: the plan accounts (the accounts added on each computer, and a computer's own sign-in that agents used this month or think with now), each one row that opens. Closed, it shows the account, whose it is and one meter, the window closest to its limit; open, its windows, every agent's part, the month's tokens and, for its owner, what they do with it (rename, sign in again, disconnect). The viewer's own logins of one account are one row. The same screen holds the workspace's provider keys, so there is no separate AI accounts screen: its old address opens this one. Then, only where the workspace bills per use (an agent thinks through the API with a key, or something was spent through it this month): the API per agent against its budget and, for admins, the API's spend by kind and the default budget. On plans alone the screen shows no budget.
- **Agent → "Uso"**: one sentence with the month by account, the month day by day colored by account, the account it thinks with now (its windows with this agent's part, and who shares it), and the month by account. The tab informs: changing the account stays in "Quem pensa".

`GET …/usage/plans` and `GET …/agents/{agentId}/usage` serve them. Opening either asks the viewer's own computers for fresh windows, as the accounts screens do (`POST …/ai-accounts/refresh`), and an account's change refreshes both views.

### 4. Who sees what (ADR 0026, ADR 0059)

Everyone in the workspace sees tokens, percentages, windows and an account's name and owner. An account's email only its owner. Money only with `view_usage`: what plan tokens would cost through the API ("≈ US$ … pela API"; the plan is already paid) and the API's real cost and budgets.

### 5. A plan's limits where the budget was

*Amended 2026-10-30.* An agent on a plan showed "0% of the October budget" on its page and in Members, a number that only counts what is paid through an API key. Wherever an agent's usage is a line (its page's facts and side card, Members' agents, its profile card, the phone's agent profile):

- **On a plan**, its account's limits: the account's name and its tightest windows, two at most, in short words ("Claude Team · semana 40% · 5h 12%"), one bar for the fullest, every window on hover and in Uso, and only near the limit (80%) when it renews ("Quase no limite · renova às 14:00", "No limite até 14:00"). A plan's limit is never called a budget.
- **The budget** shows for an agent on the API as before, and for an agent on a plan only once it spent through the API this month (its fallback, or the workspace's model before it moved to the plan), as a second short line after the plan's.
- **Unknown is nothing**: a window not reported yet, or a plan whose maker doesn't share its usage, shows no line rather than 0%. A plan that refused a request before any window was reported says only that it is at the limit (the account's name and "No limite", no bar).
- Settings › AI accounts draws each account and each computer's own sign-in with the same compact line.

The agent list (`GET …/agents`, and the agent an edit returns) carries it in `brain`: `account`, the account's name (a computer's own sign-in by its plan, "Claude Max", only where that sign-in can think for the agent, ADR 0059 §3), and `usage`, the windows the runner last reported (absent while unknown). Everyone sees both, as §4 allows; the computer's name stays admins' and the owner's. The apps refetch the list when a computer's accounts change (`machine.updated` with `accounts`, sent only when a window moved a point or more). No migration and no protocol change. One rule (`usageShown`, `packages/client/src/lib/plan-usage.ts`) and one line (`planLine`, `packages/ui/src/plan-state.ts`, drawn by `PlanMeter compact` on the web and its twin on the phone) serve every place.

*Amended 2026-10-31.* The workspace's budget read "0%" in a workspace that thinks only on plans (the account menu before it became a short menu, the Uso tile of the web's Settings, the phone's workspace page). It shows only where the workspace uses the API: an agent on the model brain has a key to think with (the AI status says it is ready, ADR 0061), or the agents spent through the API this month (the overview's `budgetUsedPercent` above 0). One rule, `workspaceUsesApi` in `packages/client/src/lib/plan-usage.ts`, reads what the apps already hold (the agent list's `brain`, the AI status, the overview): no new request. A budget counts only its agent's own calls (`usage_records.kind = 'agent'`): on the screens (`agentBudgetsThisMonth`, the agent page's `agentDetail`), in the gateway's counter when it starts a month or a budget changes (`agentSpendThisMonth`), and as API use in the usage views (`readUsage` reads a plan's rows, the router's on the plan too, and the agent's own calls). Jev's judgments (an agent's status line, its tool groups) and the router's calls on a key are recorded with the agent's id but never billed to its budget, and on plans alone they crossed 0.1% after a few hundred runs, which brought the budget back.

The viewer's own plans' limits (`ownPlanLines`): the plans one of their agents thinks with whose limits are known, their computers' own sign-ins first (while one of their agents on that computer thinks with no account, ADR 0059 §3), then their accounts (while `usedBy` names an agent and one of its logins is signed in), named as "Seus planos" names them, and two of one name say which as it tells them apart: their computers, or on the same computer an account's email. Configurações › Sua conta lists them with the compact line above, each opening Uso, and shows nothing while no window is known. The account menu stays short: one line under the viewer's status only while one of those plans is at its limit or from 80% (`PLAN_ALMOST`, where the compact line already says "Quase no limite"), at its limit first, then the fullest: its maker's mark, its name and its state ("Quase no limite", "No limite até 15:40"), opening Uso. Sua conta and the menu ask the computers to look the usage up again when they open, as every plan meter does (`refreshAccountUsage`), and the menu reads the accounts then. Members without `view_usage` see their own plans' limits too: percentages, never money.

*Amended 2026-10-31:* the compact line's one bar and the words under it take the color of the tightest window, or of the limit when the plan refused a request (ADR 0059 §7: amber from 80%, red from 90%), as the full meter's words do.

### 6. The agent sees its own usage

*Added 2026-10-31.* Asked "how is your usage limit?", an agent could only say it couldn't check. `get_my_usage` (`packages/engine/src/usage-tools.ts`) is a built-in tool with no scope: every agent has it in every run, with no grant, in the rarely used group `more` that `find_tools` loads on demand (ADR 0043). It reads the agent's own Uso tab as someone without `view_usage` sees it (`agentUsageFor` with no viewer, which also serves `GET …/agents/{agentId}/usage`):

- the plan it thinks with (its name, maker, plan and owner), each window tightest first with its percentage, when it resets in the time zone of the person behind the run and the agent's estimated part (§2), and near or at the limit what the apps say (`planWindows`, `planState`);
- its tokens this month, plans and API apart;
- how much of its API budget it used where it uses the API: always on the model brain, on a plan once it spent through the API this month (§5).

Only its own numbers: never another agent's part, tokens or budget, nor an account's email. Never money (the budget's amounts, what plan tokens would cost through the API), even when an admin asks: the result stays in the run, whose steps the agent's owner reads without `view_usage` (`GET …/runs/{runId}`, §4), and the answer may go to a channel where not everyone may see costs. It says the amounts are in Configurações › Orçamento e uso, for those who may see them. The run policy lists it as a read, so a routine's run, with nobody behind it, calls it too. The chat names the call "Conferiu o próprio uso" / "Checked its usage".

## Consequences

- Positive: one place answers who spent what, where, for plans and the API together, and an agent's page tells which account carried its month.
- Positive: no new storage for limits and no protocol change: the windows are the ones ADR 0059 already keeps.
- Negative: an agent's part is an estimate. The parts always add up to the window's percentage, so use of the account outside agents (its owner in their own terminal) is split among the agents as if it were theirs; and a window's part rounds to the hour it started.
- Negative: plan usage from before the new columns shows as one source per brain, without its account.

## Alternatives considered

- **A table of limits per account, written from the turns.** It repeats what ADR 0059 already stores with each account. Rejected.
- **Splitting by raw tokens.** Simpler, but it overstates cheap models against a plan. Weighted by API price, tokens as the fallback.
- **Inferring the account from the agent's current choice.** Wrong as soon as an agent moves accounts or several agents share a computer's own sign-in. Rejected.
- **The usage views' own request for a list's lines (§5)** (`GET …/usage/plans`). It reads the month's usage rows to answer what the account rows already hold. Rejected.
- **No budget at all for an agent on a plan (§5).** Its fallback and a month that began on the API spend real money. Rejected: the budget shows once it spent.
- **Every plan in the account menu (§5).** A short menu grows a line per plan for a number that matters near a limit. Rejected: they are in Sua conta, and the menu shows one only from 80%.
