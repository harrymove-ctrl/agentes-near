import {
  type Approval,
  type ApprovalEmail,
  useCancelApproval,
  useCatalog,
  useCustomServers,
  useDecideApproval,
} from "@agenteschat/client";
import { aheadPhase } from "@agenteschat/client/lib/approval-kind";
import { approvalOriginShort, approvalOriginWords } from "@agenteschat/client/lib/approval-origin";
import { approvalEffects } from "@agenteschat/client/lib/approval-review";
import { alwaysRoutineName, approvalDoing, approvalTitle } from "@agenteschat/client/lib/approval-words";
import { fromServer, itemName } from "@agenteschat/client/lib/connected";
import { nextLabel } from "@agenteschat/client/lib/format";
import { connectorName } from "@agenteschat/client/lib/scopes";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, Chip, Fuse, haptics, LineIcon, Text, useToast } from "@/ui";
import { useInfoHint } from "@/ui/InfoHint";
import { router } from "@/ui/navigation";
import { parseInline } from "../chat/logic";
import { Spans } from "../chat/MessageSpans";
import { ConnectorIcon, IconTile } from "../connectors/ConnectorIcon";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId } from "../shared/hooks";
import { fuseRemaining, genderOf, minutesLeft } from "../shared/logic";
import { successHaptic } from "../shared/parts";
import {
  approvalRisk,
  approvalSaid,
  approvalTable,
  approvalTraits,
  approveAlwaysHint,
  approveAlwaysLabel,
  approveAlwaysOffered,
  approveAlwaysToast,
} from "./logic";

/**
 * The exact request, in reading order: the action in words, the action itself (an email as it will be,
 * else the details table: Por onde, then the values it runs with), what the agent said, what it affects
 * as chips, and the amber fuse until it expires. The chat's question and the sheet draw the same pieces.
 */

const TRAIT_ICON = {
  production: "globe",
  irreversible: "x",
  reversible: "undo",
  external: "send",
  unsent: "archive",
  deletable: "undo",
} as const;

/**
 * A trait's words. What leaves a personal workspace (ADR 0159) leaves its person's workspace, not a company: the one
 * trait with a personal sibling.
 */
export const traitKey = (trait: keyof typeof TRAIT_ICON, personal: boolean) =>
  trait === "external" && personal ? "mobile.approval.trait.externalPersonal" : `mobile.approval.trait.${trait}`;

/**
 * The action in words, as the web says it: an email's ("Salvar um rascunho de resposta para…"), a tool run by
 * name ("Ver stack trace do evento", never "Sentry: Execute sentry tool"), the app's own tools, else the server's.
 */
export function approvalTitleText(
  t: TFunction,
  a: Pick<Approval, "tool" | "title" | "params" | "email"> & Partial<Pick<Approval, "connector">>,
) {
  return approvalTitle(t, a);
}

/** "rotina «X»" / "sem ninguém acompanhando", for the card's top line; null when a person was there. */
export function useOriginShort(a: Pick<Approval, "origin">) {
  const { t } = useTranslation();
  const origin = approvalOriginShort(a);
  if (!origin) return null;
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return tt(origin.key, origin.values);
}

/**
 * The action as a card's title, in words and in the person's language: an email's and the app's own titles as
 * `approvalTitle` says them; a connector's tool by what it does ("Gerar imagem", never the server's
 * "mcp.higgsfield.ai: Generate image", which the details keep).
 */
export function approvalHeadline(t: TFunction, a: Approval, locale: string) {
  if (a.email || !a.connector) return approvalTitle(t, a);
  const doing = approvalDoing(t, a, locale);
  return doing.charAt(0).toLocaleUpperCase(locale) + doing.slice(1);
}

/**
 * The app a request goes through: the connector (a server connected by address goes by its preset's mark and its
 * own name), a mailbox for an email, our own tools otherwise. Its name heads the request's source line.
 */
export function useApprovalSource(a: Approval) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const customId = a.connector?.startsWith("custom:") ? a.connector.slice("custom:".length) : null;
  const servers = useCustomServers(orgId, customId !== null);
  if (a.email) return { kind: "mail" as const, name: a.email.mailbox, def: null, image: undefined };
  if (!a.connector)
    return { kind: "builtin" as const, name: t("approvals.panel.builtIn"), def: null, image: undefined };
  const server = customId ? servers.data?.find((s) => s.id === customId) : undefined;
  const custom = server ? fromServer(server, catalog.data?.connectors ?? []) : null;
  const def = custom ? custom.def : (catalog.data?.connectors.find((d) => d.id === a.connector) ?? null);
  const name = custom
    ? itemName(t, custom)
    : customId
      ? t("approvals.panel.orgConnector")
      : def
        ? connectorName(t, def)
        : a.connector;
  return { kind: "connector" as const, name, def, image: custom?.image };
}

