# Design system 2026-10: mais viva, mais em camadas

Tokens em `design-system/tokens.css` (cópia em `packages/ui/src/styles/tokens.css`, um teste mantém as duas iguais) e `design-system/tokens.json`.

As regras não mudam: cards neutros (estado em chip com ícone, nunca card tingido nem borda da mesma cor), azul só na identidade dos agentes, âmbar só no que espera um humano, mono só em código, controles sempre próprios, sem exclamações.

## Tokens

### Cor

| Token | Claro | Escuro | Uso |
| --- | --- | --- | --- |
| `bg` | `#f4f4f1` | `#0f0f0e` | Fundo do app |
| `raised` | `#ffffff` | `#1c1c1b` | Cards, composer, botão secundário, diálogos |
| `raised-2` | `#ffffff` | `#242423` | O que fica dentro de algo elevado (linha ou card num diálogo, card ou lista): um degrau acima. Os contêineres aplicam sozinhos (`--raised` vira `--raised-2` dentro deles) |
| `sunken` | `#ebebe7` | `#0a0a09` | Trilhos, segmentado, pílulas, esqueletos |
| `glass` | `rgba(255,255,255,.72)` | `rgba(30,30,28,.66)` | Menus, popovers, select, toasts, ⌘K |
| `glass-solid` | `#fbfbf9` | `#1e1e1c` | Vidro sem `backdrop-filter` |
| `line` | `rgba(23,23,22,.08)` | `rgba(255,255,255,.10)` | Hairline |
| `line2` | `rgba(23,23,22,.14)` | `rgba(255,255,255,.15)` | Separadores fortes, borda de e3 |
| `line-strong` | `#82827d` | `#71716c` | Borda de controle (3:1) |
| `ink` | `#151514` | `#efefec` | Texto e ação primária |
| `ink2` | `#2a2a28` | `#d6d6d2` | Corpo de mensagem |
| `muted` | `#5c5c58` | `#a3a39e` | Texto secundário |
| `faint` | `#6f6f6a` | `#8f8f89` | Metadados |
| `agent` / `agent2` | `#0063d1` / `#3d8bff` | `#5aa8ff` / `#8cc3ff` | Identidade de agente (degradê do avatar, halo) |
| `agent-soft` | `#e3eefd` | `#11253f` | Pílula do agente alvo no composer |
| `ok` | `#1f7a45` | `#5fc48a` | Check de passo concluído, presença |
| `warn` / `warn-soft` | `#9a5b00` / `#fbeed5` | `#e0a84a` / `#33260e` | O que espera um humano |
| `danger` | `#b42a20` | `#f08a80` | Erro, destrutivo (sempre com palavra) |
| `plate` / `plate-soft` | cinza 10% / 6% | 14% / 8% | Placas de hover |

`faint` difere da proposta inicial (`#8b8b86` / `#76766f`) para passar AA (4,5:1) em texto pequeno nos dois temas. Os nomes da v1 (`surface`, `surface-raised`, `surface-sunken`, `ink-muted`, `action`, `on-action`, `attention*`, `success`, `focus-ring`, `overlay`) continuam como aliases.

### Elevação

- `e1`: cards, botão secundário, pílula ativa (sombra curta + anel `line`).
- `e2`: hover de card interativo, composer.
- `e3`: vidro, diálogos, composer em foco (anel `line2`).
- `top`: luz de 1px no topo de toda superfície elevada (`box-shadow: var(--e1), var(--top)`).

Os valores escuros são outros (sombras mais fundas, luz do topo a 6%), definidos no tema.

### Raios

`radius-sm` 6 (inputs pequenos, código) · `radius-item` 10 (itens de menu) · `radius-btn` 12 (botões, segmentado) · `radius-lg` 14 (cards, mensagens em hover, resumo do trabalho) · `radius-xl` 18 (composer) · `radius-section` 20 (seções, paleta) · `radius-full` (pessoas, pílulas, reações) · `radius-agent` `30% 30% 30% 9%` (o símbolo do agente: o canto vivo continua no inferior esquerdo).

### Tipo

Onest com `font-feature-settings: "ss01", "tnum"`. Escala: 12 (meta) · 13 (pequeno, botões sm) · 14.5 (UI) · 15 (mensagens, linha 1.62) · 16 (busca) · 17 · 20 (títulos de seção, -0.025em) · 28 / 32 (títulos de página, -0.035em). Rótulo de seção (eyebrow) 11.5px, caixa alta, +0.08em, `faint`.

### Movimento

- `--out: cubic-bezier(.2,.8,.2,1)` para entradas e sombras; `--spring: cubic-bezier(.34,1.4,.5,1)` para pressionar, pílulas deslizantes e o enviar.
- Entradas 120–220 ms (opacidade + transform, sem layout shift); só entradas, fechar é imediato.
- Com `prefers-reduced-motion: reduce`, nada anima (inclusive piscar e halo do agente).

