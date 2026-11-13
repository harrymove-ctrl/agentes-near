import { splitAtNames } from "@agenteschat/client/lib/text";
import { type AgentAppearance, Icon } from "@agenteschat/ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { AgentWho } from "@/components/AgentAvatar";

/**
 * Minimal toasts in the design language (glass, overlay shadow, icon + words, the tone's soft glow from the right).
 * Failed writes show the server's message; confirmations are rare and short.
 */
export interface Toast {
  id: number;
  tone: "success" | "info" | "warning" | "error" | "neutral";
  text: string;
  /** A second, smaller line ("Salvo" → "Autonomia: Pergunta sempre"). */
  detail?: string;
  /** Quick actions ("Ajustar", "Desfazer"); usually one. */
  actions?: ToastAction[];
  /** The agent the words name: its face goes before its name. */
  who?: ToastWho;
  /** Its time is up: it plays its exit (`.ac-toast[data-leaving]`, `--dur-fast`) before it goes. */
  leaving?: boolean;
}

/**
 * An agent named in a toast. Toasts draw outside the workspace (no directory there), so the caller hands its look.
 */
export interface ToastWho {
  name: string;
  appearance?: AgentAppearance;
}

/** Words for a toast: plain, or naming an agent (`who`), drawn with its face before its name. */
export type ToastText = string | { text: string; who: ToastWho };

export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastApi {
  show: (text: ToastText, tone?: Toast["tone"], action?: ToastAction | ToastAction[], detail?: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

/**
 * How long a toast stays; a word said in a toast's place (`useSaid`) stays as long, and so does an action that waits
 * for its Desfazer (cancelling an invitation).
 */
export const TOAST_MS = 6000;

let nextId = 1;
/** A toast's exit (`--dur-fast`). */
const LEAVE_MS = 140;

/** A tiny store so non-React code (the QueryClient) can raise toasts. */
export function createToastStore() {
  let toasts: Toast[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    show(words: ToastText, tone: Toast["tone"] = "success", action?: ToastAction | ToastAction[], detail?: string) {
      const actions = action ? (Array.isArray(action) ? action : [action]) : [];
      const text = typeof words === "string" ? words : words.text;
      const toast = {
        id: nextId++,
        tone,
        text,
        ...(typeof words === "string" ? {} : { who: words.who }),
        ...(detail ? { detail } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      };
      // The same words replace the older one ("Salvo" after "Salvo": the newest detail and Desfazer).
      toasts = [...toasts.filter((t) => t.text !== text), toast].slice(-3);
      emit();
      setTimeout(() => {
        toasts = toasts.map((t) => (t.id === toast.id ? { ...t, leaving: true } : t));
        emit();
        setTimeout(() => {
          toasts = toasts.filter((t) => t.id !== toast.id);
          emit();
        }, LEAVE_MS);
      }, TOAST_MS);
    },
    dismiss(id: number) {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    },
    get: () => toasts,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type ToastStore = ReturnType<typeof createToastStore>;

export function ToastProvider({
  store,
  closeLabel,
  children,
}: {
  store: ToastStore;
  closeLabel: string;
  children: ReactNode;
}) {
  const toasts = useSyncExternalStore(store.subscribe, store.get, store.get);
  const show = useCallback(
    (text: ToastText, tone?: Toast["tone"], action?: ToastAction | ToastAction[], detail?: string) =>
      store.show(text, tone, action, detail),
    [store],
  );
  // Stable: a toast appearing must not re-render everything that can show one.
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* In <body>, beside any side panel (also there): everything else goes inert under one, and a Desfazer must not. */}
      {createPortal(
        <div className="ac-toasts" aria-live="polite">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`ac-toast ac-toast--${toast.tone}`}
              role={toast.tone === "error" ? "alert" : "status"}
              data-leaving={toast.leaving || undefined}
            >
              <Icon name={toast.tone === "error" || toast.tone === "warning" ? "alert" : "check"} />
              {/* Actions that don't fit beside the words go under them, the × stays beside the first line. */}
              <span className="ac-actline">
                <span className="ac-toast__text">
                  {toast.detail ? (
                    <>
                      <b className="ac-toast__title">
                        <ToastWords toast={toast} />
                      </b>
                      <small className="ac-toast__detail">{toast.detail}</small>
                    </>
                  ) : (
                    <ToastWords toast={toast} />
                  )}
                </span>
                {toast.actions?.length ? (
                  <span className="ac-toast__acts ac-acts">
                    {toast.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className="ac-btn ac-btn--ghost ac-btn--sm"
                        onClick={() => {
                          action.run();
                          store.dismiss(toast.id);
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="ac-btn ac-btn--ghost ac-btn--sm ac-btn--icon ac-toast__close"
                aria-label={closeLabel}
                onClick={() => store.dismiss(toast.id)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** A toast's words; the agent it names with its face before the name (`.ac-who`), as in the conversation. */
function ToastWords({ toast }: { toast: Toast }) {
  const who = toast.who;
  if (!who) return <>{toast.text}</>;
  return (
    <>
      {splitAtNames(toast.text, [who.name]).map((part) =>
        typeof part === "string" ? part : <AgentWho key="who" name={who.name} appearance={who.appearance} />,
      )}
    </>
  );
}

/**
 * A word said in a toast's place, for as long as a toast would stay: a window that fills the page says it in a line
 * of its own, where a toast would land on its corner. `at` makes the same words said again new.
 */
export function useSaid() {
  const [said, setSaid] = useState<{ text: string; error: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!said) return;
    const id = setTimeout(() => setSaid(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [said]);
  const say = useCallback((text: string, error = false) => setSaid({ text, error, at: Date.now() }), []);
  const unsay = useCallback(() => setSaid(null), []);
  return { said, say, unsay };
}