/**
 * Approving a request where it shows (the conversation's card, Atividade's): a success haptic unless it was held to
 * approve (a high-risk one already buzzed), then a toast saying what follows (or that it failed); `onApproved` lets
 * the card's place know it is settled.
 */
export function useApproveNow(a: Approval, onApproved?: () => void) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const decide = useDecideApproval(orgId);
  const name = dir.agentById.get(a.agentId)?.name ?? "";
  const g = genderOf(name);
  const high = approvalRisk(a) === "high";
  const approve = (always = false) =>
    decide.mutate(
      { id: a.id, decision: "approve", always },
      {
        onSuccess: () => {
          if (!high) successHaptic();
          onApproved?.();
          toast({
            ...(always
              ? approveAlwaysToast(t, name, alwaysRoutineName(t, a))
              : {
                  title: t("mobile.approval.approved"),
                  subtitle: a.runAt
                    ? t("mobile.approval.approvedAhead", { when: nextLabel(i18n.language, a.runAt) })
                    : t(`mobile.approval.approvedSub${g}`, { name }),
                }),
            agentId: a.agentId,
          });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  return { approve, pending: decide.isPending, high };
}

/**
 * "Recusar" from a card or the request's sheet: the system's alert asks once, with the reason as an optional
 * field and Recusar in red; Cancelar leaves everything as it was (no mode of the sheet). Where the platform's
 * alerts take no text (Android), the request's sheet opens on its refusing step instead. A firm tap when it goes
 * through, then the toast saying the agent learns from it; `onRefused` lets the card's place know it is settled.
 */
export function useRefuseApproval(a: Approval, onRefused?: () => void) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const decide = useDecideApproval(orgId);
  const name = dir.agentById.get(a.agentId)?.name ?? "";
  const g = genderOf(name);
  const send = (reason: string) =>
    decide.mutate(
      { id: a.id, decision: "refuse", ...(reason.trim() ? { reason: reason.trim() } : {}) },
      {
        onSuccess: () => {
          haptics.medium();
          onRefused?.();
          toast({
            title: t("mobile.approval.refused"),
            subtitle: t(`mobile.approval.refusedSub${g}`, { name }),
            agentId: a.agentId,
          });
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      },
    );
  const refuse = () => {
    if (Platform.OS !== "ios") {
      router.push(`/approval/${a.id}?mode=refuse`);
      return;
    }
    Alert.prompt(
      t("mobile.approval.refuseAsk"),
      t(`mobile.approval.refuseWhy${g}`, { name }),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        { text: t("mobile.approval.refuse"), style: "destructive", onPress: (reason) => send(reason ?? "") },
      ],
      "plain-text",
    );
  };
  return { refuse, pending: decide.isPending };
}

/**
 * The name of the app a request goes through, for its "Por onde" row: the catalog's ("GitHub"), a server connected
 * by address by its own name, the raw id until they load.
 */
export function useConnectorNamer(a: Pick<Approval, "connector">): (id: string) => string {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const catalog = useCatalog();
  const customId = a.connector?.startsWith("custom:") ? a.connector.slice("custom:".length) : null;
  const servers = useCustomServers(orgId, customId !== null);
  return (id) => {
    if (customId) {
      const server = servers.data?.find((s) => s.id === customId);
      return server
        ? itemName(t, fromServer(server, catalog.data?.connectors ?? []))
        : t("approvals.panel.orgConnector");
    }
    const def = catalog.data?.connectors.find((d) => d.id === id);
    return def ? connectorName(t, def) : id;
  };
}

/**
 * The app a request goes through, as a mark on a tile (`useApprovalSource`); its name is read aloud. `bare`: the mark
 * alone, as a request card's name line draws it.
 */
export function ApprovalMark({
  approval: a,
  size = 20,
  bare = false,
}: {
  approval: Approval;
  size?: number;
  bare?: boolean;
}) {
  const source = useApprovalSource(a);
  return (
    <View accessible accessibilityLabel={source.name}>
      {source.kind === "mail" ? (
        <IconTile name="mail" size={size} bare={bare} />
      ) : source.kind === "builtin" ? (
        <IconTile name="shield" size={size} bare={bare} />
      ) : (
        <ConnectorIcon def={source.def} image={source.image} label={source.name} size={size} bare={bare} />
      )}
    </View>
  );
}

/**
 * What an approval will do, drawn on its card (its preview): an email as it goes, its subject in bold, to whom under
 * it, then its text. Only an email: an action's values stay on its line (their names are the tool's own, often
 * English), the whole call under "Ver detalhes". `hasApprovalPreview` says whether there is one.
 */
export function ApprovalPreview({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  if (!a.email) return null;
  return (
    <View style={styles.previewMail}>
      <Text variant="subhead" tone="ink" style={styles.medium} numberOfLines={2}>
        {a.email.subject || t("approval.email.noSubject")}
      </Text>
      {a.email.to.length > 0 ? (
        <Text variant="footnote" tone="muted" numberOfLines={1}>
          {a.email.to.join(", ")}
        </Text>
      ) : null}
      {a.email.body ? (
        <Text variant="small" tone="ink2" style={[styles.said, styles.previewBody]}>
          {a.email.body}
        </Text>
      ) : null}
    </View>
  );
}

export const hasApprovalPreview = (a: Approval) => Boolean(a.email);

/**
 * The email an approval writes, as it will be: its subject in bold, then De (the mailbox and its provider), Para,
 * Cc, Cco, each label above its value (never beside it), the text folded to four lines ("Ler tudo") unless `full`,
 * and the message it answers. `flat`: drawn on a request card, no frame of its own (never a box in a card).
 */
export function ApprovalEmailLetter({
  email,
  full,
  flat = false,
}: {
  email: ApprovalEmail;
  full?: boolean;
  flat?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [open, setOpen] = useState(false);
  const long = email.body.length > 180 || email.body.split("\n").length > 4;
  const rows: { label: string; value: string; note?: string }[] = [
    { label: t("approval.email.from"), value: email.from || email.mailbox, note: email.provider ?? undefined },
    ...(email.to.length > 0 ? [{ label: t("approval.email.to"), value: email.to.join(", ") }] : []),
    ...(email.cc.length > 0 ? [{ label: t("approval.email.cc"), value: email.cc.join(", ") }] : []),
    ...(email.bcc.length > 0 ? [{ label: t("approval.email.bcc"), value: email.bcc.join(", ") }] : []),
  ];
  const answers = email.original
    ? t(
        email.verb === "forward"
          ? email.original.from
            ? "mobile.approval.forwardsFrom"
            : "mobile.approval.forwards"
          : email.original.from
            ? "mobile.approval.answersFrom"
            : "mobile.approval.answers",
        { subject: email.original.subject, from: email.original.from ?? "" },
      )
    : null;
  return (
    <View style={flat ? styles.letterFlat : [styles.letter, { borderColor: c.line2 }]}>
      <View style={[flat ? styles.letterHeadFlat : styles.letterHead, { borderBottomColor: c.line2 }]}>
        <Text variant="subhead" tone="ink" style={styles.medium}>
          {email.subject || t("approval.email.noSubject")}
        </Text>
        {rows.map((r) => (
          <View key={r.label}>
            <Text variant="footnote" tone="muted">
              {r.label}
            </Text>
            <Text variant="small" tone="ink" style={styles.medium}>
              {r.value}
            </Text>
            {r.note ? (
              <Text variant="footnote" tone="muted">
                {r.note}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
      {email.body ? (
        <View style={flat ? styles.letterBodyFlat : styles.letterBody}>
          <Text variant="small" tone="ink2" style={styles.said} numberOfLines={full || open ? undefined : 4}>
            {email.body}
          </Text>
          {!full && long ? (
            // An 18-point line: 13 of slop around it gives the 44-point target.
            <Pressable
              accessibilityRole="button"
              hitSlop={13}
              onPress={() => setOpen((o) => !o)}
              style={({ pressed }) => (pressed ? styles.pressed : null)}
            >
              <Text variant="footnote" tone="ink2" style={[styles.medium, styles.underline]}>
                {open ? t("approval.email.less") : t("approval.email.more")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {answers ? (
        <View
          style={[
            flat ? styles.answersFlat : styles.answers,
            { borderTopColor: c.line2 },
            !flat && { backgroundColor: c.sunken },
          ]}
        >
          <LineIcon name="reply" size={13} color={c.muted} variant="footnote" />
          <Text variant="footnote" tone="muted" style={styles.grow}>
            {answers}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** What the agent said before asking, after the action: its face, "Lisa:" and its words. */
export function ApprovalSaid({
  approval: a,
  name,
}: {
  approval: Pick<Approval, "agentId" | "why" | "trail">;
  name: string;
}) {
  const { t } = useTranslation();
  const said = approvalSaid(a);
  if (!said) return null;
  return (
    <View style={styles.saidRow}>
      <AgentFace agentId={a.agentId} size={20} />
      <Text variant="small" tone="ink2" style={[styles.grow, styles.said]}>
        <Text variant="small" tone="ink" style={styles.medium}>
          {name}:{" "}
        </Text>
        {t("mobile.approval.saidText", { text: said })}
      </Text>
    </View>
  );
}

/** "Para todos, em produção", "Dá para desfazer": only what the request itself says. */
export function ApprovalTraits({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  const personal = isPersonal(useOrg().org);
  const traits = approvalTraits(a);
  if (traits.length === 0) return null;
  return (
    <View style={styles.chips}>
      {traits.map((tr) => (
        <Chip key={tr} icon={TRAIT_ICON[tr]} label={t(traitKey(tr, personal))} />
      ))}
    </View>
  );
}

/** Whether the request can be undone, as a chip after its title ("Não dá para desfazer"); none when it doesn't say. */
export function ApprovalUndoChip({ approval: a }: { approval: Approval }) {
  const { t } = useTranslation();
  const { undo } = approvalEffects(a);
  return undo ? <Chip icon={TRAIT_ICON[undo]} label={t(`mobile.approval.trait.${undo}`)} /> : null;
}

/**
 * Por onde, then the exact values (at most `max` rows; `long`: whole, every one), on a sunken plate.
 * `stacked`: each label above its value and no plate, for a request card where a label column squeezes the values.
 */
export function ApprovalDetails({
  approval: a,
  max = 3,
  long = false,
  stacked = false,
}: {
  approval: Approval;
  max?: number;
  long?: boolean;
  stacked?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const nameOf = useConnectorNamer(a);
  const rows = approvalTable(a, max, nameOf, long);
  if (rows.length === 0) return null;
  return (
    // Stacked it opens inside a request card: flat on it, divided by hairlines (never a plate in a card).
    <View style={stacked ? undefined : [styles.facts, { backgroundColor: c.sunken }]}>
      {rows.map((r, i) => (
        <View
          key={r.label ?? "via"}
          style={[
            stacked ? styles.factStacked : styles.fact,
            i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 },
          ]}
        >
          <Text
            variant={stacked ? "footnote" : "small"}
            tone="muted"
            style={stacked ? undefined : styles.factKey}
            numberOfLines={1}
          >
            {r.label ?? t("mobile.approval.via")}
          </Text>
          <Text
            variant="small"
            tone="ink"
            style={stacked ? styles.wrapAnywhere : styles.grow}
            numberOfLines={long ? undefined : stacked ? 4 : 2}
          >
            <Spans inline={parseInline(r.value)} />
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Why it asks, read before the action (ADR 0053 §8): "Pedido pela rotina «X» enquanto ninguém
 * acompanhava" when nobody was watching, then "Theo disse: “…”" (its reason, else its last words).
 * The request itself, or its notification (only its origin and why).
 */
export function ApprovalWhy({
  approval: a,
  name,
}: {
  approval: Pick<Approval, "origin" | "why" | "trail">;
  name: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const said = approvalSaid(a);
  const origin = approvalOriginWords(a);
  if (!said && !origin) return null;
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (
    <View style={styles.why}>
      {origin ? (
        <View style={styles.origin}>
          <LineIcon name="clock" size={13} color={c.muted} variant="footnote" />
          <Text variant="footnote" tone="muted" style={styles.grow}>
            {tt(origin.key, origin.values)}
          </Text>
        </View>
      ) : null}
      {said ? (
        <Text variant="small" tone="ink2" style={styles.said}>
          {t("mobile.approval.why", { name, text: said })}
        </Text>
      ) : null}
    </View>
  );
}

/** A request for an action prepared ahead: that approving covers a later run, and when, as on the web. */
export function ApprovalAheadLine({
  approval: a,
}: {
  approval: Pick<Approval, "runAt" | "status" | "executedAt" | "decidedAt">;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  if (aheadPhase(a) !== "asking" || !a.runAt) return null;
  return (
    <View style={styles.origin}>
      <LineIcon name="clock" size={15} color={c.ink2} variant="small" />
      <Text variant="small" tone="ink" style={[styles.grow, styles.medium]}>
        {t("approval.ahead.line", { when: nextLabel(i18n.language, a.runAt) })}
      </Text>
    </View>
  );
}

/** Withdraws an action approved ahead before its time (its routine's run won't do it), and says so. */
export function useCancelAhead() {
  const { t } = useTranslation();
  const toast = useToast();
  const cancel = useCancelApproval(useOrgId());
  return {
    pending: cancel.isPending,
    cancel: (id: string, onDone?: () => void) =>
      cancel.mutate(id, {
        onSuccess: () => {
          toast({ title: t("approval.ahead.canceled") });
          onDone?.();
        },
        onError: () => toast({ title: t("mobile.app.failed"), icon: "x" }),
      }),
  };
}

/** "Aprovar sempre" in a request card's row of buttons, the same size as the others (its ⓘ: `ApproveAlwaysInfo`). */
export function ApproveAlwaysButton({
  approval: a,
  disabled,
  onPress,
}: {
  approval: Approval;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  if (!approveAlwaysOffered(a)) return null;
  return (
    <Button variant="secondary" size="card" label={approveAlwaysLabel(t, a)} disabled={disabled} onPress={onPress} />
  );
}

/**
 * What "Aprovar sempre" covers and where to undo it, behind an ⓘ (a touch screen has no tooltip): `children` puts the
 * ⓘ after the button, in the row that holds only buttons, and its words under the row (null while closed, so the row
 * keeps no room for them). Both null where the request doesn't offer it.
 */
export function ApproveAlwaysInfo({
  approval: a,
  name,
  children,
}: {
  approval: Approval | undefined;
  name: string;
  children: (info: { button: ReactNode; text: ReactNode }) => ReactNode;
}) {
  const { t } = useTranslation();
  const offered = a ? approveAlwaysOffered(a) : false;
  const info = useInfoHint({
    name: t("common.about", { label: a ? approveAlwaysLabel(t, a) : "" }),
    text: a && offered ? approveAlwaysHint(t, a, name || t("channel.unknownAgent")) : "",
  });
  return (
    <>
      {children(offered ? { button: info.button, text: info.open ? info.text : null } : { button: null, text: null })}
    </>
  );
}

/** The amber fuse burning to the expiry and "expira em N min" (amber: it waits on a person). */
export function ApprovalFuse({ approval: a }: { approval: Pick<Approval, "createdAt" | "expiresAt"> }) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow();
  return (
    <View style={styles.fuse}>
      <View style={styles.grow}>
        <Fuse color="amber" remaining={fuseRemaining(a.createdAt, a.expiresAt, now)} />
      </View>
      <Text variant="footnote" style={[styles.expiry, { color: c.amber }]}>
        {t("mobile.approval.expiresIn", { count: minutesLeft(a.expiresAt, now) })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  facts: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 4 },
  // With the box's 4, the first and last fact sit 10 from its edge, as the letter's head and body do.
  fact: { flexDirection: "row", gap: 10, paddingVertical: 6 },
  factStacked: { gap: 2, paddingVertical: 6 },
  wrapAnywhere: { flexShrink: 1 },
  factKey: { width: 92 },
  grow: { flex: 1, minWidth: 0 },
  said: { lineHeight: 20 },
  why: { gap: 4 },
  origin: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  fuse: { flexDirection: "row", alignItems: "center", gap: 10 },
  letter: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, borderBottomLeftRadius: 6, overflow: "hidden" },
  letterHead: { gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  letterBody: { gap: 6, paddingHorizontal: 12, paddingVertical: 10 },
  // On a request card: no frame, the head and the text divided by a hairline.
  letterFlat: { gap: 0 },
  letterHeadFlat: { gap: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  letterBodyFlat: { gap: 6, paddingTop: 10 },
  answersFlat: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  previewMail: { gap: 2 },
  previewBody: { marginTop: 6 },
  // The values side by side as they fit, each label above its value.
  answers: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  medium: { fontWeight: "600" },
  underline: { textDecorationLine: "underline" },
  pressed: { opacity: 0.6 },
  saidRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  expiry: { fontWeight: "500", fontVariant: ["tabular-nums"] },
});
