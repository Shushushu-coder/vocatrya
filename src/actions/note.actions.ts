"use server";
import prisma from "@/lib/db";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import { handleError } from "@/lib/utils";
import { NoteFormSchema } from "@/models/note.schema";
import { NoteResponse } from "@/models/note.model";
import { isAbJobReadMode } from "@/lib/career/jobsReadCapabilities";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { CareerRuntimeError } from "@/lib/career/errors";
import {
  CAREER_NOTES_UNAVAILABLE_MESSAGE,
  careerMutationDeniedMessage,
} from "@/lib/career/userMessages";
import {
  CAREER_DATA_ORIGIN,
  resolveCareerRuntimeMode,
  type CareerRuntimeResolution,
} from "@/lib/career/runtimeMode";
import { requireUser } from "./shared";
import { z } from "zod";

function isAbNoteSurface(runtime: CareerRuntimeResolution): boolean {
  return isAbJobReadMode(runtime.mode, runtime.rolloutScope);
}

function assertAbNoteWrites(runtime: CareerRuntimeResolution): void {
  if (isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) return;
  throw new CareerRuntimeError(
    "JOB_MUTATIONS_DISABLED",
    careerMutationDeniedMessage(runtime.mode),
  );
}

function assertFreshNotesDoNotUseLegacy(runtime: CareerRuntimeResolution): void {
  if (runtime.origin !== CAREER_DATA_ORIGIN.fresh) return;
  throw new CareerRuntimeError(
    "JOBS_READ_UNAVAILABLE",
    CAREER_NOTES_UNAVAILABLE_MESSAGE,
  );
}

export const getNotesByJobId = async (
  jobId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (isAbNoteSurface(runtime)) {
      const opportunity = await prisma.jobOpportunity.findFirst({
        where: { id: jobId, userId: user.id },
        select: { id: true },
      });
      if (!opportunity) {
        throw new Error("Job not found");
      }
      const notes = await prisma.jobOpportunityNote.findMany({
        where: { jobOpportunityId: jobId, userId: user.id },
        orderBy: { createdAt: "desc" },
      });
      const data: NoteResponse[] = notes.map((note) => ({
        id: note.id,
        jobId: note.jobOpportunityId,
        userId: note.userId,
        content: note.content,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        isEdited: note.updatedAt.getTime() - note.createdAt.getTime() > 1000,
      }));
      return { success: true, data };
    }

    assertFreshNotesDoNotUseLegacy(runtime);
    const job = await prisma.job.findFirst({
      where: { id: jobId, userId: user.id },
      select: { id: true },
    });
    if (!job) {
      throw new Error("Job not found");
    }

    const notes = await prisma.note.findMany({
      where: { jobId, userId: user.id },
      orderBy: { createdAt: "desc" },
    });

    const data: NoteResponse[] = notes.map((note) => ({
      ...note,
      isEdited: note.updatedAt.getTime() - note.createdAt.getTime() > 1000,
    }));

    return { success: true, data };
  } catch (error) {
    const msg = "Failed to fetch notes.";
    return handleError(error, msg);
  }
};

export const addNote = async (
  data: z.infer<typeof NoteFormSchema>
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const validated = NoteFormSchema.parse(data);
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (isAbNoteSurface(runtime)) {
      assertAbNoteWrites(runtime);
      const opportunity = await prisma.jobOpportunity.findFirst({
        where: { id: validated.jobId, userId: user.id },
        select: { id: true, archivedAt: true },
      });
      if (!opportunity) {
        throw new Error("Job not found");
      }
      if (opportunity.archivedAt) {
        throw new CareerRuntimeError(
          "OPPORTUNITY_ARCHIVED",
          "This job is archived. Restore it to edit.",
        );
      }
      const note = await prisma.jobOpportunityNote.create({
        data: {
          jobOpportunityId: validated.jobId,
          userId: user.id,
          content: validated.content,
        },
      });
      return { success: true, data: { ...note, jobId: note.jobOpportunityId } };
    }

    assertFreshNotesDoNotUseLegacy(runtime);
    const job = await prisma.job.findFirst({
      where: { id: validated.jobId, userId: user.id },
      select: { id: true },
    });
    if (!job) {
      throw new Error("Job not found");
    }

    await assertLegacyCareerWriteAllowed(prisma);
    const note = await prisma.note.create({
      data: {
        jobId: validated.jobId,
        userId: user.id,
        content: validated.content,
      },
    });

    return { success: true, data: note };
  } catch (error) {
    const msg = "Failed to add note.";
    return handleError(error, msg);
  }
};

export const updateNote = async (
  data: z.infer<typeof NoteFormSchema>
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const validated = NoteFormSchema.parse(data);
    if (!validated.id) {
      throw new Error("Note ID is required for update");
    }
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (isAbNoteSurface(runtime)) {
      assertAbNoteWrites(runtime);
      const existing = await prisma.jobOpportunityNote.findFirst({
        where: { id: validated.id, userId: user.id },
        select: { id: true, jobOpportunity: { select: { archivedAt: true } } },
      });
      if (!existing) {
        throw new Error("Note not found");
      }
      if (existing.jobOpportunity.archivedAt) {
        throw new CareerRuntimeError(
          "OPPORTUNITY_ARCHIVED",
          "This job is archived. Restore it to edit.",
        );
      }
      const note = await prisma.jobOpportunityNote.update({
        where: { id: existing.id },
        data: { content: validated.content },
      });
      return { success: true, data: { ...note, jobId: note.jobOpportunityId } };
    }

    assertFreshNotesDoNotUseLegacy(runtime);
    await assertLegacyCareerWriteAllowed(prisma);
    const note = await prisma.note.update({
      where: { id: validated.id, userId: user.id },
      data: { content: validated.content },
    });

    return { success: true, data: note };
  } catch (error) {
    const msg = "Failed to update note.";
    return handleError(error, msg);
  }
};

export const deleteNote = async (
  noteId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (isAbNoteSurface(runtime)) {
      assertAbNoteWrites(runtime);
      const existing = await prisma.jobOpportunityNote.findFirst({
        where: { id: noteId, userId: user.id },
        select: { id: true, jobOpportunity: { select: { archivedAt: true } } },
      });
      if (!existing) {
        throw new Error("Note not found");
      }
      if (existing.jobOpportunity.archivedAt) {
        throw new CareerRuntimeError(
          "OPPORTUNITY_ARCHIVED",
          "This job is archived. Restore it to edit.",
        );
      }
      await prisma.jobOpportunityNote.delete({
        where: { id: existing.id },
      });
      return { success: true };
    }

    assertFreshNotesDoNotUseLegacy(runtime);
    await assertLegacyCareerWriteAllowed(prisma);
    await prisma.note.delete({
      where: { id: noteId, userId: user.id },
    });

    return { success: true };
  } catch (error) {
    const msg = "Failed to delete note.";
    return handleError(error, msg);
  }
};
