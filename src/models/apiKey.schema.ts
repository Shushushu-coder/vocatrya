import { z } from "zod";

export const apiKeySaveSchema = z.object({
  provider: z.enum(["openai", "deepseek", "openrouter", "ollama", "gemini"]),
  // The OS credential envelope caps seal input at 8KB; real provider keys
  // are well under 200 characters, so this bound is pure input hygiene.
  key: z.string().min(1, "API key is required").max(4096),
  label: z.string().optional(),
  sensitive: z.boolean().default(true),
});

export type ApiKeySaveInput = z.infer<typeof apiKeySaveSchema>;
