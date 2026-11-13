import { addressesIn } from "@agenteschat/client/lib/text";
import { Avatar, Button, Select, type SelectOption } from "@agenteschat/ui";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./invite.css";

/** An address typed or pasted: one that doesn't look like an address stays, marked, to be fixed or taken out. */
export interface ChipAddress {
  email: string;
  valid: boolean;
}

/** What a paste must hold to become chips at once: more than one address, or an address with its name. */
const LIST = /[\s,;<]/;

/** The new addresses in `text`, after the chips already there (the invite dialog's and the onboarding's). */
export const chipsFrom = (text: string, known: readonly ChipAddress[]): ChipAddress[] => {
  const seen = new Set(known.map((c) => c.email));
  return addressesIn(text).filter((a) => !seen.has(a.email));
};

/** An address's face: its first letter, as a person's tile shows their initials. */
export function AddressFace({ email }: { email: string }) {
  return <Avatar name={email} initials={email.charAt(0).toUpperCase()} size="sm" />;
}

/**
 * Addresses as chips (ADR 0090), in the onboarding's people step and the invite dialog. Enter, a comma, a semicolon
 * or leaving the field hands what was typed to `onAdd`, which reads it with `addressesIn` (the way mail apps and
 * spreadsheets copy addresses: `Ana Silva <ana@x.com>`, quotes, `mailto:`); a pasted list goes at once; Backspace in
 * an empty field takes the last chip back. Each chip shows its face and address, then `aside` (its role, or why it
 * isn't sent); one that isn't an address is marked "confira" instead.
 */
export function EmailChips<T extends ChipAddress>({
  id,
  chips,
  onAdd,
  onRemove,
  aside,
  removable,
  soft,
  placeholder,
  morePlaceholder,
  describedBy,
  onEnterEmpty,
  draft: given,
  onDraftChange,
  inputRef,
}: {
  /** The field's id, for its label. */
  id: string;
  chips: readonly T[];
  /** Typed or pasted text to turn into chips. */
  onAdd: (text: string) => void;
  onRemove: (chip: T) => void;
  /** After a good address: its role, or why it won't be sent. */
  aside: (chip: T) => ReactNode;
  /** Whether a chip can be taken out (one already sent can't); all of them when left out. */
  removable?: (chip: T) => boolean;
  /** A good address that won't be sent (in already, invited already): drawn quiet. */
  soft?: (chip: T) => boolean;
  placeholder: string;
  /** Once there are chips ("Mais e-mails…"). */
  morePlaceholder: string;
  describedBy?: string;
  /** Enter with nothing typed (the invite dialog goes on). */
  onEnterEmpty?: () => void;
  /** What is typed and not a chip yet, for a screen that counts it (the invite dialog's Continuar). */
  draft?: string;
  onDraftChange?: (draft: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const [own, setOwn] = useState("");
  const draft = given ?? own;
  const setDraft = (value: string) => {
    setOwn(value);
    onDraftChange?.(value);
  };
  const ownInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? ownInput;
  const canRemove = (chip: T) => removable?.(chip) ?? true;
  const invalid = chips.some((c) => !c.valid);
  const commit = (text: string) => {
    if (text.trim()) onAdd(text);
    setDraft("");
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the box focuses its field
    <div
      className="email-chips"
      onClick={(e) => {
        if (e.target === e.currentTarget) input.current?.focus();
      }}
    >
      {chips.map((c) => (
        <span
          key={c.email}
          className="email-chip"
          data-invalid={!c.valid || undefined}
          data-soft={(c.valid && soft?.(c)) || undefined}
        >
          <AddressFace email={c.email} />
          <span className="email-chip__email">{c.email}</span>
          {c.valid ? aside(c) : <span className="email-chip__bad">{t("members.chips.check")}</span>}
          {canRemove(c) && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="close"
              aria-label={t("common.removeName", { name: c.email })}
              onClick={() => onRemove(c)}
            />
          )}
        </span>
      ))}
      <input
        ref={input}
        id={id}
        className="email-chips__input"
        type="text"
        inputMode="email"
        autoComplete="off"
        value={draft}
        placeholder={chips.length ? morePlaceholder : placeholder}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === ";") {
            e.preventDefault();
            if (draft.trim()) commit(draft);
            else if (e.key === "Enter") onEnterEmpty?.();
          } else if (e.key === "Backspace" && !draft) {
            const last = chips[chips.length - 1];
            if (last && canRemove(last)) onRemove(last);
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (!LIST.test(text.trim())) return;
          e.preventDefault();
          commit(`${draft} ${text}`);
        }}
        onBlur={() => commit(draft)}
      />
    </div>
  );
}

/** A chip's role: one choice from a short list, named "Papel de {email}". */
export function ChipRole<V extends string>({
  email,
  value,
  options,
  onChange,
}: {
  email: string;
  value: V;
  options: SelectOption<V>[];
  onChange: (value: V) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      size="sm"
      value={value}
      options={options}
      aria-label={t("members.chips.roleOf", { email })}
      onValueChange={onChange}
    />
  );
}

/** Why a good address won't be sent ("já está na Acme", "já convidado") or what became of it ("convidado"). */
export function ChipNote({ children }: { children: ReactNode }) {
  return <span className="email-chip__soft">{children}</span>;
}
