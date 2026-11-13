import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { receiptFiles } from "@agenteschat/client/lib/actions";
import { joinNames } from "@agenteschat/client/lib/format";
import { parseInline } from "../../src/features/chat/logic";
import { translator } from "./fixtures";

/** A file of the app, as text: what a pill does lives in components the tests can't render. */
const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/chat", path), "utf8");

const FILE = "019a1b74-5b85-74a8-9ffa-f9a6ace806d8";

describe("an internal id in a text on the phone", () => {
  test("is a part of its own with the word that names its kind, so the pill takes its place", () => {
    expect(parseInline(`Na referência (artifact ${FILE}) e id=${FILE.toUpperCase()}.`)).toEqual([
      { kind: "text", text: "Na referência (" },
      { kind: "id", text: `artifact ${FILE}`, id: FILE },
      { kind: "text", text: ") e " },
      { kind: "id", text: `id=${FILE.toUpperCase()}`, id: FILE },
      { kind: "text", text: "." },
    ]);
  });

  test("inside a path, an address or code with more in it, it stays as written", () => {
    expect(parseInline(`exemplo.com/pedidos/${FILE}`)).toEqual([{ kind: "text", text: `exemplo.com/pedidos/${FILE}` }]);
    expect(parseInline(`exemplo.com/p?id=${FILE}`)).toEqual([{ kind: "text", text: `exemplo.com/p?id=${FILE}` }]);
    expect(parseInline(`\`grep ${FILE} log\``)).toEqual([{ kind: "code", text: `grep ${FILE} log` }]);
    expect(parseInline(`https://exemplo.com/${FILE}`)[0]?.kind).toBe("link");
  });

  test("alone in a code span, as agents write ids too, it is a pill that falls back to its code", () => {
    expect(parseInline(`o print \`${FILE}\``)).toEqual([
      { kind: "text", text: "o print " },
      { kind: "id", text: FILE, id: FILE, code: true },
    ]);
  });

  test("its pill opens the file or the task, a message's is the message pill, and the id never shows while it loads", () => {
    const pill = source("IdRefText.tsx");
    // A file's is the file's pill, as a file's link shows it.
    expect(pill).toContain(
      'if (ref.kind === "file") return <FilePillText orgId={orgId} id={ref.id} title={ref.title} />;',
    );
    expect(source("FileRefText.tsx")).toContain('router.push({ pathname: "/file/[id]", params: { id, ...(version ?');
    expect(pill).toMatch(/router\.push\(`\/issues\/\$\{ref\.number\}`\)/);
    expect(pill).toContain("<MessageRefText");
    expect(pill).toContain("if (query.isPending) {");
    expect(pill).toContain("if (!ref) return shown;");
    expect(source("MessageSpans.tsx")).toContain('case "id":');
  });
});

describe("the receipt of a task an agent made with a file, on the phone", () => {
  test("says which files went with it, on a line of its own under the row", async () => {
    const t = await translator("pt-BR");
    const files = receiptFiles({ kind: "issue.created", params: { number: 13, files: ["print.png", "log.txt"] } });
    expect(t("agentActions.issue.files", { names: joinNames(files, t) })).toBe("Anexei print.png e log.txt");
    expect(receiptFiles({ kind: "routine.created", params: { files: ["x"] } })).toEqual([]);
    expect(source("Receipts.tsx")).toContain("{lines.files ? <UnderLine text={lines.files} /> : null}");
  });
});
