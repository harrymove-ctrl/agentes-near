import { type Message, type Proposal, useCardProposals, useDecideProposals } from "@agenteschat/client";
import {
  appLabel,
  type ChangedLine,
  cardHead,
  cardOutcome,
  chosenRows,
  firstChange,
  isOpen,
  messageProposalCards,
  proposalSections,
  proposalTarget,
  proposalTitle,
  proposerOf,
  rowStatus,
  staleCount,
} from "@agenteschat/client/lib/proposals";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Chip, DiffView, haptics, Icon, LineIcon, Text, ToggleSwitch, useTheme, useToast } from "@/ui";
import { boldRuns } from "../chat/actions";
import { AskButtons, AskCard, AskDone, AskFoot } from "../chat/asks";
import { markName } from "../chat/logic";
import { useCardTop } from "../chat/look";
import { MessageText } from "../chat/MessageText";
import { IconTile } from "../connectors/ConnectorIcon";
import { useFailed } from "../routines/hooks";
import { Face } from "../shared/Face";
import { useDirectory, useWhen } from "../shared/hooks";

/** The proposal cards an agent's message carries (`meta.memoryUpdates`, or an older `meta.proposalId`). */
export function InstructionProposals({ message: m }: { message: Message }) {
  return (
    <>
      {messageProposalCards(m.meta).map((ids) => (
        <InstructionProposalCard key={ids.join(",")} ids={ids} />
      ))}
    </>
  );
}

/**
 * The web's card for what an agent proposed (its own or its teammates' instructions, roles and apps, or the org
 * context): each change once, a row per agent and kind of change with its switch when there are several, and
 * Aceitar and Recusar for the rows you may decide. Each row applies on its own. No Editar on the phone.
 */
