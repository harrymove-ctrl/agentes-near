import { splitAddresses } from "@agenteschat/client/lib/mail";
import { AffixInput, Button, Field, Token, TokenList } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A list of email addresses or `@domains` (email rules, routine filters), or
 * of other values with their own `split` (a database's hidden columns):
 * type one or several (commas or spaces), Enter or the + inside the field; each shows
 * as a chip with a remove button. `clearable` adds "Remover tudo" for two or
 * more chips, undone in place.
 */
export function AddressList({
  id,
  label,
  example,
  values,
  onChange,
  disabled,
  split = splitAddresses,
  placeholder,
  invalidText,
  inputMode = "email",
  clearable,
  suggestions,
}: {
  id: string;
  label: string;
  /** Under the field: what it takes ("Endereços ou @dominio.com"), or what was found for it. */
  example?: string;
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  /** Typed text → what is valid in it (default: addresses and `@domains`). */
  split?: (text: string) => { valid: string[]; invalid: string[] };
  placeholder?: string;
  invalidText?: string;
  inputMode?: "email" | "text";
  clearable?: boolean;
  /** Offered as the person types (the browser's own list). */
  suggestions?: string[];
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [cleared, setCleared] = useState<string[] | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // "Remover tudo" unmounts with the chips; focus lands on "Desfazer" instead of the page.
  useEffect(() => {
    if (cleared) undoRef.current?.focus();
  }, [cleared]);
  const add = () => {
    const { valid, invalid: wrong } = split(text);
    if (wrong.length > 0 || valid.length === 0) {
      setInvalid(text.trim().length > 0);
      return;
    }
    onChange([...new Set([...values, ...valid])]);
    setText("");
    setCleared(null);
    // The + turns off with the field empty: the keyboard stays where the next address goes.
    field.current?.focus();
  };
  return (
    <div className="mail-list">
      <Field
        label={label}
        id={id}
        example={example}
        error={invalid ? (invalidText ?? t("mail.list.invalid")) : undefined}
      >
        <AffixInput
          ref={field}
          value={text}
          disabled={disabled}
          inputMode={inputMode}
          autoComplete="off"
          placeholder={placeholder ?? t("mail.list.placeholder")}
          list={suggestions ? `${id}-suggestions` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          action={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              icon="plus"
              disabled={disabled || !text.trim()}
              aria-label={t("mail.list.addTo", { name: label })}
              onClick={add}
            />
          }
        />
        {suggestions && (
          <datalist id={`${id}-suggestions`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </Field>
      {values.length > 0 && (
        <TokenList label={label}>
          {values.map((v) => (
            <li key={v}>
              <Token
                removeLabel={t("common.removeName", { name: v })}
                onRemove={() => !disabled && onChange(values.filter((x) => x !== v))}
              >
                {v}
              </Token>
            </li>
          ))}
        </TokenList>
      )}
      {clearable && values.length > 1 && (
        <span className="mail-list__clear">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={t("mail.list.clearName", { name: label })}
            onClick={() => {
              setCleared(values);
              onChange([]);
            }}
          >
            {t("mail.list.clear")}
          </Button>
        </span>
      )}
      {/* Always mounted: screen readers skip a live region inserted already filled. */}
      <span className="mail-list__status" role="status">
        {cleared && values.length === 0 && (
          <span className="mail-list__clear small muted">
            {t("mail.list.cleared", { count: cleared.length })}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              ref={undoRef}
              onClick={() => {
                onChange(cleared);
                setCleared(null);
              }}
            >
              {t("mail.list.undo")}
            </Button>
          </span>
        )}
      </span>
    </div>
  );
}
