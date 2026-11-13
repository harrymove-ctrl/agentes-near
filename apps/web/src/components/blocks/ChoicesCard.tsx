import { useAnswerChoices, useArtifact, useChoices } from "@agenteschat/client";
import {
  answeredFirst,
  CHOICE_OTHER_MAX,
  type ChoiceDraft,
  choiceLetter,
  choiceOfKey,
  choiceSummary,
  emptyDraft,
  moveStep,
  otherChoice,
  pickChoice,
} from "@agenteschat/client/lib/choices";
import { Button, Spinner, Textarea } from "@agenteschat/ui";
import { type KeyboardEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { CardSky, colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { codeAndBold, inlineWords } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import "./blocks.css";

/**
 * An agent asks the person to pick (ADR 0124): options as big rows lettered A, B, C…, one question at a time. A click
 * (or its letter, or arrows and Enter) answers at once: it goes to the agent as the person's message, and the card
 * then shows what was picked to everyone. The last row, "Outra resposta", opens a field to write the answer instead,
 * sent with Enviar (or Enter). The app's own card, like a vote: a pick is an act of the person's.
 */
export function ChoicesCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const artifact = useArtifact(org.id, id, version);
  const query = useChoices(org.id, id);
  const answer = useAnswerChoices(org.id, id);
  const [draft, setDraft] = useState<ChoiceDraft | null>(null);
  const [closed, setClosed] = useState(false);
  // "Outra resposta" open on the question in view, and what is being written there.
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const list = useRef<HTMLFieldSetElement>(null);
  const a = artifact.data;
  if (a?.content.kind !== "choices" || !query.data) {
    return (
      <div className="live-block live-block--loading" aria-busy="true">
        <Spinner />
        <span>{t("blocks.building")}</span>
      </div>
    );
  }
  const { questions } = a.content;
  const answered = query.data.answer;
  const agent = dir.anyAgent(a.createdBy.id);

  if (answered) {
    const by = dir.memberById.get(answered.userId)?.name ?? t("blocks.someone");
    return (
      <section className="live-block choices" aria-label={a.title} data-answered="">
        <CardSky color={colorOf(agent)} />
        <header className="live-block__head">
          <span className="live-block__titles">
            <b>{a.title}</b>
            <small>{t("choices.answeredBy", { name: by })}</small>
          </span>
        </header>
        <ul className="choices__summary">
          {choiceSummary(questions, answered.picks, answered.others).map((s) => (
            <li key={s.question}>
              {questions.length > 1 && <span className="choices__asked">{inlineWords(s.question, "sq")}</span>}
              <span className="choices__picked">
                <span className="choices__letter" aria-hidden="true">
                  {s.letter}
                </span>
                <span className="choices__said" data-written={s.written ? "" : undefined}>
                  {codeAndBold(s.label, "s")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  if (closed) {
    return (
      <p className="choices__closed">
        <span>{t("choices.closed", { title: a.title })}</span>
        <button type="button" className="ac-link" onClick={() => setClosed(false)}>
          {t("choices.reopen")}
        </button>
      </p>
    );
  }

  const d = draft ?? emptyDraft(questions);
  const q = questions[d.step];
  if (!q) return null;
  const other = otherChoice(q);
  // Another question's options replace the focused button: the first of them takes the focus, so keys keep working.
  const focusFirst = () =>
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>("button")?.focus());
  const closeWriting = () => {
    setWriting(false);
    setText("");
  };
  const pick = (option: number, written?: string) => {
    if (answer.isPending) return;
    const next = pickChoice(d, option, written);
    setDraft(next.draft);
    closeWriting();
    if (next.send)
      answer.mutate(next.send, {
        onError: (e) => {
          if (!answeredFirst(e)) toast.show(t("choices.failed"), "error");
          void query.refetch();
        },
      });
    else focusFirst();
  };
  // What was written before on this question comes back in the field.
  const write = () => {
    setText(d.others[d.step] ?? "");
    setWriting(true);
  };
  const send = () => {
    const words = text.trim();
    if (words) pick(other, words);
  };
  const go = (next: ChoiceDraft) => {
    setDraft(next);
    closeWriting();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFieldSetElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const letter = choiceOfKey(e.key, q.options.length + 1);
    if (letter !== null) {
      e.preventDefault();
      if (letter === other) write();
      else pick(letter);
      return;
    }
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>(".choices__option") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const by = e.key === "ArrowDown" ? 1 : -1;
      rows[(at + by + rows.length) % rows.length]?.focus();
    } else if (questions.length > 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const next = moveStep(d, e.key === "ArrowRight" ? 1 : -1);
      go(next);
      if (next !== d) focusFirst();
    }
  };
  return (
    <section className="live-block choices" aria-label={a.title}>
      <CardSky color={colorOf(agent)} />
      <header className="live-block__head">
        <span className="live-block__titles">
          <b>{a.title}</b>
          {questions.length > 1 && <small>{t("choices.step", { step: d.step + 1, total: questions.length })}</small>}
        </span>
        <span className="ac-acts">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="close"
            aria-label={t("choices.close")}
            title={t("choices.close")}
            onClick={() => setClosed(true)}
          />
        </span>
      </header>
      <p className="choices__question" id={`choices-${id}-q`}>
        {inlineWords(q.question, "q")}
      </p>
      <fieldset
        ref={list}
        className="choices__options"
        aria-labelledby={`choices-${id}-q`}
        aria-keyshortcuts={[...q.options.map((_, i) => choiceLetter(i)), choiceLetter(other)].join(" ")}
        onKeyDown={onKeyDown}
      >
        {q.options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            className="choices__option ac-mediarow ac-mediarow--row"
            aria-pressed={d.picks[d.step] === i}
            disabled={answer.isPending}
            onClick={() => pick(i)}
          >
            <span className="ac-mediarow__face">
              <span className="choices__letter" aria-hidden="true">
                {choiceLetter(i)}
              </span>
            </span>
            <span className="ac-mediarow__head">
              <span className="choices__label">{codeAndBold(o.label, "l")}</span>
            </span>
            {o.description && (
              <span className="ac-mediarow__body">
                <span className="choices__description">{codeAndBold(o.description, "d")}</span>
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="choices__option ac-mediarow ac-mediarow--row"
          aria-pressed={d.picks[d.step] === other}
          aria-expanded={writing}
          disabled={answer.isPending}
          onClick={write}
        >
          <span className="ac-mediarow__face">
            <span className="choices__letter" aria-hidden="true">
              {choiceLetter(other)}
            </span>
          </span>
          <span className="ac-mediarow__head">
            <span className="choices__label">{t("ask.otherAnswer")}</span>
          </span>
          {d.others[d.step] && !writing && (
            <span className="ac-mediarow__body">
              <span className="choices__description">{d.others[d.step]}</span>
            </span>
          )}
        </button>
      </fieldset>
      {writing && (
        <div className="choices__write">
          <Textarea
            rows={2}
            autoGrow
            autoFocus
            value={text}
            maxLength={CHOICE_OTHER_MAX}
            placeholder={t("question.placeholder")}
            aria-label={t("question.placeholder")}
            disabled={answer.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <span className="choices__write-acts">
            <Button
              size="sm"
              variant="primary"
              disabled={!text.trim() || answer.isPending}
              loading={answer.isPending}
              onClick={send}
            >
              {t("channel.send")}
            </Button>
            <Button size="sm" variant="ghost" disabled={answer.isPending} onClick={closeWriting}>
              {t("common.cancel")}
            </Button>
          </span>
        </div>
      )}
      {questions.length > 1 && (
        <div className="live-block__foot choices__foot">
          <Button size="sm" variant="ghost" disabled={d.step === 0} onClick={() => go(moveStep(d, -1))}>
            {t("choices.back")}
          </Button>
          <span className="choices__dots" aria-hidden="true">
            {questions.map((qq, i) => (
              <span
                key={qq.question}
                className="choices__dot"
                data-on={i === d.step ? "" : undefined}
                data-done={d.picks[i] !== null ? "" : undefined}
              />
            ))}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={d.step === questions.length - 1 || d.picks[d.step] === null}
            onClick={() => go(moveStep(d, 1))}
          >
            {t("choices.next")}
          </Button>
        </div>
      )}
    </section>
  );
}
