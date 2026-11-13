import type { Widen } from "@agenteschat/i18n/widen";

/** The app's own strings in English, the source: every other language follows this shape. */
export const mobileEn = {
  common: {
    back: "Back",
    cancel: "Cancel",
    close: "Close",
    continue: "Continue",
    done: "Done",
    retry: "Try again",
    loading: "Loading",
    or: "or",
  },
  auth: {
    skyLabel: "Sky with agents",
    social: {
      failed: "Couldn't sign you in right now. Try again.",
      unfinished: "Sign-in didn't finish. Try again or use your email.",
    },
    errors: {
      network: "No connection. Check the internet and try again.",
      generic: "Something went wrong. Try again.",
      /** On the e-mail step with no connection: the lookup tries again by itself, the e-mail stays. */
      offlineRetry: "No internet right now. I'll go on as soon as it's back.",
    },
    flow: {
      /** The first question, alone: the keyboard is open under it from the start. */
      email: "What's your e-mail?",
      emailLead: "To sign in or create your account.",
      /** New here: the name and the password on one screen. */
      signUp: "Nice to meet you. What does the team call you?",
    },
    server: {
      line: "Server: {{host}} ·",
      change: "Change",
      /** The question is the title; the keyboard's return key ("go") is the action. */
      title: "Where is your agentes.chat?",
      subtitle: "The address your team opens in the browser.",
      label: "Server address",
      placeholder: "agentes.yourteam.ts.net",
      use: "Use this server",
      checking: "Checking…",
      scan: "Scan QR code",
      backTo: "Back to {{host}}",
      /** The sign-in's quiet line ends in "Change", which offers the server or the language in the system's list. */
      footChange: "Change",
      footChoose: "Server and language",
      footServer: "Another server",
      footLanguage: "Language",
      /** The quiet line under the sign-in, on the Cloud: it opens the camera for the team computer's QR code. */
      footTeam: "Use your team's server?",
      footTeamAction: "Sign in through it",
      /** On a team's server: where this sign-in goes, and the way to another. */
      footOn: "Signing in on {{host}}",
      footSwitch: "Change",
      now: "Now on {{host}}",
      invalid: "Check the address, something like agentes.yourteam.ts.net.",
      unreachable: "We can't reach {{host}}. Check the address and your connection, and try again.",
      unreachableTailscale:
        "We can't reach {{host}}. It's on Tailscale: open the Tailscale app, connect and try again. Connected already? The computer it runs on may be asleep, or its app closed.",
      certificate: "The certificate of {{host}} isn't valid. Talk to whoever runs the server.",
      notAgentes: "{{host}} isn't an agentes.chat server. Check the address.",
      serverTooOld: "{{host}} needs an update to work with this app.",
      appTooOld: "Update the agentes app to use {{host}}.",
      down: {
        line: "{{host}} didn't answer.",
        text: "It may be down or outside your network. The app opens on its own once it's back.",
        tryNow: "Try now",
        /** Beside Sign out on the waiting splash: fix the address without leaving the account. */
        switchServer: "Change server",
        /** Beside the wick burning down to the next automatic try. */
        retryIn_one: "tries again in {{count}} s",
        retryIn_other: "tries again in {{count}} s",
      },
    },
    connect: {
      title: "Connect to this server?",
      titleSignIn: "Sign in with the computer's account?",
      on: "Server: {{host}}",
      leave: "You'll be signed out of the current account on this phone.",
      confirm: "Connect",
      notNow: "Not now",
      checking: "Checking the server…",
      notALink: "This link isn't from an agentes.chat server.",
      tokenFailed: "The code expired or was already used. Sign in with your email, or show a new code on the computer.",
      signInSlow:
        "Signing in is taking longer than it should. Sign in with your email, or show a new code on the computer.",
    },
    scan: {
      hint: "Point at the QR code on the computer",
      /** Under the camera: the address, for whoever has no code to scan. */
      typeAddress: "Type the address",
      notOurs: "This QR code isn't from an agentes.chat server.",
      cameraTitle: "Use the camera",
      cameraText: "It's only used to read the QR code.",
      allow: "Allow camera",
      settings: "Open Settings",
    },
  },
  org: {
    noneTitle: "You're not in a workspace yet",
    noneSubtitle: "Ask someone on your team for an invitation, or create the workspace on the website.",
    openSite: "Open the website",
    signOut: "Sign out",
  },
  account: {
    deleteFailed: "Couldn't delete your account right now. Try again.",
    deleted: "Your account goes for good on {{date}}. Sign in before then to restore it.",
    signedOut: "You signed out.",
  },
  theme: {
    system: "Same as the phone",
    light: "Light",
    dark: "Dark",
  },
  push: {
    channel: "Alerts",
    channelDescription: "What's waiting for you, mentions and conversations.",
    /** One event line in the conversation, after an agent said it will take a while. */
    offer: {
      line: "Want to know when {{name}} is done?",
      action: "Notify me",
    },
    ask: {
      title: "Know when an agent needs you",
      text: "They work while you do something else. We'll tell you when they need your ok, finish what you asked or call you.",
      on: "Turn on notifications",
      later: "Not now",
      done: "Notifications on",
      failed: "Couldn't turn on notifications. Try again in You\u00a0›\u00a0Notifications.",
      someone: "An agent",
      examples: "Examples of notifications",
      now: "now",
      minutes: "{{n}} min",
      approval: { title: "{{name}} needs your ok", body: "Can I go ahead with what you asked?" },
      finished: { title: "{{name}} is done", body: "What you asked for is ready." },
      mention: { title: "{{name}} called you", body: "Can you take a look when you have a minute?" },
    },
  },
  a11y: {
    agent: "{{name}}, agent",
    agentWorking: "{{name}}, agent, working",
    agentPlain: "Agent",
    person: "{{name}}",
    loading: "Loading",
    grabber: "Drag down to close",
    closeSheet: "Close",
    send: "Send",
    attach: "Attach and more",
    hold: "Hold to confirm",
    clearSearch: "Clear search",
  },
  composer: {
    placeholder: "Write a message",
    join: "Add to the task in progress",
    now: "Stop and send",
    choice: "How to send while the agent works",
    /** Under the field while an agent works here, until the person has held the send button once. */
    holdToStop: "Hold to stop and send",
  },
  search: {
    placeholder: "Search",
  },
  picker: {
    /** A picker's search found none of its options. */
    none: "Nothing matches “{{text}}”.",
  },
};

/** Every language of these strings has this shape (English is the source). */
export type MobileTranslations = Widen<typeof mobileEn>;
