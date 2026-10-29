import { parseResumeHeaderSnapshot } from "./resumeHeaderSnapshot";
import { parseResumeLayoutConfig } from "./resumeLayoutConfig";
type Row = { id: string; originRefId?: string | null; hiddenAt?: Date | string | null; sortOrder: number };
type Expression = Row & { kind: string; content: string; evidenceLinks: { careerEvidenceId: string; evidenceContentSnapshot?: string; evidenceHashSnapshot?: string }[] };
type Item = Row & { careerMaterialItemId: string | null; itemKind: string; materialTitleSnapshot: string | null; expressions: Expression[] };
type Section = Row & { title: string; systemKind: string | null; items: Item[] };
export type DiffGraph = { headerSnapshot: string | null; layoutConfig: string | null; sections: Section[] };
export type ResumeDiffChange = { path: string; type: "added" | "removed" | "changed" | "moved"; before?: unknown; after?: unknown; matched: "origin" | "fallback" };
const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
/** Both graphs must be loaded through the same user's service and belong to the same variant. */
export function diffResumeVersions(before: DiffGraph, after: DiffGraph, mode: "audit" | "projection" = "audit"): ResumeDiffChange[] {
  if (mode === "projection") {
    const project = (graph: DiffGraph): DiffGraph => ({ ...graph, sections: graph.sections.filter((s) => !s.hiddenAt).map((s) => ({ ...s, items: s.items.filter((i) => !i.hiddenAt).map((i) => ({ ...i, expressions: i.expressions.filter((e) => !e.hiddenAt) })) })) });
    before = project(before); after = project(after);
  }
  const changes: ResumeDiffChange[] = [];
  const changed = (path: string, a: unknown, b: unknown, matched: "origin" | "fallback" = "origin") => {
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path, type: "changed", before: a, after: b, matched });
  };
  changed("header", parseResumeHeaderSnapshot(before.headerSnapshot), parseResumeHeaderSnapshot(after.headerSnapshot));
  changed("layout", parseResumeLayoutConfig(before.layoutConfig), parseResumeLayoutConfig(after.layoutConfig));
  function rows<T extends Row>(a: T[], b: T[], path: string, fallback: (row: T) => string, compare: (a: T, b: T, path: string, matched: "origin" | "fallback") => void) {
    a = a.filter((x) => mode === "audit" || !x.hiddenAt);
    b = b.filter((x) => mode === "audit" || !x.hiddenAt);
    const used = new Set<string>();
    const pairs = new Map<string, T>();
    // id fallback is the lineage assigned to clones of pre-feature rows.
    for (const old of a) {
      const next = b.find((x) => !used.has(x.id) && (x.originRefId ?? x.id) === (old.originRefId ?? old.id));
      if (next) { pairs.set(old.id, next); used.add(next.id); }
    }
    const oldRest = a.filter((x) => !pairs.has(x.id));
    const newRest = b.filter((x) => !used.has(x.id));
    const fallbackPairs = new Set<string>();
    for (const key of new Set(oldRest.map(fallback))) {
      const olds = oldRest.filter((x) => fallback(x) === key);
      const news = newRest.filter((x) => fallback(x) === key);
      if (olds.length !== news.length) continue;
      olds.forEach((old, i) => { if (old.originRefId && news[i].originRefId) return; pairs.set(old.id, news[i]); used.add(news[i].id); fallbackPairs.add(old.id); });
    }
    for (const old of a) {
      const next = pairs.get(old.id), itemPath = `${path}/${old.originRefId ?? old.id}`;
      if (!next) { changes.push({ path: itemPath, type: "removed", before: old, matched: "fallback" }); continue; }
      const matched = fallbackPairs.has(old.id) ? "fallback" : "origin";
      if (old.sortOrder !== next.sortOrder) changes.push({ path: itemPath, type: "moved", before: old.sortOrder, after: next.sortOrder, matched });
      if (mode === "audit") changed(`${itemPath}/hidden`, Boolean(old.hiddenAt), Boolean(next.hiddenAt), matched);
      compare(old, next, itemPath, matched);
    }
    for (const next of b) if (!used.has(next.id)) changes.push({ path: `${path}/${next.originRefId ?? next.id}`, type: "added", after: next, matched: "fallback" });
  }
  rows(before.sections, after.sections, "sections", (x) => x.systemKind ?? normalize(x.title), (a, b, path, matched) => {
    changed(`${path}/title`, a.title, b.title, matched); changed(`${path}/kind`, a.systemKind, b.systemKind, matched);
    rows(a.items, b.items, path, (x) => x.careerMaterialItemId ?? `${x.itemKind}:${x.expressions.map((e) => normalize(e.content)).join("|")}`, (a, b, path, matched) => {
      changed(`${path}/material`, [a.careerMaterialItemId, a.itemKind, a.materialTitleSnapshot], [b.careerMaterialItemId, b.itemKind, b.materialTitleSnapshot], matched);
      rows(a.expressions, b.expressions, path, (x) => x.evidenceLinks.map((l) => l.careerEvidenceId).sort().join("|") || `${x.kind}:${normalize(x.content)}`, (a, b, path, matched) => {
        changed(`${path}/content`, a.content, b.content, matched); changed(`${path}/kind`, a.kind, b.kind, matched);
        const links = (e: Expression) => e.evidenceLinks.map((l) => [l.careerEvidenceId, l.evidenceHashSnapshot ?? l.evidenceContentSnapshot]).sort((a,b) => String(a[0]).localeCompare(String(b[0])));
        changed(`${path}/evidence`, links(a), links(b), matched);
      });
    });
  });
  return changes;
}
