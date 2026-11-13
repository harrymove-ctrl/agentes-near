import { ApiError, type PageTarget } from "@agenteschat/client";
import type { agentGrammar } from "@agenteschat/client/lib/grammar";
import { isBlankPage, openRefusalKey, shownAddress } from "@agenteschat/client/lib/sites";
import { Button, Icon, Locked } from "@agenteschat/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { SiteIcon } from "./SiteIcon";

const NAV = [
  { go: "back", icon: "chevronLeft", label: "browser.inCard.navBack" },
  { go: "forward", icon: "chevronRight", label: "browser.inCard.navForward" },
  { go: "reload", icon: "refresh", label: "browser.inCard.navReload" },
] as const;

/**
 * The address bar of the agent's browser (ADR 0040 §7), always at the page's top like a browser's own: the page's
 * address, which the person in control edits (Enter opens it, Esc puts it back), with back, forward and reload.
 * Watching, the address alone, read only. A refusal (outside the agent's sites, not an address, a page that didn't
 * load) is said under it.
 */
export function AddressBar({
  grammar,
  url,
  host,
  onOpen,
  readOnly = false,
  focus = false,
  cloud = false,
  end,
}: {
  grammar: ReturnType<typeof agentGrammar>;
  /** The page's address now; null before any page. */
  url: string | null;
  /** Its host, for the site's icon ("" for none). */
  host: string;
  /** Opens the typed address or moves back, forward or reloads; rejects with the server's refusal. */
  onOpen: (to: PageTarget) => Promise<unknown>;
  readOnly?: boolean;
  /** Takes the focus when it appears: with the browser closed, an address is the next thing to type. */
  focus?: boolean;
  /** The workspace's own computer: its refusals never say it is off. */
  cloud?: boolean;
  /** At the bar's end (the page's Colar). */
  end?: ReactNode;
}) {
  const { t } = useTranslation();
  // What the person is typing; null: the page's address.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => {
    if (focus && !readOnly) input.current?.focus();
  }, [focus, readOnly]);
  const run = async (to: PageTarget) => {
    if (busy || readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await onOpen(to);
      setDraft(null);
      // Unlocked first: `Locked` hands the focus back, and a page that opened takes it away from the bar.
      flushSync(() => setBusy(false));
      input.current?.blur();
    } catch (e) {
      setError(t(openRefusalKey(e instanceof ApiError ? e.code : undefined, cloud), grammar));
      setBusy(false);
    }
  };
  return (
    <form
      className={readOnly ? "brw-go is-read" : "brw-go"}
      onSubmit={(e) => {
        e.preventDefault();
        const typed = (draft ?? "").trim();
        if (typed) void run(typed);
      }}
    >
      <Locked when={busy}>
        {!readOnly && (
          <span className="brw-go__nav">
            {NAV.map((n) => (
              <Button
                key={n.go}
                type="button"
                size="sm"
                variant="ghost"
                iconOnly
                icon={n.icon}
                aria-label={t(n.label)}
                title={t(n.label)}
                onClick={() => void run({ go: n.go })}
              />
            ))}
          </span>
        )}
        <label className="brw-go__field">
          {host ? <SiteIcon host={host} /> : <Icon name="globe" size={14} />}
          <input
            ref={input}
            type="text"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="url"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={2048}
            readOnly={readOnly}
            data-esc-own={draft === null ? undefined : ""}
            value={draft ?? shownAddress(url)}
            onFocus={(e) => {
              // The whole address, selected, as a browser's bar does: typing replaces it.
              if (!readOnly) setDraft((typed) => typed ?? (isBlankPage(url) ? "" : (url ?? "")));
              const el = e.currentTarget;
              requestAnimationFrame(() => el.select());
            }}
            onBlur={() => {
              if (!busy) setDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || draft === null) return;
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
              setError(null);
              e.currentTarget.blur();
            }}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder={readOnly ? "" : t("browser.inCard.goPlaceholder")}
            aria-label={t("browser.inCard.goLabel")}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </label>
      </Locked>
      {end}
      {error && (
        <p id={errorId} className="brw-go__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
