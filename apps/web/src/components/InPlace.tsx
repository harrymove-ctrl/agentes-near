import { useIssue } from "@agenteschat/client";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { IssueDialog } from "@/pages/IssuePage";

/** Opens a task a conversation names in its dialog, over the conversation (routines: `DetailsLink`). */
export interface InPlace {
  issue: (number: number) => void;
}

const InPlaceContext = createContext<InPlace | null>(null);

type Shown = { kind: "issue"; number: number };

/**
 * In a conversation, a task an agent names (its receipt, an issue's card) opens in its dialog over the conversation, not on its page: closing it leaves the person where they were.
 */
export function InPlaceProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const close = useCallback(() => setShown(null), []);
  const value = useMemo<InPlace>(
    () => ({
      issue: (number) => setShown({ kind: "issue", number }),
    }),
    [],
  );
  return (
    <InPlaceContext.Provider value={value}>
      {children}
      {shown?.kind === "issue" && <IssueOver key={shown.number} number={shown.number} onClose={close} />}
    </InPlaceContext.Provider>
  );
}

/** Opens a task over the conversation; null elsewhere (callers link to its page instead). */
export const useInPlace = () => useContext(InPlaceContext);

/** A task's dialog by its number, once loaded; gone or out of reach, a toast says so. */
function IssueOver({ number, onClose }: { number: number; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const issue = useIssue(org.id, number);
  useEffect(() => {
    if (!issue.isError) return;
    toast.show(t("issues.notFound"), "error");
    onClose();
  }, [issue.isError, toast, t, onClose]);
  return issue.data ? <IssueDialog issue={issue.data} onClose={onClose} /> : null;
}
