import prisma from "@/lib/db";
import {
  listAbResumeChoices,
  readAbResumeVariant,
  resolveResumeReadFamily,
} from "@/lib/career/resumeReadDispatch";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import { resumeDetailInclude } from "@/lib/jobs/resumeDetailInclude";
import type { AgentResumeSource } from "@/models/agent.model";
import type { Resume } from "@/models/profile.model";

export type ResumeLookup =
  | { status: "ok"; resume: Resume; source: AgentResumeSource; ambiguousTitle: boolean }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" };

export type CanonicalResumeLookup =
  | (ResumeLookup & { family?: "legacy" })
  | {
      status: "ok";
      family: "ab";
      id: string;
      title: string;
      versionId: string | null;
      text: string;
      source: AgentResumeSource;
      ambiguousTitle: boolean;
    }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" }
  | { status: "unavailable"; reason: string };

// SQLite has no `mode: "insensitive"` in Prisma, so title matching happens
// in JS over this list. It is also exactly what the picker renders, so the
// query is not extra work.
async function listTitles(userId: string) {
  return prisma.resume.findMany({
    where: { profile: { userId } },
    select: { id: true, title: true },
    orderBy: { updatedAt: "desc" },
  });
}

async function load(
  userId: string,
  id: string,
  source: AgentResumeSource,
  ambiguousTitle = false,
): Promise<ResumeLookup | null> {
  const resume = await prisma.resume.findFirst({
    where: { id, profile: { userId } },
    include: resumeDetailInclude,
  });
  if (!resume) return null;
  // Prisma's generated shape is structurally what preprocessResume reads but
  // is not nominally profile.model's Resume — same cast as
  // getDefaultResumeForUser.
  return {
    status: "ok",
    resume: resume as unknown as Resume,
    source,
    ambiguousTitle,
  };
}

export async function resolveResumeForAgent(
  userId: string,
  opts: { title?: string; pageResumeId?: string },
): Promise<ResumeLookup> {
  const titles = await listTitles(userId);
  if (titles.length === 0) return { status: "no_resumes" };

  const wanted = opts.title?.trim().toLowerCase();
  if (wanted) {
    const exact = titles.filter((r) => r.title.toLowerCase() === wanted);
    // Duplicate titles resolve to the most recently updated rather than
    // asking again: the picker answers with a title, so a second question
    // would loop forever.
    const matches = exact.length > 0
      ? exact
      : titles.filter((r) => r.title.toLowerCase().includes(wanted));
    if (matches.length > 0) {
      const loaded = await load(userId, matches[0].id, "named", matches.length > 1);
      if (loaded) return loaded;
    }
    return { status: "needs_selection", resumes: titles };
  }

  // Ownership comes from the scoped listing above, never from the id itself
  // — pageContext is client-supplied.
  if (opts.pageResumeId && titles.some((r) => r.id === opts.pageResumeId)) {
    const loaded = await load(userId, opts.pageResumeId, "page");
    if (loaded) return loaded;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { defaultResumeId: true },
  });
  const defaultId = user?.defaultResumeId;
  if (defaultId && titles.some((r) => r.id === defaultId)) {
    const loaded = await load(userId, defaultId, "default");
    if (loaded) return loaded;
  }

  if (titles.length === 1) {
    const loaded = await load(userId, titles[0].id, "only");
    if (loaded) return loaded;
  }

  return { status: "needs_selection", resumes: titles };
}

export function selectAbResume(
  titles: { id: string; title: string }[],
  opts: { title?: string; pageResumeId?: string },
):
  | { status: "ok"; id: string; source: AgentResumeSource; ambiguousTitle: boolean }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" } {
  if (titles.length === 0) return { status: "no_resumes" };

  const wanted = opts.title?.trim().toLowerCase();
  if (wanted) {
    const exact = titles.filter((resume) => resume.title.toLowerCase() === wanted);
    const matches = exact.length > 0
      ? exact
      : titles.filter((resume) => resume.title.toLowerCase().includes(wanted));
    if (matches.length > 0) {
      return {
        status: "ok",
        id: matches[0].id,
        source: "named",
        ambiguousTitle: matches.length > 1,
      };
    }
    return { status: "needs_selection", resumes: titles };
  }

  if (opts.pageResumeId && titles.some((resume) => resume.id === opts.pageResumeId)) {
    return { status: "ok", id: opts.pageResumeId, source: "page", ambiguousTitle: false };
  }

  if (titles.length === 1) {
    return { status: "ok", id: titles[0].id, source: "only", ambiguousTitle: false };
  }

  return { status: "needs_selection", resumes: titles };
}

/**
 * Read path for get_resume and review_resume. Write tools keep
 * resolveResumeForAgent, which stays on the legacy Resume table.
 */
export async function resolveCanonicalResumeForAgent(
  userId: string,
  opts: { title?: string; pageResumeId?: string },
): Promise<CanonicalResumeLookup> {
  const resolved = await resolveResumeReadFamily(prisma);
  if (resolved.family === "blocked") {
    return {
      status: "unavailable",
      reason: CAREER_JOBS_UNAVAILABLE_MESSAGE,
    };
  }
  if (resolved.family === "legacy") {
    const lookup = await resolveResumeForAgent(userId, opts);
    if (lookup.status === "ok") return { ...lookup, family: "legacy" };
    return lookup;
  }

  const titles = await listAbResumeChoices(prisma, userId);
  const selected = selectAbResume(titles, opts);
  if (selected.status !== "ok") return selected;

  const resume = await readAbResumeVariant(prisma, userId, selected.id);
  if (!resume) return { status: "no_resumes" };
  return {
    status: "ok",
    family: "ab",
    id: resume.id,
    title: resume.title,
    versionId: resume.versionId,
    text: resume.text,
    source: selected.source,
    ambiguousTitle: selected.ambiguousTitle,
  };
}
