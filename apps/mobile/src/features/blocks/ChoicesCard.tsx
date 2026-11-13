import { useAnswerChoices, useArtifact, useChoices } from "@agenteschat/client";
import {
  answeredFirst,
  CHOICE_OTHER_MAX,
  type ChoiceDraft,
  choiceLetter,
  choiceSummary,
  emptyDraft,
  moveStep,
  otherChoice,
  pickChoice,
} from "@agenteschat/client/lib/choices";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Icon, MEDIA_ROW, MediaRow, Sky, Text, useToast } from "@/ui";
import { initialText } from "@/ui/type-scale";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { tapHaptic } from "../shared/parts";
import { useSheetIfAny } from "../shared/SheetHost";

/**
 * An agent asks the person to pick (ADR 0124): big rows lettered A, B, C…, one question at a time. A tap answers at
 * once, as the person's own message to the agent; then the card shows what was picked to everyone. The last row,
 * "Outra resposta", opens a sheet to write the answer instead, as the ask card's does.
 */
export function ChoicesCard({ id, version }: { id: string; version?: number }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  // Outside a conversation (a task's activity) there is no sheet to write in: the options alone.
  const sheet = useSheetIfAny();
  const artifact = useArtifact(orgId, id, version);
  const query = useChoices(orgId, id);
  const answer = useAnswerChoices(orgId, id);
  const [draft, setDraft] = useState<ChoiceDraft | null>(null);
  const [closed, setClosed] = useState(false);
  const a = artifact.data;
  if (a?.content.kind !== "choices" || !query.data) {
    return (
      <View style={[styles.card, styles.loading, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        <ActivityIndicator color={c.faint} />
        <Text variant="footnote" tone="muted">
          {t("mobile.blocks.building")}
        </Text>
      </View>
    );
  }
  const { questions } = a.content;
  const answered = query.data.answer;
  const sky = (
    <Sky
      color={agentLook(dir.agentById.get(a.createdBy.id)).color}
      surface="raised"
      depth={0.95}
      fade={0}
      style={styles.sky}
    />
  );

  if (answered) {
    const by = dir.memberById.get(answered.userId)?.name ?? t("mobile.blocks.someone");
    return (
      <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
        {sky}
        <View style={styles.head}>
          <Text variant="subhead" style={styles.bold}>
            {a.title}
          </Text>
          <Text variant="footnote" tone="faint">
            {t("mobile.choices.answeredBy", { name: by })}
          </Text>
        </View>
        <View style={styles.options}>
          {choiceSummary(questions, answered.picks, answered.others).map((s) => (
            <View key={s.question} style={styles.summary}>
              {questions.length > 1 ? (
                <Text variant="footnote" tone="muted">
                  {s.question}
                </Text>
              ) : null}
              <View style={styles.picked}>
                <Letter letter={s.letter} on />
                <Text variant="body" style={[styles.flex, styles.bold, styles.said]}>
                  {s.label}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }

  if (closed) {
    return (
      <Pressable accessibilityRole="button" onPress={() => setClosed(false)} style={styles.closed}>
        <Text variant="footnote" tone="faint">
          {t("mobile.choices.closed", { title: a.title })}
        </Text>
        <Text variant="footnote" tone="ink" style={styles.bold}>
          {t("mobile.choices.reopen")}
        </Text>
      </Pressable>
    );
  }

  const d = draft ?? emptyDraft(questions);
  const q = questions[d.step];
  if (!q) return null;
  const other = otherChoice(q);
  const pick = (option: number, written?: string) => {
    if (answer.isPending) return;
    tapHaptic();
    const next = pickChoice(d, option, written);
    setDraft(next.draft);
    if (next.send)
      answer.mutate(next.send, {
        onError: (e) => {
          if (!answeredFirst(e)) toast({ title: t("mobile.choices.failed"), icon: "x" });
          void query.refetch();
        },
      });
  };
  return (
    <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
      {sky}
      <View style={[styles.head, styles.row]}>
        <View style={styles.flex}>
          <Text variant="subhead" style={styles.bold}>
            {a.title}
          </Text>
          {questions.length > 1 ? (
            <Text variant="footnote" tone="faint">
              {t("mobile.choices.step", { step: d.step + 1, total: questions.length })}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.choices.close")}
          hitSlop={10}
          onPress={() => setClosed(true)}
        >
          <Icon name="x" size={16} color={c.faint} />
        </Pressable>
      </View>
      <Text variant="body" style={styles.question}>
        {q.question}
      </Text>
      {/* Not `Locked`: it closes the keyboard, and in a conversation that's the composer's. */}
      <View style={[styles.options, answer.isPending && styles.sending]}>
        {q.options.map((o, i) => {
          const on = d.picks[d.step] === i;
          return (
            <Pressable
              key={o.label}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: answer.isPending }}
              accessibilityLabel={`${choiceLetter(i)}. ${o.label}${o.description ? `. ${o.description}` : ""}`}
              disabled={answer.isPending}
              onPress={() => pick(i)}
              style={({ pressed }) => [styles.option, { borderColor: c.line2 }, pressed && { backgroundColor: c.line }]}
            >
              <MediaRow size="row" name={o.label} face={<Letter letter={choiceLetter(i)} on={on} />}>
                {o.description ? (
                  <Text variant="footnote" tone="muted">
                    {o.description}
                  </Text>
                ) : null}
              </MediaRow>
            </Pressable>
          );
        })}
        {sheet ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: d.picks[d.step] === other, disabled: answer.isPending }}
            accessibilityLabel={`${choiceLetter(other)}. ${t("ask.otherAnswer")}`}
            disabled={answer.isPending}
            onPress={() =>
              sheet.open(
                <PromptForm
                  title={q.question}
                  placeholder={t("mobile.chat.question.placeholder")}
                  submitLabel={t("mobile.app.send")}
                  initial={d.others[d.step] ?? ""}
                  maxLength={CHOICE_OTHER_MAX}
                  onSubmit={(text) => {
                    sheet.close();
                    pick(other, text.trim());
                  }}
                />,
              )
            }
            style={({ pressed }) => [styles.option, { borderColor: c.line2 }, pressed && { backgroundColor: c.line }]}
          >
            <MediaRow
              size="row"
              name={t("ask.otherAnswer")}
              face={<Letter letter={choiceLetter(other)} on={d.picks[d.step] === other} />}
            >
              {d.others[d.step] ? (
                <Text variant="footnote" tone="muted">
                  {d.others[d.step]}
                </Text>
              ) : null}
            </MediaRow>
          </Pressable>
        ) : null}
      </View>
      {questions.length > 1 ? (
        <View style={[styles.foot, { borderTopColor: c.line2 }]}>
          <Pressable
            accessibilityRole="button"
            disabled={d.step === 0}
            onPress={() => setDraft(moveStep(d, -1))}
            // An 18-point line: 13 of slop around it gives the 44-point target.
            hitSlop={13}
          >
            <Text variant="footnote" tone={d.step === 0 ? "faint" : "ink"} style={styles.bold}>
              {t("mobile.choices.back")}
            </Text>
          </Pressable>
          <View style={styles.dots}>
            {questions.map((qq, i) => (
              <View
                key={qq.question}
                style={[
                  styles.dot,
                  { backgroundColor: i === d.step ? c.ink : d.picks[i] !== null ? c.faint : c.line2 },
                ]}
              />
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={d.step === questions.length - 1 || d.picks[d.step] === null}
            onPress={() => setDraft(moveStep(d, 1))}
            hitSlop={13}
          >
            <Text
              variant="footnote"
              tone={d.step === questions.length - 1 || d.picks[d.step] === null ? "faint" : "ink"}
              style={styles.bold}
            >
              {t("mobile.choices.next")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** An option's letter in its 24 tile inside its 1-point border: centred in the 22 left, as an initial is. */
const LETTER_TEXT = initialText(MEDIA_ROW.row.face - 2, 12);

/** An option's letter, its row's face: filled once it is the pick. */
function Letter({ letter, on }: { letter: string; on: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.letter, { borderColor: c.line2 }, on && { backgroundColor: c.ink, borderColor: c.ink }]}>
      <Text
        variant="caption"
        tone={on ? undefined : "muted"}
        style={[styles.bold, LETTER_TEXT, on && { color: c.raised }]}
      >
        {letter}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // As wide as the message, under what comes before it (the files' cards keep the same gap).
  card: {
    alignSelf: "stretch",
    marginTop: 8,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
  },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 8, opacity: 0.7 },
  head: { gap: 1, paddingHorizontal: 14, paddingTop: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  flex: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  question: { paddingHorizontal: 14, paddingTop: 6 },
  options: { gap: 6, padding: 14, paddingTop: 10 },
  sending: { opacity: 0.6 },
  // A MediaRow in its plate: the letter in the face's place, what the option adds under its line at the row's width.
  option: {
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
  },
  letter: {
    alignItems: "center",
    justifyContent: "center",
    width: MEDIA_ROW.row.face,
    height: MEDIA_ROW.row.face,
    borderWidth: 1,
    borderRadius: 8,
    borderBottomLeftRadius: 3,
  },
  summary: { gap: 4 },
  // A long written answer wraps under the letter's top; one line sits on its middle.
  picked: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  said: { paddingTop: 2 },
  closed: { flexDirection: "row", flexWrap: "wrap", columnGap: 8, paddingVertical: 6 },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: "row", gap: 6 },
  dot: { width: 6, height: 6 },
});
