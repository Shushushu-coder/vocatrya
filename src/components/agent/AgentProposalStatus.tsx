"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import type { AgentOperationProposalDTO } from "@/lib/agent/operationProposalContract";
import {
  decideOperationProposalAction,
  getOperationProposalAction,
  listOperationProposalsAction,
  reproposeOperationAction,
  resolveUncertainProposalAction,
  restoreProposalSourceAction,
  withdrawOperationProposalAction,
} from "@/actions/operationProposal.actions";

type Key =
  | "approve" | "pending" | "expires" | "queued" | "running" | "cancelling"
  | "succeeded" | "failed" | "uncertain" | "cancelled" | "expired"
  | "rejected" | "withdrawn" | "superseded" | "unverified"
  | "sourceArchived" | "sourceDeleted" | "restoreSource" | "withdraw"
  | "repropose" | "verifyHappened" | "verifyNotHappened"
  | "verifyStillUncertain" | "manualResolvedBy" | "pendingEntry"
  | "verifyEntry" | "viewAll" | "dispatched" | "approved" | "loadFailed";

// States that can still change on the server side — keep polling until the
// derived state leaves this set. Terminal states never schedule another tick.
const WATCH = new Set([
  "pending",
  "queued",
  "running",
  "cancelling",
  "uncertain",
  "unverified",
]);
const POLL_MS = 2500;

function useT() {
  const { t } = useI18n();
  return useCallback(
    (k: Key, vars?: Record<string, string | number>) =>
      t(`agentProposal.${k}`, vars),
    [t],
  );
}

type ActionRes = {
  success: boolean;
  message?: string;
  code?: string;
  data?: unknown;
};

function asDto(value: unknown): AgentOperationProposalDTO | null {
  return value && typeof value === "object" && "id" in value
    ? (value as AgentOperationProposalDTO)
    : null;
}

/**
 * Hydrates one durable proposal by approvalId / proposalId and renders its
 * full lifecycle. Read-only on mount; polling stops on terminal/error.
 * Never writes to Notion — decisions go through the proposal actions.
 */
