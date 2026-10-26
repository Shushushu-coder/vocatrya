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
  createApplicationMaterial,
  getApplicationMaterial,
  updateApplicationMaterial,
} from "@/actions/applicationProfile.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
const mockedUser = vi.mocked(getCurrentUser);

type DetailRow = Record<string, unknown> | null | undefined;

async function readMaterial(id: string) {
  const res = await getApplicationMaterial(id);
  expect(res.success).toBe(true);
  return res.data as Record<string, unknown>;
}

// CP-EDIT: every material card field commits a single-key patch through the
// shared update action. These checks run the real action + service + SQLite
// path to prove incremental writes persist on reopen and never clobber
// unedited base fields, detail columns, or history.
describe("material record incremental writes (isolated db)", () => {
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
      `material-autosave-${Date.now()}-${Math.random()}@example.com`,
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

  it("merges single detail keys and preserves untouched columns on reopen", async () => {
    const created = await createApplicationMaterial({
      type: "EDUCATION",
      title: "Fudan",
      startDate: "2018-09-01",
      endDate: "2022-06-30",
      notes: "note",
      detail: {
        institution: "Fudan",
        degree: "BSc",
        fieldOfStudy: "CS",
        gpaValue: 3.6,
        gpaScale: 4,
        rankText: "top 5%",
      },
    });
    expect(created.success).toBe(true);
    const id = (created.data as { id: string }).id;

    // One detail key: gpaValue updates, everything else stays.
    const up1 = await updateApplicationMaterial({
      id,
      detail: { gpaValue: 3.9 },
    });
    expect(up1.success).toBe(true);
    const read1 = await readMaterial(id);
    const d1 = read1.educationDetail as DetailRow;
    expect(d1?.gpaValue).toBe(3.9);
    expect(d1?.institution).toBe("Fudan");
    expect(d1?.degree).toBe("BSc");
    expect(d1?.fieldOfStudy).toBe("CS");
    expect(d1?.gpaScale).toBe(4);
    expect(d1?.rankText).toBe("top 5%");

    // Clearing one detail key writes null; siblings survive.
    const up2 = await updateApplicationMaterial({
      id,
      detail: { rankText: null },
    });
    expect(up2.success).toBe(true);
    const read2 = await readMaterial(id);
    const d2 = read2.educationDetail as DetailRow;
    expect(d2?.rankText).toBeNull();
    expect(d2?.gpaValue).toBe(3.9);
    expect(d2?.institution).toBe("Fudan");

    // A base-field commit leaves the whole detail row alone.
    const up3 = await updateApplicationMaterial({ id, title: "SJTU" });
    expect(up3.success).toBe(true);
    const read3 = await readMaterial(id);
    expect(read3.title).toBe("SJTU");
    const d3 = read3.educationDetail as DetailRow;
    expect(d3?.gpaValue).toBe(3.9);
    expect(d3?.institution).toBe("Fudan");

    // Date and flag writes stay independent of each other and of notes.
    const up4 = await updateApplicationMaterial({ id, endDate: null });
    expect(up4.success).toBe(true);
    const up5 = await updateApplicationMaterial({ id, isCurrent: true });
    expect(up5.success).toBe(true);
    const read5 = await readMaterial(id);
    expect(read5.endDate).toBeNull();
    expect(read5.isCurrent).toBe(true);
    expect(read5.notes).toBe("note");
    expect(
      (read5.startDate as Date).toISOString().startsWith("2018-09-01"),
    ).toBe(true);
  });

  it("keeps internship detail columns independent across commits", async () => {
    const created = await createApplicationMaterial({
      type: "INTERNSHIP",
      title: "Summer Intern",
      detail: {
        organizationName: "Acme",
        roleTitle: "Dev",
        locationText: "Shanghai",
      },
    });
    expect(created.success).toBe(true);
    const id = (created.data as { id: string }).id;

    const up = await updateApplicationMaterial({
      id,
      detail: { roleTitle: "Senior Dev" },
    });
    expect(up.success).toBe(true);

    const read = await readMaterial(id);
    const d = read.internshipDetail as DetailRow;
    expect(d?.roleTitle).toBe("Senior Dev");
    expect(d?.organizationName).toBe("Acme");
    expect(d?.locationText).toBe("Shanghai");
  });

  it("rejects invalid single-field detail values without writing", async () => {
    const created = await createApplicationMaterial({
      type: "EDUCATION",
      title: "Keep",
      detail: { institution: "Keep U", gpaValue: 3 },
    });
    expect(created.success).toBe(true);
    const id = (created.data as { id: string }).id;

    const rejected = await updateApplicationMaterial({
      id,
      detail: { gpaValue: Number.NaN },
    });
    expect(rejected.success).toBe(false);

    const read = await readMaterial(id);
    const d = read.educationDetail as DetailRow;
    expect(d?.gpaValue).toBe(3);
    expect(d?.institution).toBe("Keep U");
  });
});
