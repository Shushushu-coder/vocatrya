import type { TranslateFn } from "@/i18n/types";

const JOURNEY_COPY_KEYS = {
  intro: "dashboard.journeyRc.intro",
  prepareDesc: "dashboard.journeyRc.prepareDesc",
  actDesc: "dashboard.journeyRc.actDesc",
  reviewDesc: "dashboard.journeyRc.reviewDesc",
} as const;

export type JourneyCopySlot = keyof typeof JOURNEY_COPY_KEYS;

export function journeyText(
  t: TranslateFn,
  slot: JourneyCopySlot,
): string {
  return t(JOURNEY_COPY_KEYS[slot]);
}
