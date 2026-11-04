// @vitest-environment node
//
// NEXT-ACTIONS/JOURNEY-OVERVIEW i18n parity (frozen contract §8): the keys
// this package contributed to the shared dictionaries must carry identical
// {placeholder} sets per key in zh-CN and en, and cover every dashboard.* key
// the two components reference.
import fs from "node:fs";
import path from "node:path";
import zhMessages from "../src/i18n/messages/zh-CN.json";
import enMessages from "../src/i18n/messages/en.json";

function flatten(
  node: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[path] = value;
    } else if (value && typeof value === "object") {
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    }
  }
  return out;
}

const zhAll = flatten(zhMessages);
const enAll = flatten(enMessages);

// The package's owned keys: journey cards plus next-actions copy. Shared
// dictionary keys contributed by other packages are out of scope here.
const OWNED_PREFIXES = ["dashboard.journey", "dashboard.nextAction"];

const zh = Object.fromEntries(
  Object.entries(zhAll).filter(([key]) =>
    OWNED_PREFIXES.some((prefix) => key.startsWith(prefix)),
  ),
);
const en = Object.fromEntries(
  Object.entries(enAll).filter(([key]) =>
    OWNED_PREFIXES.some((prefix) => key.startsWith(prefix)),
  ),
);

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe("i18n fragment parity", () => {
  it("carries the same key set in zh-CN and en", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en).length).toBeGreaterThan(0);
  });

  it("keeps {placeholder} sets identical across locales", () => {
    for (const key of Object.keys(en)) {
      expect(placeholders(zh[key])).toEqual(placeholders(en[key]));
    }
  });

  it("covers every dashboard.* key the components reference", () => {
    const used = new Set<string>();
    for (const file of [
      "src/components/dashboard/JourneySection.tsx",
      "src/components/dashboard/NextActions.tsx",
    ]) {
      const source = fs.readFileSync(path.resolve(file), "utf8");
      for (const match of source.matchAll(/"(dashboard\.[A-Za-z0-9]+)"/g)) {
        used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      expect(en, `missing en key ${key}`).toHaveProperty(key);
      expect(zh, `missing zh key ${key}`).toHaveProperty(key);
    }
  });
});
