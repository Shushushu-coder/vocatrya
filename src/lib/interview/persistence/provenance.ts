/**
 * Phase 3B — Spec / port provenance (minimal auditable location).
 *
 * No provenance subsystem: single source of truth for the frozen
 * InterviewDx port consumed by Host Port / persistence wiring.
 */
export const INTERVIEW_PORT_PROVENANCE = {
  PORT_SOURCE_COMMIT: "a7c8d9012896ba013e3bb632de1d5ff636b08233",
  SPEC_TAG: "interview-vocatrya-spec-v1",
  SPEC_COMMIT: "a7a8e2ed75e3797c207851f62e3a13732d405f6d",
  HOST_PORT_CONTRACT_VERSION: "v0",
} as const;
