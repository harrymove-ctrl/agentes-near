import { type BlockChange, useBlockReply, useBlockValues } from "@agenteschat/client";
import type { ChartSpec } from "@agenteschat/client/lib/chart";
import { Button, Field, Input, Segmented, Switch, Textarea } from "@agenteschat/ui";
import {
  type BlockViewPart,
  type BlockWords,
  compileBlock,
  inputValue,
  parseBlockSpec,
  viewBlock,
} from "@agenteschat/ui/blocks/spec";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChartAccent, ChartView } from "@/components/ChartBlock";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "./spec-block.css";

/** In the conversation a block is at most this tall; a taller one is cut with a fade until "Show all". */
const INLINE_HEIGHT = 420;

type Sent = { text: string; at: string };
/** What this person sent from a block and whether they opened it whole, kept while the conversation is open. */
const kept = new Map<string, { sent?: Sent; open?: boolean }>();
const keptOf = (key: string) => {
  let k = kept.get(key);
  if (!k) {
    k = {};
    kept.set(key, k);
  }
  return k;
};

/**
 * A live block drawn by the app itself (ADR 0113): the parts the agent described, with the app's own controls, over
 * the state everyone in the conversation shares. Nothing the agent wrote runs here: its words reach the screen only
 * as text, and its formulas are read by our interpreter (`@agenteschat/ui/blocks/spec`).
 */
