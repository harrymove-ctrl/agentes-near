import { describe, expect, test } from "bun:test";
import { artifactRefs, documentStart, parseDelimited } from "../src/lib/artifacts";

describe("a message's files (`meta.artifacts`)", () => {
  test("a file listed twice shows once, at its newest version", () => {
    const meta = {
      artifacts: [
        { id: "a", version: 1 },
        { id: "b", version: 1 },
        { id: "a", version: 1 },
        { id: "a", version: 2 },
      ],
    };
    expect(artifactRefs(meta)).toEqual([
      { id: "a", version: 2 },
      { id: "b", version: 1 },
    ]);
  });

  test("only entries it can show", () => {
    expect(artifactRefs({ artifacts: [null, { id: 1 }, { id: "x", deleted: true, title: "x.png" }] })).toEqual([
      { id: "x", deleted: true, title: "x.png" },
    ]);
    expect(artifactRefs(undefined)).toEqual([]);
  });
});

describe("parseDelimited (a CSV's tile cover)", () => {
  test("its first lines as rows, quotes understood, CRLF too, no more than asked", () => {
    const csv = 'Cliente,Valor\r\n"Acme, Ltda",10\r\n"Diz ""oi""",20\r\nBeta,30\r\n';
    expect(parseDelimited(csv, ",", 3)).toEqual([
      ["Cliente", "Valor"],
      ["Acme, Ltda", "10"],
      ['Diz "oi"', "20"],
    ]);
    expect(parseDelimited("a\tb\n1\t2", "\t", 10)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("documentStart (a document's tile cover)", () => {
  test("a short document whole; a long one cut at its last line within the limit", () => {
    expect(documentStart("# Título\n\nTexto", 100)).toBe("# Título\n\nTexto");
    const long = `# Título\n\n${"a".repeat(60)}\n${"b".repeat(60)}`;
    expect(documentStart(long, 100)).toBe(`# Título\n\n${"a".repeat(60)}`);
    // No line break in the second half: cut at the limit.
    expect(documentStart("x".repeat(150), 100)).toBe("x".repeat(100));
  });
});
