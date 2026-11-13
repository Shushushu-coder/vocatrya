import { CareerRuntimeError } from "./errors";
import { CAREER_RUNTIME_MODE } from "./identities";
import { careerMutationDeniedMessage } from "./userMessages";

// Shared write gate for the My Jobs mutations (edit, delete, reorder, pin):
// the same modes that allow job mutations allow ordering writes.
export function assertJobMutationsAllowed(mode: string): void {
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) return;
  if (mode === CAREER_RUNTIME_MODE.LEGACY_ONLY) return;
  throw new CareerRuntimeError(
    mode === CAREER_RUNTIME_MODE.BLOCKED
      ? "CAREER_RUNTIME_BLOCKED"
      : "JOB_MUTATIONS_DISABLED",
    careerMutationDeniedMessage(mode),
  );
}