export function SpecBlock({
  id,
  version,
  spec: raw,
  agentId,
  big = false,
}: {
  id: string;
  version: number;
  spec: Record<string, unknown>;
  agentId: string;
  big?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const agent = dir.anyAgent(agentId);
  const toast = useToast();
  const blockKey = `${id}@${version}`;
  const compiled = useMemo(() => {
    try {
      return compileBlock(parseBlockSpec(raw));
    } catch {
      return null;
    }
  }, [raw]);
  const values = useBlockValues(org.id, id, version);
  const reply = useBlockReply(org.id, id);
  const thousand = t("blocks.thousand");
  const words = useMemo<BlockWords>(() => ({ locale: i18n.language, thousand }), [i18n.language, thousand]);
  const view = useMemo(
    () => (compiled ? viewBlock(compiled, values.state, words) : null),
    [compiled, values.state, words],
  );
  const [sent, setSent] = useState<Sent | null>(keptOf(blockKey).sent ?? null);
  const [open, setOpen] = useState(keptOf(blockKey).open ?? false);
  const body = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setHeight(el.scrollHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!compiled || !view) {
    return (
      <div className="live-block__broken">
        <span>
          <b>{t("blocks.brokenTitle")}</b>
          <small>{t("blocks.brokenBody")}</small>
        </span>
      </div>
    );
  }

  const tall = !big && height > INLINE_HEIGHT;
  const toggleOpen = () => {
    keptOf(blockKey).open = !open;
    setOpen(!open);
  };
  const send = () => {
    const draft = view.send;
    if (!draft?.ready || reply.isPending) return;
    const text = draft.text;
    reply.mutate(
      { text, clientId: crypto.randomUUID() },
      {
        onSuccess: () => {
          const done = { text, at: new Date().toISOString() };
          keptOf(blockKey).sent = done;
          setSent(done);
        },
        onError: () => toast.show(t("blocks.sendFailed"), "error"),
      },
    );
  };
  const same = sent !== null && sent.text === view.send?.text;

  return (
    <ChartAccent.Provider value={colorOf(agent)}>
      <div
        className="live-block__view"
        data-cut={(tall && !open) || undefined}
        style={big || !tall ? undefined : { height: open ? height : INLINE_HEIGHT }}
      >
        <div ref={body} className="spec-block">
          <Parts parts={view.parts} values={values} />
        </div>
      </div>
      {tall && (
        <div className="live-block__more">
          <Button
            variant="ghost"
            size="sm"
            icon={open ? "chevronUp" : "chevronDown"}
            aria-expanded={open}
            onClick={toggleOpen}
          >
            {open ? t("blocks.showLess") : t("blocks.showAll")}
          </Button>
        </div>
      )}
      {view.send &&
        (same ? (
          <div className="live-block__foot">
            <span className="live-block__sent">
              <span className="live-block__mark" aria-hidden="true" />
              {t("blocks.sentAt", { time: new Date(sent.at).toLocaleTimeString([], { timeStyle: "short" }) })}
            </span>
          </div>
        ) : (
          <div className="live-block__foot">
            <span className="live-block__draft">
              {view.send.ready ? (
                <>
                  {t("blocks.goesTo", { name: agent?.name ?? t("channel.unknownAgent") })} <b>{view.send.text}</b>
                </>
              ) : (
                view.send.hint
              )}
            </span>
            <Button variant="primary" size="sm" disabled={!view.send.ready || reply.isPending} onClick={send}>
              {view.send.label}
            </Button>
          </div>
        ))}
    </ChartAccent.Provider>
  );
}

type Values = ReturnType<typeof useBlockValues>;

function Parts({ parts, values }: { parts: BlockViewPart[]; values: Values }) {
  return (
    <>
      {parts.map((p) => (
        <Part key={p.key} part={p} values={values} />
      ))}
    </>
  );
}

function Part({ part: p, values }: { part: BlockViewPart; values: Values }) {
  const id = useId();
  const set = (raw: unknown) => {
    const name = "name" in p ? p.name : undefined;
    if (typeof name !== "string") return;
    const v = inputValue(p, raw);
    if (v !== undefined) values.set({ [name]: v });
  };
  switch (p.kind) {
    case "heading":
      return <h3 className="spec-block__heading">{p.text}</h3>;
    case "text":
      return <p className="spec-block__text">{p.text}</p>;
    case "note":
      return <p className="spec-block__note">{p.text}</p>;
    case "list":
      return (
        <ul className="spec-block__list">
          {p.items.map((item, i) => (
            // Lines of one list have no id but their place.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case "slider": {
      const pct = ((p.value - p.min) / (p.max - p.min)) * 100;
      return (
        <label className="spec-block__slider" htmlFor={id}>
          <span className="spec-block__label">
            <span>{p.label}</span>
            <b>{p.shown}</b>
          </span>
          <input
            id={id}
            type="range"
            min={p.min}
            max={p.max}
            step={p.step}
            value={p.value}
            style={{ "--p": `${pct}%` } as CSSProperties}
            onChange={(e) => set(e.target.value)}
          />
        </label>
      );
    }
    case "choice":
      return (
        <div className="spec-block__choice">
          {p.label && <div className="spec-block__title">{p.label}</div>}
          <Segmented
            size="sm"
            label={p.label || p.options.join(", ")}
            value={p.value ?? ""}
            onValueChange={(v) => set(v)}
            options={p.options.map((o) => ({ value: o, label: o }))}
          />
        </div>
      );
    case "field":
      return (
        <Field label={p.label}>
          {p.input === "textarea" ? (
            <Textarea value={p.value} placeholder={p.placeholder} onChange={(e) => set(e.target.value)} />
          ) : (
            <Input
              type={p.input}
              inputMode={p.input === "number" ? "decimal" : undefined}
              value={p.value}
              placeholder={p.placeholder}
              onChange={(e) => set(e.target.value)}
            />
          )}
        </Field>
      );
    case "switch":
      return (
        <div className="spec-block__switch">
          <label htmlFor={id}>{p.label}</label>
          <Switch id={id} checked={p.value} onCheckedChange={(v) => set(v)} />
        </div>
      );
    case "stats":
      return (
        <div className="spec-block__stats">
          {p.items.map((s) => (
            <div key={s.key} className="spec-block__stat" data-tone={s.tone ?? undefined}>
              <span>{s.label}</span>
              <b>{s.text}</b>
              {s.sub && <small>{s.sub}</small>}
            </div>
          ))}
        </div>
      );
    case "result":
      return <Result label={p.label} text={p.text} change={p.name ? values.changes[p.name] : undefined} />;
    case "progress":
      return (
        <div className="spec-block__progress">
          <span className="spec-block__label">
            <span>{p.label}</span>
            <b>{p.text}</b>
          </span>
          <span className="spec-block__track">
            <span style={{ width: `${p.share * 100}%` }} />
          </span>
        </div>
      );
    case "chart":
      return <BlockChart part={p} />;
    case "table":
      return (
        <div className="md__table spec-block__table">
          <table>
            <thead>
              <tr>
                {p.columns.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns have no id but their place
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id but their place
                <tr key={r}>
                  {row.map((cell, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "more":
      return (
        <details className="spec-block__more">
          <summary>{p.label || <MoreLabel />}</summary>
          <div className="spec-block__more-body">
            <Parts parts={p.parts} values={values} />
          </div>
        </details>
      );
    case "row":
      return (
        <div className="spec-block__row">
          <Parts parts={p.parts} values={values} />
        </div>
      );
    case "card": {
      const head = (p.label || p.sub) && (
        <div className="spec-block__card-head">
          {p.label && <b>{p.label}</b>}
          {p.sub && <small>{p.sub}</small>}
        </div>
      );
      if (!p.pick) {
        return (
          <div className="spec-block__card" data-on={p.selected || undefined}>
            {head}
            <Parts parts={p.parts} values={values} />
          </div>
        );
      }
      const pick = p.pick;
      return (
        // A card that is a choice holds parts (a stat, a note) a button can't: a pressable group instead.
        // biome-ignore lint/a11y/useSemanticElements: see above
        <div
          className="spec-block__card"
          role="button"
          tabIndex={0}
          aria-pressed={p.selected}
          data-pick=""
          data-on={p.selected || undefined}
          onClick={() => values.set({ [pick.name]: pick.value })}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            values.set({ [pick.name]: pick.value });
          }}
        >
          {head}
          <Parts parts={p.parts} values={values} />
        </div>
      );
    }
    case "actions":
      return (
        <div className="spec-block__actions" data-align={p.align}>
          {p.buttons.map((b) => (
            <Button
              key={b.key}
              variant={b.lead ? "primary" : "default"}
              onClick={() => {
                if (b.set) values.set(b.set);
                if (b.draw) void values.draw(b.draw.name, b.draw.options);
              }}
            >
              {b.label}
            </Button>
          ))}
        </div>
      );
  }
}

function MoreLabel() {
  const { t } = useTranslation();
  return <>{t("blocks.more")}</>;
}

/** The block's answer, large. A value the server just drew rolls into place, the same moment for everyone. */
function Result({ label, text, change }: { label: string; text: string; change: BlockChange | undefined }) {
  const first = useRef(true);
  const [roll, setRoll] = useState(0);
  // A new draw is a new `at`.
  const drawnAt = change?.drawn ? change.at : null;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (drawnAt) setRoll((n) => n + 1);
  }, [drawnAt]);
  return (
    <div className="spec-block__result">
      <span>{label}</span>
      <b key={roll} data-roll={roll > 0 || undefined} aria-live="polite">
        {text}
      </b>
    </div>
  );
}

/** A chart in the block, in the style of a message's chart. Too few points to draw shows nothing. */
function BlockChart({ part }: { part: Extract<BlockViewPart, { kind: "chart" }> }) {
  const spec: ChartSpec = {
    type: part.chart,
    title: part.label,
    labels: part.labels,
    series: [{ name: "", values: part.values }],
    ...(part.unit ? { unit: part.unit } : {}),
  };
  const enough =
    part.chart === "bar"
      ? part.values.length >= 1
      : part.values.length >= 2 && (part.chart !== "pie" || part.values.some((v) => v > 0));
  if (!enough) return null;
  return (
    <figure className="spec-block__chart">
      {part.label && <figcaption className="spec-block__title">{part.label}</figcaption>}
      <ChartView
        spec={
          part.chart === "pie"
            ? { ...spec, series: [{ name: "", values: part.values.map((v) => Math.max(0, v)) }] }
            : spec
        }
      />
    </figure>
  );
}
