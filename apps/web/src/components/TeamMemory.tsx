import { useMemoryAction, useTeamMemories } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { memoryLine } from "@agenteschat/client/lib/proposals";
import { Button, Card, CardHeader, Field, Locked, Textarea } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingLine } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { memorySource } from "@/pages/MemoryPage";

/**
 * Memória do time (ADR 0167): what people asked every agent to keep, with who and when, under the context every agent
 * reads. Editar keeps the old version in the history; Remover archives it.
 */
export function TeamMemoryCard() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const editable = can(org, "review_memory");
  const list = useTeamMemories(org.id);
  const act = useMemoryAction(org.id, "");
  const toast = useToast();
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const title = t("teamMemory.title");
  const items = list.data ?? [];
  const save = () =>
    draft &&
    act.mutate(
      { type: "edit", id: draft.id, text: draft.text },
      {
        onSuccess: () => {
          setDraft(null);
          toast.show(t("agentPage.memory.saved"));
        },
      },
    );
  return (
    <Card aria-labelledby="sec-team-memory">
      <CardHeader
        id="sec-team-memory"
        icon="members"
        title={title}
        hint={{ name: t("common.about", { label: title }), text: t("teamMemory.help") }}
      />
      {list.isPending ? (
        <LoadingLine />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <p className="small muted">{t("teamMemory.empty")}</p>
      ) : (
        <ul className="list-col">
          {items.map((m) => (
            <li key={m.id} className="agp-mem">
              {draft?.id === m.id ? (
                <Locked when={act.isPending}>
                  <Field label={t("agentPage.memory.edit")} id={`team-${m.id}`}>
                    <Textarea
                      rows={3}
                      maxLength={8000}
                      value={draft.text}
                      onChange={(e) => setDraft({ id: m.id, text: e.target.value })}
                    />
                  </Field>
                </Locked>
              ) : (
                <span>{m.summary ?? memoryLine(t, m)}</span>
              )}
              <span className="small muted">{memorySource(t, i18n.language, m)}</span>
              {editable && (
                <span className="agp-row">
                  {draft?.id === m.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!draft.text.trim()}
                        loading={act.isPending}
                        onClick={save}
                      >
                        {t("agentPage.memory.save")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                        {t("agentPage.memory.cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="edit"
                        onClick={() => setDraft({ id: m.id, text: m.text })}
                      >
                        {t("agentPage.memory.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={act.isPending}
                        onClick={() =>
                          act.mutate(
                            { type: "archive", id: m.id, archived: true },
                            { onSuccess: () => toast.show(t("teamMemory.removed")) },
                          )
                        }
                      >
                        {t("teamMemory.remove")}
                      </Button>
                    </>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
