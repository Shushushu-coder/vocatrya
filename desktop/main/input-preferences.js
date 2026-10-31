// Device input preferences must outlive the backend's ephemeral loopback port.
const { registerSnapshotPreferenceIpc } = require("./snapshot-preference");

function validateSnapshot(raw) {
  if (typeof raw !== "string" || raw.length > 1024) throw new Error("Invalid input preferences");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      !["newline", "next"].includes(value.enterBehavior) ||
      !["click", "end", "select-all"].includes(value.editEntry) ||
      !["always", "focus", "off"].includes(value.hintMode) ||
      typeof value.autoFocus !== "boolean") throw new Error("Invalid input preferences");
  return JSON.stringify(value);
}

function registerInputPreferencesIpc(options) {
  return registerSnapshotPreferenceIpc({
    ...options,
    validate: validateSnapshot,
    channels: { read: "inputPreferences:read", write: "inputPreferences:write" },
  });
}

module.exports = { registerInputPreferencesIpc };
