import { joinNames } from "@agenteschat/client/lib/format";
import { Button, Icon, modKey, Popover } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type Change, useAgentEdit } from "./context";

/**
 * The one save bar: how many changes and where, "Ver" (old → new, Desfazer
 * per item, a click jumps to it), Descartar and Salvar (⌘/Ctrl+S). It sticks
 * to the bottom of the page while something is unsaved.
 */
export function SaveBar({
  saving,
  onSave,
  onDiscard,
  onJump,
}: {
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onJump: (change: Change) => void;
}) {
  const { t } = useTranslation();
  const { changes, revert, errors } = useAgentEdit();
  const [open, setOpen] = useState(false);
  if (changes.length === 0) return null;
  const where = [...new Set(changes.map((c) => c.label))];
  const problem = errors.name ?? errors.handle ?? errors.budget ?? errors.audience;
  return (
    <section className="agp-savebar" aria-label={t("edit.unsaved")}>
      <span
        className="agp-savebar__hint ac-iconline"
        data-bad={problem ? true : undefined}
        role={problem ? "alert" : undefined}
      >
        <Icon name={problem ? "info" : "edit"} size={14} />
        {problem ?? (
          <>
            <b>{t("agentPage.changesCount", { count: changes.length })}</b>
            <span className="agp-savebar__where">
              {where.length > 3
                ? t("agentPage.saveBar.andMore", { names: where.slice(0, 3).join(", ") })
                : joinNames(where, t)}
            </span>
          </>
        )}
      </span>
      <Popover
        label={t("agentPage.saveBar.title")}
        side="top"
        align="end"
        open={open}
        onOpenChange={setOpen}
        className="agp-changes"
        trigger={
          <Button variant="ghost" icon={open ? "chevronDown" : "arrowUp"} aria-expanded={open}>
            {t("agentPage.saveBar.see")}
          </Button>
        }
      >
        <div className="agp-changes__head">
          <b>{t("agentPage.saveBar.title")}</b>
          <span className="small muted">{t("agentPage.saveBar.since")}</span>
        </div>
        <ul className="agp-changes__list">
          {changes.map((c) => (
            <li key={c.key} className="agp-changes__item">
              <button
                type="button"
                className="agp-changes__jump"
                onClick={() => {
                  setOpen(false);
                  onJump(c);
                }}
              >
                <b>{c.label}</b>
                <span>
                  {c.was && (
                    <>
                      <s>{c.was}</s> →{" "}
                    </>
                  )}
                  {c.now}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                icon="undo"
                aria-label={t("agentPage.undoLabel", { what: c.label })}
                onClick={() => {
                  if (changes.length === 1) setOpen(false);
                  revert(c.key);
                }}
              >
                {t("agentPage.undo")}
              </Button>
            </li>
          ))}
        </ul>
      </Popover>
      {/* Save's height: the bar's buttons are one row of the ruler. */}
      <Button variant="ghost" onClick={onDiscard} disabled={saving}>
        {t("edit.discard")}
      </Button>
      <Button
        variant="primary"
        className="agp-savebar__save"
        kbd={[modKey(), "S"]}
        loading={saving}
        aria-disabled={problem ? true : undefined}
        onClick={onSave}
      >
        {t("common.save")}
      </Button>
    </section>
  );
}
