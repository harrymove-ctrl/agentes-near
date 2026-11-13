import { describe, expect, test } from "bun:test";
import { dropSquashedEcho } from "../src/executor";
import { opensWith } from "../src/jobs";

describe("a computer brain's answer with a squashed echo", () => {
  test("the copy of its first words without spaces is cut", () => {
    const real = "Esse pedido é pro Theo, que é quem tem o navegador aberto no app, então não vou navegar por ele.";
    const echo = "EssepedidoéproTheo,queéquemtemonavegadorabertonoapp,entãonãovounavegar";
    expect(dropSquashedEcho(`${echo}${real}`)).toBe(real);
    const short = "Nada novo. Desde 19/10 não chegou nada na INBOX.";
    expect(dropSquashedEcho(`Nadanovo.Desde19/10${short}`)).toBe(short);
  });

  test("a normal answer, a long first word or a link stays as it is", () => {
    for (const text of [
      "Deploy ok, nada mudou.",
      "Pneumoultramicroscopicossilicovulcanoconiótico é uma palavra longa.",
      "https://agentes.chat/c/general https://agentes.chat/c/general",
    ])
      expect(dropSquashedEcho(text)).toBe(text);
  });
});

describe("an agent's message spoken to another agent", () => {
  test("the handle that opens the message (after other leading mentions) is addressed", () => {
    expect(opensWith("@Ada já postei o que achei logo acima.", "ada")).toBe(true);
    expect(opensWith("  @theo, @ada vejam isso", "ada")).toBe(true);
    expect(opensWith("Achei dois pontos. A @ada pode ajustar depois.", "ada")).toBe(false);
    expect(opensWith("@adam oi", "ada")).toBe(false);
  });
});
