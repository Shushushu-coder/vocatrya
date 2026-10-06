import "server-only";
import type { Prisma } from "@prisma/client";
import MarkdownIt from "markdown-it";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildCoverLetterTitle } from "@/lib/coverLetterTitle";

export async function saveMatchInTransaction(tx: Prisma.TransactionClient, userId: string, jobId: string, matchScore: number, matchData: string) {
  await assertLegacyCareerWriteAllowed(tx);
  await tx.job.update({ where: { id: jobId, userId }, data: { matchScore, matchData } });
}

export async function saveCoverLetterInTransaction(tx: Prisma.TransactionClient, userId: string, jobId: string, content: string, markdown: string) {
  await assertLegacyCareerWriteAllowed(tx);
  if (markdown.trim().length < APP_CONSTANTS.MIN_COVER_LETTER_CHARS) throw new Error("Generated cover letter was too short to save.");
  const job = await tx.job.findUnique({ where: { id: jobId, userId }, include: { JobTitle: true, Company: true } });
  if (!job) throw new Error("Job not found");
  const profile = await tx.profile.findFirst({ where: { userId } });
  if (!profile) throw new Error("No profile found for this user.");
  const existing = await tx.coverLetter.findMany({ where: { profile: { userId } }, select: { title: true } });
  const title = buildCoverLetterTitle(job.JobTitle?.label ?? "Cover Letter", job.Company?.label ?? "", existing.map(l => l.title));
  const letter = await tx.coverLetter.create({ data: { profileId: profile.id, title, content } });
  await tx.job.update({ where: { id: jobId, userId }, data: { coverLetterId: letter.id } });
  return { id: letter.id, title: letter.title };
}

// Rendering precedes the short DB transaction.
export function renderCoverLetterContent(markdown: string) {
  return new MarkdownIt({ html: false, linkify: false, breaks: true }).render(markdown);
}
