import { plural } from "@agenteschat/i18n/format";
import { atHost, type Words } from "./en";

export const ptBR: Words = {
  sentBy: (host) => (host ? atHost("Enviado pelo servidor do agentes.chat", "em", host) : "Enviado pelo agentes.chat."),
  fallback: "O botão não funcionou? Copie e cole este endereço no navegador:",
  role: { owner: "dono", member: "membro" },
  anAgent: "Um agente",
  someone: "Alguém",
  verify: {
    subject: "Confirme seu e-mail no agentes.chat",
    preheader: "Um clique para confirmar este endereço. O link vale por uma hora.",
    headline: "Confirme seu e-mail",
    body: "Falta um passo: confirmar que este endereço é seu.",
    button: "Confirmar e-mail",
    small: "O link vale por uma hora. Se não foi você que se cadastrou, pode ignorar este e-mail.",
    why: "Você recebeu este e-mail porque este endereço foi usado para criar uma conta no agentes.chat.",
  },
  reset: {
    subject: "Redefina sua senha do agentes.chat",
    preheader: "Escolha uma senha nova. O link vale por uma hora.",
    headline: "Escolha uma senha nova",
    body: "Recebemos um pedido para redefinir a senha deste endereço.",
    button: "Escolher senha nova",
    note: "Não pediu isso? Ignore este e-mail. Sua senha continua a mesma.",
    small: "O link vale por uma hora.",
    why: "Você recebeu este e-mail porque alguém pediu para redefinir a senha deste endereço no agentes.chat.",
  },
  invitation: {
    subject: "Você recebeu um convite para um workspace no agentes.chat",
    preheader: "Aceite em até 7 dias, com este endereço de e-mail.",
    headline: "Você recebeu um convite",
    body: (inviter, email, org, role) =>
      inviter
        ? [{ b: inviter }, `${email ? ` (${email})` : ""} convidou você para entrar na `, { b: org }, ` como ${role}.`]
        : ["Você recebeu um convite para entrar na ", { b: org }, ` como ${role}.`],
    what: "O agentes.chat é onde pessoas e agentes de IA trabalham juntos.",
    noteFrom: (inviter, note) => [{ b: inviter ? `${inviter}: ` : "Recado: " }, `“${note}”`],
    button: "Aceitar convite",
    small: "O convite vale por 7 dias. Aceite com este endereço de e-mail.",
    why: (org) =>
      `Você recebeu este e-mail porque alguém da ${org} convidou este endereço. Se não conhece essa pessoa, ignore. Nada acontece até você aceitar.`,
    personal: {
      body: (inviter, email) =>
        inviter
          ? [{ b: inviter }, `${email ? ` (${email})` : ""} convidou você para um workspace pessoal no agentes.chat.`]
          : "Você recebeu um convite para um workspace pessoal no agentes.chat.",
      why: () =>
        "Você recebeu este e-mail porque alguém convidou este endereço para um workspace pessoal. Se não conhece essa pessoa, ignore. Nada acontece até você aceitar.",
    },
  },
  inviteRequest: {
    subject: "Pediram um novo convite",
    preheader: "O convite expirou. Dá para mandar um novo em Membros.",
    headline: "Pediram um novo convite",
    body: (email, org) =>
      email
        ? [{ b: email }, " abriu um convite vencido da ", { b: org }, " e pediu um novo."]
        : ["Alguém com um link de convite vencido da ", { b: org }, " pediu um novo."],
    next: "Se você espera essa pessoa, mande um novo convite em Membros. Se não, não precisa fazer nada.",
    button: "Abrir Membros",
    why: (org) => `Você recebeu este e-mail porque criou este convite, ou cuida dos membros da ${org}.`,
    personal: {
      body: (email) =>
        email
          ? [{ b: email }, " abriu um convite vencido para o seu workspace e pediu um novo."]
          : "Alguém com um link de convite vencido para o seu workspace pediu um novo.",
      why: () => "Você recebeu este e-mail porque criou este convite, ou cuida de quem está no seu workspace.",
    },
  },
  calendar: {
    subject: "Você recebeu um convite para um evento",
    preheader: (when) => `${when}. Veja no calendário.`,
    headline: "Convite para um evento",
    facts: { event: "Evento", when: "Quando", org: "Workspace", by: "Convite de" },
    someone: "Alguém",
    button: "Ver o evento",
    why: (org) => `Você recebeu este e-mail porque alguém da ${org} convidou você para um evento.`,
    personal: {
      why: () => "Você recebeu este e-mail porque alguém do seu workspace convidou você para um evento.",
    },
  },
  waitlist: {
    subject: "Confirme seu lugar na lista do agentes.chat",
    preheader: "Um clique e seu lugar está guardado.",
    headline: "Confirme seu lugar na lista",
    body: (email) =>
      email
        ? ["Recebemos um pedido para colocar ", { b: email }, " na lista de espera do agentes.chat."]
        : "Recebemos um pedido para colocar este endereço na lista de espera do agentes.chat.",
    approve: "Aqui, nada importante acontece sem uma pessoa aprovar. Isso vale para este pedido também.",
    button: "Confirmar meu e-mail",
    small: "O link vale por 48 horas. Não foi você? Ignore este e-mail. Sem o clique, o endereço não entra na lista.",
    why: "Você recebeu este e-mail porque este endereço foi informado na lista de espera do agentes.chat.",
  },
  earlyAccess: {
    subject: "Seu convite para o agentes.chat chegou",
    preheader: (days) => `Crie sua conta em até ${days} dias, com este endereço de e-mail.`,
    headline: "Seu acesso está pronto",
    body: (email) => [{ b: email }, " já pode criar uma conta e um workspace no agentes.chat."],
    what: "O agentes.chat é onde pessoas e agentes de IA trabalham juntos.",
    button: "Criar minha conta",
    small: (days) =>
      `O link vale por ${days} dias, só para este endereço. Cadastre-se com uma senha, ou com Google, GitHub ou Apple neste mesmo endereço.`,
    why: "Você recebeu este e-mail porque este endereço está na lista de espera do agentes.chat, ou foi convidado para o agentes.chat. Nada acontece até você se cadastrar.",
  },
  earlyAccessAllowed: {
    subject: "Agora você pode criar o seu workspace",
    preheader: "Entre com a conta que você já tem e monte o seu.",
    headline: "Crie o seu workspace",
    body: (email) => [
      "Agora você pode criar o seu workspace no agentes.chat com ",
      { b: email },
      ", a conta que você já tem.",
    ],
    button: "Criar meu workspace",
    why: "Você recebeu este e-mail porque esta conta ganhou acesso antecipado ao agentes.chat.",
  },
  budget: {
    subject: {
      warning: "Um agente passou de 80% do orçamento do mês",
      exhausted: "Um agente parou: orçamento do mês atingido",
    },
    preheader: {
      warning: "Em 100%, ele para até o mês virar ou o limite subir.",
      exhausted: "Ele não responde até o mês virar ou o limite subir.",
    },
    headline: { warning: "Um agente passou de 80% do orçamento", exhausted: "Um agente atingiu o orçamento" },
    used: (pct, org) => `Usou ${pct} do orçamento deste mês · ${org}`,
    warning: "Em 100%, ele para e avisa no canal. Um admin pode mudar o limite na página do agente.",
    exhausted: "Ele não responde até o mês virar, ou até um admin subir o limite.",
    button: "Ver o orçamento",
    why: (org) =>
      `Você recebeu este e-mail porque é dono deste agente, ou admin da ${org}. É enviado em 80% e em 100%, uma vez por mês cada.`,
    personal: {
      warning: "Em 100%, ele para e avisa você. Você pode mudar o limite na página do agente.",
      exhausted: "Ele não responde até o mês virar, ou até você subir o limite na página do agente.",
      why: () => "Você recebeu este e-mail porque este agente é seu. É enviado em 80% e em 100%, uma vez por mês cada.",
    },
  },
  digest: {
    subject: (n) =>
      plural("pt-BR", n, { one: "Um pedido espera sua aprovação", other: `${n} pedidos esperam sua aprovação` }),
    preheader: "Pedidos expiram em 24 horas, e nada roda sem uma decisão.",
    headline: (n) => plural("pt-BR", n, { one: "Um pedido espera por você", other: `${n} pedidos esperam por você` }),
    body: (n, org) => [
      "Na ",
      { b: org },
      plural("pt-BR", n, {
        one: ", um agente pediu para fazer algo que só uma pessoa pode aprovar.",
        other: ", agentes pediram para fazer coisas que só uma pessoa pode aprovar.",
      }),
    ],
    age: (h) => `há\u00a0${h}\u00a0h`,
    more: (k) => `E mais ${k}.`,
    button: (n) => plural("pt-BR", n, { one: "Ver o pedido", other: "Abrir aprovações" }),
    why: (org, hours) =>
      `Você recebeu este e-mail porque pode aprovar estes pedidos na ${org}.${hours ? ` É enviado quando um pedido espera mais de ${hours} horas, uma vez por pedido.` : ""}`,
    personal: {
      body: (n) =>
        plural("pt-BR", n, {
          one: "Um dos seus agentes pediu para fazer algo que precisa da sua aprovação.",
          other: "Seus agentes pediram para fazer coisas que precisam da sua aprovação.",
        }),
      why: (_org, hours) =>
        `Você recebeu este e-mail porque pode aprovar estes pedidos.${hours ? ` É enviado quando um pedido espera mais de ${hours} horas, uma vez por pedido.` : ""}`,
    },
  },
  ready: {
    subject: "O computador dos seus agentes está pronto",
    preheader: {
      ai: "Agora: conecte sua IA, para os agentes pensarem.",
      task: "Agora: passe a primeira tarefa aos agentes.",
      create: "Agora: crie o primeiro agente.",
    },
    headline: "O computador dos seus agentes está pronto",
    computer: "O computador dos seus agentes",
    body: (org) => [
      "Obrigado por esperar. O computador da ",
      { b: org },
      " está ligado e configurado, com um usuário só para cada agente. Ele fica ligado dia e noite, para os agentes trabalharem a qualquer hora.",
    ],
    facts: { cpus: "CPUs", memory: "Memória", disk: "Disco" },
    next: "Próximos passos",
    steps: {
      ai: [
        "Conecte sua IA.",
        "Entre com o seu plano do Claude ou do ChatGPT, com o plano de código de outra IA, ou com uma chave de API. É com ela que os agentes pensam.",
      ],
      task: ["Passe a primeira tarefa.", "No #general, chame um agente com @ e diga do que precisa."],
      watch: [
        "Veja os agentes trabalhando.",
        "Na página de um agente, clique em Abrir para ver o computador dele ao vivo. Assuma o controle quando quiser e devolva quando terminar.",
      ],
      create: ["Crie um agente.", "Ele trabalha neste computador desde o começo."],
    },
    button: { ai: "Conectar sua IA", task: "Passar a primeira tarefa", create: "Criar um agente" },
    why: (org) =>
      `Você recebeu este e-mail porque é dono da ${org} no agentes.chat. É o único e-mail sobre este computador.`,
    personal: {
      body: () =>
        "Obrigado por esperar. O computador dos seus agentes está ligado e configurado, com um usuário só para cada agente. Ele fica ligado dia e noite, para os agentes trabalharem a qualquer hora.",
      steps: {
        task: ["Passe a primeira tarefa.", "Abra uma conversa com um dos seus agentes e diga do que precisa."],
      },
      why: () =>
        "Você recebeu este e-mail porque este workspace no agentes.chat é seu. É o único e-mail sobre este computador.",
    },
  },
  joinRequest: {
    subject: "Alguém pede para entrar no seu workspace",
    preheader: "Aprove ou recuse em Membros. Nada acontece até você responder.",
    headline: "Um pedido para entrar espera por você",
    body: (org) => ["Essa pessoa abriu o link de convite da ", { b: org }, " e pediu para entrar."],
    note: "Aprove só quem você espera. A pessoa entra como membro, a não ser que você escolha outro papel na página.",
    approve: "Aprovar",
    deny: "Recusar",
    more: ["Todos os pedidos ", { nobr: "em espera estão em Membros." }],
    why: (org) => `Você recebeu este e-mail porque é dono ou admin da ${org}. É enviado no máximo uma vez por hora.`,
    personal: {
      body: () => "Essa pessoa abriu o link de convite do seu workspace e pediu para entrar.",
      why: () =>
        "Você recebeu este e-mail porque cuida de quem entra no seu workspace. É enviado no máximo uma vez por hora.",
    },
  },
  joinAnswer: {
    someone: "Alguém",
    joined: {
      subject: "Seu pedido para entrar foi aprovado",
      preheader: "Você já está dentro. Abra o workspace para começar.",
      headline: "Você entrou",
      body: (who, org, role) => [`${who} aprovou seu pedido. Você entrou na `, { b: org }, ` como ${role}.`],
      button: "Abrir o workspace",
    },
    invited: {
      subject: "Seu pedido para entrar foi aprovado",
      preheader: "Falta um passo: aceite o convite em até 7 dias.",
      headline: "Aprovado: falta um passo",
      body: (who, org) => [`${who} aprovou seu pedido para entrar na `, { b: org }, "."],
      next: "Aceite o convite com este endereço de e-mail em até 7 dias.",
      button: "Aceitar convite",
    },
    denied: {
      subject: "Seu pedido para entrar não foi aprovado",
      preheader: "Alguém do workspace viu e não aprovou.",
      headline: "Seu pedido não foi aprovado",
      body: (org) => ["Alguém da ", { b: org }, " viu seu pedido e não aprovou."],
      reason: (reason) => [{ b: "Recado: " }, `“${reason}”`],
      small: "Se acha que foi engano, peça a alguém de lá para convidar você por e-mail.",
    },
    why: (org) => `Você recebeu este e-mail porque este endereço pediu para entrar na ${org} no agentes.chat.`,
    personal: {
      joined: { body: (who) => `${who} aprovou seu pedido. Agora você está no workspace.` },
      invited: { body: (who) => `${who} aprovou seu pedido para entrar no workspace.` },
      denied: {
        preheader: "A pessoa viu e não aprovou.",
        body: () => "A pessoa para quem você pediu viu seu pedido e não aprovou.",
        small: "Se acha que foi engano, peça para ela convidar você por e-mail.",
      },
      why: () =>
        "Você recebeu este e-mail porque este endereço pediu para entrar num workspace pessoal no agentes.chat.",
    },
  },
  joinCode: {
    subject: (code) => `${code} é seu código do agentes.chat`,
    preheader: "Digite na página para pedir para entrar. Vale por 10 minutos.",
    headline: "Seu código",
    body: (org) => ["Digite este código na página para pedir para entrar na ", { b: org }, "."],
    small: ["Vale por 10 minutos. Se não foi você, ", { nobr: "ignore este e-mail." }],
    why: (org) =>
      `Você recebeu este e-mail porque alguém digitou este endereço para pedir para entrar na ${org} no agentes.chat.`,
    personal: {
      body: () => "Digite este código na página para pedir para entrar neste workspace.",
      why: () =>
        "Você recebeu este e-mail porque alguém digitou este endereço para pedir para entrar num workspace pessoal no agentes.chat.",
    },
  },
  deletionCode: {
    subjectWorkspace: (code) => `${code} é seu código para apagar um workspace`,
    subjectAccount: (code) => `${code} é seu código para apagar sua conta inteira`,
    preheader: "Digite no agentes.chat para confirmar. Vale por 10 minutos.",
    headline: "Seu código",
    workspace: (org) => [
      "Digite este código para apagar o workspace ",
      { b: org },
      ". Ele fica só para leitura para todos na hora e é apagado de vez 7 dias depois.",
    ],
    account: (email) => [
      "Digite este código para apagar a conta inteira ",
      { b: email },
      ", não só um workspace. Ela sai de todos os aparelhos na hora e é apagada de vez 7 dias depois, e os workspaces em que só você está fecham com ela.",
    ],
    support: (address) => [
      "Vale por 10 minutos, e nada é apagado sem ele. Se não foi você, não passe para ninguém e escreva para ",
      { mail: address },
      ".",
    ],
    noSupport:
      "Vale por 10 minutos, e nada é apagado sem ele. Se não foi você, não passe para ninguém e avise quem cuida deste servidor.",
    whyWorkspace: (org) =>
      `Você recebeu este e-mail porque sua conta pediu para apagar o workspace ${org} no agentes.chat.`,
    whyAccount: "Você recebeu este e-mail porque sua conta pediu para ser apagada no agentes.chat.",
    personal: {
      workspace: (org) => [
        "Digite este código para apagar o seu workspace ",
        { b: org },
        ". Ele fica só para leitura na hora e é apagado de vez 7 dias depois.",
      ],
    },
  },
  deleting: {
    subject: (day) => `Um workspace em que você está vai ser apagado em ${day}`,
    preheader: "Ele está só para leitura agora. Um dono ainda pode restaurar até lá.",
    headline: "Um workspace está sendo apagado",
    body: (by, org, day, time) => [
      { b: by },
      " apagou o workspace ",
      { b: org },
      `. Ele está só para leitura agora e some de vez em ${day} às ${time}.`,
    ],
    owner: "Mudou de ideia? Restaure antes disso.",
    button: "Restaurar o workspace",
    member: "Se foi um engano, peça para um dono restaurar.",
    why: (org) => `Você recebeu este e-mail porque está na ${org} no agentes.chat.`,
    personal: {
      member: "Se foi um engano, peça para quem apagou restaurar.",
      why: () => "Você recebeu este e-mail porque está neste workspace no agentes.chat.",
    },
  },
  restored: {
    subject: "Um workspace em que você está voltou",
    preheader: "Um dono restaurou. Ele voltou a funcionar.",
    headline: "O workspace voltou",
    body: (by, org) => [{ b: by }, " restaurou ", { b: org }, ". Ele voltou a funcionar."],
    button: "Abrir o workspace",
    why: (org) => `Você recebeu este e-mail porque está na ${org} no agentes.chat.`,
    personal: {
      why: () => "Você recebeu este e-mail porque está neste workspace no agentes.chat.",
    },
  },
  appConnected: {
    subject: "Um app foi conectado à sua conta do agentes.chat",
    preheader: "Ele pode ler e mandar tarefas aos agentes em seu nome em um workspace.",
    headline: "Um app foi conectado",
    body: (app, org) => [{ b: app }, " agora tem acesso à sua conta na ", { b: org }, "."],
    note: "Não foi você? Desconecte agora e troque sua senha.",
    button: "Ver apps conectados",
    why: (org) => `Você recebeu este e-mail porque um app foi conectado à sua conta na ${org} no agentes.chat.`,
    personal: {
      body: (app) => [{ b: app }, " agora tem acesso à sua conta no seu workspace pessoal."],
      why: () =>
        "Você recebeu este e-mail porque um app foi conectado à sua conta no seu workspace pessoal no agentes.chat.",
    },
  },
  accountDeleting: {
    subject: (day) => `Sua conta do agentes.chat vai ser apagada em ${day}`,
    preheader: "Você tem 7 dias para mudar de ideia.",
    headline: "Sua conta está sendo apagada",
    body: (email, day, time) => [
      "Vamos apagar a conta ",
      { b: email },
      ` em ${day} às ${time}. Ela saiu de todos os aparelhos, e ninguém fala com você aqui até você voltar.`,
    ],
    closes: (count, names) => [
      plural("pt-BR", count, {
        one: "O workspace em que só você estava fechou agora e some na mesma data: ",
        other: "Os workspaces em que só você estava fecharam agora e somem na mesma data: ",
      }),
      ...names,
      ".",
    ],
    undo: "Mudou de ideia? Entre antes dessa data e aperte Restaurar.",
    button: "Entrar para restaurar",
    why: "Você recebeu este e-mail porque este endereço tem uma conta no agentes.chat.",
  },
  accountDeleted: {
    subject: "Sua conta do agentes.chat foi apagada",
    preheader: "Ela saiu de todos os aparelhos e não entra mais.",
    headline: "Sua conta foi apagada",
    body: (email) => ["Apagamos a conta ", { b: email }, "."],
    closes: (count, day, names) => [
      plural("pt-BR", count, {
        one: `O workspace em que só você estava está fechado e vai ser apagado de vez em ${day}: `,
        other: `Os workspaces em que só você estava estão fechados e vão ser apagados de vez em ${day}: `,
      }),
      ...names,
      ".",
    ],
    support: (address) => ["Se não foi você, escreva para ", { mail: address }, "."],
    noSupport: "Se não foi você, avise quem cuida deste servidor.",
    why: "Você recebeu este e-mail porque este endereço tinha uma conta no agentes.chat.",
  },
  autonomy: {
    subject: (day, stalls, noise) => `Agentes em ${day}: ${stalls} travas, ${noise} execuções à toa`,
    preheader: "Onde os agentes pararam e onde agiram à toa, contra os 7 dias anteriores.",
    headline: (day) => `Travas e ruído em ${day}`,
    body: "Todos os workspaces ativos deste servidor, no dia UTC. Só nomes e números.",
    stalls: "Travas",
    noise: "Ruído",
    metric: {
      mentionNoRun: "Menções que não acordaram ninguém",
      readOnly: "Execuções que só podiam ler",
      promiseUnkept: "Terminaram com trabalho por fazer",
      promiseIgnored: "Seguiram sem fazer após o aviso",
      handoffUnanswered: "Repasses sem resposta em 30 min",
      limitStops: "Parados por um limite",
      personUnanswered: "Pessoas sem resposta em 10 min",
      taskStartFailed: "Tarefas que falharam no início",
      noiseRuns: "Execuções à toa",
      quietRuns: "Terminaram sem dizer nada",
      ackReplies: "Responderam a um obrigado ou ok",
      idleWakes: "Acordados sem nada a fazer",
      noiseTokens: "Os tokens delas",
      noiseCostNanoUsd: "O custo delas",
    },
    value: (today, average) => `${today} · média de 7 dias ${average}`,
    topStalls: "Mais travas",
    topNoise: "Mais execuções à toa, com o custo",
    none: "Nenhum workspace.",
    table: (day) => `A tabela inteira: bun run report:autonomy --day ${day}`,
    why: "Você recebeu este e-mail porque este endereço está em OPS_REPORT_EMAIL neste servidor. Ele sai uma vez por dia.",
  },
  planOpened: {
    subject: (plan) => `Mais pessoas podem falar com seu agente pelo seu plano do ${plan}`,
    preheader: (plan) => `As conversas delas usam o seu plano do ${plan} e os limites dele.`,
    headline: "Mais pessoas podem falar com seu agente",
    body: (by, agent, plan) => [
      { b: by },
      " deixou mais pessoas falarem com ",
      { b: agent },
      `. As conversas delas usam o seu plano do ${plan} e os limites dele.`,
    ],
    agent: "Agente",
    by: "Mudado por",
    was: "Antes",
    now: "Agora",
    everyone: "Todo mundo no workspace",
    onlyYou: "Só você",
    you: "Você",
    note: "Para desfazer, mude Quem pode falar na página do agente.",
    button: "Ver quem pode falar",
    why: (org) =>
      `Você recebeu este e-mail porque um agente seu na ${org} pensa com o seu plano e outra pessoa mudou quem pode falar com ele.`,
    personal: {
      why: () =>
        "Você recebeu este e-mail porque um agente seu pensa com o seu plano e outra pessoa mudou quem pode falar com ele.",
    },
  },
  planLent: {
    subject: (plan) => `Seu plano do ${plan} agora pensa por outro agente`,
    preheader: (plan) => `As conversas dele usam o seu plano do ${plan} e os limites dele. Você pode tirar de volta.`,
    headline: "Alguém conectou o seu plano a um agente",
    body: (by, agent, plan) => [
      { b: by },
      ` conectou o seu plano do ${plan} ao agente `,
      { b: agent },
      ". As conversas dele usam o seu plano e os limites dele.",
    ],
    agent: "Agente",
    by: "Conectado por",
    plan: "Plano",
    note: "Tire de volta com um clique nas suas notificações, e o agente para de pensar com o seu plano.",
    button: "Abrir notificações",
    why: (org) => `Você recebeu este e-mail porque alguém na ${org} conectou o seu plano a um agente.`,
    personal: {
      why: () => "Você recebeu este e-mail porque alguém do seu workspace conectou o seu plano a um agente.",
    },
  },
  planWaiting: {
    subject: "Seu time está esperando",
    preheader: "Seu workspace está pronto. Falta um plano do agentes.chat para ele começar.",
    headline: "Seu time está esperando",
    body: (agents, channels, routines) => {
      const a = plural("pt-BR", agents, { one: `1 agente`, other: `${agents} agentes` });
      const c = plural("pt-BR", channels, { one: `1 canal`, other: `${channels} canais` });
      const r = plural("pt-BR", routines, { one: `1 rotina`, other: `${routines} rotinas` });
      return routines > 0
        ? `${a}, ${c} e ${r} estão prontos. Falta um plano do agentes.chat para eles começarem.`
        : `${a} e ${c} estão prontos. Falta um plano do agentes.chat para eles começarem.`;
    },
    button: "Ver planos do agentes.chat",
    why: (org) => `Você recebeu este e-mail porque administra ${org} no agentes.chat. São só dois avisos como este.`,
    personal: {
      subject: "Seus agentes estão esperando",
      headline: "Seus agentes estão esperando",
      body: (agents, _channels, routines) => {
        const a = plural("pt-BR", agents, { one: `1 agente`, other: `${agents} agentes` });
        const r = plural("pt-BR", routines, { one: `1 rotina`, other: `${routines} rotinas` });
        return `Tudo pronto: ${routines > 0 ? `${a} e ${r}` : a}. Só falta um plano do agentes.chat.`;
      },
      why: () => "Você recebeu este e-mail porque este workspace no agentes.chat é seu. São só dois avisos como este.",
    },
  },
};