export function AgentProposalStatus({
  approvalId,
  proposalId,
}: {
  approvalId?: string;
  proposalId?: string;
}) {
  const t = useT();
  const [dto, setDto] = useState<AgentOperationProposalDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshEpoch, refresh] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The card follows the proposal it currently shows — after a re-proposal
  // swaps the view onto the new row, refreshes keep tracking that row.
  const currentId = useRef<string | undefined>(undefined);

  const load = useCallback(async () => {
    const res = await getOperationProposalAction({
      approvalId,
      proposalId: currentId.current ?? proposalId,
    });
    if (res.success) {
      const next = res.data as AgentOperationProposalDTO;
      setDto(next);
      setFailed(false);
      return next;
    }
    setFailed(true);
    return null;
  }, [approvalId, proposalId]);

  useEffect(() => {
    let dead = false;
    const schedule = (next: AgentOperationProposalDTO | null) => {
      if (dead) return;
      if (next && WATCH.has(next.derived)) {
        timer.current = setTimeout(tick, POLL_MS);
      }
    };
    const tick = async () => {
      const next = await load();
      if (dead) return;
      schedule(next);
    };
    void tick();
    return () => {
      dead = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, refreshEpoch]);

  if (failed) {
    return <p className="mt-1 text-xs text-destructive">{t("loadFailed")}</p>;
  }
  if (!dto) return null;

  // Every action result is consumed: failures render inline, a re-proposal
  // swaps the card onto the returned new proposal, successes refresh state.
  const act = async (p: Promise<ActionRes>) => {
    const res = await p;
    if (!res?.success) {
      setActionError(res?.message ?? t("loadFailed"));
      return;
    }
    setActionError(null);
    const data = res.data as { proposal?: unknown } | undefined;
    const next = asDto(data?.proposal) ?? asDto(res.data);
    if (next) {
      currentId.current = next.id;
      setDto(next);
    }
    // A terminal card has stopped its timer. A successful mutation (in
    // particular re-proposal) must restart observation of the new state.
    refresh((value) => value + 1);
  };
  const expires = new Date(dto.expiresAt).toLocaleString();
  const attestable =
    (dto.derived === "uncertain" || dto.derived === "unverified") &&
    !dto.manualResolution;
  const reproposable =
    dto.derived === "expired" ||
    dto.derived === "failed" ||
    ((dto.derived === "uncertain" || dto.derived === "unverified") &&
      !!dto.manualResolution);

  return (
    <div className="mt-2 rounded-sm border bg-muted/20 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            ["failed", "rejected", "expired", "uncertain", "unverified"].includes(
              dto.derived,
            )
              ? "destructive"
              : "secondary"
          }
        >
          {t(dto.derived as Key)}
        </Badge>
        {dto.derived === "pending" && <span>{t("expires", { date: expires })}</span>}
        {dto.derived === "queued" && dto.dispatched && <span>{t("dispatched")}</span>}
      </div>

      {actionError && (
        <p className="mt-1 text-destructive">{actionError}</p>
      )}

      {dto.sourceArchived && dto.derived === "pending" && (
        <div className="mt-1 flex items-center gap-2">
          <span>{t("sourceArchived")}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!dto.conversationId}
            onClick={() =>
              dto.conversationId &&
              void act(
                restoreProposalSourceAction({
                  conversationId: dto.conversationId,
                }),
              )
            }
          >
            {t("restoreSource")}
          </Button>
        </div>
      )}
      {dto.conversationId === null && (
        <p className="mt-1 text-muted-foreground">{t("sourceDeleted")}</p>
      )}

      {dto.derived === "pending" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() =>
              void act(
                decideOperationProposalAction({
                  proposalId: dto.id,
                  decision: "approve",
                }),
              )
            }
            disabled={dto.sourceArchived}
          >
            {t("approve")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void act(
                decideOperationProposalAction({
                  proposalId: dto.id,
                  decision: "reject",
                }),
              )
            }
          >
            {t("rejected")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act(withdrawOperationProposalAction({ proposalId: dto.id }))
            }
          >
            {t("withdraw")}
          </Button>
        </div>
      )}

      {attestable && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void act(
                resolveUncertainProposalAction({
                  proposalId: dto.id,
                  resolution: "HAPPENED",
                }),
              )
            }
          >
            {t("verifyHappened")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void act(
                resolveUncertainProposalAction({
                  proposalId: dto.id,
                  resolution: "NOT_HAPPENED",
                }),
              )
            }
          >
            {t("verifyNotHappened")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act(
                resolveUncertainProposalAction({
                  proposalId: dto.id,
                  resolution: "STILL_UNCERTAIN",
                }),
              )
            }
          >
            {t("verifyStillUncertain")}
          </Button>
        </div>
      )}

      {reproposable && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void act(reproposeOperationAction({ proposalId: dto.id }))
            }
          >
            {t("repropose")}
          </Button>
        </div>
      )}

      {dto.manualResolution && (
        <p className="mt-1 text-muted-foreground">
          {t("manualResolvedBy", { by: "you", at: dto.decidedAt ?? "" })}
        </p>
      )}
    </div>
  );
}

/** Minimal pending/attention strip — not a global approval center. */
export function AgentProposalEntry() {
  const t = useT();
  const [rows, setRows] = useState<AgentOperationProposalDTO[] | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let dead = false;
    const tick = async () => {
      const res = await listOperationProposalsAction();
      if (dead) return;
      if (!res.success) return;
      const list = res.data as AgentOperationProposalDTO[];
      setRows(list);
      if (list.some((r) => WATCH.has(r.derived))) {
        timer.current = setTimeout(tick, POLL_MS * 2);
      }
    };
    void tick();
    return () => {
      dead = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!rows || rows.length === 0) return null;
  const pending = rows.filter((r) => r.derived === "pending").length;
  const verify = rows.filter(
    (r) => r.derived === "uncertain" || r.derived === "unverified",
  ).length;

  return (
    <div className="border-b px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {pending > 0 && (
          <Badge variant="secondary">{t("pendingEntry", { count: pending })}</Badge>
        )}
        {verify > 0 && (
          <Badge variant="destructive">{t("verifyEntry", { count: verify })}</Badge>
        )}
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {t("viewAll")}
        </Button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-sm border p-2">
              <div className="font-medium">{r.toolName}</div>
              {r.target && (
                <div className="text-muted-foreground">{r.target}</div>
              )}
              <AgentProposalStatus proposalId={r.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
