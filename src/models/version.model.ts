export interface AppVersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

export interface ReleaseNotesInfo {
  current: { version: string; notes: string | null };
  latest: { version: string; notes: string | null; url: string | null } | null;
}
