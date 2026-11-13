/**
 * A workspace wiki shaped like an imported Obsidian vault (pt-BR): short pages about one subject each, daily notes and
 * meeting notes that touch many subjects in passing, and a few very long pages. Deterministic, for ranking tests.
 */
export const TOPICS: { title: string; folder: string; lines: string[] }[] = [
  {
    title: "Política de reembolso",
    folder: "Financeiro",
    lines: [
      "Clientes podem pedir reembolso em até 7 dias depois da compra.",
      "O pedido de reembolso chega pelo formulário do site e vai para o financeiro.",
      "O gerente de contas aprova reembolsos acima de 500 reais.",
      "Assinatura anual tem reembolso proporcional aos meses que faltam.",
      "O estorno no cartão leva até duas faturas para aparecer.",
      "Reembolso por Pix sai em até 3 dias úteis.",
    ],
  },
  {
    title: "Guia de deploy",
    folder: "Engenharia",
    lines: [
      "O deploy do backend roda pelo script deploy.sh na máquina de produção.",
      "Antes do deploy rode os testes e confira o changelog.",
      "Para voltar uma versão, use o rollback com a tag anterior.",
      "Deploy só de segunda a quinta, nunca na sexta depois das 16h.",
      "O frontend sobe junto com o backend na mesma imagem.",
      "Migrations rodam antes do servidor subir.",
    ],
  },
  {
    title: "Onboarding de clientes",
    folder: "Sucesso do cliente",
    lines: [
      "Todo cliente novo tem uma reunião de kickoff na primeira semana.",
      "No kickoff mostramos o painel, as integrações e o plano de implantação.",
      "O cliente recebe um checklist de implantação por email.",
      "Depois de 30 dias fazemos uma revisão de uso com o cliente.",
      "Clientes enterprise ganham um gerente de sucesso dedicado.",
    ],
  },
  {
    title: "Contratação",
    folder: "Pessoas",
    lines: [
      "Toda vaga abre com descrição aprovada pelo gestor.",
      "O processo seletivo tem triagem, entrevista técnica e entrevista cultural.",
      "A proposta sai em até dois dias depois da última entrevista.",
      "Candidatos recusados recebem retorno por email.",
      "Indicação de funcionário paga bônus depois de 90 dias.",
    ],
  },
  {
    title: "Férias e folgas",
    folder: "Pessoas",
    lines: [
      "Férias são marcadas com 30 dias de antecedência no sistema de RH.",
      "Dá para dividir as férias em até três períodos.",
      "Folga de aniversário vale no mês do aniversário.",
      "O gestor aprova as férias no sistema.",
      "Durante as férias o status no chat fica como ausente.",
    ],
  },
  {
    title: "Uso do CRM",
    folder: "Vendas",
    lines: [
      "Todo lead entra no CRM com origem e responsável.",
      "Oportunidades paradas há 14 dias recebem um alerta.",
      "A proposta comercial é gerada pelo CRM a partir do modelo.",
      "O funil tem as etapas prospecção, qualificação, proposta e fechamento.",
      "Ligações e reuniões ficam registradas na timeline do lead.",
    ],
  },
  {
    title: "Tom de voz",
    folder: "Marketing",
    lines: [
      "Escrevemos como quem conversa, frases curtas e diretas.",
      "Evitamos jargão técnico em textos para clientes.",
      "Usamos você, nunca o senhor ou a senhora.",
      "Emojis só em redes sociais, nunca em emails formais.",
      "O nome da marca é sempre escrito em minúsculas.",
    ],
  },
  {
    title: "Preços dos planos",
    folder: "Vendas",
    lines: [
      "O plano básico custa 49 reais por usuário por mês.",
      "O plano empresa custa 99 reais por usuário por mês.",
      "Pagamento anual tem 20% de desconto.",
      "Desconto acima de 30% precisa de aprovação da diretoria.",
      "Clientes com mais de 100 usuários têm preço sob consulta.",
    ],
  },
  {
    title: "SLA de atendimento",
    folder: "Suporte",
    lines: [
      "Chamados urgentes têm resposta em até 2 horas.",
      "Chamados normais são respondidos em até um dia útil.",
      "Fora do horário comercial só chamados urgentes são atendidos.",
      "O SLA é medido do primeiro contato até a primeira resposta.",
      "Chamado sem resposta do cliente fecha em 7 dias.",
    ],
  },
  {
    title: "Senhas e acessos",
    folder: "Segurança",
    lines: [
      "Senhas ficam no cofre compartilhado, nunca em planilhas.",
      "Todo acesso a produção usa autenticação em dois fatores.",
      "Quem sai da empresa perde os acessos no mesmo dia.",
      "Chaves de API são trocadas a cada 90 dias.",
      "O acesso ao servidor de produção é só por VPN.",
    ],
  },
  {
    title: "Relatório mensal de métricas",
    folder: "Gestão",
    lines: [
      "O relatório mensal vai para a diretoria no dia 5.",
      "Ele traz receita recorrente, churn, novos clientes e NPS.",
      "Os números saem do painel de BI.",
      "Cada área comenta as métricas dela no relatório.",
    ],
  },
  {
    title: "Fornecedores e contratos",
    folder: "Jurídico",
    lines: [
      "Contratos com fornecedores passam pelo jurídico antes da assinatura.",
      "Contratos acima de 12 meses precisam de cláusula de saída.",
      "A assinatura é digital pela plataforma de contratos.",
      "Renovações automáticas são revisadas 60 dias antes.",
    ],
  },
  {
    title: "Guia da marca",
    folder: "Marketing",
    lines: [
      "As cores oficiais são o azul profundo e o laranja.",
      "A fonte dos títulos é a Inter, e a do corpo também.",
      "O logo não pode ser esticado nem mudar de cor.",
      "Fotos de produto têm fundo claro.",
    ],
  },
  {
    title: "Reunião semanal",
    folder: "Gestão",
    lines: [
      "A reunião semanal acontece às segundas às 10h.",
      "A pauta é enviada na sexta anterior.",
      "Cada área tem 5 minutos para atualizações.",
      "Decisões ficam registradas na ata da reunião.",
    ],
  },
  {
    title: "Notas fiscais",
    folder: "Financeiro",
    lines: [
      "A nota fiscal é emitida no dia do pagamento.",
      "Clientes no exterior recebem invoice em inglês.",
      "Nota fiscal com erro é cancelada e emitida de novo em até 24 horas.",
      "O financeiro envia as notas por email ao cliente.",
    ],
  },
  {
    title: "Backup do banco de dados",
    folder: "Engenharia",
    lines: [
      "O backup do banco roda toda noite às 3h.",
      "Os backups ficam 30 dias guardados em outro provedor.",
      "Uma vez por mês testamos a restauração de um backup.",
      "O alerta de backup falho vai para o canal de infraestrutura.",
    ],
  },
];

