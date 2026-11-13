"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

export type TagFilterStripItem = {
  id: string;
  label: string;
  count: number;
};

type TagFilterStripProps = {
  title: string;
  items: TagFilterStripItem[];
  totalCount: number;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  className?: string;
};

const FALLBACK_ROW_HEIGHT = 24; // h-6 chip
const ROW_GAP = 6; // gap-1.5
const COLLAPSED_ROWS = 2;
const LABEL_MAX_WIDTH = "10rem";

// Count semantics live in the queries: callers pass items whose count already
// reflects every other active filter (without the tag restriction itself).
// The strip only decides what to display: empty categories stay hidden unless
// they are the current single selection.
export function buildStripItems(
  items: TagFilterStripItem[],
  selectedId?: string,
): TagFilterStripItem[] {
  return items
    .filter((item) => item.count > 0 || item.id === selectedId)
    .sort((a, b) => b.count - a.count);
}

// Collapsed mode clamps to two rows, so a clipped selected chip would be
// unreachable; pinning it first (after "All") keeps it visible without
// measuring per-item offsets.
export function pinSelectedFirst(
  items: TagFilterStripItem[],
  selectedId?: string,
): TagFilterStripItem[] {
  const index = selectedId
    ? items.findIndex((item) => item.id === selectedId)
    : -1;
  if (index <= 0) return items;
  return [items[index], ...items.slice(0, index), ...items.slice(index + 1)];
}

function StripChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-chip
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className="min-w-0 max-w-full"
    >
      <Badge
        variant={active ? "default" : "secondary"}
        className={cn(
          "h-6 cursor-pointer gap-1.5 whitespace-nowrap",
          !active && "font-normal",
        )}
      >
        <span
          className="truncate"
          style={{ maxWidth: LABEL_MAX_WIDTH }}
        >
          {label}
        </span>
        <span
          className={cn(
            "text-xs",
            active ? "opacity-75" : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      </Badge>
    </button>
  );
}

export function TagFilterStrip({
  title,
  items,
  totalCount,
  selectedId,
  onSelect,
  className,
}: TagFilterStripProps) {
  const { t } = useI18n();
  const expandAllLabel = t("common.expandAll");
  const collapseLabel = t("common.collapse");

  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [collapsedMax, setCollapsedMax] = useState(
    FALLBACK_ROW_HEIGHT * COLLAPSED_ROWS + ROW_GAP,
  );
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      const chip = content.querySelector<HTMLElement>("[data-chip]");
      const rowHeight = chip?.offsetHeight || FALLBACK_ROW_HEIGHT;
      const max = rowHeight * COLLAPSED_ROWS + ROW_GAP;
      setCollapsedMax(max);
      setOverflowing(content.scrollHeight > max + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const sortedItems = buildStripItems(items, selectedId);
  const visibleItems =
    expanded || !overflowing
      ? sortedItems
      : pinSelectedFirst(sortedItems, selectedId);

  const select = (id: string | undefined) => {
    if (id === selectedId) return;
    onSelect(id);
  };

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {overflowing && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? collapseLabel : expandAllLabel}
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      <div
        className={cn(!expanded && "overflow-hidden")}
        style={!expanded ? { maxHeight: collapsedMax } : undefined}
      >
        <div
          ref={contentRef}
          className="relative flex flex-wrap items-center gap-1.5"
          onFocusCapture={(event) => {
            // A keyboard user reaching a clipped chip must be able to see it.
            const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-chip]");
            if (!expanded && chip && chip.offsetTop + chip.offsetHeight > collapsedMax) {
              setExpanded(true);
            }
          }}
        >
          <StripChip
            active={!selectedId}
            label={t("common.all")}
            count={totalCount}
            onClick={() => select(undefined)}
          />
          {visibleItems.map((item) => (
            <StripChip
              key={item.id}
              active={item.id === selectedId}
              label={item.label}
              count={item.count}
              onClick={() => select(item.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
