import type { MachineOs } from "@agenteschat/client";
import { useMachines } from "@agenteschat/client";
import { computerKind } from "@agenteschat/client/lib/machines";
import { Button, Chip, ComputerIcon, Icon } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/*
 * A connected computer's small pieces, shown in conversations, missions, routines and settings: apart from the
 * computers' own screens (Machines.tsx), which load with their pages, not with the app.
 */

const OSES: MachineOs[] = ["linux", "darwin", "windows", "other"];
export const osOf = (os: string): MachineOs => (OSES.includes(os as MachineOs) ? (os as MachineOs) : "other");

/** A connected computer's line icon by its id (its kind from the computers list); the generic one until known. */
export function MachineIcon({ machineId, size = 14 }: { machineId: string | null | undefined; size?: 14 | 16 }) {
  const { org } = useOrg();
  const machines = useMachines(org.id, Boolean(machineId));
  const m = machineId ? machines.data?.find((x) => x.id === machineId) : undefined;
  return m ? <ComputerIcon kind={computerKind(m.os)} size={size} /> : <Icon name="computer" size={size} />;
}

/** Online / Offline, with an icon (never a colored dot). */
export function MachineChip({ online }: { online: boolean }) {
  const { t } = useTranslation();
  return (
    <Chip icon={online ? "check" : "dash"} className="machine-chip">
      {online ? t("machines.online") : t("machines.offline")}
    </Chip>
  );
}

/** Copies text and says so in a toast (`done`; null: nothing to say), or that it couldn't. */
function useCopy() {
  const { t } = useTranslation();
  const toast = useToast();
  return async (text: string, done: string | null) => {
    try {
      await navigator.clipboard?.writeText(text);
      if (done) toast.show(done);
      return true;
    } catch {
      toast.show(t("common.unknownError"), "error");
      return false;
    }
  };
}

/**
 * A terminal command (or anything to paste) in a code block, with Copiar; `copied`: what the toast says, `onCopied`:
 * after it reached the clipboard. `labelled`: the screen's main thing (a one-line install): Copy in words, which
 * says Copied for a moment instead of a toast, and a long line wraps instead of scrolling.
 */
export function CommandBlock({
  command,
  copied,
  copyLabel,
  onCopied,
  labelled = false,
}: {
  command: string;
  copied?: string;
  copyLabel?: string;
  onCopied?: () => void;
  labelled?: boolean;
}) {
  const { t } = useTranslation();
  const copy = useCopy();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(timer);
  }, [done]);
  const label = copyLabel ?? t("common.copy");
  return (
    <div className={labelled ? "machine-command dv-cmd" : "machine-command"}>
      <pre className="machine-command__code">
        <code>{command}</code>
      </pre>
      {labelled ? (
        <Button
          size="sm"
          variant="ghost"
          icon={done ? "check" : "copy"}
          className="machine-command__copy dv-cmd__copy"
          data-copied={done || undefined}
          aria-live="polite"
          onClick={() =>
            void copy(command, null).then((ok) => {
              if (!ok) return;
              setDone(true);
              onCopied?.();
            })
          }
        >
          {done ? t("common.copied") : label}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="copy"
          className="machine-command__copy"
          aria-label={label}
          title={label}
          onClick={() =>
            void copy(command, copied ?? t("machines.commandCopied")).then((ok) => {
              if (ok) onCopied?.();
            })
          }
        />
      )}
    </div>
  );
}
