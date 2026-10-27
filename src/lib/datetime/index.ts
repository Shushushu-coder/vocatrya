/**
 * DateTime V1 foundation. Implements DATETIME_V1_CONTRACT.md
 * (see .wave1-runtime/evidence/NEXT-DATETIME-01).
 *
 * Self-owned by the datetime workline: no shared barrels re-export this yet;
 * consumers import from "@/lib/datetime" once their owners adopt it.
 */

export type {
  BusinessTimeValue,
  DateOnlyParts,
  DateOnlyString,
  InstantIso,
  TimePrecision,
  WallTime,
  WallTimeResolution,
} from "./types";
export { DateTimeContractError } from "./types";

export {
  addDaysToDateOnly,
  compareDateOnly,
  dateOnlyParts,
  dateOnlyToEpochDay,
  epochDayToDateOnly,
  isDateOnly,
  parseDateOnly,
  requireDateOnly,
  todayDateOnly,
} from "./dateOnly";

export {
  assertMinutePrecision,
  isInstantShape,
  isOnMinuteBoundary,
  isUtcMidnight,
  parseInstantIso,
  requireInstantIso,
  toInstantIso,
} from "./instant";

export {
  dateOnlyUtcWindow,
  instantToWallTime,
  wallTimeToInstant,
  type WallTimeToInstantOptions,
  type ZonedInterval,
} from "./zoned";

export { assertValidTimeZone, runtimeTimeZone } from "./zoneMath";

export {
  BUSINESS_TIME_FIELD,
  FIELD_TIME_CONTRACT,
  classifyStoredInstant,
  completedAtNow,
  dateOnlyFromPickerDate,
  isDeadlineOverdue,
  parseBusinessTimeValue,
  parseDeadlineAtInput,
  parseScheduledAtInput,
  parseTimeOfDay12h,
  readStoredInstantAsBusinessTime,
  serializeBusinessTime,
  toBusinessTimeValue,
  type BusinessTimeField,
  type SerializedBusinessTime,
  type StoredInstantClassification,
} from "./fields";

export {
  formatDateOnly,
  formatDateOnlyMonthYear,
  formatInstant,
  type DateTimeLocale,
} from "./format";

export {
  businessTimeAttentionIso,
  businessTimeDueSortKey,
  businessTimeFromColumns,
  formatBusinessTime,
  formatTimeOfDay12h,
  type BusinessTimeColumns,
} from "./businessTime";
