import { plural } from "@agenteschat/i18n/format";
import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in fr: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("fr", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 */
export const words: EmailWords = {
  sentBy: (host) => (host ? atHost("Envoyé par le serveur agentes.chat", "sur", host) : "Envoyé par agentes.chat."),
  fallback: "Le bouton ne fonctionne pas ? Copiez cette adresse dans votre navigateur :",
  role: { owner: "propriétaire", member: "membre" },
  anAgent: "Un agent",
  someone: "Quelqu’un",
  verify: {
    subject: "Confirmez votre e-mail pour agentes.chat",
    preheader: "Un clic pour confirmer cette adresse. Le lien est valable une heure.",
    headline: "Confirmez votre e-mail",
    body: "Plus qu’une étape : confirmer que cette adresse est bien la vôtre.",
    button: "Confirmer l’e-mail",
    small: "Le lien est valable une heure. Si vous ne vous êtes pas inscrit, vous pouvez ignorer cet e-mail.",
    why: "Vous recevez cet e-mail car cette adresse a servi à créer un compte sur agentes.chat.",
  },
  reset: {
    subject: "Réinitialisez votre mot de passe agentes.chat",
    preheader: "Choisissez un nouveau mot de passe. Le lien est valable une heure.",
    headline: "Choisissez un nouveau mot de passe",
    body: "Nous avons reçu une demande de réinitialisation du mot de passe pour cette adresse.",
    button: "Choisir un nouveau mot de passe",
    note: "Vous n’avez rien demandé ? Ignorez cet e-mail. Votre mot de passe reste le même.",
    small: "Le lien est valable une heure.",
    why: "Vous recevez cet e-mail car quelqu’un a demandé à réinitialiser le mot de passe de cette adresse sur agentes.chat.",
  },
  invitation: {
    subject: "Vous êtes invité dans un espace de travail sur agentes.chat",
    preheader: "Acceptez sous 7 jours, avec cette adresse e-mail.",
    headline: "Vous êtes invité dans un espace de travail",
    body: (inviter, email, org, role) =>
      inviter
        ? [
            { b: inviter },
            `${email ? ` (${email})` : ""} vous invite à rejoindre `,
            { b: org },
            ` en tant que ${role}.`,
          ]
        : ["Vous êtes invité à rejoindre ", { b: org }, ` en tant que ${role}.`],
    what: "agentes.chat, c’est l’endroit où les personnes et les agents IA travaillent ensemble.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter} : ` : "Son message : " }, `« ${note} »`],
    button: "Accepter l’invitation",
    small: "L’invitation est valable 7 jours. Acceptez-la avec cette adresse e-mail.",
    why: (org) =>
      `Vous recevez cet e-mail car quelqu’un de ${org} a invité cette adresse. Si vous ne connaissez pas cette personne, ignorez-le. Rien ne se passe tant que vous n’acceptez pas.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [
              { b: inviter },
              `${email ? ` (${email})` : ""} vous invite dans son espace de travail personnel sur agentes.chat.`,
            ]
          : "Vous êtes invité dans un espace de travail personnel sur agentes.chat.",
      why: () =>
        "Vous recevez cet e-mail car quelqu’un a invité cette adresse dans son espace de travail personnel. Si vous ne connaissez pas cette personne, ignorez-le. Rien ne se passe tant que vous n’acceptez pas.",
    },
  },
  inviteRequest: {
    subject: "Quelqu’un demande une nouvelle invitation",
    preheader: "Son invitation a expiré. Vous pouvez en envoyer une nouvelle depuis Membres.",
    headline: "Quelqu’un demande une nouvelle invitation",
    body: (email, org) =>
      email
        ? [{ b: email }, " a ouvert une invitation expirée pour ", { b: org }, " et en demande une nouvelle."]
        : ["Une personne avec un lien d’invitation expiré pour ", { b: org }, " en demande un nouveau."],
    next: "Si vous attendez cette personne, envoyez-lui une nouvelle invitation depuis Membres. Sinon, il n’y a rien à faire.",
    button: "Ouvrir Membres",
    why: (org) => `Vous recevez cet e-mail car vous avez créé cette invitation, ou vous gérez les membres de ${org}.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " a ouvert une invitation expirée pour votre espace de travail et en demande une nouvelle."]
          : "Une personne avec un lien d’invitation expiré pour votre espace de travail en demande un nouveau.",
      why: () =>
        "Vous recevez cet e-mail car vous avez créé cette invitation, ou vous gérez qui fait partie de votre espace de travail.",
    },
  },
  calendar: {
    subject: "Vous êtes invité à un événement",
    preheader: (when) => `${when}. Voir dans l’agenda.`,
    headline: "Vous êtes invité à un événement",
    facts: { event: "Événement", when: "Quand", org: "Espace de travail", by: "Invité par" },
    someone: "Quelqu’un",
    button: "Voir l’événement",
    why: (org) => `Vous recevez cet e-mail car quelqu’un de ${org} vous a invité à un événement.`,
    personal: {
      why: () => "Vous recevez cet e-mail car quelqu’un de votre espace de travail vous a invité à un événement.",
    },
  },
  waitlist: {
    subject: "Confirmez votre place sur la liste d’attente d’agentes.chat",
    preheader: "Un clic et votre place est réservée.",
    headline: "Confirmez votre place sur la liste",
    body: (email) =>
      email
        ? ["Nous avons reçu une demande pour inscrire ", { b: email }, " sur la liste d’attente d’agentes.chat."]
        : "Nous avons reçu une demande pour inscrire cette adresse sur la liste d’attente d’agentes.chat.",
    approve: "Ici, rien d’important ne se fait sans l’approbation d’une personne. Cette demande non plus.",
    button: "Confirmer mon e-mail",
    small:
      "Le lien est valable 48 heures. Ce n’était pas vous ? Ignorez cet e-mail. Sans ce clic, l’adresse n’est jamais ajoutée à la liste.",
    why: "Vous recevez cet e-mail car cette adresse a été inscrite sur la liste d’attente d’agentes.chat.",
  },
  earlyAccess: {
    subject: "Votre invitation à agentes.chat est arrivée",
    preheader: (days) => `Créez votre compte sous ${days} jours, avec cette adresse e-mail.`,
    headline: "Votre accès est prêt",
    body: (email) => [{ b: email }, " peut maintenant créer un compte et un espace de travail sur agentes.chat."],
    what: "agentes.chat, c’est l’endroit où les personnes et les agents IA travaillent ensemble.",
    button: "Créer mon compte",
    small: (days) =>
      `Le lien est valable ${days} jours, pour cette adresse uniquement. Inscrivez-vous avec un mot de passe, ou avec Google, GitHub ou Apple sur cette même adresse.`,
    why: "Vous recevez cet e-mail car cette adresse est sur la liste d’attente d’agentes.chat, ou a été invitée sur agentes.chat. Rien ne se passe tant que vous ne vous inscrivez pas.",
  },
  earlyAccessAllowed: {
    subject: "Vous pouvez maintenant créer votre propre espace de travail",
    preheader: "Connectez-vous avec le compte que vous avez déjà et configurez-le.",
    headline: "Créez votre propre espace de travail",
    body: (email) => [
      "Vous pouvez maintenant créer votre propre espace de travail sur agentes.chat avec ",
      { b: email },
      ", le compte que vous avez déjà.",
    ],
    button: "Créer mon espace de travail",
    why: "Vous recevez cet e-mail car ce compte a obtenu un accès anticipé à agentes.chat.",
  },
  budget: {
    subject: {
      warning: "Un agent a dépassé 80 % de son budget mensuel",
      exhausted: "Un agent s’est arrêté : budget mensuel atteint",
    },
    preheader: {
      warning: "À 100 %, il s’arrête jusqu’au mois prochain ou jusqu’à ce que la limite augmente.",
      exhausted: "Il ne répondra plus jusqu’au mois prochain ou jusqu’à ce que la limite augmente.",
    },
    headline: { warning: "Un agent a dépassé 80 % de son budget", exhausted: "Un agent a atteint son budget" },
    used: (pct, org) => `A utilisé ${pct} du budget de ce mois · ${org}`,
    warning:
      "À 100 %, il s’arrête et le signale dans le canal. Un admin peut modifier la limite sur la page de l’agent.",
    exhausted: "Il ne répondra plus jusqu’au mois prochain, ou jusqu’à ce qu’un admin relève la limite.",
    button: "Voir le budget",
    why: (org) =>
      `Vous recevez cet e-mail car vous êtes propriétaire de cet agent, ou admin de ${org}. Il est envoyé à 80 % et à 100 %, une fois par mois chacun.`,
    personal: {
      warning: "À 100 %, il s’arrête et vous prévient. Vous pouvez modifier la limite sur la page de l’agent.",
      exhausted:
        "Il ne répondra plus jusqu’au mois prochain, ou jusqu’à ce que vous releviez la limite sur la page de l’agent.",
      why: () =>
        "Vous recevez cet e-mail car cet agent est l’un des vôtres. Il est envoyé à 80 % et à 100 %, une fois par mois chacun.",
    },
  },
  digest: {
    subject: (n) =>
      plural("fr", n, {
        one: `${n} demande attend votre approbation`,
        other: `${n} demandes attendent votre approbation`,
      }),
    preheader: "Les demandes expirent après 24 heures, et rien ne s’exécute sans décision.",
    headline: (n) => plural("fr", n, { one: `${n} demande vous attend`, other: `${n} demandes vous attendent` }),
    body: (n, org) => [
      "Dans ",
      { b: org },
      plural("fr", n, {
        one: ", un agent a demandé à faire quelque chose que seule une personne peut approuver.",
        other: ", des agents ont demandé à faire des choses que seule une personne peut approuver.",
      }),
    ],
    age: (h) => `il y a ${h} h`,
    more: (k) => `Et ${k} de plus.`,
    button: (n) => plural("fr", n, { one: "Voir la demande", other: "Ouvrir les approbations" }),
    why: (org, hours) =>
      `Vous recevez cet e-mail car vous pouvez approuver ces demandes dans ${org}.${hours ? ` Il est envoyé quand une demande attend plus de ${hours} heures, une fois par demande.` : ""}`,
    personal: {
      body: (n) =>
        plural("fr", n, {
          one: "Un de vos agents a demandé à faire quelque chose qui nécessite votre approbation.",
          other: "Vos agents ont demandé à faire des choses qui nécessitent votre approbation.",
        }),
      why: (_org, hours) =>
        `Vous recevez cet e-mail car vous pouvez approuver ces demandes.${hours ? ` Il est envoyé quand une demande attend plus de ${hours} heures, une fois par demande.` : ""}`,
    },
  },
  ready: {
    subject: "L’ordinateur de vos agents est prêt",
    preheader: {
      ai: "Prochaine étape : connectez votre IA pour que vos agents puissent réfléchir.",
      task: "Prochaine étape : confiez une première tâche à vos agents.",
      create: "Prochaine étape : créez votre premier agent.",
    },
    headline: "L’ordinateur de vos agents est prêt",
    computer: "L’ordinateur de vos agents",
    body: (org) => [
      "Merci d’avoir patienté. L’ordinateur de ",
      { b: org },
      " est allumé et configuré, avec un utilisateur dédié pour chaque agent. Il reste allumé jour et nuit, pour que vos agents puissent travailler à toute heure.",
    ],
    facts: { cpus: "Processeurs", memory: "Mémoire", disk: "Disque" },
    next: "Prochaines étapes",
    steps: {
      ai: [
        "Connectez votre IA.",
        "Connectez-vous avec votre abonnement Claude ou ChatGPT, l’abonnement de code d’une autre IA, ou une clé API. C’est avec elle que vos agents réfléchissent.",
      ],
      task: [
        "Confiez une première tâche.",
        "Dans #general, appelez un agent avec @ et dites ce dont vous avez besoin.",
      ],
      watch: [
        "Regardez-les travailler.",
        "Sur la page d’un agent, appuyez sur Ouvrir pour voir son ordinateur en direct. Prenez la main quand vous voulez, et rendez-la quand vous avez fini.",
      ],
      create: ["Créez un agent.", "Il travaille sur cet ordinateur dès le départ."],
    },
    button: { ai: "Connecter votre IA", task: "Confier une première tâche", create: "Créer un agent" },
    why: (org) =>
      `Vous recevez cet e-mail car vous êtes propriétaire de ${org} sur agentes.chat. C’est le seul e-mail au sujet de cet ordinateur.`,
    personal: {
      body: () =>
        "Merci d’avoir patienté. L’ordinateur de vos agents est allumé et configuré, avec un utilisateur dédié pour chaque agent. Il reste allumé jour et nuit, pour que vos agents puissent travailler à toute heure.",
      steps: {
        task: [
          "Confiez une première tâche.",
          "Ouvrez une conversation avec l’un de vos agents et dites ce dont vous avez besoin.",
        ],
      },
      why: () =>
        "Vous recevez cet e-mail car cet espace de travail sur agentes.chat est le vôtre. C’est le seul e-mail au sujet de cet ordinateur.",
    },
  },
  joinRequest: {
    subject: "Quelqu’un demande à rejoindre votre espace de travail",
    preheader: "Approuvez ou refusez dans Membres. Rien ne se passe tant que vous n’avez pas répondu.",
    headline: "Une demande pour rejoindre vous attend",
    body: (org) => [
      "Cette personne a ouvert le lien d’invitation de ",
      { b: org },
      " et demande à rejoindre l’espace de travail.",
    ],
    note: "N’approuvez que les personnes que vous attendez. Elles rejoignent l’espace en tant que membre, sauf si vous choisissez un autre rôle sur la page.",
    approve: "Approuver",
    deny: "Refuser",
    more: "Toutes les demandes en attente sont dans Membres.",
    why: (org) =>
      `Vous recevez cet e-mail car vous êtes propriétaire ou admin de ${org}. Il est envoyé au plus une fois par heure.`,
    personal: {
      body: () => "Cette personne a ouvert le lien d’invitation de votre espace de travail et demande à le rejoindre.",
      why: () =>
        "Vous recevez cet e-mail car vous gérez qui rejoint votre espace de travail. Il est envoyé au plus une fois par heure.",
    },
  },
  joinAnswer: {
    someone: "Quelqu’un",
    joined: {
      subject: "Votre demande pour rejoindre a été approuvée",
      preheader: "Vous y êtes. Ouvrez l’espace de travail pour commencer.",
      headline: "Vous y êtes",
      body: (who, org, role) => [
        `${who} a approuvé votre demande. Vous avez rejoint `,
        { b: org },
        ` en tant que ${role}.`,
      ],
      button: "Ouvrir l’espace de travail",
    },
    invited: {
      subject: "Votre demande pour rejoindre a été approuvée",
      preheader: "Plus qu’une étape : acceptez l’invitation sous 7 jours.",
      headline: "Approuvée : plus qu’une étape",
      body: (who, org) => [`${who} a approuvé votre demande pour rejoindre `, { b: org }, "."],
      next: "Acceptez l’invitation avec cette adresse e-mail sous 7 jours.",
      button: "Accepter l’invitation",
    },
    denied: {
      subject: "Votre demande pour rejoindre n’a pas été approuvée",
      preheader: "Quelqu’un de l’espace de travail l’a examinée et ne l’a pas approuvée.",
      headline: "Votre demande n’a pas été approuvée",
      body: (org) => ["Quelqu’un de ", { b: org }, " a examiné votre demande et ne l’a pas approuvée."],
      reason: (reason) => [{ b: "Son message : " }, `« ${reason} »`],
      small:
        "Si vous pensez qu’il s’agit d’une erreur, demandez à quelqu’un de cet espace de travail de vous inviter par e-mail.",
    },
    why: (org) => `Vous recevez cet e-mail car cette adresse a demandé à rejoindre ${org} sur agentes.chat.`,
    personal: {
      joined: { body: (who) => `${who} a approuvé votre demande. Vous êtes maintenant dans son espace de travail.` },
      invited: { body: (who) => `${who} a approuvé votre demande pour rejoindre son espace de travail.` },
      denied: {
        preheader: "La personne l’a examinée et ne l’a pas approuvée.",
        body: () => "La personne à qui vous l’avez demandé a examiné votre demande et ne l’a pas approuvée.",
        small: "Si vous pensez qu’il s’agit d’une erreur, demandez-lui de vous inviter par e-mail.",
      },
      why: () =>
        "Vous recevez cet e-mail car cette adresse a demandé à rejoindre un espace de travail personnel sur agentes.chat.",
    },
  },
  joinCode: {
    subject: (code) => `${code} est votre code agentes.chat`,
    preheader: "Saisissez-le sur la page pour demander à rejoindre. Il est valable 10 minutes.",
    headline: "Votre code",
    body: (org) => ["Saisissez ce code sur la page pour demander à rejoindre ", { b: org }, "."],
    small: ["Il est valable 10 minutes. Si vous n’avez rien demandé, ", { nobr: "ignorez cet e-mail." }],
    why: (org) =>
      `Vous recevez cet e-mail car quelqu’un a saisi cette adresse pour demander à rejoindre ${org} sur agentes.chat.`,
    personal: {
      body: () => "Saisissez ce code sur la page pour demander à rejoindre cet espace de travail.",
      why: () =>
        "Vous recevez cet e-mail car quelqu’un a saisi cette adresse pour demander à rejoindre un espace de travail personnel sur agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} est votre code pour supprimer un espace de travail`,
    subjectAccount: (code) => `${code} est votre code pour supprimer tout votre compte`,
    preheader: "Saisissez-le dans agentes.chat pour confirmer. Il est valable 10 minutes.",
    headline: "Votre code",
    workspace: (org) => [
      "Saisissez ce code pour supprimer l’espace de travail ",
      { b: org },
      ". Il passe aussitôt en lecture seule pour tout le monde et sera supprimé définitivement 7 jours plus tard.",
    ],
    account: (email) => [
      "Saisissez ce code pour supprimer tout le compte ",
      { b: email },
      ", pas seulement un espace de travail. Il est déconnecté partout aussitôt et sera supprimé définitivement 7 jours plus tard, et les espaces de travail dont vous êtes le seul membre se ferment avec lui.",
    ],
    support: (address) => [
      "Il est valable 10 minutes, et rien n’est supprimé sans lui. Si ce n’était pas vous, ne le partagez pas et écrivez à ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Il est valable 10 minutes, et rien n’est supprimé sans lui. Si ce n’était pas vous, ne le partagez pas et prévenez les personnes qui gèrent ce serveur.",
    whyWorkspace: (org) =>
      `Vous recevez cet e-mail car votre compte a demandé la suppression de ${org} sur agentes.chat.`,
    whyAccount: "Vous recevez cet e-mail car votre compte a demandé sa suppression sur agentes.chat.",
    personal: {
      workspace: (org) => [
        "Saisissez ce code pour supprimer votre espace de travail ",
        { b: org },
        ". Il passe aussitôt en lecture seule et sera supprimé définitivement 7 jours plus tard.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Un espace de travail dont vous êtes membre sera supprimé le ${day}`,
    preheader: "Il est en lecture seule pour l’instant. Un propriétaire peut encore le restaurer d’ici là.",
    headline: "Un espace de travail est en cours de suppression",
    body: (by, org, day, time) => [
      { b: by },
      " a supprimé l’espace de travail ",
      { b: org },
      `. Il est en lecture seule et disparaîtra définitivement le ${day} à ${time}.`,
    ],
    owner: "Vous avez changé d’avis ? Restaurez-le d’ici là.",
    button: "Restaurer l’espace de travail",
    member: "Si c’est une erreur, demandez à un propriétaire de le restaurer.",
    why: (org) => `Vous recevez cet e-mail car vous êtes membre de ${org} sur agentes.chat.`,
    personal: {
      member: "Si c’est une erreur, demandez à la personne qui l’a supprimé de le restaurer.",
      why: () => "Vous recevez cet e-mail car vous êtes membre de cet espace de travail sur agentes.chat.",
    },
  },
  restored: {
    subject: "Un espace de travail dont vous êtes membre est de retour",
    preheader: "Un propriétaire l’a restauré. Il fonctionne à nouveau.",
    headline: "L’espace de travail est de retour",
    body: (by, org) => [{ b: by }, " a restauré ", { b: org }, ". Il fonctionne à nouveau."],
    button: "Ouvrir l’espace de travail",
    why: (org) => `Vous recevez cet e-mail car vous êtes membre de ${org} sur agentes.chat.`,
    personal: {
      why: () => "Vous recevez cet e-mail car vous êtes membre de cet espace de travail sur agentes.chat.",
    },
  },
  appConnected: {
    subject: "Une app a été connectée à votre compte agentes.chat",
    preheader: "Elle peut lire et confier des tâches aux agents en votre nom, dans un espace de travail.",
    headline: "Une app a été connectée",
    body: (app, org) => [{ b: app }, " a maintenant accès à votre compte dans ", { b: org }, "."],
    note: "Ce n’est pas vous ? Déconnectez-la maintenant et changez votre mot de passe.",
    button: "Voir les apps connectées",
    why: (org) => `Vous recevez cet e-mail car une app a été connectée à votre compte dans ${org} sur agentes.chat.`,
    personal: {
      body: (app) => [{ b: app }, " a maintenant accès à votre compte dans votre espace de travail personnel."],
      why: () =>
        "Vous recevez cet e-mail car une app a été connectée à votre compte dans votre espace de travail personnel sur agentes.chat.",
    },
  },
  accountDeleting: {
    subject: (day) => `Votre compte agentes.chat sera supprimé le ${day}`,
    preheader: "Vous avez 7 jours pour changer d’avis.",
    headline: "Votre compte est en cours de suppression",
    body: (email, day, time) => [
      "Nous supprimerons le compte ",
      { b: email },
      ` le ${day} à ${time}. Il est déconnecté partout, et personne ne peut vous joindre ici jusqu’à votre retour.`,
    ],
    closes: (count, names) => [
      plural("fr", count, {
        one: "L’espace de travail dont vous étiez le seul membre vient de fermer et disparaît à la même date : ",
        other:
          "Les espaces de travail dont vous étiez le seul membre viennent de fermer et disparaissent à la même date : ",
      }),
      ...names,
      ".",
    ],
    undo: "Vous avez changé d’avis ? Connectez-vous avant cette date et appuyez sur Restaurer.",
    button: "Se connecter pour restaurer",
    why: "Vous recevez cet e-mail parce que cette adresse a un compte sur agentes.chat.",
  },
  accountDeleted: {
    subject: "Votre compte agentes.chat a été supprimé",
    preheader: "Il est déconnecté partout et ne peut plus se connecter.",
    headline: "Votre compte a été supprimé",
    body: (email) => ["Nous avons supprimé le compte ", { b: email }, "."],
    closes: (count, day, names) => [
      plural("fr", count, {
        one: `L’espace de travail dont vous étiez le seul membre est fermé et sera supprimé définitivement le ${day} : `,
        other: `Les espaces de travail dont vous étiez le seul membre sont fermés et seront supprimés définitivement le ${day} : `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Si ce n’était pas vous, écrivez à ", { mail: address }, "."],
    noSupport: "Si ce n’était pas vous, prévenez les personnes qui gèrent ce serveur.",
    why: "Vous recevez cet e-mail car cette adresse avait un compte sur agentes.chat.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agents le ${day} : ${stalls} blocages, ${noise} exécutions pour rien`,
    preheader: "Où les agents se sont arrêtés et où ils ont agi pour rien, comparé aux 7 jours précédents.",
    headline: (day) => `Blocages et bruit le ${day}`,
    body: "Tous les espaces de travail actifs de ce serveur, sur la journée UTC. Noms et chiffres uniquement.",
    stalls: "Blocages",
    noise: "Bruit",
    metric: {
      mentionNoRun: "Mentions qui n’ont réveillé personne",
      readOnly: "Exécutions en lecture seule",
      promiseUnkept: "Terminées avec du travail inachevé",
      promiseIgnored: "Toujours inachevé après la relance",
      handoffUnanswered: "Passages de relais sans réponse en 30 min",
      limitStops: "Arrêtés par une limite",
      personUnanswered: "Personnes sans réponse en 10 min",
      taskStartFailed: "Tâches en échec au démarrage",
      noiseRuns: "Exécutions pour rien",
      quietRuns: "Terminées sans un mot",
      ackReplies: "Réponses à un merci ou un ok",
      idleWakes: "Réveillés sans rien à faire",
      noiseTokens: "Leurs jetons",
      noiseCostNanoUsd: "Leur coût",
    },
    value: (today, average) => `${today} · moyenne sur 7 jours ${average}`,
    topStalls: "Le plus de blocages",
    topNoise: "Le plus d’exécutions pour rien, avec leur coût",
    none: "Aucun espace de travail.",
    table: (day) => `Le tableau complet : bun run report:autonomy --day ${day}`,
    why: "Vous recevez cet e-mail car cette adresse figure dans OPS_REPORT_EMAIL sur ce serveur. Il est envoyé une fois par jour.",
  },
  planOpened: {
    subject: (plan) => `Plus de personnes peuvent parler à votre agent avec votre forfait ${plan}`,
    preheader: (plan) => `Leurs conversations utilisent votre forfait ${plan} et ses limites.`,
    headline: "Plus de personnes peuvent parler à votre agent",
    body: (by, agent, plan) => [
      { b: by },
      " a permis à plus de personnes de parler à ",
      { b: agent },
      `. Leurs conversations utilisent votre forfait ${plan} et ses limites.`,
    ],
    agent: "Agent",
    by: "Modifié par",
    was: "Avant",
    now: "Maintenant",
    everyone: "Tout le monde dans le workspace",
    onlyYou: "Vous seul",
    you: "Vous",
    note: "Pour annuler, modifiez Qui peut parler sur la page de l'agent.",
    button: "Voir qui peut parler",
    why: (org) =>
      `Vous recevez cet e-mail car un de vos agents dans ${org} pense avec votre forfait et quelqu'un d'autre a changé qui peut lui parler.`,
    personal: {
      why: () =>
        "Vous recevez cet e-mail car un de vos agents pense avec votre forfait et quelqu’un d’autre a changé qui peut lui parler.",
    },
  },
  planLent: {
    subject: (plan) => `Votre forfait ${plan} pense maintenant pour un autre agent`,
    preheader: (plan) => `Ses conversations utilisent votre forfait ${plan} et ses limites. Vous pouvez le reprendre.`,
    headline: "Quelqu’un a connecté votre forfait à un agent",
    body: (by, agent, plan) => [
      { b: by },
      ` a connecté votre forfait ${plan} à l’agent `,
      { b: agent },
      ". Ses conversations utilisent votre forfait et ses limites.",
    ],
    agent: "Agent",
    by: "Connecté par",
    plan: "Forfait",
    note: "Reprenez-le en un clic depuis vos notifications, et l’agent arrête de penser avec votre forfait.",
    button: "Ouvrir les notifications",
    why: (org) => `Vous recevez cet e-mail parce que quelqu’un dans ${org} a connecté votre forfait à un agent.`,
    personal: {
      why: () =>
        "Vous recevez cet e-mail parce que quelqu’un de votre espace de travail a connecté votre forfait à un agent.",
    },
  },
  planWaiting: {
    subject: "Votre équipe attend",
    preheader: "Votre espace de travail est prêt. Il lui faut un abonnement agentes.chat pour démarrer.",
    headline: "Votre équipe attend",
    body: (agents, channels, routines) => {
      const a = plural("fr", agents, { one: `1 agent`, other: `${agents} agents` });
      const c = plural("fr", channels, { one: `1 canal`, other: `${channels} canaux` });
      const r = plural("fr", routines, { one: `1 routine`, other: `${routines} routines` });
      return routines > 0
        ? `${a}, ${c} et ${r} sont prêts. Il leur faut un abonnement agentes.chat pour démarrer.`
        : `${a} et ${c} sont prêts. Il leur faut un abonnement agentes.chat pour démarrer.`;
    },
    button: "Voir les abonnements agentes.chat",
    why: (org) =>
      `Vous recevez cet e-mail parce que vous gérez ${org} sur agentes.chat. Nous n'envoyons que deux rappels comme celui-ci.`,
    personal: {
      subject: "Vos agents attendent",
      headline: "Vos agents attendent",
      body: (agents, _channels, routines) => {
        const a = plural("fr", agents, { one: `1 agent`, other: `${agents} agents` });
        const r = plural("fr", routines, { one: `1 routine`, other: `${routines} routines` });
        return `Tout est prêt : ${routines > 0 ? `${a} et ${r}` : a}. Il ne manque qu’un abonnement agentes.chat.`;
      },
      why: () =>
        "Vous recevez cet e-mail parce que cet espace de travail sur agentes.chat est le vôtre. Nous n’envoyons que deux rappels comme celui-ci.",
    },
  },
};
