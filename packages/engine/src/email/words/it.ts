import { plural } from "@agenteschat/i18n/format";
import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in it: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("it", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 */
export const words: EmailWords = {
  sentBy: (host) => (host ? atHost("Inviata dal server agentes.chat", "su", host) : "Inviata da agentes.chat."),
  fallback: "Il pulsante non funziona? Copia questo indirizzo nel browser:",
  role: { owner: "proprietario", member: "membro" },
  anAgent: "Un agente",
  someone: "Qualcuno",
  verify: {
    subject: "Conferma la tua email per agentes.chat",
    preheader: "Un clic per confermare questo indirizzo. Il link vale per un’ora.",
    headline: "Conferma la tua email",
    body: "Manca un solo passo: conferma che questo indirizzo è tuo.",
    button: "Conferma email",
    small: "Il link vale per un’ora. Se non ti sei registrato, puoi ignorare questa email.",
    why: "Ricevi questa email perché questo indirizzo è stato usato per registrarsi su agentes.chat.",
  },
  reset: {
    subject: "Reimposta la password di agentes.chat",
    preheader: "Scegli una nuova password. Il link vale per un’ora.",
    headline: "Scegli una nuova password",
    body: "Abbiamo ricevuto una richiesta per reimpostare la password di questo indirizzo.",
    button: "Scegli una nuova password",
    note: "Non l’hai chiesto tu? Ignora questa email. La tua password resta la stessa.",
    small: "Il link vale per un’ora.",
    why: "Ricevi questa email perché qualcuno ha chiesto di reimpostare la password di questo indirizzo su agentes.chat.",
  },
  invitation: {
    subject: "Hai un invito per uno spazio di lavoro su agentes.chat",
    preheader: "Accetta entro 7 giorni, con questo indirizzo email.",
    headline: "Hai un invito per uno spazio di lavoro",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} ti ha invitato a entrare in `, { b: org }, ` come ${role}.`]
        : ["Sei invitato a entrare in ", { b: org }, ` come ${role}.`],
    what: "agentes.chat è il posto dove persone e agenti IA lavorano insieme.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Il suo messaggio: " }, `“${note}”`],
    button: "Accetta l’invito",
    small: "L’invito vale per 7 giorni. Accettalo con questo indirizzo email.",
    why: (org) =>
      `Ricevi questa email perché qualcuno di ${org} ha invitato questo indirizzo. Se non sai chi è, ignorala. Non succede nulla finché non accetti.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [
              { b: inviter },
              `${email ? ` (${email})` : ""} ti ha invitato nel suo spazio di lavoro personale su agentes.chat.`,
            ]
          : "Hai un invito per uno spazio di lavoro personale su agentes.chat.",
      why: () =>
        "Ricevi questa email perché qualcuno ha invitato questo indirizzo nel suo spazio di lavoro personale. Se non sai chi è, ignorala. Non succede nulla finché non accetti.",
    },
  },
  inviteRequest: {
    subject: "Qualcuno ha chiesto un nuovo invito",
    preheader: "Il suo invito è scaduto. Puoi mandarne uno nuovo da Membri.",
    headline: "Qualcuno ha chiesto un nuovo invito",
    body: (email, org) =>
      email
        ? [{ b: email }, " ha aperto un invito scaduto per ", { b: org }, " e ne ha chiesto uno nuovo."]
        : ["Qualcuno con un link di invito scaduto per ", { b: org }, " ne ha chiesto uno nuovo."],
    next: "Se aspetti questa persona, mandale un nuovo invito da Membri. Altrimenti non devi fare nulla.",
    button: "Apri Membri",
    why: (org) => `Ricevi questa email perché hai creato questo invito, o gestisci i membri di ${org}.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " ha aperto un invito scaduto per il tuo spazio di lavoro e ne ha chiesto uno nuovo."]
          : "Qualcuno con un link di invito scaduto per il tuo spazio di lavoro ne ha chiesto uno nuovo.",
      why: () =>
        "Ricevi questa email perché hai creato questo invito, o ti occupi di chi fa parte del tuo spazio di lavoro.",
    },
  },
  calendar: {
    subject: "Sei invitato a un evento",
    preheader: (when) => `${when}. Vedilo nel calendario.`,
    headline: "Sei invitato a un evento",
    facts: { event: "Evento", when: "Quando", org: "Spazio di lavoro", by: "Invito da" },
    someone: "Qualcuno",
    button: "Vedi l’evento",
    why: (org) => `Ricevi questa email perché qualcuno di ${org} ti ha invitato a un evento.`,
    personal: {
      why: () => "Ricevi questa email perché qualcuno del tuo spazio di lavoro ti ha invitato a un evento.",
    },
  },
  waitlist: {
    subject: "Conferma il tuo posto nella lista d’attesa di agentes.chat",
    preheader: "Un clic e il tuo posto è salvato.",
    headline: "Conferma il tuo posto nella lista",
    body: (email) =>
      email
        ? ["Abbiamo ricevuto una richiesta per aggiungere ", { b: email }, " alla lista d’attesa di agentes.chat."]
        : "Abbiamo ricevuto una richiesta per aggiungere questo indirizzo alla lista d’attesa di agentes.chat.",
    approve:
      "Qui non succede nulla di importante senza l’approvazione di una persona. Vale anche per questa richiesta.",
    button: "Conferma la mia email",
    small:
      "Il link vale per 48 ore. Non sei stato tu? Ignora questa email. Senza il clic, l’indirizzo non entra mai nella lista.",
    why: "Ricevi questa email perché questo indirizzo è stato inserito nella lista d’attesa di agentes.chat.",
  },
  earlyAccess: {
    subject: "Il tuo invito ad agentes.chat è arrivato",
    preheader: (days) => `Crea il tuo account entro ${days} giorni, con questo indirizzo email.`,
    headline: "Il tuo accesso è pronto",
    body: (email) => [{ b: email }, " ora può creare un account e uno spazio di lavoro su agentes.chat."],
    what: "agentes.chat è il posto dove persone e agenti IA lavorano insieme.",
    button: "Crea il mio account",
    small: (days) =>
      `Il link vale per ${days} giorni, solo per questo indirizzo. Registrati con una password, oppure con Google, GitHub o Apple su questo stesso indirizzo.`,
    why: "Ricevi questa email perché questo indirizzo è nella lista d’attesa di agentes.chat, o è stato invitato su agentes.chat. Non succede nulla finché non ti registri.",
  },
  earlyAccessAllowed: {
    subject: "Ora puoi creare il tuo spazio di lavoro",
    preheader: "Accedi con l’account che hai già e configuralo.",
    headline: "Crea il tuo spazio di lavoro",
    body: (email) => [
      "Ora puoi creare il tuo spazio di lavoro su agentes.chat con ",
      { b: email },
      ", l’account che hai già.",
    ],
    button: "Crea il mio spazio di lavoro",
    why: "Ricevi questa email perché questo account ha ottenuto l’accesso anticipato ad agentes.chat.",
  },
  budget: {
    subject: {
      warning: "Un agente ha superato l’80% del budget mensile",
      exhausted: "Un agente si è fermato: budget mensile raggiunto",
    },
    preheader: {
      warning: "Al 100% si ferma fino al mese prossimo o finché il limite non sale.",
      exhausted: "Non risponderà fino al mese prossimo o finché il limite non sale.",
    },
    headline: { warning: "Un agente ha superato l’80% del budget", exhausted: "Un agente ha raggiunto il budget" },
    used: (pct, org) => `Usato il ${pct} del budget di questo mese · ${org}`,
    warning: "Al 100% si ferma e lo scrive nel canale. Un admin può cambiare il limite nella pagina dell’agente.",
    exhausted: "Non risponderà fino al mese prossimo, o finché un admin non alza il limite.",
    button: "Vedi il budget",
    why: (org) =>
      `Ricevi questa email perché sei il proprietario di questo agente, o un admin di ${org}. Parte all’80% e al 100%, una volta al mese per ciascuno.`,
    personal: {
      warning: "Al 100% si ferma e te lo dice. Puoi cambiare il limite nella pagina dell’agente.",
      exhausted: "Non risponderà fino al mese prossimo, o finché non alzi il limite nella pagina dell’agente.",
      why: () =>
        "Ricevi questa email perché questo agente è uno dei tuoi. Parte all’80% e al 100%, una volta al mese per ciascuno.",
    },
  },
  digest: {
    subject: (n) =>
      plural("it", n, {
        one: "Una richiesta aspetta la tua approvazione",
        other: `${n} richieste aspettano la tua approvazione`,
      }),
    preheader: "Le richieste scadono dopo 24 ore, e nulla parte senza una decisione.",
    headline: (n) => plural("it", n, { one: "Una richiesta ti aspetta", other: `${n} richieste ti aspettano` }),
    body: (n, org) => [
      "In ",
      { b: org },
      plural("it", n, {
        one: ", un agente ha chiesto di fare qualcosa che solo una persona può approvare.",
        other: ", alcuni agenti hanno chiesto di fare cose che solo una persona può approvare.",
      }),
    ],
    age: (h) => `${h} h fa`,
    more: (k) => `E altre ${k}.`,
    button: (n) => plural("it", n, { one: "Vedi la richiesta", other: "Apri le approvazioni" }),
    why: (org, hours) =>
      `Ricevi questa email perché puoi approvare queste richieste in ${org}.${hours ? ` Parte quando una richiesta aspetta più di ${hours} ore, una volta per richiesta.` : ""}`,
    personal: {
      body: (n) =>
        plural("it", n, {
          one: "Uno dei tuoi agenti ha chiesto di fare qualcosa che richiede la tua approvazione.",
          other: "I tuoi agenti hanno chiesto di fare cose che richiedono la tua approvazione.",
        }),
      why: (_org, hours) =>
        `Ricevi questa email perché puoi approvare queste richieste.${hours ? ` Parte quando una richiesta aspetta più di ${hours} ore, una volta per richiesta.` : ""}`,
    },
  },
  ready: {
    subject: "Il computer dei tuoi agenti è pronto",
    preheader: {
      ai: "Prossimo passo: collega la tua IA, così i tuoi agenti possono ragionare.",
      task: "Prossimo passo: dai una prima attività ai tuoi agenti.",
      create: "Prossimo passo: crea il tuo primo agente.",
    },
    headline: "Il computer dei tuoi agenti è pronto",
    computer: "Il computer dei tuoi agenti",
    body: (org) => [
      "Grazie per l’attesa. Il computer di ",
      { b: org },
      " è acceso e configurato, con un utente tutto suo per ogni agente. Resta acceso giorno e notte, così i tuoi agenti possono lavorare a qualsiasi ora.",
    ],
    facts: { cpus: "CPU", memory: "Memoria", disk: "Disco" },
    next: "Prossimi passi",
    steps: {
      ai: [
        "Collega la tua IA.",
        "Accedi con il tuo piano Claude o ChatGPT, il piano per programmare di un’altra IA, o una chiave API. I tuoi agenti ragionano con quella.",
      ],
      task: ["Dai una prima attività.", "In #general, chiama un agente con @ e scrivi di cosa hai bisogno."],
      watch: [
        "Guardali lavorare.",
        "Nella pagina di un agente, premi Apri per vedere il suo computer dal vivo. Prendi il controllo quando vuoi, e restituiscilo quando hai finito.",
      ],
      create: ["Crea un agente.", "Lavora su questo computer fin dall’inizio."],
    },
    button: { ai: "Collega la tua IA", task: "Dai una prima attività", create: "Crea un agente" },
    why: (org) =>
      `Ricevi questa email perché sei il proprietario di ${org} su agentes.chat. È l’unica email su questo computer.`,
    personal: {
      body: () =>
        "Grazie per l’attesa. Il computer dei tuoi agenti è acceso e configurato, con un utente tutto suo per ogni agente. Resta acceso giorno e notte, così i tuoi agenti possono lavorare a qualsiasi ora.",
      steps: {
        task: [
          "Dai una prima attività.",
          "Apri una conversazione con uno dei tuoi agenti e scrivi di cosa hai bisogno.",
        ],
      },
      why: () =>
        "Ricevi questa email perché questo spazio di lavoro su agentes.chat è tuo. È l’unica email su questo computer.",
    },
  },
  joinRequest: {
    subject: "Qualcuno chiede di entrare nel tuo spazio di lavoro",
    preheader: "Approva o rifiuta in Membri. Non succede nulla finché non rispondi.",
    headline: "C’è una richiesta di accesso in attesa",
    body: (org) => ["Una persona ha aperto il link di invito di ", { b: org }, " e ha chiesto di entrare."],
    note: "Approva solo le persone che aspetti. Entrano come membro, a meno che tu non scelga un altro ruolo nella pagina.",
    approve: "Approva",
    deny: "Rifiuta",
    more: "Tutte le richieste in attesa sono in Membri.",
    why: (org) => `Ricevi questa email perché sei proprietario o admin di ${org}. Parte al massimo una volta all’ora.`,
    personal: {
      body: () => "Una persona ha aperto il link di invito del tuo spazio di lavoro e ha chiesto di entrare.",
      why: () =>
        "Ricevi questa email perché ti occupi di chi entra nel tuo spazio di lavoro. Parte al massimo una volta all’ora.",
    },
  },
  joinAnswer: {
    someone: "Qualcuno",
    joined: {
      subject: "La tua richiesta di accesso è stata approvata",
      preheader: "Sei dentro. Apri lo spazio di lavoro per iniziare.",
      headline: "Sei dentro",
      body: (who, org, role) => [`${who} ha approvato la tua richiesta. Sei entrato in `, { b: org }, ` come ${role}.`],
      button: "Apri lo spazio di lavoro",
    },
    invited: {
      subject: "La tua richiesta di accesso è stata approvata",
      preheader: "Manca un passo: accetta l’invito entro 7 giorni.",
      headline: "Approvata: manca un passo",
      body: (who, org) => [`${who} ha approvato la tua richiesta di entrare in `, { b: org }, "."],
      next: "Accetta l’invito con questo indirizzo email entro 7 giorni.",
      button: "Accetta l’invito",
    },
    denied: {
      subject: "La tua richiesta di accesso non è stata approvata",
      preheader: "Qualcuno dello spazio di lavoro l’ha vista e non l’ha approvata.",
      headline: "La tua richiesta non è stata approvata",
      body: (org) => ["Qualcuno di ", { b: org }, " ha visto la tua richiesta e non l’ha approvata."],
      reason: (reason) => [{ b: "Il suo messaggio: " }, `“${reason}”`],
      small: "Se pensi che sia un errore, chiedi a qualcuno lì di invitarti via email.",
    },
    why: (org) => `Ricevi questa email perché questo indirizzo ha chiesto di entrare in ${org} su agentes.chat.`,
    personal: {
      joined: { body: (who) => `${who} ha approvato la tua richiesta. Ora sei nel suo spazio di lavoro.` },
      invited: { body: (who) => `${who} ha approvato la tua richiesta di entrare nel suo spazio di lavoro.` },
      denied: {
        preheader: "Questa persona l’ha vista e non l’ha approvata.",
        body: () => "La persona a cui l’hai chiesto ha visto la tua richiesta e non l’ha approvata.",
        small: "Se pensi che sia un errore, chiedile di invitarti via email.",
      },
      why: () =>
        "Ricevi questa email perché questo indirizzo ha chiesto di entrare in uno spazio di lavoro personale su agentes.chat.",
    },
  },
  joinCode: {
    subject: (code) => `${code} è il tuo codice agentes.chat`,
    preheader: "Inseriscilo nella pagina per chiedere di entrare. Vale per 10 minuti.",
    headline: "Il tuo codice",
    body: (org) => ["Inserisci questo codice nella pagina per chiedere di entrare in ", { b: org }, "."],
    small: ["Vale per 10 minuti. Se non l’hai chiesto tu, ", { nobr: "ignora questa email." }],
    why: (org) =>
      `Ricevi questa email perché qualcuno ha inserito questo indirizzo per chiedere di entrare in ${org} su agentes.chat.`,
    personal: {
      body: () => "Inserisci questo codice nella pagina per chiedere di entrare in questo spazio di lavoro.",
      why: () =>
        "Ricevi questa email perché qualcuno ha inserito questo indirizzo per chiedere di entrare in uno spazio di lavoro personale su agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} è il tuo codice per eliminare uno spazio di lavoro`,
    subjectAccount: (code) => `${code} è il tuo codice per eliminare tutto il tuo account`,
    preheader: "Inseriscilo in agentes.chat per confermare. Vale per 10 minuti.",
    headline: "Il tuo codice",
    workspace: (org) => [
      "Inserisci questo codice per eliminare lo spazio di lavoro ",
      { b: org },
      ". Diventa subito di sola lettura per tutti e viene eliminato per sempre 7 giorni dopo.",
    ],
    account: (email) => [
      "Inserisci questo codice per eliminare tutto l’account ",
      { b: email },
      ", non solo uno spazio di lavoro. Viene disconnesso subito ovunque ed eliminato per sempre 7 giorni dopo, e gli spazi di lavoro in cui ci sei solo tu si chiudono insieme a lui.",
    ],
    support: (address) => [
      "Vale per 10 minuti, e senza questo codice non si elimina nulla. Se non sei stato tu, non condividerlo e scrivi a ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Vale per 10 minuti, e senza questo codice non si elimina nulla. Se non sei stato tu, non condividerlo e avvisa chi gestisce questo server.",
    whyWorkspace: (org) => `Ricevi questa email perché il tuo account ha chiesto di eliminare ${org} su agentes.chat.`,
    whyAccount: "Ricevi questa email perché il tuo account ha chiesto di essere eliminato su agentes.chat.",
    personal: {
      workspace: (org) => [
        "Inserisci questo codice per eliminare il tuo spazio di lavoro ",
        { b: org },
        ". Diventa subito di sola lettura e viene eliminato per sempre 7 giorni dopo.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Uno spazio di lavoro di cui fai parte verrà eliminato il ${day}`,
    preheader: "Ora è di sola lettura. Un proprietario può ancora ripristinarlo fino ad allora.",
    headline: "Uno spazio di lavoro sta per essere eliminato",
    body: (by, org, day, time) => [
      { b: by },
      " ha eliminato lo spazio di lavoro ",
      { b: org },
      `. Ora è di sola lettura e sparirà per sempre il ${day} alle ${time}.`,
    ],
    owner: "Hai cambiato idea? Ripristinalo prima di allora.",
    button: "Ripristina lo spazio di lavoro",
    member: "Se è un errore, chiedi a un proprietario di ripristinarlo.",
    why: (org) => `Ricevi questa email perché fai parte di ${org} su agentes.chat.`,
    personal: {
      member: "Se è un errore, chiedi a chi l’ha eliminato di ripristinarlo.",
      why: () => "Ricevi questa email perché fai parte di questo spazio di lavoro su agentes.chat.",
    },
  },
  restored: {
    subject: "Uno spazio di lavoro di cui fai parte è tornato",
    preheader: "Un proprietario l’ha ripristinato. Funziona di nuovo.",
    headline: "Lo spazio di lavoro è tornato",
    body: (by, org) => [{ b: by }, " ha ripristinato ", { b: org }, ". Funziona di nuovo."],
    button: "Apri lo spazio di lavoro",
    why: (org) => `Ricevi questa email perché fai parte di ${org} su agentes.chat.`,
    personal: {
      why: () => "Ricevi questa email perché fai parte di questo spazio di lavoro su agentes.chat.",
    },
  },
  appConnected: {
    subject: "Un’app è stata collegata al tuo account agentes.chat",
    preheader: "Può leggere e mandare attività agli agenti a nome tuo in uno spazio di lavoro.",
    headline: "Un’app è stata collegata",
    body: (app, org) => [{ b: app }, " ora ha accesso al tuo account in ", { b: org }, "."],
    note: "Non l’hai collegata tu? Scollegala subito e cambia la password.",
    button: "Vedi le app collegate",
    why: (org) => `Ricevi questa email perché un’app è stata collegata al tuo account in ${org} su agentes.chat.`,
    personal: {
      body: (app) => [{ b: app }, " ora ha accesso al tuo account nel tuo spazio di lavoro personale."],
      why: () =>
        "Ricevi questa email perché un’app è stata collegata al tuo account nel tuo spazio di lavoro personale su agentes.chat.",
    },
  },
  accountDeleting: {
    subject: (day) => `Il tuo account agentes.chat verrà eliminato il ${day}`,
    preheader: "Hai 7 giorni per cambiare idea.",
    headline: "Il tuo account è in fase di eliminazione",
    body: (email, day, time) => [
      "Elimineremo l’account ",
      { b: email },
      ` il ${day} alle ${time}. È disconnesso ovunque e nessuno può raggiungerti qui finché non torni.`,
    ],
    closes: (count, names) => [
      plural("it", count, {
        one: "Lo spazio di lavoro in cui c’eri solo tu si è chiuso ora e sparisce nella stessa data: ",
        other: "Gli spazi di lavoro in cui c’eri solo tu si sono chiusi ora e spariscono nella stessa data: ",
      }),
      ...names,
      ".",
    ],
    undo: "Hai cambiato idea? Accedi prima di quella data e premi Ripristina.",
    button: "Accedi per ripristinare",
    why: "Hai ricevuto questa email perché questo indirizzo ha un account su agentes.chat.",
  },
  accountDeleted: {
    subject: "Il tuo account agentes.chat è stato eliminato",
    preheader: "È disconnesso ovunque e non può più accedere.",
    headline: "Il tuo account è stato eliminato",
    body: (email) => ["Abbiamo eliminato l’account ", { b: email }, "."],
    closes: (count, day, names) => [
      plural("it", count, {
        one: `Lo spazio di lavoro in cui c’eri solo tu è chiuso e verrà eliminato per sempre il ${day}: `,
        other: `Gli spazi di lavoro in cui c’eri solo tu sono chiusi e verranno eliminati per sempre il ${day}: `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Se non sei stato tu, scrivi a ", { mail: address }, "."],
    noSupport: "Se non sei stato tu, avvisa chi gestisce questo server.",
    why: "Ricevi questa email perché questo indirizzo aveva un account su agentes.chat.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agenti il ${day}: ${stalls} blocchi, ${noise} esecuzioni a vuoto`,
    preheader: "Dove gli agenti si sono fermati e dove hanno agito per niente, rispetto ai 7 giorni prima.",
    headline: (day) => `Blocchi e rumore il ${day}`,
    body: "Ogni spazio di lavoro attivo su questo server, nella giornata UTC. Solo nomi e conteggi.",
    stalls: "Blocchi",
    noise: "Rumore",
    metric: {
      mentionNoRun: "Menzioni che non hanno svegliato nessuno",
      readOnly: "Esecuzioni che potevano solo leggere",
      promiseUnkept: "Finite con lavoro lasciato a metà",
      promiseIgnored: "Ancora a metà dopo il sollecito",
      handoffUnanswered: "Passaggi senza risposta in 30 min",
      limitStops: "Fermati da un limite",
      personUnanswered: "Persone senza risposta in 10 min",
      taskStartFailed: "Attività fallite all’avvio",
      noiseRuns: "Esecuzioni a vuoto",
      quietRuns: "Finite senza una parola",
      ackReplies: "Risposte a un grazie o a un ok",
      idleWakes: "Svegliati senza niente da fare",
      noiseTokens: "I loro token",
      noiseCostNanoUsd: "Il loro costo",
    },
    value: (today, average) => `${today} · media su 7 giorni ${average}`,
    topStalls: "Più blocchi",
    topNoise: "Più esecuzioni a vuoto, con il loro costo",
    none: "Nessuno spazio di lavoro.",
    table: (day) => `La tabella completa: bun run report:autonomy --day ${day}`,
    why: "Ricevi questa email perché questo indirizzo è in OPS_REPORT_EMAIL su questo server. Parte una volta al giorno.",
  },
  planOpened: {
    subject: (plan) => `Più persone possono parlare con il tuo agente con il tuo piano ${plan}`,
    preheader: (plan) => `Le loro conversazioni usano il tuo piano ${plan} e i suoi limiti.`,
    headline: "Più persone possono parlare con il tuo agente",
    body: (by, agent, plan) => [
      { b: by },
      " ha fatto parlare più persone con ",
      { b: agent },
      `. Le loro conversazioni usano il tuo piano ${plan} e i suoi limiti.`,
    ],
    agent: "Agente",
    by: "Modificato da",
    was: "Prima",
    now: "Ora",
    everyone: "Tutti nel workspace",
    onlyYou: "Solo tu",
    you: "Tu",
    note: "Per annullare, cambia Chi può parlare nella pagina dell'agente.",
    button: "Vedi chi può parlare",
    why: (org) =>
      `Ricevi questa email perché un tuo agente in ${org} pensa con il tuo piano e qualcun altro ha cambiato chi può parlarci.`,
    personal: {
      why: () =>
        "Ricevi questa email perché un tuo agente pensa con il tuo piano e qualcun altro ha cambiato chi può parlarci.",
    },
  },
  planLent: {
    subject: (plan) => `Il tuo piano ${plan} ora pensa per un altro agente`,
    preheader: (plan) => `Le sue conversazioni usano il tuo piano ${plan} e i suoi limiti. Puoi riprenderlo.`,
    headline: "Qualcuno ha collegato il tuo piano a un agente",
    body: (by, agent, plan) => [
      { b: by },
      ` ha collegato il tuo piano ${plan} all’agente `,
      { b: agent },
      ". Le sue conversazioni usano il tuo piano e i suoi limiti.",
    ],
    agent: "Agente",
    by: "Collegato da",
    plan: "Piano",
    note: "Riprendilo con un clic dalle tue notifiche, e l’agente smette di pensare con il tuo piano.",
    button: "Apri le notifiche",
    why: (org) => `Ricevi questa email perché qualcuno in ${org} ha collegato il tuo piano a un agente.`,
    personal: {
      why: () => "Ricevi questa email perché qualcuno del tuo spazio di lavoro ha collegato il tuo piano a un agente.",
    },
  },
  planWaiting: {
    subject: "Il tuo team sta aspettando",
    preheader: "Il tuo spazio di lavoro è pronto. Serve un piano agentes.chat per iniziare.",
    headline: "Il tuo team sta aspettando",
    body: (agents, channels, routines) => {
      const a = plural("it", agents, { one: `1 agente`, other: `${agents} agenti` });
      const c = plural("it", channels, { one: `1 canale`, other: `${channels} canali` });
      const r = plural("it", routines, { one: `1 routine`, other: `${routines} routine` });
      return routines > 0
        ? `${a}, ${c} e ${r} sono pronti. Serve un piano agentes.chat per iniziare.`
        : `${a} e ${c} sono pronti. Serve un piano agentes.chat per iniziare.`;
    },
    button: "Vedi i piani agentes.chat",
    why: (org) =>
      `Hai ricevuto questa email perché gestisci ${org} su agentes.chat. Inviamo solo due avvisi come questo.`,
    personal: {
      subject: "I tuoi agenti stanno aspettando",
      headline: "I tuoi agenti stanno aspettando",
      body: (agents, _channels, routines) => {
        const a = plural("it", agents, { one: `1 agente`, other: `${agents} agenti` });
        const r = plural("it", routines, { one: `1 routine`, other: `${routines} routine` });
        return `Tutto pronto: ${routines > 0 ? `${a} e ${r}` : a}. Manca solo un piano agentes.chat.`;
      },
      why: () =>
        "Hai ricevuto questa email perché questo spazio di lavoro su agentes.chat è tuo. Inviamo solo due avvisi come questo.",
    },
  },
};
