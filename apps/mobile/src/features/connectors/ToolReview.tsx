import {
  type ConnectorDef,
  type CustomServer,
  type MailAccount,
  type ToolDecision,
  useCustomServerAction,
  useCustomServers,
  useMailAction,
} from "@agenteschat/client";
import { mailActionsChanged, mailActionsFrom, mailReviewTools } from "@agenteschat/client/lib/mail";
import { type ReviewTool, reviewDecisions, reviewToolsOf } from "@agenteschat/client/lib/tool-review";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  Locked,
  SearchField,
  Text,
} from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { errorHaptic, successHaptic } from "../shared/parts";
import { Problem } from "./Problem";
import {
  acceptAll,
  catalogReviewTools,
  choicesOf,
  choose,
  chosenLevel,
  confirm,
  emptyReview,
  isWaiting,
  type ReviewState,
  reviewAgain,
  reviewTarget,
  subjectsOf,
  waitingHits,
} from "./review";

/** Each tool level's mark in the picker. */
const TOOL_LEVEL_ICON: Record<string, IconName> = { read: "eye", write: "pen", approval: "shield", off: "eyeoff" };

/** What a screen pins at its bottom for the review's save: the words, whether it is busy, what a tap does. */
export interface SaveBar {
  label: string;
  busy: boolean;
  onPress: () => void;
}

/**
 * "O que faz", between connecting and who uses it (the web's second step): a server connected by its address
 * shows its tools as they came classified, by subject, each with the web's control to change it (saved on
 * Continuar, through the same endpoint); our catalog services show theirs as they are (by scope: sensitive
 * ones always ask). On its own screen (Ferramentas) the server's button saves and the catalog's list has none.
 */
