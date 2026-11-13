import { afterEach, expect, test } from "bun:test";
import { artifactFile, crc32, createArtifact, markdownToDocx, readZip } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const parts = (docx: Uint8Array) =>
  Object.fromEntries(
    readZip(docx, { maxFiles: 50, maxBytes: 5_000_000 }).map((e) => [e.path, new TextDecoder().decode(e.data)]),
  );

test("crc32 matches the standard check value", () => {
  expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
});

test("markdown becomes a Word document: headings, inline styles, links, lists, quotes, code, tables, rules", () => {
  const docx = markdownToDocx(
    [
      "# Relatório & resumo",
      "",
      "Texto com **negrito**, *itálico*, `código` e [o site](https://agentes.chat).",
      "",
      "- um",
      "- dois",
      "",
      "1. primeiro",
      "2. segundo",
      "",
      "> uma citação",
      "",
      "```",
      "const x = 1 < 2;",
      "```",
      "",
      "| mês | total |",
      "|---|---|",
      "| jan | 10 |",
      "",
      "---",
    ].join("\n"),
    { title: "Março" },
  );
  expect(Array.from(docx.slice(0, 2))).toEqual([0x50, 0x4b]); // a zip
  const p = parts(docx);
  expect(Object.keys(p).sort()).toEqual([
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/numbering.xml",
    "word/styles.xml",
  ]);
  const doc = p["word/document.xml"] ?? "";
  expect(doc).toContain('<w:pStyle w:val="Title"/>');
  expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
  expect(doc).toContain("Relatório &amp; resumo");
  expect(doc).toContain('<w:b/></w:rPr><w:t xml:space="preserve">negrito</w:t>');
  expect(doc).toContain('<w:i/></w:rPr><w:t xml:space="preserve">itálico</w:t>');
  expect(doc).toContain('w:ascii="Martian Mono"');
  expect(doc).toContain('<w:hyperlink r:id="rLink1">');
  expect(p["word/_rels/document.xml.rels"]).toContain('Target="https://agentes.chat" TargetMode="External"');
  expect(doc).toContain('<w:numId w:val="1"/>'); // bullets
  expect(doc).toContain('<w:numId w:val="4"/>'); // the second list (numbered) restarts
  expect(p["word/numbering.xml"]).toContain('<w:numFmt w:val="decimal"/>');
  expect(doc).toContain('<w:pStyle w:val="Quote"/>');
  expect(doc).toContain('<w:pStyle w:val="Code"/>');
  expect(doc).toContain("const x = 1 &lt; 2;");
  expect(doc).toContain("<w:tbl>");
  expect(doc).toContain("<w:tblHeader/>");
  expect(doc).toContain('<w:bottom w:val="single" w:sz="6"');
  expect(p["word/styles.xml"]).toContain('w:ascii="Onest"');
  expect(p["docProps/core.xml"]).toContain("<dc:title>Março</dc:title>");
});

test("documents and tables download as .docx; other kinds can't", async () => {
  f = await setup();
  const person = { type: "person" as const, userId: f.owner.id };
  const doc = await createArtifact(f.artifactDeps, person, f.org.id, {
    title: "Plano",
    content: { kind: "document", markdown: "# Plano\n\n- item" },
  });
  const file = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, doc.id, { format: "docx" });
  expect(file.contentType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  expect(file.filename).toBe("Plano-v1.docx");
  expect(parts(file.body)["word/document.xml"]).toContain("Plano");
  const table = await createArtifact(f.artifactDeps, person, f.org.id, {
    title: "Metas",
    content: { kind: "table", columns: ["mês"], rows: [["jan"]] },
  });
  const t = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, table.id, { format: "docx" });
  expect(parts(t.body)["word/document.xml"]).toContain("<w:tbl>");
  const diagram = await createArtifact(f.artifactDeps, person, f.org.id, {
    title: "Fluxo",
    content: { kind: "diagram", mermaid: "graph TD; A-->B" },
  });
  await expect(artifactFile(f.artifactDeps, f.owner.id, f.org.id, diagram.id, { format: "docx" })).rejects.toThrow(
    "DOCX",
  );
});
