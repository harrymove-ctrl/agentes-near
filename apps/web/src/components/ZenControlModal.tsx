import {
  Button,
  Chip,
  Dialog,
  DialogBody,
  Icon,
  Input,
  TabPanel,
  Tabs,
} from "@agenteschat/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import "./zen-modal.css";

type DecisionStatus = "pending" | "agree" | "adjust";

interface ZenDecision {
  decisionId: string;
  epicRef: string;
  title: string;
  proposal: string;
  status: DecisionStatus;
  note: string;
  decidedBy: string | null;
  receiptId: string | null;
  updatedAt: string;
}

interface ZenReceipt {
  seq: number;
  receiptId: string;
  actorKind: "person" | "agent" | "machine";
  actorName: string;
  actorFingerprint: string;
  actionType: string;
  epicRef: string;
  targetRef: string;
  summary: string;
  payloadHash: string;
  prevHash: string;
  receiptHash: string;
  signatureShort: string;
  createdAt: string;
}

interface ZenVerification {
  ok: boolean;
  algorithm: string;
  totalReceipts: number;
  verifiedReceipts: number;
  m5ProvenanceRate: string;
  headHash: string;
  brokenAtSeq: number | null;
  reason: string | null;
}

interface ZenPersona {
  id: string;
  name: string;
  email: string;
  roleBadge: string;
  epicFocus: string;
  handle: string;
}

interface ZenOverviewResponse {
  codename: string;
  product: string;
  personas: ZenPersona[];
  currentUser: { id: string; name: string; email: string };
  verification: ZenVerification;
  decisions: ZenDecision[];
  receipts: ZenReceipt[];
}

interface ZenTamperResponse {
  tamperDetected: boolean;
  mutatedSeq: number;
  originalPayloadHash: string;
  tamperedPayloadHash: string;
  verificationAfterTamper: ZenVerification;
  liveLedgerIntact: boolean;
}

interface ZenExportBundle {
  format: string;
  epic: string;
  exportedAt: string;
  secretsIncluded: boolean;
  secretPolicy: string;
  providerReferences: Array<{
    provider: string;
    label: string;
    keyHintRedacted: string;
    endpointBaseUrl: string | null;
  }>;
  agents: Array<{ handle: string; name: string; role: string; model: string }>;
  skillsMarkdown: Array<{ slug: string; name: string; version: number }>;
  provenanceReceipts: ZenReceipt[];
}

type ZenTab = "decisions" | "provenance" | "portability";

