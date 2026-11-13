import { type ImportItemResult, keys, type MigrationBundle, useAgents, useApi } from "@agenteschat/client";
import {
  agentsSince,
  applyInChunks,
  blockedItems,
  bundleOrigin,
  choosable,
  githubRoot,
  type ImportCard,
  type ImportFailure,
  type ImportMethod,
  isGithubLink,
  itemId,
  NOT_GITHUB,
  picksOf,
} from "@agenteschat/client/lib/import/flow";
import { type ImportFile, parseImport } from "@agenteschat/client/lib/import/index";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMeId } from "../shared/hooks";
import { planIn } from "./import";

/** What the phone reads: picked files (already text), a GitHub link, or a pasted reply. */
export type PhoneImportInput = { files: ImportFile[] | Promise<ImportFile[]> } | { url: string } | { text: string };

/**
 * The web's import flow (`useImportFlow`) for the phone's create-agent step: read into a bundle, plan it on the
 * server (a dry run), the person picks, apply in chunks. Nothing is written before `apply`.
 */
export function useAgentImport(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const [card, pickCard] = useState<ImportCard | null>(null);
  const [busy, setBusy] = useState<"reading" | "planning" | null>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [plan, setPlan] = useState<{
    orgId: string;
    bundle: MigrationBundle;
    items: ImportItemResult[];
    from: ImportFailure["from"];
  } | null>(null);
  const planned = planIn(plan, orgId);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const done = useRef(new Map<string, ImportItemResult>());
  const run = useRef(0);
  const last = useRef<PhoneImportInput | null>(null);
  // Connect with MCP or Prompt only, per source, once the person picks one (until then, the source's default).
  const [methods, setMethods] = useState<Partial<Record<ImportCard, ImportMethod>>>({});
  // The workspace's agents as read after a source's MCP steps first showed: only the ones made since then arrived.
  const [watching, setWatching] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const since = useRef(0);
  const me = useMeId();
  const agents = useAgents(orgId);
  // From a read that ended after watching started: the cache may miss an agent made while the socket was down.
  const fresh = watching && !agents.isFetching && agents.dataUpdatedAt >= since.current ? agents.data : undefined;
  useEffect(() => {
    if (!seen && fresh) setSeen(new Set(fresh.map((a) => a.id)));
  }, [seen, fresh]);
  const arrived = seen && me && agents.data ? agentsSince(agents.data, seen, me) : [];
  const { refetch } = agents;
  /** Watches for the agents an AI app creates through MCP (`arrived`) until the returned stop. */
  const watch = useCallback(() => {
    since.current = Date.now();
    setWatching(true);
    void refetch();
    return () => setWatching(false);
  }, [refetch]);
  const setCard = (next: ImportCard | null) => {
    if (next !== card) setSeen(null);
    pickCard(next);
  };

  const read = async (input: PhoneImportInput) => {
    const mine = ++run.current;
    const current = () => mine === run.current;
    const from: ImportFailure["from"] = "url" in input ? "link" : "text" in input ? "paste" : "files";
    let step: ImportFailure["step"] = "read";
    last.current = input;
    setFailure(null);
    setBusy("reading");
    try {
      let files: ImportFile[];
      let root: string | null = null;
      if ("url" in input) {
        if (!isGithubLink(input.url)) throw NOT_GITHUB;
        const res = await api.agents.importFromGithub(orgId, input.url);
        files = res.files.map((f) => ({ name: f.path, text: f.text }));
        root = githubRoot(input.url);
      } else if ("text" in input) {
        files = [{ name: "pasted", text: input.text }];
      } else {
        files = await input.files;
      }
      if (!current()) return;
      step = "plan";
      const list = await qc.fetchQuery({ queryKey: keys.models, queryFn: () => api.agents.models() });
      step = "parse";
      const bundle = parseImport(files, { models: list.models.map((m) => m.id), root });
      if (!current()) return;
      step = "plan";
      setBusy("planning");
      const plan = await api.imports.apply(orgId, { bundle, dryRun: true });
      if (!current()) return;
      done.current = new Map();
      setPlan({ orgId, bundle, items: plan.items, from });
      setPick(new Set(plan.items.filter(choosable).map(itemId)));
      setCard(bundleOrigin(bundle).card);
    } catch (cause) {
      if (current()) setFailure({ from, step, cause });
    } finally {
      if (current()) setBusy(null);
    }
  };

  const blocked = planned ? blockedItems(planned.bundle, planned.items, pick) : new Map();
  const picks = planned ? picksOf(planned.items, pick, blocked) : [];

  /** Applies what is picked. `null`: it failed (`applyError`). */
  const apply = async (): Promise<ImportItemResult[] | null> => {
    if (!planned || picks.length === 0) return [];
    setApplyError(null);
    setProgress({ done: 0, total: picks.length });
    try {
      return await applyInChunks(api, planned.orgId, { bundle: planned.bundle, pick: picks }, done.current, (n) =>
        setProgress({ done: n, total: picks.length }),
      );
    } catch (e) {
      setApplyError(e);
      return null;
    } finally {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: keys.org(planned.orgId) });
    }
  };

  return {
    card,
    setCard,
    methods,
    setMethod: (c: ImportCard, method: ImportMethod) => {
      setFailure(null);
      setMethods((m) => ({ ...m, [c]: method }));
    },
    watch,
    arrived,
    /** The read the MCP step counts from failed: nothing can show as arrived until `refetch` works. */
    watchError: watching && !seen && agents.isError && !agents.isFetching ? agents.error : null,
    rewatch: () => void refetch(),
    busy,
    failure,
    planned,
    applyError,
    blocked,
    picks,
    progress,
    read,
    apply,
    retry: () => (last.current ? read(last.current) : Promise.resolve()),
    /** Stops waiting for a read: what it finds is dropped. */
    cancel: () => {
      run.current++;
      setBusy(null);
    },
    toggle: (ids: readonly string[], on: boolean) =>
      setPick((p) => {
        const next = new Set(p);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      }),
    reset: () => {
      run.current++;
      done.current = new Map();
      setBusy(null);
      setFailure(null);
      setApplyError(null);
      setPlan(null);
      setSeen(null);
    },
  };
}

export type AgentImport = ReturnType<typeof useAgentImport>;
