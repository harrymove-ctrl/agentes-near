import type { Credential, Member } from "@agenteschat/client";
import { apiPickOptions, type BrainPickOption, brainPickText } from "@agenteschat/client/lib/brain-picker";
import { keyLine, type ModelChoice, providerLabel } from "@agenteschat/client/lib/providers";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  AffixInput,
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAppearance,
  Avatar,
  agentGradient,
  Carousel,
  ChosenValue,
  ColorPicker,
  colorKey,
  Field,
  fold,
  Icon,
  type IconName,
  isHexColor,
  matchesWords,
  Popover,
  ProviderLogo,
  SearchSelect,
  Select,
  type SelectOption,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { QUICK_BUDGETS, ROLE_IDS, ROLE_PRESETS, readBudget } from "@/lib/new-agent";

/*
 * The pieces "Criar agente" and the agent page share (same markup, same
 * `newag__*` styles): the look, the owner and key pickers, "Quem pensa",
 * the budget and the instruction tips; the role as a tag and text edited in place.
 */

/** Select value for "Sem responsável" (the API takes `ownerUserId: null`). */
export const NO_OWNER = "__none__";
/** Value of the "Chave padrão do workspace" option (the API takes `credentialId: null`). */
export const DEFAULT_KEY = "__default__";

/** "$10", "US$ 12,50": whole amounts without cents, as the language writes dollars. */
export const usd = (_t: TFunction, locale: string, n: number) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);

/**
 * The model picker's options: each provider's models under its name, OpenRouter's good picks before the rest of its
 * list; those without a key say why.
 */
export const modelOptions = (t: TFunction, locale: string, choices: [string, ModelChoice[]][]) =>
  apiPickOptions(t, locale, choices).map(pickSelectOption);

/** A "Quem pensa" option as a select's, its maker's mark before it (Automático's bulb). */
export const pickSelectOption = (o: BrainPickOption): SelectOption & BrainPickOption => ({
  ...o,
  leading: o.mark ? (
    <ProviderLogo id={o.mark} size="sm" />
  ) : (
    <span className="newag__ib">
      <Icon name="bulb" size={16} />
    </span>
  ),
});

/**
 * "Quem pensa" on the new agent's step: every model and plan the agent's page offers (`brainPickOptions`), in one
 * list searched by name, maker, plan or "free"; the chosen one reads as what thinks ("Sonnet pelo plano do Claude").
 */
export function BrainPickSelect({
  options,
  value,
  onChange,
  fallback,
}: {
  options: BrainPickOption[];
  value: string | undefined;
  onChange: (option: BrainPickOption) => void;
  /** What the trigger says for a choice the list doesn't have (the last setup's, a proposal's). */
  fallback: string;
}) {
  const { t } = useTranslation();
  const shown = useMemo(() => options.map(pickSelectOption), [options]);
  return (
    <SearchSelect
      className="agp-brainsel"
      aria-label={t("brain.title")}
      value={value}
      onValueChange={(v) => {
        const o = options.find((x) => x.value === v);
        if (o) onChange(o);
      }}
      options={shown}
      matches={(o, q) => matchesWords(brainPickText(o), q)}
      labels={{
        search: t("models.search"),
        searchPlaceholder: t("newAgent.brainPick.searchPlaceholder"),
        noResults: t("models.noResults"),
        list: t("models.list"),
      }}
      renderValue={(o) =>
        o ? (
          <span>
            <ChosenValue option={{ ...o, label: o.title }} />
          </span>
        ) : (
          <span className="newag__sel-value">{fallback}</span>
        )
      }
    />
  );
}

