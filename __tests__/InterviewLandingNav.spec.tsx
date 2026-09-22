import { SIDEBAR_LINKS } from "@/lib/constants";
import { getSidebarNavLabel } from "@/components/Header";

describe("interview navigation", () => {
  it("adds Interview to product navigation without research routes", () => {
    const interview = SIDEBAR_LINKS.find((item) => item.route === "/dashboard/interview");
    expect(interview).toBeTruthy();
    const label = getSidebarNavLabel(
      "/dashboard/interview",
      "Interview",
      (key) => (key === "nav.interview" ? "面试练习" : key),
    );
    expect(label).toBe("面试练习");
    expect(SIDEBAR_LINKS.map((item) => item.route).join(" ")).not.toMatch(
      /participant|wenjuanxing|experiment/i,
    );
  });
});
