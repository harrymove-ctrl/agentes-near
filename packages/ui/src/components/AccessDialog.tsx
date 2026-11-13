import type { ReactNode } from "react";
import { Button } from "./Button";
import { Dialog, DialogBody, DialogFooter } from "./Dialog";
import { Locked } from "./Field";
import { SearchSelect } from "./SearchSelect";
import { Select, type SelectOption } from "./Select";

export interface AccessLevel<L extends string = string> {
  value: L;
  label: string;
}

/** Someone who can get access: a person, a role, an agent. */
export interface AccessSubject {
  id: string;
  name: string;
  /** The line under the name ("Papel · 4 pessoas", an email). */
  detail?: string;
  /** Their face or mark. */
  lead: ReactNode;
  /** The heading they go under when adding ("Pessoas", "Agentes"). */
  group?: string;
}

/** A row that is always there and can't be taken out ("Todos do workspace"). */
export interface AccessBase<L extends string = string> extends AccessSubject {
  level: L;
  levels: AccessLevel<L>[];
  onChange: (level: L) => void;
}

export interface AccessDialogLabels {
  /** The search that adds someone: its accessible name and the words shown before anyone is picked. */
  add: string;
  /** Accessible name of the list of who can be added. */
  addList: string;
  addSearch: string;
  noResults: string;
  /** Accessible name of the button that takes someone out ("Remover Ana"). */
  removeOf: (name: string) => string;
  /** Accessible name of a row's level ("O que Ana pode fazer"). */
  levelOf: (name: string) => string;
  close: string;
  cancel: string;
  save: string;
}

export interface AccessDialogProps<L extends string = string> {
  title: string;
  description?: string;
  /** A line above the list: what limits this one ("Dentro de Financeiro…"). */
  note?: ReactNode;
  base: AccessBase<L>[];
  /** Everyone who may be on the list. */
  subjects: AccessSubject[];
  /** A subject's level; undefined = not on the list. */
  levelOf: (subject: AccessSubject) => L | undefined;
  /** The levels a subject may get; none = they can't be added, and aren't shown. */
  levelsFor: (subject: AccessSubject) => AccessLevel<L>[];
  /** A subject's new level; null = taken out. */
  onLevelChange: (subject: AccessSubject, level: L | null) => void;
  labels: AccessDialogLabels;
  /** Before the buttons: another way to go ("Definir para a pasta…"). */
  footerStart?: ReactNode;
  saving?: boolean;
  onSave: () => void;
  onClose: () => void;
}

function AccessRow({
  subject,
  value,
  options,
  label,
  onChange,
  onRemove,
  removeLabel,
}: {
  subject: AccessSubject;
  value: string;
  options: SelectOption[];
  label: string;
  onChange: (value: string) => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <div className="ac-access__row ac-actrow">
      <span className="ac-access__lead">{subject.lead}</span>
      <span className="ac-access__who ac-actrow__text">
        <span className="ac-access__name">{subject.name}</span>
        {subject.detail && <span className="ac-access__detail">{subject.detail}</span>}
      </span>
      <Select size="sm" aria-label={label} value={value} onValueChange={onChange} options={options} />
      {/* A slot in every row, so the levels line up whether or not this one can be taken out. */}
      <span className="ac-access__remove">
        {onRemove && (
          <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={removeLabel} onClick={onRemove} />
        )}
      </span>
    </div>
  );
}

/**
 * Who has access to something, as one list: a level for the rows that are always there ("everyone") and one for each
 * person, role or agent added. It knows nothing of what it guards: the caller says who may be added, at which levels,
 * and saves what comes out.
 */
export function AccessDialog<L extends string = string>({
  title,
  description,
  note,
  base,
  subjects,
  levelOf,
  levelsFor,
  onLevelChange,
  labels,
  footerStart,
  saving,
  onSave,
  onClose,
}: AccessDialogProps<L>) {
  const open = subjects.filter((s) => levelsFor(s).length > 0);
  const listed = open.filter((s) => levelOf(s) !== undefined);
  const addable = open.filter((s) => levelOf(s) === undefined);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      closeLabel={labels.close}
      width={560}
    >
      <Locked when={Boolean(saving)}>
        <DialogBody className="ac-access">
          {note && <p className="ac-access__note">{note}</p>}
          <SearchSelect
            value={undefined}
            placeholder={labels.add}
            aria-label={labels.add}
            labels={{
              search: labels.addSearch,
              searchPlaceholder: labels.addSearch,
              noResults: labels.noResults,
              list: labels.addList,
            }}
            options={() =>
              addable.map((s) => ({
                value: s.id,
                label: s.name,
                description: s.detail,
                leading: s.lead,
                group: s.group,
              }))
            }
            onValueChange={(id) => {
              const subject = addable.find((s) => s.id === id);
              const level = subject && levelsFor(subject).at(-1);
              if (subject && level) onLevelChange(subject, level.value);
            }}
          />
          <div className="ac-access__list">
            {base.map((b) => (
              <AccessRow
                key={b.id}
                subject={b}
                value={b.level}
                options={b.levels}
                label={labels.levelOf(b.name)}
                onChange={(v) => b.onChange(v as L)}
              />
            ))}
            {listed.map((s) => (
              <AccessRow
                key={s.id}
                subject={s}
                value={levelOf(s) as string}
                options={levelsFor(s)}
                label={labels.levelOf(s.name)}
                onChange={(v) => onLevelChange(s, v as L)}
                onRemove={() => onLevelChange(s, null)}
                removeLabel={labels.removeOf(s.name)}
              />
            ))}
          </div>
        </DialogBody>
      </Locked>
      {/* Another way to go is the footer's note: Cancelar and Salvar stay one group, never split by it. */}
      <DialogFooter note={footerStart || undefined}>
        <Button onClick={onClose}>{labels.cancel}</Button>
        <Button variant="primary" loading={saving} disabled={saving} onClick={onSave}>
          {labels.save}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
