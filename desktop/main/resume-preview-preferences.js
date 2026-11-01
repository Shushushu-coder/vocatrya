// The resume preview pane preference (hidden/width) must outlive the
// backend's ephemeral loopback port — the pane's hidden/width state is a
// device preference, not version data.
const { registerSnapshotPreferenceIpc } = require("./snapshot-preference");

function validateSnapshot(raw) {
  if (typeof raw !== "string" || raw.length > 1024) throw new Error("Invalid resume preview preferences");
  const value = JSON.parse(raw);
  // The renderer applies its own minimum-width floor on read; storage only
  // needs an exact-shape, finite, non-negative snapshot.
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      typeof value.hidden !== "boolean" ||
      typeof value.width !== "number" || !Number.isFinite(value.width) ||
      value.width < 0) throw new Error("Invalid resume preview preferences");
  return JSON.stringify(value);
}

function registerResumePreviewPreferencesIpc(options) {
  return registerSnapshotPreferenceIpc({
    ...options,
    validate: validateSnapshot,
    channels: {
      read: "resumePreviewPreferences:read",
      write: "resumePreviewPreferences:write",
    },
  });
}

module.exports = { registerResumePreviewPreferencesIpc };
