import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import type { AgentTaskHandoffState } from "@/models/agentTask.schema";
import { estimateContextTokens } from "../contextBudget";
import { AGENT_TASK_EVENT_KIND, recordTaskEvent } from "./agentTaskEvents";
import { loadLatestHandoff } from "./agentTaskHandoffStore";
import { syncAgentTaskDerivation, type InterviewSprintFacts } from "./agentTaskMilestone";
import { getAgentTask, type AgentTaskDTO } from "./agentTaskStore";
import type { AgentTaskAcceptanceItem } from "./agentTaskTemplates";

/**
 * Grounding verifier (card C, spec section 9). Deterministic code: no model
 * call. It re-checks, against the database and scoped by userId, everything
 * a handoff note claims, derives milestone + checklist from domain state,
 * and renders the "Active task state" line a fresh session is given. The
 * handoff prose (what was done / what is next) is shown as the previous
 * session's note; every fact in the line (milestone, checklist, match
 * result, staleness) comes from the verified read, never from the note.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export type GroundingLocale = "zh-CN" | "en";

export type GroundingDiscrepancyCode =
  | "handoff_corrupt"
  | "hash_mismatch"
  | "pointer_missing"
  | "job_archived"
  | "job_closed"
  | "jd_version_mismatch"
  | "prep_goal_ended"
  | "analysis_stale"
  | "session_archived"
  | "milestone_drift"
  | "acceptance_revoked";

export interface GroundingDiscrepancy {
  code: GroundingDiscrepancyCode;
  /** Pointer key / acceptance key the finding is about, when applicable. */
  key?: string;
  /** Entity id; recorded in GROUNDING events, never rendered into the line. */
  id?: string;
}

export interface TaskGrounding {
  task: AgentTaskDTO;
  /** Derived from domain state (not the note). */
  milestone: string;
  acceptanceItems: AgentTaskAcceptanceItem[];
  facts: InterviewSprintFacts;
  handoffRevision: number | null;
  discrepancies: GroundingDiscrepancy[];
  /** The rendered, token-capped "Active task state" line. */
  verifiedLine: string;
}

