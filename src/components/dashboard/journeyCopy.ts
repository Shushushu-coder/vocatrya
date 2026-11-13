// UI-RC-OVERVIEW task-local copy bridge. The shared dictionaries are merged
// by the integration owner from this worktree's .tmp/ui-rc-overview/i18n.json;
// until each key lands there, the frozen copy below is served so this
// worktree verifies independently. Once a key exists in the shared
// dictionary it wins automatically — no component change needed.
import type { Locale } from "@/i18n/config";
import { hasTranslation } from "@/i18n/translate";
import type { TranslateFn } from "@/i18n/types";

const JOURNEY_COPY_KEYS = {
  intro: "dashboard.journeyRc.intro",
  prepareDesc: "dashboard.journeyRc.prepareDesc",
  actDesc: "dashboard.journeyRc.actDesc",
  reviewDesc: "dashboard.journeyRc.reviewDesc",
} as const;

export type JourneyCopySlot = keyof typeof JOURNEY_COPY_KEYS;

const LOCAL_COPY: Record<JourneyCopySlot, Record<Locale, string>> = {
  intro: {
    "zh-CN":
      "推荐按「准备 → 行动 → 复盘」组织求职：三个阶段随时可进入，不必按顺序完成。😄",
    en: "Try organizing your search as Prepare → Act → Review — enter any stage at any time, in any order. 😄",
  },
  prepareDesc: {
    "zh-CN": "整理经历、准备简历，提前练好面试。",
    en: "Organize your experience, prepare resumes, and practice interviews ahead of time.",
  },
  actDesc: {
    "zh-CN": "记录投了哪些岗位，跟进面试和待办。",
    en: "Log the roles you apply to, then keep up with interviews and to-dos.",
  },
  reviewDesc: {
    "zh-CN": "记下面试问答，看看下次怎么答得更好。",
    en: "Note the interview Q&As and see how to answer better next time.",
  },
};

export function journeyText(
  locale: Locale,
  t: TranslateFn,
  slot: JourneyCopySlot,
): string {
  const key = JOURNEY_COPY_KEYS[slot];
  if (hasTranslation(locale, key)) return t(key);
  return LOCAL_COPY[slot][locale];
}
