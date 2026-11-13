import { elapsedClock } from "@agenteschat/client";
import {
  type ActivityEntry,
  activitySentence,
  activityVerb,
  barAsking,
  barFaces,
  barWords,
  listNames,
  markedPieces,
  markInk,
} from "@agenteschat/client/lib/activity";
import { Avatar, Icon } from "@agenteschat/ui";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentWho } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/**
 * The working line's pieces: the
 * stacked live mini bodies of who is on it, the sentence with names in ink
 * ("Theo e mais 2 estão trabalhando · Marina está digitando…", "Dev está
 * perguntando ao Infra…") and the clock of a question that is out.
 */

/** A marked sentence as plain text (what the leaving phrase reads). */
const plainText = (text: string) =>
  markedPieces(text)
    .map((p) => p.text)
    .join("");

/** Splits a marked sentence into text, bold names and faced names. */
export function boldNames(text: string): ReactNode[] {
  return markedPieces(text).map((p, i) =>
    p.agentId ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      <AgentWho key={i} agentId={p.agentId} name={p.text} />
    ) : p.bold ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: same
      <b key={i}>{p.text}</b>
    ) : (
      p.text
    ),
  );
}

/** The sentence with names in bold (its text content equals `activityText`). */
export function WorkingWords({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation();
  return <>{boldNames(activitySentence(t, entries, markInk))}</>;
}

/**
 * The card's phrase: one agent on its own is just its name (its row in the conversation says what it does), several
 * the sentence. Who is typing comes last, in a piece of its own that keeps its width (`barWords`).
 */
export function BarPhrase({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation();
  const [agents, sep, typers, typing] = barWords(t, entries, markInk);
  return (
    <>
      {agents && (
        <span className="ac-typing__agents">
          <TurnText text={agents} />
          {sep && <span className="ac-typing__and">{sep}</span>}
        </span>
      )}
      {typing && (
        <span className="ac-typing__people">
          <span className="ac-typing__typers">{boldNames(typers)}</span>
          {typing}
        </span>
      )}
    </>
  );
}

/**
 * One agent whose row is out of view: its name and its row's step ("Nina consultando o Email · …"). The step keeps
 * one width (cut with "…"), so its time and the controls after it never move under the pointer as it turns; the
 * whole step stays for screen readers and as the tip.
 */
export function BarStep({ name, step }: { name: string; step: string }) {
  return (
    <span className="ac-typing__agents">
      <b>{name}</b>{" "}
      <span className="ac-typing__step" title={step}>
        <TurnText text={step} />
      </span>
    </span>
  );
}

/**
 * Who is typing beside that agent, after its time: "· Marina digitando…". The names give way first, never what they
 * do; the time and the stop stay the agent's.
 */
export function BarAlsoTyping({ entries }: { entries: ActivityEntry[] }) {
  const { t } = useTranslation();
  const people = entries.flatMap((e) => (e.type === "person" ? [e.name] : []));
  if (people.length === 0) return null;
  return (
    <span className="ac-typing__also">
      <span className="ac-typing__typers">{boldNames(listNames(t, people, markInk))}</span>
      {` ${activityVerb(t, { kind: "typing" })}…`}
    </span>
  );
}

/**
 * A new phrase comes up from below while the old one leaves upward (just a swap with reduced motion).
 * The one leaving is drawn from an attribute, so the text on the page is only the phrase now.
 */
function TurnText({ text }: { text: string }) {
  const [shown, setShown] = useState({ now: text, was: null as string | null, n: 0 });
  if (shown.now !== text) setShown({ now: text, was: shown.now, n: shown.n + 1 });
  return (
    <span className="ac-turn">
      {shown.was !== null && (
        <span
          key={`was-${shown.n}`}
          className="ac-turn__out"
          aria-hidden="true"
          data-text={plainText(shown.was)}
          onAnimationEnd={() => setShown((s) => (s.n === shown.n ? { ...s, was: null } : s))}
        />
      )}
      <span key={`now-${shown.n}`} className="ac-turn__in" data-first={shown.n === 0 || undefined}>
        {boldNames(shown.now)}
      </span>
    </span>
  );
}

/**
 * The stacked mini bodies, a few at most (`barFaces`): each on a plate so overlaps stay readable. An agent
 * on its own asking another shows both, with an arrow (the one asked is thinking).
 */
export function WorkingStack({ entries }: { entries: ActivityEntry[] }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const asking = barAsking(entries);
  const tok = (key: string, node: ReactNode) => (
    <span key={key} className="ac-typing__tok">
      {node}
    </span>
  );
  return (
    <span className="ac-typing__avatars" aria-hidden="true">
      {barFaces(entries).map((e) => {
        if (e.type === "person")
          return tok(`p:${e.id}`, <Avatar size="xs" name={e.name} imageUrl={dir.memberById.get(e.id)?.image} />);
        if (asking && e.consult === asking)
          return (
            <Fragment key={`c:${e.id}`}>
              {tok(`a:${e.id}`, <AgentAvatar agentId={e.id} size="xs" name={e.name} state="idle" />)}
              <span className="ac-typing__to">
                <Icon name="arrowRight" size={14} />
              </span>
              {tok(
                `t:${asking.to}`,
                <AgentAvatar agentId={asking.to} size="xs" name={asking.toName} state="thinking" />,
              )}
            </Fragment>
          );
        return tok(`a:${e.id}`, <AgentAvatar agentId={e.id} size="xs" name={e.name} state="writing" />);
      })}
    </span>
  );
}

/** "0:41" next to the question the line tells (tabular figures); null when it tells none (`barAsking`). */
export function ConsultClock({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  const { t } = useTranslation();
  const asking = barAsking(entries);
  if (!asking) return null;
  const time = elapsedClock(now - asking.since);
  return (
    <span className="ac-typing__clock ac-num" role="timer" aria-label={t("chat.consult.clock", { time })}>
      {time}
    </span>
  );
}
