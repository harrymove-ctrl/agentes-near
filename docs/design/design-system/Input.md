# Input

Campo de texto com rótulo sempre visível (`ac-field__label`), ajuda opcional (`ac-field__help`) e erro (`ac-field__error` + `aria-invalid="true"`). O placeholder dá exemplo, nunca substitui o rótulo. O **composer** é o campo de mensagem do chat: anexo à esquerda, envio (primary, só ícone) à direita, foco no contêiner inteiro.

## Formulário

Um ritmo só, em `Field`, `FormStack` e `DialogBody`: `--form-gap` (16) entre um campo e o próximo, `--field-gap` (4) entre rótulo, controle e ajuda. Nada de `gap` inline por tela. Um `Segmented` direto num `Field`, `FormStack` ou `DialogBody` ocupa a largura toda. Fora disso (ao lado do título de uma seção, numa coluna), use `block`. Um valor que se adiciona a uma lista (`AddressList`, modelos) usa o + dentro do campo (`AffixInput action`), e uma ação que só aparece com algo digitado não fica cinza antes disso.

- **Campos empilhados:** dentro de um `DialogBody` num dialog e de `FormStack` fora dele. `Locked` não tem caixa, então o que ele guarda segue o ritmo.
- **Segmented num formulário:** `<Field label group>`, ocupa a largura toda e o rótulo visível dá nome ao grupo.
- **Ação pequena do campo:** texto em `labelAside`, à direita do rótulo (`ac-link ac-link--muted small`). Botão de adicionar: `action` do `AffixInput`, um ghost `sm` só com ícone dentro do campo, e Enter faz o mesmo.
- **Botões:** `DialogFooter` num dialog, `FormActions` fora dele, Cancelar antes do primary. Enquanto salva, `Locked` nos campos e os dois botões desligados.
