"use client";
import { useEffect, useRef, useState } from "react";
import { ResumePreview } from "./ResumePreview";
import { useI18n } from "@/i18n";
import type { ComponentProps } from "react";
type Props = ComponentProps<typeof ResumePreview> & { pageTarget: 1 | 2 | null };
export type FragmentPages = { pageCount: number; blocks: Record<string, number[]> };
/** Text ranges include every fragment of a cross-page block, unlike offsetLeft. */
export function measureResumeFragments(root: HTMLElement): FragmentPages {
  const bounds = root.getBoundingClientRect(), width = bounds.width;
  const blocks: Record<string, number[]> = {};
  let max = 0;
  if (!width) return { pageCount: 1, blocks };
  const pageForRect = (rect: DOMRect) => Math.max(0, Math.floor((rect.left - bounds.left + 0.5) / width));
  root.querySelectorAll<HTMLElement>("[data-resume-block]").forEach((block) => {
    const pages = new Set<number>();
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      for (const rect of Array.from(range.getClientRects())) if (rect.width && rect.height) pages.add(pageForRect(rect));
      range.detach();
    }
    if (!pages.size) for (const rect of Array.from(block.getClientRects())) if (rect.height) pages.add(pageForRect(rect));
    blocks[block.dataset.resumeBlock!] = [...pages].sort((a, b) => a - b).map((p) => p + 1);
    for (const page of pages) max = Math.max(max, page);
  });
  // Header-only resumes and headers that spill over a page also count.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent?.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(walker.currentNode);
    for (const rect of Array.from(range.getClientRects())) if (rect.width && rect.height) max = Math.max(max, pageForRect(rect));
    range.detach();
  }
  return { pageCount: max + 1, blocks };
}
export function ResumePagedPreview({ headerSnapshot, sections, pageTarget }: Props) {
  const { t } = useI18n(); const measure = useRef<HTMLDivElement>(null); const container = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState<FragmentPages | null>(null); const [scale, setScale] = useState(0.6);
  useEffect(() => {
    let disposed = false; let frame = 0;
    setMeasurement(null);
    const run = () => { if (!disposed && measure.current) setMeasurement(measureResumeFragments(measure.current)); };
    void (document.fonts?.ready ?? Promise.resolve()).then(() => { frame = requestAnimationFrame(run); });
    return () => { disposed = true; cancelAnimationFrame(frame); };
  }, [headerSnapshot, sections]);
  useEffect(() => {
    const node = container.current; if (!node) return;
    const resize = () => setScale(Math.min(1, node.clientWidth / (210 * 96 / 25.4)));
    resize(); const observer = new ResizeObserver(resize); observer.observe(node); return () => observer.disconnect();
  }, []);
  const pageCount = measurement?.pageCount ?? 1;
  const content = <ResumePreview print headerSnapshot={headerSnapshot} sections={sections} />;
  return <div ref={container} className="min-w-0 space-y-3" data-testid="resume-paged-preview">
    <p className="text-xs text-muted-foreground">{t("resumeBuilder.paginationHint")}</p>
    <p role="status" className="text-sm">{measurement ? t("resumeBuilder.pageCount", { count: pageCount }) : t("common.loading")}</p>
    {measurement && pageTarget && pageCount > pageTarget ? <p role="status" className="text-sm text-amber-700">{t("resumeBuilder.overflow", { count: pageCount, target: pageTarget })}</p> : null}
    <div aria-hidden="true" style={{ position: "fixed", left: -100000, top: 0, width: "180mm", visibility: "hidden", pointerEvents: "none" }}><div ref={measure} className="resume-fragment-columns">{content}</div></div>
    {Array.from({ length: pageCount }, (_, page) => <div key={page}>
      <div style={{ height: 297 * 96 / 25.4 * scale, position: "relative" }}>
        <div className="border bg-white shadow-sm" style={{ width: "210mm", height: "297mm", padding: "15mm", position: "absolute", top: 0, left: 0, transform: `scale(${scale})`, transformOrigin: "top left", overflow: "hidden" }}>
          <div style={{ width: "180mm", height: "267mm", overflow: "hidden" }}><div className="resume-fragment-columns" style={{ transform: `translateX(-${page * 180}mm)` }}>{content}</div></div>
        </div>
      </div><p className="text-center text-xs text-muted-foreground">{page + 1} / {pageCount}</p>
    </div>)}
  </div>;
}
