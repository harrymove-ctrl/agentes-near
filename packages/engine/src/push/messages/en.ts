/** Every push kind's words. English has them all; another language what it translated, English for the rest. */
export interface PushStrings {
  someone: string;
  anAgent: string;
  approvalTitle: (actor: string) => string;
  approvalBody: string;
  approvalHighRisk: (what: string) => string;
  /** A high-risk ask with no words of its own to show: the warning alone. */
  approvalHighRiskBody: string;
  approvalFromRoutine: (routine: string) => string;
  questionTitle: (actor: string) => string;
  questionBody: string;
  mentionTitle: (actor: string) => string;
  replyTitle: (actor: string) => string;
  missionStoppedTitle: string;
  routineFailedTitle: string;
  runFailedTitle: (actor: string) => string;
  routineFailedBody: string;
  routinePausedTitle: string;
  routinePausedBody: string;
  rightHandPausedTitle: (name: string) => string;
  rightHandPausedBody: string;
  agentUnreachedTitle: (agent: string) => string;
  agentUnreachedBody: string;
  routineStalledTitle: string;
  routineStalledBody: (computer: string) => string;
  routineWaitingPlanTitle: string;
  routineWaitingPlanBody: string;
  planResetUnknownTitle: (plan: string) => string;
  planResetUnknownBody: (agent: string) => string;
  machineConnectedTitle: string;
  computerReadyTitle: string;
  computerReadyBody: string;
  browserHandoffTitle: (actor: string) => string;
  browserHandoffReminderTitle: (actor: string) => string;
  browserHandoffBody: string;
  desktopHandoffTitle: (actor: string) => string;
  desktopHandoffReminderTitle: (actor: string) => string;
  desktopHandoffBody: string;
  secretTitle: (actor: string) => string;
  secretBody: string;
  widgetAlertTitle: (actor: string, widget: string) => string;
  widgetFailedTitle: (widget: string) => string;
  /** Why a widget didn't update, by its coded reason (`widgets.failure.*` in the apps); others: `widgetFailedBody`. */
  widgetFailedReasons: Record<string, string>;
  widgetFailedBody: string;
  proposalWaitingTitle: (actor: string) => string;
  dashboardProposalTitle: (actor: string) => string;
  dashboardProposalBody: (dashboard: string) => string;
  joinRequestTitle: (name: string, org: string) => string;
  joinSuggestionTitle: (by: string, name: string, org: string) => string;
  joinRequestBody: string;
  deviceJoinRequestTitle: (computer: string, org: string) => string;
  deviceJoinRequestBody: string;
  waitingTitle: string;
  openBody: string;
  sentGif: string;
  sentSticker: string;
  sentVoice: string;
  usageWarningTitle: (percent: number) => string;
  usageReachedMineTitle: string;
  usageMineBody: string;
  usageReachedTitle: (person: string) => string;
  usageRequestTitle: (person: string) => string;
  usageRequestBody: string;
  usageRaisedTitle: (admin: string) => string;
  usageRaisedBody: string;
  usageRefusedTitle: (admin: string) => string;
  /** Lodi's weekly card (ADR 0137 §9): its message's text, so the push and the conversation list read it. */
  /** Bring your own devices: `agent` works for `person` on this person's `device`. */
  deviceInUseTitle: (agent: string, person: string, device: string) => string;
  deviceInUseBody: string;
  deviceAccessTitle: (agent: string, person: string, device: string) => string;
  deviceAccessBody: string;
  deviceWaitingTitle: (person: string, device: string) => string;
  deviceWaitingBody: string;
  teamWeekReady: string;
  /** Lodi's daily card ("Resumo do dia") came. */
  teamDayReady: string;
  /**
   * A personal workspace's words (ADR 0159), where the team's would speak of a workspace, a team or its admins: one
   * person and their agents (and maybe their family) read these. `renderPush` picks them for `personal`.
   */
  machineConnectedTitlePersonal: string;
  computerReadyTitlePersonal: string;
  agentUnreachedBodyPersonal: string;
  /** Over `widgetFailedReasons`, by the same codes: only those that would read wrong. */
  widgetFailedReasonsPersonal: Record<string, string>;
  joinRequestTitlePersonal: (name: string) => string;
  joinSuggestionTitlePersonal: (by: string, name: string) => string;
  teamWeekReadyPersonal: string;
}

