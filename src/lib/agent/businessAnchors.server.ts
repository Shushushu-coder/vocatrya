import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { resolveResumeReadFamily } from "@/lib/career/resumeReadDispatch";
import { readTodayPlan } from "@/lib/todayPlan/service";
import { estimateContextTokens } from "./contextBudget";
import type { AgentConversationContextV1 } from "./conversationContext";
import { CAREER_DIALOGUE_BUSINESS_ANCHOR_TOKENS } from "./modelContextWindow";

type Db = PrismaClient | Prisma.TransactionClient;

export type VerifiedJobAnchor = {
  title: string;
  company: string | null;
  status: string | null;
  jdVersionNumber: number | null;
  latestJdVersionNumber: number | null;
  hasDescription: boolean;
  jdUpdatedAt: string | null;
  newerVersionAvailable: boolean;
};

export type VerifiedResumeAnchor = {
  title: string;
  versionNumber: number | null;
  versionStatus: string | null;
  updatedAt: string | null;
};

export type VerifiedTodayPlanAnchor = {
  todayTotal: number;
  todayCompleted: number;
  overdueCount: number;
  tomorrowCount: number;
  openTitles: string[];
};

export type VerifiedBusinessAnchors = {
  job: VerifiedJobAnchor | null;
  resume: VerifiedResumeAnchor | null;
  todayPlan: VerifiedTodayPlanAnchor | null;
  excludedCount: number;
  renderedBlock: string;
};

function cleanLabel(value: string | null | undefined, max = 80): string {
  if (!value) return "";
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

function isoDate(value: Date | null | undefined): string | null {
  if (!value) return null;
  const time = value.getTime();
  return Number.isNaN(time) ? null : value.toISOString().slice(0, 10);
}

async function verifyJobItem(
  db: Db,
  userId: string,
  entityId: string,
  jobsFamily: "ab" | "legacy" | "blocked",
): Promise<VerifiedJobAnchor | null> {
  if (jobsFamily === "blocked") return null;
  if (jobsFamily === "ab") {
    const row = await db.jobOpportunity.findFirst({
      where: { id: entityId, userId, archivedAt: null },
      select: {
        title: true,
        status: true,
        updatedAt: true,
        company: { select: { label: true } },
        currentJdVersion: {
          select: { versionNumber: true, rawContent: true, capturedAt: true },
        },
        descriptionVersions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { versionNumber: true, rawContent: true, capturedAt: true },
        },
      },
    });
    if (!row) return null;
    const latestJd = row.descriptionVersions[0] ?? row.currentJdVersion ?? null;
    const currentJd = row.currentJdVersion ?? latestJd;
    const currentNum = currentJd?.versionNumber ?? null;
    const latestNum = latestJd?.versionNumber ?? currentNum;
    const newerVersionAvailable = Boolean(
      latestNum !== null && currentNum !== null && latestNum > currentNum,
    );
    return {
      title: cleanLabel(row.title) || "Job",
      company: cleanLabel(row.company?.label) || null,
      status: cleanLabel(row.status, 32) || null,
      jdVersionNumber: currentNum,
      latestJdVersionNumber: latestNum,
      hasDescription: Boolean(currentJd?.rawContent?.trim()),
      jdUpdatedAt: isoDate(latestJd?.capturedAt ?? row.updatedAt),
      newerVersionAvailable,
    };
  }

  const legacy = await db.job.findFirst({
    where: { id: entityId, userId },
    select: {
      description: true,
      createdAt: true,
      JobTitle: { select: { label: true } },
      Company: { select: { label: true } },
      Status: { select: { label: true, value: true } },
    },
  });
  if (!legacy || legacy.Status?.value === "archived") return null;
  return {
    title: cleanLabel(legacy.JobTitle?.label) || "Job",
    company: cleanLabel(legacy.Company?.label) || null,
    status: cleanLabel(legacy.Status?.label ?? legacy.Status?.value, 32) || null,
    jdVersionNumber: null,
    latestJdVersionNumber: null,
    hasDescription: Boolean(legacy.description?.trim()),
    jdUpdatedAt: isoDate(legacy.createdAt),
    newerVersionAvailable: false,
  };
}

