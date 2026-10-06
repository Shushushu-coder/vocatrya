const fs = require("node:fs");
const path = require("node:path");

// Input is relative to prisma-runtime/node_modules, never an application path.
function isExcludedPrismaRuntimeArtifact(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const inTree = (root) => normalized === root || normalized.startsWith(`${root}/`);
  return (
    inTree("@prisma/engines/node_modules/.cache") ||
    normalized.endsWith(".map") ||
    inTree("effect/src") ||
    inTree("effect/dist/dts")
  );
}

function scanExcludedPrismaRuntimeArtifacts(runtimeDir) {
  const modulesDir = path.join(runtimeDir, "node_modules");
  const found = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (isExcludedPrismaRuntimeArtifact(path.relative(modulesDir, absolute))) {
        found.push(absolute);
      } else if (entry.isDirectory()) {
        walk(absolute);
      }
    }
  }
  walk(modulesDir);
  return found;
}

module.exports = { isExcludedPrismaRuntimeArtifact, scanExcludedPrismaRuntimeArtifacts };
