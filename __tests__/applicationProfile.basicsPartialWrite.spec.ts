// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
} from "@/lib/career/identities";
import { activateFreshAbNative } from "@/lib/career";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { getCurrentUser } from "@/utils/user.utils";
import {
  getApplicationCandidateProfile,
  updateApplicationCandidateProfile,
} from "@/actions/applicationProfile.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
const mockedUser = vi.mocked(getCurrentUser);

// CP-EDIT: every personal-info row commits its own key through the shared
// update action. These checks run the real action + service + SQLite path to
// prove single-field writes persist on reopen and never clobber siblings.
describe("application profile single-field writes (isolated db)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
    delete process.env[AB_RUNTIME_FEATURE_ENV];
    delete process.env[AB_ROLLOUT_SCOPE_ENV];
    try {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    } catch {
      // Windows EPERM flake.
    }
  });

  beforeEach(async () => {
    await resetDisposableDb(prisma);
    userId = await seedAccount(
      prisma,
      `basics-autosave-${Date.now()}-${Math.random()}@example.com`,
    );
    mockedUser.mockResolvedValue({
      id: userId,
      name: "Test",
      email: "t@example.com",
    } as never);
    await activateFreshAbNative(prisma);
    process.env[AB_RUNTIME_FEATURE_ENV] = "true";
    process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
  });

  it("persists each field commit and preserves untouched fields on reopen", async () => {
    const first = await updateApplicationCandidateProfile({
      fullName: "Lin Mu",
    });
    expect(first.success).toBe(true);
    const second = await updateApplicationCandidateProfile({
      email: "lin@example.com",
    });
    expect(second.success).toBe(true);

    const read = await getApplicationCandidateProfile();
    expect(read.success).toBe(true);
    const data = read.success
      ? (read.data as Record<string, unknown>)
      : {};
    expect(data.fullName).toBe("Lin Mu");
    expect(data.email).toBe("lin@example.com");

    // A later single-field save returns the row but must not clobber siblings.
    const third = await updateApplicationCandidateProfile({
      email: "new@example.com",
    });
    expect(third.success).toBe(true);
    const reread = await getApplicationCandidateProfile();
    expect(reread.success).toBe(true);
    const rereadData = reread.success
      ? (reread.data as Record<string, unknown>)
      : {};
    expect(rereadData.fullName).toBe("Lin Mu");
    expect(rereadData.email).toBe("new@example.com");

    // Clearing a field persists null and leaves every other field alone.
    const cleared = await updateApplicationCandidateProfile({
      fullName: null,
    });
    expect(cleared.success).toBe(true);
    const after = await getApplicationCandidateProfile();
    expect(after.success).toBe(true);
    const afterData = after.success
      ? (after.data as Record<string, unknown>)
      : {};
    expect(afterData.fullName).toBeNull();
    expect(afterData.email).toBe("new@example.com");
  });

  it("rejects an invalid single-field value without writing anything", async () => {
    const seed = await updateApplicationCandidateProfile({
      fullName: "Keep Me",
    });
    expect(seed.success).toBe(true);

    const rejected = await updateApplicationCandidateProfile({
      email: "not-an-email",
    });
    expect(rejected.success).toBe(false);

    const read = await getApplicationCandidateProfile();
    expect(read.success).toBe(true);
    const readData = read.success
      ? (read.data as Record<string, unknown>)
      : {};
    expect(readData.fullName).toBe("Keep Me");
    expect(readData.email).toBeNull();
  });
});
