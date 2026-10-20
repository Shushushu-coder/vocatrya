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

// The seeded failure vector must stay a failure on both sides of the
// process-cleanup boundary: the old route skips JobOpportunity when counting
// company references and dies on P2003, while the fixed route counts it but
// refuses to delete an opportunity a ResumeVariant still targets
// (CLEANUP_BLOCKED). Registering the opportunity AND its anchor company
// makes either implementation reject the request with a 500 - and leaves
// the company and the releasable location witnesses identical.
test.describe.serial("cleanup failure propagation (W1-SHARED-E2E-R2)", () => {
  const releasedCompany = uniqueName("cleanup released company");
  const releasedLocation = uniqueName("cleanup released location");
  const rejectedCompany = uniqueName("cleanup rejected company");
  const rejectedTitle = uniqueName("cleanup rejected opportunity");
  const rejectedVariant = uniqueName("cleanup rejected variant");
  const blockedCompany = uniqueName("cleanup blocked company");
  const blockedTitle = uniqueName("cleanup blocked opportunity");
  const blockedVariant = uniqueName("cleanup blocked variant");

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

  test("the cleanup route refuses the seeded failure vector", async ({
    page,
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
    await prisma.resumeVariant.create({
      data: {
        userId: createdBy,
        name: rejectedVariant,
        targetJobOpportunityId: opportunity.id,
      },
    });
    try {
      const res = await page.request.post("/api/test/cleanup", {
        data: { jobIds: [opportunity.id], companies: [rejectedCompany] },
      });
      // Old route: P2003 deleting the still-referenced company. New route:
      // 500 CLEANUP_BLOCKED inside deleteOwnedOpportunity. The shared
      // contract: the request is refused and every seeded row survives.
      expect(res.status()).toBe(500);
      expect(
        await prisma.jobOpportunity.findUnique({
          where: { id: opportunity.id },
        }),
      ).not.toBeNull();
      expect(
        await prisma.company.findUnique({ where: { id: company.id } }),
      ).not.toBeNull();
    } finally {
      // Purge the seed directly: on the old route a referenced company can
      // never be released through cleanup (the defect the route fix closes),
      // so teardown must not be asked to.
      await prisma.resumeVariant.deleteMany({
        where: { name: rejectedVariant, userId: createdBy },
      });
      await prisma.jobOpportunity.deleteMany({
        where: { title: rejectedTitle, userId: createdBy },
      });
      await prisma.company.deleteMany({
        where: { value: libraryValue(rejectedCompany), createdBy },
      });
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
    // Old route fails the combined request at companies (P2003); the fixed
    // route fails it at jobs (CLEANUP_BLOCKED). The per-group retry then
    // still releases the location both ways.
    cleanup.job(opportunity.id);
    cleanup.company(blockedCompany);
    cleanup.location(releasedLocation);
  });

  test("the blocked group stayed while later groups were still released", async () => {
    const createdBy = await testUserId();
    try {
      // The guarded opportunity, its variant, and its anchor company could
      // not be released; the location - skipped by the aborted combined
      // request - was still released by the per-group retry.
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
      // Neither blocker is releasable through the cleanup route on the old
      // implementation (that is exactly what makes the 500 real); remove
      // the seed directly so no A+B residue pollutes the shared database.
      await prisma.resumeVariant.deleteMany({
        where: { name: blockedVariant, userId: createdBy },
      });
      await prisma.jobOpportunity.deleteMany({
        where: { title: blockedTitle, userId: createdBy },
      });
      await prisma.company.deleteMany({
        where: { value: libraryValue(blockedCompany), createdBy },
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
