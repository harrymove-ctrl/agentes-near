import { Button } from "@agenteschat/ui";
import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";

/**
 * The computer dialog's one head: whichever surface shows (the screen, the page, a cover) puts its sub-line and
 * actions there, so the screen's and the page's own heads fold into the dialog's.
 */
export interface DialogHeadSlots {
  sub: HTMLElement | null;
  actions: HTMLElement | null;
  full: boolean;
  setFull: (full: boolean) => void;
  /** What the sub-line says while live and watching (the dialog knows of requests, holds and pauses). */
  watching: string;
  /** The screen asks before taking control; Escape dismisses that question first. */
  setAsk?: (dismiss: (() => void) | null) => void;
  /** An action that failed, said in place of the sub-line for a moment (`useSayFailed`). */
  say: (text: string) => void;
  /**
   * The last picture of the view that just left the stage (the screen for the page, or back), and whether the person
   * was in control there: where control changed, the next view shows it dimmed while it opens, never a cold
   * "Abrindo…". Written as a view goes, taken as the next one comes.
   */
  picture: { current: KeptPicture | null };
}

export interface KeptPicture {
  /** A data URL. */
  src: string;
  control: boolean;
}

export const DialogHeadContext = createContext<DialogHeadSlots | null>(null);

/** Inside the computer dialog: its head's slots. Null elsewhere (the chat's cards keep their own heads). */
export const useDialogHead = () => useContext(DialogHeadContext);

/** An action that failed: said in the computer dialog's head (a toast would land on its corner), a toast elsewhere. */
export function useSayFailed() {
  const head = useDialogHead();
  const toast = useToast();
  return (text: string) => (head ? head.say(text) : toast.show(text, "error"));
}

/** Puts a sub-line and actions in the dialog's head. */
export function DialogHead({ sub, actions }: { sub?: ReactNode; actions?: ReactNode }) {
  const head = useDialogHead();
  if (!head) return null;
  return (
    <>
      {head.sub && sub !== undefined && createPortal(sub, head.sub)}
      {head.actions && actions !== undefined && createPortal(actions, head.actions)}
    </>
  );
}

/** Full screen and back: two corners pulled apart to go in, pushed together to come out. */
export function FullScreenButton({ full, onToggle }: { full: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const label = full ? t("browser.inCard.fullExit") : t("browser.inCard.full");
  return (
    <Button
      size="sm"
      variant="ghost"
      iconOnly
      icon={full ? "shrink" : "expand"}
      className="cmp-full ac-btn--glyph"
      aria-label={label}
      title={label}
      onClick={onToggle}
    />
  );
}

/** Full screen: the agent's screen alone, or the whole dialog over its page or a cover. */
export function FullButton() {
  const head = useDialogHead();
  if (!head) return null;
  return <FullScreenButton full={head.full} onToggle={() => head.setFull(!head.full)} />;
}
