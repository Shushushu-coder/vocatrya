// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { AB_RUNTIME_FEATURE_ENV, AB_ROLLOUT_SCOPE_ENV } from "@/lib/career/identities";
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
  getEmergencyContactOverview,
  revealEmergencyContact,
  updateEmergencyContact,
} from "@/actions/applicationProfile.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
const mockedUser = vi.mocked(getCurrentUser);

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
  userId = await seedAccount(prisma, `emergency-edit-${Date.now()}-${Math.random()}@example.com`);
  mockedUser.mockResolvedValue({ id: userId, name: "Test", email: "t@example.com" } as never);
  await activateFreshAbNative(prisma);
  process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
});

describe("emergency contact partial write (actions + isolated db)", () => {
  it("writing only the relation preserves stored name and phone", async () => {
    const seeded = await updateEmergencyContact({
      emergencyContactName: "张建国",
      emergencyContactRelation: "父亲",
      emergencyContactPhone: "13800138000",
    });
    expect(seeded.success).toBe(true);

    // Mirrors the component's new save path: untouched fields are omitted.
    const res = await updateEmergencyContact({ emergencyContactRelation: "母亲" });
    expect(res.success).toBe(true);

    const stored = await prisma.candidateSensitiveInfo.findUnique({ where: { userId } });
    expect(stored?.emergencyContactName).toBe("张建国");
    expect(stored?.emergencyContactRelation).toBe("母亲");
    expect(stored?.emergencyContactPhone).toBe("13800138000");

    // Re-open read path returns the same preserved values.
    const revealed = await revealEmergencyContact();
    expect(revealed.success).toBe(true);
    if (!revealed.success) return;
    expect((revealed.data as { name: string }).name).toBe("张建国");
    expect((revealed.data as { phone: string }).phone).toBe("13800138000");
    const overview = await getEmergencyContactOverview();
    expect(overview.success).toBe(true);
    if (!overview.success) return;
    expect((overview.data as { relation: string }).relation).toBe("母亲");
  });

  it("explicit null clears a field while omitted fields survive", async () => {
    const seeded = await updateEmergencyContact({
      emergencyContactName: "张建国",
      emergencyContactRelation: "父亲",
      emergencyContactPhone: "13800138000",
    });
    expect(seeded.success).toBe(true);

    const res = await updateEmergencyContact({ emergencyContactName: null });
    expect(res.success).toBe(true);

    const stored = await prisma.candidateSensitiveInfo.findUnique({ where: { userId } });
    expect(stored?.emergencyContactName).toBeNull();
    expect(stored?.emergencyContactRelation).toBe("父亲");
    expect(stored?.emergencyContactPhone).toBe("13800138000");
  });
});
