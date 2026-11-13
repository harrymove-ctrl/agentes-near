import { type ImportItemResult, keys, type MigrationBundle } from "@agenteschat/client";
import {
  Alert,
  Button,
  Field,
  Locked,
  normalizeAppearance,
  Radio,
  RadioCard,
  RadioGroup,
  Spinner,
  SwapLabel,
  Textarea,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { failedOffline } from "@/chat/offline";
import {
  ImportFlow,
  type ImportFlowState,
  ImportReport,
  Preview,
  SourceMark,
  useImportFlow,
  useImportMethod,
} from "@/components/ImportFlow";
import { EXPORT_PROMPT } from "@/lib/import";
import {
  agentsArrived,
  blockedItems,
  bundleOrigin,
  cardName,
  IMPORT_CARDS,
  importApplyErrorText,
  importFailureText,
  itemId,
  picksOf,
  type RequestCard,
  retryable,
} from "@/lib/import-flow";
import type { TeamSourceFacts, TeamSourceState } from "./TeamSource";

/*
 * The team step's own views of the import (ADR 0162 amended 2026-11-10, ADR 0055), loaded only once the step shows
 * them (`TeamSource`). The import's hook lives here, in the one component the step keeps mounted from the question to
 * the report, and tells the page what it holds (`link.publish`) for the heading, Lodi's line and the preview.
 */

/**
 * Every agent on the workspace's suggested model (`model: null`): whatever model it ran on in the other app, the AI
 * the rail's next step connects then answers for the whole team.
 */
const unmodeled = (bundle: MigrationBundle): MigrationBundle => ({
  ...bundle,
  agents: bundle.agents.map((a) => ({ ...a, model: null })),
});

const made = (item: ImportItemResult) => item.action === "create" || item.action === "update";

export function TeamSourceBody({
  state,
  orgId,
  personal,
  org,
}: {
  state: TeamSourceState;
  orgId: string;
  personal: boolean;
  org: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const flow = useImportFlow(orgId);
  const { link, none } = state;
  // Grok Bot's answer is pasted on the step's own view, which offers no MCP.
  const mcp = useImportMethod(flow, orgId).method === "mcp" && !link.replyCard;
  // A clean import whose files still go to the Drive: the step waits for the copy (closing the page would stop it).
  const [awaitCopy, setAwaitCopy] = useState(false);

  const bring = useMutation({
    // A failure is said in place, under what was found, and the same button tries again (what came stays).
    meta: { silent: true },
    mutationFn: async () => {
      // As the apply reads them: whether it then copies the agents' files to the Drive (`useImportFlow`'s apply).
      const { planned: plan, pick, copyFiles } = flow;
      const items = await flow.apply(unmodeled);
      // As the template's button: done once the agents are in the page's list, where the rail reads them.
      await qc.invalidateQueries({ queryKey: keys.agents(orgId) });
      const arrived = plan ? agentsArrived(plan.items, items, pick, new Set()) : new Map<string, string>();
      return { items, copies: copyFiles && (plan?.files.some((f) => arrived.has(f.agent)) ?? false) };
    },
    onMutate: () => {
      setAwaitCopy(false);
      link.hold(true);
    },
    onSuccess: ({ items, copies }) => {
      const clean = items.some((i) => i.kind === "agent" && made(i)) && !items.some((i) => i.action === "skip");
      // Everything came: the rail moves on. Something stayed behind, or no agent came: the report waits for Continue.
      if (items.length === 0 || (clean && !copies)) return link.hold(false);
      if (clean) setAwaitCopy(true);
    },
  });

  const copying = Boolean(flow.copy?.running);
  const leftBehind = (flow.copy?.result?.left.length ?? 0) > 0;
  useEffect(() => {
    if (!awaitCopy || copying || leftBehind) return;
    setAwaitCopy(false);
    link.hold(false);
  }, [awaitCopy, copying, leftBehind, link.hold]);

  const planned = flow.planned;
  const facts = useMemo<TeamSourceFacts>(() => {
    if (!planned)
      return {
        card: flow.card,
        app: flow.card && flow.card !== "other" ? cardName(t, flow.card) : null,
        count: 0,
        coming: null,
        report: false,
        applying: false,
        mcp,
      };
    const items = new Map(planned.items.map((i) => [itemId(i), i]));
    const comes = (kind: "agent" | "channel", key: string) => {
      const item = items.get(itemId({ kind, key }));
      return item !== undefined && (item.action === "unchanged" || (made(item) && flow.pick.has(itemId(item))));
    };
    const origin = bundleOrigin(planned.bundle);
    return {
      card: flow.card,
      app: origin.app ?? (planned.bundle.source.name || cardName(t, origin.card)),
      count: planned.bundle.agents.length,
      coming: {
        agents: planned.bundle.agents
          .filter((a) => comes("agent", a.key))
          .map((a) => ({ name: a.name, role: a.role, look: normalizeAppearance(a.appearance), fresh: true })),
        channels: planned.bundle.channels.filter((c) => comes("channel", c.key)).map((c) => c.name),
      },
      report: flow.report !== null,
      applying: bring.isPending,
      mcp: false,
    };
  }, [planned, flow.card, flow.pick, flow.report, bring.isPending, mcp, t]);
  useEffect(() => {
    link.publish(facts);
  }, [facts, link.publish]);
  useEffect(() => () => link.publish(null), [link.publish]);
  // The page's Back reaches the flow: back from what was found to the request clears it.
  useEffect(() => {
    link.bindReset(flow.reset);
  });
  useEffect(() => () => link.bindReset(null), [link.bindReset]);

  const picks = useMemo(
    () => (planned ? picksOf(planned.items, flow.pick, blockedItems(planned.bundle, planned.items, flow.pick)) : []),
    [planned, flow.pick],
  );

  // "Prefer a new team" from the request: a team's start (a template's team or from scratch), or a personal workspace on
  // with no agents yet.
  const fresh = () => {
    flow.reset();
    link.choose("none");
    if (personal) link.go("ask");
    none.mutate();
  };

  // The report once the apply settled and kept the step (something stayed behind, or the files still copy); a clean
  // one stays on what was found, its button pending, until the rail moves on.
  const reporting = flow.report !== null && state.holding && !bring.isPending;
  const view = link.stage !== "import" ? "ask" : reporting ? "report" : planned ? "found" : "bring";
  const agentsCame = (flow.report ?? []).some((i) => i.kind === "agent" && made(i));

  if (view === "ask") return <Ask state={state} flow={flow} personal={personal} org={org} />;

  if (view === "report") {
    const onContinue = () => {
      setAwaitCopy(false);
      if (agentsCame) return link.hold(false);
      // No agent came (all of them skipped, or only skills and channels): a team chooses how to start (a template's
      // team or from scratch), a personal workspace goes on with no agents yet, as "Prefer a new team" does (the
      // question shows that answer while it saves, and stays with it if the save fails).
      if (personal) {
        link.hold(false);
        return fresh();
      }
      link.go("start");
      link.hold(false);
    };
    return (
      <>
        <div className="onb__answer">
          <ImportReport flow={flow} orgId={orgId} linked={false} onRetry={() => flow.apply(unmodeled)} />
        </div>
        <div className="onb__actions">
          <Button
            variant="primary"
            block
            kbd={["↵"]}
            data-enter=""
            disabled={copying || bring.isPending || none.isPending}
            onClick={onContinue}
          >
            {t("onboarding.actions.continue")}
          </Button>
        </div>
      </>
    );
  }

  if (view === "found")
    return (
      <>
        <div className="onb__answer">
          <Preview flow={flow} orgId={orgId} standalone={false} level={2} />
          {flow.progress && (
            <p className="imp-apply__progress" role="status">
              {t("onboarding.import.applying", flow.progress)}
            </p>
          )}
          {bring.isError && <Alert>{importApplyErrorText(t, bring.error, failedOffline)}</Alert>}
        </div>
        <div className="onb__actions">
          <Button
            variant="primary"
            block
            kbd={["↵"]}
            data-enter=""
            disabled={picks.length === 0}
            // Brought, with nothing left behind: pending until the rail moves on to the next step.
            loading={bring.isPending || agentsCame}
            onClick={() => bring.mutate()}
          >
            {t(personal ? "onboarding.flow.team.found.bringPersonal" : "onboarding.flow.team.found.bring")}
          </Button>
        </div>
      </>
    );

  const freshLink = (
    <p className="onb__help">
      <button
        type="button"
        className="ac-link onb__link"
        onClick={fresh}
        disabled={flow.busy !== null || none.isPending}
      >
        {t(personal ? "onboarding.flow.team.ask.freshPersonal" : "onboarding.flow.team.bring.fresh")}
      </button>
    </p>
  );
  if (link.replyCard) return <BringReply card={link.replyCard} flow={flow} after={freshLink} />;
  // Any other app hands back files: the import's own picker, which reads a drop, a folder, a link or an answer. It
  // reads as soon as something is dropped or picked, so the step has no button of its own here.
  return (
    <div className="onb__answer">
      <ImportFlow flow={flow} orgId={orgId} />
      {freshLink}
    </div>
  );
}

/**
 * The question: the import's apps as cards, and "No agents yet" on a row of its own under them (the cards' grid never
 * ends on a lone card). The step's button says where the answer leads. A team's question has "Skip this step" under
 * it (ADR 0162, amended 2026-11-11); a personal workspace's "No agents yet" already goes on with no agents.
 */
function Ask({
  state,
  flow,
  personal,
  org,
}: {
  state: TeamSourceState;
  flow: ImportFlowState;
  personal: boolean;
  org: string;
}) {
  const { t } = useTranslation();
  const { link, none, skip } = state;
  const { chosen } = link;
  return (
    <>
      <Locked when={none.isPending || skip.isPending}>
        <div className="onb__answer">
          <RadioGroup
            value={chosen ?? ""}
            onValueChange={(v) => link.choose(v || null)}
            aria-label={t("onboarding.flow.team.ask.title")}
            className="onb-sources"
          >
            <div className="imp-sources">
              {IMPORT_CARDS.map((c) => (
                <label
                  key={c}
                  htmlFor={`onb-source-${c}`}
                  className="ac-option ac-option--stacked imp-source onb-source"
                  data-state={chosen === c ? "checked" : "unchecked"}
                >
                  <Radio value={c} id={`onb-source-${c}`} />
                  <SourceMark card={c} />
                  <span className="ac-option__title">{cardName(t, c)}</span>
                </label>
              ))}
            </div>
            <RadioCard
              value="none"
              id="onb-source-none"
              checked={chosen === "none"}
              title={t("onboarding.flow.team.ask.none")}
              description={
                personal
                  ? t("onboarding.flow.team.ask.noneTextPersonal")
                  : t("onboarding.flow.team.ask.noneText", { org })
              }
            />
          </RadioGroup>
        </div>
      </Locked>
      <div className="onb__actions">
        <Button
          variant="primary"
          block
          kbd={["↵"]}
          data-enter=""
          disabled={chosen === null || skip.isPending}
          loading={none.isPending}
          onClick={() => {
            if (chosen === "none") return none.mutate();
            if (!chosen) return;
            flow.setCard(chosen);
            link.go("import");
          }}
        >
          {chosen === "none"
            ? t(personal ? "onboarding.flow.team.ask.freshPersonal" : "onboarding.flow.team.ask.fresh")
            : chosen && chosen !== "other"
              ? t("onboarding.flow.team.ask.from", { app: cardName(t, chosen) })
              : t("onboarding.actions.continue")}
        </Button>
        {!personal && (
          <p className="onb__skip">
            <span className="muted">{t("onboarding.flow.team.ask.skipText")}</span>
            <button
              type="button"
              className="ac-link"
              disabled={none.isPending || skip.isPending}
              onClick={() => skip.mutate()}
            >
              {t("onboarding.flow.team.ask.skip")}
            </button>
          </p>
        )}
      </div>
    </>
  );
}

/**
 * An app that answers in its chat: the request to copy there, then its answer pasted here and read by the step's
 * button. Enter in the answer is a new line (an answer is many lines), never the step's button.
 */
function BringReply({ card, flow, after }: { card: RequestCard; flow: ImportFlowState; after: ReactNode }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const app = cardName(t, card);
  const busy = flow.busy !== null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(EXPORT_PROMPT);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <>
      <div className="onb__answer">
        <section className="imp-other" aria-labelledby="onb-bring-title">
          <h2 id="onb-bring-title" className="imp-other__title">
            {t("onboarding.flow.team.bring.ask", { app })}
          </h2>
          <ol className="imp-other__steps">
            <li>{t("onboarding.import.request.copyStep")}</li>
            <li>{t("onboarding.flow.team.bring.paste", { app })}</li>
            <li>{t("onboarding.flow.team.bring.reply")}</li>
          </ol>
          <Textarea
            readOnly
            rows={6}
            value={EXPORT_PROMPT}
            aria-label={t("onboarding.import.request.prompt")}
            className="imp-other__prompt"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="imp-other__copy">
            <Button onClick={() => void copy()}>
              <SwapLabel
                icon="copy"
                altIcon="check"
                label={t("onboarding.import.request.copy")}
                alt={t("common.copied")}
                showAlt={copied === "ok"}
              />
            </Button>
            <span role="status" className="small muted">
              {copied === "ok"
                ? t(`onboarding.import.request.${card}.copied`)
                : copied === "failed"
                  ? t("onboarding.import.request.copyFailed")
                  : ""}
            </span>
          </div>
        </section>
        {busy ? (
          <div className="imp-reading">
            <span className="imp-reading__text" role="status">
              <Spinner />
              {flow.busy === "planning" ? t("onboarding.import.planning") : t("onboarding.import.reading")}
            </span>
            <Button size="sm" variant="ghost" onClick={flow.cancel}>
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <Field label={t("onboarding.flow.team.bring.field", { app })}>
            <Textarea
              rows={6}
              className="imp-other__prompt"
              value={text}
              placeholder={t("onboarding.flow.team.bring.placeholder")}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.stopPropagation();
              }}
            />
          </Field>
        )}
        {flow.failure && (
          <div className="imp-failure">
            <Alert>{importFailureText(t, flow.failure, failedOffline)}</Alert>
            {retryable(flow.failure) && (
              <Button size="sm" icon="refresh" onClick={() => void flow.retry()}>
                {t("common.retry")}
              </Button>
            )}
          </div>
        )}
        {after}
      </div>
      <div className="onb__actions">
        <Button
          variant="primary"
          block
          kbd={["↵"]}
          data-enter=""
          disabled={!text.trim()}
          loading={busy}
          onClick={() => void flow.read({ text })}
        >
          {t("onboarding.flow.team.bring.read")}
        </Button>
      </div>
    </>
  );
}
