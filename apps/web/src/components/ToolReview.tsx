import type { ToolDecision } from "@agenteschat/client";
import {
  bySubject,
  countLevels,
  levelSummary,
  matchTool,
  REVIEW_LEVELS,
  type ReviewTool,
  SENSITIVE_LEVELS,
  subjectLabel,
} from "@agenteschat/client/lib/tool-review";
import {
  AskPixels,
  HappyAgent,
  Icon,
  SearchField,
  Segmented,
  SuggestSpark,
  ToolLevelBar,
  type ToolLevelKind,
  ToolLevelStrip,
  ToolLevelSwatch,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useDeferredValue, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

/**
 * The connector tool review: one
 * grouped list. "Precisam da sua decisão" first (only the tools whose names
 * don't say what they do), then every subject with its pixel strip and a
 * short summary; expanding shows the tools with one control each (Consulta ·
 * Muda · Aprovação · Desligada; sensitive tools only Aprovação · Desligada).
 * One search across subjects. Read-only (the agent page) shows each level
 * instead of the control.
 */

/** A level as a small pixel swatch and its short name (read-only rows). */
export function LevelTag({ level }: { level: ToolLevelKind }) {
  const { t } = useTranslation();
  return (
    <span className="tr-tag" title={t(`toolReview.help.${level}`)}>
      <ToolLevelSwatch level={level} />
      {t(`toolReview.choice.${level}`)}
    </span>
  );
}

function LevelControl({
  tool,
  value,
  onChange,
}: {
  tool: ReviewTool;
  value: ToolDecision;
  onChange: (level: ToolDecision) => void;
}) {
  const { t } = useTranslation();
  const opts = tool.levels ?? (tool.sensitive ? SENSITIVE_LEVELS : REVIEW_LEVELS);
  return (
    <Segmented
      size="sm"
      className="tr-seg"
      label={t("toolReview.levelOf", { name: tool.label })}
      value={value}
      onValueChange={onChange}
      options={opts.map((l) => ({
        value: l,
        label: t(`toolReview.short.${l}`),
        title: t(`toolReview.help.${l}`),
        mark: <ToolLevelSwatch level={l} />,
      }))}
    />
  );
}

function ToolRow({
  tool,
  level,
  showTech,
  pending,
  onLevel,
  onOk,
}: {
  tool: ReviewTool;
  level: ToolDecision;
  showTech: boolean;
  pending?: boolean;
  /** Absent: read-only. */
  onLevel?: (level: ToolDecision) => void;
  onOk?: () => void;
}) {
  const { t } = useTranslation();
  const title = [tool.description, tool.name, tool.sensitive ? t("toolReview.sensitive") : ""]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="tr-row" data-row={tool.name} data-off={level === "off" || undefined} title={title}>
      <span className="tr-row__t">
        <span className="tr-row__nm">{tool.label}</span>
        {pending && (
          <span className="tr-row__why ac-iconline">
            <SuggestSpark />
            <span>
              <Trans
                i18nKey="toolReview.suggestion"
                values={{
                  level: t(`toolReview.one.${tool.suggested}`),
                  reason: t(`toolReview.reason.${tool.reason ?? "unknown"}`, {
                    defaultValue: t("toolReview.reason.unknown"),
                  }),
                }}
                components={{ b: <b /> }}
              />
            </span>
          </span>
        )}
        {showTech && <span className="tr-row__tech">{tool.name}</span>}
      </span>
      <span className="tr-row__ctl">
        {onLevel ? <LevelControl tool={tool} value={level} onChange={onLevel} /> : <LevelTag level={level} />}
        {pending && onOk && (
          <button
            type="button"
            className="tr-ok"
            aria-label={t("toolReview.confirm", { name: tool.label })}
            onClick={onOk}
          >
            {t("toolReview.ok")}
          </button>
        )}
      </span>
    </div>
  );
}

