import { ManagedError, type ManagedCapabilities, type ManagedModelDTO } from "../../../src/lib/ai/managed-contract";

export interface ManagedModel {
  modelKey: string; displayName: string; upstreamModelId: string; enabled: boolean;
  planRequirement: string | null; sortOrder: number; capabilities: ManagedCapabilities;
  mappingRevision: string; maxInputTokens: number; maxOutputTokens: number;
  allowedModelAliases?: string[];
}
export interface ManagedCatalog { revision: string; managedAiEnabled: boolean; defaultModelKey: string; models: ManagedModel[] }
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export function validateCatalog(raw: unknown): ManagedCatalog {
  if (!raw || typeof raw !== "object") throw new Error("Invalid Managed catalog");
  const catalog = raw as ManagedCatalog;
  if (!nonempty(catalog.revision) || typeof catalog.managedAiEnabled !== "boolean" || !Array.isArray(catalog.models)) throw new Error("Invalid Managed catalog");
  const keys = new Set<string>();
  for (const model of catalog.models) {
    if (!model || !nonempty(model.modelKey) || !/^[a-z0-9][a-z0-9._-]*$/.test(model.modelKey) || keys.has(model.modelKey) ||
      !nonempty(model.displayName) || !nonempty(model.upstreamModelId) || !nonempty(model.mappingRevision) ||
      typeof model.enabled !== "boolean" || (model.planRequirement !== null && !nonempty(model.planRequirement)) || !Number.isInteger(model.sortOrder) ||
      !Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens < 1 || model.maxInputTokens > 1_000_000 ||
      !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 1_000_000 ||
      !model.capabilities || Object.keys(model.capabilities).sort().join() !== "streaming,structuredOutput,text,tools" ||
      Object.values(model.capabilities).some(value => typeof value !== "boolean") || model.capabilities.tools !== false ||
      (model.allowedModelAliases !== undefined && (!Array.isArray(model.allowedModelAliases) || model.allowedModelAliases.some(alias => !nonempty(alias))))) {
      throw new Error("Invalid Managed catalog model");
    }
    keys.add(model.modelKey);
  }
  if (!keys.has(catalog.defaultModelKey)) throw new Error("Invalid Managed catalog default");
  return structuredClone(catalog);
}

export class ModelCatalog {
  private readonly config: ManagedCatalog;
  constructor(raw: unknown, private readonly verified: ManagedCapabilities) { this.config = validateCatalog(raw); }
  resolve(key: string, capability?: keyof ManagedCapabilities): ManagedModel {
    if (!this.config.managedAiEnabled) throw new ManagedError("MANAGED_AI_DISABLED");
    const model = this.config.models.find(entry => entry.modelKey === key);
    if (!model) throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
    if (!model.enabled) throw new ManagedError("MODEL_DISABLED");
    if (capability && (!model.capabilities[capability] || !this.verified[capability])) throw new ManagedError("CAPABILITY_UNSUPPORTED");
    return structuredClone(model);
  }
  dto(): { revision: string; models: ManagedModelDTO[] } {
    return { revision: this.config.revision, models: [...this.config.models].sort((a, b) => a.sortOrder - b.sortOrder).map(model => ({
      modelKey: model.modelKey, displayName: model.displayName, enabled: model.enabled,
      available: this.config.managedAiEnabled && model.enabled,
      capabilities: {
        text: model.capabilities.text && this.verified.text,
        streaming: model.capabilities.streaming && this.verified.streaming,
        structuredOutput: model.capabilities.structuredOutput && this.verified.structuredOutput, tools: false,
      },
    })) };
  }
}
