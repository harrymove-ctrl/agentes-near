import {
  type Actor,
  type Issue,
  type IssuePriority,
  useAiStatus,
  useIssueAction,
  useIssueColumns,
} from "@agenteschat/client";
import { PRIORITIES } from "@agenteschat/client/lib/issues";
import { aiStateOf } from "@agenteschat/client/lib/no-ai";
import { EVERYONE } from "@agenteschat/client/lib/who-sees";
import { useLocalSearchParams, usePreventRemove } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Filters, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, Locked, OPTION_ROW, useToast } from "@/ui";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { useWhoSeesDraft, useWhoSeesLabel, WhoSeesRows } from "../shared/WhoSees";
import { columnOfIssue, DUE_CHOICES, type DueChoice, dueDateOf } from "./logic";
import { useColumnLabel } from "./parts";
import { useStartAgent } from "./useStartAgent";

type Open = "who" | "priority" | "due" | "sees" | null;

const close = () => goBack("/issues");

/**
 * "Nova tarefa", a screen pushed over Tarefas (the native bar: back, the title, "Criar"): the title, a
 * description, who does it (an agent picked here is asked right away, as on the web: it starts and the status
 * moves on its own), the priority and the due date. From a board column's "+" (`column`), it goes in that column.
 */
export function NewIssueForm() {
  const { t } = useTranslation();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const dir = useDirectory();
  const meId = useMeId();
  const orgId = useOrgId();
  const action = useIssueAction(orgId);
  const start = useStartAgent();
  const ai = useAiStatus(orgId);
  const columns = useIssueColumns(orgId);
  const columnLabel = useColumnLabel();
  const { column: columnId } = useLocalSearchParams<{ column?: string }>();
  const column = columnId ? columns.data?.find((c) => c.id === columnId) : undefined;
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [who, setWho] = useState<Actor | null>(null);
  const [priority, setPriority] = useState<IssuePriority>("normal");
  const [due, setDue] = useState<DueChoice>("none");
  const [open, setOpen] = useState<Open>(null);
  const sees = useWhoSeesDraft(EVERYONE);
  const seesLabel = useWhoSeesLabel();
  const ready = title.trim().length > 0 && !action.isPending && sees.ready;
  // A back swipe with a task half written asks first, as the web's dialog keeps it from a stray click.
  const done = useRef(false);
  usePreventRemove(title.trim() !== "" || text.trim() !== "", ({ repeat }) => {
    if (done.current) return repeat();
    Alert.alert(t("edit.unsaved"), undefined, [
      { text: t("edit.keepEditing"), style: "cancel" },
      { text: t("edit.discard"), style: "destructive", onPress: repeat },
    ]);
  });
  const toggle = (o: Exclude<Open, null>) => setOpen((v) => (v === o ? null : o));
  const agents = dir.agents.filter((a) => a.canTalk !== false);
  const whoName = (a: Actor | null) =>
    !a ? t("mobile.issues.nobody") : a.type === "person" && a.id === meId ? t("mobile.issues.you") : dir.nameOf(a);
  const whoRole = who?.type === "agent" ? (dir.agentById.get(who.id)?.role ?? "") : "";

  const submit = () => {
    if (!ready) return;
    action.mutate(
      {
        type: "create",
        input: {
          title: title.trim(),
          description: text.trim(),
          assignee: who?.type === "person" ? who : null,
          priority,
          dueDate: dueDateOf(due),
          audience: sees.choice,
        },
      },
      {
        onSuccess: (created) => {
          const issue = created as Issue;
          // New tasks land in A fazer's first column; another one was picked by its "+" (an agent's moves on).
          if (column && who?.type !== "agent" && columnOfIssue(issue, columns.data ?? [])?.id !== column.id)
            action.mutate({ type: "update", id: issue.id, patch: { columnId: column.id } });
          // An agent picked here starts right away: assigned, its run linked, in progress (as on the web).
          if (who?.type === "agent") start.run(issue, who.id, { created: true });
          successHaptic();
          toast({
            title: t("mobile.issues.form.created", { number: issue.number }),
            ...(who?.type === "agent" ? { agentId: who.id } : {}),
          });
          done.current = true;
          close();
        },
        onError: () => toast({ title: t("mobile.issues.form.createFailed"), icon: "x" }),
      },
    );
  };

  const choices: (Actor | null)[] = [
    ...agents.map((a) => ({ type: "agent" as const, id: a.id })),
    ...(meId ? [{ type: "person" as const, id: meId }] : []),
    null,
  ];
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("mobile.issues.form.title")}
        solid={false}
        grouped
        action={{ label: t("mobile.issues.form.create"), disabled: !ready, onPress: submit }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        <Locked when={action.isPending} style={styles.fields}>
          <TextArea
            value={title}
            onChangeText={setTitle}
            placeholder={t("mobile.issues.form.titlePlaceholder")}
            accessibilityLabel={t("issues.form.title")}
            multiline={false}
            minHeight={50}
            autoFocus
            returnKeyType="next"
            maxLength={300}
          />
          <TextArea
            value={text}
            onChangeText={setText}
            placeholder={t("mobile.issues.form.description")}
            accessibilityLabel={t("mobile.issues.form.description")}
            minHeight={96}
            maxLength={50_000}
          />
          <View>
            <GroupedHeader>{t("mobile.issues.form.who")}</GroupedHeader>
            <GroupedList>
              <GroupedRow
                label={whoName(who)}
                leading={who ? <Face who={who} size={OPTION_ROW.face} live={false} /> : undefined}
                icon={who ? undefined : "agent"}
                value={whoRole || undefined}
                chevron
                onPress={() => toggle("who")}
              />
              {open === "who"
                ? choices
                    .filter((a) => (a?.type ?? null) !== (who?.type ?? null) || a?.id !== who?.id)
                    .map((a) => (
                      <GroupedRow
                        key={a ? `${a.type}:${a.id}` : "nobody"}
                        label={whoName(a)}
                        leading={a ? <Face who={a} size={OPTION_ROW.face} live={false} /> : undefined}
                        icon={a ? undefined : "circle"}
                        value={a?.type === "agent" ? (dir.agentById.get(a.id)?.role ?? undefined) : undefined}
                        onPress={() => {
                          setWho(a);
                          setOpen(null);
                        }}
                      />
                    ))
                : null}
            </GroupedList>
            {who?.type === "agent" ? (
              <GroupedFooter>
                {/* "Starts as soon as it's created" isn't true for an agent with no AI: it waits for one. */}
                {aiStateOf(ai.data, who.id) === "no_ai"
                  ? t("mobile.ai.taskNoAi", { name: dir.agentById.get(who.id)?.name ?? "" })
                  : t("mobile.issues.form.agentStarts")}
              </GroupedFooter>
            ) : null}
          </View>
          <View>
            <GroupedHeader>{t("mobile.issues.form.details")}</GroupedHeader>
            <GroupedList>
              {column ? (
                <GroupedRow icon="circle" label={t("issues.column")} sub={columnLabel(column)} subLines={0} />
              ) : null}
              <GroupedRow
                icon="flag"
                label={t("issues.form.priority")}
                value={t(`issues.priority.${priority}`)}
                chevron
                onPress={() => toggle("priority")}
              />
              {open === "priority" ? (
                <View style={styles.inline}>
                  <Filters
                    items={PRIORITIES.map((p) => ({ key: p, label: t(`issues.priority.${p}`) }))}
                    value={priority}
                    onChange={(k) => {
                      setPriority(k as IssuePriority);
                      setOpen(null);
                    }}
                  />
                </View>
              ) : null}
              <GroupedRow
                icon="clock"
                label={t("mobile.issues.form.due")}
                value={t(`mobile.issues.form.dueChoice.${due}`)}
                chevron
                onPress={() => toggle("due")}
              />
              {open === "due" ? (
                <View style={styles.inline}>
                  <Filters
                    items={DUE_CHOICES.map((d) => ({ key: d, label: t(`mobile.issues.form.dueChoice.${d}`) }))}
                    value={due}
                    onChange={(k) => {
                      setDue(k as DueChoice);
                      setOpen(null);
                    }}
                  />
                </View>
              ) : null}
              <GroupedRow
                icon={sees.choice.mode === "everyone" ? "globe" : "lock"}
                label={t("whoSees.label")}
                value={seesLabel(sees.choice)}
                chevron
                onPress={() => toggle("sees")}
              />
            </GroupedList>
            {open === "sees" ? (
              <View style={styles.seesRows}>
                <WhoSeesRows draft={sees} />
                <GroupedFooter>{t("whoSees.admins")}</GroupedFooter>
              </View>
            ) : null}
          </View>
        </Locked>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // A form's 16 pt sides, as Nova rotina's.
  in: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  fields: { gap: 12 },
  inline: { paddingVertical: 10, marginHorizontal: -2 },
  seesRows: { gap: 12, marginTop: 12 },
});
