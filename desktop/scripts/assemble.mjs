import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isForbiddenArtifact, scanForbiddenArtifacts } = require("../main/artifacts.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const standaloneRoot = path.join(repoRoot, ".next", "standalone");
const outputRoot = path.join(repoRoot, ".codex-tmp", "desktop-poc");
const backendRoot = path.join(outputRoot, "backend");
const packagedBackendRoot = path.join(outputRoot, "resources", "backend");

function copyFiltered(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required build path is missing: ${source}`);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !isForbiddenArtifact(entry),
  });
}

function required(relativePath) {
  const absolute = path.join(backendRoot, relativePath);
  if (!fs.existsSync(absolute)) throw new Error(`POC assembly missing ${relativePath}`);
  return absolute;
}

fs.rmSync(backendRoot, { recursive: true, force: true });
fs.rmSync(packagedBackendRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
const excludedSourceArtifacts = scanForbiddenArtifacts(standaloneRoot).map((entry) => path.relative(standaloneRoot, entry));
copyFiltered(standaloneRoot, backendRoot);
copyFiltered(path.join(repoRoot, "public"), path.join(backendRoot, "public"));
copyFiltered(path.join(repoRoot, ".next", "static"), path.join(backendRoot, ".next", "static"));
fs.cpSync(backendRoot, packagedBackendRoot, { recursive: true });

const serverPath = required("server.js");
const prismaEngine = required("node_modules/.prisma/client/query_engine-windows.dll.node");
const sharpRuntime = required("node_modules/@img/sharp-win32-x64/index.cjs");
const forbidden = scanForbiddenArtifacts(backendRoot);
forbidden.push(...scanForbiddenArtifacts(packagedBackendRoot));
if (forbidden.length > 0) {
  throw new Error(`Forbidden artifacts found in desktop bundle:\n${forbidden.join("\n")}`);
}

const inventory = {
  generatedAt: new Date().toISOString(),
  serverPath,
  publicAssets: fs.existsSync(path.join(backendRoot, "public")),
  nextStaticAssets: fs.existsSync(path.join(backendRoot, ".next", "static")),
  prismaQueryEngine: prismaEngine,
  sharpWindowsRuntime: sharpRuntime,
  packagedBackendRoot,
  excludedSourceArtifacts,
  forbiddenArtifacts: [],
};
fs.writeFileSync(path.join(outputRoot, "bundle-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
console.log(JSON.stringify(inventory, null, 2));
