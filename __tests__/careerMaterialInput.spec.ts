import { CareerRuntimeError } from "@/lib/career/errors";
import {
  assertApplicationMaterialCreateTitle,
  sanitizeApplicationMaterialDetail,
} from "@/lib/career/careerMaterialInput";

function expectInvalidDetail(fn: () => unknown) {
  expect(fn).toThrow(CareerRuntimeError);
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code: "INVALID_MATERIAL_DETAIL" });
    expect((error as Error).message).toBe("Invalid material detail field.");
    expect((error as Error).message).not.toContain("evil");
    expect(JSON.stringify(error)).not.toContain("{\"evil\"");
  }
}

describe("Application Profile material detail whitelist", () => {
  it("rejects structuredData on EDUCATION", () => {
    expectInvalidDetail(() =>
      sanitizeApplicationMaterialDetail("EDUCATION", {
        institution: "Test University",
        structuredData: "{\"evil\":true}",
      }),
    );
  });

  it("rejects companyId on INTERNSHIP", () => {
    expectInvalidDetail(() =>
      sanitizeApplicationMaterialDetail("INTERNSHIP", {
        organizationName: "Test",
        companyId: "some-id",
      }),
    );
  });

  it("rejects cross-type fields", () => {
    expectInvalidDetail(() =>
      sanitizeApplicationMaterialDetail("SKILL", {
        skillName: "Python",
        gpaValue: 4,
      }),
    );
  });

  it("rejects unknown keys", () => {
    expectInvalidDetail(() =>
      sanitizeApplicationMaterialDetail("EDUCATION", {
        institution: "X",
        arbitraryKey: "x",
      }),
    );
  });

  it("rejects objects and NaN on scalar fields", () => {
    expectInvalidDetail(() =>
      sanitizeApplicationMaterialDetail("EDUCATION", {
        institution: { nested: true },
      }),
    );
    expectInvalidDetail(() =>
      sanitizeApplicationMaterialDetail("EDUCATION", {
        gpaValue: Number.NaN,
      }),
    );
    expectInvalidDetail(() =>
      sanitizeApplicationMaterialDetail("EDUCATION", {
        gpaScale: Number.POSITIVE_INFINITY,
      }),
    );
  });

  it("constructs sanitized EDUCATION/INTERNSHIP/SKILL objects", () => {
    expect(
      sanitizeApplicationMaterialDetail("EDUCATION", {
        institution: "Test University",
        gpaValue: 3.8,
      }),
    ).toEqual({ institution: "Test University", gpaValue: 3.8 });
    expect(
      sanitizeApplicationMaterialDetail("INTERNSHIP", {
        organizationName: "Test",
        roleTitle: "Intern",
      }),
    ).toEqual({ organizationName: "Test", roleTitle: "Intern" });
    expect(
      sanitizeApplicationMaterialDetail("SKILL", { skillName: "Python" }),
    ).toEqual({ skillName: "Python" });
  });

  it("rejects CUSTOM and EMPLOYMENT on the Application Profile path", () => {
    expect(() => sanitizeApplicationMaterialDetail("CUSTOM", {})).toThrow(
      /CUSTOM editing not supported/,
    );
    expect(() => sanitizeApplicationMaterialDetail("EMPLOYMENT", {})).toThrow(
      /EMPLOYMENT editing is not supported/,
    );
  });

  it("rejects blank create titles after trim", () => {
    expect(() => assertApplicationMaterialCreateTitle("   ")).toThrow(CareerRuntimeError);
    expect(() => assertApplicationMaterialCreateTitle("")).toThrow(CareerRuntimeError);
    expect(assertApplicationMaterialCreateTitle("  Uni  ")).toBe("Uni");
  });
});
