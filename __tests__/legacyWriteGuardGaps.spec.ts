import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeDiscoveredJob } from "@/actions/automation/analyze";
import { addNote, updateNote, deleteNote } from "@/actions/note.actions";
import { createJobFromNames } from "@/lib/jobs/createJobFromNames";
import { updateJobFromNames } from "@/lib/jobs/updateJobFromNames";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import * as writeGuard from "@/lib/career/writeGuard";
import { CareerRuntimeError } from "@/lib/career/errors";
import type { CareerRuntimeMode } from "@/lib/career/identities";
import type { AbRolloutScope } from "@/lib/career/rolloutScope";
import {
  CAREER_DATA_ORIGIN,
  type CareerDataOrigin,
} from "@/lib/career/runtimeMode";

// No Prisma client is instantiated. Real resolvers and the real write guard
// run against delegates below; runtime/scope and both provider paths are mocked.
const mocks = vi.hoisted(() => {
  const entity = () => ({
    findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(),
  });
  return {
    mode: "LEGACY_ONLY" as CareerRuntimeMode,
    scope: "none" as AbRolloutScope,
    origin: undefined as CareerDataOrigin | undefined,
    db: {
      company: entity(), jobTitle: entity(), location: entity(),
      jobSource: entity(), tag: entity(),
      jobStatus: { findUnique: vi.fn() },
      job: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
      note: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      jobOpportunity: { findFirst: vi.fn() },
      jobOpportunityNote: {
        findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
      },
      userSettings: { findUnique: vi.fn() },
    },
    generate: vi.fn(), execute: vi.fn(), assignment: vi.fn(), model: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({ default: mocks.db }));
vi.mock("@/actions/shared", () => ({ requireUser: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/career/runtimeMode", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/career/runtimeMode")>();
  return {
    ...actual,
    resolveCareerRuntimeMode: async () => ({
      mode: mocks.mode,
      reason: "test-runtime",
      writeFamily: actual.careerWriteFamilyFor(mocks.mode),
      rolloutScope: mocks.scope,
      origin: mocks.origin ?? actual.CAREER_DATA_ORIGIN.legacy,
    }),
  };
});
vi.mock("@/lib/career/rolloutScope", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/career/rolloutScope")>(),
  resolveAbRolloutScope: () => mocks.scope,
}));
vi.mock("ai", () => ({ generateText: mocks.generate }));
vi.mock("@/lib/ai", () => ({
  getModel: mocks.model,
  parseJobMatch: () => ({ scores: { matchScore: 82, recommendation: "apply" }, body: "analysis" }),
  JOB_MATCH_SYSTEM_PROMPT: "system",
  buildJobMatchPrompt: () => "prompt",
  preprocessResume: async () => ({ success: true, data: { normalizedText: "resume" } }),
  preprocessJob: async () => ({ success: true, data: { normalizedText: "job" } }),
}));
vi.mock("@/actions/profile.actions", () => ({
  getResumeById: async () => ({ data: { title: "Resume" } }),
}));
vi.mock("@/actions/job.actions", () => ({ getJobDetails: async () => ({ job: {} }) }));
vi.mock("@/lib/ai/assignments", () => ({ resolveBusinessAIConfig: mocks.assignment }));
vi.mock("@/lib/ai/execution", () => ({ executeAIConnectionText: mocks.execute }));
vi.mock("@/lib/automation-logger", () => ({ automationLogger: { isRunning: () => false } }));
vi.mock("@/lib/telemetry", () => ({
  genAiRequestAttrs: () => ({}), genAiResponseAttrs: () => ({}), inputSizeAttrs: () => ({}),
  SURFACES: { JOB_MATCH: "job-match" },
  withSpan: async (_name: string, _attrs: unknown, fn: (span: object) => unknown) =>
    fn({ setAttrs: vi.fn() }),
}));

