# Design do agentes

Fonte de verdade visual para o frontend.

## Conteúdo
- `refresh-2026-10.md`: o design system atual (tokens, componentes, movimento).
- `design-system/README.md`: regras de uso (cor, forma, tipo, voz). Leia primeiro.
- `design-system/tokens.json` e `tokens.css`: tokens (claro/escuro via `data-theme`).
- `design-system/bundle.css`: estilos de referência dos componentes (classes `ac-*`).
- `design-system/<Componente>.md`: diretrizes por componente.
- `icons/`: ícones próprios (grid 20px, traço 1.6) e o símbolo do logo.
- `desktop/`: o papel de parede dos desktops dos agentes (`render.sh` gera os PNGs que o runner leva, ADR 0058 §15).

## Regras que não podem quebrar
- Azul (`agent`) só na identidade dos agentes: avatar, símbolo do logo, anel de "trabalhando", cursor de streaming.
- Cards neutros; estado só em chip com ícone (nunca bolinha, nunca card tingido).
- Mono só para código.
- Controles sempre próprios (select, checkbox, radio, menu, diálogo); nada com visual nativo.
- Barra de rolagem também é nossa com mouse ou trackpad: fina, arredondada, no tom da tinta, sem trilho nem setas (`packages/ui`, `components.css`). Na tela de toque fica o indicador do sistema, que só aparece rolando e não ocupa espaço. Faixas que rolam com o dedo (passos, chips, abas) escondem a sua em qualquer aparelho. O polegar para antes das pontas, dentro de qualquer canto arredondado. Uma lista que esmaece nas pontas com máscara termina a máscara com `var(--scroll-strip)`, para o esmaecido não apagar a barra. `apps/web/test/scrollbars-css.test.ts` guarda as regras.
- Listas longas e edição detalhada vão para diálogos com lista e busca.