/** One subject: name, how many tools, the pixel strip and the summary; open shows its tools. */
function Subject({
  label,
  tools,
  all,
  levelOf,
  open,
  onToggle,
  query,
  onLevel,
}: {
  label: string;
  /** The tools shown (search hits). */
  tools: { tool: ReviewTool; tech: boolean }[];
  /** Every tool of the subject (strip and summary). */
  all: ReviewTool[];
  levelOf: (tool: ReviewTool) => ToolDecision;
  open: boolean;
  onToggle: () => void;
  query: string;
  onLevel?: (tool: ReviewTool, level: ToolDecision) => void;
}) {
  const { t } = useTranslation();
  const levels = all.map(levelOf);
  const summary = levelSummary(t, countLevels(levels.map((level) => ({ level }))));
  return (
    <section className="tr-subj" data-open={open || undefined} aria-label={label}>
      <button type="button" className="tr-subj__h" aria-expanded={open} onClick={onToggle}>
        <span>
          <b>{label}</b>
          <small>
            {query
              ? t("toolReview.subjectHits", { hits: tools.length, count: all.length })
              : t("toolReview.subjectCount", { count: all.length })}
            {summary && ` · ${summary}`}
          </small>
        </span>
        <ToolLevelStrip levels={levels} label={summary} className="tr-subj__strip" />
        <Icon name="chevronRight" className="tr-subj__chev" />
      </button>
      {open && (
        <div className="tr-subj__b">
          {tools.map(({ tool, tech }) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              level={levelOf(tool)}
              showTech={tech}
              onLevel={onLevel ? (l) => onLevel(tool, l) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Subjects of tools, searchable; with `onLevel` each row has the control, without it shows the level. */
export function ToolSubjects({
  tools,
  levelOf,
  onLevel,
  query,
  before,
  emptyText,
}: {
  tools: ReviewTool[];
  levelOf: (tool: ReviewTool) => ToolDecision;
  onLevel?: (tool: ReviewTool, level: ToolDecision) => void;
  query: string;
  /** Rendered first inside the list (the "needs your decision" group). */
  before?: React.ReactNode;
  emptyText?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = bySubject(t, tools)
    .map((g) => ({
      ...g,
      hits: g.tools.map((tool) => ({ tool, ...matchTool(tool, query) })).filter((m) => m.ok),
    }))
    .filter((g) => g.hits.length > 0);
  if (groups.length === 0 && !before) {
    return <div className="tr-empty">{emptyText ?? t("toolReview.noMatch", { q: query.trim() })}</div>;
  }
  return (
    <div className="tr-subjects">
      {before}
      {groups.map((g) => (
        <Subject
          key={g.subject}
          label={g.label}
          tools={g.hits}
          all={g.tools}
          levelOf={levelOf}
          open={query.trim() ? true : open.has(g.subject)}
          onToggle={() => {
            if (query.trim()) return;
            setOpen((s) => {
              const next = new Set(s);
              if (next.has(g.subject)) next.delete(g.subject);
              else next.add(g.subject);
              return next;
            });
          }}
          query={query.trim()}
          onLevel={onLevel}
        />
      ))}
    </div>
  );
}

/** The search field over the subjects. */
export function ToolSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <SearchField
      className="tr-search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClear={() => onChange("")}
      clearLabel={t("toolReview.clearSearch")}
      placeholder={t("toolReview.search")}
      aria-label={t("toolReview.search")}
    />
  );
}

/** The done card: the agent, happy; the proportion bar of the levels and its legend. */
function DoneCard({
  name,
  counts,
  reviewable,
  onReview,
}: {
  name: string;
  counts: Record<ToolLevelKind, number>;
  reviewable: number;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="tr-done" aria-label={t("toolReview.doneTitle")}>
      <HappyAgent className="tr-done__agent" />
      <div>
        <h4 className="tr-done__title">{t("toolReview.doneTitle")}</h4>
        <p className="tr-done__sub">{t("toolReview.doneSub", { name })}</p>
      </div>
      <ToolLevelBar counts={counts} label={levelSummary(t, counts)} className="tr-done__bar" />
      <div className="tr-legend">
        {REVIEW_LEVELS.filter((l) => l !== "off" || counts.off > 0).map((l) => (
          <span key={l} data-level={l}>
            <ToolLevelSwatch level={l} />
            <b>{counts[l].toLocaleString()}</b> {t(`toolReview.legend.${l}`, { count: counts[l] })}
          </span>
        ))}
      </div>
      {reviewable > 0 && (
        <button type="button" className="tr-link" onClick={onReview}>
          {t("toolReview.review", { count: reviewable })}
        </button>
      )}
    </section>
  );
}

export interface ToolReviewState {
  levels: Record<string, ToolDecision>;
  /** Pending tools the person decided here (they leave the group). */
  decided: Set<string>;
}

/**
 * The review's body: the done card (nothing pending) or the "needs your
 * decision" group, then every tool by subject. The parent owns the state
 * (it saves on Continuar).
 */
export function ToolReview({
  name,
  tools,
  state,
  onChange,
  onMoved,
}: {
  /** The connector's name. */
  name: string;
  tools: ReviewTool[];
  state: ToolReviewState;
  onChange: (state: ToolReviewState) => void;
  /** A pending tool was decided and went to its subject (a toast). */
  onMoved?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const levelOf = (tool: ReviewTool) => state.levels[tool.name] ?? tool.level;
  const isPending = (tool: ReviewTool) => tool.pending && !state.decided.has(tool.name);
  const pending = tools.filter(isPending);
  const settled = tools.filter((x) => !isPending(x));
  const reviewable = tools.filter((x) => x.pending).length;
  const decide = (tool: ReviewTool, level: ToolDecision) => {
    onChange({
      levels: { ...state.levels, [tool.name]: level },
      decided: new Set([...state.decided, tool.name]),
    });
    onMoved?.(t("toolReview.moved", { name: tool.label, subject: subjectLabel(t, tool.subject) }));
  };
  const setLevel = (tool: ReviewTool, level: ToolDecision) => {
    if (isPending(tool)) return decide(tool, level);
    onChange({ ...state, levels: { ...state.levels, [tool.name]: level } });
  };
  const acceptAll = () => {
    onChange({ levels: state.levels, decided: new Set([...state.decided, ...pending.map((x) => x.name)]) });
    onMoved?.(t("toolReview.accepted", { count: pending.length }));
  };
  const hits = pending.map((tool) => ({ tool, ...matchTool(tool, query) })).filter((m) => m.ok);
  const counts = countLevels(tools.map((x) => ({ level: levelOf(x) })));
  const decideGroup =
    hits.length > 0 ? (
      <section
        className="tr-subj tr-decide"
        data-open
        aria-label={t("toolReview.decideTitle", { count: pending.length })}
      >
        <div className="tr-decide__h ac-mediarow">
          <span className="ac-mediarow__face">
            <AskPixels />
          </span>
          <span className="ac-mediarow__head tr-decide__t">
            <b>{t("toolReview.decideTitle", { count: pending.length })}</b>
          </span>
          {!query.trim() && (
            <span className="ac-mediarow__end ac-mediarow__end--wrap">
              <button type="button" className="tr-link" onClick={acceptAll}>
                {t("toolReview.acceptAll")}
              </button>
            </span>
          )}
          <small className="ac-mediarow__body tr-decide__help">{t("toolReview.decideHelp")}</small>
        </div>
        <div className="tr-subj__b">
          {hits.map(({ tool, tech }) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              level={levelOf(tool)}
              showTech={tech}
              pending
              onLevel={(l) => decide(tool, l)}
              onOk={() => decide(tool, levelOf(tool))}
            />
          ))}
        </div>
      </section>
    ) : null;
  return (
    <div className="tr">
      {pending.length === 0 && tools.length > 0 && (
        <DoneCard
          name={name}
          counts={counts}
          reviewable={reviewable}
          onReview={() => onChange({ ...state, decided: new Set() })}
        />
      )}
      <section className="tr-all" aria-labelledby="tr-all-h">
        <h3 id="tr-all-h" className="tr-all__h">
          {t("toolReview.all", { count: tools.length })}
        </h3>
        <ToolSearch value={q} onChange={setQ} />
        <ToolSubjects tools={settled} levelOf={levelOf} onLevel={setLevel} query={query} before={decideGroup} />
      </section>
    </div>
  );
}

/** The footer's note: what's left, or that it can change later. */
export function reviewNote(t: TFunction, tools: ReviewTool[], state: ToolReviewState) {
  const left = tools.filter((x) => x.pending && !state.decided.has(x.name)).length;
  return left > 0 ? t("toolReview.missing", { count: left }) : t("toolReview.later");
}

/** A read-only view by subject (the agent page's "Ver"): levels shown, searchable. */
export function ToolLevelsView({ tools }: { tools: ReviewTool[] }) {
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  return (
    <div className="tr">
      <ToolSearch value={q} onChange={setQ} />
      <ToolSubjects tools={tools} levelOf={(x) => x.level} query={query} />
    </div>
  );
}
