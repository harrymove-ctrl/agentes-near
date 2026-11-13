import { type AuditRow, useAudit, useAuditRow } from "@agenteschat/client";
import {
  AUDIT_HIDDEN,
  AUDIT_SHOWS,
  type AuditMark,
  type AuditMood,
  type AuditShow,
  auditActorName,
  auditApprovalText,
  auditDetailEntries,
  auditHint,
  auditOutcome,
  auditPhrase,
  auditQueryOf,
  auditReason,
  auditReasonKey,
  auditRoutine,
  auditSecretText,
  auditSentence,
  auditStr,
  auditSubLine,
  auditToolSaid,
  auditValueText,
  auditWhere,
  TOOL_CALL,
} from "@agenteschat/client/lib/audit";
import { humanize } from "@agenteschat/client/lib/custom-tools";
import { formatTime, whenAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import type { TFunction } from "i18next";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  EmptyState,
  Filters,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  type IconName,
  LineIcon,
  SCREEN_X,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { chatHref } from "../links/logic";
import { Face } from "../shared/Face";
import { useEmptyLook } from "../shared/FirstUse";
import { useColors, useDirectory, useWhen } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { copyText, Tile } from "../shared/parts";
import { Gap, SettingsPage } from "./parts";

/** The picker's key for "Qualquer agente" (no filter). */
const ANY_AGENT = "\u0000any";

/*
 * Configurações › Auditoria on the phone (admins), as the web's: the log by day, a sentence per row (who, what),
 * the line under it (about what, who asked, where) and how it ended; shortcuts on top and an agent to narrow it to.
 * A row pushes its own screen with the reason, the approval or the secret, what was sent (secrets hidden), the
 * technical detail, and the conversation and the request to open. Words in `@agenteschat/client/lib/audit`.
 */

const FACE = 30;

/** Each mark of the shared outcome (`auditOutcome`) as this app's icon. */
const MARK_ICON: Record<AuditMark, IconName> = {
  check: "check",
  block: "x",
  clock: "clock",
  stop: "stop",
  alert: "info",
  waiting: "wait",
};

export function AuditScreen({ agentId: first = null }: { agentId?: string | null } = {}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const when = useWhen();
  const dir = useDirectory();
  const { orgId, org } = useOrg();
  const admin = can(org, "view_audit");
  const look = useEmptyLook();
  const [show, setShow] = useState<AuditShow>("all");
  const [agentId, setAgentId] = useState<string | null>(first);
  const audit = useAudit(orgId, auditQueryOf(show, agentId), admin);
  const rows = useMemo(() => audit.data?.pages.flatMap((p) => p.rows) ?? [], [audit.data]);
  const days = useMemo(() => byDay(rows, when.day), [rows, when.day]);
  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  // In the app's picker: "Qualquer agente" first, then each agent with its face and role, the one shown checked.
  const pickAgent = () =>
    void pickOne({
      title: t("audit.agent"),
      value: agentId ?? ANY_AGENT,
      options: [
        { key: ANY_AGENT, label: t("audit.anyAgent"), leading: { kind: "icon", name: "members" } },
        ...dir.agents.map((a) => ({
          key: a.id,
          label: a.name,
          ...(a.role?.trim() ? { sub: a.role.trim() } : {}),
          leading: { kind: "agent" as const, agentId: a.id },
        })),
      ],
    }).then((key) => {
      if (key !== null) setAgentId(key === ANY_AGENT ? null : key);
    });

  return (
    <SettingsPage title={t("settings.section.audit")}>
      <GroupedFooter>{t("settings.sectionText.audit")}</GroupedFooter>
      {!admin ? (
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      ) : (
        <>
          <Gap />
          <Filters
            items={AUDIT_SHOWS.map((s) => ({ key: s, label: t(`audit.filter.${s}`) }))}
            value={show}
            onChange={(key) => setShow(key as AuditShow)}
          />
          {show !== "people" ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  icon="agent"
                  label={t("audit.agent")}
                  value={agent?.name ?? t("audit.anyAgent")}
                  chevron
                  onPress={pickAgent}
                />
              </GroupedList>
            </>
          ) : null}
          {audit.isPending ? <ActivityIndicator color={c.muted} style={styles.loading} /> : null}
          {audit.isError && !audit.data ? (
            <View style={styles.note}>
              <Note icon="x">{t("common.loadFailed")}</Note>
            </View>
          ) : null}
          {audit.isSuccess && rows.length === 0 ? (
            show === "all" && !agentId ? (
              <EmptyState
                size="panel"
                agent={look}
                mood="deal"
                title={t("mobile.empty.audit.title")}
                subtitle={t("mobile.empty.audit.text")}
              />
            ) : (
              <EmptyState
                size="inline"
                title={t("audit.emptyFiltered")}
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    label={t("filters.clearAll")}
                    onPress={() => {
                      setShow("all");
                      setAgentId(null);
                    }}
                  />
                }
              />
            )
          ) : null}
          {days.map(([day, list]) => (
            <Fragment key={day}>
              <GroupedHeader>{day}</GroupedHeader>
              <GroupedList>
                {list.map((row) => (
                  <AuditRowView key={row.id} row={row} time={formatTime(i18n.language, row.at)} />
                ))}
              </GroupedList>
            </Fragment>
          ))}
          {audit.hasNextPage ? (
            <>
              <Gap />
              <GroupedList>
                <GroupedRow
                  icon="down"
                  label={t("audit.loadMore")}
                  disabled={audit.isFetchingNextPage}
                  onPress={() => void audit.fetchNextPage()}
                />
              </GroupedList>
            </>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

/** The rows under each day's heading ("Hoje", "Ontem", "terça-feira, 27 de outubro"), newest first. */
function byDay(rows: AuditRow[], day: (iso: string) => string): [string, AuditRow[]][] {
  const out: [string, AuditRow[]][] = [];
  for (const row of rows) {
    const label = day(row.at);
    const last = out.at(-1);
    if (last && last[0] === label) last[1].push(row);
    else out.push([label, [row]]);
  }
  return out;
}

/** One row: the face, "Ada criou uma tarefa", the line under it, and how it ended with the time. */
function AuditRowView({ row, time }: { row: AuditRow; time: string }) {
  const { t, i18n } = useTranslation();
  const { name, text } = auditSentence(t, row, i18n.language);
  const sub = auditSubLine(t, row);
  const look = auditOutcome(t, row);
  return (
    <GroupedRow
      leading={<AuditFace row={row} />}
      label={name ? `${name} ${text}` : text}
      labelLines={2}
      {...(sub ? { sub } : {})}
      below={
        <View style={styles.end}>
          {look ? <OutcomeLine mood={look.mood} mark={look.mark} text={look.text} /> : null}
          <Text variant="caption" tone="faint" style={styles.time}>
            {time}
          </Text>
        </View>
      }
      chevron
      onPress={() => router.push(`/settings/audit/${row.id}`)}
    />
  );
}

/** Who did it: the agent's or the person's face; a gear for the system. */
function AuditFace({ row }: { row: AuditRow }) {
  if (row.actor.type === "system" || !row.actor.id) return <Tile icon="server" size={FACE} />;
  return <Face who={{ type: row.actor.type, id: row.actor.id }} size={FACE} live={false} />;
}

/** How it ended in its color: green when done, amber while it waits, red when refused or failed. */
function OutcomeLine({ mood, mark, text }: { mood: AuditMood; mark: AuditMark; text: string }) {
  const c = useColors();
  const color =
    mood === "done"
      ? c.ok
      : mood === "waiting"
        ? c.amber
        : mood === "refused" || mood === "failed"
          ? c.danger
          : c.muted;
  return (
    <View style={styles.outcome}>
      <LineIcon name={MARK_ICON[mark]} size={13} color={color} variant="caption" />
      <Text variant="caption" style={[styles.semibold, { color }, styles.shrink]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/**
 * A row of the log on its own screen (pushed over the list): the sentence and how it ended, the reason, the facts
 * (who asked, where, through which app, the approval or the secret, when), what was sent with secrets hidden, a
 * change's details, the technical detail, and the conversation and the waiting request to open.
 */
export function AuditRowScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { orgId } = useOrg();
  const row = useAuditRow(orgId, id);
  if (!row) {
    return (
      <SettingsPage title={t("settings.section.audit")}>
        <View style={styles.note}>
          <Note icon="info">{t("audit.emptyFiltered")}</Note>
        </View>
      </SettingsPage>
    );
  }
  const name = auditActorName(t, row) ?? t("audit.system");
  const { name: who, text } = auditSentence(t, row, i18n.language);
  const look = auditOutcome(t, row);
  const reason = auditReason(t, row);
  const reasonKey = auditReasonKey(row);
  const said = auditToolSaid(row);
  const isCall = row.action === TOOL_CALL;
  const where = auditWhere(t, row);
  const connector = auditStr(row.details.connector);
  const asked = isCall ? askedOf(t, row) : null;
  const input = isCall ? (row.details.input as Record<string, unknown> | undefined) : undefined;
  const sent = input ? Object.entries(input) : [];
  const changeDetails = isCall ? [] : auditDetailEntries(row.details);
  const copy = async () => {
    if (await copyText(row.id)) toast({ title: t("audit.panel.copied"), icon: "check" });
  };

  return (
    <SettingsPage
      title={auditHint(t, row) ?? auditPhrase(t, row)}
      subtitle={`${name} · ${whenAt(t, i18n.language, row.at)}`}
    >
      <View style={styles.lead}>
        <Text variant="body" tone="ink">
          {who ? (
            <Text variant="body" tone="ink" style={styles.semibold}>
              {`${who} `}
            </Text>
          ) : null}
          {text}
        </Text>
        {look ? <OutcomeLine mood={look.mood} mark={look.mark} text={look.text} /> : null}
      </View>
      {reason ? (
        <View style={styles.note}>
          <Note icon={reasonKey === "refused" ? "x" : "info"}>
            {`${t(`audit.panel.reason.${reasonKey}`)}: ${reason}`}
          </Note>
        </View>
      ) : null}

      <Gap />
      <GroupedList>
        {asked ? <GroupedRow label={t("audit.panel.asked")} value={asked} /> : null}
        {where && row.channel ? (
          <GroupedRow
            label={t("audit.panel.where")}
            value={where}
            chevron
            onPress={() => router.push(chatHref(row.channel?.id ?? ""))}
          />
        ) : null}
        {connector ? <GroupedRow label={t("audit.panel.via")} value={connector} /> : null}
        {row.approval ? (
          <GroupedRow label={t("audit.panel.approval")} value={auditApprovalText(t, row.approval)} />
        ) : null}
        {row.secret ? <GroupedRow label={t("audit.panel.secret")} value={auditSecretText(t, row.secret)} /> : null}
        <GroupedRow label={t("audit.panel.when")} value={whenAt(t, i18n.language, row.at)} />
      </GroupedList>

      {sent.length > 0 ? (
        <>
          <GroupedHeader>{t("audit.panel.sent")}</GroupedHeader>
          <KeyValues entries={sent} />
          <GroupedFooter>{t("audit.panel.sentHint")}</GroupedFooter>
        </>
      ) : null}
      {changeDetails.length > 0 ? (
        <>
          <GroupedHeader>{t("audit.panel.details")}</GroupedHeader>
          <KeyValues entries={changeDetails} />
        </>
      ) : null}

      {row.approval?.status === "pending" || row.channel ? (
        <>
          <Gap />
          <GroupedList>
            {row.approval?.status === "pending" ? (
              <GroupedRow
                icon="wait"
                label={t("audit.panel.openApproval")}
                chevron
                onPress={() => router.push(`/approval/${row.approval?.id ?? ""}`)}
              />
            ) : null}
            {row.channel ? (
              <GroupedRow
                icon="chat"
                label={t("audit.panel.openConversation")}
                chevron
                onPress={() => router.push(chatHref(row.channel?.id ?? ""))}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}

      <GroupedHeader>{t("audit.panel.tech")}</GroupedHeader>
      <GroupedList>
        <GroupedRow label={t("audit.panel.techAction")} sub={row.action} />
        {isCall && row.target.id ? <GroupedRow label={t("audit.panel.techTool")} sub={row.target.id} /> : null}
        {auditStr(row.details.kind) ? (
          <GroupedRow label={t("audit.panel.techKind")} sub={auditStr(row.details.kind) ?? ""} />
        ) : null}
        {said ? <GroupedRow label={t("audit.panel.techSaid")} sub={said} subLines={6} /> : null}
        {row.runId ? <GroupedRow label={t("audit.panel.techRun")} sub={row.runId} /> : null}
        <GroupedRow label={t("audit.panel.techId")} sub={row.id} />
        <GroupedRow icon="copy" label={t("audit.panel.copyLink")} onPress={() => void copy()} />
      </GroupedList>
    </SettingsPage>
  );
}

/** Who asked for a call: the person, the routine, or nobody (the agent on its own). */
function askedOf(t: TFunction, row: AuditRow) {
  const behind = auditStr(row.details.behind);
  if (behind === "person" && row.onBehalfOf) return row.onBehalfOf.name ?? t("audit.removed");
  if (behind === "routine") {
    const routine = auditRoutine(row);
    return routine ? t("audit.panel.routine", { name: routine }) : t("audit.behind.routineAny");
  }
  if (behind === "unattended") return t("audit.panel.nobody");
  return null;
}

/**
 * What was sent or kept, a field a row: its name in words ("Issue number", never `issue_number`, as the approval
 * card says it), then its value (a hidden one says so, with a lock).
 */
function KeyValues({ entries }: { entries: [string, unknown][] }) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <GroupedList>
      {entries.map(([k, v]) =>
        v === AUDIT_HIDDEN ? (
          <GroupedRow
            key={k}
            label={humanize(k)}
            below={
              <View style={styles.outcome}>
                <LineIcon name="lock" size={13} color={c.faint} variant="caption" />
                <Text variant="caption" tone="faint">
                  {t("audit.panel.hidden")}
                </Text>
              </View>
            }
          />
        ) : (
          <GroupedRow key={k} label={humanize(k)} sub={auditValueText(v)} subLines={6} />
        ),
      )}
    </GroupedList>
  );
}

const styles = StyleSheet.create({
  shrink: { flexShrink: 1 },
  // The other settings screens' note: on the groups' edge, not indented past it.
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginTop: 24 },
  end: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  outcome: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  time: { fontVariant: ["tabular-nums"] },
  semibold: { fontWeight: "600" },
  lead: { paddingHorizontal: SCREEN_X, paddingTop: 12, gap: 8 },
});
