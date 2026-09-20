const fs = require("node:fs");
const path = require("node:path");

function isForbiddenArtifact(filePath) {
  const name = path.basename(filePath);
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    /\.db(?:-(?:wal|shm))?$/i.test(name) ||
    /\.tmp[^/\\]*$/i.test(name)
  );
}

function scanForbiddenArtifacts(root) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (isForbiddenArtifact(absolute)) {
      found.push(absolute);
    } else if (entry.isDirectory()) {
      found.push(...scanForbiddenArtifacts(absolute));
    }
  }
  return found;
}

module.exports = { isForbiddenArtifact, scanForbiddenArtifacts };
