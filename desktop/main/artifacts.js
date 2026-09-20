const fs = require("node:fs");
const path = require("node:path");

function isForbiddenArtifact(filePath) {
  const name = path.basename(filePath);
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    normalizedName === "secrets.dat" ||
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

// Required offline migration artifacts inside an assembled desktop backend:
// bundled schema.prisma, bundled migrations, Prisma CLI entry, Windows
// schema engine, and the SQLite helper script. Returns human-readable
// relative paths for everything missing (empty means complete).
function findMissingPrismaRuntimeArtifacts(backendRoot, { platform = process.platform } = {}) {
  const missing = [];
  const runtimeDir = path.join(backendRoot, "prisma-runtime");
  const requiredFiles = [
    path.join("prisma-runtime", "schema.prisma"),
    path.join("prisma-runtime", "node_modules", "prisma", "build", "index.js"),
    "db-tool.cjs",
  ];
  if (platform === "win32") {
    requiredFiles.push(
      path.join("prisma-runtime", "node_modules", "@prisma", "engines", "schema-engine-windows.exe"),
    );
  }
  for (const relative of requiredFiles) {
    if (!fs.existsSync(path.join(backendRoot, relative))) {
      missing.push(relative);
    }
  }
  const migrationsDir = path.join(runtimeDir, "migrations");
  if (!fs.existsSync(migrationsDir)) {
    missing.push(path.join("prisma-runtime", "migrations"));
  } else {
    const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
    if (!entries.some((entry) => entry.isDirectory())) {
      missing.push(path.join("prisma-runtime", "migrations (empty)"));
    }
  }
  return missing;
}

module.exports = { findMissingPrismaRuntimeArtifacts, isForbiddenArtifact, scanForbiddenArtifacts };
