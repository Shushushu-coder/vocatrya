export type ResumeLayoutConfig = { template: "standard"; pageTarget: 1 | 2 | null };
export function parseResumeLayoutConfig(raw: string | null | undefined): ResumeLayoutConfig {
  try {
    const value = JSON.parse(raw ?? "null");
    const config = value?.builder ?? value;
    return { template: "standard", pageTarget: config?.pageTarget === 1 || config?.pageTarget === 2 ? config.pageTarget : null };
  } catch { return { template: "standard", pageTarget: null }; }
}
/** Preserve migration provenance and other historical metadata alongside our namespace. */
export function serializeResumeLayoutConfig(previous: string | null, config: ResumeLayoutConfig): string {
  let old: Record<string, unknown> = {};
  try { const value = JSON.parse(previous ?? "null"); if (value && typeof value === "object" && !Array.isArray(value)) old = value; } catch {}
  return JSON.stringify({ ...old, builder: config });
}
