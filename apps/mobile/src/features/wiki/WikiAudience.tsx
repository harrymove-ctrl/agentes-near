import {
  useRoles,
  useSetWikiFolderAudience,
  useWikiAction,
  useWikiFolderAudience,
  useWikiPage,
  type WikiFolderAudience,
} from "@agenteschat/client";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import {
  OPEN_WIKI_ACCESS,
  type WikiAccess,
  type WikiAccessDraft,
  type WikiLevel,
  wikiAccessDraft,
  wikiAccessLimited,
  wikiAccessOf,
  wikiBaseLevels,
  wikiRowCap,
} from "@agenteschat/client/lib/wiki";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { Locked, Row, SCREEN_X, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { AccessList, type AccessListRow } from "../shared/AccessList";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic, Tile } from "../shared/parts";

/**
 * "Acesso" to a wiki page or folder (ADR 0023 addenda), the web's dialog as a screen on the shared `AccessList`: a level
 * for everyone and one per role, person and agent. Administrators always read and edit. Inside a limited folder it can only be
 * narrower.
 */
export function WikiAudienceScreen({ slug, folder }: { slug?: string; folder?: string }) {
  const orgId = useOrgId();
  const page = useWikiPage(orgId, slug ?? null);
  // "" is the wiki's root: every page and folder.
  const info = useWikiFolderAudience(orgId, folder ?? "", folder !== undefined);
  const p = slug ? page.data : undefined;
  if (folder !== undefined) {
    if (!info.data) return null;
    const { own, above } = info.data;
    return <Form key={folder} folder={folder} initial={own ?? above ?? OPEN_WIKI_ACCESS} above={above} />;
  }
  if (!p) return null;
  return (
    <Form
      key={p.id}
      slug={p.slug}
      inFolder={p.folder}
      initial={{
        audience: p.audience ?? null,
        agentIds: p.agentIds ?? null,
        editors: p.editors ?? null,
        agentEditorIds: p.agentEditorIds ?? null,
      }}
      above={p.folderAudience ?? null}
    />
  );
}

/** The levels a row walks through: edits or not beside "everyone can view", or each one it may reach. */
const rowLevels = (base: WikiLevel, cap: WikiLevel): WikiLevel[] =>
  base === "view" ? ["view", "edit"] : cap === "edit" ? ["none", "view", "edit"] : ["none", "view"];

