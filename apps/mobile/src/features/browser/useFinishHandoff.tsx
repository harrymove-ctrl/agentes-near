import { type BrowserHandoff, handoffWantsWords, useBrowserHandoffActions } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, useToast } from "@/ui";
import { useOrgId } from "../shared/hooks";
import { genderOf } from "../shared/logic";
import { PromptForm } from "../shared/PromptForm";
import { successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { FAILED_REASONS, NOTE_MAX } from "./logic";

/**
 * Ending a person's turn on an agent's browser or screen. Pronto or Devolver hands back at once, and `leaveNote` is the
 * same with a sheet for what the person wants the agent to know, which it reads as their own words. Where the request
 * asked the person something (`handoffWantsWords`) Pronto opens that sheet, or the answer would be lost. "Não consegui"
 * is a sheet too. `doneLabel`: the word the turn ends with. `finishing`: from the answer until `after` (the screen's
 * status read again) settles, so a switch cover never sees the old mode in between.
 */
export function useFinishHandoff(
  handoff: BrowserHandoff | null | undefined,
  name: string,
  doneLabel: string,
  after?: () => Promise<unknown>,
) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const sheet = useSheet();
  const actions = useBrowserHandoffActions(orgId);
  const g = genderOf(name);
  const [finishing, setFinishing] = useState(false);
  const finish = async (ok: boolean, said?: string) => {
    if (!handoff) return;
    const text = said?.slice(0, NOTE_MAX) || undefined;
    setFinishing(true);
    try {
      if (ok) await actions.done(handoff.id, text);
      else await actions.failed(handoff.id, text);
      successHaptic();
      await after?.();
    } catch {
      toast({ title: t("mobile.app.failed"), icon: "x" });
    } finally {
      setFinishing(false);
    }
  };
  // No haptic here: the press gives its own (`Button`, the dock's `PressScale`).
  const leaveNote = () => {
    sheet.open(
      <PromptForm
        title={t("mobile.browser.done.title")}
        intro={t(`mobile.browser.done.intro${g}`, { name })}
        placeholder={t("mobile.browser.done.placeholder")}
        submitLabel={doneLabel}
        icon="check"
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          await finish(true, text);
        }}
      />,
    );
  };
  const handBack = () => {
    if (finishing) return;
    if (handoffWantsWords(handoff)) return leaveNote();
    void finish(true);
  };
  const couldnt = () => {
    sheet.open(
      <PromptForm
        title={t("mobile.browser.failed.title")}
        intro={t(`mobile.browser.failed.intro${g}`, { name })}
        placeholder={t("mobile.browser.failed.placeholder")}
        submitLabel={t("mobile.browser.failed.send")}
        allowEmpty
        onSubmit={async (text) => {
          sheet.close();
          await finish(false, text.trim() || undefined);
        }}
      >
        <View style={styles.reasons}>
          {FAILED_REASONS.map((r) => (
            <Button
              key={r}
              variant="secondary"
              size="sm"
              label={t(`mobile.browser.failed.reason.${r}`)}
              onPress={() => {
                sheet.close();
                void finish(false, t(`mobile.browser.failed.reason.${r}`));
              }}
            />
          ))}
        </View>
      </PromptForm>,
    );
  };
  return { handBack, leaveNote, couldnt, finishing };
}

const styles = StyleSheet.create({
  reasons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
