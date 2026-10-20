import { PrismaClient } from "@prisma/client";
import { test, expect, uniqueName } from "./fixtures";
import { E2E_TEST_USER } from "./support/testUser";
import { configureE2EDatabase } from "./support/database";

// Runs against the same isolated SQLite file as every e2e spec here; the
// assertions double-check what the /api/test/cleanup teardown really did.
const database = configureE2EDatabase();
const prisma = new PrismaClient({ datasourceUrl: database.url });

async function testUserId() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: E2E_TEST_USER.email },
    select: { id: true },
  });
  return user.id;
}

// Library rows are stored as value = label.trim().toLowerCase() and the
// cleanup route matches on that normalized value.
const libraryValue = (label: string) => label.trim().toLowerCase();

test.describe.serial("cleanup failure propagation (W1-SHARED-E2E-R2)", () => {
  const releasedCompany = uniqueName("cleanup released company");
  const stuckCompany = uniqueName("cleanup stuck company");
  const releasedLocation = uniqueName("cleanup released location");

  test("successful cleanup still releases a registered row", async ({
    cleanup,
  }) => {
    await prisma.company.create({
      data: {
        label: releasedCompany,
        value: libraryValue(releasedCompany),
        createdBy: await testUserId(),
      },
    });
    cleanup.company(releasedCompany);
  });

  test("the successfully cleaned row is actually gone", async () => {
    expect(
      await prisma.company.findFirst({
        where: { value: libraryValue(releasedCompany) },
      }),
    ).toBeNull();
  });

  test("a cleanup-route 500 fails the test without blocking other releases", async ({
    cleanup,
  }) => {
    test.fail();
    const createdBy = await testUserId();
    const company = await prisma.company.create({
      data: {
        label: stuckCompany,
        value: libraryValue(stuckCompany),
        createdBy,
      },
    });
    await prisma.location.create({
      data: {
        label: releasedLocation,
        value: libraryValue(releasedLocation),
        createdBy,
      },
    });
    // JobOpportunity.companyId is onDelete: Restrict and is not part of the
    // route's reference count, so deleting this company is a real 500 - and
    // the combined request aborts there before it ever reaches locations.
    await prisma.jobOpportunity.create({
      data: { userId: createdBy, companyId: company.id, title: stuckCompany },
    });
    cleanup.company(stuckCompany);
    cleanup.location(releasedLocation);
  });

  test("the failed group stayed while later groups were still released", async () => {
    try {
      // The Restrict-guarded company could not be released; the location,
      // which the combined 500 skipped, was still released by the per-group
      // retry.
      expect(
        await prisma.company.findFirst({
          where: { value: libraryValue(stuckCompany) },
        }),
      ).not.toBeNull();
      expect(
        await prisma.location.findFirst({
          where: { value: libraryValue(releasedLocation) },
        }),
      ).toBeNull();
    } finally {
      // The Restrict-guarded rows can never be released through the cleanup
      // route (that is exactly what made the 500 real); remove them directly
      // so no A+B residue pollutes the shared e2e database.
      await prisma.jobOpportunity.deleteMany({
        where: { title: stuckCompany },
      });
      await prisma.company.deleteMany({
        where: { value: libraryValue(stuckCompany) },
      });
    }
  });

  test("a cleanup request bounced by auth middleware fails the test", async ({
    page,
    cleanup,
  }) => {
    test.fail();
    cleanup.tag(uniqueName("cleanup bounced tag"));
    // Clearing the session cookie bounces the POST off the auth middleware
    // onto /signin: the response chain ends 200 but nothing was cleaned.
    await page.context().clearCookies();
  });

  test("a thrown cleanup request fails the test instead of passing", async ({
    page,
    cleanup,
  }) => {
    test.fail();
    cleanup.tag(uniqueName("cleanup aborted tag"));
    // With the context gone the request itself throws during teardown.
    await page.context().close();
  });
});
