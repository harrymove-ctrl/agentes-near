import { type CodeToken, codeLabel, formatJson, highlightCode, isJsonLang } from "@agenteschat/client/lib/code";
import { Button, Dialog, DialogBody } from "@agenteschat/ui";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGrowFrom } from "@/lib/grow";

/**
 * Fenced code in a message or document: the language on top, copy
 * (the icon turns into "Copiado" for a moment) and full screen. Full screen grows out of the card itself
 * into a dialog with line numbers and an optional wrap; Esc closes. Colors from the shared highlighter
 * (`@agenteschat/client/lib/code`, the phone app uses the same one). `preview`: the block drawn (a diagram), shown
 * in place of the code until "Código" is pressed; full screen shows whichever is on. `action`: a button of the
 * block's own on top ("Ver diagrama"). JSON reads formatted (`formatJson`), its long lines wrapped under their own
 * indent, the text as written one press away ("Original"); copy takes what shows.
 */
export function CodeBlock({
  lang,
  text,
  preview,
  action,
}: {
  lang: string;
  text: string;
  preview?: ReactNode;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const formatted = useMemo(() => (isJsonLang(lang) ? formatJson(text) : null), [lang, text]);
  const [raw, setRaw] = useState(false);
  const pretty = formatted !== null && !raw;
  const shown = pretty ? formatted : text;
  const lines = useMemo(() => highlightCode(shown, lang), [shown, lang]);
  const label = codeLabel(lang) || t("common.code");
  const [open, setOpen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [code, setCode] = useState(false);
  const drawing = code ? null : preview;
  const card = useRef<HTMLDivElement>(null);
  const remember = useGrowFrom(open, card, ".code-viewer");
  const expand = () => {
    remember();
    setOpen(true);
  };

  return (
    <div className="code-card" ref={card}>
      <div className="code-card__top ac-actline">
        <span className="code-card__lang">{label}</span>
        <span className="ac-acts">
          {action}
          {preview && (
            <Button variant="ghost" size="sm" aria-pressed={code} onClick={() => setCode((c) => !c)}>
              {t("common.code")}
            </Button>
          )}
          {formatted !== null && formatted !== text.trim() && (
            <Button variant="ghost" size="sm" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
              {t("common.raw")}
            </Button>
          )}
          <CopyCode text={shown} />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="expand"
            aria-label={t("common.fullScreen")}
            title={t("common.fullScreen")}
            onClick={expand}
          />
        </span>
      </div>
      {drawing ? (
        <div className="code-card__preview">{drawing}</div>
      ) : (
        <pre className="code-card__code" data-wrap={pretty || undefined}>
          <code>
            <CodeLines lines={lines} hang={pretty} />
          </code>
        </pre>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={label}
        closeLabel={t("common.close")}
        width={920}
        className="code-viewer"
        actions={
          <>
            {!drawing && (
              <Button variant="ghost" size="sm" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
                {t("common.wrapLines")}
              </Button>
            )}
            <CopyCode text={shown} />
          </>
        }
      >
        <DialogBody className="code-viewer__body">
          {drawing ? (
            <div className="code-viewer__preview">{drawing}</div>
          ) : (
            <pre className="code-viewer__code" data-wrap={wrap}>
              <code>
                <CodeLines lines={lines} numbered />
              </code>
            </pre>
          )}
        </DialogBody>
      </Dialog>
    </div>
  );
}

/** `hang`: a wrapped line goes on under its own indent (`--hang`, its leading spaces), not at the block's edge. */
function CodeLines({
  lines,
  numbered = false,
  hang = false,
}: {
  lines: CodeToken[][];
  numbered?: boolean;
  hang?: boolean;
}) {
  return lines.map((line, i) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one block, in order
      key={i}
      className={numbered ? "code-line code-line--numbered" : "code-line"}
      style={hang ? ({ "--hang": `${line[0]?.text.match(/^ */)?.[0].length ?? 0}ch` } as CSSProperties) : undefined}
    >
      {line.map((tok, j) =>
        tok.kind === "plain" ? (
          tok.text
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the tokens of one line, in order
          <span key={j} className={`code-tok code-tok--${tok.kind}`}>
            {tok.text}
          </span>
        ),
      )}
      {i < lines.length - 1 ? "\n" : null}
    </span>
  ));
}

/** Copy, then "Copiado" with a check for a moment. */
function CopyCode({ text }: { text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1400);
      },
      () => {},
    );
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={done ? "check" : "copy"}
      className="code-card__copy"
      data-done={done}
      aria-label={done ? t("common.copied") : t("common.copy")}
      title={t("common.copy")}
      onClick={copy}
    >
      <span className="code-card__copied" aria-hidden="true">
        {t("common.copied")}
      </span>
    </Button>
  );
}