const references = [mocks.db.company, mocks.db.jobTitle, mocks.db.location, mocks.db.jobSource, mocks.db.tag];
const input = {
  company: "Acme", jobTitle: "Engineer", location: "Remote", source: "Board",
  tags: ["TypeScript"], jobDescription: "Build things", allowDuplicate: true,
};
const note = { id: "note-1", jobId: "job-1", content: "hello" };
const noteActions = [
  { operation: "create" as const, call: () => addNote(note) },
  { operation: "update" as const, call: () => updateNote(note) },
  { operation: "delete" as const, call: () => deleteNote(note.id) },
];
type RuntimeState = {
  mode: CareerRuntimeMode;
  scope: AbRolloutScope;
  origin: CareerDataOrigin;
};
const allowed: RuntimeState[] = [
  { mode: "LEGACY_ONLY", scope: "none", origin: CAREER_DATA_ORIGIN.legacy },
  { mode: "AB_ENABLED", scope: "none", origin: CAREER_DATA_ORIGIN.migrated },
  {
    mode: "AB_ENABLED",
    scope: "resume_v1",
    origin: CAREER_DATA_ORIGIN.migrated,
  },
];
const blocked: RuntimeState[] = [
  { mode: "BLOCKED", scope: "none", origin: CAREER_DATA_ORIGIN.unknown },
  {
    mode: "AB_READY_DISABLED",
    scope: "none",
    origin: CAREER_DATA_ORIGIN.migrated,
  },
  { mode: "AB_ENABLED", scope: "full", origin: CAREER_DATA_ORIGIN.migrated },
  { mode: "AB_ENABLED", scope: "full", origin: CAREER_DATA_ORIGIN.fresh },
  {
    mode: "AB_ENABLED",
    scope: "resume_v1",
    origin: CAREER_DATA_ORIGIN.fresh,
  },
  {
    mode: "AB_READY_DISABLED",
    scope: "none",
    origin: CAREER_DATA_ORIGIN.fresh,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode = "LEGACY_ONLY";
  mocks.scope = "none";
  mocks.origin = CAREER_DATA_ORIGIN.legacy;
  vi.spyOn(console, "error").mockImplementation(() => {});
  references.forEach((delegate, i) => {
    delegate.findUnique.mockResolvedValue(null);
    delegate.create.mockImplementation(async ({ data }) => ({ ...data, id: `ref-${i}` }));
  });
  mocks.db.jobStatus.findUnique.mockResolvedValue({ id: "status-1" });
  mocks.db.job.findFirst.mockResolvedValue({
    id: "job-1", automationId: "automation-1", automation: { resumeId: "resume-1" },
    matchData: '{"kept":true}', descriptionCompleteness: "title-only",
  });
  mocks.db.job.create.mockResolvedValue({ id: "job-1" });
  mocks.db.userSettings.findUnique.mockResolvedValue(null);
  mocks.db.note.create.mockResolvedValue(note);
  mocks.db.note.update.mockResolvedValue(note);
  mocks.assignment.mockResolvedValue({ status: "UNASSIGNED" });
  mocks.generate.mockResolvedValue({ text: "match" });
  mocks.execute.mockResolvedValue({ text: "match" });
});

afterEach(() => vi.restoreAllMocks());

describe.each(blocked)(
  "blocked writes: $origin/$mode/$scope",
  ({ mode, scope, origin }) => {
  beforeEach(() => {
    mocks.mode = mode;
    mocks.scope = scope;
    mocks.origin = origin;
  });

  it("returns the guard message before either provider path or a Job write", async () => {
    const error = await assertLegacyCareerWriteAllowed(mocks.db).catch((err: Error) => err);
    expect(await analyzeDiscoveredJob("job-1")).toEqual({ success: false, message: (error as Error).message });
    expect(mocks.assignment).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.db.job.update).not.toHaveBeenCalled();
  });

  if (mode === "BLOCKED") {
    it.each(noteActions)("blocks legacy note $operation with the guard message", async ({ call }) => {
      const error = await assertLegacyCareerWriteAllowed(mocks.db).catch((err: Error) => err);
      expect(await call()).toEqual({ success: false, message: (error as Error).message });
      Object.values(mocks.db.note).forEach((write) => expect(write).not.toHaveBeenCalled());
    });
  }

  it.each(["create", "update"])("blocks %s before any reference create/upsert or Job write", async (operation) => {
    const error = await assertLegacyCareerWriteAllowed(mocks.db).catch((err: Error) => err);
    const call = operation === "create"
      ? createJobFromNames(input, "user-1")
      : updateJobFromNames({ ...input, jobId: "job-1" }, "user-1");
    await expect(call).rejects.toEqual(error);
    references.forEach((delegate) => {
      expect(delegate.findUnique).not.toHaveBeenCalled();
      expect(delegate.create).not.toHaveBeenCalled();
      expect(delegate.upsert).not.toHaveBeenCalled();
    });
    expect(mocks.db.job.create).not.toHaveBeenCalled();
    expect(mocks.db.job.update).not.toHaveBeenCalled();
  });
});

