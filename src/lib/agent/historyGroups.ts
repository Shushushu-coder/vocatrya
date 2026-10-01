export type HistoryBucket = "today" | "yesterday" | "earlier";

export function historyBucket(updatedAt: Date, now: Date): HistoryBucket {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (updatedAt >= startOfToday) return "today";
  if (updatedAt >= startOfYesterday) return "yesterday";
  return "earlier";
}

export function groupHistory<T extends { updatedAt: string }>(
  items: T[],
  now: Date,
): Record<HistoryBucket, T[]> {
  const groups: Record<HistoryBucket, T[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const item of items) {
    const when = new Date(item.updatedAt);
    const bucket = Number.isNaN(when.getTime())
      ? "earlier"
      : historyBucket(when, now);
    groups[bucket].push(item);
  }
  return groups;
}
