/**
 * Application write boundary for ResumeVariantVersion.
 *
 * Ordinary runtime must mutate versions only through ResumeVariantService.
 * Backup restore uses dynamic Prisma delegates and is not a direct write site.
 * Tests are outside `src/` and are not scanned.
 */
export const RESUME_VARIANT_VERSION_WRITE_ALLOWLIST = [
  "src/lib/career/resumeVariantService.ts",
  "src/lib/legacy-migration/migrator.ts",
] as const;

export const RESUME_VARIANT_VERSION_DIRECT_WRITE_RE =
  /\.resumeVariantVersion\.(create|update|updateMany|delete|deleteMany|upsert)\s*\(/;
