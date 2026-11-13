import { Button, Icon, Popover, SearchField } from "@agenteschat/ui";
import { type KeyboardEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

/** "#Processo, vendas" → ["processo", "vendas"]: the tags as the server keeps them (at most 20). */
export const tagsOf = (text: string, base: string[] = []) =>
  [
    ...new Set([
      ...base,
      ...text
        .split(/[\s,]+/)
        .map((x) => x.replace(/^#/, "").trim().toLowerCase())
        .filter(Boolean),
    ]),
  ].slice(0, 20);

/** Every folder of the pages, parents included ("Processos/Vendas" also gives "Processos"). */
function allFolders(folders: string[]) {
  const out = new Set<string>();
  for (const f of folders) {
    const parts = f.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * The page's folder while editing: a chip that opens the folders with a search, "Sem pasta" and, for a name that
 * isn't one yet, "Criar pasta" (a folder exists once a page is in it).
 */
export function WikiFolderPicker({
  value,
  folders,
  onChange,
}: {
  value: string;
  folders: string[];
  onChange: (folder: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = useMemo(() => allFolders([...folders, value].filter(Boolean)), [folders, value]);
  const query = q.trim().replace(/^\/+|\/+$/g, "");
  const shown = list.filter((f) => !query || f.toLowerCase().includes(query.toLowerCase()));
  const creates = query && !list.some((f) => f.toLowerCase() === query.toLowerCase());
  const pick = (folder: string) => {
    onChange(folder);
    setOpen(false);
    setQ("");
  };
  return (
    <Popover
      label={t("wiki.form.folder")}
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      className="wiki-folders-pop"
      trigger={
        <button type="button" className="wiki-chip wiki-chip--line" title={t("wiki.props.folderHint")}>
          <Icon name="drive" size={14} />
          {value || t("wiki.props.noFolder")}
          <Icon name="chevronDown" size={14} />
        </button>
      }
    >
      <SearchField
        size="sm"
        aria-label={t("wiki.props.searchFolder")}
        placeholder={t("wiki.props.searchFolder")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onClear={() => setQ("")}
        clearLabel={t("filters.clearSearch")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && creates) {
            e.preventDefault();
            pick(query);
          }
        }}
      />
      <div className="wiki-folders-pop__list" role="listbox" aria-label={t("wiki.form.folder")}>
        {!query && (
          <button
            type="button"
            role="option"
            aria-selected={!value}
            className="wiki-folders-pop__row"
            onClick={() => pick("")}
          >
            <Icon name="document" size={16} />
            {t("wiki.props.noFolder")}
          </button>
        )}
        {shown.map((f) => (
          <button
            key={f}
            type="button"
            role="option"
            aria-selected={f === value}
            className="wiki-folders-pop__row"
            data-depth={f.split("/").length - 1}
            onClick={() => pick(f)}
          >
            <Icon name="drive" size={16} />
            {f.split("/").pop()}
          </button>
        ))}
        {creates && (
          <button
            type="button"
            role="option"
            aria-selected={false}
            className="wiki-folders-pop__row"
            onClick={() => pick(query)}
          >
            <Icon name="plus" size={16} />
            {t("wiki.props.createFolder", { name: query })}
          </button>
        )}
      </div>
    </Popover>
  );
}

/** The page's tags while editing: chips with ×, and "+ Tag" that opens a field (Enter or a comma adds). */
export function WikiTagsEdit({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const commit = () => {
    if (text.trim()) onChange(tagsOf(text, tags));
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText("");
      setAdding(false);
    } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
  };
  return (
    <>
      {tags.map((tag) => (
        <span key={tag} className="wiki-tagchip">
          #{tag}
          <button
            type="button"
            aria-label={t("wiki.props.removeTag", { tag })}
            title={t("wiki.props.removeTag", { tag })}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="ac-input wiki-tag-input"
          aria-label={t("wiki.form.tags")}
          placeholder={t("wiki.form.tagsPlaceholder")}
          value={text}
          // biome-ignore lint/a11y/noAutofocus: the field opens from "+ Tag", where the person is
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            commit();
            setAdding(false);
          }}
        />
      ) : (
        <Button size="sm" variant="ghost" icon="plus" className="wiki-chip--add" onClick={() => setAdding(true)}>
          {t("wiki.props.addTag")}
        </Button>
      )}
    </>
  );
}