function Form({
  slug,
  folder,
  inFolder,
  initial,
  above,
}: {
  slug?: string;
  folder?: string;
  inFolder?: string;
  initial: WikiAccess;
  above: WikiFolderAudience | null;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const dir = useDirectory();
  const roles = useRoles(orgId);
  const action = useWikiAction(orgId);
  const saveFolder = useSetWikiFolderAudience(orgId);
  const [draft, setDraft] = useState<WikiAccessDraft>(() => wikiAccessDraft(initial));
  const cap = useMemo(() => wikiAccessDraft(above ?? OPEN_WIKI_ACCESS), [above]);
  const done = (title: string) => {
    successHaptic();
    toast({ title });
    router.back();
  };
  const save = () => {
    const access = wikiAccessOf(draft);
    if (folder !== undefined) {
      saveFolder.mutate(
        { folder, access },
        {
          onSuccess: () =>
            done(wikiAccessLimited(access) ? t("wiki.audienceFolderSaved") : t("wiki.audienceFolderOpened")),
          onError: failed,
        },
      );
    } else if (slug) {
      action.mutate(
        { type: "audience", slug, access },
        {
          onSuccess: () => done(wikiAccessLimited(access) ? t("wiki.audienceSaved") : t("wiki.audienceOpened")),
          onError: failed,
        },
      );
    }
  };
  const levelName = (level: WikiLevel) =>
    t(
      level === "edit"
        ? "wiki.audienceLevelEdit"
        : level === "view"
          ? "wiki.audienceLevelView"
          : "wiki.audienceLevelNone",
    );
  const row = (
    group: "roles" | "users" | "agentRows",
    base: WikiLevel,
    rowCap: WikiLevel,
    key: string,
    icon: "shield" | "person",
    label: string,
    hint?: string,
  ): AccessListRow<WikiLevel> => {
    const level = draft[group][key] ?? "none";
    const baseKey = group === "agentRows" ? "agents" : "people";
    // With everyone editing, a tap adds them, and adding someone means limiting it: "everyone" drops until Salvar.
    if (base === "edit") {
      return {
        key,
        icon,
        label,
        ...(hint ? { hint } : {}),
        level: "none",
        levels: ["none", rowCap === "edit" ? "edit" : "view"],
        action: t("wiki.audienceAddRow"),
        onChange: (next) => setDraft((d) => ({ ...d, [baseKey]: "none", [group]: { ...d[group], [key]: next } })),
      };
    }
    return {
      key,
      icon,
      label,
      ...(hint ? { hint } : {}),
      // With everyone viewing, a row is only "this one edits too".
      level: base === "view" && level !== "edit" ? "view" : level,
      levels: rowLevels(base, rowCap),
      onChange: (next) => setDraft((d) => ({ ...d, [group]: { ...d[group], [key]: next } })),
    };
  };
  const base = (key: "people" | "agents", label: string, hint: string, icon: "person"): AccessListRow<WikiLevel> => ({
    key,
    icon,
    label,
    hint,
    level: draft[key],
    levels: [...wikiBaseLevels(cap[key])].reverse(),
    onChange: (next) => setDraft((d) => ({ ...d, [key]: next })),
  });
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r))).filter(
    (r) => wikiRowCap(cap.people, cap.roles[r.id]) !== "none",
  );
  const agents = dir.agents.filter((a) => wikiRowCap(cap.agents, cap.agentRows[a.id]) !== "none");
  return (
    // Who sees and edits, as every access screen: groups on the grouped gray.
    <View style={[styles.fill, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={folder === "" ? t("wiki.audienceRootTitle") : t("wiki.audience")}
        solid={false}
        action={{ label: t("common.save"), onPress: save, disabled: action.isPending || saveFolder.isPending }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <Locked when={action.isPending || saveFolder.isPending}>
          <Text variant="footnote" tone="faint" style={styles.lead}>
            {folder
              ? t("wiki.audienceFolderText")
              : folder === ""
                ? t("wiki.audienceRootText")
                : t("wiki.audienceText")}
          </Text>
          {above ? (
            <Text variant="footnote" tone="faint" style={styles.lead}>
              {above.folder ? t("wiki.audienceInFolder", { folder: above.folder }) : t("wiki.audienceInRoot")}
            </Text>
          ) : null}
          <AccessList
            levelName={levelName}
            rows={[
              base("people", t("wiki.audienceEveryone"), t("wiki.audienceEveryoneText"), "person"),
              base("agents", t("wiki.audienceAgentsAll"), t("wiki.audienceAgentsAllText"), "person"),
            ]}
          />
          <AccessList
            title={t("wiki.audienceRoles")}
            levelName={levelName}
            rows={roleList.map((r) =>
              row("roles", draft.people, wikiRowCap(cap.people, cap.roles[r.id]), r.id, "shield", r.name),
            )}
          />
          <AccessList
            title={t("wiki.audiencePeople")}
            levelName={levelName}
            rows={[...dir.memberById.values()].map((m) =>
              row("users", draft.people, "edit", m.userId, "person", m.name, m.email),
            )}
          />
          <AccessList
            title={t("wiki.audienceAgents")}
            levelName={levelName}
            rows={agents.map((a) =>
              row("agentRows", draft.agents, wikiRowCap(cap.agents, cap.agentRows[a.id]), a.id, "person", a.name),
            )}
          />
          <Text variant="footnote" tone="faint" style={styles.lead}>
            {t("wiki.audienceEditNote")}
          </Text>
          {inFolder ? (
            <Row
              leading={<Tile icon="archive" />}
              title={t("wiki.audienceUseFolder", { folder: inFolder })}
              chevron
              onPress={() => router.push({ pathname: "/wiki-audience", params: { folder: inFolder } })}
            />
          ) : null}
        </Locked>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: 40 },
  lead: { paddingHorizontal: SCREEN_X, paddingVertical: 12 },
});
