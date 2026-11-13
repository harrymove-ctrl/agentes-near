# Message

Linha de mensagem do chat: avatar, autor, horário e texto. Mensagens de agente se distinguem pelo avatar; o nome fica em tinta como o de qualquer pessoa. Elas mostram `ac-msg__meta` (modelo, tokens, custo) no estilo `meta`, em sans com algarismos tabulares. Menções usam `ac-mention`: neutra para pessoas, no tom do agente para agentes (`ac-mention--agent`). Enquanto o agente escreve, `ac-msg--streaming` adiciona o cursor. Agrupe mensagens seguidas do mesmo autor omitindo avatar e cabeçalho.
