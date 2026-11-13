import {
  type Channel,
  useChannelCategories,
  useChannels,
  useCreateChannelCategory,
  useDeleteChannelCategory,
  usePlaceChannel,
  usePlaceChannelCategory,
  useRenameChannelCategory,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useHeldWhile } from "@agenteschat/client/lib/hold";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, TextInput } from "react-native";
import { useOrg } from "@/providers/org";
import {
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Text,
  useFieldText,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { useColors, useMeId, useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { arrangesCategories, categoryHrefs, channelSteps, movesChannel, stepBefore } from "./logic";

/** Names are at most this long (the server's CATEGORY_NAME_MAX). */
const NAME_MAX = 40;

/** The other channels of a category, for the line under it ("bugs, tech, deploys"). */
function channelLine(channels: Channel[], categoryId: string | null, except?: string) {
  return channels
    .filter((c) => (c.categoryId ?? null) === categoryId && c.id !== except)
    .map((c) => c.name)
    .join(", ");
}

/**
 * "Categoria" of a channel (ADR 0080), from its ⋯ sheet or a long press on the home: "Sem categoria" and the
 * categories, each with its channels, the current one checked; a tap moves it and goes back. Admins get
 * "Nova categoria", which takes the channel along. Below, its place among the channels next to it, one step
 * up or down (the home lists channels by latest activity, the web's sidebar in this order).
 */
export function PickCategoryScreen({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const toast = useToast();
  const channels = useChannels(orgId);
  const categories = useChannelCategories(orgId);
  const place = usePlaceChannel(orgId);
  const channel = channels.data?.find((c) => c.id === channelId);
  const current = channel?.categoryId ?? null;
  const all = channels.data ?? [];
  const order = channelSteps(all, channelId);
  const step = (move: typeof order.up) => {
    if (move) place.mutate(move, { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) });
  };
  const pick = (categoryId: string | null, name: string) => {
    if (!channel || categoryId === current) return router.back();
    place.mutate(
      { channelId, categoryId },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("channelCategories.moved", { channel: channel.name, name }) });
          router.back();
        },
        onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
      },
    );
  };
  return (
    <SettingsPage title={t("channelCategories.category")} {...(channel ? { subtitle: `#${channel.name}` } : {})}>
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("mobile.categories.where", { channel: channel?.name ?? "" }) }),
          text: t("mobile.categories.whereHelp"),
        }}
      >
        {t("mobile.categories.where", { channel: channel?.name ?? "" })}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("channelCategories.noCategory")}
          sub={t("channelCategories.noCategoryDesc")}
          checked={current === null}
          disabled={place.isPending}
          onPress={() => pick(null, t("channelCategories.noCategory"))}
        />
        {(categories.data ?? []).map((c) => (
          <GroupedRow
            key={c.id}
            label={c.name}
            sub={channelLine(all, c.id, channelId) || t("channelCategories.moveEmptyCategory")}
            checked={current === c.id}
            disabled={place.isPending}
            onPress={() => pick(c.id, c.name)}
          />
        ))}
      </GroupedList>
      {arrangesCategories(org) ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="plus"
              label={t("channelCategories.newCategory")}
              onPress={() => router.push(categoryHrefs.create(channelId))}
            />
          </GroupedList>
        </>
      ) : null}
      {channel ? (
        <>
          <GroupedHeader>{t("mobile.categories.order")}</GroupedHeader>
          <GroupedList>
            <GroupedRow
              label={t("mobile.categories.up")}
              disabled={!order.up || place.isPending}
              onPress={() => step(order.up)}
            />
            <GroupedRow
              label={t("mobile.categories.down")}
              disabled={!order.down || place.isPending}
              onPress={() => step(order.down)}
            />
          </GroupedList>
          <GroupedFooter>
            {t("mobile.categories.channelPosition", { at: order.at + 1, count: order.count })}
          </GroupedFooter>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** "Nova categoria" (admins): the name and the channels it takes along; "Criar" in the bar. */
export function NewCategoryScreen({ channelId }: { channelId?: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const words = useFieldText("body");
  const toast = useToast();
  const channels = useChannels(orgId);
  const categories = useChannelCategories(orgId);
  const create = useCreateChannelCategory(orgId);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(channelId ? [channelId] : []));
  const categoryName = new Map((categories.data ?? []).map((x) => [x.id, x.name]));
  const taken = useHeldWhile(
    (categories.data ?? []).some((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase()),
    create.isPending || create.isSuccess,
  );
  const save = () => {
    if (!name.trim()) return toast({ title: t("channelCategories.nameEmpty"), icon: "x" });
    if (taken) return toast({ title: t("channelCategories.nameTaken", { name: name.trim() }), icon: "x" });
    const channelIds = (channels.data ?? []).filter((x) => picked.has(x.id)).map((x) => x.id);
    create.mutate(
      { name: name.trim(), channelIds },
      {
        onSuccess: (category) => {
          successHaptic();
          toast({ title: t("channelCategories.created", { name: category.name }) });
          router.back();
        },
        onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
      },
    );
  };
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <SettingsPage
      title={t("channelCategories.newCategory")}
      action={{ label: t("mobile.categories.create"), onPress: save, disabled: create.isPending || !name.trim() }}
      locked={create.isPending}
    >
      <Gap />
      <GroupedList>
        <GroupedField label={t("channelCategories.name")}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t("channelCategories.namePlaceholder")}
            placeholderTextColor={c.faint}
            maxLength={NAME_MAX}
            autoFocus
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={save}
            style={[styles.input, words, { color: c.ink }]}
          />
        </GroupedField>
      </GroupedList>
      <GroupedFooter>
        {taken ? t("channelCategories.nameTaken", { name: name.trim() }) : t("mobile.categories.endOfList")}
      </GroupedFooter>
      <GroupedHeader>{t("channelCategories.channels")}</GroupedHeader>
      <GroupedList>
        {(channels.data ?? [])
          .filter((x) => x.isMember || picked.has(x.id))
          .map((x) => {
            const where = x.categoryId ? categoryName.get(x.categoryId) : undefined;
            return (
              <GroupedRow
                key={x.id}
                label={`#${x.name}`}
                sub={where ? t("channelCategories.inCategory", { name: where }) : t("channelCategories.noCategory")}
                checked={picked.has(x.id)}
                onPress={() => toggle(x.id)}
              />
            );
          })}
      </GroupedList>
    </SettingsPage>
  );
}

/**
 * "Categorias" (admins), from a category's long press: the order (each one opens to rename, move up or down,
 * or delete) and "Nova categoria".
 */
export function CategoriesScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const categories = useChannelCategories(orgId);
  const list = categories.data ?? [];
  return (
    <SettingsPage title={t("mobile.categories.title")}>
      <Gap />
      {list.length > 0 ? (
        <GroupedList>
          {list.map((x) => {
            const n = (channels.data ?? []).filter((c) => c.categoryId === x.id).length;
            return (
              <GroupedRow
                key={x.id}
                label={x.name}
                sub={t("mobile.categories.channelCount", { count: n })}
                chevron
                onPress={() => router.push(categoryHrefs.edit(x.id))}
              />
            );
          })}
        </GroupedList>
      ) : (
        <Text tone="faint" style={styles.empty}>
          {t("mobile.categories.none")}
        </Text>
      )}
      <Gap />
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("channelCategories.newCategory")}
          onPress={() => router.push(categoryHrefs.create())}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.categories.manageHelp")}</GroupedFooter>
    </SettingsPage>
  );
}

