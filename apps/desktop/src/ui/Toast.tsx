import { Icon, type IconName } from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

type Show = (message: string, icon?: IconName) => void;
const ToastContext = createContext<Show>(() => {});

/** One short confirmation at a time at the bottom of the window ("Pasta removida"). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; icon: IconName; key: number } | null>(null);
  const [on, setOn] = useState(false);
  const show = useCallback<Show>((message, icon = "check") => {
    setToast({ message, icon, key: Date.now() });
    setOn(true);
  }, []);
  // The shown toast's own timer: a toast asked for after the provider is gone (an action ending after its window)
  // starts none.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setOn(false), 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <output className="dk-toast" data-on={on || undefined} aria-live="polite">
        {toast && (
          <>
            <Icon name={toast.icon} size={14} />
            {toast.message}
          </>
        )}
      </output>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
