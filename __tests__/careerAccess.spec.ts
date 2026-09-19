// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  CAREER_RUNTIME_MODE,
  activateFreshAbNative,
  assertCareerDataCopyable,
  assertCareerDataReadable,
  assertCareerDataWritable,
  canCopyCareerData,
  canReadCareerData,
  canWriteCareerData,
} from "@/lib/career";
import { CandidateProfileService } from "@/lib/career/candidateProfileService";
import { CareerMaterialService } from "@/lib/career/careerMaterialService";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };
const FEATURE_OFF = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "false" };
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `career-access-${Date.now()}-${Math.random()}@example.com`);
});

describe("career domain access guard matrix", () => {
  it("READ allows in AB_ENABLED with resume_v1 or full scope", () => {
    expect(canReadCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "full")).toBe(true);
    expect(canReadCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "resume_v1")).toBe(
      true,
    );
    expect(canReadCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "none")).toBe(false);
    expect(canReadCareerData(CAREER_RUNTIME_MODE.AB_ENABLED)).toBe(false);
  });
  it("READ denies in AB_READY_DISABLED", () => {
    expect(canReadCareerData(CAREER_RUNTIME_MODE.AB_READY_DISABLED)).toBe(false);
  });
  it("READ denies in LEGACY_ONLY", () => {
    expect(canReadCareerData(CAREER_RUNTIME_MODE.LEGACY_ONLY)).toBe(false);
  });
  it("WRITE allows in AB_ENABLED with resume_v1 or full scope", () => {
    expect(canWriteCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "full")).toBe(true);
    expect(canWriteCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "resume_v1")).toBe(
      true,
    );
    expect(canWriteCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "none")).toBe(false);
  });
  it("WRITE denies in AB_READY_DISABLED", () => {
    expect(canWriteCareerData(CAREER_RUNTIME_MODE.AB_READY_DISABLED)).toBe(false);
  });
  it("WRITE denies in LEGACY_ONLY", () => {
    expect(canWriteCareerData(CAREER_RUNTIME_MODE.LEGACY_ONLY)).toBe(false);
  });
  it("COPY allows in AB_ENABLED with resume_v1 or full scope", () => {
    expect(canCopyCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "full")).toBe(true);
    expect(canCopyCareerData(CAREER_RUNTIME_MODE.AB_ENABLED, "resume_v1")).toBe(
      true,
    );
  });
  it("COPY denies in AB_READY_DISABLED", () => {
    expect(canCopyCareerData(CAREER_RUNTIME_MODE.AB_READY_DISABLED)).toBe(false);
  });
  it("COPY denies in LEGACY_ONLY", () => {
    expect(canCopyCareerData(CAREER_RUNTIME_MODE.LEGACY_ONLY)).toBe(false);
  });

  it("assert readable/writable/copyable resolve AB_ENABLED", async () => {
    await activateFreshAbNative(prisma);
    await expect(assertCareerDataReadable(prisma, FEATURE_ON)).resolves.toBe(
      CAREER_RUNTIME_MODE.AB_ENABLED,
    );
    await expect(assertCareerDataWritable(prisma, FEATURE_ON)).resolves.toBe(
      CAREER_RUNTIME_MODE.AB_ENABLED,
    );
    await expect(assertCareerDataCopyable(prisma, FEATURE_ON)).resolves.toBe(
      CAREER_RUNTIME_MODE.AB_ENABLED,
    );
  });

  it("assert denies READ/COPY/WRITE in AB_READY_DISABLED without returning data", async () => {
    await activateFreshAbNative(prisma);
    await expect(assertCareerDataReadable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_READ_NOT_ENABLED",
    });
    await expect(assertCareerDataWritable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_WRITE_NOT_ENABLED",
    });
    await expect(assertCareerDataCopyable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_READ_NOT_ENABLED",
    });
  });

  it("assert denies READ/COPY/WRITE in LEGACY_ONLY without returning data", async () => {
    // No migration state -> LEGACY_ONLY.
    await expect(assertCareerDataReadable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_READ_NOT_ENABLED",
    });
    await expect(assertCareerDataWritable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_WRITE_NOT_ENABLED",
    });
    await expect(assertCareerDataCopyable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_READ_NOT_ENABLED",
    });
  });
});

describe("mode downgrade preserves B-side rows", () => {
  it("AB_ENABLED -> AB_READY_DISABLED hides via guard, rows remain, re-enable restores same values", async () => {
    await activateFreshAbNative(prisma);
    const profileSvc = new CandidateProfileService(prisma as never, userId, FEATURE_ON);
    const materialSvc = new CareerMaterialService(prisma as never, userId, FEATURE_ON);

    await profileSvc.upsertCandidateProfile(userId, {
      fullName: "Downgrade Fixture",
      email: "downgrade@example.com",
    });
    const created = await materialSvc.create({
      type: "EDUCATION",
      title: "Fixture University",
      detail: { institution: "Fixture University", degree: "Bachelor" },
    });

    // Sanity: readable while enabled.
    await expect(assertCareerDataReadable(prisma, FEATURE_ON)).resolves.toBe(
      CAREER_RUNTIME_MODE.AB_ENABLED,
    );
    const visibleProfile = await prisma.candidateProfile.findUnique({ where: { userId } });
    expect(visibleProfile?.fullName).toBe("Downgrade Fixture");

    // Downgrade: same DB, feature off -> AB_READY_DISABLED, guard denies.
    await expect(assertCareerDataReadable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_READ_NOT_ENABLED",
    });
    await expect(assertCareerDataWritable(prisma, FEATURE_OFF)).rejects.toMatchObject({
      code: "CAREER_WRITE_NOT_ENABLED",
    });

    // Rows must remain (no DELETE / MERGE / SYNC).
    expect(await prisma.candidateProfile.count({ where: { userId } })).toBe(1);
    expect(await prisma.careerMaterialItem.count({ where: { userId } })).toBe(1);
    expect(
      await prisma.careerMaterialItem.findUnique({ where: { id: created.id } }),
    ).not.toBeNull();

    // Re-enable: same values return.
    await expect(assertCareerDataReadable(prisma, FEATURE_ON)).resolves.toBe(
      CAREER_RUNTIME_MODE.AB_ENABLED,
    );
    const restored = await prisma.candidateProfile.findUniqueOrThrow({ where: { userId } });
    expect(restored.fullName).toBe("Downgrade Fixture");
    expect(restored.email).toBe("downgrade@example.com");
    const restoredMaterial = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(restoredMaterial.title).toBe("Fixture University");
  }, 60_000);
});
