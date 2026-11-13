import { useWikiAction, useWikiTree } from "@agenteschat/client";
import { Button, Dialog, DialogBody, DialogFooter, Icon, Locked, SearchField } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

export type WikiSource = { kind: "message"; channelId: string; messageId: string };

/** The block appended to the page: the text as a quote, then where it came from. */
export const wikiBlock = (text: string, from: string) =>
  `${text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}\n\n_${from}_`;

/**
 * "Salvar na wiki": pick a page (search) or create one with the typed title;
 * the text goes at the end with a line saying where it came from (and the
 * server records the backlink from `source`).
 */
export function SaveToWikiDialog({
  open,
  onClose,
  text,
  source,
  from,
}: {
  open: boolean;
  onClose: () => void;
  text: string;
  source: WikiSource;
  /** "de uma mensagem em #eng". */
  from: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const tree = useWikiTree(org.id, open);
  const action = useWikiAction(org.id);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const query = q.trim();
  const pages = (tree.data ?? []).filter((p) => !query || p.title.toLowerCase().includes(query.toLowerCase()));
  const exact = (tree.data ?? []).some((p) => p.title.toLowerCase() === query.toLowerCase());
  const block = wikiBlock(text, from);
  const appendTo = (slug: string, title: string) =>
    action.mutate(
      { type: "append", slug, text: block, source },
      {
        onSuccess: () => {
          toast.show(t("wiki.savedTo", { title }));
          onClose();
        },
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.saveTitle")}
      description={t("wiki.saveText")}
      closeLabel={t("common.close")}
      width={520}
    >
      <Locked when={action.isPending || busy}>
        <DialogBody>
          <SearchField
            size="sm"
            aria-label={t("wiki.savePick")}
            placeholder={t("wiki.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onClear={() => setQ("")}
            clearLabel={t("filters.clearSearch")}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: a scroll region of page choices */}
          <div className="save-wiki__list" role="region" aria-label={t("wiki.savePick")}>
            {pages.map((p) => (
              <button key={p.slug} type="button" className="save-wiki__page" onClick={() => appendTo(p.slug, p.title)}>
                <Icon name="book" size={14} />
                <span>{p.title}</span>
                {p.folder && <span className="small muted">{p.folder}</span>}
              </button>
            ))}
            {query && !exact && (
              <button
                type="button"
                className="save-wiki__page save-wiki__page--new"
                onClick={async () => {
                  setBusy(true);
                  try {
                    const page = await action.mutateAsync({
                      type: "create",
                      input: { title: query, body: `# ${query}\n\n` },
                    });
                    appendTo(page.slug, page.title);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Icon name="plus" size={14} />
                <span>{t("wiki.saveNew", { title: query })}</span>
              </button>
            )}
          </div>
        </DialogBody>
      </Locked>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
      </DialogFooter>
    </Dialog>
  );
}
