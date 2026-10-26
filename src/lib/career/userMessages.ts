import { CAREER_RUNTIME_MODE } from "./identities";

const EDITS_BLOCKED =
  "Career profile and application data cannot be changed until the data integrity check passes.";
const EDITS_DISABLED =
  "Career profile and application editing is not enabled for this app yet. Changes to jobs and resumes through the previous version's editors are also unavailable.";

export const CAREER_JOBS_UNAVAILABLE_MESSAGE =
  "Job application data cannot be read in the current instance state.";

export const CAREER_COVER_LETTER_UNSUPPORTED_MESSAGE =
  "A cover letter cannot be saved with this job yet. Remove the cover letter and try again.";

export const CAREER_TAGS_UNSUPPORTED_MESSAGE =
  "Tags cannot be saved with this job yet. Remove the tags and try again.";

export const CAREER_LEGACY_EDITOR_UNAVAILABLE_MESSAGE =
  "This editor cannot change jobs or resumes in the current app state.";

export const CAREER_NOTES_UNAVAILABLE_MESSAGE =
  "Notes cannot be read or changed in the current app state.";

export const CAREER_TIMELINE_UNAVAILABLE_MESSAGE =
  "The application timeline is not available in the current app state.";

export const CAREER_REFLECTION_UNAVAILABLE_MESSAGE =
  "Interview reflection is not available in the current app state.";

export const CAREER_UPCOMING_UNAVAILABLE_MESSAGE =
  "Upcoming events are not available in the current app state.";

export const CAREER_READ_DENIED_MESSAGE =
  "Career data cannot be read in the current app state.";

export const CAREER_WRITE_DENIED_MESSAGE =
  "Career data cannot be changed in the current app state.";

export function careerMutationDeniedMessage(mode: string): string {
  if (mode === CAREER_RUNTIME_MODE.BLOCKED) return EDITS_BLOCKED;
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) return CAREER_WRITE_DENIED_MESSAGE;
  return EDITS_DISABLED;
}
