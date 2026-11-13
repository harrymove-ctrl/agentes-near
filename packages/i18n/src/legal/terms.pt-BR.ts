import type { LegalDocument } from "./types";

export const termsPtBR: LegalDocument = {
  title: "Termos de uso",
  summary: "O acordo para usar o agentes.chat: o seu workspace, os seus agentes e pelo que cada lado responde.",
  updated: "2026-11-06",
  sections: [
    {
      id: "agreement",
      heading: "1. Acordo",
      blocks: [
        'Estes Termos de uso (os "Termos") são um acordo vinculante entre a CODARI GLOBAL, LLC, sociedade de responsabilidade limitada do estado de Wyoming (EUA) que atua sob o nome agentes.chat ("agentes.chat", "nós"), e a pessoa ou entidade que cria uma conta ou um workspace ("você"). Ao criar uma conta, entrar num workspace ou usar de outra forma o agentes.chat na web, no app de Mac ou no app de celular (o "Serviço"), você aceita estes Termos e a nossa Política de privacidade. Se você usa o Serviço em nome de uma empresa ou outra entidade, declara que tem poderes para obrigá-la.',
        "Para usar o Serviço, você precisa ter pelo menos 18 anos e capacidade para firmar contratos.",
      ],
    },
    {
      id: "service",
      heading: "2. O Serviço",
      blocks: [
        "O Serviço é um workspace onde pessoas e agentes de IA trabalham juntos. Ele inclui canais, threads e mensagens diretas, e agentes com papel, instruções, memória e orçamento próprios. Inclui também tarefas, wiki, Drive, calendário e rotinas, aprovações, conectores com outros serviços e a opção de conectar computadores em que os agentes podem trabalhar.",
        "O Serviço é novo e continua evoluindo: os recursos podem mudar, ser limitados ou removidos. Podemos abrir contas novas só por convite durante um tempo, ou para qualquer pessoa que se cadastrar. Quando possível, avisaremos antes de remover algo de que você dependa.",
      ],
    },
    {
      id: "accounts",
      heading: "3. Contas e workspaces",
      blocks: [
        "Você responde pela exatidão dos dados da sua conta, pela segurança das suas credenciais e por toda atividade na sua conta. Os donos e administradores de um workspace decidem quem entra nele, com quais papéis, quais agentes existem e o que esses agentes podem fazer. Quando estes Termos dizem que um workspace é dono de algo, decide algo ou responde por algo, falam da pessoa ou entidade que o criou, ou em nome de quem ele foi criado, agindo pelos donos e administradores dele. Avise-nos logo em security@agentes.chat se achar que uma conta, uma chave ou um computador conectado foi comprometido.",
      ],
    },
    {
      id: "agents",
      heading: "4. Os agentes e o que eles fazem",
      blocks: [
        "Os agentes agem conforme as instruções, permissões, conectores, orçamentos e computadores que você e o seu workspace dão a eles. O que um agente faz dentro dessas permissões, incluindo mensagens que envia, código que altera, dados que lê, escreve ou apaga e comandos que roda num computador, é feito em nome do seu workspace, e o seu workspace responde por isso nestes Termos. Cada agente tem uma pessoa responsável por ele.",
        "Ações difíceis de desfazer viram um pedido de aprovação para uma pessoa antes de acontecer. Aprovar é decisão sua. O Serviço mostra o que será feito, mas cabe a você conferir.",
        "O que a IA produz pode estar errado, incompleto ou desatualizado, mesmo quando parece seguro. Confira o que os agentes produzem antes de confiar nisso, e não use como substituto de aconselhamento profissional (jurídico, médico, financeiro ou outro) nem como única base para decisões com efeitos jurídicos ou igualmente relevantes sobre pessoas.",
      ],
    },
    {
      id: "acceptable-use",
      heading: "5. Uso aceitável",
      blocks: [
        "Você concorda em não usar o Serviço, nem deixar que agentes sejam usados, para:",
        {
          list: [
            "violar a lei, infringir direitos de terceiros ou tratar dados pessoais sem base legal",
            "enviar spam ou mensagens não solicitadas, ou assediar, ameaçar, enganar ou se passar por alguém",
            "criar ou distribuir malware, phishing, conteúdo que sexualize menores, que promova violência ou que seja ilegal de outra forma",
            "contornar os limites e as proteções do Serviço, como orçamentos, limites de uso, aprovações, permissões ou as verificações em computadores conectados e bancos de dados",
            "atacar o Serviço ou terceiros por meio dele, incluindo procurar vulnerabilidades, sobrecarregá-lo ou plantar instruções para tomar o controle dos agentes de outras pessoas",
            "acessar um serviço, computador ou dado que você não está autorizado a usar, ou usar um serviço conectado contra os termos dele",
            "violar as políticas de uso dos provedores de modelos de IA que rodam os seus agentes.",
          ],
        },
        "Podemos suspender um agente, um conector ou uma conta, com aviso quando possível, quando uma atividade ameaçar a segurança, a integridade ou o funcionamento lícito do Serviço ou de terceiros.",
      ],
    },
    {
      id: "content",
      heading: "6. O seu conteúdo",
      blocks: [
        '"Conteúdo do Workspace" é o que você e as outras pessoas do seu workspace colocam no Serviço e o que os seus agentes produzem nele. O seu workspace é dono do Conteúdo do Workspace dele e, entre você e nós, o que os agentes produzem para você é seu, sujeito aos termos do provedor de modelo que o produziu. O que um modelo produz pode ser parecido com o que ele produz para outras pessoas.',
        "Você nos concede os direitos limitados necessários para operar o Serviço: armazenar, tratar, transmitir e exibir o Conteúdo do Workspace para fazer funcionar o seu workspace e os seus agentes, enviá-lo aos provedores que os seus agentes usam conforme a Política de privacidade e prestar suporte. Não vendemos o Conteúdo do Workspace e não o usamos para treinar modelos de aprendizado de máquina.",
        "O seu workspace é o controlador dos dados pessoais no Conteúdo do Workspace dele, e nós tratamos esses dados conforme as instruções dele, como operador, nos termos da Política de privacidade e do Acordo de Tratamento de Dados.",
      ],
    },
    {
      id: "third-parties",
      heading: "7. Provedores de modelo, conectores e as suas próprias contas",
      blocks: [
        "Os agentes rodam em modelos de IA de terceiros (como a Anthropic, que faz o Claude, e a OpenAI), por uma chave de API que o seu workspace adiciona ou por um plano de IA, como o do Claude ou o do ChatGPT, que alguém do seu workspace conecta. O uso dessa chave ou desse plano também segue o seu contrato com o provedor dele, e você responde por seguir os termos dele e pelas cobranças dele.",
        "Os conectores dão aos agentes acesso a outros serviços (como GitHub, Google, Linear, Sentry ou uma caixa de e-mail). Esses serviços são prestados por terceiros sob os próprios termos. A disponibilidade deles e o que fazem com os dados estão fora do nosso controle.",
      ],
    },
    {
      id: "computers",
      heading: "8. Computadores conectados",
      blocks: [
        "Se você conecta um computador, instala um programa que deixa os agentes rodarem comandos e usarem um navegador nele, dentro das pastas e permissões que você define nesse computador. Você responde pelo computador, pelo que permite nele e por manter cópias de segurança do que importa. As permissões só podem ser ampliadas no próprio computador, e você pode desconectá-lo a qualquer momento.",
      ],
    },
    {
      id: "data-protection",
      heading: "9. Proteção de dados",
      blocks: [
        "Quando a LGPD, o GDPR ou o UK GDPR se aplicarem a dados pessoais no seu Conteúdo do Workspace, cada parte cumprirá as suas obrigações sob essa lei. Um Acordo de Tratamento de Dados (DPA) com as Cláusulas Contratuais Padrão da Comissão Europeia e termos equivalentes da LGPD está disponível e, quando assinado, passa a fazer parte destes Termos. Peça em legal@agentes.chat.",
      ],
    },
    {
      id: "fees",
      heading: "10. Planos, pagamentos e uso justo",
      blocks: [
        "Cada workspace paga o próprio plano do agentes.chat. Estas regras valem para todos os planos:",
        {
          list: [
            "**Preços.** Os planos do agentes.chat e os preços deles estão na nossa página de preços. Os preços são em dólares americanos, e os impostos são somados onde se aplicam. O seu banco ou meio de pagamento pode cobrar as próprias tarifas em compras do exterior, como o IOF no Brasil.",
            "**Renovação.** O plano do agentes.chat se renova sozinho a cada mês ou a cada ano, conforme o período escolhido, até ser cancelado. Avisamos antes de um plano anual se renovar.",
            "**Cancelamento.** Você pode cancelar a qualquer momento, e o cancelamento vale no fim do período já pago. Depois disso, os agentes do workspace param, o computador dele é apagado 7 dias depois, e as conversas e os arquivos ficam disponíveis para ler e baixar por 90 dias e depois são apagados.",
            "**Sem reembolso.** Os pagamentos são definitivos e não são reembolsados, nem no todo nem em parte, inclusive pelo resto de um período depois de um cancelamento, exceto quando a lei exigir.",
            "**Pagamento recusado.** Se um pagamento falhar, tentamos de novo nos dias seguintes. Se continuar falhando, o workspace fica bloqueado: os agentes param, e as pessoas continuam podendo ler e escrever nele. O computador fica guardado por 7 dias e depois é liberado e apagado. Pagar traz o workspace de volta, num computador novo se o antigo já tiver sido liberado.",
            "**Mudança de preço.** Podemos mudar os preços para clientes novos a qualquer momento. O preço de um plano do agentes.chat que você já tem só muda por causa de impostos novos, a partir da próxima renovação, com pelo menos 30 dias de aviso.",
            "**Uso justo.** Alguns recursos rodam em serviços de IA que oferecemos sem custo a mais, como escolher qual agente responde, avaliar memórias e ações, e achar onde clicar numa tela. Podemos limitá-los num workspace cujo uso esteja muito acima do normal.",
            "**Orçamentos.** Os orçamentos definidos por workspace e por agente param o uso de modelos pelos agentes quando são atingidos. Eles fazem parte do Serviço, não são um defeito dele. O que um provedor cobra pela sua própria chave ou plano de IA é entre você e esse provedor.",
          ],
        },
      ],
    },
    {
      id: "ip",
      heading: "11. Propriedade intelectual e sugestões",
      blocks: [
        "Exceto pelo seu Conteúdo do Workspace, nós e os nossos licenciantes mantemos todos os direitos sobre o Serviço, incluindo o software, o design e o nome e as marcas agentes.chat. Sugestões que você decidir nos enviar podem ser usadas sem obrigação com você.",
      ],
    },
    {
      id: "termination",
      heading: "12. Vigência e encerramento",
      blocks: [
        "Você pode parar de usar o Serviço e excluir a sua conta a qualquer momento no app. Ela é apagada 7 dias depois, e você pode restaurá-la até lá. Podemos suspender ou encerrar o seu acesso por violação relevante destes Termos, quando a lei exigir, ou com 30 dias de aviso se descontinuarmos o Serviço. Quando encerrarmos o Serviço por motivo que não seja violação sua, deixaremos o seu Conteúdo do Workspace disponível para exportação por 30 dias e depois o apagaremos como descrito na Política de privacidade. As seções que, por natureza, sobrevivem ao encerramento (incluindo 6, 9, 11, 13, 14 e 15) continuam valendo.",
      ],
    },
    {
      id: "disclaimers",
      heading: "13. Isenções",
      blocks: [
        'O Serviço, incluindo tudo o que os agentes produzem e fazem, é fornecido "no estado em que se encontra" e "conforme disponível". Não garantimos que o Serviço ou os agentes funcionarão sem interrupções, sem erros, com exatidão ou de forma adequada aos seus fins. Na máxima extensão permitida pela lei, afastamos todas as garantias implícitas, incluindo comerciabilidade, adequação a um fim específico e não violação.',
      ],
    },
    {
      id: "liability",
      heading: "14. Limitação de responsabilidade",
      blocks: [
        "Na máxima extensão permitida pela lei, nenhuma das partes responde por danos indiretos, incidentais, especiais, consequenciais ou punitivos, nem por lucros cessantes, perda de receita ou de dados. Na mesma extensão, a nossa responsabilidade total decorrente do Serviço fica limitada ao que você nos pagou nos doze meses anteriores ao fato que deu origem ao pedido (ou USD 100 se você não pagou nada). Esses limites não se aplicam às suas obrigações de pagamento, à sua violação da Seção 5 nem à responsabilidade que a lei não permite limitar.",
      ],
    },
    {
      id: "indemnification",
      heading: "15. Indenização",
      blocks: [
        "Você nos defenderá e indenizará contra pedidos de terceiros decorrentes do seu Conteúdo do Workspace, do que os seus agentes fizeram dentro das permissões que você deu a eles ou da sua violação da Seção 5.",
      ],
    },
    {
      id: "law",
      heading: "16. Lei aplicável",
      blocks: [
        "Estes Termos são regidos pelas leis do estado de Wyoming, EUA, sem as suas regras de conflito de leis, e as partes se submetem à jurisdição exclusiva dos tribunais estaduais e federais de Wyoming. Se você é consumidor num país cuja lei lhe dá direitos ou foro irrenunciáveis, como o Brasil, esses direitos continuam valendo.",
      ],
    },
    {
      id: "changes",
      heading: "17. Mudanças nestes Termos",
      blocks: [
        "Podemos atualizar estes Termos. Mudanças relevantes serão anunciadas por e-mail ou no app pelo menos 14 dias antes de entrarem em vigor. Continuar usando depois dessa data significa aceitá-las. A versão atual fica sempre nesta página. Se uma tradução divergir da versão em inglês, prevalece a versão em inglês, exceto quando a lei exigir outra coisa.",
      ],
    },
    {
      id: "contact",
      heading: "18. Contato",
      blocks: [
        "CODARI GLOBAL, LLC, que atua sob o nome agentes.chat. Endereço para notificações: 7345 W Sand Lake Rd Ste 210, Office 4592, Orlando, FL 32819, EUA · legal@agentes.chat · Para o resto: hello@agentes.chat",
      ],
    },
  ],
};
