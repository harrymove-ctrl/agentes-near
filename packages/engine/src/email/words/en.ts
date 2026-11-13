import { plural } from "@agenteschat/i18n/format";
import type { Inline, Text } from "../layout";

/**
 * Every email's words, in English and pt-BR. Plain text only (bold is `{ b }`): the layout escapes it.
 * Subjects, preheaders, headlines and buttons hold only these words; what people type or agents write
 * goes in the body, made inert by the caller. Plain voice, no em dashes or semicolons.
 * The layout keeps every text's last two words on one line, so a wrapped one never ends on a word alone. A card's
 * closing line ends in a `{ nobr }` of its own where those two would leave its last line above the baseline, short
 * of what the card's end margin expects (`END` in the layout), and a host keeps the word before it.
 */

export type Step = [title: string, text: string];

/**
 * A self-hosted server's host and the word before it ("at", "em") on one line: a narrow screen moves them down
 * together, so the host is never split at a hyphen nor alone on the last line. A host over 36 characters moves down
 * alone: with the word it may not fit a 320 px phone's line (digits run wide), and would then break inside again or
 * leave the word alone on a line of its own.
 */
export const atHost = (lead: string, word: string, host: string): Text =>
  host.length > 36 ? [`${lead} ${word} `, { nobr: `${host}.` }] : [`${lead} `, { nobr: `${word} ${host}.` }];

