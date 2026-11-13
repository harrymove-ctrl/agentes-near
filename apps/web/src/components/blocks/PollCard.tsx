import type { Poll } from "@agenteschat/client";
import { useArtifact, usePoll, useVote } from "@agenteschat/client";
import { pollAnswered, pollIsOpen, pollTally, pollToggle } from "@agenteschat/client/lib/blocks";
import { AvatarStack, Icon, Spinner } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { PersonAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { CardSky, colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { inlineWords } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import "./blocks.css";

const FACES = 5;

/**
 * A vote in the conversation (ADR 0113). The app's own card, never a page: a vote is an act of the person's, and a
 * page in a frame could cast one the moment it showed. Everyone sees the marks arrive (`poll.updated`).
 */
export function PollCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const artifact = useArtifact(org.id, id, version);
  const query = usePoll(org.id, id);
  const vote = useVote(org.id, id);
  const a = artifact.data;
  const poll: Poll | undefined = query.data;
  if (a?.content.kind !== "poll" || !poll) {
    return (
      <div className="live-block live-block--loading" aria-busy="true">
        <Spinner />
        <span>{t("blocks.building")}</span>
      </div>
    );
  }
  const { options, multiple, question } = a.content;
  const open = pollIsOpen(poll);
  const answered = pollAnswered(poll);
  const tally = pollTally(options, poll);
  const top = Math.max(...tally.map((o) => o.voters.length));
  const nameOf = (userId: string) => dir.memberById.get(userId)?.name ?? t("blocks.someone");
  const closes = new Date(poll.closesAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  return (
    <section className="live-block" aria-label={question}>
      <CardSky color={colorOf(dir.anyAgent(a.createdBy.id))} />
      <header className="live-block__head">
        <span className="live-block__titles">
          <b>{inlineWords(question, "pq")}</b>
          <small>{open ? t("blocks.pollCloses", { time: closes }) : t("blocks.pollClosed")}</small>
        </span>
      </header>
      <div className="poll__options">
        {tally.map((o) => {
          const mine = o.voters.includes(me.user.id);
          const won = !open && top > 0 && o.voters.length === top;
          return (
            <button
              key={o.option}
              type="button"
              className="poll__option"
              aria-pressed={mine}
              data-won={won ? "" : undefined}
              disabled={!open || vote.isPending}
              onClick={() =>
                vote.mutate(pollToggle(poll, me.user.id, o.option, multiple), {
                  onError: () => toast.show(t("blocks.voteFailed"), "error"),
                })
              }
            >
              {/* The share fills the option up to its faces, never under them: their rings stay the card's face. */}
              <span className="poll__track">
                <span className="poll__fill" style={{ width: `${o.share * 100}%` }} />
                <span className="poll__box">{mine && <Icon name="check" size={14} />}</span>
                <span className="poll__label">{o.label}</span>
              </span>
              {o.voters.length > 0 && (
                // Each voter's face as the conversation shows it: the photo, else the initials.
                <span className="poll__faces" role="img" aria-label={o.voters.map(nameOf).join(", ")}>
                  <AvatarStack>
                    {o.voters.slice(0, FACES).map((v) => (
                      <PersonAvatar key={v} id={v} name={nameOf(v)} size="sm" title={nameOf(v)} />
                    ))}
                  </AvatarStack>
                  {o.voters.length > FACES && (
                    <span className="poll__more" title={o.voters.slice(FACES).map(nameOf).join(", ")}>
                      +{o.voters.length - FACES}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {multiple && open && <p className="poll__note">{t("blocks.pollMultiple")}</p>}
      <div className="live-block__foot">
        <span className="live-block__sent">
          <span className="live-block__mark" data-open={open ? "" : undefined} aria-hidden="true" />
          {t("blocks.pollAnswered", { count: answered, total: poll.people })}
        </span>
      </div>
    </section>
  );
}