describe.each(allowed)(
  "allowed writes: $origin/$mode/$scope",
  ({ mode, scope, origin }) => {
  beforeEach(() => {
    mocks.mode = mode;
    mocks.scope = scope;
    mocks.origin = origin;
  });

  it.each(noteActions)("surfaces a guard rejection before legacy note $operation", async ({ call }) => {
    const error = new CareerRuntimeError("LEGACY_WRITE_BLOCKED", "blocked by guard");
    const guard = vi.spyOn(writeGuard, "assertLegacyCareerWriteAllowed").mockRejectedValueOnce(error);
    expect(await call()).toEqual({ success: false, message: error.message });
    expect(guard).toHaveBeenCalledWith(mocks.db);
    Object.values(mocks.db.note).forEach((write) => expect(write).not.toHaveBeenCalled());
  });

  it.each(["legacy", "account"])("preserves %s analysis and saved match data", async (provider) => {
    if (provider === "account") mocks.assignment.mockResolvedValue({
      status: "RESOLVED", backendKind: "test", provider: "test", model: "model", connectionId: "conn-1",
    });
    expect(await analyzeDiscoveredJob("job-1")).toEqual({ success: true, matchScore: 82 });
    expect(provider === "account" ? mocks.execute : mocks.generate).toHaveBeenCalledOnce();
    const args = mocks.db.job.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: "job-1", userId: "user-1" });
    expect(args.data.matchScore).toBe(82);
    expect(JSON.parse(args.data.matchData)).toMatchObject({
      kept: true, analyzed: true, matchScore: 82, body: "analysis", resumeId: "resume-1", resumeTitle: "Resume",
    });
  });

  it.each(noteActions)("preserves legacy note $operation", async ({ call, operation }) => {
    expect(await call()).toEqual(operation === "delete" ? { success: true } : { success: true, data: note });
    expect(mocks.db.note[operation]).toHaveBeenCalledOnce();
    expect(mocks.db.note[operation].mock.calls[0][0]).toEqual(operation === "create"
      ? { data: { jobId: "job-1", userId: "user-1", content: "hello" } }
      : operation === "update"
        ? { where: { id: "note-1", userId: "user-1" }, data: { content: "hello" } }
        : { where: { id: "note-1", userId: "user-1" } });
  });

  it.each(["create", "update"])("preserves %s reference resolution and Job write", async (operation) => {
    const result = operation === "create"
      ? await createJobFromNames(input, "user-1")
      : await updateJobFromNames({ ...input, jobId: "job-1" }, "user-1");
    expect(result).toMatchObject(operation === "create" ? { created: true, jobId: "job-1" } : { updated: true, jobId: "job-1" });
    references.forEach((delegate) => expect(delegate.create).toHaveBeenCalledOnce());
    const args = (operation === "create" ? mocks.db.job.create : mocks.db.job.update).mock.calls[0][0];
    expect(args.data).toMatchObject({
      companyId: "ref-0", jobTitleId: "ref-1", locationId: "ref-2", jobSourceId: "ref-3", description: "<p>Build things</p>\n",
    });
  });
});

it.each(noteActions)("preserves disabled A+B note $operation rejection", async ({ call }) => {
  mocks.mode = "AB_READY_DISABLED";
  mocks.origin = CAREER_DATA_ORIGIN.migrated;
  expect(await call()).toEqual({
    success: false, message: "Career profile and application editing is not enabled for this app yet. Changes to jobs and resumes through the previous version's editors are also unavailable.",
  });
  Object.values(mocks.db.note).forEach((write) => expect(write).not.toHaveBeenCalled());
  [mocks.db.jobOpportunityNote.create, mocks.db.jobOpportunityNote.update, mocks.db.jobOpportunityNote.delete]
    .forEach((write) => expect(write).not.toHaveBeenCalled());
});

it.each(noteActions)("keeps full A+B note $operation on its existing branch", async ({ call, operation }) => {
  mocks.mode = "AB_ENABLED";
  mocks.scope = "full";
  mocks.origin = CAREER_DATA_ORIGIN.migrated;
  mocks.db.jobOpportunity.findFirst.mockResolvedValue({ id: "job-1" });
  mocks.db.jobOpportunityNote.findFirst.mockResolvedValue({ id: "note-1" });
  mocks.db.jobOpportunityNote.create.mockResolvedValue({ ...note, jobOpportunityId: "job-1" });
  mocks.db.jobOpportunityNote.update.mockResolvedValue({ ...note, jobOpportunityId: "job-1" });
  expect(await call()).toMatchObject({ success: true });
  expect(mocks.db.jobOpportunityNote[operation]).toHaveBeenCalledOnce();
  Object.values(mocks.db.note).forEach((write) => expect(write).not.toHaveBeenCalled());
});