## Componentes

- **Botões** (`Button`): altura 40 (sm 32), raio 12, peso 600. `primary` (b1): degradê da própria tinta (82% → 100%), luz em cima, sombra na base, `filter: brightness(1.08)` no hover. `default` (b2): `raised` + e1 + top, e2 no hover. `ghost`: transparente, texto `muted`, placa no hover. Pressionar: `scale(.97) translateY(.5px)` com mola. Foco: anel de 2px em `ink` com 2px de `raised`. `loading`: spinner, mesma largura. Atalhos com `Kbd` dentro do botão. **Split** (`SplitButton`) e **segmentado** (`Segmented`, pílula que desliza com mola).
- **Kbd**: 18px de altura, raio 5, fundo cinza 14%, peso 600, opacidade .75.
- **Vidro** (`.ac-glass`): `glass` + `backdrop-filter: blur(18px) saturate(1.6)` + e3, raio 16 (paleta 20); sem suporte, `glass-solid`. Em Menu, Popover, Select, Toast e ⌘K.
- **Avatar do agente**: o símbolo vivo. Degradê `agent2 → agent`, raio `radius-agent`, dois olhos brancos. Estados: `idle` (pisca a cada ~5 s), `thinking` (olhos olham em volta + halo), `writing` (olhos em traço + halo). Mapeamento do tempo real: run `queued`/`thinking`/`running` sem texto → `thinking`; texto chegando → `writing`; o resto → `idle`. Usado na conversa, barra lateral, perfil, barra de atividade e pílula do composer.
- **Avatar de pessoa**: círculo com degradê neutro, iniciais, ponto de presença `ok` com anel `raised`.
- **Composer**: card flutuante (raio 18, e2 + top; e3 em foco). Pílulas de contexto (agente alvo com o avatar, skill ativa). `/` abre o menu de comandos em vidro. O enviar é um quadrado de 34px apagado sem texto e cresce para "Enviar ↵" quando há texto (mola).
- **Mensagens**: placa de hover (`plate-soft`, raio 14). Agentes ganham o resumo do trabalho "N passos · conectores · tempo" (expansível, passos com check `ok`), cards de arquivo com miniatura e reações em pílula.
- **Paleta ⌘K**: vidro, raio 20, busca no topo, grupos "Ir para" (canais, agentes, seções das configurações) e "Pedir a um agente" (abre a DM com o texto). Setas e Enter; Esc fecha.
- **Checkbox / switch / abas**: o check desenha o traço (`stroke-dashoffset`), o switch desliza o polegar com mola, as abas e o segmentado usam a pílula deslizante.
- **Cards e seções**: `raised` + e1 + top, raio 14 (seções 20); interativos sobem para e2 no hover. Esqueletos usam `sunken`.

## Refino 2026-10-18

- **Light menos cinza:** área de trabalho branca (`--pane`), menu lateral em papel quase branco (`--side`), campos brancos com contorno fino. Cinza só no trilho de campos/segmentado e no estado escolhido. Dark igual.
- **Régua de controles:** tudo que se clica ou digita tem uma de três alturas, 32 (compacto), 40 (padrão) e 48 (só a ação principal de uma tela inteira), com raio de 30% da altura (10/12/14), lado 12/14/16, texto 13/14/15 e ícone 16/18/20 (`--control-*`). Pílula só para etiqueta que não se clica (status, contador, menção). Segmentado: itens 4px para dentro (3px no 32), raio de dentro = raio de fora − recuo.
- **Avatar:** agente e pessoa no mesmo quadro (raio 30% do lado). O agente fica em pé dentro do próprio céu em pixel (moldura "Céu"). O recibo de 18px e as cenas grandes (xl) ficam sem quadro.
- **Doto:** só em ocasião especial (".chat" do logo, landing, número grande de destaque). Contadores, badges, medidas e porcentagens usam a fonte normal com algarismos tabulares.
- **Conversa:** texto 15,5/1,7 em `--ink`, sem balão. Um layout só em toda conversa (canal, thread, DM com pessoa ou agente): alinhado à esquerda, o texto na largura toda da coluna (código e tabelas rolam dentro da própria caixa; uma tabela tem a largura das colunas). Os cartões de uma mensagem (ferramentas, o que o agente mudou, pedidos, arquivos) têm uma largura só, `--msg-card-w` (560px), e se destacam da placa de hover da linha: a face é `--raised-2` e um poço (código, a faixa de uma tabela, "Leu seu recado") é `--msg-well`. Numa resposta, as ferramentas vêm por último, depois do texto e do que mudou, ao vivo e salva; uma chamada só é a linha dela, sem "Usou 1 ferramenta". Na DM com agente, o chip do agente fica na linha das ferramentas do composer. Mensagens seguidas do mesmo autor se agrupam; ações aparecem ao passar o mouse. Resposta longa abre na primeira linha, com o botão "Fim da resposta".