/** A model picker for a long list: a search over the models (name, maker, id), shaped like the cards around it. */
export function ModelSelect({
  value,
  onChange,
  options,
  className,
  "aria-label": label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  return (
    <SearchSelect
      className={className}
      aria-label={label}
      value={value}
      onValueChange={onChange}
      options={options}
      labels={{
        search: t("models.search"),
        searchPlaceholder: t("models.searchPlaceholder"),
        noResults: t("models.noResults"),
        list: t("models.list"),
      }}
      renderValue={(o) =>
        o ? (
          <span>
            <ChosenValue option={o} />
          </span>
        ) : (
          value
        )
      }
    />
  );
}

/**
 * Key choices by their provider's mark: the workspace default first (with its masked hint), then the other
 * stored keys.
 */
/** `provider`: whose key the default would be when the workspace has none set (the chosen model's maker). */
export function keyOptions(
  t: TFunction,
  credentials: Credential[],
  defaultId: string | null,
  provider?: string,
): SelectOption[] {
  const live = credentials.filter((c) => !c.revokedAt);
  const def = live.find((c) => c.id === defaultId);
  return [
    {
      value: DEFAULT_KEY,
      label: t("newAgent.defaultKey"),
      description: def
        ? t("newAgent.defaultKeyDesc", { provider: providerLabel(def.provider), hint: def.keyHint })
        : undefined,
      leading:
        def || provider ? (
          <ProviderLogo id={def?.provider ?? provider ?? ""} size="sm" />
        ) : (
          <span className="newag__ib">
            <Icon name="key" size={16} />
          </span>
        ),
    },
    ...live
      .filter((c) => c.id !== defaultId)
      .map((c) => ({
        value: c.id,
        label: c.label,
        description: keyLine(t, c),
        leading: <ProviderLogo id={c.provider} size="sm" />,
      })),
  ];
}

type LookPatch = Partial<Required<AgentAppearance>>;

type LookPickProps = {
  look: Required<AgentAppearance>;
  onPick: (patch: LookPatch) => void;
  /** Pointing at an option tries it on the agent; null takes it off again (a new agent's card, ADR 0164). */
  onPreview?: (patch: LookPatch | null) => void;
};

/** Pointing at an option previews it, leaving takes it off (only when the picker asks for previews). */
const tryOn = (onPreview: LookPickProps["onPreview"], patch: LookPatch) =>
  onPreview
    ? { onPointerEnter: () => onPreview(patch), onPointerLeave: () => onPreview(null) }
    : ({} as Record<string, never>);

/** The choices of a look row: wrapping ("Criar agente") or one sliding row (the agent's settings). */
function ChoiceRow({
  label,
  carousel,
  acc,
  children,
}: {
  label: string;
  carousel?: boolean;
  acc?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (carousel)
    return (
      <Carousel label={label} previousLabel={t("look.previous")} nextLabel={t("look.next")} className="newag__car">
        {children}
      </Carousel>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: pressable options, not a native fieldset
    <div className={acc ? "newag__opts newag__opts--acc" : "newag__opts"} role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** Color swatches, eyes and an accessory, each a live symbol. `onPick` gets what changed. */
export function LookPicker({ look, onPick, onPreview }: LookPickProps) {
  const { t } = useTranslation();
  return (
    <>
      <div className="newag__look-row">
        <span className="newag__label">
          {t("look.color")} <span className="newag__opt-label">{t(`look.colors.${colorKey(look.color)}`)}</span>
        </span>
        <ColorChoices look={look} onPick={onPick} onPreview={onPreview} />
      </div>
      <div className="newag__look-row">
        <span className="newag__label">{t("look.eyes")}</span>
        <EyesChoices look={look} onPick={onPick} onPreview={onPreview} />
      </div>
      <div className="newag__look-row">
        <span className="newag__label">
          {t("look.accessory")} <span className="newag__opt-label">{t("newAgent.optional")}</span>
        </span>
        <AccessoryChoices look={look} onPick={onPick} onPreview={onPreview} />
      </div>
    </>
  );
}

function ColorChoices({ look, onPick, onPreview }: LookPickProps) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: pressable swatches, not a native fieldset
    <div className="newag__swatches" role="group" aria-label={t("look.color")}>
      {AGENT_COLORS.map((c) => {
        const [top, bottom] = agentGradient(c);
        return (
          <button
            key={c}
            type="button"
            className="newag__swatch"
            aria-label={t(`look.colors.${c}`)}
            title={t(`look.colors.${c}`)}
            aria-pressed={look.color === c}
            style={{ "--a": top, "--b": bottom } as CSSProperties}
            onClick={() => onPick({ color: c })}
            {...tryOn(onPreview, { color: c })}
          />
        );
      })}
      <CustomColor look={look} onPick={onPick} />
    </div>
  );
}

/** The ninth swatch, "Personalizar": a rainbow until a custom color is picked, then that color, selected. */
function CustomColor({ look, onPick }: LookPickProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const custom = isHexColor(look.color);
  const [top, bottom] = custom ? agentGradient(look.color) : [];
  return (
    <Popover
      label={t("look.customColor")}
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className={custom ? "newag__swatch" : "newag__swatch newag__swatch--custom"}
          aria-label={t("look.customColor")}
          title={t("look.customColor")}
          aria-pressed={custom}
          style={custom ? ({ "--a": top, "--b": bottom } as CSSProperties) : undefined}
        />
      }
    >
      <ColorPicker
        value={look.color}
        onChange={(color) => onPick({ color })}
        onDone={() => setOpen(false)}
        labels={{ area: t("look.colorArea"), hue: t("look.hue"), hex: t("look.hex") }}
      />
    </Popover>
  );
}

function EyesChoices({ look, onPick, onPreview, carousel }: LookPickProps & { carousel?: boolean }) {
  const { t } = useTranslation();
  return (
    <ChoiceRow label={t("look.eyes")} carousel={carousel}>
      {AGENT_EYES.map((e) => (
        <button
          key={e}
          type="button"
          className="newag__opt"
          aria-pressed={look.eyes === e}
          onClick={() => onPick({ eyes: e })}
          {...tryOn(onPreview, { eyes: e })}
        >
          <span className="newag__stage">
            <AgentAvatar
              framed={false}
              name={t(`look.eyesNames.${e}`)}
              appearance={{ ...look, eyes: e, accessory: "none" }}
            />
          </span>
          {t(`look.eyesNames.${e}`)}
        </button>
      ))}
    </ChoiceRow>
  );
}

function AccessoryChoices({ look, onPick, onPreview, carousel }: LookPickProps & { carousel?: boolean }) {
  const { t } = useTranslation();
  return (
    <ChoiceRow label={t("look.accessory")} carousel={carousel} acc>
      {AGENT_ACCESSORIES.map((a) => (
        <button
          key={a}
          type="button"
          className="newag__opt"
          aria-pressed={look.accessory === a}
          onClick={() => onPick({ accessory: a })}
          {...tryOn(onPreview, { accessory: a })}
        >
          <span className="newag__stage">
            {a === "none" ? (
              <Icon name="block" />
            ) : (
              <AgentAvatar
                size="sm"
                framed={false}
                name={t(`look.accessories.${a}`)}
                appearance={{ ...look, accessory: a }}
              />
            )}
          </span>
          {t(`look.accessories.${a}`)}
        </button>
      ))}
    </ChoiceRow>
  );
}

/**
 * The look right on the agent's settings: the colors, then the eyes and what it
 * wears as one sliding row each, so the section stays short. Each pick shows at once.
 */
export function LookRows({
  look,
  onChange,
}: {
  look: Required<AgentAppearance>;
  onChange: (look: Required<AgentAppearance>) => void;
}) {
  const { t } = useTranslation();
  const pick = (patch: LookPatch) => onChange({ ...look, ...patch });
  return (
    <div className="agp-look">
      <div className="agp-look__row">
        <span className="newag__label">{t("look.color")}</span>
        <ColorChoices look={look} onPick={pick} />
      </div>
      <div className="agp-look__row">
        <span className="newag__label">{t("look.eyes")}</span>
        <EyesChoices look={look} onPick={pick} carousel />
      </div>
      <div className="agp-look__row">
        <span className="newag__label">{t("look.onHead")}</span>
        <AccessoryChoices look={look} onPick={pick} carousel />
      </div>
    </div>
  );
}

/**
 * "Responsável": a member (you marked) or "Sem responsável". Each with their role under the name, which a personal
 * workspace leaves out (ADR 0159): a family knows who is who.
 */
export function OwnerSelect({
  value,
  onChange,
  members,
  meId,
  card = true,
}: {
  value: string;
  onChange: (value: string) => void;
  members: Member[];
  meId: string;
  /** The agent forms' card-like picker; `false` in a stack of plain fields (a dialog), drawn as its selects are. */
  card?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const roles = !isPersonal(org);
  return (
    <Select
      className={card ? "newag__sel" : undefined}
      aria-label={t("newAgent.owner")}
      value={value}
      onValueChange={onChange}
      options={[
        ...members.map((m) => ({
          value: m.userId,
          label: m.userId === meId ? t("newAgent.you", { name: m.name }) : m.name,
          ...(roles ? { description: t(`roles.${m.role}`) } : {}),
          leading: <Avatar kind="person" size="sm" name={m.name} imageUrl={m.image} />,
        })),
        {
          value: NO_OWNER,
          label: t("newAgent.noOwnerOption"),
          hint: t("newAgent.noOwnerShort"),
          leading: (
            <span className="newag__ib">
              <Icon name="members" size={16} />
            </span>
          ),
        },
      ]}
    />
  );
}

/**
 * "Responsável" where it can't be changed: the person and their role (a team's workspace), or "Sem responsável".
 */
export function OwnerValue({ member, meId }: { member: Member | undefined; meId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const role = member && !isPersonal(org) ? t(`roles.${member.role}`) : null;
  return (
    <div className="agp-person">
      {member ? (
        <Avatar kind="person" size="md" name={member.name} imageUrl={member.image} />
      ) : (
        <span className="newag__ib">
          <Icon name="members" size={16} />
        </span>
      )}
      <span className="agp-person__t">
        {/* With the role under it the name takes the face's top; alone, it centres on the tile. */}
        <b className={role ? "ac-captop" : undefined}>
          {member
            ? member.userId === meId
              ? t("newAgent.you", { name: member.name })
              : member.name
            : t("newAgent.noOwnerOption")}
        </b>
        {role && <span>{role}</span>}
      </span>
    </div>
  );
}

/** "Chave": the workspace default first, then the other stored keys. */
export function KeySelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
}) {
  const { t } = useTranslation();
  return (
    <Select
      className="newag__sel"
      aria-label={t("newAgent.key")}
      value={value}
      onValueChange={onChange}
      placeholder={t("newAgent.noKeys")}
      options={options}
    />
  );
}

/** A plan brain (Claude Code, Codex, Cursor, OpenCode, Grok Build, the Antigravity CLI) on a computer, chosen while creating an agent. */
export interface PlanChoice {
  kind: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
  machineId: string;
  /** One account there (an agent's proposal suggests a free one, ADR 0081); none: the computer's own sign-in. */
  accountId?: string;
  label?: string;
  /** Its model there (`auto` or one of `brainModelChoices`); none: Automático. */
  model?: string;
}

/** "US$ [  ]" with quick amounts; empty = the workspace default. */
export function BudgetField({
  id,
  value,
  onChange,
  defaultBudget,
  error,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  defaultBudget: number | undefined;
  error?: string;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const { amount } = readBudget(value);
  // A quick amount lights its button and leaves "Outro valor" empty; the field only holds an amount of its own
  // (while typing it keeps what was typed, even "10").
  const [typing, setTyping] = useState(false);
  const quick = amount !== null && (QUICK_BUDGETS as readonly number[]).includes(amount);
  const custom = value.trim() !== "" && (typing || !quick);
  const pick = (next: string) => {
    setTyping(false);
    onChange(next);
  };
  return (
    <div className="newag__money">
      {defaultBudget !== undefined && (
        <button type="button" className="newag__tog" aria-pressed={!value.trim()} onClick={() => pick("")}>
          {t("agent.budgetDefaultChoice", { amount: usd(t, locale, defaultBudget) })}
        </button>
      )}
      {QUICK_BUDGETS.map((v) => (
        <button
          key={v}
          type="button"
          className="newag__tog"
          aria-pressed={amount === v && !custom}
          onClick={() => pick(String(v))}
        >
          {usd(t, locale, v)}
        </button>
      ))}
      <Field
        label={<span className="ac-visually-hidden">{t("newAgent.budget")}</span>}
        id={id}
        error={error}
        className={custom ? "newag__money-field newag__money-field--on" : "newag__money-field"}
      >
        <AffixInput
          prefix="US$"
          inputMode="decimal"
          value={custom ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          placeholder={t("agent.budgetOther")}
        />
      </Field>
      {children}
    </div>
  );
}

/** "O que fazer", "O que evitar", "A quem pedir ajuda": a line added to the instructions. */
export function InstructionTips({ helper, onAdd }: { helper: string; onAdd: (text: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="newag__tips">
      {(["do", "avoid", "help"] as const).map((tip) => (
        <button
          key={tip}
          type="button"
          className="newag__tip"
          onClick={() => onAdd(t(`newAgent.tips.${tip}.text`, { name: helper }))}
        >
          <b>
            <Icon name="plus" size={14} />
            {t(`newAgent.tips.${tip}.title`)}
          </b>
          <span>{t(`newAgent.tips.${tip}.desc`)}</span>
        </button>
      ))}
    </div>
  );
}

type KnownRole = { id: string; name: string; icon: IconName };

/** The roles "Criar agente" offers (all but "Do zero"): each one's icon and its name in the person's language. */
const knownRoles = (t: TFunction): KnownRole[] =>
  ROLE_IDS.filter((id) => id !== "custom").map((id) => ({
    id,
    name: t(`newAgent.roles.${id}.name`),
    icon: ROLE_PRESETS[id].icon,
  }));

const iconIn = (roles: KnownRole[], role: string): IconName =>
  roles.find((r) => fold(r.name) === fold(role.trim()))?.icon ?? "agent";

/** The icon of a role named like one "Criar agente" offers (any case or accents), else the agent's own. */
export const roleIcon = (t: TFunction, role: string) => iconIn(knownRoles(t), role);

/** Editing in place: the field takes the focus as it opens, and its button gets it back after Enter or Esc. */
function useInPlace(editing: boolean) {
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // One ending per opening: taking the focused field away can blur it after Enter or Esc already ended it.
  const open = useRef(false);
  const back = useRef(false);
  useLayoutEffect(() => {
    if (editing) {
      const el = field.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    } else if (back.current) {
      back.current = false;
      button.current?.focus();
    }
  }, [editing]);
  return {
    button,
    field,
    begin: () => {
      open.current = true;
    },
    /** True once per opening; `refocus` gives the focus back to the button. */
    end: (refocus: boolean) => {
      if (!open.current) return false;
      open.current = false;
      back.current = refocus;
      return true;
    },
  };
}

/**
 * Text that edits where it is (the agent's name and @ on its settings): the value, with a pencil on hover that takes
 * no room otherwise; a click turns it into a field of the same size. Enter or leaving keeps what was typed (nothing
 * typed keeps the value), Esc puts back what it was. It only calls `onCommit`: the page's draft, which its save bar
 * saves.
 */
export function InPlaceText({
  id,
  value,
  shown,
  prefix,
  label,
  editLabel,
  maxLength,
  clean,
  spellCheck,
  invalid,
  describedBy,
  onCommit,
}: {
  id: string;
  value: string;
  /** How it reads while not edited ("@ada"); the value by default. */
  shown?: string;
  /** Before the field, outside what is typed ("@"). */
  prefix?: string;
  /** The field's name ("Nome"). */
  label: string;
  /** The button's name, with the value in it ("Editar nome: Ada"). */
  editLabel: string;
  maxLength?: number;
  /** Applied as it is typed (`cleanHandle`). */
  clean?: (typed: string) => string;
  spellCheck?: boolean;
  invalid?: boolean;
  /** The id of an error about it. */
  describedBy?: string;
  onCommit: (value: string) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const edit = useInPlace(typed !== null);
  const close = (keep: boolean, refocus: boolean) => {
    if (!edit.end(refocus)) return;
    const next = (typed ?? "").trim();
    if (keep && next && next !== value) onCommit(next);
    setTyped(null);
  };
  if (typed !== null)
    return (
      <span className="agp-inplace__field">
        {prefix && (
          <span className="agp-inplace__prefix" aria-hidden="true">
            {prefix}
          </span>
        )}
        <input
          ref={edit.field}
          id={id}
          data-esc-own=""
          value={typed}
          size={Math.max(4, typed.length + 1)}
          maxLength={maxLength}
          autoComplete="off"
          spellCheck={spellCheck}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e) => setTyped(clean ? clean(e.target.value) : e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              close(true, true);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close(false, true);
            }
          }}
          onBlur={() => close(true, false)}
        />
      </span>
    );
  return (
    <button
      ref={edit.button}
      type="button"
      id={id}
      className="agp-inplace"
      aria-label={editLabel}
      aria-describedby={describedBy}
      onClick={() => {
        edit.begin();
        setTyped(value);
      }}
    >
      {shown ?? value}
      <span className="agp-inplace__pen">
        <Icon name="edit" size={14} />
      </span>
    </button>
  );
}

/**
 * The agent's role as a tag: the icon "Criar agente" gives that role (`roleIcon`) and its name ("Sem cargo" when
 * empty), a pencil on hover. With `onChange`, a click turns it into a field of the same shape over the roles the app
 * knows (a combobox): every one as it opens, the one it has highlighted and marked; typing filters them and offers
 * what was typed as a role of its own. Arrows move, Enter picks the highlighted one (or what was typed), Esc puts it
 * back, leaving keeps what was typed. Without `onChange`, a static chip.
 */
export function RoleTag({
  id,
  value,
  onChange,
  maxLength = 200,
}: {
  id?: string;
  value: string;
  onChange?: (role: string) => void;
  maxLength?: number;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const roles = useMemo(() => knownRoles(t), [t]);
  const [typed, setTyped] = useState<string | null>(null);
  /** What was typed since it opened: until then the list shows every role. */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const edit = useInPlace(typed !== null);
  const role = value.trim();
  const text = role || t("agent.noRole");
  const q = (query ?? "").trim();
  const own = q && !roles.some((r) => fold(r.name) === fold(q)) ? q : "";
  const options = [
    ...roles.filter((r) => matchesWords(r.name, q)).map((r) => ({ ...r, own: false })),
    ...(own ? [{ id: "own", name: own, icon: "agent" as const, own: true }] : []),
  ];
  const optionId = (i: number) => `${listId}-${i}`;
  useEffect(() => {
    const box = list.current;
    // Only a list that scrolls (never in layout-less test DOMs).
    if (active < 0 || !box || box.scrollHeight <= box.clientHeight) return;
    box.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const close = (next: string | null, refocus: boolean) => {
    if (!edit.end(refocus)) return;
    if (next !== null && next !== role) onChange?.(next);
    setTyped(null);
    setQuery(null);
    setActive(-1);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = options.length;
      if (n === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      // From nothing highlighted, down starts at the first and up at the last.
      const from = active < 0 && step > 0 ? -1 : Math.max(active, 0);
      setActive((from + step + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      close(options[active]?.name ?? (typed ?? "").trim(), true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(null, true);
    }
  };

  if (!onChange)
    return (
      <span id={id} className="agp-roletag" data-empty={!role || undefined}>
        <Icon name={iconIn(roles, role)} size={16} />
        <span className="agp-roletag__text" title={role || undefined}>
          {text}
        </span>
      </span>
    );
  if (typed === null)
    return (
      <button
        ref={edit.button}
        type="button"
        id={id}
        className="agp-roletag"
        data-empty={!role || undefined}
        aria-label={t("agent.editRole", { role: text })}
        onClick={() => {
          edit.begin();
          setTyped(value);
          setQuery(null);
          setActive(roles.findIndex((r) => fold(r.name) === fold(role)));
        }}
      >
        <Icon name={iconIn(roles, role)} size={16} />
        <span className="agp-roletag__text" title={role || undefined}>
          {text}
        </span>
        <span className="agp-roletag__pen">
          <Icon name="edit" size={14} />
        </span>
      </button>
    );
  return (
    <span className="agp-roleedit">
      <span className="agp-roletag agp-roletag--edit">
        <Icon name={iconIn(roles, typed)} size={16} />
        <input
          ref={edit.field}
          id={id}
          role="combobox"
          aria-label={t("agent.roleLabel")}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          value={typed}
          maxLength={maxLength}
          autoComplete="off"
          placeholder={t("agent.rolePlaceholder")}
          onChange={(e) => {
            setTyped(e.target.value);
            setQuery(e.target.value);
            setActive(e.target.value.trim() ? 0 : -1);
          }}
          onKeyDown={onKey}
          onBlur={() => close(typed.trim(), false)}
        />
      </span>
      <div ref={list} id={listId} role="listbox" aria-label={t("agent.roleList")} className="ac-menu agp-roles">
        {options.map((o, i) => (
          // biome-ignore lint/a11y/useFocusableInteractive: options are reached through aria-activedescendant
          // biome-ignore lint/a11y/useKeyWithClickEvents: the field handles the keys
          <div
            key={o.id}
            id={optionId(i)}
            role="option"
            data-index={i}
            aria-selected={i === active}
            data-highlighted={i === active || undefined}
            className="ac-menu__item"
            // The focus stays in the field: leaving it would keep what was typed before the pick.
            onMouseDown={(e) => e.preventDefault()}
            onPointerMove={() => setActive(i)}
            onClick={() => close(o.name, true)}
          >
            <span className="ac-menu__leading">
              <Icon name={o.icon} size={16} />
            </span>
            <span className="ac-menu__label">
              <span className="agp-roles__name">{o.own ? t("agent.roleUse", { role: o.name }) : o.name}</span>
            </span>
            {!o.own && fold(o.name) === fold(role) && <span className="agp-roles__hint">{t("agent.roleCurrent")}</span>}
          </div>
        ))}
      </div>
    </span>
  );
}
