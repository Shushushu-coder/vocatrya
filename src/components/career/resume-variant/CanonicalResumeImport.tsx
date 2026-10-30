"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import type { ParsedResumeImport } from "@/lib/career/resumeImportContract";
import { importItemRef } from "@/lib/career/resumeImportSelection";

type Preview = { parsed: ParsedResumeImport; rawText: string; name: string; approval: string;
  previewRefs?: string[];
  summary: { created: number; reused: number; conflicts: string[] } };

export function CanonicalResumeImport() {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "extracting" | "parsing" | "saving">("idle");
  const [preview, setPreview] = useState<Preview | null>(null);
  // Item-level exclusion: refs the user unchecked. Default keeps everything.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [excludeProfile, setExcludeProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  // Durable import identity: one opaque id per logical import, reused by
  // every retry of the same upload so the server replays one operation.
  const requestId = useRef<string | null>(null);
  // The file behind the current requestId — lets a failed upload retry
  // under the same durable identity instead of minting a new import.
  const selectedFile = useRef<File | null>(null);
  const active = phase !== "idle";
  const cancel = () => {
    controller.current?.abort();
    requestId.current = null;
    selectedFile.current = null;
    setPreview(null); setError(null); setOpen(false); setPhase("idle");
    setExcluded(new Set()); setExcludeProfile(false);
  };
  const upload = async (file: File) => {
    if (busy.current) return;
    busy.current = true;
    setError(null); setPreview(null); setPhase("extracting");
    const abort = new AbortController(); controller.current = abort;
    // Extraction and AI run in one request; this label marks the combined parsing stage.
    const timer = setTimeout(() => { if (!abort.signal.aborted) setPhase("parsing"); }, 1000);
    try {
      const form = new FormData(); form.set("file", file);
      form.set("requestId", requestId.current ?? (requestId.current = crypto.randomUUID()));
      const response = await fetch("/api/profile/resume-import", { method: "POST", body: form, signal: abort.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.code);
      if (!abort.signal.aborted) {
        setPreview(result);
        setExcluded(new Set()); setExcludeProfile(false);
      }
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "AI_PARSE_FAILED");
    } finally { clearTimeout(timer); busy.current = false; if (!abort.signal.aborted) setPhase("idle"); }
  };
  const toggleItem = (ref: string) => setExcluded((previous) => {
    const next = new Set(previous);
    if (next.has(ref)) next.delete(ref); else next.add(ref);
    return next;
  });
  const confirm = async () => {
    if (!preview || busy.current) return;
    busy.current = true; setPhase("saving"); setError(null);
    try {
      const response = await fetch("/api/profile/resume-import", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          approval: preview.approval,
          excludedItemRefs: [...excluded].sort(),
          excludeProfileImport: excludeProfile,
        }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.code ?? "SAVE_FAILED");
      router.push(`/dashboard/profile/resumes/${result.variantId}`);
    } catch (reason) {
      // Selection errors get their own copy; everything else stays SAVE_FAILED.
      const code = reason instanceof Error ? reason.message : "";
      setError(["IMPORT_EXCLUSION_INVALID", "IMPORT_EXCLUSION_EMPTY", "IMPORT_CONFIRMATION_IMMUTABLE"].includes(code) ? code : "SAVE_FAILED");
    } finally { busy.current = false; setPhase("idle"); }
  };
  // AI environment failures (connection/runtime/capability not ready) are
  // not file problems — collapsing them into AI_PARSE_FAILED advises
  // retrying a file that can never pass on this runtime. They surface as
  // their own category instead.
  const AI_UNAVAILABLE_CODES = [
    "ASSIGNED_CONNECTION_UNAVAILABLE", "AUTH_NOT_CONFIRMED", "BACKEND_UNAVAILABLE",
    "BYOK_CREDENTIAL_UNAVAILABLE", "CAPABILITY_UNSUPPORTED",
    "CONNECTION_DISCONNECTED", "CONNECTION_ERROR",
    "MANAGED_AUTH_REQUIRED", "MANAGED_BINDING_UNAVAILABLE",
    "MANAGED_EXECUTION_NOT_IMPLEMENTED", "MANAGED_PROVENANCE_INVALID",
    "MANAGED_RUNTIME_UNAVAILABLE", "MODEL_DISABLED", "MODEL_UNAVAILABLE",
    "PERMISSION_BOUNDARY_NOT_READY", "REAUTH_REQUIRED", "RUNTIME_BROKEN",
    "RUNTIME_NOT_AVAILABLE", "RUNTIME_NOT_INSTALLED",
    "STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION", "STRUCTURED_OUTPUT_NOT_VERIFIED",
    "STRUCTURED_OUTPUT_UNSUPPORTED", "UNSUPPORTED_BACKEND",
    "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  ];
  const errorKey = error && (["UNSUPPORTED_FORMAT", "NO_TEXT", "NO_CONTENT", "TOO_SHORT", "TOO_LONG", "FILE_TOO_LARGE", "CORRUPTED", "SAVE_FAILED", "AI_NOT_CONFIGURED", "EXTRACTION_FAILED", "ENCRYPTED", "DECOMPRESSION_BOMB", "IMPORT_EXCLUSION_INVALID", "IMPORT_EXCLUSION_EMPTY", "IMPORT_CONFIRMATION_IMMUTABLE"].includes(error) ? error : AI_UNAVAILABLE_CODES.includes(error) ? "AI_UNAVAILABLE" : "AI_PARSE_FAILED");
  const totalItems = preview?.parsed.sections.reduce((count, section) => count + section.items.length, 0) ?? 0;
  const allExcluded = totalItems > 0 && excluded.size >= totalItems;
  if (!open) return <Button variant="outline" onClick={() => setOpen(true)}>{t("canonicalImport.open")}</Button>;
  return <div className="w-full space-y-3 rounded-md border p-4" data-testid="canonical-resume-import">
    <h2 className="font-medium">{t(preview ? "canonicalImport.review" : "canonicalImport.open")}</h2>
    {!preview && <label className="block space-y-2"><span>{t("canonicalImport.choose")}</span>
      <Input type="file" accept=".pdf,.docx" disabled={active} onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) {
          // A new file selection is a new logical import — mint a fresh
          // requestId; only an explicit retry reuses the current one.
          selectedFile.current = file;
          requestId.current = crypto.randomUUID();
          void upload(file);
        }
        event.target.value = "";
      }} /></label>}
    {active && <p role="status">{t(`canonicalImport.${phase}`)}</p>}
    {errorKey && <p role="alert" className="text-destructive">{t(`canonicalImport.errors.${errorKey}`)}</p>}
    {!active && !preview && error && selectedFile.current && (
      <Button variant="outline" onClick={() => void upload(selectedFile.current!)}>{t("common.retry")}</Button>
    )}
    {preview && <div className="space-y-3" data-testid="canonical-import-review">
      <p>{t("canonicalImport.summary", { count: preview.summary.created, reused: preview.summary.reused, name: preview.name })}</p>
      {preview.summary.conflicts.length > 0 && <p>{t("canonicalImport.conflicts")} {preview.summary.conflicts.map((field) => t(`canonicalImport.fields.${field}`)).join(" / ")}</p>}
      <details><summary>{t("canonicalImport.profile")}</summary><pre className="whitespace-pre-wrap text-sm">{Object.entries(preview.parsed.profile).filter(([, value]) => value).map(([field, value]) => `${t(`canonicalImport.fields.${field}`)}: ${value}`).join("\n")}</pre></details>
      {Object.values(preview.parsed.profile).some(Boolean) && <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={excludeProfile} disabled={active} onChange={(event) => setExcludeProfile(event.target.checked)} />
        <span>{t("canonicalImport.excludeProfile")}</span>
      </label>}
      {preview.parsed.sections.map((section, index) => <div key={index} className="space-y-2">
        <h3 className="font-medium">{section.title}</h3>
        {section.items.map((item, itemIndex) => ({ item, itemIndex }))
          // Uncertain items pin to the top for proofreading; refs stay bound
          // to the signed-parse position, so display order never moves them.
          .sort((a, b) => Number(Boolean(b.item.uncertainty)) - Number(Boolean(a.item.uncertainty)))
          .map(({ item, itemIndex }) => {
          const ref = importItemRef(index, itemIndex);
          const isExcluded = excluded.has(ref);
          return <div key={itemIndex} className={`rounded border p-2 text-sm ${isExcluded ? "opacity-50" : ""}`}>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={!isExcluded} disabled={active} onChange={() => toggleItem(ref)} />
            <span>{t(`canonicalImport.types.${item.type}`)} · {item.title}</span>
          </label>
          <pre className="whitespace-pre-wrap">{item.sourceText}</pre>
          <dl>{Object.entries(item.structuredFields).filter(([, value]) => value).map(([field, value]) => <div key={field}><dt className="inline">{t(`canonicalImport.fields.${field}`)}: </dt><dd className="inline">{value}</dd></div>)}</dl>
          <details><summary>{t("canonicalImport.expressions")}</summary>
            {item.expressions.map((expression, expressionIndex) => <div key={expressionIndex} className="mt-2 border-l pl-2">
              <p className="whitespace-pre-wrap">{expression}</p>
              {item.evidenceCandidates.filter((evidence) => evidence.expressionIndex === expressionIndex).map((evidence, evidenceIndex) =>
                <p key={evidenceIndex} className="mt-1 text-muted-foreground">{t(`canonicalImport.evidenceKinds.${evidence.kind}`)}: {evidence.content}</p>)}
            </div>)}
          </details>
          {item.uncertainty && <p>{t("canonicalImport.needsReview")}: {item.uncertainty}</p>}
        </div>;
        })}
      </div>)}
      <details><summary>{t("canonicalImport.source")}</summary><pre className="whitespace-pre-wrap text-sm">{preview.rawText}</pre></details>
      {allExcluded && <p role="status">{t("canonicalImport.errors.IMPORT_EXCLUSION_EMPTY")}</p>}
      <Button onClick={() => void confirm()} disabled={active || allExcluded}>{t("canonicalImport.confirm")}</Button>
    </div>}
    <Button variant="ghost" onClick={cancel} disabled={phase === "saving"}>{t("common.cancel")}</Button>
  </div>;
}