/** One category (admins): its name ("Salvar" in the bar), its channels, its place in the order, and delete. */
export function EditCategoryScreen({ categoryId }: { categoryId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const words = useFieldText("body");
  const toast = useToast();
  const channels = useChannels(orgId);
  const categories = useChannelCategories(orgId);
  const rename = useRenameChannelCategory(orgId);
  const remove = useDeleteChannelCategory(orgId);
  const placeCategory = usePlaceChannelCategory(orgId);
  const list = categories.data ?? [];
  const category = list.find((x) => x.id === categoryId);
  const [name, setName] = useState<string | null>(null);
  const value = name ?? category?.name ?? "";
  const ids = list.map((x) => x.id);
  const inIt = (channels.data ?? []).filter((x) => x.categoryId === categoryId);
  const save = () => {
    if (!category) return;
    const next = value.trim();
    if (!next) return toast({ title: t("channelCategories.nameEmpty"), icon: "x" });
    if (next === category.name) return router.back();
    if (list.some((x) => x.id !== categoryId && x.name.trim().toLowerCase() === next.toLowerCase()))
      return toast({ title: t("channelCategories.nameTaken", { name: next }), icon: "x" });
    rename.mutate(
      { categoryId, name: next },
      {
        onSuccess: () => {
          successHaptic();
          router.back();
        },
        onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
      },
    );
  };
  const step = (dir: -1 | 1) => {
    const before = stepBefore(ids, categoryId, dir);
    if (before === undefined) return;
    placeCategory.mutate(
      { categoryId, beforeCategoryId: before },
      { onError: (e) => toast({ title: errorText(t, e), icon: "x" }) },
    );
  };
  const askDelete = () =>
    category &&
    Alert.alert(t("mobile.categories.deleteTitle", { name: category.name }), t("channelCategories.deleteDesc"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("channelCategories.delete"),
        style: "destructive",
        onPress: () =>
          remove.mutate(categoryId, {
            onSuccess: () => {
              toast({
                title: inIt.length
                  ? t("channelCategories.deleted", { name: category.name, count: inIt.length })
                  : t("channelCategories.deletedEmpty", { name: category.name }),
              });
              router.back();
            },
            onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
          }),
      },
    ]);
  const at = ids.indexOf(categoryId);
  return (
    <SettingsPage
      title={category?.name ?? t("mobile.categories.title")}
      action={{ label: t("channelCategories.save"), onPress: save, disabled: rename.isPending || !category }}
      locked={rename.isPending}
    >
      <Gap />
      <GroupedList>
        <GroupedField label={t("channelCategories.name")}>
          <TextInput
            value={value}
            onChangeText={setName}
            maxLength={NAME_MAX}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={save}
            style={[styles.input, words, { color: c.ink }]}
          />
        </GroupedField>
      </GroupedList>
      <GroupedHeader>{t("mobile.categories.order")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("mobile.categories.up")}
          disabled={at <= 0 || placeCategory.isPending}
          onPress={() => step(-1)}
        />
        <GroupedRow
          label={t("mobile.categories.down")}
          disabled={at < 0 || at >= ids.length - 1 || placeCategory.isPending}
          onPress={() => step(1)}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.categories.position", { at: at + 1, count: ids.length })}</GroupedFooter>
      {inIt.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.categories.itsChannels")}</GroupedHeader>
          <GroupedList>
            {inIt.map((x) => (
              <GroupedRow key={x.id} label={`#${x.name}`} />
            ))}
          </GroupedList>
        </>
      ) : null}
      <Gap />
      <GroupedList>
        <GroupedRow label={t("channelCategories.delete")} danger onPress={askDelete} />
      </GroupedList>
      <GroupedFooter>{t("channelCategories.deleteDesc")}</GroupedFooter>
    </SettingsPage>
  );
}

/** Whether the person may change this channel's category (for its ⋯ sheet and the home's long press). */
export function useMovesChannel(channelId: string) {
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const channel = useChannels(orgId).data?.find((c) => c.id === channelId);
  return channel ? movesChannel(channel, meId, org) : false;
}

const styles = StyleSheet.create({
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  empty: { textAlign: "center", paddingVertical: 24 },
});
