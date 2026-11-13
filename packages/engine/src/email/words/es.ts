import { plural } from "@agenteschat/i18n/format";
import { atHost } from "./en";
import type { EmailWords } from "./index";

/**
 * The emails in es: whatever is here replaces English, word group by word group (`deepMerge`); write a count's
 * forms with `plural("es", n, { one, few, many, other })` from `@agenteschat/i18n/format`.
 */
export const words: EmailWords = {
  sentBy: (host) =>
    host ? atHost("Enviado por el servidor de agentes.chat", "en", host) : "Enviado por agentes.chat.",
  fallback: "¿El botón no funciona? Copia esta dirección en tu navegador:",
  role: { owner: "propietario", member: "miembro" },
  anAgent: "Un agente",
  someone: "Alguien",
  verify: {
    subject: "Confirma tu correo en agentes.chat",
    preheader: "Un clic para confirmar esta dirección. El enlace es válido por una hora.",
    headline: "Confirma tu correo",
    body: "Solo falta un paso: confirmar que esta dirección es tuya.",
    button: "Confirmar correo",
    small: "El enlace es válido por una hora. Si no te registraste, puedes ignorar este correo.",
    why: "Recibiste este correo porque esta dirección se usó para registrarse en agentes.chat.",
  },
  reset: {
    subject: "Restablece tu contraseña de agentes.chat",
    preheader: "Elige una contraseña nueva. El enlace es válido por una hora.",
    headline: "Elige una contraseña nueva",
    body: "Recibimos una solicitud para restablecer la contraseña de esta dirección.",
    button: "Elegir una contraseña nueva",
    note: "¿No lo pediste? Ignora este correo. Tu contraseña sigue igual.",
    small: "El enlace es válido por una hora.",
    why: "Recibiste este correo porque alguien pidió restablecer la contraseña de esta dirección en agentes.chat.",
  },
  invitation: {
    subject: "Te invitaron a un espacio de trabajo en agentes.chat",
    preheader: "Acepta en un plazo de 7 días, con esta dirección de correo.",
    headline: "Te invitaron a un espacio de trabajo",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} te invitó a unirte a `, { b: org }, ` como ${role}.`]
        : ["Te invitaron a unirte a ", { b: org }, ` como ${role}.`],
    what: "agentes.chat es donde personas y agentes de IA trabajan juntos.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Su nota: " }, `“${note}”`],
    button: "Aceptar invitación",
    small: "La invitación es válida por 7 días. Acéptala con esta dirección de correo.",
    why: (org) =>
      `Recibiste este correo porque alguien de ${org} invitó a esta dirección. Si no sabes quién es, ignóralo. No pasa nada hasta que aceptes.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [
              { b: inviter },
              `${email ? ` (${email})` : ""} te invitó a su espacio de trabajo personal en agentes.chat.`,
            ]
          : "Te invitaron a un espacio de trabajo personal en agentes.chat.",
      why: () =>
        "Recibiste este correo porque alguien invitó a esta dirección a su espacio de trabajo personal. Si no sabes quién es, ignóralo. No pasa nada hasta que aceptes.",
    },
  },
  inviteRequest: {
    subject: "Alguien pidió una invitación nueva",
    preheader: "Su invitación venció. Puedes enviar una nueva desde Miembros.",
    headline: "Alguien pidió una invitación nueva",
    body: (email, org) =>
      email
        ? [{ b: email }, " abrió una invitación vencida a ", { b: org }, " y pidió una nueva."]
        : ["Alguien con un enlace de invitación vencido a ", { b: org }, " pidió una invitación nueva."],
    next: "Si esperas a esa persona, envíale una invitación nueva desde Miembros. Si no, no tienes que hacer nada.",
    button: "Abrir Miembros",
    why: (org) => `Recibiste este correo porque creaste esta invitación o administras los miembros de ${org}.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " abrió una invitación vencida a tu espacio de trabajo y pidió una nueva."]
          : "Alguien con un enlace de invitación vencido a tu espacio de trabajo pidió una invitación nueva.",
      why: () =>
        "Recibiste este correo porque creaste esta invitación o te ocupas de quién está en tu espacio de trabajo.",
    },
  },
  calendar: {
    subject: "Te invitaron a un evento",
    preheader: (when) => `${when}. Míralo en el calendario.`,
    headline: "Te invitaron a un evento",
    facts: { event: "Evento", when: "Cuándo", org: "Espacio de trabajo", by: "Te invitó" },
    someone: "Alguien",
    button: "Ver el evento",
    why: (org) => `Recibiste este correo porque alguien de ${org} te invitó a un evento.`,
    personal: {
      why: () => "Recibiste este correo porque alguien de tu espacio de trabajo te invitó a un evento.",
    },
  },
  waitlist: {
    subject: "Confirma tu lugar en la lista de espera de agentes.chat",
    preheader: "Un clic y tu lugar queda reservado.",
    headline: "Confirma tu lugar en la lista",
    body: (email) =>
      email
        ? ["Recibimos una solicitud para agregar ", { b: email }, " a la lista de espera de agentes.chat."]
        : "Recibimos una solicitud para agregar esta dirección a la lista de espera de agentes.chat.",
    approve: "Aquí no pasa nada importante sin que una persona lo apruebe. Eso también vale para esta solicitud.",
    button: "Confirmar mi correo",
    small:
      "El enlace es válido por 48 horas. ¿No fuiste tú? Ignora este correo. Sin el clic, la dirección nunca entra en la lista.",
    why: "Recibiste este correo porque esta dirección se anotó en la lista de espera de agentes.chat.",
  },
  earlyAccess: {
    subject: "Llegó tu invitación a agentes.chat",
    preheader: (days) => `Crea tu cuenta en un plazo de ${days} días, con esta dirección de correo.`,
    headline: "Tu acceso está listo",
    body: (email) => [{ b: email }, " ya puede crear una cuenta y un espacio de trabajo en agentes.chat."],
    what: "agentes.chat es donde personas y agentes de IA trabajan juntos.",
    button: "Crear mi cuenta",
    small: (days) =>
      `El enlace es válido por ${days} días, solo para esta dirección. Regístrate con una contraseña, o con Google, GitHub o Apple en esta misma dirección.`,
    why: "Recibiste este correo porque esta dirección está en la lista de espera de agentes.chat, o recibió una invitación a agentes.chat. No pasa nada hasta que te registres.",
  },
  earlyAccessAllowed: {
    subject: "Ya puedes crear tu propio espacio de trabajo",
    preheader: "Inicia sesión con la cuenta que ya tienes y configúralo.",
    headline: "Crea tu propio espacio de trabajo",
    body: (email) => [
      "Ya puedes crear tu propio espacio de trabajo en agentes.chat con ",
      { b: email },
      ", la cuenta que ya tienes.",
    ],
    button: "Crear mi espacio de trabajo",
    why: "Recibiste este correo porque esta cuenta recibió acceso anticipado a agentes.chat.",
  },
  budget: {
    subject: {
      warning: "Un agente superó el 80 % de su presupuesto mensual",
      exhausted: "Un agente se detuvo: llegó a su presupuesto mensual",
    },
    preheader: {
      warning: "Al 100 % se detiene hasta el próximo mes o hasta que suba el límite.",
      exhausted: "No responderá hasta el próximo mes o hasta que suba el límite.",
    },
    headline: {
      warning: "Un agente superó el 80 % de su presupuesto",
      exhausted: "Un agente llegó a su presupuesto",
    },
    used: (pct, org) => `Usó ${pct} del presupuesto de este mes · ${org}`,
    warning: "Al 100 % se detiene y lo avisa en el canal. Un admin puede cambiar el límite en la página del agente.",
    exhausted: "No responderá hasta el próximo mes, o hasta que un admin suba el límite.",
    button: "Ver el presupuesto",
    why: (org) =>
      `Recibiste este correo porque este agente es tuyo, o eres admin de ${org}. Se envía al 80 % y al 100 %, una vez al mes cada uno.`,
    personal: {
      warning: "Al 100 % se detiene y te avisa. Puedes cambiar el límite en la página del agente.",
      exhausted: "No responderá hasta el próximo mes, o hasta que subas el límite en la página del agente.",
      why: () =>
        "Recibiste este correo porque este agente es tuyo. Se envía al 80 % y al 100 %, una vez al mes cada uno.",
    },
  },
  digest: {
    subject: (n) =>
      plural("es", n, {
        one: "Una solicitud espera tu aprobación",
        other: `${n} solicitudes esperan tu aprobación`,
      }),
    preheader: "Las solicitudes vencen en 24 horas, y nada se ejecuta sin una decisión.",
    headline: (n) => plural("es", n, { one: "Una solicitud te espera", other: `${n} solicitudes te esperan` }),
    body: (n, org) => [
      "En ",
      { b: org },
      plural("es", n, {
        one: ", un agente pidió hacer algo que solo una persona puede aprobar.",
        other: ", los agentes pidieron hacer cosas que solo una persona puede aprobar.",
      }),
    ],
    age: (h) => `hace ${h} h`,
    more: (k) => `Y ${k} más.`,
    button: (n) => plural("es", n, { one: "Revisar la solicitud", other: "Abrir aprobaciones" }),
    why: (org, hours) =>
      `Recibiste este correo porque puedes aprobar estas solicitudes en ${org}.${hours ? ` Se envía cuando una solicitud espera más de ${hours} horas, una vez por solicitud.` : ""}`,
    personal: {
      body: (n) =>
        plural("es", n, {
          one: "Uno de tus agentes pidió hacer algo que necesita tu aprobación.",
          other: "Tus agentes pidieron hacer cosas que necesitan tu aprobación.",
        }),
      why: (_org, hours) =>
        `Recibiste este correo porque puedes aprobar estas solicitudes.${hours ? ` Se envía cuando una solicitud espera más de ${hours} horas, una vez por solicitud.` : ""}`,
    },
  },
  ready: {
    subject: "La computadora de tus agentes está lista",
    preheader: {
      ai: "Lo siguiente: conecta tu IA, para que tus agentes puedan pensar.",
      task: "Lo siguiente: dale a tus agentes una primera tarea.",
      create: "Lo siguiente: crea tu primer agente.",
    },
    headline: "La computadora de tus agentes está lista",
    computer: "La computadora de tus agentes",
    body: (org) => [
      "Gracias por esperar. La computadora de ",
      { b: org },
      " ya está encendida y configurada, con un usuario propio para cada agente. Queda encendida día y noche, para que tus agentes puedan trabajar a cualquier hora.",
    ],
    facts: { cpus: "CPU", memory: "Memoria", disk: "Disco" },
    next: "Próximos pasos",
    steps: {
      ai: [
        "Conecta tu IA.",
        "Inicia sesión con tu plan de Claude o ChatGPT, el plan de programación de otra IA, o una clave de API. Tus agentes piensan con ella.",
      ],
      task: ["Da una primera tarea.", "En #general, llama a un agente con @ y di lo que necesitas."],
      watch: [
        "Míralos trabajar.",
        "En la página de un agente, haz clic en Abrir para ver su computadora en vivo. Toma el control cuando quieras, y devuélvelo cuando termines.",
      ],
      create: ["Crea un agente.", "Trabaja en esta computadora desde el primer momento."],
    },
    button: { ai: "Conectar tu IA", task: "Dar una primera tarea", create: "Crear un agente" },
    why: (org) =>
      `Recibiste este correo porque eres propietario de ${org} en agentes.chat. Es el único correo sobre esta computadora.`,
    personal: {
      body: () =>
        "Gracias por esperar. La computadora de tus agentes ya está encendida y configurada, con un usuario propio para cada agente. Queda encendida día y noche, para que tus agentes puedan trabajar a cualquier hora.",
      steps: {
        task: ["Da una primera tarea.", "Abre una conversación con uno de tus agentes y di lo que necesitas."],
      },
      why: () =>
        "Recibiste este correo porque este espacio de trabajo en agentes.chat es tuyo. Es el único correo sobre esta computadora.",
    },
  },
  joinRequest: {
    subject: "Alguien pide unirse a tu espacio de trabajo",
    preheader: "Apruébala o recházala en Miembros. No pasa nada hasta que respondas.",
    headline: "Una solicitud para unirse te espera",
    body: (org) => ["Esta persona abrió el enlace de invitación de ", { b: org }, " y pidió unirse."],
    note: "Aprueba solo a quienes esperas. Entran como miembro, salvo que elijas otro rol en la página.",
    approve: "Aprobar",
    deny: "Rechazar",
    more: "Todas las solicitudes pendientes están en Miembros.",
    why: (org) =>
      `Recibiste este correo porque eres propietario o admin de ${org}. Se envía como máximo una vez por hora.`,
    personal: {
      body: () => "Esta persona abrió el enlace de invitación de tu espacio de trabajo y pidió unirse.",
      why: () =>
        "Recibiste este correo porque te ocupas de quién se une a tu espacio de trabajo. Se envía como máximo una vez por hora.",
    },
  },
  joinAnswer: {
    someone: "Alguien",
    joined: {
      subject: "Se aprobó tu solicitud para unirte",
      preheader: "Ya estás dentro. Abre el espacio de trabajo para empezar.",
      headline: "Ya estás dentro",
      body: (who, org, role) => [`${who} aprobó tu solicitud. Te uniste a `, { b: org }, ` como ${role}.`],
      button: "Abrir el espacio de trabajo",
    },
    invited: {
      subject: "Se aprobó tu solicitud para unirte",
      preheader: "Solo falta un paso: acepta la invitación en un plazo de 7 días.",
      headline: "Aprobada: solo falta un paso",
      body: (who, org) => [`${who} aprobó tu solicitud para unirte a `, { b: org }, "."],
      next: "Acepta la invitación con esta dirección de correo en un plazo de 7 días.",
      button: "Aceptar invitación",
    },
    denied: {
      subject: "No se aprobó tu solicitud para unirte",
      preheader: "Alguien del espacio de trabajo la revisó y no la aprobó.",
      headline: "Tu solicitud no se aprobó",
      body: (org) => ["Alguien de ", { b: org }, " revisó tu solicitud y no la aprobó."],
      reason: (reason) => [{ b: "Su nota: " }, `“${reason}”`],
      small: "Si crees que es un error, pídele a alguien de ahí que te invite por correo.",
    },
    why: (org) => `Recibiste este correo porque esta dirección pidió unirse a ${org} en agentes.chat.`,
    personal: {
      joined: { body: (who) => `${who} aprobó tu solicitud. Ya estás en su espacio de trabajo.` },
      invited: { body: (who) => `${who} aprobó tu solicitud para unirte a su espacio de trabajo.` },
      denied: {
        preheader: "Esa persona la revisó y no la aprobó.",
        body: () => "La persona a quien se lo pediste revisó tu solicitud y no la aprobó.",
        small: "Si crees que es un error, pídele que te invite por correo.",
      },
      why: () =>
        "Recibiste este correo porque esta dirección pidió unirse a un espacio de trabajo personal en agentes.chat.",
    },
  },
  joinCode: {
    subject: (code) => `${code} es tu código de agentes.chat`,
    preheader: "Escríbelo en la página para pedir unirte. Es válido por 10 minutos.",
    headline: "Tu código",
    body: (org) => ["Escribe este código en la página para pedir unirte a ", { b: org }, "."],
    small: ["Es válido por 10 minutos. Si no lo pediste, ", { nobr: "ignora este correo." }],
    why: (org) =>
      `Recibiste este correo porque alguien escribió esta dirección para pedir unirse a ${org} en agentes.chat.`,
    personal: {
      body: () => "Escribe este código en la página para pedir unirte a este espacio de trabajo.",
      why: () =>
        "Recibiste este correo porque alguien escribió esta dirección para pedir unirse a un espacio de trabajo personal en agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} es tu código para eliminar un espacio de trabajo`,
    subjectAccount: (code) => `${code} es tu código para eliminar toda tu cuenta`,
    preheader: "Escríbelo en agentes.chat para confirmar. Es válido por 10 minutos.",
    headline: "Tu código",
    workspace: (org) => [
      "Escribe este código para eliminar el espacio de trabajo ",
      { b: org },
      ". Queda en solo lectura para todos al instante y se elimina para siempre 7 días después.",
    ],
    account: (email) => [
      "Escribe este código para eliminar toda la cuenta ",
      { b: email },
      ", no solo un espacio de trabajo. Se cierra la sesión en todas partes al instante y se elimina para siempre 7 días después, y los espacios de trabajo donde solo estás tú se cierran con ella.",
    ],
    support: (address) => [
      "Es válido por 10 minutos, y no se elimina nada sin él. Si no fuiste tú, no lo compartas y escribe a ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Es válido por 10 minutos, y no se elimina nada sin él. Si no fuiste tú, no lo compartas y avisa a quienes administran este servidor.",
    whyWorkspace: (org) => `Recibiste este correo porque tu cuenta pidió eliminar ${org} en agentes.chat.`,
    whyAccount: "Recibiste este correo porque tu cuenta pidió eliminarse de agentes.chat.",
    personal: {
      workspace: (org) => [
        "Escribe este código para eliminar tu espacio de trabajo ",
        { b: org },
        ". Queda en solo lectura al instante y se elimina para siempre 7 días después.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Un espacio de trabajo del que formas parte se eliminará el ${day}`,
    preheader: "Ya está en solo lectura. Un propietario aún puede restaurarlo hasta entonces.",
    headline: "Se está eliminando un espacio de trabajo",
    body: (by, org, day, time) => [
      { b: by },
      " eliminó el espacio de trabajo ",
      { b: org },
      `. Ya está en solo lectura y se elimina para siempre el ${day} a las ${time}.`,
    ],
    owner: "¿Cambiaste de opinión? Restáuralo antes de esa fecha.",
    button: "Restaurar el espacio de trabajo",
    member: "Si es un error, pídele a un propietario que lo restaure.",
    why: (org) => `Recibiste este correo porque formas parte de ${org} en agentes.chat.`,
    personal: {
      member: "Si es un error, pídele a quien lo eliminó que lo restaure.",
      why: () => "Recibiste este correo porque formas parte de este espacio de trabajo en agentes.chat.",
    },
  },
  restored: {
    subject: "Volvió un espacio de trabajo del que formas parte",
    preheader: "Un propietario lo restauró. Funciona de nuevo.",
    headline: "El espacio de trabajo volvió",
    body: (by, org) => [{ b: by }, " restauró ", { b: org }, ". Funciona de nuevo."],
    button: "Abrir el espacio de trabajo",
    why: (org) => `Recibiste este correo porque formas parte de ${org} en agentes.chat.`,
    personal: {
      why: () => "Recibiste este correo porque formas parte de este espacio de trabajo en agentes.chat.",
    },
  },
  appConnected: {
    subject: "Se conectó una app a tu cuenta de agentes.chat",
    preheader: "Puede leer y enviar tareas a los agentes en tu nombre en un espacio de trabajo.",
    headline: "Se conectó una app",
    body: (app, org) => [{ b: app }, " ahora tiene acceso a tu cuenta en ", { b: org }, "."],
    note: "¿No la conectaste tú? Desconéctala ahora y cambia tu contraseña.",
    button: "Ver apps conectadas",
    why: (org) => `Recibiste este correo porque se conectó una app a tu cuenta en ${org} en agentes.chat.`,
    personal: {
      body: (app) => [{ b: app }, " ahora tiene acceso a tu cuenta en tu espacio de trabajo personal."],
      why: () =>
        "Recibiste este correo porque se conectó una app a tu cuenta en tu espacio de trabajo personal en agentes.chat.",
    },
  },
  accountDeleting: {
    subject: (day) => `Tu cuenta de agentes.chat se eliminará el ${day}`,
    preheader: "Tienes 7 días para cambiar de opinión.",
    headline: "Tu cuenta se está eliminando",
    body: (email, day, time) => [
      "Eliminaremos la cuenta ",
      { b: email },
      ` el ${day} a las ${time}. Se cerró la sesión en todas partes y nadie puede contactarte aquí hasta que vuelvas.`,
    ],
    closes: (count, names) => [
      plural("es", count, {
        one: "El espacio de trabajo donde solo estabas tú se cerró ahora y se elimina en la misma fecha: ",
        other: "Los espacios de trabajo donde solo estabas tú se cerraron ahora y se eliminan en la misma fecha: ",
      }),
      ...names,
      ".",
    ],
    undo: "¿Cambiaste de opinión? Inicia sesión antes de esa fecha y pulsa Restaurar.",
    button: "Iniciar sesión para restaurar",
    why: "Recibiste este correo porque esta dirección tiene una cuenta en agentes.chat.",
  },
  accountDeleted: {
    subject: "Se eliminó tu cuenta de agentes.chat",
    preheader: "Se cerró la sesión en todas partes y ya no se puede volver a iniciar sesión.",
    headline: "Se eliminó tu cuenta",
    body: (email) => ["Eliminamos la cuenta ", { b: email }, "."],
    closes: (count, day, names) => [
      plural("es", count, {
        one: `El espacio de trabajo donde solo estabas tú está cerrado y se eliminará para siempre el ${day}: `,
        other: `Los espacios de trabajo donde solo estabas tú están cerrados y se eliminarán para siempre el ${day}: `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Si no fuiste tú, escribe a ", { mail: address }, "."],
    noSupport: "Si no fuiste tú, avisa a quienes administran este servidor.",
    why: "Recibiste este correo porque esta dirección tenía una cuenta en agentes.chat.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agentes el ${day}: ${stalls} atascos, ${noise} ejecuciones inútiles`,
    preheader: "Dónde se detuvieron los agentes y dónde actuaron para nada, frente a los 7 días anteriores.",
    headline: (day) => `Atascos y ruido el ${day}`,
    body: "Cada espacio de trabajo activo en este servidor, durante el día UTC. Solo nombres y cifras.",
    stalls: "Atascos",
    noise: "Ruido",
    metric: {
      mentionNoRun: "Menciones que no despertaron a nadie",
      readOnly: "Ejecuciones que solo podían leer",
      promiseUnkept: "Terminaron con trabajo pendiente",
      promiseIgnored: "Aún pendiente tras el recordatorio",
      handoffUnanswered: "Traspasos sin respuesta en 30 min",
      limitStops: "Detenidas por un límite",
      personUnanswered: "Personas sin respuesta en 10 min",
      taskStartFailed: "Tareas que fallaron al empezar",
      noiseRuns: "Ejecuciones para nada",
      quietRuns: "Terminaron sin decir nada",
      ackReplies: "Respondieron a un gracias o un ok",
      idleWakes: "Despertados sin nada que hacer",
      noiseTokens: "Sus tokens",
      noiseCostNanoUsd: "Su costo",
    },
    value: (today, average) => `${today} · promedio de 7 días ${average}`,
    topStalls: "Más atascos",
    topNoise: "Más ejecuciones para nada, con su costo",
    none: "Ningún espacio de trabajo.",
    table: (day) => `La tabla completa: bun run report:autonomy --day ${day}`,
    why: "Recibiste este correo porque esta dirección está en OPS_REPORT_EMAIL en este servidor. Se envía una vez al día.",
  },
  planOpened: {
    subject: (plan) => `Más personas pueden hablar con tu agente con tu plan de ${plan}`,
    preheader: (plan) => `Sus conversaciones usan tu plan de ${plan} y sus límites.`,
    headline: "Más personas pueden hablar con tu agente",
    body: (by, agent, plan) => [
      { b: by },
      " dejó que más personas hablen con ",
      { b: agent },
      `. Sus conversaciones usan tu plan de ${plan} y sus límites.`,
    ],
    agent: "Agente",
    by: "Cambiado por",
    was: "Antes",
    now: "Ahora",
    everyone: "Todos en el workspace",
    onlyYou: "Solo tú",
    you: "Tú",
    note: "Para deshacerlo, cambia Quién puede hablar en la página del agente.",
    button: "Ver quién puede hablar",
    why: (org) =>
      `Recibiste este correo porque un agente tuyo en ${org} piensa con tu plan y otra persona cambió quién puede hablar con él.`,
    personal: {
      why: () =>
        "Recibiste este correo porque un agente tuyo piensa con tu plan y otra persona cambió quién puede hablar con él.",
    },
  },
  planLent: {
    subject: (plan) => `Tu plan de ${plan} ahora piensa por otro agente`,
    preheader: (plan) => `Sus conversaciones usan tu plan de ${plan} y sus límites. Puedes recuperarlo.`,
    headline: "Alguien conectó tu plan a un agente",
    body: (by, agent, plan) => [
      { b: by },
      ` conectó tu plan de ${plan} al agente `,
      { b: agent },
      ". Sus conversaciones usan tu plan y sus límites.",
    ],
    agent: "Agente",
    by: "Conectado por",
    plan: "Plan",
    note: "Recupéralo con un clic desde tus notificaciones, y el agente deja de pensar con tu plan.",
    button: "Abrir notificaciones",
    why: (org) => `Recibiste este correo porque alguien en ${org} conectó tu plan a un agente.`,
    personal: {
      why: () => "Recibiste este correo porque alguien de tu espacio de trabajo conectó tu plan a un agente.",
    },
  },
  planWaiting: {
    subject: "Tu equipo está esperando",
    preheader: "Tu espacio de trabajo está listo. Falta un plan de agentes.chat para empezar.",
    headline: "Tu equipo está esperando",
    body: (agents, channels, routines) => {
      const a = plural("es", agents, { one: `1 agente`, other: `${agents} agentes` });
      const c = plural("es", channels, { one: `1 canal`, other: `${channels} canales` });
      const r = plural("es", routines, { one: `1 rutina`, other: `${routines} rutinas` });
      return routines > 0
        ? `${a}, ${c} y ${r} están listos. Falta un plan de agentes.chat para que empiecen.`
        : `${a} y ${c} están listos. Falta un plan de agentes.chat para que empiecen.`;
    },
    button: "Ver planes de agentes.chat",
    why: (org) =>
      `Recibiste este correo porque administras ${org} en agentes.chat. Solo enviamos dos avisos como este.`,
    personal: {
      subject: "Tus agentes están esperando",
      headline: "Tus agentes están esperando",
      body: (agents, _channels, routines) => {
        const a = plural("es", agents, { one: `1 agente`, other: `${agents} agentes` });
        const r = plural("es", routines, { one: `1 rutina`, other: `${routines} rutinas` });
        return `Todo listo: ${routines > 0 ? `${a} y ${r}` : a}. Solo falta un plan de agentes.chat.`;
      },
      why: () =>
        "Recibiste este correo porque este espacio de trabajo en agentes.chat es tuyo. Solo enviamos dos avisos como este.",
    },
  },
};
