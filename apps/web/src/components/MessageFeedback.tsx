import type { ReactionCount } from "@agenteschat/client";
import { useCorrectMessage } from "@agenteschat/client";
import { formatInt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button, Dialog, DialogBody, DialogFooter, Field, Locked, Textarea } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { useOrg } from "./org-context";
import { DOWN, ReactButton, reactionOf, reactionState, UP, useMessageReactions } from "./Reactions";

/**
 * 👍/👎 and "Corrigir resposta" on an agent reply. Both feed the agent's
 * learning (phase 5); 👍/👎 are reactions like any other (same pills under
 * the message). Also "Reagir" (any emoji) and `quick` actions ("Responder").
 * Shown on hover or keyboard focus, always reachable with Tab.
 */
export function MessageFeedback({
  messageId,
  agentName,
  active,
  initial,
  quick,
  more,
}: {
  messageId: string;
  agentName: string;
  /** The row was hovered or focused: load the reactions. */
  active: boolean;
  /** Reactions from the message list. */
  initial?: ReactionCount[];
  /** Before the feedback buttons (e.g. "Responder"). */
  quick?: ReactNode;
  /** The "…" menu (Salvar na wiki, Copiar link, Responder em thread). */
  more?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const { me } = useOrg();
  const reactions = useMessageReactions(messageId, initial, { feedback: true, load: active });
  const [correcting, setCorrecting] = useState(false);
  const up = reactionState(reactions.list, UP, me.user.id);
  const down = reactionState(reactions.list, DOWN, me.user.id);

  return (
    <>
      <div
        className="ac-msg__actions"
        role="toolbar"
        aria-label={t("channel.actions", { name: agentName })}
        data-open={correcting}
      >
        <ReactButton onPick={(emoji) => reactions.toggle(reactionOf(emoji))} />
        {quick}
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("channel.helpful")}
          aria-pressed={up.mine}
          disabled={reactions.pending}
          icon="thumbUp"
          onClick={() => reactions.toggle(UP)}
        >
          {up.count > 0 && <span className="ac-msg__reaction-count">{formatInt(i18n.language, up.count)}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("channel.notHelpful")}
          aria-pressed={down.mine}
          disabled={reactions.pending}
          icon="thumbDown"
          onClick={() => reactions.toggle(DOWN)}
        >
          {down.count > 0 && <span className="ac-msg__reaction-count">{formatInt(i18n.language, down.count)}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="edit"
          aria-label={t("channel.correct")}
          onClick={() => setCorrecting(true)}
        />
        {more}
      </div>
      <CorrectionDialog open={correcting} onOpenChange={setCorrecting} messageId={messageId} agentName={agentName} />
    </>
  );
}

export function CorrectionDialog({
  open,
  onOpenChange,
  messageId,
  agentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string;
  agentName: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const correct = useCorrectMessage(org.id);
  const [text, setText] = useState("");
  const g = agentGrammar(agentName);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setText("");
      }}
      title={t("channel.correctTitle", g)}
      closeLabel={t("common.close")}
      unsaved={text.trim() !== ""}
      width={480}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          correct.mutate(
            { messageId, body: text.trim() },
            {
              onSuccess: () => {
                toast.show(t("channel.correctionSent", g));
                setText("");
                onOpenChange(false);
              },
            },
          );
        }}
      >
        <Locked when={correct.isPending}>
          <DialogBody>
            <Field
              label={t("channel.correctLabel")}
              id={`correct-${messageId}`}
              hint={{
                name: t("common.about", { label: t("channel.correctLabel") }),
                text: t("channel.correctHelp", g),
              }}
            >
              <Textarea
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("channel.correctPlaceholder")}
                autoFocus
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!text.trim() || correct.isPending}
            loading={correct.isPending}
          >
            {t("channel.sendCorrection")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