export function InstructionProposalCard({ ids }: { ids: string[] }) {
  const { t } = useTranslation();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const when = useWhen();
  const { colors } = useTheme();
  const cardTop = useCardTop();
  const toast = useToast();
  const failed = useFailed();
  const rows = useCardProposals(orgId, ids);
  const decide = useDecideProposals(orgId);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [first] = rows;
  if (!first) return null;
  const agentName = (id: string) => dir.anyAgent(id)?.name || t("channel.unknownAgent");
  const orgName = org?.name ?? "";
  const head = cardHead(t, rows, agentName(proposerOf(first)), agentName, org ?? orgName);
  const runs = boldRuns(t(head.key, head.values) as string);
  const { chosen, all } = chosenRows(rows, off);
  const many = rows.length > 1;
  const decides = rows.some((p) => isOpen(p) && p.canDecide);
  const toggle = (id: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = (decision: "accept" | "refuse") =>
    decide.mutate(
      { ids: chosen.map((p) => p.id), decision },
      {
        onSuccess: ({ failed: lost }) => {
          const stale = staleCount(lost);
          const ofAgent = lost.some((f) => rows.some((p) => p.id === f.id && !isTextRow(p)));
          if (stale > 0)
            toast({
              title: t(ofAgent ? "proposals.staleSomeAgent" : "proposals.staleSome", { count: stale }),
              icon: "x",
            });
          const other = lost.find((f) => staleCount([f]) === 0);
          if (other) failed(other.error);
        },
      },
    );
  const rowList = (list: Proposal[]) => (
    <>
      {list.map((p) => {
        const name = p.target.type === "org_context" ? orgName : agentName(p.agentId);
        const status = rowStatus(t, p);
        const on = p.canDecide && !off.has(p.id);
        return (
          <View key={p.id} style={styles.row}>
            <View style={styles.line}>
              {p.target.type === "org_context" ? (
                <Icon name="members" size={24} color={colors.ink2} />
              ) : (
                <Face who={{ type: "agent", id: p.agentId }} size={24} live={false} />
              )}
            </View>
            <View style={styles.fill}>
              <View style={styles.line}>
                <Text variant="body" style={styles.bold} numberOfLines={1}>
                  {name}
                </Text>
              </View>
              <SettingChange p={p} />
            </View>
            {status ? (
              <View style={styles.line}>
                <Text variant="footnote" tone="faint">
                  {status}
                </Text>
              </View>
            ) : null}
            {many && isOpen(p) ? (
              <Pressable
                disabled={!p.canDecide || decide.isPending}
                onPress={() => {
                  haptics.selection();
                  toggle(p.id);
                }}
                accessibilityRole="switch"
                accessibilityLabel={t("proposals.include", { name })}
                accessibilityState={{ checked: on, disabled: !p.canDecide }}
                hitSlop={8}
              >
                <ToggleSwitch value={on} />
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </>
  );
  const groups = proposalSections(rows);
  const texts = groups.flatMap((g) => (g.kind === "text" && g.lines.length > 0 ? [g] : []));
  const firstLine = firstChange(texts[0]?.lines);
  const change =
    texts.length > 0 ? { label: t("ask.seeChange"), content: <Diffs lines={texts.map((g) => g.lines)} /> } : null;
  const only = many ? undefined : first;
  // Waiting on the person: a request card like every other, the rows and their switches above the decision.
  if (decides)
    return (
      <AskCard
        id={ids.join(",")}
        kind="proposal"
        agentId={proposerOf(first)}
        waitsFor="you"
        lead={only ? proposalTitle(t, only, org ?? orgName, agentName) : runs.map((r) => r.text).join("")}
        well={
          only
            ? {
                tile: <IconTile name={only.target.type === "agent_access" ? "bolt" : "file"} size={20} bare />,
                title: proposalTarget(t, only, agentName, org ?? orgName),
                detail:
                  only.target.type === "agent_role"
                    ? t("proposals.roleLine", { from: only.before, to: only.after })
                    : firstLine?.text,
                more: change,
              }
            : firstLine
              ? { tile: <IconTile name="file" size={20} bare />, title: firstLine.text, more: change }
              : null
        }
        body={
          only ? (
            only.target.type === "agent_access" ? (
              <SettingChange p={only} />
            ) : undefined
          ) : (
            rowList(groups.flatMap((g) => g.rows))
          )
        }
        foot={
          <AskFoot>
            <AskButtons
              primary={
                <Button
                  variant="primary"
                  size="card"
                  wide
                  label={
                    !many
                      ? t("proposals.accept")
                      : all
                        ? t("proposals.acceptAll")
                        : t("proposals.acceptSome", { count: chosen.length })
                  }
                  disabled={decide.isPending || chosen.length === 0}
                  onPress={() => run("accept")}
                />
              }
              secondary={
                <Button
                  variant="secondary"
                  size="card"
                  wide
                  label={t("proposals.refuse")}
                  disabled={decide.isPending || chosen.length === 0}
                  onPress={() => run("refuse")}
                />
              }
            />
          </AskFoot>
        }
      />
    );
  const card = (
    <View style={[styles.card, { backgroundColor: colors.sunken }, cardTop]}>
      <View style={styles.head}>
        <LineIcon variant="subhead" name="doc" size={16} color={colors.ink2} />
        <Text variant="subhead" tone="ink2" style={styles.fill}>
          {runs.map((r, i) =>
            r.bold ? (
              <Text key={String(i)} variant="subhead" tone="ink" style={styles.bold}>
                {r.text}
              </Text>
            ) : (
              r.text
            ),
          )}
        </Text>
      </View>
      {groups.map((section) => (
        <View key={section.rows[0]?.id} style={styles.section}>
          {section.kind === "text" && section.lines.length > 0 ? <ProseDiff lines={section.lines} /> : null}
          {rowList(section.rows)}
        </View>
      ))}
    </View>
  );
  if (rows.some(isOpen)) return card;
  // Decided: one pill like a decided approval, with the last decision's time; the card when asked for.
  const outcome = cardOutcome(t, rows);
  const decidedAt = rows.reduce<string | null>(
    (at, r) => (r.decidedAt && (!at || r.decidedAt > at) ? r.decidedAt : at),
    null,
  );
  const what = many
    ? runs.map((r) => (r.bold ? markName(r.text) : r.text)).join("")
    : markName(proposalTitle(t, first, org ?? orgName, agentName));
  return (
    <AskDone
      done={outcome.accepted}
      words={`${outcome.label}: ${what}`}
      time={decidedAt ? when.short(decidedAt) : undefined}
      more={{ label: t("ask.seeChange"), content: card, card: true }}
    />
  );
}

/** What "Ver a mudança" opens: each change once. */
function Diffs({ lines }: { lines: ChangedLine[][] }) {
  return (
    <>
      {lines.map((l) => (
        <ProseDiff key={l.map((x) => x.text).join("\n")} lines={l} />
      ))}
    </>
  );
}

/** A change to instructions or the context as the web draws it: Markdown blocks, added on green, removed on red. */
function ProseDiff({ lines }: { lines: ChangedLine[] }) {
  const { t } = useTranslation();
  return (
    <DiffView
      prose
      lines={lines}
      render={(text, kind) => <MessageText body={text} small muted={kind === "del"} selectable={false} />}
      folded={(count) => t("proposals.sameLines", { count })}
    />
  );
}

const isTextRow = (p: Proposal) => p.target.type === "agent_instructions" || p.target.type === "org_context";

/** What a role or access row changes: "Papel: Dev → Revisora", or a chip per app turned on or off. */
function SettingChange({ p }: { p: Proposal }) {
  const { t } = useTranslation();
  if (p.target.type === "agent_role")
    return (
      <Text variant="footnote" tone="muted">
        {t("proposals.roleLine", { from: p.before, to: p.after })}
      </Text>
    );
  if (p.target.type !== "agent_access") return null;
  return (
    <View style={styles.chips}>
      {(p.access ?? []).map((l) => (
        <Chip
          key={l.id}
          icon={l.on ? "plus" : "x"}
          label={t(l.on ? "proposals.accessOn" : "proposals.accessOff", { app: appLabel(t, l) })}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 12, gap: 10, alignItems: "stretch" },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  section: { gap: 8 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  /** A row's first line, as tall as its switch: the face, the name and the state sit centered on it. */
  line: { minHeight: 28, justifyContent: "center" },
  fill: { flex: 1, minWidth: 0, gap: 4 },
  bold: { fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
