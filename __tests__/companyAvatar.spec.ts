import {
  COMPANY_AVATAR_PALETTES,
  companyAvatarPaletteClass,
  companyAvatarText,
} from "@/lib/company-avatar";

describe("companyAvatarText", () => {
  it("uses the first Han character for Chinese names", () => {
    expect(companyAvatarText("阿里巴巴集团")).toBe("阿");
    expect(companyAvatarText("腾讯科技（深圳）有限公司")).toBe("腾");
  });

  it("supports CJK extension ideographs as single graphemes", () => {
    // U+20BB7 (CJK Ext B) is a surrogate pair — a broken implementation would
    // return the lone lead surrogate instead of the full character.
    expect(companyAvatarText("𠮷野家")).toBe("𠮷");
    expect(companyAvatarText("𠮷")).toBe("𠮷");
  });

  it("takes single initials for one-word English names", () => {
    expect(companyAvatarText("Acme")).toBe("A");
  });

  it("takes word initials for multi-word English names", () => {
    expect(companyAvatarText("Acme Corp")).toBe("AC");
    expect(companyAvatarText("Byte Dance Ltd")).toBe("BD");
  });

  it("uppercases lowercase and case-variant inputs", () => {
    expect(companyAvatarText("acme corp")).toBe("AC");
    expect(companyAvatarText("ACME CORP")).toBe("AC");
    expect(companyAvatarText("aCmE cOrP")).toBe("AC");
  });

  it("keeps digits for number-led names", () => {
    expect(companyAvatarText("3M")).toBe("3");
    expect(companyAvatarText("7-Eleven")).toBe("7E");
    expect(companyAvatarText("360 安全")).toBe("安");
  });

  it("resolves mixed Chinese/English names deterministically to the first Han character", () => {
    expect(companyAvatarText("ByteDance 字节跳动")).toBe("字");
    expect(companyAvatarText("腾讯 Tencent")).toBe("腾");
    expect(companyAvatarText("Google 谷歌")).toBe("谷");
    // Same inputs always produce the same output across repeated calls.
    expect(companyAvatarText("ByteDance 字节跳动")).toBe(
      companyAvatarText("ByteDance 字节跳动"),
    );
  });

  it("ignores leading punctuation and symbols", () => {
    expect(companyAvatarText("!!Acme Corp")).toBe("AC");
    expect(companyAvatarText("——阿里巴巴")).toBe("阿");
    expect(companyAvatarText("*** 7-Eleven")).toBe("7E");
    expect(companyAvatarText("© Acme")).toBe("A");
  });

  it("degrades emoji-only, punctuation-only and blank names to empty", () => {
    expect(companyAvatarText("🎉🚀")).toBe("");
    expect(companyAvatarText("§¶†‡")).toBe("");
    expect(companyAvatarText("→←↑")).toBe("");
    expect(companyAvatarText("!@#$%")).toBe("");
    expect(companyAvatarText("")).toBe("");
    expect(companyAvatarText("   ")).toBe("");
    expect(companyAvatarText(null)).toBe("");
    expect(companyAvatarText(undefined)).toBe("");
  });

  it("normalizes NFKC compatibility characters before extraction", () => {
    // Fullwidth latin collapses to ASCII words.
    expect(companyAvatarText("Ａｃｍｅ Ｃｏｒｐ")).toBe("AC");
    // Halfwidth katakana composes to standard katakana, then reads as letters.
    expect(companyAvatarText("ｶﾀｶﾅ")).toBe("カ");
    // ™ is a compatibility equivalent of TM — NFKC folds it into a word.
    expect(companyAvatarText("™")).toBe("T");
  });

  it("handles accented latin via grapheme segmentation", () => {
    expect(companyAvatarText("élan vital")).toBe("ÉV");
    expect(companyAvatarText("École")).toBe("É");
  });
});

describe("companyAvatarPaletteClass", () => {
  it("is stable for the same name across calls", () => {
    const first = companyAvatarPaletteClass("Acme Corp");
    expect(companyAvatarPaletteClass("Acme Corp")).toBe(first);
    expect(first).not.toBe("");
  });

  it("maps normalized-equivalent names to the same palette", () => {
    const base = companyAvatarPaletteClass("Acme Corp");
    expect(companyAvatarPaletteClass("  Acme Corp  ")).toBe(base);
    expect(companyAvatarPaletteClass("ACME CORP")).toBe(base);
    expect(companyAvatarPaletteClass("Ａｃｍｅ　Ｃｏｒｐ")).toBe(base);
  });

  it("always returns a palette from the approved table", () => {
    const allowed = new Set(
      COMPANY_AVATAR_PALETTES.map((p) => p.className),
    );
    for (const name of [
      "阿里巴巴",
      "Acme Corp",
      "3M",
      "字节跳动 ByteDance",
      "🎉",
      "",
      null,
      undefined,
    ]) {
      expect(allowed).toContain(companyAvatarPaletteClass(name));
    }
  });
});

// WCAG 2.x relative luminance on the resolved sRGB pairs recorded next to each
// palette — the check computes real ratios instead of trusting shade names.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(bg: string, fg: string): number {
  const [hi, lo] = [luminance(bg), luminance(fg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe("company avatar palettes", () => {
  it("provides about six fixed hues", () => {
    expect(COMPANY_AVATAR_PALETTES).toHaveLength(6);
  });

  it.each(COMPANY_AVATAR_PALETTES.map((p, i) => [i, p] as const))(
    "palette %i meets WCAG AA 4.5:1 in light and dark",
    (_i, palette) => {
      const light = contrastRatio(palette.light[0], palette.light[1]);
      const dark = contrastRatio(palette.dark[0], palette.dark[1]);
      expect(light).toBeGreaterThanOrEqual(4.5);
      expect(dark).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe("Intl.Segmenter fallback", () => {
  it("still resolves initials and surrogate-pair Han without Segmenter", async () => {
    const intl = Intl as { Segmenter?: unknown };
    const original = intl.Segmenter;
    try {
      intl.Segmenter = undefined;
      vi.resetModules();
      const mod = await import("@/lib/company-avatar");
      expect(mod.companyAvatarText("Acme Corp")).toBe("AC");
      expect(mod.companyAvatarText("𠮷野家")).toBe("𠮷");
      expect(mod.companyAvatarText("élan vital")).toBe("ÉV");
    } finally {
      intl.Segmenter = original;
      vi.resetModules();
    }
  });
});
