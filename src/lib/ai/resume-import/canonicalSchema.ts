import { z } from "zod";
import { ParsedResumeImportSchema } from "@/lib/career/resumeImportContract";

/** Zod serializes nullable strings with anyOf; the runtime subset uses type arrays. */
export function canonicalImportJsonSchema(): Record<string, unknown> {
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.anyOf) && record.anyOf.length === 2) {
      const [value, nullable] = record.anyOf as Record<string, unknown>[];
      if (value.type === "string" && nullable.type === "null") return { ...value, type: ["string", "null"] };
    }
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, convert(value)]));
  };
  return convert(z.toJSONSchema(ParsedResumeImportSchema)) as Record<string, unknown>;
}