export function ZenControlModal({
  open,
  onOpenChange,
  orgId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<ZenTab>("decisions");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [tamperResult, setTamperResult] = useState<ZenTamperResponse | null>(null);
  const [bundlePreview, setBundlePreview] = useState<ZenExportBundle | null>(null);
  const [switchingEmail, setSwitchingEmail] = useState<string | null>(null);

  const overview = useQuery<ZenOverviewResponse>({
    queryKey: ["zen-overview", orgId],
    enabled: open && Boolean(orgId),
    queryFn: async () => {
      const res = await fetch(`/api/app/organizations/${orgId}/zen/overview`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load ZEN overview (${res.status})`);
      return res.json() as Promise<ZenOverviewResponse>;
    },
  });

  const decideMutation = useMutation({
    mutationFn: async (input: { decisionId: string; status: DecisionStatus; note: string }) => {
      const res = await fetch(`/api/app/organizations/${orgId}/zen/decisions/${input.decisionId}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: input.status, note: input.note }),
      });
      if (!res.ok) throw new Error(`Decision save failed (${res.status})`);
      return res.json() as Promise<{
        decision: ZenDecision;
        receiptId: string;
        verification: ZenVerification;
      }>;
    },
    onSuccess: (_data, vars) => {
      if (editingNoteId === vars.decisionId) {
        setEditingNoteId(null);
      }
      void qc.invalidateQueries({ queryKey: ["zen-overview", orgId] });
    },
  });

  const tamperMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/app/organizations/${orgId}/zen/tamper-check`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Tamper simulation failed (${res.status})`);
      return res.json() as Promise<ZenTamperResponse>;
    },
    onSuccess: (data) => {
      setTamperResult(data);
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/app/organizations/${orgId}/zen/export-bundle`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Export bundle failed (${res.status})`);
      return res.json() as Promise<ZenExportBundle>;
    },
    onSuccess: (data) => {
      setBundlePreview(data);
    },
  });

  const switchPersona = async (email: string) => {
    setSwitchingEmail(email);
    try {
      const res = await fetch("/api/auth/zen-demo-login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(`Persona switch failed (${res.status})`);
      qc.clear();
      window.location.assign("/");
    } finally {
      setSwitchingEmail(null);
    }
  };

  const decisions = overview.data?.decisions ?? [];
  const agreedCount = decisions.filter((d) => d.status === "agree").length;
  const verification = overview.data?.verification;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={780}
      title="Ergo (Codename ZEN) · Architecture & Provenance"
      subtitle="Customer Zero experiment for CommandOSS · Local PGlite + ML-DSA-65 ledger"
      closeLabel="Close"
    >
      <DialogBody>
        <div className="zen-modal">
          <div className="zen-modal__bar">
            <div className="zen-modal__metrics">
              <span>
                M5 Provenance:{" "}
                <strong>
                  {verification
                    ? `${verification.m5ProvenanceRate} (${verification.verifiedReceipts}/${verification.totalReceipts})`
                    : "Loading..."}
                </strong>
              </span>
              <span>
                Agreed: <strong>{agreedCount} / {decisions.length || 9}</strong>
              </span>
              {overview.data?.currentUser.name && (
                <span>
                  Identity: <strong>{overview.data.currentUser.name}</strong>
                </span>
              )}
            </div>
            <Link
              to="/updates"
              className="zen-modal__updates-link"
              onClick={() => onOpenChange(false)}
            >
              <Icon name="bulb" size={14} />
              <span>Updates &amp; PRD Log</span>
            </Link>
          </div>

          <Tabs<ZenTab>
            variant="segmented"
            label="Ergo ZEN inspector sections"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "decisions", label: "Decisions D1..D9", count: agreedCount },
              {
                value: "provenance",
                label: "ML-DSA-65 Ledger",
                count: verification?.totalReceipts,
              },
              { value: "portability", label: "Personas & Export" },
            ]}
          >
            <TabPanel value="decisions">
              <div className="zen-modal__panel">
                <p className="zen-modal__lead">
                  Sign off the 9 architecture proposals covering Epics <code>E8..E16</code>. Each
                  choice records a post-quantum <code>ML-DSA-65</code> receipt in the workspace
                  ledger.
                </p>

                {decisions.map((d) => {
                  const draftNote = notes[d.decisionId] ?? d.note ?? "";
                  const noteOpen = editingNoteId === d.decisionId;
                  return (
                    <div
                      key={d.decisionId}
                      className="zen-card"
                      data-status={d.status}
                      data-testid={`zen-decision-${d.decisionId}`}
                    >
                      <div className="zen-card__head">
                        <div className="zen-card__title-group">
                          <span className="zen-card__id">{d.decisionId}</span>
                          <span className="zen-card__title">{d.title}</span>
                          <Chip>{d.epicRef}</Chip>
                        </div>

                        <div className="zen-card__actions">
                          <Chip
                            tone={
                              d.status === "agree"
                                ? "done"
                                : d.status === "adjust"
                                  ? "waiting"
                                  : "neutral"
                            }
                            icon={
                              d.status === "agree"
                                ? "check"
                                : d.status === "adjust"
                                  ? "alert"
                                  : "shield"
                            }
                          >
                            {d.status === "agree"
                              ? "Agreed"
                              : d.status === "adjust"
                                ? "Adjust"
                                : "Pending"}
                          </Chip>

                          <Button
                            size="sm"
                            variant={d.status === "agree" ? "primary" : "default"}
                            data-testid={`zen-agree-${d.decisionId}`}
                            loading={
                              decideMutation.isPending &&
                              decideMutation.variables?.decisionId === d.decisionId &&
                              decideMutation.variables?.status === "agree"
                            }
                            onClick={() =>
                              decideMutation.mutate({
                                decisionId: d.decisionId,
                                status: "agree",
                                note: draftNote,
                              })
                            }
                          >
                            Agree
                          </Button>

                          <Button
                            size="sm"
                            variant="ghost"
                            data-testid={`zen-adjust-${d.decisionId}`}
                            loading={
                              decideMutation.isPending &&
                              decideMutation.variables?.decisionId === d.decisionId &&
                              decideMutation.variables?.status === "adjust"
                            }
                            onClick={() => {
                              if (!noteOpen && !draftNote) {
                                setEditingNoteId(d.decisionId);
                              }
                              decideMutation.mutate({
                                decisionId: d.decisionId,
                                status: "adjust",
                                note: draftNote,
                              });
                            }}
                          >
                            Adjust
                          </Button>

                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setEditingNoteId(noteOpen ? null : d.decisionId)
                            }
                          >
                            {noteOpen ? "Hide note" : d.note ? "Edit note" : "Note"}
                          </Button>
                        </div>
                      </div>

                      <p className="zen-card__proposal">{d.proposal}</p>

                      {noteOpen && (
                        <div className="zen-card__note-box">
                          <div className="zen-card__note-input">
                            <Input
                              aria-label={`${d.decisionId} note`}
                              placeholder="Optional architecture rationale or adjustment note..."
                              value={draftNote}
                              onChange={(e) =>
                                setNotes((prev) => ({
                                  ...prev,
                                  [d.decisionId]: e.target.value,
                                }))
                              }
                            />
                          </div>
                          <Button
                            size="sm"
                            variant="default"
                            onClick={() =>
                              decideMutation.mutate({
                                decisionId: d.decisionId,
                                status: d.status === "pending" ? "agree" : d.status,
                                note: draftNote,
                              })
                            }
                          >
                            Save note
                          </Button>
                        </div>
                      )}

                      {(d.receiptId || d.note) && (
                        <div className="zen-card__foot">
                          {d.note ? (
                            <span className="zen-card__saved-note">"{d.note}"</span>
                          ) : (
                            <span />
                          )}
                          {d.receiptId && (
                            <span>
                              Signed by <strong>{d.decidedBy}</strong> ·{" "}
                              <code>{d.receiptId}</code>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </TabPanel>

            <TabPanel value="provenance">
              <div className="zen-modal__panel">
                <div className="zen-card">
                  <div className="zen-card__head">
                    <div>
                      <div className="zen-card__title">
                        Guardrail M5: {verification?.m5ProvenanceRate ?? "100%"} Verified (
                        {verification?.algorithm ?? "ML-DSA-65"})
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ac-ink-muted)", marginTop: 2 }}>
                        Chain head: <code>{verification?.headHash.slice(0, 28)}...</code>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="default"
                      icon="shield"
                      data-testid="zen-tamper-btn"
                      loading={tamperMutation.isPending}
                      onClick={() => tamperMutation.mutate()}
                    >
                      Simulate Tamper Attack (AC14.6)
                    </Button>
                  </div>
                </div>

                {tamperResult && (
                  <div className="zen-card" data-testid="zen-tamper-result">
                    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                      <strong>
                        <Icon name="check" size={14} inline /> Tamper Caught at Seq #
                        {tamperResult.mutatedSeq}:
                      </strong>{" "}
                      Mutating 1 nibble of <code>payload_hash</code> (
                      <code>{tamperResult.originalPayloadHash.slice(0, 10)}...</code> to{" "}
                      <code>{tamperResult.tamperedPayloadHash.slice(0, 10)}...</code>) broke the{" "}
                      <code>ML-DSA-65</code> signature check immediately (
                      <code>{tamperResult.verificationAfterTamper.reason}</code>). Live PGlite
                      ledger intact:{" "}
                      <strong>{tamperResult.liveLedgerIntact ? "YES (100%)" : "NO"}</strong>.
                    </div>
                  </div>
                )}

                {(overview.data?.receipts ?? []).map((r) => (
                  <div key={r.receiptId} className="zen-receipt-row">
                    <div className="zen-card__head">
                      <span>
                        <strong>#{r.seq}</strong> · <strong>{r.actorName}</strong> ({r.actorKind}) ·{" "}
                        <code>{r.actionType}</code>
                      </span>
                      <Chip>{r.epicRef}</Chip>
                    </div>
                    <div style={{ color: "var(--ac-ink-soft)" }}>{r.summary}</div>
                    <div style={{ fontSize: 11, color: "var(--ac-ink-muted)" }}>
                      Receipt <code>{r.receiptId}</code> · Sig <code>{r.signatureShort}</code> · PQ
                      Key <code>{r.actorFingerprint}</code>
                    </div>
                  </div>
                ))}
              </div>
            </TabPanel>

            <TabPanel value="portability">
              <div className="zen-modal__panel">
                <div className="zen-card">
                  <div className="zen-card__title">
                    CommandOSS Persona Switcher (E9 Private Channels &amp; F2.8 Guest Isolation)
                  </div>
                  <p className="zen-card__proposal">
                    Switch session cookies in one click to verify that private{" "}
                    <code>#exec-security</code> is accessible to <strong>Harry Phan</strong>,{" "}
                    <strong>Henry Nguyen</strong>, and <strong>Daniel Lam</strong>, while hidden
                    from <strong>Tyr</strong> and <strong>External Client</strong>.
                  </p>
                  <div className="zen-persona-grid">
                    {(overview.data?.personas ?? []).map((p) => {
                      const active = overview.data?.currentUser.email === p.email;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className="zen-persona-btn"
                          data-active={active}
                          data-testid={`zen-switch-${p.handle}`}
                          disabled={switchingEmail !== null}
                          onClick={() => void switchPersona(p.email)}
                        >
                          <span style={{ fontWeight: 600, fontSize: 12.5 }}>
                            {p.name} {active ? "(Current)" : ""}
                          </span>
                          <span style={{ fontSize: 11.5, color: "var(--ac-ink-muted)" }}>
                            {p.roleBadge}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--ac-ink-soft)" }}>
                            {p.epicFocus}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="zen-card">
                  <div className="zen-card__head">
                    <div>
                      <div className="zen-card__title">
                        Open Agent Bundle Export (<code>.ergo-bundle</code> · Epic E15)
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ac-ink-muted)", marginTop: 2 }}>
                        Exports personas, <code>SKILL.md</code> files, and signed provenance with
                        zero raw API keys.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      icon="code"
                      data-testid="zen-export-btn"
                      loading={exportMutation.isPending}
                      onClick={() => exportMutation.mutate()}
                    >
                      Preview .ergo-bundle
                    </Button>
                  </div>

                  {bundlePreview && (
                    <pre
                      data-testid="zen-export-preview"
                      style={{
                        margin: 0,
                        maxHeight: 220,
                        overflow: "auto",
                        padding: 10,
                        borderRadius: 8,
                        fontSize: 11.5,
                        background: "var(--ac-bg-subtle, rgba(15, 23, 42, 0.04))",
                      }}
                    >
                      {JSON.stringify(bundlePreview, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            </TabPanel>
          </Tabs>
        </div>
      </DialogBody>
    </Dialog>
  );
}
