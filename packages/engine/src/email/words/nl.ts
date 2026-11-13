import { plural } from "@agenteschat/i18n/format";
import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in nl: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("nl", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 */
export const words: EmailWords = {
  sentBy: (host) =>
    host ? atHost("Verstuurd door de agentes.chat-server", "op", host) : "Verstuurd door agentes.chat.",
  fallback: "Werkt de knop niet? Kopieer dit adres naar je browser:",
  role: { owner: "eigenaar", member: "lid" },
  anAgent: "Een agent",
  someone: "Iemand",
  verify: {
    subject: "Bevestig je e-mailadres voor agentes.chat",
    preheader: "Eén klik om dit adres te bevestigen. De link werkt een uur.",
    headline: "Bevestig je e-mailadres",
    body: "Nog één stap: bevestig dat dit adres van jou is.",
    button: "E-mailadres bevestigen",
    small: "De link werkt een uur. Heb je je niet aangemeld? Dan kun je deze e-mail negeren.",
    why: "Je krijgt deze e-mail omdat dit adres is gebruikt om je aan te melden bij agentes.chat.",
  },
  reset: {
    subject: "Stel je wachtwoord voor agentes.chat opnieuw in",
    preheader: "Kies een nieuw wachtwoord. De link werkt een uur.",
    headline: "Kies een nieuw wachtwoord",
    body: "We kregen een verzoek om het wachtwoord van dit adres opnieuw in te stellen.",
    button: "Nieuw wachtwoord kiezen",
    note: "Niet door jou gevraagd? Negeer deze e-mail. Je wachtwoord blijft hetzelfde.",
    small: "De link werkt een uur.",
    why: "Je krijgt deze e-mail omdat iemand heeft gevraagd het wachtwoord van dit adres op agentes.chat opnieuw in te stellen.",
  },
  invitation: {
    subject: "Je bent uitgenodigd voor een werkruimte op agentes.chat",
    preheader: "Accepteer binnen 7 dagen, met dit e-mailadres.",
    headline: "Je bent uitgenodigd voor een werkruimte",
    body: (inviter, email, org, role) =>
      inviter
        ? [
            { b: inviter },
            `${email ? ` (${email})` : ""} nodigt je uit om lid te worden van `,
            { b: org },
            ` als ${role}.`,
          ]
        : ["Je bent uitgenodigd om lid te worden van ", { b: org }, ` als ${role}.`],
    what: "Op agentes.chat werken mensen en AI-agents samen.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Hun bericht: " }, `‘${note}’`],
    button: "Uitnodiging accepteren",
    small: "De uitnodiging werkt 7 dagen. Accepteer haar met dit e-mailadres.",
    why: (org) =>
      `Je krijgt deze e-mail omdat iemand bij ${org} dit adres heeft uitgenodigd. Ken je diegene niet? Negeer de e-mail dan. Er gebeurt niets tot je accepteert.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [
              { b: inviter },
              `${email ? ` (${email})` : ""} nodigt je uit voor een persoonlijke werkruimte op agentes.chat.`,
            ]
          : "Je bent uitgenodigd voor een persoonlijke werkruimte op agentes.chat.",
      why: () =>
        "Je krijgt deze e-mail omdat iemand dit adres heeft uitgenodigd voor een persoonlijke werkruimte. Ken je diegene niet? Negeer de e-mail dan. Er gebeurt niets tot je accepteert.",
    },
  },
  inviteRequest: {
    subject: "Iemand vraagt om een nieuwe uitnodiging",
    preheader: "De uitnodiging is verlopen. Je kunt een nieuwe sturen vanuit Leden.",
    headline: "Iemand vraagt om een nieuwe uitnodiging",
    body: (email, org) =>
      email
        ? [{ b: email }, " opende een verlopen uitnodiging voor ", { b: org }, " en vraagt om een nieuwe."]
        : ["Iemand met een verlopen uitnodigingslink voor ", { b: org }, " vraagt om een nieuwe."],
    next: "Verwacht je deze persoon? Stuur dan een nieuwe uitnodiging vanuit Leden. Zo niet, dan hoef je niets te doen.",
    button: "Leden openen",
    why: (org) => `Je krijgt deze e-mail omdat je deze uitnodiging hebt gemaakt of de leden van ${org} beheert.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " opende een verlopen uitnodiging voor je werkruimte en vraagt om een nieuwe."]
          : "Iemand met een verlopen uitnodigingslink voor je werkruimte vraagt om een nieuwe.",
      why: () => "Je krijgt deze e-mail omdat je deze uitnodiging hebt gemaakt of bepaalt wie er in je werkruimte zit.",
    },
  },
  calendar: {
    subject: "Je bent uitgenodigd voor een afspraak",
    preheader: (when) => `${when}. Bekijk het in de agenda.`,
    headline: "Je bent uitgenodigd voor een afspraak",
    facts: { event: "Afspraak", when: "Wanneer", org: "Werkruimte", by: "Uitgenodigd door" },
    someone: "Iemand",
    button: "Afspraak bekijken",
    why: (org) => `Je krijgt deze e-mail omdat iemand bij ${org} je heeft uitgenodigd voor een afspraak.`,
    personal: {
      why: () => "Je krijgt deze e-mail omdat iemand in je werkruimte je heeft uitgenodigd voor een afspraak.",
    },
  },
  waitlist: {
    subject: "Bevestig je plek op de wachtlijst van agentes.chat",
    preheader: "Eén klik en je plek is vastgelegd.",
    headline: "Bevestig je plek op de lijst",
    body: (email) =>
      email
        ? ["We kregen een verzoek om ", { b: email }, " op de wachtlijst van agentes.chat te zetten."]
        : "We kregen een verzoek om dit adres op de wachtlijst van agentes.chat te zetten.",
    approve: "Hier gebeurt niets belangrijks zonder dat een mens het goedkeurt. Dat geldt ook voor dit verzoek.",
    button: "Mijn e-mailadres bevestigen",
    small:
      "De link werkt 48 uur. Was jij het niet? Negeer deze e-mail. Zonder de klik komt het adres nooit op de lijst.",
    why: "Je krijgt deze e-mail omdat dit adres is opgegeven voor de wachtlijst van agentes.chat.",
  },
  earlyAccess: {
    subject: "Je uitnodiging voor agentes.chat is er",
    preheader: (days) => `Maak binnen ${days} dagen je account aan, met dit e-mailadres.`,
    headline: "Je toegang staat klaar",
    body: (email) => [{ b: email }, " kan nu een account en een werkruimte aanmaken op agentes.chat."],
    what: "Op agentes.chat werken mensen en AI-agents samen.",
    button: "Mijn account aanmaken",
    small: (days) =>
      `De link werkt ${days} dagen, alleen voor dit adres. Meld je aan met een wachtwoord, of met Google, GitHub of Apple op ditzelfde adres.`,
    why: "Je krijgt deze e-mail omdat dit adres op de wachtlijst van agentes.chat staat of is uitgenodigd voor agentes.chat. Er gebeurt niets tot je je aanmeldt.",
  },
  earlyAccessAllowed: {
    subject: "Je kunt nu je eigen werkruimte aanmaken",
    preheader: "Log in met het account dat je al hebt en richt hem in.",
    headline: "Maak je eigen werkruimte aan",
    body: (email) => [
      "Je kunt nu je eigen werkruimte aanmaken op agentes.chat met ",
      { b: email },
      ", het account dat je al hebt.",
    ],
    button: "Mijn werkruimte aanmaken",
    why: "Je krijgt deze e-mail omdat dit account vroege toegang tot agentes.chat heeft gekregen.",
  },
  budget: {
    subject: {
      warning: "Een agent zit boven 80% van zijn maandbudget",
      exhausted: "Een agent is gestopt: maandbudget bereikt",
    },
    preheader: {
      warning: "Bij 100% stopt hij tot de nieuwe maand begint of de limiet omhooggaat.",
      exhausted: "Hij antwoordt niet tot de nieuwe maand begint of de limiet omhooggaat.",
    },
    headline: { warning: "Een agent zit boven 80% van zijn budget", exhausted: "Een agent heeft zijn budget bereikt" },
    used: (pct, org) => `${pct} van het budget van deze maand gebruikt · ${org}`,
    warning:
      "Bij 100% stopt hij en meldt dat in het kanaal. Een beheerder kan de limiet aanpassen op de pagina van de agent.",
    exhausted: "Hij antwoordt niet tot de nieuwe maand begint, of tot een beheerder de limiet verhoogt.",
    button: "Budget bekijken",
    why: (org) =>
      `Je krijgt deze e-mail omdat je eigenaar bent van deze agent of beheerder van ${org}. We sturen hem bij 80% en bij 100%, elk één keer per maand.`,
    personal: {
      warning: "Bij 100% stopt hij en laat hij het je weten. Je kunt de limiet aanpassen op de pagina van de agent.",
      exhausted:
        "Hij antwoordt niet tot de nieuwe maand begint, of tot je de limiet verhoogt op de pagina van de agent.",
      why: () =>
        "Je krijgt deze e-mail omdat deze agent van jou is. We sturen hem bij 80% en bij 100%, elk één keer per maand.",
    },
  },
  digest: {
    subject: (n) =>
      plural("nl", n, {
        one: "Er wacht een verzoek op je goedkeuring",
        other: `Er wachten ${n} verzoeken op je goedkeuring`,
      }),
    preheader: "Verzoeken verlopen na 24 uur, en zonder beslissing gebeurt er niets.",
    headline: (n) => plural("nl", n, { one: "Er wacht een verzoek op je", other: `Er wachten ${n} verzoeken op je` }),
    body: (n, org) => [
      "In ",
      { b: org },
      plural("nl", n, {
        one: " vroeg een agent om iets te doen wat alleen een mens kan goedkeuren.",
        other: " vroegen agents om dingen te doen die alleen een mens kan goedkeuren.",
      }),
    ],
    age: (h) => `${h} u geleden`,
    more: (k) => `En nog ${k}.`,
    button: (n) => plural("nl", n, { one: "Verzoek bekijken", other: "Goedkeuringen openen" }),
    why: (org, hours) =>
      `Je krijgt deze e-mail omdat je deze verzoeken in ${org} kunt goedkeuren.${hours ? ` We sturen hem als een verzoek langer dan ${hours} uur wacht, één keer per verzoek.` : ""}`,
    personal: {
      body: (n) =>
        plural("nl", n, {
          one: "Een van je agents vroeg om iets te doen waarvoor je goedkeuring nodig is.",
          other: "Je agents vroegen om dingen te doen waarvoor je goedkeuring nodig is.",
        }),
      why: (_org, hours) =>
        `Je krijgt deze e-mail omdat je deze verzoeken kunt goedkeuren.${hours ? ` We sturen hem als een verzoek langer dan ${hours} uur wacht, één keer per verzoek.` : ""}`,
    },
  },
  ready: {
    subject: "De computer van je agents staat klaar",
    preheader: {
      ai: "Volgende stap: koppel je AI, zodat je agents kunnen denken.",
      task: "Volgende stap: geef je agents een eerste taak.",
      create: "Volgende stap: maak je eerste agent aan.",
    },
    headline: "De computer van je agents staat klaar",
    computer: "De computer van je agents",
    body: (org) => [
      "Bedankt voor het wachten. De computer van ",
      { b: org },
      " staat aan en is ingericht, met een eigen gebruiker voor elke agent. Hij blijft dag en nacht aan, zodat je agents altijd kunnen werken.",
    ],
    facts: { cpus: "CPU's", memory: "Geheugen", disk: "Schijf" },
    next: "Volgende stappen",
    steps: {
      ai: [
        "Koppel je AI.",
        "Log in met je Claude- of ChatGPT-abonnement, het codeerabonnement van een andere AI of een API-sleutel. Daarmee denken je agents.",
      ],
      task: ["Geef een eerste taak.", "Roep in #general een agent aan met @ en zeg wat je nodig hebt."],
      watch: [
        "Kijk hoe ze werken.",
        "Klik op de pagina van een agent op Openen om zijn computer live te zien. Neem de controle over wanneer je wilt, en geef die terug als je klaar bent.",
      ],
      create: ["Maak een agent aan.", "Hij werkt vanaf het begin op deze computer."],
    },
    button: { ai: "Je AI koppelen", task: "Eerste taak geven", create: "Agent aanmaken" },
    why: (org) =>
      `Je krijgt deze e-mail omdat je eigenaar bent van ${org} op agentes.chat. Het is de enige e-mail over deze computer.`,
    personal: {
      body: () =>
        "Bedankt voor het wachten. De computer van je agents staat aan en is ingericht, met een eigen gebruiker voor elke agent. Hij blijft dag en nacht aan, zodat je agents altijd kunnen werken.",
      steps: {
        task: ["Geef een eerste taak.", "Open een gesprek met een van je agents en zeg wat je nodig hebt."],
      },
      why: () =>
        "Je krijgt deze e-mail omdat deze werkruimte op agentes.chat van jou is. Het is de enige e-mail over deze computer.",
    },
  },
  joinRequest: {
    subject: "Iemand wil lid worden van je werkruimte",
    preheader: "Keur het goed of weiger het in Leden. Er gebeurt niets tot je antwoordt.",
    headline: "Er wacht een verzoek om lid te worden",
    body: (org) => ["Diegene opende de uitnodigingslink van ", { b: org }, " en vraagt om lid te worden."],
    note: "Keur alleen mensen goed die je verwacht. Ze worden lid, tenzij je op de pagina een andere rol kiest.",
    approve: "Goedkeuren",
    deny: "Weigeren",
    more: "Alle wachtende verzoeken staan in Leden.",
    why: (org) =>
      `Je krijgt deze e-mail omdat je eigenaar of beheerder bent van ${org}. We sturen hem hooguit één keer per uur.`,
    personal: {
      body: () => "Diegene opende de uitnodigingslink van je werkruimte en vraagt om lid te worden.",
      why: () =>
        "Je krijgt deze e-mail omdat jij bepaalt wie er lid wordt van je werkruimte. We sturen hem hooguit één keer per uur.",
    },
  },
  joinAnswer: {
    someone: "Iemand",
    joined: {
      subject: "Je verzoek om lid te worden is goedgekeurd",
      preheader: "Je bent binnen. Open de werkruimte om te beginnen.",
      headline: "Je bent binnen",
      body: (who, org, role) => [
        `${who} heeft je verzoek goedgekeurd. Je bent lid geworden van `,
        { b: org },
        ` als ${role}.`,
      ],
      button: "Werkruimte openen",
    },
    invited: {
      subject: "Je verzoek om lid te worden is goedgekeurd",
      preheader: "Nog één stap: accepteer de uitnodiging binnen 7 dagen.",
      headline: "Goedgekeurd: nog één stap",
      body: (who, org) => [`${who} heeft je verzoek om lid te worden van `, { b: org }, " goedgekeurd."],
      next: "Accepteer de uitnodiging binnen 7 dagen met dit e-mailadres.",
      button: "Uitnodiging accepteren",
    },
    denied: {
      subject: "Je verzoek om lid te worden is niet goedgekeurd",
      preheader: "Iemand van de werkruimte heeft het bekeken en niet goedgekeurd.",
      headline: "Je verzoek is niet goedgekeurd",
      body: (org) => ["Iemand bij ", { b: org }, " heeft je verzoek bekeken en niet goedgekeurd."],
      reason: (reason) => [{ b: "Hun bericht: " }, `‘${reason}’`],
      small: "Denk je dat het een vergissing is? Vraag iemand daar om je per e-mail uit te nodigen.",
    },
    why: (org) => `Je krijgt deze e-mail omdat dit adres heeft gevraagd om lid te worden van ${org} op agentes.chat.`,
    personal: {
      joined: { body: (who) => `${who} heeft je verzoek goedgekeurd. Je zit nu in de werkruimte.` },
      invited: { body: (who) => `${who} heeft je verzoek om lid te worden van de werkruimte goedgekeurd.` },
      denied: {
        preheader: "Diegene heeft het bekeken en niet goedgekeurd.",
        body: () => "De persoon aan wie je het vroeg, heeft je verzoek bekeken en niet goedgekeurd.",
        small: "Denk je dat het een vergissing is? Vraag diegene om je per e-mail uit te nodigen.",
      },
      why: () =>
        "Je krijgt deze e-mail omdat dit adres heeft gevraagd om lid te worden van een persoonlijke werkruimte op agentes.chat.",
    },
  },
  joinCode: {
    subject: (code) => `${code} is je code voor agentes.chat`,
    preheader: "Typ hem op de pagina om te vragen of je lid mag worden. Hij werkt 10 minuten.",
    headline: "Je code",
    body: (org) => ["Typ deze code op de pagina om te vragen of je lid mag worden van ", { b: org }, "."],
    small: ["Hij werkt 10 minuten. Heb je er niet om gevraagd? ", { nobr: "Negeer deze e-mail." }],
    why: (org) =>
      `Je krijgt deze e-mail omdat iemand dit adres heeft ingevuld om lid te worden van ${org} op agentes.chat.`,
    personal: {
      body: () => "Typ deze code op de pagina om te vragen of je lid mag worden van deze werkruimte.",
      why: () =>
        "Je krijgt deze e-mail omdat iemand dit adres heeft ingevuld om lid te worden van een persoonlijke werkruimte op agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} is je code om een werkruimte te verwijderen`,
    subjectAccount: (code) => `${code} is je code om je hele account te verwijderen`,
    preheader: "Typ hem in agentes.chat om te bevestigen. Hij werkt 10 minuten.",
    headline: "Je code",
    workspace: (org) => [
      "Typ deze code om de werkruimte ",
      { b: org },
      " te verwijderen. Hij wordt meteen voor iedereen alleen-lezen en 7 dagen later definitief verwijderd.",
    ],
    account: (email) => [
      "Typ deze code om het hele account ",
      { b: email },
      " te verwijderen, niet alleen één werkruimte. Het wordt meteen overal uitgelogd en 7 dagen later definitief verwijderd, en de werkruimtes waar alleen jij in zit gaan mee dicht.",
    ],
    support: (address) => [
      "Hij werkt 10 minuten, en zonder deze code wordt er niets verwijderd. Was jij het niet? Deel hem dan niet en schrijf naar ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Hij werkt 10 minuten, en zonder deze code wordt er niets verwijderd. Was jij het niet? Deel hem dan niet en laat het weten aan de mensen die deze server beheren.",
    whyWorkspace: (org) =>
      `Je krijgt deze e-mail omdat vanuit je account is gevraagd om ${org} op agentes.chat te verwijderen.`,
    whyAccount: "Je krijgt deze e-mail omdat vanuit je account is gevraagd om het van agentes.chat te verwijderen.",
    personal: {
      workspace: (org) => [
        "Typ deze code om je werkruimte ",
        { b: org },
        " te verwijderen. Hij wordt meteen alleen-lezen en 7 dagen later definitief verwijderd.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Een werkruimte waar je in zit wordt op ${day} verwijderd`,
    preheader: "Hij is nu alleen-lezen. Tot dan kan een eigenaar hem nog herstellen.",
    headline: "Een werkruimte wordt verwijderd",
    body: (by, org, day, time) => [
      { b: by },
      " heeft de werkruimte ",
      { b: org },
      ` verwijderd. Hij is nu alleen-lezen en verdwijnt definitief op ${day} om ${time}.`,
    ],
    owner: "Toch van gedachten veranderd? Herstel hem voor die tijd.",
    button: "Werkruimte herstellen",
    member: "Is het een vergissing? Vraag een eigenaar om hem te herstellen.",
    why: (org) => `Je krijgt deze e-mail omdat je in ${org} op agentes.chat zit.`,
    personal: {
      member: "Is het een vergissing? Vraag degene die hem verwijderde om hem te herstellen.",
      why: () => "Je krijgt deze e-mail omdat je in deze werkruimte op agentes.chat zit.",
    },
  },
  restored: {
    subject: "Een werkruimte waar je in zit is terug",
    preheader: "Een eigenaar heeft hem hersteld. Hij werkt weer.",
    headline: "De werkruimte is terug",
    body: (by, org) => [{ b: by }, " heeft ", { b: org }, " hersteld. Hij werkt weer."],
    button: "Werkruimte openen",
    why: (org) => `Je krijgt deze e-mail omdat je in ${org} op agentes.chat zit.`,
    personal: {
      why: () => "Je krijgt deze e-mail omdat je in deze werkruimte op agentes.chat zit.",
    },
  },
  appConnected: {
    subject: "Er is een app gekoppeld aan je agentes.chat-account",
    preheader: "Hij kan in één werkruimte namens jou lezen en taken naar agents sturen.",
    headline: "Er is een app gekoppeld",
    body: (app, org) => [{ b: app }, " heeft nu toegang tot je account in ", { b: org }, "."],
    note: "Heb je hem niet gekoppeld? Ontkoppel hem nu en wijzig je wachtwoord.",
    button: "Gekoppelde apps bekijken",
    why: (org) => `Je krijgt deze e-mail omdat er een app is gekoppeld aan je account in ${org} op agentes.chat.`,
    personal: {
      body: (app) => [{ b: app }, " heeft nu toegang tot je account in je persoonlijke werkruimte."],
      why: () =>
        "Je krijgt deze e-mail omdat er een app is gekoppeld aan je account in je persoonlijke werkruimte op agentes.chat.",
    },
  },
  accountDeleting: {
    subject: (day) => `Je agentes.chat-account wordt op ${day} verwijderd`,
    preheader: "Je hebt 7 dagen om van gedachten te veranderen.",
    headline: "Je account wordt verwijderd",
    body: (email, day, time) => [
      "We verwijderen het account ",
      { b: email },
      ` op ${day} om ${time}. Het is overal uitgelogd en niemand kan je hier bereiken tot je terug bent.`,
    ],
    closes: (count, names) => [
      plural("nl", count, {
        one: "De werkruimte waar alleen jij in zat is nu gesloten en verdwijnt op dezelfde datum: ",
        other: "De werkruimtes waar alleen jij in zat zijn nu gesloten en verdwijnen op dezelfde datum: ",
      }),
      ...names,
      ".",
    ],
    undo: "Toch van gedachten veranderd? Log voor die datum in en druk op Herstellen.",
    button: "Inloggen om te herstellen",
    why: "Je krijgt deze e-mail omdat dit adres een account heeft op agentes.chat.",
  },
  accountDeleted: {
    subject: "Je agentes.chat-account is verwijderd",
    preheader: "Het is overal uitgelogd en kan niet meer inloggen.",
    headline: "Je account is verwijderd",
    body: (email) => ["We hebben het account ", { b: email }, " verwijderd."],
    closes: (count, day, names) => [
      plural("nl", count, {
        one: `De werkruimte waar alleen jij in zat is gesloten en wordt op ${day} definitief verwijderd: `,
        other: `De ${count} werkruimtes waar alleen jij in zat zijn gesloten en worden op ${day} definitief verwijderd: `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Was jij het niet? Schrijf naar ", { mail: address }, "."],
    noSupport: "Was jij het niet? Laat het weten aan de mensen die deze server beheren.",
    why: "Je krijgt deze e-mail omdat dit adres een account had op agentes.chat.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agents op ${day}: ${stalls} keer vastgelopen, ${noise} runs voor niets`,
    preheader: "Waar agents vastliepen en waar ze voor niets in actie kwamen, vergeleken met de 7 dagen ervoor.",
    headline: (day) => `Vastgelopen en voor niets op ${day}`,
    body: "Elke actieve werkruimte op deze server, over de UTC-dag. Alleen namen en aantallen.",
    stalls: "Vastgelopen",
    noise: "Voor niets",
    metric: {
      mentionNoRun: "Vermeldingen die niemand wekten",
      readOnly: "Runs die alleen konden lezen",
      promiseUnkept: "Gestopt met werk dat nog open stond",
      promiseIgnored: "Nog steeds open na het duwtje",
      handoffUnanswered: "Overdrachten zonder antwoord in 30 min",
      limitStops: "Gestopt door een limiet",
      personUnanswered: "Mensen zonder antwoord in 10 min",
      taskStartFailed: "Taken die bij de start mislukten",
      noiseRuns: "Runs voor niets",
      quietRuns: "Gestopt zonder een woord",
      ackReplies: "Antwoord op een bedankje of een oké",
      idleWakes: "Gewekt zonder iets te doen",
      noiseTokens: "Hun tokens",
      noiseCostNanoUsd: "Hun kosten",
    },
    value: (today, average) => `${today} · gemiddelde over 7 dagen ${average}`,
    topStalls: "Vaakst vastgelopen",
    topNoise: "Meeste runs voor niets, met hun kosten",
    none: "Geen werkruimte.",
    table: (day) => `De hele tabel: bun run report:autonomy --day ${day}`,
    why: "Je krijgt deze e-mail omdat dit adres in OPS_REPORT_EMAIL op deze server staat. We sturen hem één keer per dag.",
  },
  planOpened: {
    subject: (plan) => `Meer mensen kunnen met je agent praten via je ${plan}-abonnement`,
    preheader: (plan) => `Hun gesprekken gebruiken je ${plan}-abonnement en de limieten ervan.`,
    headline: "Meer mensen kunnen met je agent praten",
    body: (by, agent, plan) => [
      { b: by },
      " heeft meer mensen met ",
      { b: agent },
      ` laten praten. Hun gesprekken gebruiken je ${plan}-abonnement en de limieten ervan.`,
    ],
    agent: "Agent",
    by: "Gewijzigd door",
    was: "Eerst",
    now: "Nu",
    everyone: "Iedereen in de workspace",
    onlyYou: "Alleen jij",
    you: "Jij",
    note: "Ongedaan maken? Wijzig Wie mag praten op de pagina van de agent.",
    button: "Bekijk wie mag praten",
    why: (org) =>
      `Je krijgt deze e-mail omdat een agent van jou in ${org} met je abonnement denkt en iemand anders heeft gewijzigd wie met hem mag praten.`,
    personal: {
      why: () =>
        "Je krijgt deze e-mail omdat een agent van jou met je abonnement denkt en iemand anders heeft gewijzigd wie met hem mag praten.",
    },
  },
  planLent: {
    subject: (plan) => `Je ${plan}-abonnement denkt nu voor een andere agent`,
    preheader: (plan) =>
      `Zijn gesprekken gebruiken je ${plan}-abonnement en de limieten ervan. Je kunt het terugnemen.`,
    headline: "Iemand heeft je abonnement aan een agent gekoppeld",
    body: (by, agent, plan) => [
      { b: by },
      ` heeft je ${plan}-abonnement aan de agent `,
      { b: agent },
      " gekoppeld. Zijn gesprekken gebruiken je abonnement en de limieten ervan.",
    ],
    agent: "Agent",
    by: "Gekoppeld door",
    plan: "Abonnement",
    note: "Neem het met één klik terug in je meldingen, dan denkt de agent niet meer met je abonnement.",
    button: "Meldingen openen",
    why: (org) => `Je krijgt deze e-mail omdat iemand in ${org} je abonnement aan een agent heeft gekoppeld.`,
    personal: {
      why: () => "Je krijgt deze e-mail omdat iemand in je werkruimte je abonnement aan een agent heeft gekoppeld.",
    },
  },
  planWaiting: {
    subject: "Je team wacht",
    preheader: "Je werkruimte is klaar. Er is een agentes.chat-abonnement nodig om te beginnen.",
    headline: "Je team wacht",
    body: (agents, channels, routines) => {
      const a = plural("nl", agents, { one: `1 agent`, other: `${agents} agents` });
      const c = plural("nl", channels, { one: `1 kanaal`, other: `${channels} kanalen` });
      const r = plural("nl", routines, { one: `1 routine`, other: `${routines} routines` });
      return routines > 0
        ? `${a}, ${c} en ${r} staan klaar. Er is een agentes.chat-abonnement nodig om te beginnen.`
        : `${a} en ${c} staan klaar. Er is een agentes.chat-abonnement nodig om te beginnen.`;
    },
    button: "agentes.chat-abonnementen bekijken",
    why: (org) =>
      `Je krijgt deze e-mail omdat je ${org} beheert op agentes.chat. We sturen maar twee van deze berichten.`,
    personal: {
      subject: "Je agents wachten",
      headline: "Je agents wachten",
      body: (agents, _channels, routines) => {
        const a = plural("nl", agents, { one: `1 agent`, other: `${agents} agents` });
        const r = plural("nl", routines, { one: `1 routine`, other: `${routines} routines` });
        return `Klaar: ${routines > 0 ? `${a} en ${r}` : a}. Alleen een agentes.chat-abonnement ontbreekt nog.`;
      },
      why: () =>
        "Je krijgt deze e-mail omdat deze werkruimte op agentes.chat van jou is. We sturen maar twee van deze berichten.",
    },
  },
};