export const en = {
  /** Who sent it: agentes.chat, or a self-hosted server named by its host. */
  sentBy: (host: string | null): Text =>
    host ? atHost("Sent by the agentes.chat server", "at", host) : "Sent by agentes.chat.",
  fallback: "Button not working? Copy this address into your browser:",
  role: { owner: "an owner", member: "a member" } as Record<string, string>,
  anAgent: "An agent",
  someone: "Someone",
  verify: {
    subject: "Confirm your email for agentes.chat",
    preheader: "One click to confirm this address. The link works for an hour.",
    headline: "Confirm your email",
    body: "One step left: confirm that this address is yours.",
    button: "Confirm email",
    small: "The link works for an hour. If you didn't sign up, you can ignore this email.",
    why: "You got this email because this address was used to sign up for agentes.chat.",
  },
  reset: {
    subject: "Reset your agentes.chat password",
    preheader: "Choose a new password. The link works for an hour.",
    headline: "Choose a new password",
    body: "We got a request to reset the password for this address.",
    button: "Choose a new password",
    note: "Didn't ask for this? Ignore this email. Your password stays the same.",
    small: "The link works for an hour.",
    why: "You got this email because someone asked to reset the password for this address on agentes.chat.",
  },
  invitation: {
    subject: "You're invited to a workspace on agentes.chat",
    preheader: "Accept within 7 days, with this email address.",
    headline: "You're invited to a workspace",
    body: (inviter: string, email: string | null, org: string, role: string): Text =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} invited you to join `, { b: org }, ` as ${role}.`]
        : ["You're invited to join ", { b: org }, ` as ${role}.`],
    what: "agentes.chat is where people and AI agents work together.",
    noteFrom: (inviter: string, note: string): Text => [{ b: inviter ? `${inviter}: ` : "Their note: " }, `“${note}”`],
    button: "Accept invitation",
    small: "The invitation works for 7 days. Accept it with this email address.",
    why: (org: string) =>
      `You got this email because someone at ${org} invited this address. If you don't know them, ignore it. Nothing happens until you accept.`,
    /** A personal workspace's (ADR 0159): someone's family or friends, with no workspace name nor role to read. */
    personal: {
      body: (inviter: string, email: string | null): Text =>
        inviter
          ? [{ b: inviter }, `${email ? ` (${email})` : ""} invited you to their personal workspace on agentes.chat.`]
          : "You're invited to a personal workspace on agentes.chat.",
      why: () =>
        "You got this email because someone invited this address to their personal workspace. If you don't know them, ignore it. Nothing happens until you accept.",
    },
  },
  inviteRequest: {
    subject: "Someone asked for a new invitation",
    preheader: "Their invitation expired. You can send a new one from Members.",
    headline: "Someone asked for a new invitation",
    body: (email: string, org: string): Text =>
      email
        ? [{ b: email }, " opened an expired invitation to ", { b: org }, " and asked for a new one."]
        : ["Someone with an expired invitation link to ", { b: org }, " asked for a new one."],
    next: "If you expect them, send a new invitation from Members. If not, there's nothing to do.",
    button: "Open Members",
    why: (org: string) => `You got this email because you created this invitation, or manage the members of ${org}.`,
    personal: {
      body: (email: string): Text =>
        email
          ? [{ b: email }, " opened an expired invitation to your workspace and asked for a new one."]
          : "Someone with an expired invitation link to your workspace asked for a new one.",
      why: () => "You got this email because you created this invitation, or look after who is in your workspace.",
    },
  },
  calendar: {
    subject: "You're invited to an event",
    preheader: (when: string) => `${when}. See it in the calendar.`,
    headline: "You're invited to an event",
    facts: { event: "Event", when: "When", org: "Workspace", by: "Invited by" },
    someone: "Someone",
    button: "See the event",
    why: (org: string) => `You got this email because someone at ${org} invited you to an event.`,
    personal: {
      why: () => "You got this email because someone in your workspace invited you to an event.",
    },
  },
  waitlist: {
    subject: "Confirm your spot on the agentes.chat waiting list",
    preheader: "One click and your spot is saved.",
    headline: "Confirm your spot on the list",
    body: (email: string | null): Text =>
      email
        ? ["We got a request to put ", { b: email }, " on the agentes.chat waiting list."]
        : "We got a request to put this address on the agentes.chat waiting list.",
    approve: "Here, nothing important happens without a person approving it. That goes for this request too.",
    button: "Confirm my email",
    small:
      "The link works for 48 hours. Wasn't you? Ignore this email. Without the click, the address never joins the list.",
    why: "You got this email because this address was entered on the agentes.chat waiting list.",
  },
  earlyAccess: {
    subject: "Your invitation to agentes.chat is here",
    preheader: (days: number) => `Create your account within ${days} days, with this email address.`,
    headline: "Your access is ready",
    body: (email: string): Text => [{ b: email }, " can now create an account and a workspace on agentes.chat."],
    what: "agentes.chat is where people and AI agents work together.",
    button: "Create my account",
    small: (days: number) =>
      `The link works for ${days} days, for this address only. Sign up with a password, or with Google, GitHub or Apple on this same address.`,
    why: "You got this email because this address is on the agentes.chat waiting list, or was invited to agentes.chat. Nothing happens until you sign up.",
  },
  earlyAccessAllowed: {
    subject: "You can now create your own workspace",
    preheader: "Sign in with the account you already have and set it up.",
    headline: "Create your own workspace",
    body: (email: string): Text => [
      "You can now create your own workspace on agentes.chat with ",
      { b: email },
      ", the account you already have.",
    ],
    button: "Create my workspace",
    why: "You got this email because this account was given early access to agentes.chat.",
  },
  budget: {
    subject: {
      warning: "An agent passed 80% of its monthly budget",
      exhausted: "An agent stopped: monthly budget reached",
    },
    preheader: {
      warning: "At 100% it stops until the month turns or the limit goes up.",
      exhausted: "It won't answer until the month turns or the limit goes up.",
    },
    headline: { warning: "An agent passed 80% of its budget", exhausted: "An agent reached its budget" },
    used: (pct: string, org: string) => `Used ${pct} of this month's budget · ${org}`,
    warning: "At 100% it stops and says so in the channel. An admin can change the limit on the agent's page.",
    exhausted: "It won't answer until the month turns, or until an admin raises the limit.",
    button: "See the budget",
    why: (org: string) =>
      `You got this email because you own this agent, or are an admin of ${org}. It goes out at 80% and at 100%, once a month each.`,
    /** A personal workspace's (ADR 0159): one person and their own agents, no admin to ask. */
    personal: {
      warning: "At 100% it stops and tells you. You can change the limit on the agent's page.",
      exhausted: "It won't answer until the month turns, or until you raise the limit on the agent's page.",
      why: () =>
        "You got this email because this agent is one of yours. It goes out at 80% and at 100%, once a month each.",
    },
  },
  digest: {
    subject: (n: number) =>
      plural("en", n, {
        one: "A request is waiting for your approval",
        other: `${n} requests are waiting for your approval`,
      }),
    preheader: "Requests expire after 24 hours, and nothing runs without a decision.",
    headline: (n: number) =>
      plural("en", n, { one: "A request is waiting for you", other: `${n} requests are waiting for you` }),
    body: (n: number, org: string): Text => [
      "In ",
      { b: org },
      plural("en", n, {
        one: ", an agent asked to do something only a person can approve.",
        other: ", agents asked to do things only a person can approve.",
      }),
    ],
    age: (h: number) => `${h}\u00a0h\u00a0ago`,
    more: (k: number) => `And ${k} more.`,
    button: (n: number): string => plural("en", n, { one: "Review the request", other: "Open approvals" }),
    why: (org: string, hours: number | undefined) =>
      `You got this email because you can approve these requests in ${org}.${hours ? ` It goes out when a request waits more than ${hours} hours, once per request.` : ""}`,
    personal: {
      body: (n: number): Text =>
        plural("en", n, {
          one: "One of your agents asked to do something that needs your approval.",
          other: "Your agents asked to do things that need your approval.",
        }),
      why: (_org: string, hours: number | undefined) =>
        `You got this email because you can approve these requests.${hours ? ` It goes out when a request waits more than ${hours} hours, once per request.` : ""}`,
    },
  },
  ready: {
    subject: "Your agents' computer is ready",
    preheader: {
      ai: "Next: connect your AI, so your agents can think.",
      task: "Next: give your agents a first task.",
      create: "Next: create your first agent.",
    },
    headline: "Your agents' computer is ready",
    /** The picture's alt text: the computer, with the agents around it. */
    computer: "Your agents' computer",
    body: (org: string): Text => [
      "Thanks for waiting. ",
      { b: org },
      "'s computer is on and set up, with a user of its own for each agent. It stays on day and night, so your agents can work any time.",
    ],
    facts: { cpus: "CPUs", memory: "Memory", disk: "Disk" },
    next: "Next steps",
    steps: {
      ai: [
        "Connect your AI.",
        "Sign in with your Claude or ChatGPT plan, another AI's coding plan, or an API key. Your agents think with it.",
      ] as Step,
      task: ["Give a first task.", "In #general, call an agent with @ and say what you need."] as Step,
      watch: [
        "Watch them work.",
        "On an agent's page, press Open to see its computer live. Take control whenever you want, and hand it back when you're done.",
      ] as Step,
      create: ["Create an agent.", "It works on this computer from the start."] as Step,
    },
    button: { ai: "Connect your AI", task: "Give a first task", create: "Create an agent" },
    why: (org: string) =>
      `You got this email because you own ${org} on agentes.chat. It's the only email about this computer.`,
    /** A personal workspace's (ADR 0159): the person's computer for their agents, who they talk to directly. */
    personal: {
      body: (): Text =>
        "Thanks for waiting. Your agents' computer is on and set up, with a user of its own for each agent. It stays on day and night, so your agents can work any time.",
      steps: {
        task: ["Give a first task.", "Open a conversation with one of your agents and say what you need."] as Step,
      },
      why: () =>
        "You got this email because this workspace on agentes.chat is yours. It's the only email about this computer.",
    },
  },
  joinRequest: {
    subject: "Someone asks to join your workspace",
    preheader: "Approve or deny it in Members. Nothing happens until you answer.",
    headline: "A request to join is waiting",
    body: (org: string): Text => ["They opened ", { b: org }, "'s invitation link and asked to join."],
    note: "Approve only people you expect. They join as a member unless you pick another role on the page.",
    approve: "Approve",
    deny: "Deny",
    more: "All waiting requests are in Members." as Text,
    why: (org: string) =>
      `You got this email because you're an owner or admin of ${org}. It goes out at most once an hour.`,
    personal: {
      body: (): Text => "They opened your workspace's invitation link and asked to join.",
      why: () =>
        "You got this email because you look after who joins your workspace. It goes out at most once an hour.",
    },
  },
  joinAnswer: {
    someone: "Someone",
    joined: {
      subject: "Your request to join was approved",
      preheader: "You're in. Open the workspace to start.",
      headline: "You're in",
      body: (who: string, org: string, role: string): Text => [
        `${who} approved your request. You joined `,
        { b: org },
        ` as ${role}.`,
      ],
      button: "Open the workspace",
    },
    invited: {
      subject: "Your request to join was approved",
      preheader: "One step left: accept the invitation within 7 days.",
      headline: "Approved: one step left",
      body: (who: string, org: string): Text => [`${who} approved your request to join `, { b: org }, "."],
      next: "Accept the invitation with this email address within 7 days.",
      button: "Accept invitation",
    },
    denied: {
      subject: "Your request to join wasn't approved",
      preheader: "Someone at the workspace looked at it and didn't approve it.",
      headline: "Your request wasn't approved",
      body: (org: string): Text => ["Someone at ", { b: org }, " looked at your request and didn't approve it."],
      reason: (reason: string): Text => [{ b: "Their note: " }, `“${reason}”`],
      small: "If you think it's a mistake, ask someone there to invite you by email.",
    },
    why: (org: string) => `You got this email because this address asked to join ${org} on agentes.chat.`,
    /** Joining someone's personal workspace (ADR 0159): the person who answered, not a company. */
    personal: {
      joined: { body: (who: string): Text => `${who} approved your request. You're in their workspace now.` },
      invited: { body: (who: string): Text => `${who} approved your request to join their workspace.` },
      denied: {
        preheader: "They looked at it and didn't approve it.",
        body: (): Text => "The person you asked looked at your request and didn't approve it.",
        small: "If you think it's a mistake, ask them to invite you by email.",
      },
      why: () => "You got this email because this address asked to join a personal workspace on agentes.chat.",
    },
  },
  joinCode: {
    subject: (code: string) => `${code} is your agentes.chat code`,
    preheader: "Type it on the page to ask to join. It works for 10 minutes.",
    headline: "Your code",
    body: (org: string): Text => ["Type this code on the page to ask to join ", { b: org }, "."],
    small: ["It works for 10 minutes. If you didn't ask, ", { nobr: "ignore this email." }] as Text,
    why: (org: string) =>
      `You got this email because someone typed this address to ask to join ${org} on agentes.chat.`,
    personal: {
      body: (): Text => "Type this code on the page to ask to join this workspace.",
      why: () =>
        "You got this email because someone typed this address to ask to join a personal workspace on agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code: string) => `${code} is your code to delete a workspace`,
    subjectAccount: (code: string) => `${code} is your code to delete your whole account`,
    preheader: "Type it in agentes.chat to confirm. It works for 10 minutes.",
    headline: "Your code",
    workspace: (org: string): Text => [
      "Type this code to delete the workspace ",
      { b: org },
      ". It turns read-only for everyone at once and is deleted for good 7 days later.",
    ],
    account: (email: string): Text => [
      "Type this code to delete the whole account ",
      { b: email },
      ", not just one workspace. It's signed out everywhere at once and deleted for good 7 days later, and the workspaces only you are in close with it.",
    ],
    support: (address: string): Text => [
      "It works for 10 minutes, and nothing is deleted without it. If it wasn't you, don't share it and write to ",
      { mail: address },
      ".",
    ],
    noSupport:
      "It works for 10 minutes, and nothing is deleted without it. If it wasn't you, don't share it and tell the people who run this server." as Text,
    whyWorkspace: (org: string) => `You got this email because your account asked to delete ${org} on agentes.chat.`,
    whyAccount: "You got this email because your account asked to be deleted on agentes.chat.",
    personal: {
      workspace: (org: string): Text => [
        "Type this code to delete your workspace ",
        { b: org },
        ". It turns read-only at once and is deleted for good 7 days later.",
      ],
    },
  },
  deleting: {
    subject: (day: string) => `A workspace you're in will be deleted on ${day}`,
    preheader: "It's read-only now. An owner can still restore it until then.",
    headline: "A workspace is being deleted",
    body: (by: string, org: string, day: string, time: string): Text => [
      { b: by },
      " deleted the workspace ",
      { b: org },
      `. It's read-only now and goes for good on ${day} at ${time}.`,
    ],
    owner: "Changed your mind? Restore it before then.",
    button: "Restore the workspace",
    member: "If it's a mistake, ask an owner to restore it." as Text,
    why: (org: string) => `You got this email because you're in ${org} on agentes.chat.`,
    personal: {
      member: "If it's a mistake, ask whoever deleted it to restore it." as Text,
      why: () => "You got this email because you're in this workspace on agentes.chat.",
    },
  },
  restored: {
    subject: "A workspace you're in is back",
    preheader: "An owner restored it. It works again.",
    headline: "The workspace is back",
    body: (by: string, org: string): Text => [{ b: by }, " restored ", { b: org }, ". It works again."],
    button: "Open the workspace",
    why: (org: string) => `You got this email because you're in ${org} on agentes.chat.`,
    personal: {
      why: () => "You got this email because you're in this workspace on agentes.chat.",
    },
  },
  appConnected: {
    subject: "An app was connected to your agentes.chat account",
    preheader: "It can read and send tasks to agents as you in one workspace.",
    headline: "An app was connected",
    body: (app: string, org: string): Text => [{ b: app }, " now has access to your account in ", { b: org }, "."],
    note: "Didn't connect it? Disconnect it now and change your password.",
    button: "See connected apps",
    why: (org: string) => `You got this email because an app was connected to your account in ${org} on agentes.chat.`,
    personal: {
      body: (app: string): Text => [{ b: app }, " now has access to your account in your personal workspace."],
      why: () =>
        "You got this email because an app was connected to your account in your personal workspace on agentes.chat.",
    },
  },
  accountDeleting: {
    subject: (day: string) => `Your agentes.chat account will be deleted on ${day}`,
    preheader: "You have 7 days to change your mind.",
    headline: "Your account is being deleted",
    body: (email: string, day: string, time: string): Text => [
      "We will delete the account ",
      { b: email },
      ` on ${day} at ${time}. It's signed out everywhere, and nobody can reach you here until you're back.`,
    ],
    closes: (count: number, names: Inline[]): Text => [
      plural("en", count, {
        one: "The workspace only you were in closed now and goes on the same date: ",
        other: "The workspaces only you were in closed now and go on the same date: ",
      }),
      ...names,
      ".",
    ],
    undo: "Changed your mind? Sign in before that date and press Restore.",
    button: "Sign in to restore",
    why: "You got this email because this address has an account on agentes.chat.",
  },
  accountDeleted: {
    subject: "Your agentes.chat account was deleted",
    preheader: "It's signed out everywhere and can't sign in again.",
    headline: "Your account was deleted",
    body: (email: string): Text => ["We deleted the account ", { b: email }, "."],
    closes: (count: number, day: string, names: Inline[]): Text => [
      plural("en", count, {
        one: `The workspace only you were in is closed and will be deleted for good on ${day}: `,
        other: `The workspaces only you were in are closed and will be deleted for good on ${day}: `,
      }),
      ...names,
      ".",
    ],
    support: (address: string): Text => ["If it wasn't you, write to ", { mail: address }, "."],
    noSupport: "If it wasn't you, tell the people who run this server." as Text,
    why: "You got this email because this address had an account on agentes.chat.",
  },
  autonomy: {
    subject: (day: string, stalls: string, noise: string) => `Agents on ${day}: ${stalls} stalls, ${noise} noise runs`,
    preheader: "Where agents stopped and where they acted for nothing, against the 7 days before.",
    headline: (day: string) => `Stalls and noise on ${day}`,
    body: "Every active workspace on this server, over the UTC day. Names and counts only.",
    stalls: "Stalls",
    noise: "Noise",
    metric: {
      mentionNoRun: "Mentions that woke nobody",
      readOnly: "Runs that could only read",
      promiseUnkept: "Ended on work left undone",
      promiseIgnored: "Still undone after the nudge",
      handoffUnanswered: "Hand-offs unanswered in 30 min",
      limitStops: "Stopped by a limit",
      personUnanswered: "People unanswered in 10 min",
      taskStartFailed: "Tasks that failed at the start",
      noiseRuns: "Runs for nothing",
      quietRuns: "Ended without a word",
      ackReplies: "Answered a thanks or an ok",
      idleWakes: "Woken with nothing to do",
      noiseTokens: "Their tokens",
      noiseCostNanoUsd: "Their cost",
    } as Record<string, string>,
    value: (today: string, average: string) => `${today} · 7-day average ${average}`,
    topStalls: "Most stalls",
    topNoise: "Most runs for nothing, with their cost",
    none: "No workspace." as Text,
    table: (day: string) => `The whole table: bun run report:autonomy --day ${day}`,
    why: "You got this email because this address is in OPS_REPORT_EMAIL on this server. It goes out once a day.",
  },
  planOpened: {
    subject: (plan: string) => `More people can talk to your agent on your ${plan} plan`,
    preheader: (plan: string) => `Their conversations use your ${plan} plan and its limits.`,
    headline: "More people can talk to your agent",
    body: (by: string, agent: string, plan: string): Text => [
      { b: by },
      " let more people talk to ",
      { b: agent },
      `. Their conversations with it use your ${plan} plan and its limits.`,
    ],
    agent: "Agent",
    by: "Changed by",
    was: "Before",
    now: "Now",
    everyone: "Everyone in the workspace",
    onlyYou: "Only you",
    you: "You",
    note: "To undo it, change Who can talk on the agent's page.",
    button: "See who can talk",
    why: (org: string) =>
      `You got this email because an agent of yours in ${org} thinks with your plan and someone else changed who can talk to it.`,
    personal: {
      why: () =>
        "You got this email because an agent of yours thinks with your plan and someone else changed who can talk to it.",
    },
  },
  planLent: {
    subject: (plan: string) => `Your ${plan} plan now thinks for another agent`,
    preheader: (plan: string) => `Its conversations use your ${plan} plan and its limits. You can take it back.`,
    headline: "Someone connected your plan to an agent",
    body: (by: string, agent: string, plan: string): Text => [
      { b: by },
      ` connected your ${plan} plan to `,
      { b: agent },
      ". Its conversations use your plan and its limits.",
    ],
    agent: "Agent",
    by: "Connected by",
    plan: "Plan",
    note: "Take it back in one click from your notifications, and the agent stops thinking with your plan.",
    button: "Open notifications",
    why: (org: string) => `You got this email because someone in ${org} connected your plan to an agent.`,
    personal: {
      why: () => "You got this email because someone in your workspace connected your plan to an agent.",
    },
  },
  planWaiting: {
    subject: "Your team is waiting",
    preheader: "Your workspace is ready. It needs an agentes.chat plan to start.",
    headline: "Your team is waiting",
    body: (agents: number, channels: number, routines: number): Text => {
      const a = plural("en", agents, { one: "1 agent", other: `${agents} agents` });
      const c = plural("en", channels, { one: "1 channel", other: `${channels} channels` });
      const r = plural("en", routines, { one: "1 routine", other: `${routines} routines` });
      return `${routines > 0 ? `${a}, ${c} and ${r}` : `${a} and ${c}`} are ready. They need an agentes.chat plan to start.`;
    },
    button: "See agentes.chat plans",
    why: (org: string) => `You got this email because you run ${org} on agentes.chat. We send two of these, then stop.`,
    /** A personal workspace's (ADR 0159): the person's agents and routines, no team nor channels. */
    personal: {
      subject: "Your agents are waiting",
      headline: "Your agents are waiting",
      body: (agents: number, _channels: number, routines: number): Text => {
        const a = plural("en", agents, { one: "1 agent", other: `${agents} agents` });
        const r = plural("en", routines, { one: "1 routine", other: `${routines} routines` });
        return `Ready to go: ${routines > 0 ? `${a} and ${r}` : a}. All that's missing is an agentes.chat plan.`;
      },
      why: () => "You got this email because this workspace on agentes.chat is yours. We send two of these, then stop.",
    },
  },
};

/** Every email's words: English has them all; another language what it translated (`Partial`), English for the rest. */
export type Words = typeof en;
