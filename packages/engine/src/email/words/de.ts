import { plural } from "@agenteschat/i18n/format";
import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in de: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("de", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 */
export const words: EmailWords = {
  sentBy: (host) => (host ? atHost("Gesendet vom agentes.chat-Server", "auf", host) : "Gesendet von agentes.chat."),
  fallback: "Der Button funktioniert nicht? Kopiere diese Adresse in deinen Browser:",
  role: { owner: "Inhaber", member: "Mitglied" },
  anAgent: "Ein Agent",
  someone: "Jemand",
  verify: {
    subject: "Bestätige deine E-Mail-Adresse für agentes.chat",
    preheader: "Ein Klick, um diese Adresse zu bestätigen. Der Link gilt eine Stunde lang.",
    headline: "Bestätige deine E-Mail-Adresse",
    body: "Nur noch ein Schritt: Bestätige, dass diese Adresse dir gehört.",
    button: "E-Mail-Adresse bestätigen",
    small: "Der Link gilt eine Stunde lang. Wenn du dich nicht registriert hast, kannst du diese E-Mail ignorieren.",
    why: "Du erhältst diese E-Mail, weil mit dieser Adresse ein Konto bei agentes.chat erstellt wurde.",
  },
  reset: {
    subject: "Setze dein Passwort für agentes.chat zurück",
    preheader: "Wähle ein neues Passwort. Der Link gilt eine Stunde lang.",
    headline: "Wähle ein neues Passwort",
    body: "Wir haben eine Anfrage erhalten, das Passwort für diese Adresse zurückzusetzen.",
    button: "Neues Passwort wählen",
    note: "Das warst nicht du? Ignoriere diese E-Mail. Dein Passwort bleibt, wie es ist.",
    small: "Der Link gilt eine Stunde lang.",
    why: "Du erhältst diese E-Mail, weil jemand das Passwort für diese Adresse bei agentes.chat zurücksetzen wollte.",
  },
  invitation: {
    subject: "Du bist zu einem Workspace auf agentes.chat eingeladen",
    preheader: "Nimm die Einladung innerhalb von 7 Tagen mit dieser E-Mail-Adresse an.",
    headline: "Du bist zu einem Workspace eingeladen",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} lädt dich ein, `, { b: org }, ` als ${role} beizutreten.`]
        : ["Du bist eingeladen, ", { b: org }, ` als ${role} beizutreten.`],
    what: "Auf agentes.chat arbeiten Menschen und KI-Agenten zusammen.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Nachricht: " }, `„${note}“`],
    button: "Einladung annehmen",
    small: "Die Einladung gilt 7 Tage lang. Nimm sie mit dieser E-Mail-Adresse an.",
    why: (org) =>
      `Du erhältst diese E-Mail, weil jemand bei ${org} diese Adresse eingeladen hat. Wenn du die Person nicht kennst, ignoriere sie einfach. Es passiert nichts, solange du nicht annimmst.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [
              { b: inviter },
              `${email ? ` (${email})` : ""} lädt dich in einen persönlichen Workspace auf agentes.chat ein.`,
            ]
          : "Du bist zu einem persönlichen Workspace auf agentes.chat eingeladen.",
      why: () =>
        "Du erhältst diese E-Mail, weil jemand diese Adresse in einen persönlichen Workspace eingeladen hat. Wenn du die Person nicht kennst, ignoriere sie einfach. Es passiert nichts, solange du nicht annimmst.",
    },
  },
  inviteRequest: {
    subject: "Jemand bittet um eine neue Einladung",
    preheader: "Die Einladung ist abgelaufen. Unter Mitglieder kannst du eine neue senden.",
    headline: "Jemand bittet um eine neue Einladung",
    body: (email, org) =>
      email
        ? [{ b: email }, " hat eine abgelaufene Einladung zu ", { b: org }, " geöffnet und bittet um eine neue."]
        : ["Jemand mit einem abgelaufenen Einladungslink zu ", { b: org }, " bittet um einen neuen."],
    next: "Wenn du die Person erwartest, sende unter Mitglieder eine neue Einladung. Wenn nicht, musst du nichts tun.",
    button: "Mitglieder öffnen",
    why: (org) =>
      `Du erhältst diese E-Mail, weil du diese Einladung erstellt hast oder die Mitglieder von ${org} verwaltest.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " hat eine abgelaufene Einladung zu deinem Workspace geöffnet und bittet um eine neue."]
          : "Jemand mit einem abgelaufenen Einladungslink zu deinem Workspace bittet um einen neuen.",
      why: () =>
        "Du erhältst diese E-Mail, weil du diese Einladung erstellt hast oder dich darum kümmerst, wer in deinem Workspace ist.",
    },
  },
  calendar: {
    subject: "Du bist zu einem Termin eingeladen",
    preheader: (when) => `${when}. Sieh ihn dir im Kalender an.`,
    headline: "Du bist zu einem Termin eingeladen",
    facts: { event: "Termin", when: "Wann", org: "Workspace", by: "Eingeladen von" },
    someone: "Jemand",
    button: "Termin ansehen",
    why: (org) => `Du erhältst diese E-Mail, weil dich jemand bei ${org} zu einem Termin eingeladen hat.`,
    personal: {
      why: () => "Du erhältst diese E-Mail, weil dich jemand in deinem Workspace zu einem Termin eingeladen hat.",
    },
  },
  waitlist: {
    subject: "Bestätige deinen Platz auf der Warteliste von agentes.chat",
    preheader: "Ein Klick und dein Platz ist gesichert.",
    headline: "Bestätige deinen Platz auf der Liste",
    body: (email) =>
      email
        ? ["Wir haben eine Anfrage erhalten, ", { b: email }, " auf die Warteliste von agentes.chat zu setzen."]
        : "Wir haben eine Anfrage erhalten, diese Adresse auf die Warteliste von agentes.chat zu setzen.",
    approve: "Bei uns passiert nichts Wichtiges, ohne dass ein Mensch es freigibt. Das gilt auch für diese Anfrage.",
    button: "Meine E-Mail-Adresse bestätigen",
    small:
      "Der Link gilt 48 Stunden lang. Das warst nicht du? Ignoriere diese E-Mail. Ohne den Klick kommt die Adresse nie auf die Liste.",
    why: "Du erhältst diese E-Mail, weil diese Adresse auf der Warteliste von agentes.chat eingetragen wurde.",
  },
  earlyAccess: {
    subject: "Deine Einladung zu agentes.chat ist da",
    preheader: (days) => `Erstelle dein Konto innerhalb von ${days} Tagen mit dieser E-Mail-Adresse.`,
    headline: "Dein Zugang ist bereit",
    body: (email) => [{ b: email }, " kann jetzt ein Konto und einen Workspace auf agentes.chat erstellen."],
    what: "Auf agentes.chat arbeiten Menschen und KI-Agenten zusammen.",
    button: "Mein Konto erstellen",
    small: (days) =>
      `Der Link gilt ${days} Tage lang und nur für diese Adresse. Registriere dich mit einem Passwort oder mit Google, GitHub oder Apple unter derselben Adresse.`,
    why: "Du erhältst diese E-Mail, weil diese Adresse auf der Warteliste von agentes.chat steht oder zu agentes.chat eingeladen wurde. Es passiert nichts, solange du dich nicht registrierst.",
  },
  earlyAccessAllowed: {
    subject: "Du kannst jetzt deinen eigenen Workspace erstellen",
    preheader: "Melde dich mit deinem bestehenden Konto an und richte ihn ein.",
    headline: "Erstelle deinen eigenen Workspace",
    body: (email) => [
      "Du kannst jetzt mit ",
      { b: email },
      ", deinem bestehenden Konto, deinen eigenen Workspace auf agentes.chat erstellen.",
    ],
    button: "Meinen Workspace erstellen",
    why: "Du erhältst diese E-Mail, weil dieses Konto frühen Zugang zu agentes.chat bekommen hat.",
  },
  budget: {
    subject: {
      warning: "Ein Agent hat 80 % seines Monatsbudgets überschritten",
      exhausted: "Ein Agent hat angehalten: Monatsbudget erreicht",
    },
    preheader: {
      warning: "Bei 100 % hält er an, bis der neue Monat beginnt oder das Limit steigt.",
      exhausted: "Er antwortet nicht mehr, bis der neue Monat beginnt oder das Limit steigt.",
    },
    headline: {
      warning: "Ein Agent hat 80 % seines Budgets überschritten",
      exhausted: "Ein Agent hat sein Budget erreicht",
    },
    used: (pct, org) => `${pct} des Budgets für diesen Monat verbraucht · ${org}`,
    warning: "Bei 100 % hält er an und sagt das im Kanal. Ein Admin kann das Limit auf der Seite des Agenten ändern.",
    exhausted: "Er antwortet nicht mehr, bis der neue Monat beginnt oder ein Admin das Limit erhöht.",
    button: "Budget ansehen",
    why: (org) =>
      `Du erhältst diese E-Mail, weil du der Inhaber dieses Agenten oder Admin von ${org} bist. Sie kommt bei 80 % und bei 100 %, jeweils einmal im Monat.`,
    personal: {
      warning: "Bei 100 % hält er an und sagt dir Bescheid. Du kannst das Limit auf der Seite des Agenten ändern.",
      exhausted:
        "Er antwortet nicht mehr, bis der neue Monat beginnt oder du das Limit auf der Seite des Agenten erhöhst.",
      why: () =>
        "Du erhältst diese E-Mail, weil das einer deiner Agenten ist. Sie kommt bei 80 % und bei 100 %, jeweils einmal im Monat.",
    },
  },
  digest: {
    subject: (n) =>
      plural("de", n, {
        one: "Eine Anfrage wartet auf deine Freigabe",
        other: `${n} Anfragen warten auf deine Freigabe`,
      }),
    preheader: "Anfragen laufen nach 24 Stunden ab, und ohne Entscheidung passiert nichts.",
    headline: (n) => plural("de", n, { one: "Eine Anfrage wartet auf dich", other: `${n} Anfragen warten auf dich` }),
    body: (n, org) => [
      "In ",
      { b: org },
      plural("de", n, {
        one: " möchte ein Agent etwas tun, das nur ein Mensch freigeben kann.",
        other: " möchten Agenten Dinge tun, die nur ein Mensch freigeben kann.",
      }),
    ],
    age: (h) => `vor\u00a0${h}\u00a0Std.`,
    more: (k) => `Und ${k} weitere.`,
    button: (n) => plural("de", n, { one: "Anfrage ansehen", other: "Freigaben öffnen" }),
    why: (org, hours) =>
      `Du erhältst diese E-Mail, weil du diese Anfragen in ${org} freigeben kannst.${hours ? ` Sie kommt, wenn eine Anfrage länger als ${hours} Stunden wartet, einmal pro Anfrage.` : ""}`,
    personal: {
      body: (n) =>
        plural("de", n, {
          one: "Einer deiner Agenten möchte etwas tun, das deine Freigabe braucht.",
          other: "Deine Agenten möchten Dinge tun, die deine Freigabe brauchen.",
        }),
      why: (_org, hours) =>
        `Du erhältst diese E-Mail, weil du diese Anfragen freigeben kannst.${hours ? ` Sie kommt, wenn eine Anfrage länger als ${hours} Stunden wartet, einmal pro Anfrage.` : ""}`,
    },
  },
  ready: {
    subject: "Der Computer deiner Agenten ist bereit",
    preheader: {
      ai: "Als Nächstes: Verbinde deine KI, damit deine Agenten denken können.",
      task: "Als Nächstes: Gib deinen Agenten eine erste Aufgabe.",
      create: "Als Nächstes: Erstelle deinen ersten Agenten.",
    },
    headline: "Der Computer deiner Agenten ist bereit",
    computer: "Der Computer deiner Agenten",
    body: (org) => [
      "Danke fürs Warten. Der Computer von ",
      { b: org },
      " ist an und eingerichtet, mit einem eigenen Benutzer für jeden Agenten. Er läuft Tag und Nacht, damit deine Agenten jederzeit arbeiten können.",
    ],
    facts: { cpus: "CPUs", memory: "Arbeitsspeicher", disk: "Speicherplatz" },
    next: "Nächste Schritte",
    steps: {
      ai: [
        "Verbinde deine KI.",
        "Melde dich mit deinem Claude- oder ChatGPT-Abo an, dem Coding-Abo einer anderen KI oder einem API-Schlüssel. Damit denken deine Agenten.",
      ],
      task: ["Gib eine erste Aufgabe.", "Ruf in #general einen Agenten mit @ und sag, was du brauchst."],
      watch: [
        "Sieh ihnen bei der Arbeit zu.",
        "Klick auf der Seite eines Agenten auf Öffnen, um seinen Computer live zu sehen. Übernimm die Steuerung, wann immer du willst, und gib sie zurück, wenn du fertig bist.",
      ],
      create: ["Erstelle einen Agenten.", "Er arbeitet von Anfang an auf diesem Computer."],
    },
    button: { ai: "KI verbinden", task: "Erste Aufgabe geben", create: "Agenten erstellen" },
    why: (org) =>
      `Du erhältst diese E-Mail, weil du Inhaber von ${org} auf agentes.chat bist. Es ist die einzige E-Mail zu diesem Computer.`,
    personal: {
      body: () =>
        "Danke fürs Warten. Der Computer deiner Agenten ist an und eingerichtet, mit einem eigenen Benutzer für jeden Agenten. Er läuft Tag und Nacht, damit deine Agenten jederzeit arbeiten können.",
      steps: {
        task: ["Gib eine erste Aufgabe.", "Öffne eine Unterhaltung mit einem deiner Agenten und sag, was du brauchst."],
      },
      why: () =>
        "Du erhältst diese E-Mail, weil dieser Workspace auf agentes.chat dir gehört. Es ist die einzige E-Mail zu diesem Computer.",
    },
  },
  joinRequest: {
    subject: "Jemand möchte deinem Workspace beitreten",
    preheader: "Gib die Anfrage unter Mitglieder frei oder lehne sie ab. Bis du antwortest, passiert nichts.",
    headline: "Eine Beitrittsanfrage wartet",
    body: (org) => ["Die Person hat den Einladungslink von ", { b: org }, " geöffnet und möchte beitreten."],
    note: "Gib nur Personen frei, die du erwartest. Sie treten als Mitglied bei, außer du wählst auf der Seite eine andere Rolle.",
    approve: "Freigeben",
    deny: "Ablehnen",
    more: "Alle offenen Anfragen findest du unter Mitglieder.",
    why: (org) =>
      `Du erhältst diese E-Mail, weil du Inhaber oder Admin von ${org} bist. Sie kommt höchstens einmal pro Stunde.`,
    personal: {
      body: () => "Die Person hat den Einladungslink deines Workspace geöffnet und möchte beitreten.",
      why: () =>
        "Du erhältst diese E-Mail, weil du dich darum kümmerst, wer deinem Workspace beitritt. Sie kommt höchstens einmal pro Stunde.",
    },
  },
  joinAnswer: {
    someone: "Jemand",
    joined: {
      subject: "Deine Beitrittsanfrage wurde freigegeben",
      preheader: "Du bist dabei. Öffne den Workspace, um loszulegen.",
      headline: "Du bist dabei",
      body: (who, org, role) => [
        `${who} hat deine Anfrage freigegeben. Du bist `,
        { b: org },
        ` als ${role} beigetreten.`,
      ],
      button: "Workspace öffnen",
    },
    invited: {
      subject: "Deine Beitrittsanfrage wurde freigegeben",
      preheader: "Nur noch ein Schritt: Nimm die Einladung innerhalb von 7 Tagen an.",
      headline: "Freigegeben: nur noch ein Schritt",
      body: (who, org) => [`${who} hat deine Anfrage freigegeben, `, { b: org }, " beizutreten."],
      next: "Nimm die Einladung innerhalb von 7 Tagen mit dieser E-Mail-Adresse an.",
      button: "Einladung annehmen",
    },
    denied: {
      subject: "Deine Beitrittsanfrage wurde nicht freigegeben",
      preheader: "Jemand im Workspace hat sie sich angesehen und nicht freigegeben.",
      headline: "Deine Anfrage wurde nicht freigegeben",
      body: (org) => ["Jemand bei ", { b: org }, " hat sich deine Anfrage angesehen und sie nicht freigegeben."],
      reason: (reason) => [{ b: "Begründung: " }, `„${reason}“`],
      small: "Wenn du denkst, dass das ein Fehler ist, bitte jemanden dort, dich per E-Mail einzuladen.",
    },
    why: (org) =>
      `Du erhältst diese E-Mail, weil mit dieser Adresse der Beitritt zu ${org} auf agentes.chat angefragt wurde.`,
    personal: {
      joined: { body: (who) => `${who} hat deine Anfrage freigegeben. Du bist jetzt im Workspace.` },
      invited: { body: (who) => `${who} hat deine Anfrage freigegeben, dem Workspace beizutreten.` },
      denied: {
        preheader: "Die Person hat sie sich angesehen und nicht freigegeben.",
        body: () => "Die Person, die du gefragt hast, hat sich deine Anfrage angesehen und sie nicht freigegeben.",
        small: "Wenn du denkst, dass das ein Fehler ist, bitte sie, dich per E-Mail einzuladen.",
      },
      why: () =>
        "Du erhältst diese E-Mail, weil mit dieser Adresse der Beitritt zu einem persönlichen Workspace auf agentes.chat angefragt wurde.",
    },
  },
  joinCode: {
    subject: (code) => `${code} ist dein Code für agentes.chat`,
    preheader: "Gib ihn auf der Seite ein, um den Beitritt anzufragen. Er gilt 10 Minuten lang.",
    headline: "Dein Code",
    body: (org) => ["Gib diesen Code auf der Seite ein, um den Beitritt zu ", { b: org }, " anzufragen."],
    small: ["Er gilt 10 Minuten lang. Wenn du nichts angefragt hast, ", { nobr: "ignoriere diese E-Mail." }],
    why: (org) =>
      `Du erhältst diese E-Mail, weil jemand diese Adresse eingegeben hat, um den Beitritt zu ${org} auf agentes.chat anzufragen.`,
    personal: {
      body: () => "Gib diesen Code auf der Seite ein, um den Beitritt zu diesem Workspace anzufragen.",
      why: () =>
        "Du erhältst diese E-Mail, weil jemand diese Adresse eingegeben hat, um den Beitritt zu einem persönlichen Workspace auf agentes.chat anzufragen.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} ist dein Code zum Löschen eines Workspace`,
    subjectAccount: (code) => `${code} ist dein Code zum Löschen deines ganzen Kontos`,
    preheader: "Gib ihn in agentes.chat ein, um zu bestätigen. Er gilt 10 Minuten lang.",
    headline: "Dein Code",
    workspace: (org) => [
      "Gib diesen Code ein, um den Workspace ",
      { b: org },
      " zu löschen. Er ist sofort für alle schreibgeschützt und wird 7 Tage später endgültig gelöscht.",
    ],
    account: (email) => [
      "Gib diesen Code ein, um das ganze Konto ",
      { b: email },
      " zu löschen, nicht nur einen Workspace. Es wird sofort überall abgemeldet und 7 Tage später endgültig gelöscht, und Workspaces, in denen nur du bist, werden mit ihm geschlossen.",
    ],
    support: (address) => [
      "Er gilt 10 Minuten lang, und ohne ihn wird nichts gelöscht. Wenn du das nicht warst, gib ihn nicht weiter und schreib an ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Er gilt 10 Minuten lang, und ohne ihn wird nichts gelöscht. Wenn du das nicht warst, gib ihn nicht weiter und sag den Leuten Bescheid, die diesen Server betreiben.",
    whyWorkspace: (org) =>
      `Du erhältst diese E-Mail, weil über dein Konto das Löschen von ${org} auf agentes.chat angefragt wurde.`,
    whyAccount: "Du erhältst diese E-Mail, weil über dein Konto dessen Löschung auf agentes.chat angefragt wurde.",
    personal: {
      workspace: (org) => [
        "Gib diesen Code ein, um deinen Workspace ",
        { b: org },
        " zu löschen. Er ist sofort schreibgeschützt und wird 7 Tage später endgültig gelöscht.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Ein Workspace, in dem du bist, wird am ${day} gelöscht`,
    preheader: "Er ist jetzt schreibgeschützt. Bis dahin kann ein Inhaber ihn noch wiederherstellen.",
    headline: "Ein Workspace wird gelöscht",
    body: (by, org, day, time) => [
      { b: by },
      " hat den Workspace ",
      { b: org },
      ` gelöscht. Er ist jetzt schreibgeschützt und wird am ${day} um ${time} endgültig entfernt.`,
    ],
    owner: "Doch anders überlegt? Stell ihn vorher wieder her.",
    button: "Workspace wiederherstellen",
    member: "Wenn das ein Fehler ist, bitte einen Inhaber, ihn wiederherzustellen.",
    why: (org) => `Du erhältst diese E-Mail, weil du in ${org} auf agentes.chat bist.`,
    personal: {
      member: "Wenn das ein Fehler ist, bitte die Person, die ihn gelöscht hat, ihn wiederherzustellen.",
      why: () => "Du erhältst diese E-Mail, weil du in diesem Workspace auf agentes.chat bist.",
    },
  },
  restored: {
    subject: "Ein Workspace, in dem du bist, ist wieder da",
    preheader: "Ein Inhaber hat ihn wiederhergestellt. Er funktioniert wieder.",
    headline: "Der Workspace ist wieder da",
    body: (by, org) => [{ b: by }, " hat ", { b: org }, " wiederhergestellt. Er funktioniert wieder."],
    button: "Workspace öffnen",
    why: (org) => `Du erhältst diese E-Mail, weil du in ${org} auf agentes.chat bist.`,
    personal: {
      why: () => "Du erhältst diese E-Mail, weil du in diesem Workspace auf agentes.chat bist.",
    },
  },
  appConnected: {
    subject: "Eine App wurde mit deinem agentes.chat-Konto verbunden",
    preheader: "Sie kann in einem Workspace in deinem Namen lesen und Agenten Aufgaben schicken.",
    headline: "Eine App wurde verbunden",
    body: (app, org) => [{ b: app }, " hat jetzt Zugriff auf dein Konto in ", { b: org }, "."],
    note: "Das warst nicht du? Trenne die Verbindung sofort und ändere dein Passwort.",
    button: "Verbundene Apps ansehen",
    why: (org) =>
      `Du erhältst diese E-Mail, weil eine App mit deinem Konto in ${org} auf agentes.chat verbunden wurde.`,
    personal: {
      body: (app) => [{ b: app }, " hat jetzt Zugriff auf dein Konto in deinem persönlichen Workspace."],
      why: () =>
        "Du erhältst diese E-Mail, weil eine App mit deinem Konto in deinem persönlichen Workspace auf agentes.chat verbunden wurde.",
    },
  },
  accountDeleting: {
    subject: (day) => `Dein agentes.chat-Konto wird am ${day} gelöscht`,
    preheader: "Du hast 7 Tage Zeit, es dir anders zu überlegen.",
    headline: "Dein Konto wird gelöscht",
    body: (email, day, time) => [
      "Wir löschen das Konto ",
      { b: email },
      ` am ${day} um ${time}. Es ist überall abgemeldet, und niemand erreicht dich hier, bis du zurück bist.`,
    ],
    closes: (count, names) => [
      plural("de", count, {
        one: "Der Workspace, in dem nur du warst, ist jetzt geschlossen und verschwindet am selben Tag: ",
        other: `Die ${count} Workspaces, in denen nur du warst, sind jetzt geschlossen und verschwinden am selben Tag: `,
      }),
      ...names,
      ".",
    ],
    undo: "Doch anders überlegt? Melde dich vor diesem Datum an und tippe auf Wiederherstellen.",
    button: "Anmelden und wiederherstellen",
    why: "Du erhältst diese E-Mail, weil diese Adresse ein Konto auf agentes.chat hat.",
  },
  accountDeleted: {
    subject: "Dein agentes.chat-Konto wurde gelöscht",
    preheader: "Es ist überall abgemeldet und kann sich nicht mehr anmelden.",
    headline: "Dein Konto wurde gelöscht",
    body: (email) => ["Wir haben das Konto ", { b: email }, " gelöscht."],
    closes: (count, day, names) => [
      plural("de", count, {
        one: `Der Workspace, in dem nur du warst, ist geschlossen und wird am ${day} endgültig gelöscht: `,
        other: `Die ${count} Workspaces, in denen nur du warst, sind geschlossen und werden am ${day} endgültig gelöscht: `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Wenn du das nicht warst, schreib an ", { mail: address }, "."],
    noSupport: "Wenn du das nicht warst, sag den Leuten Bescheid, die diesen Server betreiben.",
    why: "Du erhältst diese E-Mail, weil diese Adresse ein Konto auf agentes.chat hatte.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agenten am ${day}: ${stalls} Hänger, ${noise} Leerläufe`,
    preheader: "Wo Agenten hängen geblieben sind und wo sie umsonst gehandelt haben, verglichen mit den 7 Tagen davor.",
    headline: (day) => `Hänger und Leerlauf am ${day}`,
    body: "Alle aktiven Workspaces auf diesem Server, über den UTC-Tag. Nur Namen und Zahlen.",
    stalls: "Hänger",
    noise: "Leerlauf",
    metric: {
      mentionNoRun: "Erwähnungen, die niemanden geweckt haben",
      readOnly: "Ausführungen, die nur lesen konnten",
      promiseUnkept: "Mit offener Arbeit beendet",
      promiseIgnored: "Nach dem Anstupsen noch offen",
      handoffUnanswered: "Übergaben ohne Antwort in 30 Min.",
      limitStops: "Von einem Limit gestoppt",
      personUnanswered: "Personen ohne Antwort in 10 Min.",
      taskStartFailed: "Aufgaben, die beim Start scheiterten",
      noiseRuns: "Leerläufe",
      quietRuns: "Ohne ein Wort beendet",
      ackReplies: "Auf ein Danke oder ein Ok geantwortet",
      idleWakes: "Geweckt, ohne etwas zu tun",
      noiseTokens: "Ihre Tokens",
      noiseCostNanoUsd: "Ihre Kosten",
    },
    value: (today, average) => `${today} · 7-Tage-Schnitt ${average}`,
    topStalls: "Die meisten Hänger",
    topNoise: "Die meisten Leerläufe, mit ihren Kosten",
    none: "Kein Workspace.",
    table: (day) => `Die ganze Tabelle: bun run report:autonomy --day ${day}`,
    why: "Du erhältst diese E-Mail, weil diese Adresse auf diesem Server in OPS_REPORT_EMAIL steht. Sie kommt einmal am Tag.",
  },
  planOpened: {
    subject: (plan) => `Mehr Leute können über dein ${plan}-Abo mit deinem Agenten sprechen`,
    preheader: (plan) => `Ihre Unterhaltungen nutzen dein ${plan}-Abo und seine Limits.`,
    headline: "Mehr Leute können mit deinem Agenten sprechen",
    body: (by, agent, plan) => [
      { b: by },
      " hat mehr Leute mit ",
      { b: agent },
      ` sprechen lassen. Ihre Unterhaltungen nutzen dein ${plan}-Abo und seine Limits.`,
    ],
    agent: "Agent",
    by: "Geändert von",
    was: "Vorher",
    now: "Jetzt",
    everyone: "Alle im Workspace",
    onlyYou: "Nur du",
    you: "Du",
    note: "Zum Rückgängigmachen ändere Wer schreiben darf auf der Seite des Agenten.",
    button: "Ansehen, wer schreiben darf",
    why: (org) =>
      `Du erhältst diese E-Mail, weil einer deiner Agenten in ${org} mit deinem Abo denkt und jemand anderes geändert hat, wer mit ihm sprechen darf.`,
    personal: {
      why: () =>
        "Du erhältst diese E-Mail, weil einer deiner Agenten mit deinem Abo denkt und jemand anderes geändert hat, wer mit ihm sprechen darf.",
    },
  },
  planLent: {
    subject: (plan) => `Dein ${plan}-Abo denkt jetzt für einen anderen Agenten`,
    preheader: (plan) => `Seine Unterhaltungen nutzen dein ${plan}-Abo und seine Limits. Du kannst es zurücknehmen.`,
    headline: "Jemand hat dein Abo mit einem Agenten verbunden",
    body: (by, agent, plan) => [
      { b: by },
      ` hat dein ${plan}-Abo mit dem Agenten `,
      { b: agent },
      " verbunden. Seine Unterhaltungen nutzen dein Abo und seine Limits.",
    ],
    agent: "Agent",
    by: "Verbunden von",
    plan: "Abo",
    note: "Nimm es mit einem Klick in deinen Benachrichtigungen zurück, dann denkt der Agent nicht mehr mit deinem Abo.",
    button: "Benachrichtigungen öffnen",
    why: (org) => `Du erhältst diese E-Mail, weil jemand in ${org} dein Abo mit einem Agenten verbunden hat.`,
    personal: {
      why: () => "Du erhältst diese E-Mail, weil jemand in deinem Workspace dein Abo mit einem Agenten verbunden hat.",
    },
  },
  planWaiting: {
    subject: "Dein Team wartet",
    preheader: "Dein Workspace ist bereit. Zum Start fehlt ein agentes.chat-Tarif.",
    headline: "Dein Team wartet",
    body: (agents, channels, routines) => {
      const a = plural("de", agents, { one: `1 Agent`, other: `${agents} Agenten` });
      const c = plural("de", channels, { one: `1 Kanal`, other: `${channels} Kanäle` });
      const r = plural("de", routines, { one: `1 Routine`, other: `${routines} Routinen` });
      return routines > 0
        ? `${a}, ${c} und ${r} sind bereit. Zum Start fehlt ein agentes.chat-Tarif.`
        : `${a} und ${c} sind bereit. Zum Start fehlt ein agentes.chat-Tarif.`;
    },
    button: "agentes.chat-Tarife ansehen",
    why: (org) =>
      `Du bekommst diese E-Mail, weil du ${org} auf agentes.chat leitest. Wir senden nur zwei solche Hinweise.`,
    personal: {
      subject: "Deine Agenten warten",
      headline: "Deine Agenten warten",
      body: (agents, _channels, routines) => {
        const a = plural("de", agents, { one: `1 Agent`, other: `${agents} Agenten` });
        const r = plural("de", routines, { one: `1 Routine`, other: `${routines} Routinen` });
        return `Alles bereit: ${routines > 0 ? `${a} und ${r}` : a}. Es fehlt nur noch ein agentes.chat-Tarif.`;
      },
      why: () =>
        "Du bekommst diese E-Mail, weil dieser Workspace auf agentes.chat dir gehört. Wir senden nur zwei solche Hinweise.",
    },
  },
};
