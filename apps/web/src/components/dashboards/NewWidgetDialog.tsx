import type { Agent, PinnableBlock, Widget, WidgetFormat, WidgetSchedule, WidgetSize } from "@agenteschat/client";
import {
  useAgents,
  useConfirmWidget,
  useDashboards,
  useHomeDashboard,
  usePinnableBlocks,
  usePinWidget,
  useRemoveWidget,
  useTestWidget,
  useWidgetDraft,
  useWidgetSuggestions,
  WIDGET_STILL_MS,
  widgetStepWords,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { errorText } from "@agenteschat/client/lib/errors";
import { joinNames, relativeTime } from "@agenteschat/client/lib/format";
import { taskClock } from "@agenteschat/client/lib/task-manager";
import {
  BuildingDither,
  Button,
  Dialog,
  DialogFooter,
  Icon,
  Input,
  Locked,
  PixelSpinner,
  Popover,
  Select,
  Switch,
  useDarkTheme,
  useNow,
  useUnsavedInDialog,
  WidgetBleed,
  WidgetBody,
  WidgetGlyph,
  widgetTileVars,
} from "@agenteschat/ui";
import {
  sizeToLayout,
  WIDGET_FORMATS,
  WIDGET_SCHEDULES,
  WIDGET_SIZES,
  type WidgetSpec,
} from "@agenteschat/ui/widgets/spec";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentPickerDialog } from "@/components/agents/AgentPickerDialog";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { failureText } from "@/components/widgets/parts";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import "@/pages/dashboards.css";

/** The destination select's value for the person's own home board ("My Home"). */
const HOME = "home";
/** A widget's title, as long as the server takes it (ADR 0135). */
const TITLE_MAX = 80;

type Mode = "ask" | "pin";

export interface NewWidgetDialogProps {
  orgId: string;
  open: boolean;
  onClose: () => void;
  /** The board it goes on by default; null = My Home. */
  dashboardId: string | null;
  /** Which way it opens: asking an agent, or pinning a chart from the chat. */
  tab?: Mode;
}

/**
 * New widget (ADR 0135 §3). The dialog is the widget itself, large on a dotted stage, and the card is the form: what
 * to follow is written in its body (with the agent's suggestions), the agent's face in its footer opens the list of
 * agents, the schedule beside it how often it updates, the bell in its head the alert, S/M/L its size; its title is
 * edited in place. Test has the agent build it there with real data (a draft), and only a draft that worked for what
 * is asked now can be created; while it builds the card says the step its agent is in and for how long, and Stop
 * ends the build with the ask as it was written; after the test the ask folds into one line that opens it again. Or
 * a chart an agent already sent in the chat is pinned. Under the card, the board it goes on. Used by a board's page
 * and by Home.
 */
export function NewWidgetDialog({ orgId, open, onClose, dashboardId, tab = "ask" }: NewWidgetDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>(tab);
  // Closed: the next opening starts the way it was asked to.
  useEffect(() => {
    if (!open) setMode(tab);
  }, [open, tab]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={mode === "pin" ? t("dashboards.newWidget.pinTitle") : t("dashboards.newWidget.title")}
      description={mode === "pin" ? t("dashboards.newWidget.pinSubtitle") : t("dashboards.newWidget.cardSubtitle")}
      closeLabel={t("common.close")}
      width={620}
      className="db-dialog nw"
    >
      {open && (
        <NewWidgetBody orgId={orgId} dashboardId={dashboardId} mode={mode} setMode={setMode} onClose={onClose} />
      )}
    </Dialog>
  );
}

/**
 * Where the test of what is asked stands: none yet, the draft being built (or the test being sent), built (`ok`),
 * failed, or made for an ask that changed since (`stale`: its prompt, agent or format).
 */
type TestPhase = "none" | "testing" | "ok" | "failed" | "stale";

function phaseOf(sending: boolean, draft: Widget | undefined, draftId: string | null, stale: boolean): TestPhase {
  if (sending) return "testing";
  if (!draftId) return "none";
  if (stale) return "stale";
  if (!draft || draft.status === "building" || draft.status === "updating") return "testing";
  return draft.status === "ok" ? "ok" : "failed";
}

