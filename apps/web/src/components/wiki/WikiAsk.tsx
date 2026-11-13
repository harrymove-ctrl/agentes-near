import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Dialog, DialogBody, DialogFooter, Field, Locked, Select, Textarea } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";

/**
 * "Pedir a um agente" from a page: the selected words and what to change go to the agent's DM with a link to the
 * page, as a message from the person. The agent edits with its wiki tools, so the version shows "a pedido de".
 */
export function WikiAskDialog({
  title,
  quote,
  suggested,
  onClose,
}: {
  /** The page's title (the message links it). */
  title: string;
  /** The selected words; empty asks about the whole page. */
  quote: string;
  /** Agents to offer first: who uses or wrote the page. */
  suggested: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const agents = dir.agents.filter((a) => canTalk(a));
  const first = suggested.find((id) => agents.some((a) => a.id === id)) ?? agents[0]?.id ?? "";
  const [agentId, setAgentId] = useState(first);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const agent = agents.find((a) => a.id === agentId);
  const send = async () => {
    if (!agent || !text.trim()) return;
    setSending(true);
    try {
      const quoted = quote
        ? `\n\n${quote
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n")}`
        : "";
      const body = `${t("wiki.ask.message", { title })}${quoted}\n\n${text.trim()}`;
      const { channelId } = await api.dms.open(org.id, { agentId: agent.id });
      await api.chat.post(org.id, channelId, { body });
      toast.show(t("wiki.ask.sent", { name: agent.name }));
      onClose();
    } catch (e) {
      toast.show(errorText(t, e), "error");
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.ask.title")}
      description={t("wiki.ask.text")}
      closeLabel={t("common.close")}
      unsaved={text.trim() !== ""}
      width={480}
    >
      <Locked when={sending}>
        <DialogBody className="wiki-ask">
          <Field label={t("wiki.ask.agent")}>
            <Select
              value={agentId}
              onValueChange={setAgentId}
              aria-label={t("wiki.ask.agent")}
              options={agents.map((a) => ({
                value: a.id,
                label: a.name,
                description: a.role || undefined,
                leading: <AgentAvatar agent={a} name={a.name} size="sm" />,
              }))}
            />
          </Field>
          {quote && <blockquote className="wiki-ask__quote">{quote}</blockquote>}
          <Field label={t("wiki.ask.what")}>
            <Textarea
              rows={3}
              value={text}
              placeholder={t("wiki.ask.placeholder")}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          </Field>
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          icon="send"
          loading={sending}
          disabled={sending || !agent || !text.trim()}
          onClick={() => void send()}
        >
          {agent ? t("wiki.ask.send", { name: agent.name }) : t("wiki.ask.sendNone")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
