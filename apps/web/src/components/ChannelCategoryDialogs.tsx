import {
  ApiError,
  type Channel,
  type ChannelCategory,
  useChannelCategories,
  useChannels,
  useCreateChannelCategory,
  usePlaceChannel,
  useRenameChannelCategory,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogSearchList,
  Field,
  Icon,
  Input,
  Locked,
  OptionList,
  Select,
} from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";
import { useOrg } from "./org-context";

/** Categories are named as typed, at most this long (the server's CATEGORY_NAME_MAX). */
const NAME_MAX = 40;
/** The Select's value for "no category" (Radix Select can't hold an empty string). */
const NONE = "none";
/** The Select's last option: opens "Nova categoria" on top and comes back with it chosen. */
const NEW = "new";

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * "Nova categoria" (ADR 0080): a name and, unless `nameOnly`, the channels it takes along (`withChannel` starts
 * checked). `onCreated` gets the new category (the dialog that opened this one picks it).
 */
export function NewCategoryDialog({
  open,
  onOpenChange,
  withChannel,
  nameOnly,
  initialName = "",
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  withChannel?: string;
  nameOnly?: boolean;
  /** What the person had typed where they asked for it ("Criar “Produto”"). */
  initialName?: string;
  onCreated?: (category: ChannelCategory) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const channels = useChannels(org.id);
  const categories = useChannelCategories(org.id);
  const create = useCreateChannelCategory(org.id);
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  // Only as it opens: what opened it can change while it saves, once the list holds the category being made (Mover's
  // `initialName` goes empty when its search finds that name).
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening only
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setQ("");
    setPicked(new Set(withChannel ? [withChannel] : []));
    setTouched(false);
    create.reset();
  }, [open]);
  const categoryName = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
  const taken = useHeldWhile(
    (categories.data ?? []).some((c) => sameName(c.name, name)),
    create.isPending || create.isSuccess,
  );
  const error = !name.trim() ? "empty" : taken ? "taken" : null;
  const needle = q.trim().toLowerCase();
  const list = (channels.data ?? []).filter((c) => !needle || c.name.includes(needle));
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = () => {
    setTouched(true);
    if (error) return;
    // Keep the sidebar's order for the channels it takes.
    const channelIds = (channels.data ?? []).filter((c) => picked.has(c.id)).map((c) => c.id);
    create.mutate(
      { name: name.trim(), channelIds: nameOnly ? undefined : channelIds },
      {
        onSuccess: (category) => {
          onOpenChange(false);
          if (onCreated) onCreated(category);
          else toast.show(t("channelCategories.created", { name: category.name }));
        },
        onError: (e) => {
          if (e instanceof ApiError && e.status === 409) setTouched(true);
          else toast.show(errorText(t, e), "error");
        },
      },
    );
  };
  const showError = touched || error === "taken";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("channelCategories.newCategory")}
      description={t("channelCategories.newCategoryDesc")}
      closeLabel={t("common.close")}
      width={480}
      // Not autoFocus: it also opens over Criar canal and over the channel's details.
      initialFocus={nameField}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Locked when={create.isPending}>
          <DialogBody className="channel-category__fields">
            <Field
              label={t("channelCategories.name")}
              id="category-name"
              hint={{
                name: t("common.about", { label: t("channelCategories.name") }),
                text: t("channelCategories.newCategoryHelp"),
              }}
              error={
                showError && error === "empty"
                  ? t("channelCategories.nameEmpty")
                  : showError && error === "taken"
                    ? t("channelCategories.nameTaken", { name: name.trim() })
                    : undefined
              }
            >
              <Input
                ref={nameField}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("channelCategories.namePlaceholder")}
                maxLength={NAME_MAX}
                autoComplete="off"
              />
            </Field>
            {!nameOnly && <span className="ac-field__label">{t("channelCategories.channels")}</span>}
          </DialogBody>
          {!nameOnly && (
            <DialogSearchList
              query={q}
              onQueryChange={setQ}
              searchLabel={t("channelCategories.channelsSearch")}
              searchPlaceholder={t("channelCategories.channelsSearch")}
              isEmpty={list.length === 0}
              emptyText={t("channelCategories.channelsEmpty", { q })}
            >
              {list.map((c) => {
                const id = `category-pick-${c.id}`;
                const where = c.categoryId ? categoryName.get(c.categoryId) : undefined;
                return (
                  <label key={c.id} htmlFor={id} className="scope-row">
                    <Checkbox id={id} checked={picked.has(c.id)} onCheckedChange={(on) => toggle(c.id, on)} />
                    <span className="scope-row__text">
                      <span className="channel-category__channel">
                        <Icon name="channel" size={16} />
                        {c.name}
                      </span>
                      <span className="small muted">
                        {where ? t("channelCategories.inCategory", { name: where }) : t("channelCategories.noCategory")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </DialogSearchList>
          )}
        </Locked>
        <DialogFooter bar>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            {!nameOnly && picked.size > 0
              ? t("channelCategories.createWith", { count: picked.size })
              : t("channelCategories.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Renomear categoria": the same field, in a small dialog (not an edit inside the sidebar). */
export function RenameCategoryDialog({
  category,
  onOpenChange,
}: {
  category: ChannelCategory | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const categories = useChannelCategories(org.id);
  const rename = useRenameChannelCategory(org.id);
  const [name, setName] = useState("");
  useEffect(() => {
    if (category) setName(category.name);
  }, [category]);
  // Never taken by itself, also while the dialog closes: its field still shows then, with `category` already null.
  const renaming = useHeldWhile(category, category === null);
  const taken = (categories.data ?? []).some((c) => c.id !== renaming?.id && sameName(c.name, name));
  const error = !name.trim()
    ? t("channelCategories.nameEmpty")
    : taken
      ? t("channelCategories.nameTaken", { name: name.trim() })
      : undefined;
  return (
    <Dialog
      open={category !== null}
      onOpenChange={onOpenChange}
      title={t("channelCategories.renameTitle")}
      closeLabel={t("common.close")}
      width={420}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!category || error) return;
          if (name.trim() === category.name) return onOpenChange(false);
          rename.mutate(
            { categoryId: category.id, name: name.trim() },
            {
              onSuccess: () => onOpenChange(false),
              onError: (e) => toast.show(errorText(t, e), "error"),
            },
          );
        }}
      >
        <Locked when={rename.isPending}>
          <DialogBody>
            <Field label={t("channelCategories.name")} id="category-rename" error={error}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={NAME_MAX}
                autoComplete="off"
                autoFocus
              />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={Boolean(error)} loading={rename.isPending}>
            {t("channelCategories.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/**
 * The category of a channel as a Select: "Sem categoria", the categories, and "Nova categoria…", which opens
 * that dialog on top (name only) and comes back with the new one chosen.
 */
export function CategorySelect({
  value,
  onChange,
  canCreate,
  id,
}: {
  value: string | null;
  onChange: (categoryId: string | null) => void;
  /** Admins: offer "Nova categoria…". */
  canCreate: boolean;
  id?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const categories = useChannelCategories(org.id);
  const [creating, setCreating] = useState(false);
  const wantsNew = useRef(false);
  return (
    <>
      <Select
        id={id}
        value={value ?? NONE}
        onValueChange={(v) => {
          if (v === NEW) wantsNew.current = true;
          else onChange(v === NONE ? null : v);
        }}
        // The dialog opens once the list has given focus back to the trigger, a tick after it closes: opened with the
        // pick, it would lose its field's focus to the trigger behind it, and give focus back to an option that's gone.
        onCloseAutoFocus={() => {
          if (!wantsNew.current) return;
          wantsNew.current = false;
          setCreating(true);
        }}
        options={[
          { value: NONE, label: t("channelCategories.noCategory"), description: t("channelCategories.noCategoryDesc") },
          ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
          ...(canCreate
            ? [
                {
                  value: NEW,
                  label: t("channelCategories.newCategoryOption"),
                  leading: <Icon name="plus" size={16} />,
                  action: true,
                },
              ]
            : []),
        ]}
      />
      <NewCategoryDialog
        open={creating}
        onOpenChange={setCreating}
        nameOnly
        onCreated={(category) => onChange(category.id)}
      />
    </>
  );
}

/**
 * "Mover #canal": the categories as an OptionList (the current one tagged "Agora", each with its channels),
 * a search on top, and "Nova categoria" at the end (admins). The button says where it goes.
 */
export function MoveChannelDialog({
  channel,
  onOpenChange,
  canCreate,
}: {
  channel: Channel | null;
  onOpenChange: (open: boolean) => void;
  canCreate: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const channels = useChannels(org.id);
  const categories = useChannelCategories(org.id);
  const place = usePlaceChannel(org.id);
  const current = channel?.categoryId ?? NONE;
  const [dest, setDest] = useState<string>(NONE);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!channel) return;
    setDest(channel.categoryId ?? NONE);
    setQ("");
  }, [channel]);
  const all = [
    { id: NONE, name: t("channelCategories.noCategory") },
    ...(categories.data ?? []).map((c) => ({ id: c.id, name: c.name })),
  ];
  const needle = q.trim().toLowerCase();
  const shown = all.filter((c) => !needle || c.name.toLowerCase().includes(needle));
  const lineOf = (id: string) => {
    if (id === NONE) return t("channelCategories.noCategoryDesc");
    const names = (channels.data ?? []).filter((c) => c.categoryId === id && c.id !== channel?.id).map((c) => c.name);
    return names.length ? names.join(", ") : t("channelCategories.moveEmptyCategory");
  };
  const destName = all.find((c) => c.id === dest)?.name ?? "";
  const same = dest === current;
  const submit = () => {
    if (!channel || same) return;
    const categoryId = dest === NONE ? null : dest;
    place.mutate(
      { channelId: channel.id, categoryId },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.show(t("channelCategories.moved", { channel: channel.name, name: destName }), "info", {
            label: t("channelCategories.undo"),
            run: () => place.mutate({ channelId: channel.id, categoryId: current === NONE ? null : current }),
          });
        },
        onError: (e) => toast.show(errorText(t, e), "error"),
      },
    );
  };
  return (
    <>
      <Dialog
        open={channel !== null && !creating}
        onOpenChange={onOpenChange}
        title={t("channelCategories.moveTitle", { channel: channel?.name ?? "" })}
        description={t("channelCategories.moveDesc")}
        closeLabel={t("common.close")}
        width={480}
      >
        <form
          style={{ display: "contents" }}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Locked when={place.isPending}>
            <DialogSearchList
              query={q}
              onQueryChange={(v) => {
                setQ(v);
                // Typing picks the first match, so Enter moves there.
                const first = all.find((c) => v.trim() && c.name.toLowerCase().includes(v.trim().toLowerCase()));
                if (first) setDest(first.id);
              }}
              searchLabel={t("channelCategories.moveSearch")}
              searchPlaceholder={t("channelCategories.moveSearch")}
              isEmpty={false}
              emptyText=""
            >
              {shown.length > 0 ? (
                <OptionList
                  aria-label={t("channelCategories.moveSearch")}
                  value={dest}
                  onValueChange={setDest}
                  options={shown.map((c) => ({
                    value: c.id,
                    title: c.name,
                    tag: c.id === current ? t("channelCategories.moveNow") : undefined,
                    description: lineOf(c.id),
                  }))}
                />
              ) : (
                <p className="ac-dialog__empty">{t("channelCategories.moveEmpty", { q })}</p>
              )}
              {canCreate && (
                <button
                  type="button"
                  className="member-row member-row--add channel-category__add"
                  onClick={() => setCreating(true)}
                >
                  <span className="member-row__plus" aria-hidden="true">
                    <Icon name="plus" />
                  </span>
                  <span>
                    {needle && shown.length === 0
                      ? t("channelCategories.moveCreate", { name: q.trim() })
                      : t("channelCategories.newCategory")}
                  </span>
                </button>
              )}
            </DialogSearchList>
          </Locked>
          <DialogFooter bar>
            <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={same} loading={place.isPending}>
              {same ? t("channelCategories.moveSame") : t("channelCategories.moveTo", { name: destName })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      <NewCategoryDialog
        open={creating}
        onOpenChange={setCreating}
        nameOnly
        initialName={shown.length === 0 ? q.trim() : ""}
        onCreated={(category) => {
          setDest(category.id);
          setQ("");
        }}
      />
    </>
  );
}