const FILLER = [
  "Combinamos de voltar ao assunto na próxima semana.",
  "Ficou de mandar o resumo no canal depois.",
  "O time comentou que o mês foi corrido.",
  "Ninguém tinha objeção, seguimos com o plano.",
  "Alguém lembrou de atualizar a documentação.",
  "Ficou pendente revisar os números com calma.",
  "A conversa foi rápida e objetiva.",
  "Teve uma dúvida sobre o prazo, já resolvida.",
];

/** A small seeded generator, so every run builds the same wiki. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

export interface CorpusPage {
  title: string;
  folder: string;
  body: string;
}

/**
 * 200 pages: one short page per topic, 150 daily and meeting notes (5 to 60 sentences mixing topics and filler), and
 * the rest long pages (300 to 900 sentences) that mention everything in passing.
 */
export function wikiCorpus(): CorpusPage[] {
  const next = rng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] as T;
  const sentence = () => (next() < 0.5 ? pick(FILLER) : pick(pick(TOPICS).lines));
  const pages: CorpusPage[] = TOPICS.map((t) => ({ title: t.title, folder: t.folder, body: t.lines.join(" ") }));
  for (let i = 0; i < 150; i++) {
    const n = 5 + Math.floor(next() * 56);
    const day = String((i % 28) + 1).padStart(2, "0");
    const month = String((Math.floor(i / 28) % 12) + 1).padStart(2, "0");
    pages.push({
      title: i % 3 === 0 ? `Ata ${day}-${month}` : `Diário 2026-${month}-${day} ${i}`,
      folder: i % 3 === 0 ? "Reuniões" : "Diário",
      body: Array.from({ length: n }, sentence).join(" "),
    });
  }
  const longTitles = ["Manual da empresa", "Wiki antiga", "Planejamento 2026", "Histórico de decisões"];
  for (let i = 0; pages.length < 200; i++) {
    const n = 300 + Math.floor(next() * 600);
    pages.push({
      title: `${longTitles[i % longTitles.length]} ${Math.floor(i / longTitles.length) + 1}`,
      folder: "",
      body: Array.from({ length: n }, sentence).join(" "),
    });
  }
  return pages;
}
