import { canonicalize, hashCanonical } from "@/lib/career";

describe("canonical hash", () => {
  it("sorts object keys and preserves array order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ list: [1, 2] })).not.toBe(canonicalize({ list: [2, 1] }));
  });

  it("distinguishes null from missing", () => {
    expect(canonicalize({ a: null })).not.toBe(canonicalize({}));
    expect(canonicalize({ a: undefined })).toBe(canonicalize({}));
  });

  it("is stable for UTF-8 content", () => {
    const left = hashCanonical({ title: "简历" });
    const right = hashCanonical({ title: "简历" });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });
});
