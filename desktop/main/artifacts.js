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
  return scanTree(root, (absolute) => isForbiddenArtifact(absolute));
}

function isInstallerForbiddenArtifact(filePath, { scanRoot } = {}) {
  if (isForbiddenArtifact(filePath)) return true;
  const name = path.basename(filePath).toLowerCase();
  const relative = scanRoot ? path.relative(scanRoot, filePath) : filePath;
  const parts = relative.split(/[/\\]/).map((part) => part.toLowerCase());
  if (parts.includes(".codex-tmp")) return true;
  if (parts.includes(".playwright-cli")) return true;
  if (parts.includes("playwright-report")) return true;
  if (parts.includes("test-results")) return true;
  if (parts.includes("blob-report")) return true;
  if (name === ".dev-server.log" || name === ".dev-server.err.log") return true;
  if (name.startsWith("npm-debug.log")) return true;
  if (name === "app-update.yml" || name === "dev-app-update.yml" || name === "latest.yml") return true;
  return false;
}

function scanInstallerForbiddenArtifacts(root) {
  return scanTree(root, (absolute) => isInstallerForbiddenArtifact(absolute, { scanRoot: root }));
}

function scanTree(root, predicate) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (predicate(absolute)) {
      found.push(absolute);
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...scanTree(absolute, predicate));
    }
  }
  return found;
}

function findMissingPackagedResources(appDir, { platform = process.platform } = {}) {
  const missing = [];
  const required = [
    "Vocatrya.exe",
    path.join("resources", "backend", "server.js"),
    path.join("resources", "backend", "public"),
    path.join("resources", "backend", ".next", "static"),
    path.join("resources", "backend", "db-tool.cjs"),
    path.join("resources", "backend", "node_modules", ".prisma", "client", "query_engine-windows.dll.node"),
    path.join("resources", "backend", "node_modules", "@img", "sharp-win32-x64", "index.cjs"),
    path.join("resources", "runtime", "win32-x64", "node.exe"),
    path.join("resources", "licenses", "LICENSE"),
    path.join("resources", "licenses", "THIRD_PARTY_NOTICES.txt"),
    path.join("resources", "build-info.json"),
  ];
  if (platform === "win32") {
    required.push(
      path.join(
        "resources",
        "backend",
        "prisma-runtime",
        "node_modules",
        "@prisma",
        "engines",
        "schema-engine-windows.exe",
      ),
    );
  }
  required.push(
    path.join("resources", "backend", "prisma-runtime", "schema.prisma"),
    path.join("resources", "backend", "prisma-runtime", "node_modules", "prisma", "build", "index.js"),
    path.join("resources", "backend", "prisma-runtime", "migrations"),
  );
  for (const relative of required) {
    if (!fs.existsSync(path.join(appDir, relative))) missing.push(relative);
  }
  const asarPath = path.join(appDir, "resources", "app.asar");
  const unpackedApp = path.join(appDir, "resources", "app");
  if (!fs.existsSync(asarPath) && !fs.existsSync(unpackedApp)) {
    missing.push(path.join("resources", "app.asar"));
  }
  return missing;
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
    path.join("prisma-runtime", "node_modules", "effect", "package.json"),
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

module.exports = {
  findMissingPackagedResources,
  findMissingPrismaRuntimeArtifacts,
  isForbiddenArtifact,
  isInstallerForbiddenArtifact,
  scanForbiddenArtifacts,
  scanInstallerForbiddenArtifacts,
};
