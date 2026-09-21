import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf8");
}

function copyLicense(source, destination, label) {
  if (!source || !fs.existsSync(source)) {
    throw new Error(`Required ${label} license file is missing: ${source || "(unset)"}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function collectNpmLicenseInventory(nodeModulesDir) {
  const inventory = [];
  const seen = new Set();
  if (!fs.existsSync(nodeModulesDir)) return inventory;

  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".bin") continue;
      const nested = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(nested);
        continue;
      }
      const packageJsonPath = path.join(nested, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
          const key = `${pkg.name}@${pkg.version}`;
          if (pkg.name && !seen.has(key)) {
            seen.add(key);
            inventory.push({
              name: pkg.name,
              version: pkg.version || "",
              license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type || "UNKNOWN",
            });
          }
        } catch {
          // Skip unreadable package manifests rather than inventing license text.
        }
        const nestedModules = path.join(nested, "node_modules");
        if (fs.existsSync(nestedModules)) visit(nestedModules);
      }
    }
  }

  visit(nodeModulesDir);
  inventory.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return inventory;
}

export function generateNotices({
  root = repoRoot,
  outputDir,
  nodeLicensePath,
  backendNodeModules,
} = {}) {
  if (!outputDir) throw new Error("outputDir is required");
  fs.mkdirSync(outputDir, { recursive: true });

  const projectLicense = path.join(root, "LICENSE");
  copyLicense(projectLicense, path.join(outputDir, "LICENSE"), "Vocatrya");
  copyLicense(path.join(root, "node_modules", "electron", "LICENSE"), path.join(outputDir, "ELECTRON-LICENSE.txt"), "Electron");
  copyLicense(path.join(root, "node_modules", "prisma", "LICENSE"), path.join(outputDir, "PRISMA-LICENSE.txt"), "Prisma");
  copyLicense(path.join(root, "node_modules", "sharp", "LICENSE"), path.join(outputDir, "SHARP-LICENSE.txt"), "sharp");
  const sharpWinLicense = path.join(root, "node_modules", "@img", "sharp-win32-x64", "LICENSE");
  if (fs.existsSync(sharpWinLicense)) {
    copyLicense(sharpWinLicense, path.join(outputDir, "SHARP-WIN32-LICENSE.txt"), "sharp-win32-x64");
  }
  const nodeNoticePath = path.join(outputDir, "NODE-LICENSE.txt");
  if (nodeLicensePath && fs.existsSync(nodeLicensePath)) {
    if (path.resolve(nodeLicensePath) !== path.resolve(nodeNoticePath)) {
      copyLicense(nodeLicensePath, nodeNoticePath, "Node.js");
    }
  } else {
    throw new Error("Node.js LICENSE is required for installer notices");
  }

  const inventory = collectNpmLicenseInventory(
    backendNodeModules || path.join(root, ".codex-tmp", "windows-installer", "stage", "resources", "backend", "node_modules"),
  );
  const prismaRuntimeInventory = collectNpmLicenseInventory(
    path.join(path.dirname(backendNodeModules || path.join(root, ".codex-tmp", "windows-installer", "stage", "resources", "backend", "node_modules")), "prisma-runtime", "node_modules"),
  );

  const merged = [...inventory];
  const seen = new Set(inventory.map((item) => `${item.name}@${item.version}`));
  for (const item of prismaRuntimeInventory) {
    const key = `${item.name}@${item.version}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  merged.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const projectLicenseText = readIfExists(projectLicense) || "";
  const notices = [
    "Vocatrya third-party notices",
    "",
    "Vocatrya is derived from JobSync (https://github.com/Gsync/jobsync) under the MIT License.",
    "The original copyright notice and license are preserved in LICENSE.",
    "This file lists redistributed runtimes and the license field from bundled npm packages.",
    "License text is copied from those packages; it is not authored for this installer.",
    "",
    "=== Vocatrya / JobSync ===",
    projectLicenseText.trim(),
    "",
    "=== Node.js ===",
    "See NODE-LICENSE.txt (official Node.js Windows x64 archive).",
    "",
    "=== Electron (includes Chromium and Node components redistributed by Electron) ===",
    "See ELECTRON-LICENSE.txt and LICENSES.chromium.html next to Vocatrya.exe when packaged.",
    "",
    "=== Prisma ===",
    "See PRISMA-LICENSE.txt.",
    "",
    "=== sharp / libvips (Windows x64 native runtime) ===",
    "See SHARP-LICENSE.txt and SHARP-WIN32-LICENSE.txt when present.",
    "",
    "=== Bundled npm packages (name, version, license field from package.json) ===",
    ...merged.map((item) => `${item.name}@${item.version} — ${item.license}`),
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outputDir, "THIRD_PARTY_NOTICES.txt"), `${notices}\n`, "utf8");
  fs.writeFileSync(
    path.join(outputDir, "npm-license-inventory.json"),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: merged }, null, 2)}\n`,
    "utf8",
  );
  return { outputDir, packageCount: merged.length };
}