async function verifyResumeItem(
  db: Db,
  userId: string,
  entityId: string,
  resumeFamily: "ab" | "legacy" | "blocked",
): Promise<VerifiedResumeAnchor | null> {
  if (resumeFamily === "blocked") return null;
  if (resumeFamily === "ab") {
    const row = await db.resumeVariant.findFirst({
      where: { id: entityId, userId, archivedAt: null },
      select: {
        name: true,
        updatedAt: true,
        currentVersion: {
          select: { versionNumber: true, status: true, createdAt: true },
        },
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { versionNumber: true, status: true, createdAt: true },
        },
      },
    });
    if (!row) return null;
    const version = row.currentVersion ?? row.versions[0] ?? null;
    const versionArchived = version?.status === "ARCHIVED";
    return {
      title: cleanLabel(row.name) || "Resume",
      versionNumber: versionArchived ? null : (version?.versionNumber ?? null),
      versionStatus: versionArchived ? null : cleanLabel(version?.status, 32) || null,
      updatedAt: isoDate(row.updatedAt),
    };
  }

  const legacy = await db.resume.findFirst({
    where: { id: entityId, profile: { userId } },
    select: { title: true, updatedAt: true },
  });
  if (!legacy) return null;
  return {
    title: cleanLabel(legacy.title) || "Resume",
    versionNumber: null,
    versionStatus: null,
    updatedAt: isoDate(legacy.updatedAt),
  };
}

export function renderVerifiedBusinessAnchors(input: {
  job: VerifiedJobAnchor | null;
  resume: VerifiedResumeAnchor | null;
  todayPlan: VerifiedTodayPlanAnchor | null;
  excludedCount: number;
  locale?: string;
  maxTokens?: number;
}): string {
  const { job, resume, todayPlan, excludedCount } = input;
  if (!job && !resume && !todayPlan && excludedCount === 0) return "";
  const isEn = input.locale === "en";
  const maxTokens = input.maxTokens ?? CAREER_DIALOGUE_BUSINESS_ANCHOR_TOKENS;

  const build = (titleLimit: number): string => {
    const lines: string[] = [
      isEn
        ? "Verified business anchors (live SQLite state, post-compaction):"
        : "已核验业务锚点（实时数据库状态，压缩后重挂）：",
    ];
    if (job) {
      const target = job.company ? `${job.title} · ${job.company}` : job.title;
      const jdState = isEn
        ? job.jdVersionNumber !== null
          ? `JD v${job.jdVersionNumber}${job.newerVersionAvailable && job.latestJdVersionNumber ? ` (latest v${job.latestJdVersionNumber})` : ""}${job.hasDescription ? "" : ", empty JD"}`
          : job.hasDescription
            ? "JD present"
            : "JD missing"
        : job.jdVersionNumber !== null
          ? `JD v${job.jdVersionNumber}${job.newerVersionAvailable && job.latestJdVersionNumber ? `（最新 v${job.latestJdVersionNumber}）` : ""}${job.hasDescription ? "" : "，暂无正文"}`
          : job.hasDescription
            ? "已有 JD 正文"
            : "暂无 JD 正文";
      const statusPart = job.status ? (isEn ? `, status ${job.status}` : `，状态 ${job.status}`) : "";
      lines.push(
        isEn
          ? `- Bound job: ${target}${statusPart}, ${jdState}${job.jdUpdatedAt ? `, updated ${job.jdUpdatedAt}` : ""}`
          : `- 绑定职位：${target}${statusPart}，${jdState}${job.jdUpdatedAt ? `，更新于 ${job.jdUpdatedAt}` : ""}`,
      );
    }
    if (resume) {
      const verPart =
        resume.versionNumber !== null
          ? isEn
            ? `v${resume.versionNumber}${resume.versionStatus ? ` (${resume.versionStatus})` : ""}`
            : `v${resume.versionNumber}${resume.versionStatus ? `（${resume.versionStatus}）` : ""}`
          : isEn
            ? "current version"
            : "当前版本";
      lines.push(
        isEn
          ? `- Bound resume: ${resume.title} (${verPart}${resume.updatedAt ? `, updated ${resume.updatedAt}` : ""})`
          : `- 绑定简历：${resume.title}（${verPart}${resume.updatedAt ? `，更新于 ${resume.updatedAt}` : ""}）`,
      );
    }
    if (todayPlan) {
      const openSlice = titleLimit > 0 ? todayPlan.openTitles.slice(0, titleLimit) : [];
      const openText = openSlice.length
        ? isEn
          ? `; open: ${openSlice.join("; ")}`
          : `；待完成：${openSlice.join("；")}`
        : "";
      lines.push(
        isEn
          ? `- Conversation checklist (today_plan): today ${todayPlan.todayCompleted}/${todayPlan.todayTotal} done, overdue ${todayPlan.overdueCount}, tomorrow ${todayPlan.tomorrowCount}${openText}`
          : `- 会话待办（today_plan）：今日已完成 ${todayPlan.todayCompleted}/${todayPlan.todayTotal}，逾期 ${todayPlan.overdueCount}，明日 ${todayPlan.tomorrowCount}${openText}`,
      );
    }
    if (excludedCount > 0) {
      lines.push(
        isEn
          ? `- Excluded references: ${excludedCount} linked record(s) archived, deleted, or inaccessible (excluded; do not guess from earlier turns).`
          : `- 已排除引用：${excludedCount} 项已归档、删除或无权访问（已排除，勿凭历史猜测）。`,
      );
    }
    return lines.join("\n");
  };

  for (const limit of [5, 2, 0]) {
    const candidate = build(limit);
    if (estimateContextTokens(candidate) <= maxTokens) return candidate;
  }
  return build(0);
}

