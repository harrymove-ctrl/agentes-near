import type { LocaleStrings } from "@agenteschat/i18n/plurals";

/**
 * The app's own strings (pt-BR; English, `keys.en.ts`, is the source), under `mobile.*`.
 * They live here until they move into `@agenteschat/i18n` (packages/i18n); `./index.ts` merges them
 * into the shared resources at runtime. `keys.en.ts` must have exactly the same shape (typed below).
 */
export const mobilePtBR = {
  common: {
    back: "Voltar",
    cancel: "Cancelar",
    close: "Fechar",
    continue: "Continuar",
    done: "Pronto",
    retry: "Tentar de novo",
    loading: "Carregando",
    or: "ou",
  },
  auth: {
    skyLabel: "Céu com agentes",
    social: {
      failed: "Não deu para entrar agora. Tente de novo.",
      /** The browser's sign-in closed without a session (cancelled, or refused there). */
      unfinished: "O login não terminou. Tente de novo ou use seu email.",
    },
    errors: {
      network: "Sem conexão. Confira a internet e tente de novo.",
      generic: "Algo deu errado. Tente de novo.",
      /** No passo do e-mail, sem conexão: a busca tenta de novo sozinha, o e-mail fica. */
      offlineRetry: "Sem internet agora. Eu continuo assim que voltar.",
    },
    flow: {
      /** The first question, alone: the keyboard is open under it from the start. */
      email: "Qual é o seu e-mail?",
      emailLead: "Para entrar ou criar sua conta.",
      /** Novo por aqui: o nome e a senha numa tela. */
      signUp: "Prazer. Como o time te chama?",
    },
    server: {
      line: "Servidor: {{host}} ·",
      change: "Trocar",
      /** The question is the title; the keyboard's return key ("ir") is the action. */
      title: "Onde fica o seu agentes.chat?",
      subtitle: "O endereço que o time abre no navegador.",
      label: "Endereço do servidor",
      placeholder: "agentes.suaequipe.ts.net",
      use: "Usar este servidor",
      checking: "Conferindo…",
      scan: "Escanear QR code",
      backTo: "Voltar para {{host}}",
      /** A linha quieta do login termina em "Mudar", que oferece o servidor ou o idioma na lista do sistema. */
      footChange: "Mudar",
      footChoose: "Servidor e idioma",
      footServer: "Outro servidor",
      footLanguage: "Idioma",
      /** A linha quieta do login, no agentes.chat: abre a câmera para o QR code do computador da equipe. */
      footTeam: "Usa o servidor da sua equipe?",
      footTeamAction: "Entrar por ele",
      /** Num servidor da equipe: onde este login vai, e o jeito de trocar. */
      footOn: "Entrando em {{host}}",
      footSwitch: "Trocar",
      now: "Agora em {{host}}",
      invalid: "Confira o endereço, algo como agentes.suaequipe.ts.net.",
      unreachable: "Não conseguimos falar com {{host}}. Confira o endereço e a internet, e tente de novo.",
      unreachableTailscale:
        "Não conseguimos falar com {{host}}. Ele está no Tailscale: abra o app do Tailscale, conecte e tente de novo. Já está conectado? O computador do servidor pode estar dormindo ou com o app fechado.",
      certificate: "O certificado de {{host}} não é válido. Fale com quem cuida do servidor.",
      notAgentes: "{{host}} não é um servidor agentes.chat. Confira o endereço.",
      serverTooOld: "{{host}} precisa de uma atualização para funcionar com este app.",
      appTooOld: "Atualize o app agentes para usar {{host}}.",
      down: {
        line: "{{host}} não respondeu.",
        text: "Ele pode estar fora do ar ou fora da sua rede. O app abre sozinho quando ele voltar.",
        tryNow: "Tentar agora",
        /** Ao lado de Sair no splash de espera: corrigir o endereço sem sair da conta. */
        switchServer: "Trocar de servidor",
        /** Beside the wick burning down to the next automatic try. */
        retryIn_one: "tenta de novo em {{count}} s",
        retryIn_other: "tenta de novo em {{count}} s",
      },
    },
    connect: {
      title: "Conectar a este servidor?",
      titleSignIn: "Entrar com a conta do computador?",
      on: "Servidor: {{host}}",
      leave: "Você sai da conta atual neste celular.",
      confirm: "Conectar",
      notNow: "Agora não",
      checking: "Conferindo o servidor…",
      notALink: "Este link não é de um servidor agentes.chat.",
      tokenFailed: "O código expirou ou já foi usado. Entre com seu e-mail, ou mostre um código novo no computador.",
      signInSlow:
        "Entrar está demorando mais que o normal. Entre com seu e-mail, ou mostre um código novo no computador.",
    },
    scan: {
      hint: "Aponte para o QR code do computador",
      /** Embaixo da câmera: o endereço, para quem não tem código para escanear. */
      typeAddress: "Digitar o endereço",
      notOurs: "Esse QR code não é de um servidor agentes.chat.",
      cameraTitle: "Usar a câmera",
      cameraText: "Ela só serve para ler o QR code.",
      allow: "Permitir câmera",
      settings: "Abrir Ajustes",
    },
  },
  org: {
    noneTitle: "Você ainda não está em um workspace",
    noneSubtitle: "Peça um convite a alguém do seu time, ou crie o workspace pelo site.",
    openSite: "Abrir o site",
    signOut: "Sair",
  },
  account: {
    deleteFailed: "Não deu para apagar sua conta agora. Tente de novo.",
    deleted: "Sua conta some de vez em {{date}}. Entre antes disso para restaurar.",
    signedOut: "Você saiu.",
  },
  theme: {
    system: "Igual ao celular",
    light: "Claro",
    dark: "Escuro",
  },
  push: {
    channel: "Avisos",
    channelDescription: "O que espera você, menções e conversas.",
    /** One event line in the conversation, after an agent said it will take a while. */
    offer: {
      line: "Quer saber quando {{name}} terminar?",
      action: "Avisar",
    },
    ask: {
      title: "Saiba quando um agente precisar de você",
      text: "Eles trabalham enquanto você faz outra coisa. Avisamos quando pedem seu ok, terminam o que você pediu ou chamam você.",
      on: "Ativar avisos",
      later: "Agora não",
      done: "Avisos ativados",
      failed: "Não deu para ativar os avisos. Tente de novo em Você\u00a0›\u00a0Notificações.",
      someone: "Um agente",
      examples: "Exemplos de avisos",
      now: "agora",
      minutes: "{{n}} min",
      approval: { title: "{{name}} pede seu ok", body: "Posso seguir com o que você pediu?" },
      finished: { title: "{{name}} terminou", body: "Está pronto o que você pediu." },
      mention: { title: "{{name}} chamou você", body: "Dá uma olhada quando puder?" },
    },
  },
  a11y: {
    agent: "{{name}}, agente",
    agentWorking: "{{name}}, agente, trabalhando",
    agentPlain: "Agente",
    person: "{{name}}",
    loading: "Carregando",
    grabber: "Arraste para baixo para fechar",
    closeSheet: "Fechar",
    send: "Enviar",
    attach: "Anexar e mais",
    hold: "Segure para confirmar",
    clearSearch: "Limpar busca",
  },
  composer: {
    placeholder: "Escreva uma mensagem",
    join: "Juntar ao que está fazendo",
    now: "Parar e mandar",
    choice: "Como mandar enquanto o agente trabalha",
    holdToStop: "Segure para parar e mandar",
  },
  search: {
    placeholder: "Buscar",
  },
  picker: {
    /** A picker's search found none of its options. */
    none: "Nada com “{{text}}”.",
  },
} satisfies LocaleStrings;
