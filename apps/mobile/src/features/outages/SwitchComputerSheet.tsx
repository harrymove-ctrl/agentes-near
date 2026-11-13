import {
  moveErrorOf,
  pickedTargetKey,
  type TargetOption,
  targetOptions,
} from "@agenteschat/client/lib/machine-outages";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  Button,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  LineIcon,
  Locked,
  OPTION_ROW,
  ProviderLogo,
  SheetScreen,
  Text,
  useToast,
} from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { successHaptic, tapHaptic } from "../shared/parts";
import { computerIcon, type MachineOutage, moveToast, sheetDesc, targetText, waitingText } from "./logic";
import { useMachineOutages, useMoveAgents } from "./queries";

/**
 * "Trocar o computador", a native form sheet: "Para onde" (only the
 * targets that can run the waiting agents' brains; one that can't take them now is disabled with the reason),
 * "Quem troca" (a switch per agent with what it has waiting), the plain hint that a task that already changed
 * files on the old computer waits for it, then "Trocar N agentes" and "Agora não". The result is a toast.
 */
export function SwitchComputerSheet({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  const q = useMachineOutages();
  const outage = q.data?.outages.find((o) => o.machineId === machineId) ?? null;

  let body: ReactNode;
  if (!q.data) {
    body = q.isError ? <Text tone="muted">{t("mobile.app.failed")}</Text> : <ActivityIndicator color={c.muted} />;
  } else if (!outage || outage.agents.length === 0) {
    body = (
      <>
        <Text variant="body" tone="muted">
          {outage ? t("mobile.outage.sheet.gone", { computer: outage.name }) : t("mobile.outage.card.backSome")}
        </Text>
        <Button variant="secondary" wide label={t("mobile.common.close")} onPress={onClose} />
      </>
    );
  } else {
    body = <SwitchForm key={outage.machineId} outage={outage} targets={q.targets} onClose={onClose} />;
  }
  return (
    <SheetScreen>
      <SheetTitle title={t("mobile.outage.sheet.title")} />
      {body}
    </SheetScreen>
  );
}

function SwitchForm({
  outage: o,
  targets,
  onClose,
}: {
  outage: MachineOutage;
  targets: Parameters<typeof targetOptions>[1];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const move = useMoveAgents();
  // Everyone switches unless unchecked (agents that start waiting while the sheet is open join checked).
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = useMemo(
    () => new Set(o.agents.filter((a) => !unchecked.has(a.agentId)).map((a) => a.agentId)),
    [o.agents, unchecked],
  );
  const options = useMemo(() => targetOptions(o, targets, chosen), [o, targets, chosen]);
  const targetKey = pickedTargetKey(options, picked);
  const target = options.find((x) => x.key === targetKey) ?? null;
  const count = chosen.size;

  // The switch's row gives its own tap (`GroupedRow`).
  const toggle = (agentId: string) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };
  const submit = () => {
    if (!target || count === 0 || move.isPending) return;
    move.mutate(
      { machineId: o.machineId, agentIds: [...chosen], target: target.target },
      {
        onSuccess: (r) => {
          const said = moveToast(t, r, o.name);
          if (said.ok) successHaptic();
          toast({
            title: said.title,
            ...(said.subtitle ? { subtitle: said.subtitle } : {}),
            icon: said.ok ? "check" : "x",
          });
          onClose();
        },
        onError: (err) => {
          const code = moveErrorOf(err);
          toast({
            title: code
              ? t(`mobile.outage.error.${code.slice("machine.".length)}`, { computer: o.name })
              : t("mobile.app.failed"),
            icon: "x",
          });
        },
      },
    );
  };

  return (
    <>
      <Text variant="body" tone="muted">
        {sheetDesc(t, o, chosen)}
      </Text>

      {/* Settings' groups: each header on its group and each note under it, at the groups' own spacing. */}
      <Locked when={move.isPending}>
        <GroupedHeader>{t("mobile.outage.sheet.where")}</GroupedHeader>
        <GroupedList>
          {options.map((x) => {
            const text = targetText(t, x);
            // Only "Has Claude Code and Codex" names the brains: each gets its maker's mark.
            const marked = x.enabled && x.brains.length > 0 && Boolean(text.desc);
            return (
              <GroupedRow
                key={x.key}
                icon={computerIcon(x.platform)}
                label={text.title}
                value={text.tag ?? undefined}
                {...(marked
                  ? { below: <BrainsLine brains={x.brains} text={text.desc} /> }
                  : { belowText: text.desc || undefined })}
                checked={x.key === targetKey}
                faint={!x.enabled}
                disabled={!x.enabled}
                onPress={() => {
                  tapHaptic();
                  setPicked(x.key);
                }}
              />
            );
          })}
        </GroupedList>
        {!options.some((x) => x.enabled) ? <GroupedFooter>{t("mobile.outage.sheet.none")}</GroupedFooter> : null}

        <GroupedHeader>{t("mobile.outage.sheet.who")}</GroupedHeader>
        <GroupedList>
          {o.agents.map((a) => (
            <GroupedRow
              key={a.agentId}
              leading={<AgentFace agentId={a.agentId} size={OPTION_ROW.face} mode="rest" live={false} />}
              label={a.name}
              value={waitingText(t, a)}
              toggle={chosen.has(a.agentId)}
              onPress={() => toggle(a.agentId)}
            />
          ))}
        </GroupedList>
        <GroupedFooter>{t("mobile.outage.sheet.hint", { computer: o.name })}</GroupedFooter>
      </Locked>

      <View style={styles.acts}>
        <Button
          variant="primary"
          wide
          label={t("mobile.outage.sheet.submit", { count })}
          loading={move.isPending}
          disabled={!target || count === 0}
          onPress={submit}
        />
        <Button variant="ghost" wide label={t("mobile.outage.sheet.later")} onPress={onClose} />
      </View>
    </>
  );
}

/** A target's line naming the brains it has, each after its maker's mark (on the line's first line). */
function BrainsLine({ brains, text }: { brains: TargetOption["brains"]; text: string }) {
  return (
    <View style={styles.descLine}>
      {brains.map((b) => (
        <LineIcon key={b} variant="footnote" size={14}>
          <ProviderLogo id={b} size="xs" />
        </LineIcon>
      ))}
      <Text variant="footnote" tone="faint" numberOfLines={2} style={styles.shrink}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The marks stay on the first of its two lines.
  descLine: { flexDirection: "row", alignItems: "flex-start", gap: 6, minWidth: 0 },
  acts: { gap: 8, marginTop: 4 },
  shrink: { flexShrink: 1 },
});
