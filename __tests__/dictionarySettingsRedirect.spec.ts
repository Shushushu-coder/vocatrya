// @vitest-environment node
import AdminPage from "@/app/dashboard/admin/page";
import { redirect } from "next/navigation";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/i18n/server", () => ({ getServerI18n: vi.fn() }));

it("keeps old dictionary links usable with their tab and scope inside settings", async () => {
  await AdminPage({ searchParams: Promise.resolve({ tab: "companies", scope: "watchlist" }) });
  expect(redirect).toHaveBeenCalledWith("/dashboard/settings?tab=companies&scope=watchlist&section=dictionary");
});