function NewWidgetBody({
  orgId,
  dashboardId,
  mode,
  setMode,
  onClose,
}: {
  orgId: string;
  dashboardId: string | null;
  mode: Mode;
  setMode: (mode: Mode) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const dark = useDarkTheme();
  const now = useNow(30_000);
  const id = useId();
  const agents = (useAgents(orgId).data ?? []).filter((a) => !a.former && canTalk(a));
  const [agentId, setAgentId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [format, setFormat] = useState<WidgetFormat>("auto");
  const [schedule, setSchedule] = useState<WidgetSchedule>(mode === "pin" ? "day" : "hour");
  const [alertOn, setAlertOn] = useState(true);
  const [condition, setCondition] = useState("");
  const [alertOpen, setAlertOpen] = useState(false);
  const [size, setSize] = useState<WidgetSize>("m");
  const [dest, setDest] = useState<string>(dashboardId ?? HOME);
  const [block, setBlock] = useState<number | null>(null);
  const [choosing, setChoosing] = useState(false);
  // The test: the draft it made, the ask it was made for, and the title as the person edits it (null = the agent's).
  const [draftId, setDraftId] = useState<string | null>(null);
  const [testedFor, setTestedFor] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  // After a test the ask folds into one line; this opens it again for a change.
  const [editing, setEditing] = useState(false);
  // A test being sent, when the build under way started, and how many were stopped (the ask takes the focus back).
  const [sending, setSending] = useState(false);
  const [since, setSince] = useState(0);
  const [stops, setStops] = useState(0);
  // Which test the dialog waits for: one stopped or replaced before its draft came back is dropped when it does.
  const run = useRef(0);
  const askField = useRef<HTMLTextAreaElement>(null);
  useUnsavedInDialog(text.trim() !== "" || condition.trim() !== "");

  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const suggestions = useWidgetSuggestions(orgId, agent?.id, mode === "ask");
  const boards = useDashboards(orgId);
  const home = useHomeDashboard(orgId, dest === HOME);
  const pinnable = usePinnableBlocks(orgId, mode === "pin");
  const test = useTestWidget(orgId);
  const confirm = useConfirmWidget(orgId);
  const remove = useRemoveWidget(orgId);
  const pin = usePinWidget(orgId);
  const detail = useWidgetDraft(orgId, draftId).data;
  const live = detail ?? (test.data?.id === draftId ? test.data : undefined);
  const draft = draftId && live?.id === draftId ? live : undefined;

  // A draft nobody created is deleted when the dialog closes or another test replaces it (the server sweeps any
  // left behind after a day). `pending` is the draft still to delete; one being created is kept.
  const pending = useRef<string | null>(null);
  const confirming = useRef(false);
  const alive = useRef(true);
  const drop = useRef(remove.mutate);
  drop.current = remove.mutate;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pending.current && !confirming.current) drop.current(pending.current);
      pending.current = null;
    };
  }, []);
  // The ask opened again after a test: the cursor goes to its end.
  useEffect(() => {
    const field = askField.current;
    if (!editing || !field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing]);
  useEffect(() => {
    if (stops > 0) askField.current?.focus();
  }, [stops]);

  const sources = suggestions.data?.sources ?? [];
  const sugs = suggestions.data?.suggestions ?? [];
  const sug = picked === null ? null : (sugs[picked] ?? null);
  const blocks = pinnable.data ?? [];
  const chosen = block === null ? null : (blocks[block] ?? null);
  const editable = (boards.data?.dashboards ?? []).filter((d) => d.kind === "board" && d.canEdit);
  const destOptions = [
    { value: HOME, label: t("dashboards.home") },
    ...editable.map((d) => ({ value: d.id, label: d.title })),
  ];
  const where = destOptions.find((o) => o.value === dest)?.label ?? t("dashboards.home");
  const targetId = dest === HOME ? (home.data?.id ?? null) : dest;

  const asked = text.trim();
  // What a test answers for: what is asked, of whom, in what format (schedule, alert, size and board don't count).
  const askKey = JSON.stringify([asked, agent?.id ?? "", format]);
  const phase: TestPhase =
    mode === "ask" ? phaseOf(sending, draft, draftId, draftId !== null && testedFor !== askKey) : "none";
  const clock = useNow(phase === "testing" ? 1000 : false);
  const elapsed = phase === "testing" ? Math.max(0, clock - since) : 0;
  const stepWords = widgetStepWords(t, detail?.id === draftId ? detail?.step : null, i18n.language);
  // The draft's data, still shown (dimmed) once the ask changed since the test.
  const built = draft?.status === "ok" && draft.spec ? draft : null;
  const tested = phase === "ok" ? built : null;
  const stale = phase === "stale";
  const asking = mode === "ask" && (phase === "none" || editing);
  const testedWhen = tested?.refreshedAt
    ? relativeTime(t, i18n.language, tested.refreshedAt, new Date(now))
    : t("common.now");

  // Whose card it is: the agent asked, or the one who sent the chosen block.
  const owner: Agent | undefined = mode === "pin" ? (chosen ? dir.anyAgent(chosen.agentId) : undefined) : agent;
  const name = owner?.name ?? agent?.name ?? t("dashboards.newWidget.theAgent");
  const color = colorOf(owner ?? agent);
  const title = titleEdit ?? (mode === "pin" ? (chosen?.title ?? "") : (built?.title ?? ""));
  const shownSpec: WidgetSpec | null = mode === "pin" ? ((chosen?.spec as WidgetSpec | undefined) ?? null) : null;

  const failed = (error: unknown) => toast.show(errorText(t, error, i18n.language), "error");
  const canTest =
    mode === "ask" &&
    Boolean(agent) &&
    asked.length > 0 &&
    targetId !== null &&
    phase !== "testing" &&
    !remove.isPending;
  const busy = confirm.isPending || pin.isPending;
  const alertInput = { enabled: alertOn, condition: alertOn ? condition.trim() : "" };

  /** Test: the agent builds a draft now, with real data; the draft before it goes. */
  const runTest = () => {
    if (!canTest || !agent || targetId === null) return;
    const before = pending.current;
    pending.current = null;
    if (before) remove.mutate(before);
    setDraftId(null);
    setEditing(false);
    setAlertOpen(false);
    const forAsk = askKey;
    run.current += 1;
    const mine = run.current;
    setSending(true);
    setSince(Date.now());
    const made = (draftMade: Widget) => {
      // Closed or stopped while it was sent: nobody will create it.
      if (!alive.current || run.current !== mine) {
        drop.current(draftMade.id);
        return;
      }
      pending.current = draftMade.id;
      setDraftId(draftMade.id);
      setTestedFor(forAsk);
      setSending(false);
    };
    const refused = (error: unknown) => {
      if (!alive.current || run.current !== mine) return;
      setSending(false);
      failed(error);
    };
    // The person's own title, else a suggestion's when its ask is the one sent; else the agent names it.
    const own = titleEdit?.trim() || undefined;
    const named = own ?? (sug && asked === (sug.prompt || sug.title) ? sug.title : undefined);
    const input = {
      dashboardId: targetId,
      agentId: agent.id,
      prompt: asked,
      ...(named ? { title: named } : {}),
      format,
      schedule,
      alert: alertInput,
      size,
    };
    // Its promise, not the mutation's callbacks: those don't run once the dialog is gone, and the draft must go then.
    void test.mutateAsync(input).then(made, refused);
  };

  /** Stop: the build ends (its draft goes, and its run with it) and the ask is back as it was written. */
  const stop = () => {
    run.current += 1;
    const building = pending.current;
    pending.current = null;
    if (building) remove.mutate(building);
    setSending(false);
    setDraftId(null);
    setTestedFor(null);
    setStops((n) => n + 1);
  };

  /** Create widget: the tested draft goes on the board, with the title, size, schedule and alert chosen now. */
  const create = () => {
    if (!tested || targetId === null || busy) return;
    confirming.current = true;
    const own = titleEdit?.trim();
    confirm.mutate(
      {
        widgetId: tested.id,
        dashboardId: targetId,
        // Only a title the person wrote: theirs is kept from then on; otherwise the agent's from the test stays.
        ...(own && own !== tested.title ? { title: own } : {}),
        size,
        schedule,
        alert: alertInput,
      },
      {
        onSuccess: () => {
          pending.current = null;
          toast.show(t("dashboards.newWidget.created", { where }));
          onClose();
        },
        onError: (error) => {
          confirming.current = false;
          failed(error);
        },
      },
    );
  };

  /** Pin: the chosen block goes on the board as it is, kept up to date or not. */
  const pinIt = () => {
    if (!chosen || targetId === null || busy) return;
    const own = titleEdit?.trim();
    pin.mutate(
      {
        dashboardId: targetId,
        messageId: chosen.messageId,
        block: chosen.block,
        schedule,
        size,
        ...(own && own !== chosen.title ? { title: own } : {}),
      },
      {
        onSuccess: () => {
          toast.show(t("dashboards.newWidget.created", { where }));
          onClose();
        },
        onError: failed,
      },
    );
  };

  const submit = () => {
    if (mode === "pin") pinIt();
    else if (tested) create();
    else runTest();
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setTitleEdit(null);
    setEditing(false);
    setAlertOpen(false);
    setSchedule(next === "pin" ? "day" : "hour");
    if (next === "ask") setBlock(null);
  };
  const pickSuggestion = (index: number) => {
    const s = sugs[index];
    if (!s) return;
    setPicked(index);
    setText(s.prompt || s.title);
    if (s.alert) setCondition(s.alert);
    setSize(s.kind === "kpi" || s.kind === "goal" ? "s" : "m");
  };
  const pickAgent = (next: string) => {
    setAgentId(next);
    setPicked(null);
  };
  const pickBlock = (index: number) => {
    const b = blocks[index];
    setBlock(index);
    setTitleEdit(null);
    if (b) setSize(b.spec.kind === "kpi" || b.spec.kind === "goal" ? "s" : "m");
  };

  const layout = sizeToLayout(size);
  const tones = (who: { appearance?: unknown } | undefined) => widgetTileVars(colorOf(who), dark);

  const formatOptions = WIDGET_FORMATS.map((f) => ({
    value: f,
    label: t(`widgets.kinds.${f}`),
    description: t(`dashboards.newWidget.formatHints.${f}`, { name }),
    leading: <WidgetGlyph kind={f} size={20} />,
  }));
  /** The format, as a dropdown: boxed while the ask is written, quiet beside the folded ask. */
  const formatSelect = (boxed: boolean) => (
    <Select<WidgetFormat>
      className={boxed ? "nwc-pk nwc-pk--box" : "nwc-pk"}
      size="sm"
      aria-label={t("dashboards.newWidget.format")}
      value={format}
      onValueChange={setFormat}
      options={formatOptions}
      renderValue={(o) => (
        <span className="nwc-pk__v">
          <WidgetGlyph kind={o.value} size={18} />
          {o.value === "auto" && boxed ? t("dashboards.newWidget.formatAuto") : o.label}
        </span>
      )}
    />
  );
  /** The size, as a dropdown beside the format: its name, and how much of the board it takes. */
  const sizeSelect = (boxed: boolean) => (
    <Select<WidgetSize>
      className={boxed ? "nwc-pk nwc-pk--box" : "nwc-pk"}
      size="sm"
      aria-label={t("widgets.sizes.label")}
      value={size}
      onValueChange={setSize}
      options={WIDGET_SIZES.map((s) => ({
        value: s,
        label: t(`widgets.sizeNames.${s}`),
        description: t(`widgets.sizeHints.${s}`),
      }))}
    />
  );
  const scheduleWords = (s: WidgetSchedule, inline: boolean) => {
    if (s === "manual") {
      if (mode === "pin") return inline ? t("dashboards.newWidget.noUpdateInline") : t("dashboards.newWidget.noUpdate");
      return inline ? t("dashboards.newWidget.manualInline") : t("dashboards.newWidget.manual");
    }
    return inline ? t(`widgets.schedulesInline.${s}`) : t(`widgets.schedules.${s}`);
  };
  // Only the schedules: what each costs stays out of this dialog (the agent's budget still applies to every run).
  const scheduleSelect = (
    <Select<WidgetSchedule>
      className="nwc-pk"
      size="sm"
      aria-label={t("dashboards.newWidget.updates")}
      value={schedule}
      onValueChange={setSchedule}
      options={WIDGET_SCHEDULES.map((s) => ({ value: s, label: scheduleWords(s, false) }))}
      renderValue={(o) => (
        <span className="nwc-pk__v">
          <Icon name="repeat" size={14} />
          {scheduleWords(o.value, true)}
        </span>
      )}
    />
  );

  // The alert, behind the bell: on or off, and when.
  const alertSugs = [...new Set(sugs.map((s) => s.alert).filter((a): a is string => Boolean(a)))];
  const alertLine = alertOn
    ? condition.trim()
      ? t("widgets.alert.line", { condition: condition.trim() })
      : t("widgets.alert.lineAny")
    : t("widgets.alert.none");
  const bell = (
    <Popover
      label={t("dashboards.newWidget.alert")}
      side="bottom"
      align="end"
      open={alertOpen}
      onOpenChange={setAlertOpen}
      className="nw-alert"
      trigger={
        <button
          type="button"
          className="nwc-bell"
          aria-label={t("dashboards.newWidget.alert")}
          data-on={alertOn || undefined}
          title={alertLine}
        >
          <Icon name="bell" size={16} />
          {alertOn && <span>{t("dashboards.newWidget.alertOn")}</span>}
        </button>
      }
    >
      <div className="nw-alert__row">
        <Switch
          id={`${id}-alert`}
          checked={alertOn}
          onCheckedChange={setAlertOn}
          aria-describedby={`${id}-alert-hint`}
        />
        <span>
          <label htmlFor={`${id}-alert`}>
            <b>{t("widgets.alert.label")}</b>
          </label>
          <small id={`${id}-alert-hint`}>{t("widgets.alert.hint")}</small>
        </span>
      </div>
      {alertOn && (
        <>
          <label className="nw-alert__cond" htmlFor={`${id}-cond`}>
            {t("widgets.alert.condition")}
          </label>
          <Input
            id={`${id}-cond`}
            value={condition}
            maxLength={200}
            placeholder={t("widgets.alert.placeholder")}
            onChange={(e) => setCondition(e.target.value)}
          />
          {alertSugs.length > 0 && (
            <span className="nw-alert__sugs">
              {alertSugs.map((a) => (
                <button key={a} type="button" aria-pressed={condition.trim() === a} onClick={() => setCondition(a)}>
                  {a}
                </button>
              ))}
            </span>
          )}
        </>
      )}
      <span className="nw-alert__foot">
        <Button size="sm" onClick={() => setAlertOpen(false)}>
          {t("dashboards.newWidget.alertDone")}
        </Button>
      </span>
    </Popover>
  );

  // ── The card's parts ──────────────────────────────────────────────────
  const blockPicks = (
    <>
      <p className="nw-hint">{t("dashboards.newWidget.pickFromChat")}</p>
      {pinnable.isSuccess && blocks.length === 0 ? (
        <p className="nw-hint">{t("dashboards.newWidget.noBlocks")}</p>
      ) : (
        <div className="nw-picks" role="radiogroup" aria-label={t("dashboards.newWidget.fromChat")}>
          {blocks.map((b, i) => (
            // biome-ignore lint/a11y/useSemanticElements: a block's row (its glyph, title and place) in a radio group
            <button
              key={`${b.messageId}:${b.block}`}
              type="button"
              role="radio"
              className="nw-pick"
              aria-checked={block === i}
              style={tones(dir.anyAgent(b.agentId))}
              onClick={() => pickBlock(i)}
            >
              <span className="nw-pick__glyph">
                <WidgetGlyph kind={b.spec.kind} size={28} />
              </span>
              <span className="nw-pick__text">
                <b>{b.title}</b>
                <small>{placeOf(t, i18n.language, b, dir.anyAgent(b.agentId)?.name ?? "")}</small>
              </span>
              <span className="nw-radio" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </>
  );

  const askBox = (
    <>
      <textarea
        ref={askField}
        className="nwc-ask"
        rows={2}
        value={text}
        maxLength={2000}
        aria-label={t("dashboards.newWidget.what")}
        placeholder={t("dashboards.newWidget.what")}
        onChange={(e) => {
          setText(e.target.value);
          if (sug && e.target.value !== (sug.prompt || sug.title)) setPicked(null);
        }}
        onKeyDown={(e) => {
          // Enter tests (Shift+Enter is a new line).
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          runTest();
        }}
      />
      {phase === "none" && !asked && sugs.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: toggle buttons under the ask, not a fieldset
        <div className="nw-sugs" role="group" aria-label={t("dashboards.newWidget.suggestions")}>
          {sugs.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className="nw-sug"
              aria-pressed={picked === i}
              style={tones(agent)}
              onClick={() => pickSuggestion(i)}
            >
              <span className="nw-sug__glyph">
                <WidgetGlyph kind={s.kind} size={18} />
              </span>
              {s.title}
            </button>
          ))}
        </div>
      )}
      {/* The format sits at the card's foot end, under the ask (and the suggestions), at any size. */}
      <div className="nwc-row nwc-row--format">
        <span className="nwc-pks">
          {formatSelect(true)}
          {sizeSelect(true)}
        </span>
        {editing && built && <span className="nw-hint">{t("dashboards.newWidget.enterTests")}</span>}
      </div>
      {editing && built?.spec && (
        <div className="nwc-was" data-stale={stale || undefined}>
          <WidgetBody spec={built.spec} status="ok" color={color} size={layout} locale={i18n.language} sparkApart />
        </div>
      )}
    </>
  );

  /** What the card shows once asked: being built, why it failed, or the data. */
  const content: ReactNode =
    mode === "pin" ? (
      shownSpec && (
        <WidgetBody spec={shownSpec} status="ok" color={color} size={layout} locale={i18n.language} sparkApart />
      )
    ) : phase === "testing" ? (
      <div className="wk-build nw-build">
        <BuildingDither color={color} />
        <div className="nw-build__words">
          <p className="nw-build__step" role="status">
            <span key={stepWords}>{stepWords}</span>
          </p>
          <div
            className="nw-build__still"
            data-on={elapsed >= WIDGET_STILL_MS || undefined}
            aria-hidden={elapsed < WIDGET_STILL_MS}
          >
            <p>{t("dashboards.newWidget.stillWorking")}</p>
          </div>
        </div>
      </div>
    ) : phase === "failed" ? (
      <div className="nw-fail ac-iconline" role="status">
        <Icon name="alert" size={18} />
        <div>
          <b>{t("dashboards.newWidget.failedTitle", { name })}</b>
          <p>{failureText(t, draft?.failure ?? null, name)}</p>
          <span className="nw-fail__acts">
            <Button size="sm" icon="refresh" disabled={!canTest} onClick={runTest}>
              {t("dashboards.newWidget.tryAgain")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t("dashboards.newWidget.editAsk")}
            </Button>
          </span>
        </div>
      </div>
    ) : built?.spec ? (
      <WidgetBody spec={built.spec} status="ok" color={color} size={layout} locale={i18n.language} sparkApart />
    ) : null;

  const folded =
    mode === "pin" ? (
      chosen && (
        <button
          type="button"
          className="nwc-asked"
          aria-label={t("dashboards.newWidget.repick")}
          title={t("dashboards.newWidget.repick")}
          onClick={() => setBlock(null)}
        >
          <Icon name="pin" size={14} />
          <span>{placeOf(t, i18n.language, chosen, name)}</span>
          <Icon name="edit" size={14} />
        </button>
      )
    ) : (
      <button
        type="button"
        className="nwc-asked"
        aria-label={t("dashboards.newWidget.editAskOf", { ask: asked })}
        title={t("dashboards.newWidget.editAsk")}
        onClick={() => setEditing(true)}
      >
        <span>{t("dashboards.newWidget.quoted", { ask: asked })}</span>
        <Icon name="edit" size={14} />
      </button>
    );

  const body: ReactNode =
    mode === "pin" && !chosen ? (
      blockPicks
    ) : asking ? (
      askBox
    ) : (
      <>
        <div className="nwc-row">
          {folded}
          <span className="nwc-pks">
            {mode === "ask" && formatSelect(false)}
            {sizeSelect(false)}
          </span>
        </div>
        <div className="nwc-content">{content}</div>
      </>
    );

  const foot: ReactNode =
    phase === "testing" ? (
      <>
        <PixelSpinner size={14} color={color} />
        <span className="wg__when nwc-building">{t("dashboards.newWidget.buildingFoot", { name })}</span>
        <span className="nwc-clock" role="timer">
          {taskClock(elapsed)}
        </span>
        <Button size="sm" icon="stop" className="nwc-stop" onClick={stop}>
          {t("dashboards.newWidget.stop")}
        </Button>
      </>
    ) : (
      <>
        {mode === "ask" ? (
          <button
            type="button"
            className="nwc-who"
            aria-haspopup="dialog"
            aria-label={t("dashboards.newWidget.whoButton", { name })}
            disabled={agents.length === 0}
            onClick={() => setChoosing(true)}
          >
            {agent && <AgentAvatar agentId={agent.id} name={agent.name} size="xs" />}
            <b>{agent?.name ?? t("dashboards.newWidget.noAgents")}</b>
            <Icon name="chevronDown" size={14} />
          </button>
        ) : (
          owner && (
            <span className="nwc-who nwc-who--still">
              <AgentAvatar agentId={owner.id} name={owner.name} size="xs" />
              <b>{owner.name}</b>
            </span>
          )
        )}
        <span className="wg__dot" aria-hidden="true">
          ·
        </span>
        {scheduleSelect}
        {tested && <span className="nwc-when">{testedWhen}</span>}
      </>
    );

  // Pinning: no face until a block (and so its agent) is chosen.
  const face = mode === "pin" ? owner : agent;
  const card = (
    <article
      className="ac-card wg nwc"
      data-size={size}
      data-w={layout.w}
      data-h={layout.h}
      data-state={phase === "testing" ? "building" : "ok"}
      data-stale={(stale && !editing) || undefined}
      aria-label={title.trim() || t("dashboards.newWidget.title")}
      aria-busy={phase === "testing" || undefined}
      style={widgetTileVars(color, dark)}
    >
      <span className="wg__sweep" aria-hidden="true" />
      <div className="wg__head">
        {face && (
          <span className="wg__face">
            <AgentAvatar agentId={face.id} name={face.name} size="xs" />
          </span>
        )}
        <input
          className="nwc__title"
          value={title}
          maxLength={TITLE_MAX}
          spellCheck={false}
          autoComplete="off"
          aria-label={t("dashboards.newWidget.titleField")}
          placeholder={
            mode === "pin" ? t("dashboards.newWidget.titleField") : t("dashboards.newWidget.titlePlaceholder", { name })
          }
          onChange={(e) => setTitleEdit(e.target.value)}
        />
        {tested && (
          <span
            className="nwc__badge"
            role="img"
            aria-label={t("dashboards.newWidget.tested", { when: testedWhen })}
            title={t("dashboards.newWidget.tested", { when: testedWhen })}
          >
            <Icon name="check" size={14} />
          </span>
        )}
        {mode === "ask" && bell}
      </div>
      {stale && !editing && (
        <div className="nwc__stale ac-actline" role="status">
          <span className="ac-iconline">
            <Icon name="info" size={16} />
            <span>
              <b>{t("dashboards.newWidget.stale")}.</b> {t("dashboards.newWidget.staleHint")}
            </span>
          </span>
          <Button size="sm" icon="refresh" disabled={!canTest} onClick={runTest}>
            {t("dashboards.newWidget.testAgain")}
          </Button>
        </div>
      )}
      <div className="wg__body">{body}</div>
      <div className="wg__foot">{foot}</div>
      {!asking && <WidgetBleed spec={shownSpec ?? built?.spec ?? null} color={color} size={layout} />}
    </article>
  );

  // Under the card: what it reads and how it keeps up (once there is a result), or the other way to make one.
  const readsFrom = tested?.sources.length ? tested.sources : sources;
  const below: ReactNode =
    mode === "ask" && tested ? (
      <p className="nw-footnote ac-iconline">
        <Icon name="plug" size={14} />
        <span>
          {[
            readsFrom.length ? t("dashboards.newWidget.steps.reads", { sources: joinNames(readsFrom, t) }) : null,
            schedule === "manual" ? t("dashboards.newWidget.steps.noRoutine") : t("dashboards.newWidget.inRoutines"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </p>
    ) : mode === "pin" && chosen ? (
      <p className="nw-footnote ac-iconline">
        <Icon name="pin" size={14} />
        <span>
          {schedule === "manual"
            ? t("dashboards.newWidget.pinAsIs")
            : t("dashboards.newWidget.pinRedoes", { name, schedule: scheduleWords(schedule, true) })}
        </span>
      </p>
    ) : mode === "pin" ? (
      <button type="button" className="nw-quiet" onClick={() => switchMode("ask")}>
        <Icon name="chevronLeft" size={14} />
        {t("dashboards.newWidget.tabAsk")}
      </button>
    ) : phase === "none" && !editing ? (
      <button type="button" className="nw-quiet" onClick={() => switchMode("pin")}>
        <Icon name="pin" size={14} />
        {t("dashboards.newWidget.orPin")}
      </button>
    ) : null;

  const primary =
    mode === "pin" ? (
      <Button type="submit" variant="primary" disabled={!chosen || targetId === null || busy} loading={pin.isPending}>
        {t("dashboards.newWidget.pin")}
      </Button>
    ) : phase === "testing" ? (
      <Button variant="primary" disabled loading>
        {t("dashboards.newWidget.testingShort")}
      </Button>
    ) : stale ? (
      <Button variant="primary" icon="refresh" disabled={!canTest} onClick={runTest}>
        {t("dashboards.newWidget.testAgain")}
      </Button>
    ) : tested ? (
      <Button type="submit" variant="primary" disabled={busy || targetId === null} loading={confirm.isPending}>
        {t("dashboards.newWidget.create")}
      </Button>
    ) : phase === "failed" ? (
      <Button variant="primary" disabled>
        {t("dashboards.newWidget.create")}
      </Button>
    ) : (
      <Button type="submit" variant="primary" disabled={!canTest}>
        {t("dashboards.newWidget.test")}
      </Button>
    );

  return (
    <form
      className="db-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Locked when={busy}>
        <div className="ac-dialog__body nw-body">
          <div className="nw-stage">
            {card}
            {below}
          </div>
        </div>
      </Locked>
      {/* Where it goes is the footer's note, only when there is a choice (with My Home alone, nothing to pick):
          Cancelar and the main button stay one group, never split by it. */}
      <DialogFooter
        className="nw-foot"
        note={
          destOptions.length > 1 ? (
            <span className="nw-dest">
              <Icon name="grid" size={16} />
              <label htmlFor={`${id}-dest`}>{t("dashboards.newWidget.destination")}</label>
              <Locked when={busy}>
                <Select id={`${id}-dest`} size="sm" value={dest} onValueChange={setDest} options={destOptions} />
              </Locked>
            </span>
          ) : undefined
        }
      >
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        {primary}
      </DialogFooter>
      <AgentPickerDialog
        open={choosing}
        onClose={() => setChoosing(false)}
        agents={agents}
        value={agent?.id}
        onPick={pickAgent}
        title={t("dashboards.newWidget.who")}
        description={t("dashboards.newWidget.whoHint")}
      />
    </form>
  );
}

/** "Nina in #support · yesterday": where an agent sent the chart, and when. */
function placeOf(t: TFunction, locale: string, b: PinnableBlock, agentName: string): string {
  const when = relativeTime(t, locale, b.at);
  if (b.place.kind === "dm") return t("dashboards.newWidget.place.dm", { name: agentName, when });
  if (!b.place.name) return t("dashboards.newWidget.place.unnamed", { name: agentName, when });
  return t(b.place.kind === "thread" ? "dashboards.newWidget.place.thread" : "dashboards.newWidget.place.channel", {
    name: agentName,
    channel: b.place.name,
    when,
  });
}
