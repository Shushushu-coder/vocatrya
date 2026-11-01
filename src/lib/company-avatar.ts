// Deterministic letter-avatar helpers for company logos. Pure functions only:
// no DOM, theme, locale or random access, so they behave identically in unit
// tests, SSR and the desktop renderer.

/**
 * One palette entry binds the Tailwind utility classes to their resolved sRGB
 * pairs. The hex values mirror the default Tailwind v4 palette and let the
 * unit test compute real WCAG contrast ratios instead of trusting shade names.
 */
export const COMPANY_AVATAR_PALETTES = [
  {
    className:
      "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
    light: ["#e0f2fe", "#075985"],
    dark: ["#082f49", "#7dd3fc"],
  },
  {
    className:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    light: ["#d1fae5", "#065f46"],
    dark: ["#022c22", "#6ee7b7"],
  },
  {
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    light: ["#fef3c7", "#92400e"],
    dark: ["#451a03", "#fcd34d"],
  },
  {
    className:
      "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
    light: ["#ede9fe", "#5b21b6"],
    dark: ["#2e1065", "#c4b5fd"],
  },
  {
    className:
      "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
    light: ["#ffe4e6", "#9f1239"],
    dark: ["#4c0519", "#fda4af"],
  },
  {
    className:
      "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300",
    light: ["#cffafe", "#155e75"],
    dark: ["#083344", "#67e8f9"],
  },
] as const;

// Runs of letters, marks and numbers are the "words" of a company name; every
// other character (punctuation, symbols, emoji, whitespace) only separates.
const WORD_RUN = /[\p{L}\p{M}\p{N}]+/gu;
// Script=Han covers the whole CJK ideograph family, extensions included.
const HAN_CHAR = /\p{Script=Han}/u;

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function firstGrapheme(text: string): string {
  if (graphemeSegmenter) {
    const first = graphemeSegmenter
      .segment(text)
      [Symbol.iterator]()
      .next();
    return first.done ? "" : first.value.segment;
  }
  // Hosts without Intl.Segmenter fall back to the first code point; NFKC
  // already folded the common combining-mark cases into single points.
  return Array.from(text)[0] ?? "";
}

function normalizeName(name?: string | null): string {
  return (name ?? "").normalize("NFKC").trim();
}

/**
 * 1–2 deterministic characters for the letter avatar, or "" when the name has
 * no meaningful content (caller then renders the neutral building icon).
 *
 * Rules, in order:
 * - Any Han ideograph wins: CJK and mixed-language names resolve to the first
 *   Han character ("阿里巴巴" → "阿", "ByteDance 字节" → "字").
 * - Otherwise take the first grapheme of each of the first two words,
 *   uppercased ("Acme Corp" → "AC", "3M" → "3", "élan vital" → "ÉV").
 * - Leading symbols are ignored naturally because only word characters match.
 */
export function companyAvatarText(name?: string | null): string {
  const normalized = normalizeName(name);
  if (!normalized) return "";
  const han = normalized.match(HAN_CHAR);
  if (han) return han[0];
  return (normalized.match(WORD_RUN) ?? [])
    .slice(0, 2)
    .map((word) => firstGrapheme(word).toUpperCase())
    .join("");
}

/**
 * Stable hash (FNV-1a over UTF-16 units) so the same normalized name maps to
 * the same palette in every render, process and session. Case-folded so that
 * "Acme" and "ACME" share a hue; no randomness involved.
 */
function hashName(normalized: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Background + foreground utility classes for the letter avatar. The same
 * normalized name always resolves to the same palette; empty names get the
 * first palette deterministically (callers normally prefer the neutral icon).
 */
export function companyAvatarPaletteClass(name?: string | null): string {
  const normalized = normalizeName(name).toLowerCase();
  const index = normalized
    ? hashName(normalized) % COMPANY_AVATAR_PALETTES.length
    : 0;
  return COMPANY_AVATAR_PALETTES[index].className;
}
