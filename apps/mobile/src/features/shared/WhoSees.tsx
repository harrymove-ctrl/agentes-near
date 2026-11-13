import { useIssue, useIssueAction, useWikiAction, useWikiPage } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import {
  type AudienceChoice,
  type AudienceKind,
  audienceKind,
  audienceOfKind,
  pickedOf,
  whoSeesLabel,
  wikiAudienceOf,
} from "@agenteschat/client/lib/who-sees";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { Face } from "./Face";
import { useColors, useDirectory, useMeId, useOrgId } from "./hooks";
import { goBack, PushedHeader, successHaptic } from "./parts";

const KINDS: { kind: AudienceKind; icon: "globe" | "lock" | "person"; label: string }[] = [
  { kind: "everyone", icon: "globe", label: "whoSees.everyone" },
  { kind: "me", icon: "lock", label: "whoSees.me" },
  { kind: "people", icon: "person", label: "whoSees.people" },
];

/** The setting in a few words, from the directory's names. */
export function useWhoSeesLabel() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const meId = useMeId();
  return (a: { mode: "everyone" | "people"; userIds?: readonly string[] }) =>
    whoSeesLabel(t, a, meId ?? "", (id) => dir.memberById.get(id)?.name);
}

/** What the three options hold while someone chooses. */
export function useWhoSeesDraft(
  value: { mode: "everyone" | "people"; userIds?: readonly string[] },
  /** Others stay on a list (a page's roles): it opens as a list, even of me alone. */
  listed = false,
) {
  const meId = useMeId() ?? "";
  const [kind, setKind] = useState<AudienceKind>(() => {
    const now = audienceKind(value, meId);
    return now === "me" && listed ? "people" : now;
  });
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => pickedOf(value, meId));
  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const choice: AudienceChoice = audienceOfKind(kind, [...picked], meId);
  return { kind, setKind, picked, toggle, choice, ready: kind !== "people" || picked.size > 0 };
}

/** "Quem vê" (ADR 0151), the web's three options as rows, the people under them when it's some of them. */
export function WhoSeesRows({ draft }: { draft: ReturnType<typeof useWhoSeesDraft> }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const meId = useMeId();
  const stays = !can(useOrg().org, "administrator");
  return (
    <>
      <GroupedList>
        {KINDS.map((k) => (
          <GroupedRow
            key={k.kind}
            icon={k.icon}
            label={t(k.label as "whoSees.everyone")}
            checked={draft.kind === k.kind}
            onPress={() => draft.setKind(k.kind)}
          />
        ))}
      </GroupedList>
      {draft.kind === "people" ? (
        <GroupedList>
          {[...dir.memberById.values()].map((m) => (
            <GroupedRow
              key={m.userId}
              label={m.name}
              leading={<Face who={{ type: "person", id: m.userId }} size={26} live={false} />}
              checked={draft.picked.has(m.userId) || (stays && m.userId === meId)}
              onPress={stays && m.userId === meId ? undefined : () => draft.toggle(m.userId)}
            />
          ))}
        </GroupedList>
      ) : null}
    </>
  );
}

/** The screen: a task's (`number`) or a wiki page's (`slug`) "Quem vê", saved from the bar. */
export function WhoSeesScreen({ number, slug }: { number?: number; slug?: string }) {
  const orgId = useOrgId();
  const issue = useIssue(orgId, number ?? 0, number !== undefined);
  const page = useWikiPage(orgId, slug ?? null);
  if (number !== undefined) {
    const i = issue.data;
    return i ? (
      <IssueForm key={i.id} id={i.id} audience={i.audience ?? { mode: "everyone", userIds: [], channelId: null }} />
    ) : null;
  }
  const p = page.data;
  if (!p) return null;
  return (
    <PageForm
      key={p.id}
      slug={p.slug}
      roleIds={p.audience?.roleIds ?? []}
      value={p.audience ? { mode: "people", userIds: p.audience.userIds } : { mode: "everyone" }}
    />
  );
}

function IssueForm({
  id,
  audience,
}: {
  id: string;
  audience: { mode: "everyone" | "people"; userIds: string[]; channelId: string | null };
}) {
  const { t } = useTranslation();
  const failed = useFailed();
  const action = useIssueAction(useOrgId());
  const draft = useWhoSeesDraft(audience);
  const save = () =>
    action.mutate(
      { type: "audience", id, audience: draft.choice },
      {
        onSuccess: () => {
          successHaptic();
          goBack();
        },
        onError: failed,
      },
    );
  return (
    <Form
      title={t("whoSees.taskTitle")}
      note={audience.channelId ? t("whoSees.tied") : undefined}
      draft={draft}
      saving={action.isPending}
      onSave={save}
    />
  );
}

function PageForm({
  slug,
  roleIds,
  value,
}: {
  slug: string;
  roleIds: string[];
  value: { mode: "everyone" | "people"; userIds?: readonly string[] };
}) {
  const { t } = useTranslation();
  const failed = useFailed();
  const { org } = useOrg();
  const action = useWikiAction(useOrgId());
  const draft = useWhoSeesDraft(value, roleIds.length > 0);
  const save = () =>
    action.mutate(
      { type: "who", slug, audience: wikiAudienceOf(draft.choice, roleIds, draft.kind) },
      {
        onSuccess: () => {
          successHaptic();
          goBack();
        },
        onError: failed,
      },
    );
  return (
    <Form
      title={t("whoSees.pageTitle")}
      note={roleIds.length > 0 && draft.kind === "people" ? t("whoSees.rolesToo") : undefined}
      draft={draft}
      saving={action.isPending}
      onSave={save}
      onMore={
        can(org, "manage_roles") ? () => router.replace({ pathname: "/wiki-audience", params: { slug } }) : undefined
      }
    />
  );
}

function Form({
  title,
  note,
  draft,
  saving,
  onSave,
  onMore,
}: {
  title: string;
  note?: string;
  draft: ReturnType<typeof useWhoSeesDraft>;
  saving: boolean;
  onSave: () => void;
  onMore?: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={title}
        solid={false}
        grouped
        action={{ label: t("common.save"), disabled: saving || !draft.ready, onPress: onSave }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.in}>
        <Locked when={saving} style={styles.fields}>
          <View>
            <GroupedHeader>{t("whoSees.label")}</GroupedHeader>
            <WhoSeesRows draft={draft} />
            <GroupedFooter>{note ? `${note} ${t("whoSees.admins")}` : t("whoSees.admins")}</GroupedFooter>
          </View>
          {onMore ? (
            <GroupedList>
              <GroupedRow label={t("whoSees.moreOptions")} chevron onPress={onMore} />
            </GroupedList>
          ) : null}
        </Locked>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { padding: 16, paddingBottom: 40 },
  fields: { gap: 16 },
});
