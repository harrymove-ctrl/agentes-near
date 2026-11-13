import { type Message, useApi } from "@agenteschat/client";
import { type ConsultNoticeFold, pairItemOf } from "@agenteschat/client/lib/consult-group";
import { agentsByAnyHandle } from "@agenteschat/client/lib/directory";
import { errorText } from "@agenteschat/client/lib/errors";
import { consultationOfNotice, noticeOf, stoppedNoticeOf } from "@agenteschat/client/lib/notices";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { EventPill, EventPillAction, EventPillText, ProviderLogo, useToast } from "@/ui";
import { useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { ConsultPairRow } from "./ConsultGroup";
import { eventLineOf } from "./logic";
import { useQuietInset } from "./look";
import { MessageText } from "./MessageText";
import { StoppedLine } from "./StoppedLine";

/**
 * An automatic line of the conversation, not a voice (the web's `NoticeLine`): what reached an agent's
 * conversation ("Rotina «Sentry» entregou um relatório" while the agent hasn't told it yet, "Infra
 * respondeu", "Nota de Dev", "Chegou o resultado que Ada esperava"), as one pill (`EventPill`) with its time; the
 * text opens under it on "Show", a follow-up still to come has "Cancel". The agent's own reply, if it has one,
 * follows as a normal message.
 * An answer the reply that asked shows (`ConsultGroup`, `fold`): nothing when that reply is close, the two agents'
 * pair row when it is farther up (a tap opens their conversation).
 * A task a person stopped has its own pill (`StoppedLine`), drawn in the stopped reply's when that reply is here.
 */
export function EventLine({ message, fold, gap }: { message: Message; fold?: ConsultNoticeFold; gap: number }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const when = useWhen();
  const [open, setOpen] = useState(false);
  const inset = useQuietInset();
  // A person stopped one of the agent's tasks (ADR 0128): its own line, with the reason, or a way to give one.
  const stopped = stoppedNoticeOf(message.meta);
  if (stopped) return <StoppedLine message={message} notice={stopped} gap={gap} />;
  if (fold?.fold === "hide") return null;
  // Farther up than the reply that asked: the same pair row where the answer arrived, opening their conversation.
  if (fold?.fold === "line")
    return (
      <ConsultPairRow
        askerId={fold.consultation.agentId}
        channelId={message.channelId}
        items={[fold.consultation]}
        gap={gap}
      />
    );
  // An answer from another agent that carries the consultation, its reply not here: the same pair row a reply
  // has (who asked whom), never the text written for the agent; a tap opens what they said.
  const consulted = consultationOfNotice(message.meta);
  const line = eventLineOf(
    message,
    {
      author: dir.nameOf(message.author) || t("channel.unknownAgent"),
      agentByHandle: (handle) => agentsByAnyHandle(dir.agents).get(handle.toLowerCase())?.name ?? null,
    },
    when,
  );
  if (consulted)
    return (
      <ConsultPairRow
        askerId={consulted.askerId}
        channelId={message.channelId}
        items={[pairItemOf(consulted.consultation)]}
        gap={gap}
      />
    );
  if (!line) return null;
  return (
    <View style={[styles.line, { paddingLeft: inset, marginTop: gap }]}>
      <EventPill
        mark={noticeOf(message.meta)?.kind === "github_event" ? <ProviderLogo id="github" size="xs" /> : line.icon}
        time={when.time(message.createdAt)}
        actions={[
          line.pending ? <CancelFollowUp key="cancel" messageId={message.id} /> : null,
          line.answer ? <AnswerGitHub key="answer" messageId={message.id} /> : null,
          line.detail ? (
            <EventPillAction
              key="show"
              label={open ? t("chat.notice.hide") : t("chat.notice.show")}
              expanded={open}
              onPress={() => setOpen((o) => !o)}
            />
          ) : null,
        ]}
        below={
          open && line.detail ? (
            <EventPillText>
              <MessageText
                body={
                  "content" in line.detail ? line.detail.content : t(line.detail.words.key, line.detail.words.values)
                }
              />
            </EventPillText>
          ) : null
        }
      >
        {t(line.key, line.values)}
      </EventPill>
    </View>
  );
}

/** "Cancel" on a follow-up still to come: the pill changes in place once the server has it. */
function CancelFollowUp({ messageId }: { messageId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const [busy, setBusy] = useState(false);
  return (
    <EventPillAction
      label={t("chat.notice.followUpCancel")}
      loading={busy}
      onPress={() => {
        setBusy(true);
        void api.chat
          .cancelFollowUp(orgId, messageId)
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    />
  );
}

/**
 * "Pedir resposta" on what someone the agent doesn't answer wrote on GitHub: the agent answers them there, with this
 * person behind it. The pill changes in place once the server has it; a refusal says why.
 */
function AnswerGitHub({ messageId }: { messageId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <EventPillAction
      label={t("chat.notice.github.ask")}
      loading={busy}
      onPress={() => {
        setBusy(true);
        void api.chat
          .answerGitHub(orgId, messageId)
          .catch((error: unknown) => toast({ title: errorText(t, error), icon: "x" }))
          .finally(() => setBusy(false));
      }}
    />
  );
}

const styles = StyleSheet.create({
  // Aligned with the messages' words, like `IssueTakenLine`; left aligned, never centered. The list sets its top.
  line: { paddingRight: 16 },
});
