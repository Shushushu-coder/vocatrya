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
  const releasedLocation = uniqueName("cleanup released location");
  const rejectedCompany = uniqueName("cleanup rejected company");
  const rejectedTitle = uniqueName("cleanup rejected opportunity");
  const rejectedVariant = uniqueName("cleanup rejected variant");
  const blockedCompany = uniqueName("cleanup blocked company");
  const blockedTitle = uniqueName("cleanup blocked opportunity");
  const blockedVariant = uniqueName("cleanup blocked variant");
  // The propagation test records the opportunity it seeds so the follow-up
  // test can release that exact row once it is unblocked.
  let blockedOpportunityId = "";

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

  test("the route rejects a resume-targeted opportunity as CLEANUP_BLOCKED", async ({
    page,
    cleanup,
  }) => {
    const createdBy = await testUserId();
    const company = await prisma.company.create({
      data: {
        label: rejectedCompany,
        value: libraryValue(rejectedCompany),
        createdBy,
      },
    });
    const opportunity = await prisma.jobOpportunity.create({
      data: { userId: createdBy, companyId: company.id, title: rejectedTitle },
    });
    // deleteOwnedOpportunity refuses an opportunity a ResumeVariant still
    // targets, so the route answers 500 with code CLEANUP_BLOCKED instead of
    // partially deleting the request.
    await prisma.resumeVariant.create({
      data: {
        userId: createdBy,
        name: rejectedVariant,
        targetJobOpportunityId: opportunity.id,
      },
    });
    try {
      const res = await page.request.post("/api/test/cleanup", {
        data: { jobIds: [opportunity.id] },
      });
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      expect(res.status()).toBe(500);
      expect(body.code).toBe("CLEANUP_BLOCKED");
      expect(typeof body.error).toBe("string");
      // The refusal happens inside the route's transaction, so nothing in
      // the request - not even the company the opportunity references - is
      // deleted.
      expect(
        await prisma.jobOpportunity.findUnique({
          where: { id: opportunity.id },
        }),
      ).not.toBeNull();
      expect(
        await prisma.company.findUnique({ where: { id: company.id } }),
      ).not.toBeNull();
    } finally {
      // Dropping the targeting variant unblocks the seed, so this test's own
      // teardown can release both rows through the route like any other
      // registration.
      await prisma.resumeVariant.deleteMany({
        where: { name: rejectedVariant, userId: createdBy },
      });
      cleanup.job(opportunity.id);
      cleanup.company(rejectedCompany);
    }
  });

  test("a cleanup-route 500 fails the test without blocking other releases", async ({
    cleanup,
  }) => {
    test.fail();
    const createdBy = await testUserId();
    const company = await prisma.company.create({
      data: {
        label: blockedCompany,
        value: libraryValue(blockedCompany),
        createdBy,
      },
    });
    const opportunity = await prisma.jobOpportunity.create({
      data: { userId: createdBy, companyId: company.id, title: blockedTitle },
    });
    blockedOpportunityId = opportunity.id;
    // The variant targeting this opportunity makes the jobIds group fail
    // with 500 CLEANUP_BLOCKED, and the combined request aborts inside the
    // route's transaction before it ever reaches locations.
    await prisma.resumeVariant.create({
      data: {
        userId: createdBy,
        name: blockedVariant,
        targetJobOpportunityId: opportunity.id,
      },
    });
    await prisma.location.create({
      data: {
        label: releasedLocation,
        value: libraryValue(releasedLocation),
        createdBy,
      },
    });
    cleanup.job(opportunity.id);
    cleanup.location(releasedLocation);
  });

  test("the blocked group stayed while later groups were still released", async ({
    cleanup,
  }) => {
    const createdBy = await testUserId();
    try {
      // The variant-targeted opportunity could not be released; the
      // location, which the aborted combined request skipped, was still
      // released by the per-group retry.
      expect(
        await prisma.jobOpportunity.findFirst({
          where: { title: blockedTitle, userId: createdBy },
        }),
      ).not.toBeNull();
      expect(
        await prisma.resumeVariant.findFirst({
          where: { name: blockedVariant, userId: createdBy },
        }),
      ).not.toBeNull();
      expect(
        await prisma.company.findFirst({
          where: { value: libraryValue(blockedCompany) },
        }),
      ).not.toBeNull();
      expect(
        await prisma.location.findFirst({
          where: { value: libraryValue(releasedLocation) },
        }),
      ).toBeNull();
    } finally {
      // Remove the targeting variant so the opportunity is no longer
      // blocked, then let this test's teardown release the opportunity and
      // its anchor company through the route - the same path a green test
      // would take - so the failure vector leaves no residue behind.
      await prisma.resumeVariant.deleteMany({
        where: { name: blockedVariant, userId: createdBy },
      });
      if (blockedOpportunityId) {
        cleanup.job(blockedOpportunityId);
      }
      cleanup.company(blockedCompany);
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