/**
 * L3 real-time SQLite verification & re-injection after compaction.
 * Queries strictly by `userId` and persisted `entityId` — never matches by name.
 */
export async function resolveVerifiedBusinessAnchors(
  db: Db,
  input: {
    userId: string;
    conversationId: string;
    context: AgentConversationContextV1 | null | undefined;
    locale?: string;
    timeZone?: string;
    now?: Date;
    maxTokens?: number;
  },
): Promise<VerifiedBusinessAnchors> {
  const items = input.context?.items ?? [];
  const jobItems = items.filter((item) => item.kind === "job");
  const resumeItems = items.filter((item) => item.kind === "resume");

  let jobsFamily: "ab" | "legacy" | "blocked" = "blocked";
  let resumeFamily: "ab" | "legacy" | "blocked" = "blocked";
  if (jobItems.length > 0) {
    try {
      jobsFamily = (await resolveJobsReadFamily(db)).family;
    } catch {
      jobsFamily = "blocked";
    }
  }
  if (resumeItems.length > 0) {
    try {
      resumeFamily = (await resolveResumeReadFamily(db)).family;
    } catch {
      resumeFamily = "blocked";
    }
  }

  let excludedCount = 0;
  let verifiedJob: VerifiedJobAnchor | null = null;
  for (const item of jobItems) {
    try {
      const found = await verifyJobItem(db, input.userId, item.entityId, jobsFamily);
      if (!found) {
        excludedCount += 1;
      } else if (!verifiedJob) {
        verifiedJob = found;
      }
    } catch {
      excludedCount += 1;
    }
  }

  let verifiedResume: VerifiedResumeAnchor | null = null;
  for (const item of resumeItems) {
    try {
      const found = await verifyResumeItem(db, input.userId, item.entityId, resumeFamily);
      if (!found) {
        excludedCount += 1;
      } else if (!verifiedResume) {
        verifiedResume = found;
      }
    } catch {
      excludedCount += 1;
    }
  }

  let todayPlan: VerifiedTodayPlanAnchor | null = null;
  try {
    const view = await readTodayPlan(
      {
        userId: input.userId,
        conversationId: input.conversationId,
        timeZone: input.timeZone ?? "UTC",
        now: input.now,
      },
      db,
    );
    if (view) {
      const { today, tomorrow, overdue } = view.buckets;
      if (today.length + tomorrow.length + overdue.length > 0) {
        const openTitles = [...overdue, ...today]
          .filter((item) => !item.completed)
          .slice(0, 5)
          .map((item) => cleanLabel(item.title, 60))
          .filter(Boolean);
        todayPlan = {
          todayTotal: today.length,
          todayCompleted: today.filter((item) => item.completed).length,
          overdueCount: overdue.length,
          tomorrowCount: tomorrow.length,
          openTitles,
        };
      }
    }
  } catch {
    todayPlan = null;
  }

  const renderedBlock = renderVerifiedBusinessAnchors({
    job: verifiedJob,
    resume: verifiedResume,
    todayPlan,
    excludedCount,
    locale: input.locale,
    maxTokens: input.maxTokens,
  });

  return {
    job: verifiedJob,
    resume: verifiedResume,
    todayPlan,
    excludedCount,
    renderedBlock,
  };
}
