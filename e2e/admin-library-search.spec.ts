import { randomUUID } from "crypto";
import { test, expect, createNewJob } from "./fixtures";

// R4-A1: the Locations and Sources tabs gained the same backend-driven
// search the Job Titles tab already had. These specs exercise the real
// server actions — filtering is done server-side, not in the browser.
test.describe("Admin Locations search", () => {
  test("filters the locations list by name from the backend", async ({
    page,
    cleanup,
  }) => {
    // Shared suffix lets one search term match both locations below without
    // depending on the unfiltered (pagination-sensitive) list.
    const suffix = randomUUID().slice(0, 8);
    const locationA = `Zurich ${suffix}`;
    const locationB = `Remote ${suffix}`;

    await createNewJob(page, `Engineer A ${suffix}`, cleanup, {
      location: locationA,
    });
    await createNewJob(page, `Engineer B ${suffix}`, cleanup, {
      location: locationB,
    });

    await page.goto("/dashboard/admin?tab=locations");
    await page.waitForLoadState("networkidle");

    const searchInput = page.getByPlaceholder("Search locations...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill(locationA);

    await expect(
      page.getByRole("cell", { name: locationA, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: locationB, exact: true }),
    ).not.toBeVisible();

    await searchInput.fill(suffix);

    await expect(
      page.getByRole("cell", { name: locationA, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: locationB, exact: true }),
    ).toBeVisible();
  });
});

test.describe("Admin Sources search", () => {
  test("filters the sources list by name from the backend", async ({
    page,
    cleanup,
  }) => {
    // Sources come from the seeded catalog (a Job's source picker offers
    // fixed options), so the search can assert on stable seed labels —
    // creating a job first keeps the tab's stats columns non-degenerate.
    const suffix = randomUUID().slice(0, 8);
    await createNewJob(page, `Engineer ${suffix}`, cleanup);

    await page.goto("/dashboard/admin?tab=sources");
    await page.waitForLoadState("networkidle");

    const searchInput = page.getByPlaceholder("Search sources...");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("Indeed");

    await expect(
      page.getByRole("cell", { name: "Indeed", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "Linkedin", exact: true }),
    ).not.toBeVisible();
  });
});