function dedupe(items: GroundingDiscrepancy[]): GroundingDiscrepancy[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.code}|${item.key ?? ""}|${item.id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function statusDrift(
  db: Db,
  userId: string,
  state: AgentTaskHandoffState,
  missing: ReadonlySet<string>,
  fallbackJobId: string | null,
): Promise<GroundingDiscrepancy[]> {
  const out: GroundingDiscrepancy[] = [];
  const live = (ids: string[], key: string) =>
    ids.filter((id) => !missing.has(`${key}:${id}`));
  const work = state.completedWork;

  const jobIds = live(work.jobOpportunityIds, "jobOpportunityIds");
  if (jobIds.length) {
    const rows = await db.jobOpportunity.findMany({
      where: { id: { in: jobIds }, userId },
      select: { id: true, status: true, archivedAt: true },
    });
    for (const row of rows) {
      if (row.archivedAt) out.push({ code: "job_archived", key: "jobOpportunityIds", id: row.id });
      else if (row.status === "CLOSED" || row.status === "EXPIRED") {
        out.push({ code: "job_closed", key: "jobOpportunityIds", id: row.id });
      }
    }
  }

  const jdIds = live(work.jobDescriptionVersionIds, "jobDescriptionVersionIds");
  if (jdIds.length) {
    const allowedJobs = new Set([
      ...work.jobOpportunityIds,
      ...(fallbackJobId ? [fallbackJobId] : []),
    ]);
    const rows = await db.jobDescriptionVersion.findMany({
      where: { id: { in: jdIds }, jobOpportunity: { userId } },
      select: { id: true, jobOpportunityId: true },
    });
    for (const row of rows) {
      if (!allowedJobs.has(row.jobOpportunityId)) {
        out.push({ code: "jd_version_mismatch", key: "jobDescriptionVersionIds", id: row.id });
      }
    }
  }

  const goalIds = live(work.interviewPrepGoalIds, "interviewPrepGoalIds");
  if (goalIds.length) {
    const rows = await db.interviewPrepGoal.findMany({
      where: { id: { in: goalIds }, userId, status: "ENDED" },
      select: { id: true },
    });
    for (const row of rows) out.push({ code: "prep_goal_ended", key: "interviewPrepGoalIds", id: row.id });
  }

  const matchIds = live(work.matchAnalysisIds, "matchAnalysisIds");
  if (matchIds.length) {
    const rows = await db.matchAnalysis.findMany({
      where: { id: { in: matchIds }, userId },
      select: { id: true, status: true, isStale: true },
    });
    for (const row of rows) {
      if (row.status !== "COMPLETED" || row.isStale) {
        out.push({ code: "analysis_stale", key: "matchAnalysisIds", id: row.id });
      }
    }
  }

  const sessionIds = live(work.interviewSessionIds, "interviewSessionIds");
  if (sessionIds.length) {
    const rows = await db.interviewSession.findMany({
      where: {
        id: { in: sessionIds },
        userId,
        OR: [{ archivedAt: { not: null } }, { status: "ARCHIVED" }],
      },
      select: { id: true },
    });
    for (const row of rows) out.push({ code: "session_archived", key: "interviewSessionIds", id: row.id });
  }
  return out;
}

/* --------------------------------- rendering -------------------------------- */

const COPY = {
  "zh-CN": {
    header: (iso: string) => `Active task state (system-maintained, verified ${iso}):`,
    task: (title: string, milestone: string, blocked: string) =>
      `Task: ${title} · milestone=${milestone} · blocked=${blocked}`,
    blockedNo: "no",
    done: "Last session note",
    matchScore: (score: number) => `匹配分析 ${score} 分（已落库）`,
    matchVerdict: (verdict: string) => `岗位匹配筛选 ${verdict}（已落库）`,
    matchStale: "匹配分析已失效，需重跑 match_job",
    matchNone: "尚无岗位匹配分析",
    match: "Match",
    acceptance: "Acceptance",
    next: "Next",
    nextInitial: "按验收清单推进第一个未完成项（仅推进这一项）",
    constraints: "Constraints",
    discrepancies: "Grounding discrepancies",
    discrepancy: {
      handoff_corrupt: "上次便签无法读取，已忽略",
      hash_mismatch: "上次便签校验和不符，仅供参考",
      pointer_missing: (key: string) => `便签引用的 ${key} 已不存在（已移除）`,
      job_archived: "机会已归档",
      job_closed: "机会已关闭/过期",
      jd_version_mismatch: "便签中的 JD 版本不属于当前机会",
      prep_goal_ended: "面试准备目标已结束",
      analysis_stale: "匹配分析已失效，需重跑",
      session_archived: "有练习会话已归档",
      milestone_drift: (from: string, to: string) =>
        `便签称 milestone=${from}，实际 ${to}（已按实际修正）`,
      acceptance_revoked: (key: string) => `验收项 ${key} 便签称已通过，实际证据缺失（按未通过）`,
    },
  },
  en: {
    header: (iso: string) => `Active task state (system-maintained, verified ${iso}):`,
    task: (title: string, milestone: string, blocked: string) =>
      `Task: ${title} · milestone=${milestone} · blocked=${blocked}`,
    blockedNo: "no",
    done: "Last session note",
    matchScore: (score: number) => `match analysis score ${score} (saved)`,
    matchVerdict: (verdict: string) => `fit screening ${verdict} (saved)`,
    matchStale: "match analysis is STALE (invalidated) — re-run match_job",
    matchNone: "no match analysis yet",
    match: "Match",
    acceptance: "Acceptance",
    next: "Next",
    nextInitial: "advance the first unmet acceptance item (just that one)",
    constraints: "Constraints",
    discrepancies: "Grounding discrepancies",
    discrepancy: {
      handoff_corrupt: "the last handoff note was unreadable and is ignored",
      hash_mismatch: "the last handoff note failed its checksum; treat it as a hint only",
      pointer_missing: (key: string) => `the note referenced ${key} that no longer exists (removed)`,
      job_archived: "the opportunity is archived",
      job_closed: "the opportunity is closed/expired",
      jd_version_mismatch: "a JD version in the note does not belong to this opportunity",
      prep_goal_ended: "the interview prep goal has ended",
      analysis_stale: "match analysis is STALE (invalidated) — re-run",
      session_archived: "a practice session was archived",
      milestone_drift: (from: string, to: string) =>
        `note said milestone=${from}, actual ${to} (corrected to actual)`,
      acceptance_revoked: (key: string) =>
        `acceptance item ${key} was marked passed but its evidence is gone (treated as not passed)`,
    },
  },
} as const;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

function describeDiscrepancy(
  copy: (typeof COPY)[GroundingLocale],
  item: GroundingDiscrepancy,
  extra: { from?: string; to?: string },
): string {
  const table = copy.discrepancy;
  switch (item.code) {
    case "pointer_missing":
      return table.pointer_missing(item.key ?? "pointer");
    case "milestone_drift":
      return table.milestone_drift(extra.from ?? "?", extra.to ?? "?");
    case "acceptance_revoked":
      return table.acceptance_revoked(item.key ?? "?");
    default:
      return table[item.code];
  }
}

export function renderTaskStatusLine(input: {
  title: string;
  milestone: string;
  acceptanceItems: readonly AgentTaskAcceptanceItem[];
  facts: InterviewSprintFacts;
  state: AgentTaskHandoffState | null;
  discrepancies: readonly GroundingDiscrepancy[];
  noteMilestone?: string;
  verifiedAt: Date;
  locale?: GroundingLocale;
}): string {
  const copy = COPY[input.locale ?? "zh-CN"];
  const maxTokens = Math.floor(APP_CONSTANTS.AGENT_TASK_HANDOFF_TOKENS * 0.8);
  const state = input.state;
  const blocked = state?.blocking.isBlocked
    ? `yes(${state.blocking.reason ?? "?"}${state.blocking.requiredInputKey ? `:${state.blocking.requiredInputKey}` : ""})`
    : copy.blockedNo;

  const match = input.facts.latestMatch;
  const matchText = !match
    ? copy.matchNone
    : match.isStale
      ? copy.matchStale
      : match.score !== null
        ? copy.matchScore(match.score)
        : match.verdict
          ? copy.matchVerdict(match.verdict)
          : copy.matchNone;

  const acceptance = input.acceptanceItems
    .map((item) => `[${item.passes ? "x" : " "}] ${item.key}`)
    .join(" ");

  const build = (summaryMax: number, maxConstraints: number, nextMax: number): string => {
    const lines = [
      copy.header(input.verifiedAt.toISOString()),
      copy.task(oneLine(input.title, 120), input.milestone, blocked),
      `${copy.match}: ${matchText}`,
      `${copy.acceptance}: ${acceptance}`,
    ];
    if (state) {
      const summary = summaryMax > 0 ? oneLine(state.completedWork.summary, summaryMax) : "";
      if (summary) lines.push(`${copy.done} (unverified prose): ${summary}`);
      lines.push(`${copy.next}: ${oneLine(state.nextActions[0].action, nextMax)}`);
      const constraints = state.criticalConstraints.slice(0, maxConstraints);
      if (constraints.length) {
        lines.push(`${copy.constraints}: ${constraints.map((c) => oneLine(c, 200)).join("; ")}`);
      }
    } else {
      lines.push(`${copy.next}: ${copy.nextInitial}`);
    }
    if (input.discrepancies.length) {
      const text = input.discrepancies
        .map((item) =>
          describeDiscrepancy(copy, item, { from: input.noteMilestone, to: input.milestone }),
        )
        .join("; ");
      lines.push(`${copy.discrepancies}: ${oneLine(text, 600)}`);
    }
    return lines.join("\n");
  };

  // Shed the model-written prose first (summary, then constraints, then the
  // next-action text); the verified facts (milestone, checklist, match,
  // discrepancies) are fixed-size and always kept.
  const stages: Array<[number, number, number]> = [
    [APP_CONSTANTS.AGENT_TASK_HANDOFF_SUMMARY_MAX_CHARS, 10, 300],
    [750, 10, 300],
    [375, 5, 300],
    [180, 3, 200],
    [80, 2, 120],
    [0, 1, 120],
    [0, 0, 120],
  ];
  let line = "";
  for (const [summaryMax, maxConstraints, nextMax] of stages) {
    line = build(summaryMax, maxConstraints, nextMax);
    if (estimateContextTokens(line) <= maxTokens) break;
  }
  return line;
}

/* ---------------------------------- verifier -------------------------------- */

/**
 * Verify a task and build its status line. Re-derives and persists
 * milestone + checklist from domain state first, then audits the latest
 * handoff note against the database. `recordEvents` writes one GROUNDING
 * event per discrepancy (resume does; the per-turn read does not, so a
 * long session cannot flood the audit log).
 */
export async function verifyTaskGrounding(
  db: Db,
  input: {
    userId: string;
    taskId: string;
    locale?: GroundingLocale;
    now?: Date;
    recordEvents?: boolean;
  },
): Promise<TaskGrounding | null> {
  const task = await getAgentTask(db, { userId: input.userId, taskId: input.taskId });
  if (!task) return null;
  const synced = await syncAgentTaskDerivation(db, {
    userId: input.userId,
    taskId: input.taskId,
  });
  if (!synced) return null;

  const loaded = await loadLatestHandoff(db, {
    userId: input.userId,
    taskId: input.taskId,
    checkPointers: true,
  });
  const discrepancies: GroundingDiscrepancy[] = [];
  let state: AgentTaskHandoffState | null = null;
  let handoffRevision: number | null = null;

  if (loaded?.status === "corrupt") {
    discrepancies.push({ code: "handoff_corrupt" });
    handoffRevision = loaded.revision;
  } else if (loaded) {
    state = loaded.state;
    handoffRevision = loaded.revision;
    if (!loaded.hashMatches) discrepancies.push({ code: "hash_mismatch" });
    const missing = new Set<string>();
    for (const item of loaded.missingPointers ?? []) {
      missing.add(`${item.key}:${item.id}`);
      discrepancies.push({ code: "pointer_missing", key: item.key, id: item.id });
    }
    discrepancies.push(
      ...(await statusDrift(db, input.userId, loaded.state, missing, task.jobOpportunityId)),
    );
    if (loaded.state.milestone !== synced.milestone) {
      discrepancies.push({ code: "milestone_drift" });
    }
    const derivedPass = new Map(synced.acceptanceItems.map((item) => [item.key, item.passes]));
    for (const snap of loaded.state.acceptanceSnapshot) {
      if (snap.passes && derivedPass.get(snap.key) !== true) {
        discrepancies.push({ code: "acceptance_revoked", key: snap.key });
      }
    }
  }
  // The newest analysis may have gone stale after (or without) any note.
  if (synced.facts.latestMatch?.isStale) {
    discrepancies.push({
      code: "analysis_stale",
      key: "matchAnalysisIds",
      id: synced.facts.latestMatch.id,
    });
  }
  const unique = dedupe(discrepancies);

  const verifiedAt = input.now ?? new Date();
  const verifiedLine = renderTaskStatusLine({
    title: task.title,
    milestone: synced.milestone,
    acceptanceItems: synced.acceptanceItems,
    facts: synced.facts,
    state,
    discrepancies: unique,
    noteMilestone: state?.milestone,
    verifiedAt,
    locale: input.locale,
  });

  if (input.recordEvents && unique.length) {
    for (const item of unique) {
      try {
        await recordTaskEvent(db, {
          userId: input.userId,
          taskId: input.taskId,
          kind: AGENT_TASK_EVENT_KIND.GROUNDING,
          payload: {
            code: item.code,
            ...(item.key ? { key: item.key } : {}),
            ...(item.id ? { id: item.id } : {}),
            handoffRevision,
          },
        });
      } catch {
        // Audit is best-effort; the verified line is the product.
      }
    }
  }

  const fresh = (await getAgentTask(db, { userId: input.userId, taskId: input.taskId })) ?? task;
  return {
    task: fresh,
    milestone: synced.milestone,
    acceptanceItems: synced.acceptanceItems,
    facts: synced.facts,
    handoffRevision,
    discrepancies: unique,
    verifiedLine,
  };
}
