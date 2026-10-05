import { projectResumeVariantText } from "@/lib/career/resumeVariantText";

describe("projectResumeVariantText", () => {
  it("projects the header and expression content the preview shows", () => {
    const text = projectResumeVariantText({
      headerSnapshot: JSON.stringify({
        fullName: "Ada Lovelace",
        headline: "Engineer",
        email: "ada@example.com",
        links: [{ label: "Site", url: "https://ada.example" }],
      }),
      sections: [
        {
          title: "Experience",
          items: [
            {
              materialTitleSnapshot: "Analytical Engines",
              careerMaterialItem: { title: "LIVE TITLE MUST NOT RENDER" },
              expressions: [{ content: "Built the first program." }],
            },
          ],
        },
      ],
    });
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("ada@example.com");
    expect(text).toContain("https://ada.example");
    expect(text).toContain("## Experience");
    expect(text).toContain("Analytical Engines");
    expect(text).toContain("Built the first program.");
  });
});