export const en: PushStrings = {
  someone: "Someone",
  anAgent: "An agent",
  approvalTitle: (a) => `${a} needs your approval`,
  approvalBody: "Tap to see the request.",
  approvalHighRisk: (what) => `${what}. Open the app to review it.`,
  approvalHighRiskBody: "A high-risk request. Open the app to review it.",
  approvalFromRoutine: (routine) => `Routine «${routine}»`,
  questionTitle: (a) => `${a} has a question for you`,
  questionBody: "Tap to answer.",
  mentionTitle: (a) => `${a} mentioned you`,
  replyTitle: (a) => `${a} replied`,
  missionStoppedTitle: "A mission stopped",
  routineFailedTitle: "A routine didn't finish",
  runFailedTitle: (a) => `${a} couldn't finish`,
  routineFailedBody: "Tap to see what happened.",
  routinePausedTitle: "A routine was paused",
  routinePausedBody: "Tap to see why.",
  rightHandPausedTitle: (name) => `${name} stopped approving for you`,
  rightHandPausedBody: "You undid 3 of its decisions this week. Tap to review.",
  agentUnreachedTitle: (agent) => `A routine couldn't call ${agent}`,
  agentUnreachedBody: "Only the people the agent works with can talk to it. Tap to let it.",
  routineStalledTitle: "A routine is waiting for its computer",
  routineStalledBody: (c) => `It runs when ${c} is back.`,
  routineWaitingPlanTitle: "A routine is waiting for its plan to reset",
  routineWaitingPlanBody: "It runs when the plan resets.",
  planResetUnknownTitle: (p) => `${p} didn't say when its limit resets`,
  planResetUnknownBody: (a) => `${a}'s work is still waiting.`,
  machineConnectedTitle: "A new computer joined the workspace",
  computerReadyTitle: "Your workspace's computer is ready",
  computerReadyBody: "Open an agent's page to see it live.",
  browserHandoffTitle: (a) => `${a} needs you in the browser`,
  browserHandoffReminderTitle: (a) => `${a} still needs you in the browser`,
  browserHandoffBody: "Tap to open the screen.",
  desktopHandoffTitle: (a) => `${a} needs you on the computer`,
  desktopHandoffReminderTitle: (a) => `${a} still needs you on the computer`,
  desktopHandoffBody: "Open agentes.chat on a laptop to help.",
  secretTitle: (a) => `${a} needs a secret from you`,
  secretBody: "Tap to send it securely.",
  widgetAlertTitle: (a, w) => (w ? `${a}: ${w}` : `${a} flagged a widget`),
  widgetFailedTitle: (w) => (w ? `“${w}” didn't update` : "A widget didn't update"),
  widgetFailedReasons: {
    no_update: "The last update ended without data.",
    budget_exceeded: "The agent reached its budget for the month.",
    waiting_computer: "The agent's computer is away.",
    waiting_plan: "The agent's plan is at its limit.",
    waiting_budget: "The agent's budget is at its limit.",
    missing_credential: "The agent has no AI key or plan to work with.",
    timeout: "The update took too long.",
    creator_left: "Whoever set it up left the workspace.",
    creator_no_access: "Whoever set it up can no longer use it.",
    failing: "It failed several times in a row and stopped.",
  },
  widgetFailedBody: "Tap to see why.",
  proposalWaitingTitle: (a) => `${a} proposes an improvement`,
  dashboardProposalTitle: (a) => `${a} wants to publish a dashboard`,
  dashboardProposalBody: (d) => (d ? `“${d}” · Tap to decide.` : "Tap to decide."),
  joinRequestTitle: (name, org) => `${name} asks to join ${org}`,
  joinSuggestionTitle: (by, name, org) => `${by} suggested ${name} for ${org}`,
  joinRequestBody: "Tap to approve or deny.",
  deviceJoinRequestTitle: (computer, org) => `${computer} wants to join ${org}`,
  deviceJoinRequestBody: "Tap to let it join or deny.",
  waitingTitle: "Something is waiting for you",
  openBody: "Tap to open.",
  sentGif: "Sent a GIF",
  sentSticker: "Sent a sticker",
  sentVoice: "Sent a voice message",
  usageWarningTitle: (p) => `You've used ${p}% of your limit this month`,
  usageReachedMineTitle: "You've reached your usage limit this month",
  usageMineBody: "Tap to see your usage.",
  usageReachedTitle: (a) => `${a} reached their usage limit this month`,
  usageRequestTitle: (a) => `${a} asked for more usage this month`,
  usageRequestBody: "Tap to raise the limit or decline.",
  usageRaisedTitle: (a) => `${a} raised your limit this month`,
  usageRaisedBody: "You can keep going.",
  usageRefusedTitle: (a) => `${a} declined your request for more usage`,
  deviceInUseTitle: (a, p, d) => (p ? `${a} (for ${p}) is using your ${d}` : `${a} is using your ${d}`),
  deviceInUseBody: "Tap to stop it.",
  deviceAccessTitle: (a, p, d) => (p ? `${a} (for ${p}) asks to use your ${d}` : `${a} asks to use your ${d}`),
  deviceAccessBody: "Tap to allow once, always, or say no.",
  deviceWaitingTitle: (p, d) => `${p}'s agent is waiting for your ${d}`,
  deviceWaitingBody: "It starts when it's back.",
  teamWeekReady: "Your team's week is ready",
  teamDayReady: "Your day's summary is ready",
  machineConnectedTitlePersonal: "A new computer was connected",
  computerReadyTitlePersonal: "Your agents' computer is ready",
  agentUnreachedBodyPersonal: "Whoever made the routine can't talk to this agent yet. Tap to let them.",
  widgetFailedReasonsPersonal: { creator_left: "Whoever set it up is no longer in your workspace." },
  joinRequestTitlePersonal: (name) => `${name} asks to join your workspace`,
  joinSuggestionTitlePersonal: (by, name) => `${by} suggested inviting ${name}`,
  teamWeekReadyPersonal: "Your week is ready",
};
