"use client";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DeleteAlertDialog } from "@/components/DeleteAlertDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cloneResumeVersionAsDraft,
  createResumeExpression,
  createResumeSection,
  createResumeSectionItem,
  deleteResumeExpression,
  deleteResumeSection,
  deleteResumeSectionItem,
  freezeResumeVersion,
  getResumeVariant,
  getResumeVariantVersion,
  listResumeCareerMaterials,
  listResumeVariantVersions,
  reorderResumeExpressions,
  reorderResumeSectionItems,
  reorderResumeSections,
  replaceResumeExpressionEvidence,
  updateResumeExpression,
  updateResumeHeaderSnapshot,
  updateResumeSection,
} from "@/actions/resumeVariant.actions";
import { parseResumeHeaderSnapshot } from "@/lib/career/resumeHeaderSnapshot";
import { CAREER_MATERIAL_TYPE, EVIDENCE_STATUS } from "@/lib/career/identities";
import { toastError, toastSuccess } from "@/lib/toast";
import { useSaveStatus } from "@/context/SaveStatusContext";
import { SaveStatusIndicator } from "@/components/SaveStatusIndicator";
import { useI18n } from "@/i18n";
import { ResumePreview } from "./ResumePreview";
import { ResumeVersionDiffView } from "./ResumeVersionDiffView";
import { ResumePagedPreview } from "./ResumePagedPreview";
import { ResumeBuilderDnd, BuilderSortable, BuilderSortableGroup, ResumeMaterialLibrary, type BuilderDrop, type LibraryDrag } from "./ResumeBuilderDnd";
import { parseResumeLayoutConfig } from "@/lib/career/resumeLayoutConfig";
import type { ResumeDiffChange } from "@/lib/career/resumeVersionDiff";
import { setResumeContentHidden, attachResumeMaterial, addResumeEvidence, syncResumeMaterialTitle, updateResumeLayout, listResumeTargetJobs, updateResumeTargetJob, compareResumeVersions, createBlankResumeDraft } from "@/actions/resumeVariant.actions";
import { ResumeExportControl } from "./ResumeExportControl";

const MATERIAL_TYPE_ORDER = [
  CAREER_MATERIAL_TYPE.EDUCATION,
  CAREER_MATERIAL_TYPE.INTERNSHIP,
  CAREER_MATERIAL_TYPE.PROJECT,
  CAREER_MATERIAL_TYPE.RESEARCH,
  CAREER_MATERIAL_TYPE.PUBLICATION,
  CAREER_MATERIAL_TYPE.COMPETITION,
  CAREER_MATERIAL_TYPE.CAMPUS_ACTIVITY,
  CAREER_MATERIAL_TYPE.AWARD,
  CAREER_MATERIAL_TYPE.SKILL,
  CAREER_MATERIAL_TYPE.CERTIFICATION,
  CAREER_MATERIAL_TYPE.EMPLOYMENT,
  CAREER_MATERIAL_TYPE.CUSTOM,
];

type VersionSummary = {
  id: string;
  versionNumber: number;
  status: string;
  currentVersion: boolean;
};

type ExpressionRow = {
  hiddenAt?: string | Date | null;
  originRefId?: string | null;
  id: string;
  kind: string;
  content: string;
  sortOrder: number;
  evidenceStatus: string;
  evidenceLinks: { id: string; careerEvidenceId: string }[];
};

type ItemRow = {
  hiddenAt?: string | Date | null;
  originRefId?: string | null;
  materialTitleSnapshot: string | null;
  id: string;
  itemKind: string;
  careerMaterialItemId: string | null;
  sortOrder: number;
  careerMaterialItem: {
    id: string;
    title: string;
    type: string;
    archivedAt: string | Date | null;
  } | null;
  expressions: ExpressionRow[];
};

type SectionRow = {
  hiddenAt?: string | Date | null;
  originRefId?: string | null;
  id: string;
  title: string;
  systemKind: string | null;
  sortOrder: number;
  items: ItemRow[];
};

type VersionGraph = {
  layoutConfig: string | null;
  id: string;
  status: string;
  headerSnapshot: string | null;
  resumeVariant: { id: string; name: string; archivedAt: string | Date | null };
  submittedAttempts: { id: string }[];
  sections: SectionRow[];
};

type MaterialOption = {
  id: string;
  title: string;
  type: string;
  evidence: { id: string; kind: string; content: string }[];
};

function statusKey(status: string): string {
  if (status === "FROZEN") return "resumeVariants.statusFrozen";
  if (status === "SUBMITTED") return "resumeVariants.statusSubmitted";
  if (status === "ARCHIVED") return "resumeVariants.statusArchived";
  return "resumeVariants.statusDraft";
}

function moveIds(ids: string[], index: number, direction: -1 | 1): string[] | null {
  const next = index + direction;
  if (next < 0 || next >= ids.length) return null;
  const copy = [...ids];
  const [item] = copy.splice(index, 1);
  copy.splice(next, 0, item);
  return copy;
}

