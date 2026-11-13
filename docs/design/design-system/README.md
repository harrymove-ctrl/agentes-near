**agentes** (agentes.chat) é um workspace de chat onde pessoas e agentes de IA trabalham juntos. O sistema tem uma regra central: **dá para saber, de relance, quem é pessoa e quem é agente, e o que está esperando um humano**. Tudo o mais é neutro e calmo, porque as pessoas passam o dia inteiro aqui.

## Conteúdo e voz

- Escreva em português do Brasil, frases curtas, voz ativa, sem exclamações e sem emoji na interface.
- Botões começam com verbo e dizem exatamente o que acontece: "Aprovar merge", "Pedir à Ada", "Criar canal". Nunca "OK" ou "Confirmar" sozinhos.
- O produto se chama "agentes", em minúsculas, como no logo.
- Agentes são chamados pelo nome, como colegas: "Ada abriu o PR #42", não "O agente Dev executou a ação".
- Ações sensíveis nomeiam o alvo: "Ada quer fazer merge do PR #42 em main".
- Erros dizem o que houve e como resolver: "Use um valor maior que zero."
- Números de máquina (custos, tokens, modelos) aparecem precisos e por extenso: "sonnet 5.5 · 1.240 tokens · US$ 0,004".

## Fundamentos visuais

**Cor.** O sistema é neutro primeiro. Interface e pessoas usam tinta: `ink` sobre `surface`, `surface-raised` e `surface-sunken`; texto secundário em `ink-muted`. O botão primário é `action` com `on-action`, ou seja, ações humanas são em tinta, não em cor.
- `agent` (azul céu) é só identidade: avatar do agente, símbolo do logo, anel de "trabalhando" e cursor de streaming. Nunca pinte de azul nomes, menções, seleções, botões, barras ou fundos. A interface é neutra; quem é agente se vê pelo avatar.
- `attention` (âmbar) aparece só quando algo espera um humano: aprovação pendente, orçamento perto do limite. Sempre em peça pequena (chip `attention` sobre `attention-soft` com ícone, contador), nunca pintando um card inteiro nem como borda.
- Cards são sempre neutros (`surface-raised` + `line`). O estado vai num chip, não no fundo.
- `success` é neutro (alias de `ink`): o azul é dos agentes, então sucesso se diz pelo ícone de check e pela palavra. `danger` é vermelho e sempre acompanha uma palavra ou ícone.
- Texto sobre fundo colorido usa o token `on-…` correspondente, nunca branco literal.

**Forma.** Pessoas são círculos (`radius-full`). Agentes são o símbolo vivo: quadrado arredondado `radius-agent` (`30% 30% 30% 9%`), com **um canto vivo** no inferior esquerdo, degradê `agent2 → agent` e dois olhos que piscam, olham em volta (pensando) ou viram traço (escrevendo); ver `../refresh-2026-10.md`. O canto vivo é a assinatura do agente e só aparece em coisas de agente: avatar, botão "Pedir a …" e card de aprovação. Controles usam `radius-sm`; cards e menus `radius-md`; diálogos `radius-lg`.

**Tipo.** Onest para toda a interface: `display` em títulos de página, `title` em cabeçalhos de canal e cards, `body` nas mensagens, `small` em rodapés de thread, `label` em caixa alta nos rótulos da barra lateral. `meta` para custo, tokens e modelo ao lado do horário, com algarismos tabulares. Martian Mono (`code`) só aparece em código: inline, blocos, diffs e comandos. Nunca use mono para rótulos, metadados, botões ou texto de interface.

**Espaço.** Base de 4px. Mensagens do mesmo autor ficam a `space-2`; grupos de autores diferentes a `space-6`. Cards têm padding `space-4`.

**Profundidade (2026-10).** Camadas com elevação `e1`/`e2`/`e3` e a luz de topo `top`: cards e botões secundários em e1, hover de card interativo e composer em e2, vidro (menus, popovers, select, toasts, ⌘K) e diálogos em e3. Vidro usa `glass` + `backdrop-filter`, com `glass-solid` de reserva. Raios: itens de menu 10, botões 12, cards 14, composer 18, seções 20. Movimento com `--out` e `--spring`, sempre desligado com `prefers-reduced-motion`. Especificação completa em `../refresh-2026-10.md`.

**Foco e estados.** Todo controle focado por teclado mostra `focus-ring`: 1px da superfície e um anel cinza de 2px em `focus-color` (`line-strong`, 3:1). Só o teclado o desenha: um clique, um toque ou o que um script foca depois de alguém digitar não mostram anel (`trackInput` marca `<html data-pointer>`, e toda regra que desenha um anel começa com `html:not([data-pointer])`). Bordas de controle usam `line-strong` (3:1). Desabilitado é `ink-muted` sobre `surface`. Um agente trabalhando ganha um anel `agent` no avatar e, enquanto escreve, um cursor `agent` no fim do texto; ambos param com `prefers-reduced-motion`.

## Logo

A marca é **agentes**; o domínio é agentes.chat. O logo principal é o símbolo do agente colado a "agentes" em Onest 700. A versão expandida acrescenta um balão pequeno "chat" em `agent`, no alto à direita, para quando o domínio importa (site, lançamentos). Em texto corrido, escreva "agentes" (minúsculo); "agentes.chat" só como endereço. Use o componente Logo; arquivos do símbolo em `docs/design/icons/`. Abaixo de 18px, só o símbolo.

## Iconografia

Ícones próprios, desenhados num grid de 20px com traço de 1.6, pontas e junções arredondadas. Formas que fecham (mensagem, agente, aprovar) repetem o canto vivo inferior esquerdo. Nos arquivos em `docs/design/icons/` a tinta é `ink` do tema claro (`#151a17`); no produto, use o mesmo desenho inline com `stroke: currentColor` (classe `ac-icon`). Sem emoji como ícone. Chips e badges de estado levam ícone, nunca bolinha colorida.

## Componentes

Os estilos estão em `bundle.css`, com prefixo `ac-`, e leem apenas os tokens. Controles são sempre nossos: select, menu, checkbox e diálogos não usam o visual nativo do sistema. Por enquanto são classes CSS sobre HTML semântico; a implementação em React com primitivos headless vem no pacote `packages/ui` do app.