export function ReviewStep({
  connectionId,
  def,
  name,
  onNext,
  onScreen = false,
  onSaveBar,
}: {
  connectionId: string;
  def: ConnectorDef | null;
  name: string;
  onNext: () => void;
  onScreen?: boolean;
  /** On its own screen, the save goes to the screen's bottom bar (ref-stable: a state setter); null when none. */
  onSaveBar?: (bar: SaveBar | null) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const servers = useCustomServers(orgId);
  const target = reviewTarget(
    connectionId,
    def,
    servers.data ?? (servers.isError ? [] : undefined),
    servers.isFetching,
  );
  if (target.kind === "server") {
    return (
      <ServerReview
        key={target.server.id}
        server={target.server}
        name={name}
        onNext={onNext}
        onScreen={onScreen}
        onSaveBar={onSaveBar}
      />
    );
  }
  if (target.kind === "loading") return <ActivityIndicator color={c.muted} />;
  const tools = target.kind === "catalog" ? catalogReviewTools(t, target.def) : [];
  return (
    <>
      {tools.length === 0 ? (
        <GroupedFooter>{t("toolReview.noTools")}</GroupedFooter>
      ) : (
        <ToolList tools={tools} levelOf={(x) => x.level} />
      )}
      {target.kind === "catalog" ? <GroupedFooter>{t("toolReview.catalogLead", { name })}</GroupedFooter> : null}
      {onScreen ? null : <Button variant="primary" wide label={t("connectFlow.next")} onPress={onNext} />}
    </>
  );
}

/** A server's tools: the person settles what waits and changes what they want; Continuar (Salvar) saves it all. */
function ServerReview({
  server: first,
  name,
  onNext,
  onScreen,
  onSaveBar,
}: {
  server: CustomServer;
  name: string;
  onNext: () => void;
  onScreen: boolean;
  onSaveBar?: ((bar: SaveBar | null) => void) | undefined;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { save, refresh } = useCustomServerAction(orgId);
  const [server, setServer] = useState(first);
  const [state, setState] = useState<ReviewState>(emptyReview);
  const [failed, setFailed] = useState<string | null>(null);
  const tools = useMemo(() => reviewToolsOf(t, server), [t, server]);
  const left = tools.filter((x) => isWaiting(state, x)).length;
  const busy = save.isPending || refresh.isPending;
  const fail = (text: string) => {
    errorHaptic();
    setFailed(text);
  };
  const lookAgain = () => {
    setFailed(null);
    refresh.mutate(server.id, {
      onSuccess: (fresh) => setServer(fresh),
      onError: () => fail(t("mobile.connectors.review.refreshFailed")),
    });
  };
  const next = () => {
    setFailed(null);
    save.mutate(
      { id: server.id, label: server.label, tools: reviewDecisions(tools, state.levels, state.decided) },
      {
        onSuccess: () => {
          successHaptic();
          onNext();
        },
        onError: () => fail(t("mobile.connectors.review.saveFailed", { name })),
      },
    );
  };
  const saveLabel = save.isPending
    ? t("mobile.connectors.review.saving")
    : onScreen
      ? t("common.save")
      : t("connectFlow.next");
  // Pinned at the screen's bottom (Ferramentas): the bar gets the words and the state, a tap the latest `next`.
  const nextNow = useRef(next);
  useEffect(() => {
    nextNow.current = next;
  });
  useEffect(() => {
    onSaveBar?.({ label: saveLabel, busy, onPress: () => nextNow.current() });
  }, [onSaveBar, saveLabel, busy]);
  useEffect(() => () => onSaveBar?.(null), [onSaveBar]);
  return (
    <>
      {server.toolsError ? <Problem text={t("toolReview.unreadable", { reason: server.toolsError })} /> : null}
      {tools.length === 0 ? (
        server.toolsError ? null : (
          <GroupedFooter>{t("toolReview.noTools")}</GroupedFooter>
        )
      ) : (
        <Locked when={busy}>
          <ToolList tools={tools} levelOf={(x) => chosenLevel(state, x)} review={{ state, onChange: setState }} />
        </Locked>
      )}
      {/* Asking the server again is the last row: it rarely changes right after connecting. */}
      <View>
        <GroupedList>
          <GroupedRow
            label={
              refresh.isPending
                ? t("mobile.connectors.review.refreshing")
                : server.toolsError
                  ? t("common.retry")
                  : t("toolReview.refresh")
            }
            disabled={busy}
            onPress={lookAgain}
          />
        </GroupedList>
        <GroupedFooter>{left > 0 ? t("toolReview.missing", { count: left }) : t("toolReview.later")}</GroupedFooter>
      </View>
      {failed ? <Problem key={failed} text={failed} /> : null}
      {onSaveBar ? null : <Button variant="primary" wide label={saveLabel} disabled={busy} onPress={next} />}
    </>
  );
}

/**
 * A mailbox's "O que faz", as on the web: each action at Consulta · Muda · Aprovação · Desligada (sending and
 * deleting only ask or are off), saved through the mailbox on Continuar (Salvar on its own).
 */
export function MailReview({
  account,
  onNext,
  onScreen = false,
}: {
  account: MailAccount;
  onNext: () => void;
  onScreen?: boolean;
}) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { update } = useMailAction(orgId);
  const [state, setState] = useState<ReviewState>(emptyReview);
  const [failed, setFailed] = useState(false);
  const tools = useMemo(() => mailReviewTools(t, account), [t, account]);
  const next = () => {
    const chosen = mailActionsFrom(tools, state.levels);
    if (!mailActionsChanged(account, chosen)) return onNext();
    setFailed(false);
    update.mutate(
      { accountId: account.id, ...chosen },
      {
        onSuccess: () => {
          successHaptic();
          onNext();
        },
        onError: () => {
          errorHaptic();
          setFailed(true);
        },
      },
    );
  };
  return (
    <>
      <Text variant="body" tone="muted">
        {t("mail.toolsLead", { name: account.address })}
      </Text>
      <Locked when={update.isPending}>
        <ToolList tools={tools} levelOf={(x) => chosenLevel(state, x)} review={{ state, onChange: setState }} />
      </Locked>
      {failed ? <Problem text={t("mail.actionsError")} /> : null}
      <Button
        variant="primary"
        wide
        label={
          update.isPending ? t("mobile.connectors.review.saving") : onScreen ? t("common.save") : t("connectFlow.next")
        }
        disabled={update.isPending}
        onPress={next}
      />
    </>
  );
}

/** The levels' groups, in the order that matters most: what asks first, what is off last. */
const LEVEL_ORDER: ToolDecision[] = ["approval", "write", "read", "off"];

/**
 * The tools, as the phone's settings list them: one search, then (editable) "Precisam da sua decisão" first, each with
 * our suggestion as its value and "Aceitar as sugestões" under them; then every other tool grouped by what it may do
 * (Pede sua aprovação · Muda coisas · Só consulta · Desligada), its level as the row's value. A tap opens the system's
 * choice of levels, each said in a line. Read-only shows the same groups without the choice.
 */
function ToolList({
  tools,
  levelOf,
  review,
}: {
  tools: ReviewTool[];
  levelOf: (tool: ReviewTool) => ToolDecision;
  /** Absent: read-only. */
  review?: { state: ReviewState; onChange: (state: ReviewState) => void };
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const searching = query.trim().length > 0;
  const state = review?.state;
  const waiting = state ? tools.filter((x) => isWaiting(state, x)) : [];
  const hits = state ? waitingHits(state, tools, query) : [];
  const rest = subjectsOf(t, state ? tools.filter((x) => !isWaiting(state, x)) : tools, query).flatMap((g) => g.hits);
  const reviewable = tools.filter((x) => x.pending).length;
  // A tool's level in the app's picker: each level with its mark and what it means ("Só consulta" over "vê dados,
  // não muda nada"), the one it has checked.
  const pick = (tool: ReviewTool) => {
    if (!review) return;
    const now = chosenLevel(review.state, tool);
    void pickOne({
      title: tool.label,
      value: now,
      options: choicesOf(tool).map((level) => {
        const [label, ...rest] = t(`toolReview.help.${level}`).split(": ");
        return {
          key: level,
          label: label ?? level,
          ...(rest.length ? { sub: rest.join(": ") } : {}),
          leading: { kind: "icon" as const, name: TOOL_LEVEL_ICON[level] ?? "circle" },
        };
      }),
    }).then((key) => {
      const level = choicesOf(tool).find((l) => l === key);
      if (!level) return;
      review.onChange(
        level === now && isWaiting(review.state, tool)
          ? confirm(review.state, tool)
          : choose(review.state, tool, level),
      );
    });
  };
  const row = ({ tool, tech }: { tool: ReviewTool; tech: boolean }, suggested = false) => (
    <GroupedRow
      key={tool.name}
      label={tool.label}
      labelLines={2}
      {...(tech ? { sub: tool.name } : {})}
      value={t(`toolReview.short.${levelOf(tool)}`)}
      {...(suggested ? { valueLeading: <Icon name="wait" size={13} color={c.amber} /> } : {})}
      chevron={Boolean(review)}
      {...(review ? { onPress: () => pick(tool) } : {})}
    />
  );
  // One block: a sheet's or a screen's gap goes around the list, never between a group's header and its rows.
  return (
    <View>
      <SearchField
        value={q}
        onChangeText={setQ}
        placeholder={t("toolReview.search")}
        accessibilityLabel={t("toolReview.search")}
      />
      {review && hits.length > 0 ? (
        <>
          <GroupedHeader>{t("toolReview.decideTitle", { count: waiting.length })}</GroupedHeader>
          <GroupedList>{hits.map((h) => row(h, true))}</GroupedList>
          <GroupedFooter>{t("toolReview.decideHelp")}</GroupedFooter>
          {searching ? null : (
            <View style={styles.accept}>
              <Button
                variant="secondary"
                wide
                label={t("toolReview.acceptAll")}
                onPress={() =>
                  review.onChange(
                    acceptAll(
                      review.state,
                      hits.map((h) => h.tool),
                    ),
                  )
                }
              />
            </View>
          )}
        </>
      ) : null}
      {review && waiting.length === 0 && reviewable > 0 && !searching ? (
        <View style={styles.again}>
          <GroupedList>
            <GroupedRow
              label={t("toolReview.review", { count: reviewable })}
              chevron
              onPress={() => review.onChange(reviewAgain(review.state))}
            />
          </GroupedList>
        </View>
      ) : null}
      {LEVEL_ORDER.map((level) => {
        const these = rest.filter((h) => levelOf(h.tool) === level);
        if (these.length === 0) return null;
        return (
          <View key={level}>
            <GroupedHeader>{`${t(`toolReview.choice.${level}`)} · ${these.length}`}</GroupedHeader>
            <GroupedList>{these.map((h) => row(h))}</GroupedList>
          </View>
        );
      })}
      {rest.length === 0 && hits.length === 0 ? (
        <GroupedFooter>{t("toolReview.noMatch", { q: query.trim() })}</GroupedFooter>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  accept: { paddingTop: 12 },
  // A header's room above a group with none.
  again: { paddingTop: 20 },
});
