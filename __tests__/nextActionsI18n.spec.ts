// @vitest-environment node
//
// NEXT-ACTIONS/JOURNEY-OVERVIEW i18n fragment parity (frozen contract §8):
// the unmerged fragments under .tmp/p2-overview-actions/ must carry identical
// key sets in zh-CN and en, identical {placeholder} sets per key, and cover
// every dashboard.* key the two components reference. When the coordinating
// window merges the fragments into src/i18n/messages/, this spec should be
// repointed at the dictionaries.
import fs from "node:fs";
import path from "node:path";
import zhFragment from "../.tmp/p2-overview-actions/i18n.zh-CN.json";
import enFragment from "../.tmp/p2-overview-actions/i18n.en.json";

function flatten(fragment: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [namespace, entries] of Object.entries(fragment)) {
    for (const [key, value] of Object.entries(
      entries as Record<string, string>,
    )) {
      out[`${namespace}.${key}`] = value;
    }
  }
  return out;
}

const zh = flatten(zhFragment);
const en = flatten(enFragment);

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
