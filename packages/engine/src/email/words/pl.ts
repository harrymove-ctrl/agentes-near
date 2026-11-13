import { plural } from "@agenteschat/i18n/format";
import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in pl: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("pl", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 */
export const words: EmailWords = {
  sentBy: (host) =>
    host ? atHost("Wysłano z serwera agentes.chat pod", "adresem", host) : "Wysłano przez agentes.chat.",
  fallback: "Przycisk nie działa? Skopiuj ten adres do przeglądarki:",
  role: { owner: "właściciel", member: "członek" },
  anAgent: "Agent",
  someone: "Ktoś",
  verify: {
    subject: "Potwierdź swój e-mail w agentes.chat",
    preheader: "Jedno kliknięcie, żeby potwierdzić ten adres. Link działa przez godzinę.",
    headline: "Potwierdź swój e-mail",
    body: "Został jeden krok: potwierdź, że ten adres należy do ciebie.",
    button: "Potwierdź e-mail",
    small: "Link działa przez godzinę. Jeśli to nie ty zakładasz konto, możesz zignorować tę wiadomość.",
    why: "Otrzymujesz tę wiadomość, ponieważ ten adres został użyty do założenia konta w agentes.chat.",
  },
  reset: {
    subject: "Zresetuj hasło do agentes.chat",
    preheader: "Ustaw nowe hasło. Link działa przez godzinę.",
    headline: "Ustaw nowe hasło",
    body: "Otrzymaliśmy prośbę o zresetowanie hasła dla tego adresu.",
    button: "Ustaw nowe hasło",
    note: "To nie ty? Zignoruj tę wiadomość. Twoje hasło się nie zmieni.",
    small: "Link działa przez godzinę.",
    why: "Otrzymujesz tę wiadomość, ponieważ ktoś poprosił o zresetowanie hasła dla tego adresu w agentes.chat.",
  },
  invitation: {
    subject: "Masz zaproszenie do przestrzeni roboczej w agentes.chat",
    preheader: "Przyjmij je w ciągu 7 dni, z tego adresu e-mail.",
    headline: "Masz zaproszenie do przestrzeni roboczej",
    body: (inviter, email, org, role) =>
      inviter
        ? [
            { b: inviter },
            `${email ? ` (${email})` : ""} zaprasza cię do przestrzeni roboczej `,
            { b: org },
            ` jako ${role}.`,
          ]
        : ["Masz zaproszenie do przestrzeni roboczej ", { b: org }, ` jako ${role}.`],
    what: "agentes.chat to miejsce, w którym osoby i agenci AI pracują razem.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Wiadomość: " }, `„${note}”`],
    button: "Przyjmij zaproszenie",
    small: "Zaproszenie jest ważne przez 7 dni. Przyjmij je z tego adresu e-mail.",
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ ktoś z przestrzeni roboczej ${org} zaprosił ten adres. Jeśli nie znasz tej osoby, zignoruj tę wiadomość. Nic się nie stanie, dopóki nie przyjmiesz zaproszenia.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [
              { b: inviter },
              `${email ? ` (${email})` : ""} zaprasza cię do swojej osobistej przestrzeni roboczej w agentes.chat.`,
            ]
          : "Masz zaproszenie do osobistej przestrzeni roboczej w agentes.chat.",
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ ktoś zaprosił ten adres do swojej osobistej przestrzeni roboczej. Jeśli nie znasz tej osoby, zignoruj tę wiadomość. Nic się nie stanie, dopóki nie przyjmiesz zaproszenia.",
    },
  },
  inviteRequest: {
    subject: "Ktoś prosi o nowe zaproszenie",
    preheader: "Zaproszenie wygasło. Nowe wyślesz w sekcji Członkowie.",
    headline: "Ktoś prosi o nowe zaproszenie",
    body: (email, org) =>
      email
        ? [
            "Z adresu ",
            { b: email },
            " otwarto wygasłe zaproszenie do przestrzeni roboczej ",
            { b: org },
            " i poproszono o nowe.",
          ]
        : ["Ktoś z wygasłym linkiem z zaproszeniem do przestrzeni roboczej ", { b: org }, " prosi o nowy."],
    next: "Jeśli spodziewasz się tej osoby, wyślij nowe zaproszenie w sekcji Członkowie. Jeśli nie, nic nie musisz robić.",
    button: "Otwórz listę członków",
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ to zaproszenie pochodzi od ciebie albo zarządzasz członkami przestrzeni roboczej ${org}.`,
    personal: {
      body: (email) =>
        email
          ? [
              "Z adresu ",
              { b: email },
              " otwarto wygasłe zaproszenie do twojej przestrzeni roboczej i poproszono o nowe.",
            ]
          : "Ktoś z wygasłym linkiem z zaproszeniem do twojej przestrzeni roboczej prosi o nowy.",
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ to zaproszenie pochodzi od ciebie albo decydujesz, kto jest w twojej przestrzeni roboczej.",
    },
  },
  calendar: {
    subject: "Masz zaproszenie na wydarzenie",
    preheader: (when) => `${when}. Zobacz je w kalendarzu.`,
    headline: "Masz zaproszenie na wydarzenie",
    facts: { event: "Wydarzenie", when: "Kiedy", org: "Przestrzeń robocza", by: "Zaprasza" },
    someone: "Ktoś",
    button: "Zobacz wydarzenie",
    why: (org) => `Otrzymujesz tę wiadomość, ponieważ ktoś z przestrzeni roboczej ${org} zaprosił cię na wydarzenie.`,
    personal: {
      why: () => "Otrzymujesz tę wiadomość, ponieważ ktoś z twojej przestrzeni roboczej zaprosił cię na wydarzenie.",
    },
  },
  waitlist: {
    subject: "Potwierdź swoje miejsce na liście oczekujących agentes.chat",
    preheader: "Jedno kliknięcie i twoje miejsce jest zarezerwowane.",
    headline: "Potwierdź swoje miejsce na liście",
    body: (email) =>
      email
        ? ["Otrzymaliśmy prośbę o dopisanie adresu ", { b: email }, " do listy oczekujących agentes.chat."]
        : "Otrzymaliśmy prośbę o dopisanie tego adresu do listy oczekujących agentes.chat.",
    approve: "Tutaj nic ważnego nie dzieje się, dopóki ktoś tego nie zatwierdzi. Dotyczy to także tej prośby.",
    button: "Potwierdź mój e-mail",
    small: "Link działa przez 48 godzin. To nie ty? Zignoruj tę wiadomość. Bez kliknięcia adres nie trafi na listę.",
    why: "Otrzymujesz tę wiadomość, ponieważ ten adres został wpisany na listę oczekujących agentes.chat.",
  },
  earlyAccess: {
    subject: "Twoje zaproszenie do agentes.chat już jest",
    preheader: (days) =>
      `Załóż konto w ciągu ${plural("pl", days, { one: `${days} dnia`, few: `${days} dni`, many: `${days} dni`, other: `${days} dnia` })}, z tego adresu e-mail.`,
    headline: "Twój dostęp jest gotowy",
    body: (email) => ["Z adresu ", { b: email }, " możesz już założyć konto i przestrzeń roboczą w agentes.chat."],
    what: "agentes.chat to miejsce, w którym osoby i agenci AI pracują razem.",
    button: "Załóż konto",
    small: (days) =>
      `Link działa przez ${plural("pl", days, { one: `${days} dzień`, few: `${days} dni`, many: `${days} dni`, other: `${days} dnia` })}, tylko dla tego adresu. Zarejestruj się hasłem albo przez Google, GitHub lub Apple na ten sam adres.`,
    why: "Otrzymujesz tę wiadomość, ponieważ ten adres jest na liście oczekujących agentes.chat albo dostał zaproszenie do agentes.chat. Nic się nie stanie, dopóki się nie zarejestrujesz.",
  },
  earlyAccessAllowed: {
    subject: "Możesz już założyć własną przestrzeń roboczą",
    preheader: "Zaloguj się na konto, które już masz, i ją skonfiguruj.",
    headline: "Załóż własną przestrzeń roboczą",
    body: (email) => [
      "Możesz już założyć własną przestrzeń roboczą w agentes.chat na koncie ",
      { b: email },
      ", które już masz.",
    ],
    button: "Załóż przestrzeń roboczą",
    why: "Otrzymujesz tę wiadomość, ponieważ to konto dostało wczesny dostęp do agentes.chat.",
  },
  budget: {
    subject: {
      warning: "Agent przekroczył 80% miesięcznego budżetu",
      exhausted: "Agent się zatrzymał: miesięczny budżet wyczerpany",
    },
    preheader: {
      warning: "Przy 100% zatrzyma się do początku nowego miesiąca albo do podniesienia limitu.",
      exhausted: "Nie odpowie do początku nowego miesiąca albo do podniesienia limitu.",
    },
    headline: { warning: "Agent przekroczył 80% budżetu", exhausted: "Agent wyczerpał budżet" },
    used: (pct, org) => `Wykorzystano ${pct} budżetu na ten miesiąc · ${org}`,
    warning: "Przy 100% zatrzyma się i napisze o tym na kanale. Administrator może zmienić limit na stronie agenta.",
    exhausted: "Nie odpowie do początku nowego miesiąca albo do czasu, aż administrator podniesie limit.",
    button: "Zobacz budżet",
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ jesteś właścicielem tego agenta albo administratorem przestrzeni roboczej ${org}. Przychodzi przy 80% i przy 100%, każda raz w miesiącu.`,
    personal: {
      warning: "Przy 100% zatrzyma się i da ci znać. Limit możesz zmienić na stronie agenta.",
      exhausted: "Nie odpowie do początku nowego miesiąca albo do czasu, aż podniesiesz limit na stronie agenta.",
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ to twój agent. Przychodzi przy 80% i przy 100%, każda raz w miesiącu.",
    },
  },
  digest: {
    subject: (n) =>
      plural("pl", n, {
        one: "Prośba czeka na twoje zatwierdzenie",
        few: `${n} prośby czekają na twoje zatwierdzenie`,
        many: `${n} próśb czeka na twoje zatwierdzenie`,
        other: `${n} prośby czeka na twoje zatwierdzenie`,
      }),
    preheader: "Prośby wygasają po 24 godzinach, a bez decyzji nic się nie wykona.",
    headline: (n) =>
      plural("pl", n, {
        one: "Prośba czeka na ciebie",
        few: `${n} prośby czekają na ciebie`,
        many: `${n} próśb czeka na ciebie`,
        other: `${n} prośby czeka na ciebie`,
      }),
    body: (n, org) => [
      "W przestrzeni roboczej ",
      { b: org },
      plural("pl", n, {
        one: " agent prosi o coś, co może zatwierdzić tylko człowiek.",
        other: " agenci proszą o rzeczy, które może zatwierdzić tylko człowiek.",
      }),
    ],
    age: (h) => `${h} h temu`,
    more: (k) => `I jeszcze ${k}.`,
    button: (n) => plural("pl", n, { one: "Zobacz prośbę", other: "Otwórz zatwierdzenia" }),
    why: (org, hours) =>
      `Otrzymujesz tę wiadomość, ponieważ możesz zatwierdzać te prośby w przestrzeni roboczej ${org}.${hours ? ` Przychodzi, gdy prośba czeka dłużej niż ${hours} godz., raz na każdą prośbę.` : ""}`,
    personal: {
      body: (n) =>
        plural("pl", n, {
          one: "Jeden z twoich agentów prosi o coś, co wymaga twojego zatwierdzenia.",
          other: "Twoi agenci proszą o rzeczy, które wymagają twojego zatwierdzenia.",
        }),
      why: (_org, hours) =>
        `Otrzymujesz tę wiadomość, ponieważ możesz zatwierdzać te prośby.${hours ? ` Przychodzi, gdy prośba czeka dłużej niż ${hours} godz., raz na każdą prośbę.` : ""}`,
    },
  },
  ready: {
    subject: "Komputer twoich agentów jest gotowy",
    preheader: {
      ai: "Dalej: połącz swoje AI, żeby agenci mogli myśleć.",
      task: "Dalej: daj agentom pierwsze zadanie.",
      create: "Dalej: utwórz pierwszego agenta.",
    },
    headline: "Komputer twoich agentów jest gotowy",
    computer: "Komputer twoich agentów",
    body: (org) => [
      "Dziękujemy za cierpliwość. Komputer przestrzeni roboczej ",
      { b: org },
      " jest włączony i skonfigurowany, z osobnym użytkownikiem dla każdego agenta. Działa dzień i noc, więc agenci mogą pracować o każdej porze.",
    ],
    facts: { cpus: "CPU", memory: "Pamięć", disk: "Dysk" },
    next: "Następne kroki",
    steps: {
      ai: [
        "Połącz swoje AI.",
        "Zaloguj się kontem z planem Claude lub ChatGPT albo z planem do programowania innego AI, lub podaj klucz API. To dzięki temu agenci myślą.",
      ],
      task: ["Daj pierwsze zadanie.", "Na kanale #general zawołaj agenta przez @ i napisz, czego potrzebujesz."],
      watch: [
        "Zobacz, jak pracują.",
        "Na stronie agenta kliknij Otwórz, żeby zobaczyć jego komputer na żywo. Przejmij kontrolę, kiedy chcesz, i oddaj ją, gdy skończysz.",
      ],
      create: ["Utwórz agenta.", "Od początku pracuje na tym komputerze."],
    },
    button: { ai: "Połącz swoje AI", task: "Daj pierwsze zadanie", create: "Utwórz agenta" },
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ jesteś właścicielem przestrzeni roboczej ${org} w agentes.chat. To jedyna wiadomość o tym komputerze.`,
    personal: {
      body: () =>
        "Dziękujemy za cierpliwość. Komputer twoich agentów jest włączony i skonfigurowany, z osobnym użytkownikiem dla każdego agenta. Działa dzień i noc, więc twoi agenci mogą pracować o każdej porze.",
      steps: {
        task: ["Daj pierwsze zadanie.", "Otwórz rozmowę z jednym ze swoich agentów i napisz, czego potrzebujesz."],
      },
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ ta przestrzeń robocza w agentes.chat należy do ciebie. To jedyna wiadomość o tym komputerze.",
    },
  },
  joinRequest: {
    subject: "Ktoś prosi o dołączenie do twojej przestrzeni roboczej",
    preheader: "Zatwierdź lub odrzuć w sekcji Członkowie. Nic się nie stanie, dopóki nie odpowiesz.",
    headline: "Prośba o dołączenie czeka",
    body: (org) => [
      "Ta osoba otworzyła link z zaproszeniem do przestrzeni roboczej ",
      { b: org },
      " i prosi o dołączenie.",
    ],
    note: "Zatwierdzaj tylko osoby, których się spodziewasz. Ta osoba dołączy jako członek, chyba że wybierzesz na stronie inną rolę.",
    approve: "Zatwierdź",
    deny: "Odrzuć",
    more: "Wszystkie oczekujące prośby znajdziesz w sekcji Członkowie.",
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ jesteś właścicielem lub administratorem przestrzeni roboczej ${org}. Przychodzi najwyżej raz na godzinę.`,
    personal: {
      body: () => "Ta osoba otworzyła link z zaproszeniem do twojej przestrzeni roboczej i prosi o dołączenie.",
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ decydujesz, kto dołącza do twojej przestrzeni roboczej. Przychodzi najwyżej raz na godzinę.",
    },
  },
  joinAnswer: {
    someone: "Ktoś",
    joined: {
      subject: "Twoja prośba o dołączenie została zatwierdzona",
      preheader: "Jesteś w środku. Otwórz przestrzeń roboczą i zaczynaj.",
      headline: "Jesteś w środku",
      body: (who, org, role) => [
        `${who} zatwierdza twoją prośbę. Jesteś teraz w przestrzeni roboczej `,
        { b: org },
        ` jako ${role}.`,
      ],
      button: "Otwórz przestrzeń roboczą",
    },
    invited: {
      subject: "Twoja prośba o dołączenie została zatwierdzona",
      preheader: "Został jeden krok: przyjmij zaproszenie w ciągu 7 dni.",
      headline: "Zatwierdzono: został jeden krok",
      body: (who, org) => [`${who} zatwierdza twoją prośbę o dołączenie do przestrzeni roboczej `, { b: org }, "."],
      next: "Przyjmij zaproszenie z tego adresu e-mail w ciągu 7 dni.",
      button: "Przyjmij zaproszenie",
    },
    denied: {
      subject: "Twoja prośba o dołączenie nie została zatwierdzona",
      preheader: "Ktoś z przestrzeni roboczej ją przejrzał i nie zatwierdził.",
      headline: "Twoja prośba nie została zatwierdzona",
      body: (org) => ["Ktoś z przestrzeni roboczej ", { b: org }, " przejrzał twoją prośbę i jej nie zatwierdził."],
      reason: (reason) => [{ b: "Wiadomość: " }, `„${reason}”`],
      small: "Jeśli to pomyłka, poproś kogoś z tej przestrzeni roboczej o zaproszenie e-mailem.",
    },
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ z tego adresu poproszono o dołączenie do przestrzeni roboczej ${org} w agentes.chat.`,
    personal: {
      joined: { body: (who) => `${who} zatwierdza twoją prośbę. Jesteś teraz w tej przestrzeni roboczej.` },
      invited: { body: (who) => `${who} zatwierdza twoją prośbę o dołączenie do tej przestrzeni roboczej.` },
      denied: {
        preheader: "Ta osoba ją przejrzała i nie zatwierdziła.",
        body: () => "Osoba, do której trafiła twoja prośba, przejrzała ją i nie zatwierdziła.",
        small: "Jeśli to pomyłka, poproś tę osobę o zaproszenie e-mailem.",
      },
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ z tego adresu poproszono o dołączenie do osobistej przestrzeni roboczej w agentes.chat.",
    },
  },
  joinCode: {
    subject: (code) => `${code} to twój kod do agentes.chat`,
    preheader: "Wpisz go na stronie, żeby poprosić o dołączenie. Działa przez 10 minut.",
    headline: "Twój kod",
    body: (org) => ["Wpisz ten kod na stronie, żeby poprosić o dołączenie do przestrzeni roboczej ", { b: org }, "."],
    small: ["Działa przez 10 minut. Jeśli to nie ty, ", { nobr: "zignoruj tę wiadomość." }],
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ ktoś wpisał ten adres, żeby poprosić o dołączenie do przestrzeni roboczej ${org} w agentes.chat.`,
    personal: {
      body: () => "Wpisz ten kod na stronie, żeby poprosić o dołączenie do tej przestrzeni roboczej.",
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ ktoś wpisał ten adres, żeby poprosić o dołączenie do osobistej przestrzeni roboczej w agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} to twój kod do usunięcia przestrzeni roboczej`,
    subjectAccount: (code) => `${code} to twój kod do usunięcia całego konta`,
    preheader: "Wpisz go w agentes.chat, żeby potwierdzić. Działa przez 10 minut.",
    headline: "Twój kod",
    workspace: (org) => [
      "Wpisz ten kod, żeby usunąć przestrzeń roboczą ",
      { b: org },
      ". Od razu stanie się dla wszystkich tylko do odczytu, a po 7 dniach zostanie usunięta na dobre.",
    ],
    account: (email) => [
      "Wpisz ten kod, żeby usunąć całe konto ",
      { b: email },
      ", a nie tylko jedną przestrzeń roboczą. Od razu zostanie wylogowane wszędzie i po 7 dniach usunięte na dobre, a razem z nim zamkną się przestrzenie robocze, w których jesteś tylko ty.",
    ],
    support: (address) => [
      "Działa przez 10 minut i bez niego nic nie zostanie usunięte. Jeśli to nie ty, nikomu go nie podawaj i napisz na ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Działa przez 10 minut i bez niego nic nie zostanie usunięte. Jeśli to nie ty, nikomu go nie podawaj i daj znać osobom, które prowadzą ten serwer.",
    whyWorkspace: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ z twojego konta poproszono o usunięcie przestrzeni roboczej ${org} w agentes.chat.`,
    whyAccount: "Otrzymujesz tę wiadomość, ponieważ z twojego konta poproszono o jego usunięcie w agentes.chat.",
    personal: {
      workspace: (org) => [
        "Wpisz ten kod, żeby usunąć swoją przestrzeń roboczą ",
        { b: org },
        ". Od razu stanie się tylko do odczytu, a po 7 dniach zostanie usunięta na dobre.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Przestrzeń robocza, w której jesteś, zostanie usunięta ${day}`,
    preheader: "Jest już tylko do odczytu. Do tego czasu właściciel może ją jeszcze przywrócić.",
    headline: "Przestrzeń robocza jest usuwana",
    body: (by, org, day, time) => [
      { b: by },
      " usuwa przestrzeń roboczą ",
      { b: org },
      `. Jest już tylko do odczytu i zniknie na dobre ${day} o ${time}.`,
    ],
    owner: "Zmiana planów? Przywróć ją przed tym terminem.",
    button: "Przywróć przestrzeń roboczą",
    member: "Jeśli to pomyłka, poproś właściciela o jej przywrócenie.",
    why: (org) => `Otrzymujesz tę wiadomość, ponieważ jesteś w przestrzeni roboczej ${org} w agentes.chat.`,
    personal: {
      member: "Jeśli to pomyłka, poproś osobę, która ją usunęła, o jej przywrócenie.",
      why: () => "Otrzymujesz tę wiadomość, ponieważ jesteś w tej przestrzeni roboczej w agentes.chat.",
    },
  },
  restored: {
    subject: "Przestrzeń robocza, w której jesteś, wróciła",
    preheader: "Właściciel ją przywrócił. Znów działa.",
    headline: "Przestrzeń robocza wróciła",
    body: (by, org) => [{ b: by }, " przywraca przestrzeń roboczą ", { b: org }, ". Znów działa."],
    button: "Otwórz przestrzeń roboczą",
    why: (org) => `Otrzymujesz tę wiadomość, ponieważ jesteś w przestrzeni roboczej ${org} w agentes.chat.`,
    personal: {
      why: () => "Otrzymujesz tę wiadomość, ponieważ jesteś w tej przestrzeni roboczej w agentes.chat.",
    },
  },
  appConnected: {
    subject: "Do twojego konta agentes.chat podłączono aplikację",
    preheader: "Może czytać i wysyłać zadania agentom w twoim imieniu w jednej przestrzeni roboczej.",
    headline: "Podłączono aplikację",
    body: (app, org) => [{ b: app }, " ma teraz dostęp do twojego konta w przestrzeni roboczej ", { b: org }, "."],
    note: "To nie ty? Odłącz ją teraz i zmień hasło.",
    button: "Zobacz podłączone aplikacje",
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ do twojego konta w przestrzeni roboczej ${org} w agentes.chat podłączono aplikację.`,
    personal: {
      body: (app) => [{ b: app }, " ma teraz dostęp do twojego konta w twojej osobistej przestrzeni roboczej."],
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ do twojego konta w twojej osobistej przestrzeni roboczej w agentes.chat podłączono aplikację.",
    },
  },
  accountDeleting: {
    subject: (day) => `Twoje konto agentes.chat zostanie usunięte ${day}`,
    preheader: "Masz 7 dni, żeby zmienić zdanie.",
    headline: "Twoje konto jest usuwane",
    body: (email, day, time) => [
      "Usuniemy konto ",
      { b: email },
      ` ${day} o ${time}. Zostało wylogowane wszędzie i nikt nie może się tu z tobą skontaktować, dopóki nie wrócisz.`,
    ],
    closes: (count, names) => [
      plural("pl", count, {
        one: "Przestrzeń robocza, w której nie było nikogo poza tobą, właśnie się zamknęła i zniknie tego samego dnia: ",
        other:
          "Przestrzenie robocze, w których nie było nikogo poza tobą, właśnie się zamknęły i znikną tego samego dnia: ",
      }),
      ...names,
      ".",
    ],
    undo: "Zmieniasz zdanie? Zaloguj się przed tą datą i naciśnij Przywróć.",
    button: "Zaloguj się, aby przywrócić",
    why: "Otrzymujesz tę wiadomość, ponieważ ten adres ma konto w agentes.chat.",
  },
  accountDeleted: {
    subject: "Twoje konto agentes.chat zostało usunięte",
    preheader: "Zostało wylogowane wszędzie i nie da się już na nie zalogować.",
    headline: "Twoje konto zostało usunięte",
    body: (email) => ["Usunęliśmy konto ", { b: email }, "."],
    closes: (count, day, names) => [
      plural("pl", count, {
        one: `Przestrzeń robocza, w której nie było nikogo poza tobą, jest zamknięta i zostanie usunięta na dobre ${day}: `,
        other: `Przestrzenie robocze, w których nie było nikogo poza tobą, są zamknięte i zostaną usunięte na dobre ${day}: `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Jeśli to nie ty, napisz na ", { mail: address }, "."],
    noSupport: "Jeśli to nie ty, daj znać osobom, które prowadzą ten serwer.",
    why: "Otrzymujesz tę wiadomość, ponieważ ten adres miał konto w agentes.chat.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agenci ${day}: zastoje ${stalls}, uruchomienia na próżno ${noise}`,
    preheader: "Gdzie agenci utknęli i gdzie działali na próżno, w porównaniu z 7 poprzednimi dniami.",
    headline: (day) => `Zastoje i szum ${day}`,
    body: "Każda aktywna przestrzeń robocza na tym serwerze, w dobie UTC. Tylko nazwy i liczby.",
    stalls: "Zastoje",
    noise: "Szum",
    metric: {
      mentionNoRun: "Wzmianki, które nikogo nie obudziły",
      readOnly: "Uruchomienia tylko do odczytu",
      promiseUnkept: "Zakończone z niedokończoną pracą",
      promiseIgnored: "Nadal niedokończone po przypomnieniu",
      handoffUnanswered: "Przekazania bez odpowiedzi w 30 min",
      limitStops: "Zatrzymane przez limit",
      personUnanswered: "Osoby bez odpowiedzi w 10 min",
      taskStartFailed: "Zadania nieudane na starcie",
      noiseRuns: "Uruchomienia na próżno",
      quietRuns: "Zakończone bez słowa",
      ackReplies: "Odpowiedzi na „dzięki” albo „ok”",
      idleWakes: "Wybudzone bez niczego do zrobienia",
      noiseTokens: "Ich tokeny",
      noiseCostNanoUsd: "Ich koszt",
    },
    value: (today, average) => `${today} · średnia z 7 dni ${average}`,
    topStalls: "Najwięcej zastojów",
    topNoise: "Najwięcej uruchomień na próżno, z kosztem",
    none: "Brak przestrzeni roboczych.",
    table: (day) => `Cała tabela: bun run report:autonomy --day ${day}`,
    why: "Otrzymujesz tę wiadomość, ponieważ ten adres jest w OPS_REPORT_EMAIL na tym serwerze. Przychodzi raz dziennie.",
  },
  planOpened: {
    subject: (plan) => `Więcej osób może rozmawiać z twoim agentem w ramach twojego planu ${plan}`,
    preheader: (plan) => `Ich rozmowy korzystają z twojego planu ${plan} i jego limitów.`,
    headline: "Więcej osób może rozmawiać z twoim agentem",
    body: (by, agent, plan) => [
      { b: by },
      " pozwolił(a) większej liczbie osób rozmawiać z ",
      { b: agent },
      `. Ich rozmowy korzystają z twojego planu ${plan} i jego limitów.`,
    ],
    agent: "Agent",
    by: "Zmienił(a)",
    was: "Wcześniej",
    now: "Teraz",
    everyone: "Wszyscy w workspace",
    onlyYou: "Tylko ty",
    you: "Ty",
    note: "Aby to cofnąć, zmień Kto może rozmawiać na stronie agenta.",
    button: "Zobacz, kto może rozmawiać",
    why: (org) =>
      `Otrzymujesz tę wiadomość, ponieważ twój agent w ${org} myśli w ramach twojego planu, a ktoś inny zmienił, kto może z nim rozmawiać.`,
    personal: {
      why: () =>
        "Otrzymujesz tę wiadomość, ponieważ twój agent myśli w ramach twojego planu, a ktoś inny zmienił, kto może z nim rozmawiać.",
    },
  },
  planLent: {
    subject: (plan) => `Twój plan ${plan} myśli teraz dla innego agenta`,
    preheader: (plan) => `Jego rozmowy korzystają z twojego planu ${plan} i jego limitów. Możesz go odebrać.`,
    headline: "Ktoś połączył twój plan z agentem",
    body: (by, agent, plan) => [
      { b: by },
      ` połączył(a) twój plan ${plan} z agentem `,
      { b: agent },
      ". Jego rozmowy korzystają z twojego planu i jego limitów.",
    ],
    agent: "Agent",
    by: "Połączone przez",
    plan: "Plan",
    note: "Odbierz go jednym kliknięciem w powiadomieniach, a agent przestanie myśleć z twoim planem.",
    button: "Otwórz powiadomienia",
    why: (org) => `Dostajesz ten e-mail, bo ktoś w ${org} połączył twój plan z agentem.`,
    personal: {
      why: () => "Dostajesz ten e-mail, bo w twojej przestrzeni roboczej połączono twój plan z agentem.",
    },
  },
  planWaiting: {
    subject: "Twój zespół czeka",
    preheader: "Twoja przestrzeń robocza jest gotowa. Do startu potrzebny jest plan agentes.chat.",
    headline: "Twój zespół czeka",
    body: (agents, channels, routines) => {
      const a = plural("pl", agents, {
        one: `1 agent`,
        few: `${agents} agenci`,
        many: `${agents} agentów`,
        other: `${agents} agenta`,
      });
      const c = plural("pl", channels, {
        one: `1 kanał`,
        few: `${channels} kanały`,
        many: `${channels} kanałów`,
        other: `${channels} kanału`,
      });
      const r = plural("pl", routines, {
        one: `1 rutyna`,
        few: `${routines} rutyny`,
        many: `${routines} rutyn`,
        other: `${routines} rutyny`,
      });
      return routines > 0
        ? `Gotowe: ${a}, ${c} i ${r}. Do startu potrzebny jest plan agentes.chat.`
        : `Gotowe: ${a} i ${c}. Do startu potrzebny jest plan agentes.chat.`;
    },
    button: "Zobacz plany agentes.chat",
    why: (org) => `Ten e-mail przyszedł, bo prowadzisz ${org} w agentes.chat. Wysyłamy tylko dwa takie powiadomienia.`,
    personal: {
      subject: "Twoi agenci czekają",
      headline: "Twoi agenci czekają",
      body: (agents, _channels, routines) => {
        const a = plural("pl", agents, {
          one: `1 agent`,
          few: `${agents} agenci`,
          many: `${agents} agentów`,
          other: `${agents} agenta`,
        });
        const r = plural("pl", routines, {
          one: `1 rutyna`,
          few: `${routines} rutyny`,
          many: `${routines} rutyn`,
          other: `${routines} rutyny`,
        });
        return `Gotowe: ${routines > 0 ? `${a} i ${r}` : a}. Brakuje tylko planu agentes.chat.`;
      },
      why: () =>
        "Ten e-mail przyszedł, bo ta przestrzeń robocza w agentes.chat należy do ciebie. Wysyłamy tylko dwa takie powiadomienia.",
    },
  },
};
