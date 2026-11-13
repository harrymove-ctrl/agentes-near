import type { LegalDocument } from "./types";

export const termsEn: LegalDocument = {
  title: "Terms of Use",
  summary: "The agreement for using agentes.chat: your workspace, your agents, and what each side is responsible for.",
  updated: "2026-11-06",
  sections: [
    {
      id: "agreement",
      heading: "1. Agreement",
      blocks: [
        'These Terms of Use (the "Terms") are a binding agreement between CODARI GLOBAL, LLC, a Wyoming limited liability company doing business as agentes.chat ("agentes.chat", "we", "us"), and the person or entity that creates an account or a workspace ("you"). By creating an account, joining a workspace, or otherwise using agentes.chat on the web, the Mac app or the phone app (the "Service"), you accept these Terms and our Privacy Policy. If you use the Service on behalf of a company or other entity, you represent that you have authority to bind it.',
        "You must be at least 18 years old and able to enter into a contract to use the Service.",
      ],
    },
    {
      id: "service",
      heading: "2. The Service",
      blocks: [
        "The Service is a workspace where people and AI agents work together. It includes channels, threads and direct messages, and agents with their own roles, instructions, memory and budgets. It also includes tasks, wiki, Drive, calendar and routines, approvals, connectors to other services, and the option to connect computers on which agents can work.",
        "The Service is new and still evolving: features may change, be limited or be removed. We may open new accounts only by invitation for a time, or to anyone who signs up. We will tell you in advance before removing something you rely on, where practicable.",
      ],
    },
    {
      id: "accounts",
      heading: "3. Accounts and workspaces",
      blocks: [
        "You are responsible for the accuracy of your account information, for the security of your credentials, and for all activity under your account. A workspace's owners and admins decide who joins it, what roles they have, which agents exist and what those agents may do. Where these Terms say a workspace owns, decides or answers for something, they mean the person or entity that created it, or on whose behalf it was created, acting through its owners and admins. Notify us promptly at security@agentes.chat if you believe an account, a key or a connected computer has been compromised.",
      ],
    },
    {
      id: "agents",
      heading: "4. Agents and what they do",
      blocks: [
        "Agents act on the instructions, permissions, connectors, budgets and computers that you and your workspace give them. What an agent does within those permissions, including messages it sends, code it changes, data it reads, writes or deletes, and commands it runs on a computer, is done on your workspace's behalf, and your workspace is responsible for it under these Terms. Each agent has a person responsible for it.",
        "Actions that are hard to undo become an approval request for a person before they happen. Approving one is your decision. The Service shows what will be done, but you are responsible for reviewing it.",
        "AI output can be wrong, incomplete or out of date, even when it sounds confident. Review what agents produce before relying on it, and do not use it as a substitute for professional advice (legal, medical, financial or otherwise) or as the only basis for decisions with legal or similarly significant effects on people.",
      ],
    },
    {
      id: "acceptable-use",
      heading: "5. Acceptable use",
      blocks: [
        "You agree not to use the Service, or let agents be used, to:",
        {
          list: [
            "break the law, infringe others' rights, or process personal data without a lawful basis",
            "send spam or unsolicited messages, or harass, threaten, deceive or impersonate anyone",
            "create or distribute malware, phishing, or content that sexualizes minors, promotes violence or is otherwise unlawful",
            "get around the Service's limits and safeguards, such as budgets, rate limits, approvals, permissions, or the checks on connected computers and databases",
            "attack the Service or others through it, including probing for vulnerabilities, overloading it, or planting instructions meant to take over other people's agents",
            "access a service, computer or data you are not authorized to use, or use a connected service against its own terms",
            "violate the usage policies of the AI model providers that run your agents.",
          ],
        },
        "We may suspend an agent, a connector or an account, with notice where practicable, when activity threatens the security, integrity or lawful operation of the Service or of others.",
      ],
    },
    {
      id: "content",
      heading: "6. Your content",
      blocks: [
        '"Workspace Content" means what you and the other people in your workspace put into the Service and what your agents produce in it. Your workspace owns its Workspace Content, and as between you and us, the output agents produce for you is yours, subject to the terms of the model provider that produced it. Output may be similar to what the same models produce for others.',
        "You grant us the limited rights needed to operate the Service: to store, process, transmit and display Workspace Content in order to run your workspace and agents, send it to the providers your agents use as described in the Privacy Policy, and provide support. We do not sell Workspace Content and do not use it to train machine-learning models.",
        "Your workspace is the controller of the personal data in its Workspace Content, and we process that data on its instructions as a processor, as described in the Privacy Policy and the Data Processing Addendum.",
      ],
    },
    {
      id: "third-parties",
      heading: "7. Model providers, connectors and your own accounts",
      blocks: [
        "Agents run on AI models from third parties (such as Anthropic, which makes Claude, and OpenAI), through an API key your workspace adds or an AI plan, such as Claude or ChatGPT, that someone in your workspace connects. Using that key or plan is also governed by your agreement with its provider, and you are responsible for following its terms and for its charges.",
        "Connectors give agents access to other services (such as GitHub, Google, Linear, Sentry or an email inbox). Those services are provided by third parties under their own terms. Their availability and what they do with data are outside our control.",
      ],
    },
    {
      id: "computers",
      heading: "8. Connected computers",
      blocks: [
        "If you connect a computer, you install software that lets agents run commands and use a browser on it, within the folders and permissions you set on that computer. You are responsible for the computer, for what you allow there, and for keeping backups of what matters. Permissions can only be widened on the computer itself, and you can disconnect it at any time.",
      ],
    },
    {
      id: "data-protection",
      heading: "9. Data protection",
      blocks: [
        "Where the GDPR, UK GDPR or LGPD applies to personal data in your Workspace Content, each party will comply with its obligations under that law. A Data Processing Addendum (DPA) incorporating the European Commission's Standard Contractual Clauses and equivalent LGPD terms is available and, when executed, is incorporated into these Terms. Request it at legal@agentes.chat.",
      ],
    },
    {
      id: "fees",
      heading: "10. Plans, payments and fair use",
      blocks: [
        "Each workspace pays for its own agentes.chat plan. These rules apply to every plan:",
        {
          list: [
            "**Prices.** Plans and their prices are on our pricing page. Prices are in US dollars, and taxes are added where they apply. Your bank or payment provider may charge its own fees on purchases from abroad, such as the IOF in Brazil.",
            "**Renewal.** A plan renews automatically each month or each year, depending on the period chosen, until it is canceled. We send a reminder before a yearly plan renews.",
            "**Cancellation.** You can cancel at any time, and the cancellation takes effect at the end of the period already paid. Then the workspace's agents stop, its computer is wiped 7 days later, and its conversations and files stay available to read and download for 90 days, after which they are deleted.",
            "**No refunds.** Payments are final and non-refundable, in whole or in part, including for the rest of a period after a cancellation, except where the law requires otherwise.",
            "**Failed payments.** If a payment fails, we try again over the following days. If it still fails, the workspace is put on hold: its agents stop, and people can still read and write in it. Its computer is kept for 7 days, then released and wiped. Paying brings the workspace back, on a new computer if the old one was released.",
            "**Price changes.** We may change prices for new customers at any time. The price of a plan you already have changes only because of new taxes, from its next renewal, with at least 30 days' notice.",
            "**Fair use.** Some features run on AI services we provide at no extra charge, such as choosing which agent answers, judging memories and actions, and finding what to click on a screen. We may limit them for a workspace whose use is far above normal.",
            "**Budgets.** Budgets set per workspace and per agent stop agents' model usage when they are reached. They are part of the Service, not a defect of it. Charges a provider makes for your own key or AI plan are between you and that provider.",
          ],
        },
      ],
    },
    {
      id: "ip",
      heading: "11. Intellectual property and feedback",
      blocks: [
        "Except for your Workspace Content, we and our licensors keep all rights, title and interest in the Service, including its software, design and the agentes.chat name and marks. Feedback you choose to send us may be used without obligation to you.",
      ],
    },
    {
      id: "termination",
      heading: "12. Term and termination",
      blocks: [
        "You may stop using the Service and delete your account at any time in the app. Your account is removed 7 days later, and you can restore it until then. We may suspend or end your access for material breach of these Terms, where required by law, or with 30 days' notice if we discontinue the Service. When we end the Service for reasons other than your breach, we will make your Workspace Content available for export for 30 days, then delete it as described in the Privacy Policy. Sections that by their nature survive termination (including 6, 9, 11, 13, 14 and 15) do so.",
      ],
    },
    {
      id: "disclaimers",
      heading: "13. Disclaimers",
      blocks: [
        'The Service, including everything agents produce and do, is provided "as is" and "as available". We do not warrant that the Service or agents will be uninterrupted, error-free, accurate or fit for your purposes. To the maximum extent permitted by law, we disclaim all implied warranties, including merchantability, fitness for a particular purpose and non-infringement.',
      ],
    },
    {
      id: "liability",
      heading: "14. Limitation of liability",
      blocks: [
        "To the maximum extent permitted by law, neither party is liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue or data. To the same extent, our aggregate liability arising out of the Service is limited to the amounts you paid us in the twelve months before the event giving rise to the claim (or USD 100 if you paid nothing). These limits do not apply to your payment obligations, your breach of Section 5, or liability that cannot be limited by law.",
      ],
    },
    {
      id: "indemnification",
      heading: "15. Indemnification",
      blocks: [
        "You will defend and indemnify us against third-party claims arising from your Workspace Content, from what your agents did within the permissions you gave them, or from your breach of Section 5.",
      ],
    },
    {
      id: "law",
      heading: "16. Governing law",
      blocks: [
        "These Terms are governed by the laws of the State of Wyoming, USA, excluding its conflict-of-law rules, and the parties submit to the exclusive jurisdiction of the state and federal courts located in Wyoming. If you are a consumer in a jurisdiction whose law grants you non-waivable rights or venue, such as Brazil, those rights are unaffected.",
      ],
    },
    {
      id: "changes",
      heading: "17. Changes to these Terms",
      blocks: [
        "We may update these Terms. Material changes will be announced by email or in the app at least 14 days before they take effect. Continued use after the effective date is acceptance. The current version always lives at this page. If a translation and the English version differ, the English version prevails, except where the law requires otherwise.",
      ],
    },
    {
      id: "contact",
      heading: "18. Contact",
      blocks: [
        "CODARI GLOBAL, LLC, doing business as agentes.chat. Notices: 7345 W Sand Lake Rd Ste 210, Office 4592, Orlando, FL 32819, USA · legal@agentes.chat · Everything else: hello@agentes.chat",
      ],
    },
  ],
};