export function ResumeVariantWorkspace({
  variantId,
  initialVersionId,
}: {
  variantId: string;
  initialVersionId?: string;
}) {
  const { t } = useI18n();
  const [variantName, setVariantName] = useState("");
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [version, setVersion] = useState<VersionGraph | null>(null);
  const headerDirty = useRef(false);
  const headerRevision = useRef(0);
  const [exportBusy, setExportBusy] = useState(false);
  const loadedVersion = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const [liveExpressions, setLiveExpressions] = useState<Record<string, string>>({});
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<{ id: string; title: string; company: { label: string } | null }[]>([]);
  const [targetJob, setTargetJob] = useState("");
  const [compareId, setCompareId] = useState("");
  const [comparison, setComparison] = useState<{ changes: ResumeDiffChange[]; before: VersionGraph; after: VersionGraph } | null>(null);
  const [headerForm, setHeaderForm] = useState({
    fullName: "",
    headline: "",
    email: "",
    phone: "",
    address: "",
    links: "",
  });
  const [sectionTitle, setSectionTitle] = useState("");
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [materialSectionId, setMaterialSectionId] = useState<string | null>(null);
  const [evidenceExpression, setEvidenceExpression] = useState<{
    expression: ExpressionRow;
    materialId: string | null;
  } | null>(null);
  const [selectedEvidenceIds, setSelectedEvidenceIds] = useState<string[]>([]);
  const [expressionDrafts, setExpressionDrafts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{
    kind: "section" | "item" | "freeze";
    id: string;
  } | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(
    async (preferredVersionId?: string) => {
      const sequence = ++loadSequence.current;
      const [variantResult, versionList] = await Promise.all([
        getResumeVariant(variantId),
        listResumeVariantVersions(variantId),
      ]);
      if (sequence !== loadSequence.current) return;
      if (!variantResult.success || !versionList.success) {
        setLoadError(true);
        toastError(
          (!variantResult.success ? variantResult.message : !versionList.success ? versionList.message : "") ||
            t("resumeVariants.loadFailed"),
        );
        return;
      }
      const summary = variantResult.data as {
        name: string;
        currentVersionId: string | null;
      };
      const list = (versionList.data as VersionSummary[]) ?? [];
      setVariantName(summary.name);
      setTargetJob((variantResult.data as { targetJobOpportunityId?: string | null }).targetJobOpportunityId ?? "");
      setVersions(list);
      // Fail closed (defense-in-depth): an explicitly requested version that
      // is missing from this variant list must surface a safe load error
      // instead of silently falling back to the current version. An omitted
      // preferredVersionId keeps the current-version fallback.
      if (
        preferredVersionId &&
        !list.some((row) => row.id === preferredVersionId)
      ) {
        setLoadError(true);
        toastError(t("resumeVariants.loadFailed"));
        return;
      }
      setLoadError(false);
      const nextId =
        preferredVersionId ??
        summary.currentVersionId ??
        list[list.length - 1]?.id ??
        null;
      setSelectedVersionId(nextId);
      if (!nextId) {
        setVersion(null);
        return;
      }
      const graph = await getResumeVariantVersion(nextId);
      if (sequence !== loadSequence.current) return;
      if (!graph.success) {
        toastError(graph.message);
        return;
      }
      const loaded = graph.data as VersionGraph;
      setVersion(loaded);
      const changedVersion = loadedVersion.current !== loaded.id;
      if (changedVersion) { setLiveExpressions({}); setLiveTitles({}); setComparison(null); headerDirty.current = false; }
      loadedVersion.current = loaded.id;
      const header = parseResumeHeaderSnapshot(loaded.headerSnapshot);
      if (!headerDirty.current) setHeaderForm({
        fullName: header.fullName ?? "",
        headline: header.headline ?? "",
        email: header.email ?? "",
        phone: header.phone ?? "",
        address: header.address ?? "",
        links: header.links.map((link) => link.url).join("\n"),
      });
    },
    [t, variantId],
  );

  useEffect(() => {
    void load(initialVersionId);
  }, [load, initialVersionId]);

  useEffect(() => {
    let active = true;
    void listResumeCareerMaterials().then((result) => { if (active && result.success) setMaterials((result.data as MaterialOption[]) ?? []); });
    void listResumeTargetJobs().then((result) => { if (active && result.success) setJobs(result.data as typeof jobs); });
    return () => { active = false; };
  }, []);
  const editable = Boolean(
    version &&
      !exportBusy &&
      version.status === "DRAFT" &&
      !version.resumeVariant.archivedAt &&
      version.submittedAttempts.length === 0,
  );

  const groupedMaterials = useMemo(() => {
    const groups = new Map<string, MaterialOption[]>();
    for (const type of MATERIAL_TYPE_ORDER) groups.set(type, []);
    for (const material of materials) {
      const list = groups.get(material.type) ?? [];
      list.push(material);
      groups.set(material.type, list);
    }
    return [...groups.entries()].filter(([, list]) => list.length > 0);
  }, [materials]);

  const previewHeader = useMemo(() => JSON.stringify({ ...headerForm, links: headerForm.links.split(/\r?\n/).filter(Boolean) }), [headerForm]);
  const previewSections = useMemo(() => version?.sections.map((section) => ({ ...section, title: liveTitles[section.id] ?? section.title, items: section.items.map((item) => ({ ...item, expressions: item.expressions.map((expression) => ({ ...expression, content: liveExpressions[expression.id] ?? expression.content })) })) })) ?? [], [version, liveTitles, liveExpressions]);
  const saveStatus = useSaveStatus();
  // announce="status" routes success to the quiet shell indicator instead of a
  // toast — used by implicit saves (blur edits, reorders). Create/delete/
  // freeze and explicit Save buttons keep announcing via toast.
  const run = async (
    result: Promise<{ success: boolean; message?: string }>,
    ok: string,
    announce: "toast" | "status" = "status",
  ) => {
    const seq = saveStatus.begin();
    const resolved = await result;
    if (!resolved.success) {
      saveStatus.finish(seq, false);
      toastError(resolved.message || t("resumeVariants.saveFailed"), undefined, { sticky: true });
      return false;
    }
    saveStatus.finish(seq, true);
    if (announce === "toast") toastSuccess(ok);
    return true;
  };

  const reloadSelected = async (versionId = selectedVersionId) => {
    if (versionId) await load(versionId);
    else await load();
  };

  const applyBuilder = async (action: Promise<{ success: boolean; message?: string }>) => {
    if (await run(action, t("resumeVariants.saveSuccess"))) await reloadSelected();
  };
  const sortBuilder = async (target: BuilderDrop, orderedIds: string[]) => {
    await applyBuilder(target.kind === "section" ? reorderResumeSections({ versionId: target.parentId, orderedIds }) : target.kind === "item" ? reorderResumeSectionItems({ sectionId: target.parentId, orderedIds }) : reorderResumeExpressions({ itemId: target.parentId, orderedIds }));
  };
  const attachBuilder = async (source: LibraryDrag, target: BuilderDrop) => {
    if (source.evidenceId && target.kind === "item" && target.materialId === source.materialId) await applyBuilder(addResumeEvidence({ itemId: target.id, evidenceId: source.evidenceId }));
    else {
      const section = version?.sections.find((s) => s.id === target.id || s.items.some((i) => i.id === target.id || i.expressions.some((e) => e.id === target.id)));
      if (section) await applyBuilder(attachResumeMaterial({ sectionId: section.id, materialId: source.materialId, evidenceId: source.evidenceId }));
    }
  };
  const visibility = (kind: "section" | "item" | "expression", id: string, hidden: boolean) => <Button size="sm" variant="ghost" onClick={() => void applyBuilder(setResumeContentHidden({ kind, id, hidden: !hidden }))}>{t(hidden ? "resumeBuilder.show" : "resumeBuilder.hide")}</Button>;

  const flushDraft = async (): Promise<boolean> => {
    if (!version || !editable) return true;
    if (headerDirty.current) {
      if (!(await run(updateResumeHeaderSnapshot({ versionId: version.id, ...headerForm, links: headerForm.links.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }), t("resumeVariants.saveSuccess")))) return false;
      headerDirty.current = false;
    }
    for (const section of version.sections) {
      const title = liveTitles[section.id];
      if (title !== undefined && title !== section.title) {
        if (!title.trim()) { toastError(t("resumeVariants.sectionTitlePlaceholder")); return false; }
        if (!(await run(updateResumeSection({ sectionId: section.id, title }), t("resumeVariants.saveSuccess")))) return false;
        setLiveTitles((current) => { if (current[section.id] !== title) return current; const next = { ...current }; delete next[section.id]; return next; });
      }
      for (const item of section.items) for (const expression of item.expressions) {
        const content = liveExpressions[expression.id];
        if (content !== undefined && content !== expression.content) {
          if (!content.trim()) { toastError(t("resumeVariants.expressionPlaceholder")); return false; }
          if (!(await run(updateResumeExpression({ expressionId: expression.id, content }), t("resumeVariants.saveSuccess")))) return false;
          setLiveExpressions((current) => { if (current[expression.id] !== content) return current; const next = { ...current }; delete next[expression.id]; return next; });
        }
      }
    }
    await reloadSelected(version.id);
    return true;
  };

  const openMaterialPicker = async (sectionId: string) => {
    const result = await listResumeCareerMaterials();
    if (!result.success) {
      toastError(result.message);
      return;
    }
    setMaterials((result.data as MaterialOption[]) ?? []);
    setMaterialSectionId(sectionId);
  };

  const saveHeader = async () => {
    if (!version) return;
    const revision = headerRevision.current;
    const ok = await run(
      updateResumeHeaderSnapshot({
        versionId: version.id,
        fullName: headerForm.fullName,
        headline: headerForm.headline,
        email: headerForm.email,
        phone: headerForm.phone,
        address: headerForm.address,
        links: headerForm.links
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      }),
      t("resumeVariants.saveSuccess"),
      "toast",
    );
    if (ok) { if (revision === headerRevision.current) headerDirty.current = false; await reloadSelected(version.id); }
  };

  const addSection = async () => {
    if (!version) return;
    const title = sectionTitle.trim() || t("resumeVariants.sectionTitlePlaceholder");
    const ok = await run(
      createResumeSection({ versionId: version.id, title }),
      t("resumeVariants.saveSuccess"),
      "toast",
    );
    if (ok) {
      setSectionTitle("");
      await reloadSelected(version.id);
    }
  };

  const confirmAction = async () => {
    if (!confirm || !version) return;
    if (confirm.kind === "section") {
      const ok = await run(deleteResumeSection(confirm.id), t("resumeVariants.saveSuccess"), "toast");
      if (ok) await reloadSelected(version.id);
    } else if (confirm.kind === "item") {
      const ok = await run(deleteResumeSectionItem(confirm.id), t("resumeVariants.saveSuccess"), "toast");
      if (ok) await reloadSelected(version.id);
    } else {
      if (!(await flushDraft())) return;
      const ok = await run(freezeResumeVersion(confirm.id), t("resumeVariants.freezeSuccess"), "toast");
      if (ok) await reloadSelected(confirm.id);
    }
    setConfirm(null);
  };

  if (loadError) {
    return (
      <div>
        <p className="text-sm text-muted-foreground">{t("resumeVariants.variantNotFound")}</p>
        <Link className="text-sm text-primary underline" href="/dashboard/profile/resumes">
          {t("resumeVariants.backToList")}
        </Link>
      </div>
    );
  }

  if (!version) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }

  const evidenceMaterial = evidenceExpression?.materialId
    ? materials.find((row) => row.id === evidenceExpression.materialId) ??
      null
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link className="text-sm text-primary underline" href="/dashboard/profile/resumes">
            {t("resumeVariants.backToList")}
          </Link>
          <h1 className="mt-2 text-xl font-semibold">{variantName}</h1>
          <p className="text-sm text-muted-foreground">
            {t(statusKey(version.status))}
            {editable ? "" : ` · ${t("resumeVariants.readOnly")}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Autosave feedback sits inside the editor's own action row rather
              than a window-wide status bar. */}
          <SaveStatusIndicator />
          <ResumeExportControl key={version.id} versionId={version.id} status={version.status} beforeExport={flushDraft} onBusyChange={setExportBusy}
            archived={Boolean(version.resumeVariant.archivedAt)} onFrozen={(id) => {
              setVersion((current) => current?.id === id ? { ...current, status: "FROZEN" } : current);
              setVersions((current) => current.map((row) => row.id === id ? { ...row, status: "FROZEN" } : row));
            }} />
          {editable ? (
            <Button variant="outline" onClick={() => setConfirm({ kind: "freeze", id: version.id })}>
              {t("resumeVariants.freeze")}
            </Button>
          ) : version.status === "FROZEN" || version.status === "SUBMITTED" ? (
            <Button
              onClick={async () => {
                if (!(await flushDraft())) return;
                const ok = await run(
                  cloneResumeVersionAsDraft(version.id),
                  t("resumeVariants.cloneSuccess"),
                  "toast",
                );
                if (ok) await load();
              }}
            >
              {t("resumeVariants.createNewDraft")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="resume-version-switcher">
        {versions.map((row) => (
          <Button
            key={row.id}
            size="sm"
            variant={row.id === version.id ? "default" : "outline"}
            onClick={async () => { if (await flushDraft()) await load(row.id); }}
          >
            {t("resumeVariants.versionNumber", { number: row.versionNumber })}
            {" · "}
            {t(statusKey(row.status))}
            {row.currentVersion ? ` · ${t("resumeVariants.currentVersion")}` : ""}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <label className="text-sm">{t("resumeBuilder.targetJob")}<select className="ml-2 max-w-xs rounded border bg-background p-2" value={targetJob} disabled={Boolean(version.resumeVariant.archivedAt)} onChange={(e) => void applyBuilder(updateResumeTargetJob({ versionId: version.id, jobId: e.target.value || null }))}>
          <option value="">{t("resumeBuilder.noTargetJob")}</option>
          {targetJob && !jobs.some((job) => job.id === targetJob) && <option value={targetJob}>{t("resumeBuilder.unavailableJob")}</option>}
          {jobs.map((job) => <option key={job.id} value={job.id}>{job.company?.label ? `${job.company.label} · ` : ""}{job.title}</option>)}
        </select></label>
        <label className="text-sm">{t("resumeBuilder.template")}<select className="ml-2 rounded border bg-background p-2" disabled><option>{t("resumeBuilder.standardTemplate")}</option></select></label>
        <label className="text-sm">{t("resumeBuilder.pageTarget")}<select className="ml-2 rounded border bg-background p-2" value={parseResumeLayoutConfig(version.layoutConfig).pageTarget ?? ""} disabled={!editable} onChange={(e) => void applyBuilder(updateResumeLayout({ versionId: version.id, pageTarget: e.target.value === "1" ? 1 : e.target.value === "2" ? 2 : null }))}>
          <option value="">{t("resumeBuilder.unlimitedPages")}</option><option value="1">1</option><option value="2">2</option>
        </select></label>
        <Button variant="outline" disabled={Boolean(version.resumeVariant.archivedAt)} onClick={async () => { if (!(await flushDraft())) return; if (await run(createBlankResumeDraft(variantId), t("resumeVariants.saveSuccess"))) await load(); }}>{t("resumeBuilder.blankDraft")}</Button>
        <Button variant="outline" disabled={Boolean(version.resumeVariant.archivedAt)} onClick={async () => { if (!(await flushDraft())) return; if (await run(cloneResumeVersionAsDraft(version.id), t("resumeVariants.cloneSuccess"))) await load(); }}>{t("resumeBuilder.cloneVersion")}</Button>
        <label className="text-sm">{t("resumeBuilder.compare")}<select aria-label={t("resumeBuilder.compare")} className="ml-2 rounded border bg-background p-2" value={compareId} onChange={(e) => { setCompareId(e.target.value); setComparison(null); }}><option value="">—</option>{versions.filter((v) => v.id !== version.id).map((v) => <option key={v.id} value={v.id}>v{v.versionNumber}</option>)}</select></label>
        <Button variant="outline" disabled={!compareId} onClick={async () => { const result = await compareResumeVersions({ beforeId: compareId, afterId: version.id }); if (result.success) setComparison(result.data as typeof comparison); else toastError(result.message); }}>{t("resumeBuilder.compare")}</Button>
      </div>
      <ResumeBuilderDnd disabled={!editable} onSort={sortBuilder} onAttach={attachBuilder}>
      <div className="grid items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <ResumeMaterialLibrary materials={materials} sections={version.sections} disabled={!editable} onAdd={(source, sectionId) => void applyBuilder(attachResumeMaterial({ sectionId, materialId: source.materialId, evidenceId: source.evidenceId }))} />
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("resumeVariants.headerTitle")}</CardTitle>
              <p className="text-sm text-muted-foreground">{t("resumeVariants.headerHint")}</p>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["fullName", "fieldFullName"],
                  ["headline", "fieldHeadline"],
                  ["email", "fieldEmail"],
                  ["phone", "fieldPhone"],
                  ["address", "fieldAddress"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="text-sm">
                  <span className="mb-1 block text-muted-foreground">
                    {t(`resumeVariants.${label}`)}
                  </span>
                  <Input
                    value={headerForm[key]}
                    disabled={!editable}
                    onChange={(event) =>
                      { headerDirty.current = true; headerRevision.current += 1; setHeaderForm((current) => ({ ...current, [key]: event.target.value })); }
                    }
                  />
                </label>
              ))}
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block text-muted-foreground">
                  {t("resumeVariants.fieldLinks")}
                </span>
                <Textarea
                  value={headerForm.links}
                  disabled={!editable}
                  onChange={(event) =>
                    { headerDirty.current = true; headerRevision.current += 1; setHeaderForm((current) => ({ ...current, links: event.target.value })); }
                  }
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t("resumeVariants.fieldLinksHint")}
                </span>
              </label>
              {editable ? (
                <div>
                  <Button size="sm" onClick={() => void saveHeader()}>
                    {t("common.save")}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {editable ? (
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-sm"
                value={sectionTitle}
                placeholder={t("resumeVariants.sectionTitlePlaceholder")}
                onChange={(event) => setSectionTitle(event.target.value)}
              />
              <Button onClick={() => void addSection()}>{t("resumeVariants.addSection")}</Button>
            </div>
          ) : null}

          {version.sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("resumeVariants.noSections")}</p>
          ) : (
            <BuilderSortableGroup ids={version.sections.map((s) => s.id)}>{version.sections.map((section, sectionIndex) => (
              <BuilderSortable key={section.id} disabled={!editable} hidden={Boolean(section.hiddenAt)} data={{ id: section.id, kind: "section", parentId: version.id, orderedIds: version.sections.map((s) => s.id) }}><Card>
                <CardHeader className="flex flex-col gap-2 space-y-0">
                  {editable ? (
                    <Input
                      className="max-w-md font-medium"
                      value={liveTitles[section.id] ?? section.title}
                      onChange={(e) => setLiveTitles((current) => ({ ...current, [section.id]: e.target.value }))}
                      onBlur={(event) => {
                        const title = event.target.value.trim();
                        if (!title || title === section.title) return;
                        void run(
                          updateResumeSection({ sectionId: section.id, title }),
                          t("resumeVariants.saveSuccess"),
                        ).then((ok) => {
                          if (ok) { setLiveTitles((current) => { if (current[section.id]?.trim() !== title) return current; const next = { ...current }; delete next[section.id]; return next; }); void reloadSelected(version.id); }
                        });
                      }}
                    />
                  ) : (
                    <CardTitle className="text-base">{section.title}</CardTitle>
                  )}
                  {editable ? (
                    <div className="flex flex-wrap gap-1">
                      {visibility("section", section.id, Boolean(section.hiddenAt))}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={sectionIndex === 0}
                        onClick={() => {
                          const ordered = moveIds(
                            version.sections.map((row) => row.id),
                            sectionIndex,
                            -1,
                          );
                          if (!ordered) return;
                          void run(
                            reorderResumeSections({ versionId: version.id, orderedIds: ordered }),
                            t("resumeVariants.saveSuccess"),
                          ).then((ok) => {
                            if (ok) void reloadSelected(version.id);
                          });
                        }}
                      >
                        {t("resumeVariants.moveUp")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={sectionIndex === version.sections.length - 1}
                        onClick={() => {
                          const ordered = moveIds(
                            version.sections.map((row) => row.id),
                            sectionIndex,
                            1,
                          );
                          if (!ordered) return;
                          void run(
                            reorderResumeSections({ versionId: version.id, orderedIds: ordered }),
                            t("resumeVariants.saveSuccess"),
                          ).then((ok) => {
                            if (ok) void reloadSelected(version.id);
                          });
                        }}
                      >
                        {t("resumeVariants.moveDown")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm({ kind: "section", id: section.id })}
                      >
                        {t("resumeVariants.deleteSection")}
                      </Button>
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-4">
                  <BuilderSortableGroup ids={section.items.map((i) => i.id)}>{section.items.map((item, itemIndex) => (
                    <BuilderSortable key={item.id} disabled={!editable} hidden={Boolean(item.hiddenAt)} data={{ id: item.id, kind: "item", parentId: section.id, materialId: item.careerMaterialItemId, orderedIds: section.items.map((i) => i.id) }}><div className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-medium">
                            {item.materialTitleSnapshot ?? t("resumeVariants.manualItem")}
                          </p>
                          {item.careerMaterialItem ? (
                            <p className="text-xs text-muted-foreground">
                              {t(
                                `applicationProfile.materialType${item.careerMaterialItem.type}`,
                              )}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {item.careerMaterialItem ? (
                            <Button size="sm" variant="link" asChild>
                              <Link href="/dashboard/profile/application">
                                {t("resumeVariants.viewMaterial")}
                              </Link>
                            </Button>
                          ) : null}
                          {editable ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={itemIndex === 0}
                                onClick={() => {
                                  const ordered = moveIds(
                                    section.items.map((row) => row.id),
                                    itemIndex,
                                    -1,
                                  );
                                  if (!ordered) return;
                                  void run(
                                    reorderResumeSectionItems({
                                      sectionId: section.id,
                                      orderedIds: ordered,
                                    }),
                                    t("resumeVariants.saveSuccess"),
                                  ).then((ok) => {
                                    if (ok) void reloadSelected(version.id);
                                  });
                                }}
                              >
                                {t("resumeVariants.moveUp")}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={itemIndex === section.items.length - 1}
                                onClick={() => {
                                  const ordered = moveIds(
                                    section.items.map((row) => row.id),
                                    itemIndex,
                                    1,
                                  );
                                  if (!ordered) return;
                                  void run(
                                    reorderResumeSectionItems({
                                      sectionId: section.id,
                                      orderedIds: ordered,
                                    }),
                                    t("resumeVariants.saveSuccess"),
                                  ).then((ok) => {
                                    if (ok) void reloadSelected(version.id);
                                  });
                                }}
                              >
                                {t("resumeVariants.moveDown")}
                              </Button>
                              {visibility("item", item.id, Boolean(item.hiddenAt))}
                              {item.careerMaterialItemId && <Button size="sm" variant="ghost" onClick={() => void applyBuilder(syncResumeMaterialTitle(item.id))}>{t("resumeBuilder.syncTitle")}</Button>}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfirm({ kind: "item", id: item.id })}
                              >
                                {t("resumeVariants.deleteItem")}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-3 space-y-2">
                        {item.expressions.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            {t("resumeVariants.noExpressions")}
                          </p>
                        ) : (
                          <BuilderSortableGroup ids={item.expressions.map((e) => e.id)}>{item.expressions.map((expression, expressionIndex) => (
                            <BuilderSortable key={expression.id} disabled={!editable} hidden={Boolean(expression.hiddenAt)} data={{ id: expression.id, kind: "expression", parentId: item.id, orderedIds: item.expressions.map((e) => e.id) }}><div className="rounded-md bg-muted/40 p-2">
                              {editable ? (
                                <Textarea
                                  value={liveExpressions[expression.id] ?? expression.content}
                                  onChange={(e) => setLiveExpressions((current) => ({ ...current, [expression.id]: e.target.value }))}
                                  onBlur={(event) => {
                                    const content = event.target.value.trim();
                                    if (!content || content === expression.content) return;
                                    void run(
                                      updateResumeExpression({
                                        expressionId: expression.id,
                                        content,
                                      }),
                                      t("resumeVariants.saveSuccess"),
                                    ).then((ok) => {
                                      if (ok) { setLiveExpressions((current) => { if (current[expression.id]?.trim() !== content) return current; const next = { ...current }; delete next[expression.id]; return next; }); void reloadSelected(version.id); }
                                    });
                                  }}
                                />
                              ) : (
                                <p className="whitespace-pre-wrap text-sm">{expression.content}</p>
                              )}
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                                {expression.evidenceStatus === EVIDENCE_STATUS.UNLINKED ? (
                                  <span className="text-amber-700">
                                    {t("resumeVariants.unlinked")} · {t("resumeVariants.unlinkedWarning")}
                                  </span>
                                ) : (
                                  <span>
                                    {t("resumeVariants.linkedEvidence", {
                                      count: expression.evidenceLinks.length,
                                    })}
                                  </span>
                                )}
                                {editable ? (
                                  <>
                                    {visibility("expression", expression.id, Boolean(expression.hiddenAt))}
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={async () => {
                                        if (item.careerMaterialItemId && materials.length === 0) {
                                          const result = await listResumeCareerMaterials();
                                          if (result.success) {
                                            setMaterials((result.data as MaterialOption[]) ?? []);
                                          }
                                        }
                                        setEvidenceExpression({
                                          expression,
                                          materialId: item.careerMaterialItemId,
                                        });
                                        setSelectedEvidenceIds(
                                          expression.evidenceLinks.map((link) => link.careerEvidenceId),
                                        );
                                      }}
                                    >
                                      {t("resumeVariants.linkEvidence")}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={expressionIndex === 0}
                                      onClick={() => {
                                        const ordered = moveIds(
                                          item.expressions.map((row) => row.id),
                                          expressionIndex,
                                          -1,
                                        );
                                        if (!ordered) return;
                                        void run(
                                          reorderResumeExpressions({
                                            itemId: item.id,
                                            orderedIds: ordered,
                                          }),
                                          t("resumeVariants.saveSuccess"),
                                        ).then((ok) => {
                                          if (ok) void reloadSelected(version.id);
                                        });
                                      }}
                                    >
                                      {t("resumeVariants.moveUp")}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={expressionIndex === item.expressions.length - 1}
                                      onClick={() => {
                                        const ordered = moveIds(
                                          item.expressions.map((row) => row.id),
                                          expressionIndex,
                                          1,
                                        );
                                        if (!ordered) return;
                                        void run(
                                          reorderResumeExpressions({
                                            itemId: item.id,
                                            orderedIds: ordered,
                                          }),
                                          t("resumeVariants.saveSuccess"),
                                        ).then((ok) => {
                                          if (ok) void reloadSelected(version.id);
                                        });
                                      }}
                                    >
                                      {t("resumeVariants.moveDown")}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        void run(
                                          deleteResumeExpression(expression.id),
                                          t("resumeVariants.saveSuccess"),
                                          "toast",
                                        ).then((ok) => {
                                          if (ok) void reloadSelected(version.id);
                                        });
                                      }}
                                    >
                                      {t("resumeVariants.deleteExpression")}
                                    </Button>
                                  </>
                                ) : null}
                              </div>
                            </div></BuilderSortable>
                          ))}</BuilderSortableGroup>
                        )}
                        {editable ? (
                          <div className="flex flex-wrap gap-2">
                            <Input
                              className="max-w-xl"
                              value={expressionDrafts[item.id] ?? ""}
                              placeholder={t("resumeVariants.expressionPlaceholder")}
                              onChange={(event) =>
                                setExpressionDrafts((current) => ({
                                  ...current,
                                  [item.id]: event.target.value,
                                }))
                              }
                            />
                            <Button
                              size="sm"
                              onClick={() => {
                                const content = (expressionDrafts[item.id] ?? "").trim();
                                if (!content) return;
                                void run(
                                  createResumeExpression({ itemId: item.id, content }),
                                  t("resumeVariants.saveSuccess"),
                                  "toast",
                                ).then((ok) => {
                                  if (ok) {
                                    setExpressionDrafts((current) => ({ ...current, [item.id]: "" }));
                                    void reloadSelected(version.id);
                                  }
                                });
                              }}
                            >
                              {t("resumeVariants.addExpression")}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div></BuilderSortable>
                  ))}</BuilderSortableGroup>

                  {editable ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void openMaterialPicker(section.id)}
                      >
                        {t("resumeVariants.addMaterial")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          void run(
                            createResumeSectionItem({ sectionId: section.id }),
                            t("resumeVariants.saveSuccess"),
                            "toast",
                          ).then((ok) => {
                            if (ok) void reloadSelected(version.id);
                          });
                        }}
                      >
                        {t("resumeVariants.addManualItem")}
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card></BuilderSortable>
            ))}</BuilderSortableGroup>
          )}
        </div>
        <div className="min-w-0 lg:sticky lg:top-4 lg:max-h-[85vh] lg:overflow-y-auto"><ResumePagedPreview headerSnapshot={previewHeader} sections={previewSections} pageTarget={parseResumeLayoutConfig(version.layoutConfig).pageTarget} /></div>
        </div>
      </div>
      </ResumeBuilderDnd>
      <Dialog open={comparison !== null} onOpenChange={(open) => { if (!open) setComparison(null); }}><DialogContent className="!max-w-[95vw] max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{t("resumeBuilder.compare")}</DialogTitle></DialogHeader>
        {comparison && <><p className="text-xs text-muted-foreground">{t("resumeBuilder.auditHint")}</p>
        <ResumeVersionDiffView changes={comparison.changes} />
        <div className="grid gap-3 lg:grid-cols-2"><ResumePreview headerSnapshot={comparison.before.headerSnapshot} sections={comparison.before.sections} /><ResumePreview headerSnapshot={comparison.after.headerSnapshot} sections={comparison.after.sections} /></div></>}
      </DialogContent></Dialog>

      {editable ? (
        <p className="text-xs text-muted-foreground">{t("resumeVariants.freezeHint")}</p>
      ) : version.status === "FROZEN" || version.status === "SUBMITTED" ? (
        <p className="text-xs text-muted-foreground">{t("resumeVariants.createNewDraftHint")}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("resumeVariants.staleEvidenceNote")}</p>

      <Dialog
        open={materialSectionId != null}
        onOpenChange={(open) => {
          if (!open) setMaterialSectionId(null);
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("resumeVariants.materialPickerTitle")}</DialogTitle>
          </DialogHeader>
          {groupedMaterials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("resumeVariants.materialPickerEmpty")}
            </p>
          ) : (
            groupedMaterials.map(([type, list]) => (
              <div key={type} className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t(`applicationProfile.materialType${type}`)}
                </h3>
                {list.map((material) => (
                  <button
                    key={material.id}
                    className="block w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      if (!materialSectionId) return;
                      void run(
                        attachResumeMaterial({
                          sectionId: materialSectionId,
                          materialId: material.id,
                        }),
                        t("resumeVariants.saveSuccess"),
                        "toast",
                      ).then((ok) => {
                        if (ok) {
                          setMaterialSectionId(null);
                          void reloadSelected(version.id);
                        }
                      });
                    }}
                  >
                    {material.title}
                  </button>
                ))}
              </div>
            ))
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={evidenceExpression != null}
        onOpenChange={(open) => {
          if (!open) setEvidenceExpression(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("resumeVariants.evidencePickerTitle")}</DialogTitle>
          </DialogHeader>
          {!evidenceExpression?.materialId ? (
            <p className="text-sm text-muted-foreground">
              {t("resumeVariants.evidencePickerManual")}
            </p>
          ) : !evidenceMaterial || evidenceMaterial.evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("resumeVariants.evidencePickerEmpty")}
            </p>
          ) : (
            <div className="space-y-2">
              {evidenceMaterial.evidence.map((evidence) => {
                const checked = selectedEvidenceIds.includes(evidence.id);
                return (
                  <label key={evidence.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setSelectedEvidenceIds((current) =>
                          checked
                            ? current.filter((id) => id !== evidence.id)
                            : [...current, evidence.id],
                        );
                      }}
                    />
                    <span>{evidence.content}</span>
                  </label>
                );
              })}
              <Button
                size="sm"
                onClick={() => {
                  if (!evidenceExpression) return;
                  void run(
                    replaceResumeExpressionEvidence({
                      expressionId: evidenceExpression.expression.id,
                      evidenceIds: selectedEvidenceIds,
                    }),
                    t("resumeVariants.saveSuccess"),
                    "toast",
                  ).then((ok) => {
                    if (ok) {
                      setEvidenceExpression(null);
                      void reloadSelected(version.id);
                    }
                  });
                }}
              >
                {t("common.save")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <DeleteAlertDialog
        pageTitle=""
        open={confirm != null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        onDelete={() => void confirmAction()}
        alertTitle={
          confirm?.kind === "freeze"
            ? t("resumeVariants.freezeConfirmTitle")
            : confirm?.kind === "section"
              ? t("resumeVariants.deleteSectionConfirm")
              : t("resumeVariants.deleteItemConfirm")
        }
        alertDescription={
          confirm?.kind === "freeze"
            ? t("resumeVariants.freezeConfirmDescription")
            : t("resumeBuilder.deleteWarning")
        }
        actionLabel={
          confirm?.kind === "freeze" ? t("resumeVariants.freeze") : t("common.delete")
        }
        actionVariant={confirm?.kind === "freeze" ? "default" : "destructive"}
      />
    </div>
  );
}
