"use client";
import { useI18n } from "@/i18n";

// Task-local copy adapter for UI-RC-JOB-ORDER: the shared bilingual
// dictionary is consolidated by agent A (.tmp/ui-rc-job-order/i18n.json
// carries the keys). Until the keys are wired, t() returns the key itself —
// this adapter falls back to the shipped strings so the feature stays
// usable. Once the dictionary lands, t() wins and the fallbacks go unused.
const JOB_ORDER_FALLBACKS: Record<string, { "zh-CN": string; en: string }> = {
  "jobs.sortBy": { "zh-CN": "排序", en: "Sort" },
  "jobs.sortCustom": { "zh-CN": "自定义排序", en: "Custom order" },
  "jobs.sortCreatedAt": { "zh-CN": "最近创建", en: "Recently created" },
  "jobs.clearFiltersToReorder": {
    "zh-CN": "清除筛选后可拖动排序",
    en: "Clear filters to drag and reorder",
  },
  "jobs.dragToReorder": { "zh-CN": "拖动排序", en: "Drag to reorder" },
  "jobs.pinned": { "zh-CN": "已置顶", en: "Pinned" },
  "jobs.pinJob": { "zh-CN": "置顶", en: "Pin to top" },
  "jobs.unpinJob": { "zh-CN": "取消置顶", en: "Unpin" },
};

export function useJobOrderT() {
  const { t, locale } = useI18n();
  return (key: string): string => {
    const resolved = t(key);
    if (resolved !== key) return resolved;
    const entry = JOB_ORDER_FALLBACKS[key];
    return entry?.[locale === "zh-CN" ? "zh-CN" : "en"] ?? key;
  };
}
