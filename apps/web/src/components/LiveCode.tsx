import type { LiveCode, LiveOutput } from "@agenteschat/client";
import { nearBottom } from "@agenteschat/client/lib/chat";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Icon } from "@agenteschat/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";

const KEYWORDS = new Set([
  // Python
  "def",
  "return",
  "import",
  "from",
  "as",
  "for",
  "in",
  "if",
  "elif",
  "else",
  "while",
  "class",
  "with",
  "try",
  "except",
  "finally",
  "raise",
  "lambda",
  "pass",
  "None",
  "True",
  "False",
  "and",
  "or",
  "not",
  // JS / TS / shell
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "new",
  "export",
  "null",
  "undefined",
  "true",
  "false",
  "then",
  "fi",
  "do",
  "done",
  "echo",
]);

export type CodeToken = { kind: "comment" | "string" | "keyword" | "number" | "text"; text: string };

/** A light tokenizer (no highlighter library): comments, strings, numbers and keywords; the rest is text. */
export function tokenizeCode(source: string): CodeToken[] {
  const out: CodeToken[] = [];
  const re =
    /(#[^\n]*|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  for (const m of source.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: source.slice(last, at) });
    const [all, comment, string, number, word] = m;
    if (comment) out.push({ kind: "comment", text: all });
    else if (string) out.push({ kind: "string", text: all });
    else if (number) out.push({ kind: "number", text: all });
    else if (word && KEYWORDS.has(word)) out.push({ kind: "keyword", text: all });
    else out.push({ kind: "text", text: all });
    last = at + all.length;
  }
  if (last < source.length) out.push({ kind: "text", text: source.slice(last) });
  // Merge adjacent text tokens.
  return out.reduce<CodeToken[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.kind === "text" && tok.kind === "text") prev.text += tok.text;
    else acc.push({ ...tok });
    return acc;
  }, []);
}

/** The code, mono, with the light tokens. */
export function CodeView({ code }: { code: LiveCode }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("code.source", { language: code.language })}>
      <pre className="live-code__src">
        <code>
          {tokenizeCode(code.source).map((tok, i) =>
            tok.kind === "text" ? (
              tok.text
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: static tokens of one source
              <span key={i} className={`live-code__${tok.kind}`}>
                {tok.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </section>
  );
}

/** The terminal-style output: stdout neutral, stderr in the danger tone; follows new output while at the bottom. */
export function OutputView({ output, live }: { output: LiveOutput[]; live?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const size = output.reduce((n, o) => n + o.text.length, 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow whenever output grows
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size]);
  return (
    <section aria-label={t("code.output")} aria-live={live ? "polite" : undefined}>
      <pre
        ref={ref}
        className="live-code__out"
        onScroll={(e) => {
          pinned.current = nearBottom(e.currentTarget);
        }}
      >
        {output.length === 0 ? (
          <span className="live-code__empty">{live ? t("code.waiting") : t("code.noOutput")}</span>
        ) : (
          output.map((o, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: output chunks in order
            <span key={i} className={o.stream === "stderr" ? "live-code__stderr" : "live-code__stdout"}>
              {o.text}
            </span>
          ))
        )}
      </pre>
    </section>
  );
}

/** Code + output with "copiar" (the code). Used live in the activity bar and in the work summary. */
export function CodePanel({
  code,
  output,
  live,
  header,
}: {
  code: LiveCode;
  output: LiveOutput[];
  live?: boolean;
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <div className="live-code">
      <div className="live-code__bar">
        <span className="small muted">{header ?? code.language}</span>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard?.writeText(code.source);
            toast.show(t("code.copied"));
          }}
        >
          {t("code.copy")}
        </Button>
      </div>
      <CodeView code={code} />
      <OutputView output={output} live={live} />
    </div>
  );
}

/** "Ver código" under the activity bar: opens the live code and output of the agents running code. */
export function LiveCodeToggle({ name, code, output }: { name: string; code: LiveCode; output: LiveOutput[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="live-code-toggle">
      <button type="button" className="live-code-toggle__btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="code" size={14} />
        {open ? t("code.hide") : t("code.show", agentGrammar(name))}
      </button>
      {open && <CodePanel code={code} output={output} live header={t("code.running", { name })} />}
    </div>
  );
}

/** "3,4 KB" / "820 B". */
export function formatBytes(locale: string, bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(kb)} KB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(kb / 1024)} MB`;
}

/** A message that went into the running task, as the agent took it in. */
export interface SteerNote {
  /** Its author's name. */
  author: string;
  /** I wrote it ("seu recado"). */
  mine: boolean;
  text: string;
}

/**
 * "Leu seu recado · separa por iPhone e Android" in a well under the reply's tools; "Parou para ler seu
 * recado" when the person asked it to stop and read now.
 */
export function SteerWell({ now, note }: { now: boolean; note: SteerNote | undefined }) {
  const { t } = useTranslation();
  const title = note
    ? now
      ? note.mine
        ? t("run.well.nowYours")
        : t("run.well.nowOf", { name: note.author })
      : note.mine
        ? t("run.well.readYours")
        : t("run.well.readOf", { name: note.author })
    : now
      ? t("run.well.nowYours")
      : t("run.well.readYours");
  return (
    <p className="live-work__steer ac-iconline">
      <Icon name={now ? "bolt" : "checks"} size={14} />
      <b>{title}</b>
      {note?.text && <q>{note.text}</q>}
    </p>
  );
}
