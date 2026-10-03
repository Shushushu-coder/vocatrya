import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { assertSha256Sync, sha256FileSync } from "../scripts/node-runtime.mjs";

const require = createRequire(import.meta.url);
const identity = require("./installer-identity.js");
const artifacts = require("./artifacts.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("windows installer identity", () => {
  it("keeps a stable desktop app id and product name", () => {
    expect(identity.DESKTOP_APP_ID).toBe("com.vocatrya.desktop");
    expect(identity.PRODUCT_NAME).toBe("Vocatrya");
    expect(identity.EXECUTABLE_NAME).toBe("Vocatrya");
    expect(identity.SHORTCUT_NAME).toBe("Vocatrya");
    expect(identity.PUBLISHER).toBe("Vocatrya contributors");
    expect(identity.TARGET_ARCH).toBe("x64");
    expect(identity.INSTALLER_TARGET).toBe("nsis");
  });

  it("pins Node 20.20.2 with official archive and executable SHA-256", () => {
    expect(identity.NODE_VERSION).toBe("v20.20.2");
    expect(identity.NODE_ARCHIVE_NAME).toBe("node-v20.20.2-win-x64.zip");
    expect(identity.NODE_ARCHIVE_SHA256).toBe("dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77");
    expect(identity.NODE_EXE_SHA256).toHaveLength(64);
    expect(identity.NODE_ARCHIVE_URL).toContain("v20.20.2");
  });
});

describe("electron-builder configuration", () => {
  const yml = read("desktop/electron-builder.yml");
  const nsh = read("desktop/installer.nsh");
  const pkg = JSON.parse(read("package.json"));

  it("ships the static A1.5 Windows identity with executable editing and shell icon metadata", () => {
    expect(yml).toMatch(/icon:\s*desktop\/assets\/icon\.ico/);
    expect(yml).toMatch(/from:\s*desktop\/assets\/icon\.ico\s+to:\s*icon\.ico/);
    expect(yml).toMatch(/installerIcon:\s*desktop\/assets\/icon\.ico/);
    expect(yml).toMatch(/uninstallerIcon:\s*desktop\/assets\/icon\.ico/);
    expect(yml).toMatch(/signExecutable:\s*false/);
    expect(yml).not.toMatch(/signAndEditExecutable:\s*false/);
    const main = read("desktop/main/main.js");
    expect(main).toContain('path.join(process.resourcesPath, "icon.ico")');
    expect(main).toContain("appIconPath: iconPath");
    const icon = fs.readFileSync(path.join(repoRoot, "desktop/assets/icon.ico"));
    expect(icon.readUInt16LE(2)).toBe(1);
    expect(icon.readUInt16LE(4)).toBe(7);
    expect(Array.from({ length: 7 }, (_, i) => icon[6 + i * 16] || 256)).toEqual([16,24,32,48,64,128,256]);
  });

  it("configures a per-user NSIS installer with selectable directory", () => {
    expect(yml).toMatch(/appId:\s*com\.vocatrya\.desktop/);
    expect(yml).toMatch(/productName:\s*Vocatrya/);
    expect(yml).toMatch(/oneClick:\s*false/);
    expect(yml).toMatch(/perMachine:\s*false/);
    expect(yml).toMatch(/allowToChangeInstallationDirectory:\s*true/);
    expect(yml).toMatch(/createDesktopShortcut:\s*always/);
    expect(yml).toMatch(/createStartMenuShortcut:\s*true/);
    expect(yml).toMatch(/shortcutName:\s*Vocatrya/);
    expect(yml).toMatch(/deleteAppDataOnUninstall:\s*false/);
    expect(yml).toMatch(/executableName:\s*Vocatrya/);
    expect(yml).toMatch(/artifactName:\s*Vocatrya-Setup-\$\{version\}-x64\.\$\{ext\}/);
    expect(yml).toMatch(/target:\s*nsis/);
    expect(yml).toMatch(/- x64/);
    expect(yml).not.toMatch(/arm64/);
    expect(yml).not.toMatch(/ia32/);
    expect(yml).not.toMatch(/electron-updater/);
    expect(yml).toMatch(/afterPack:\s*desktop\/scripts\/after-pack\.cjs/);
    expect(yml).toMatch(/asar:\s*true/);
    expect(yml).toMatch(/forceCodeSigning:\s*false/);
    expect(yml).toMatch(/output:\s*\.codex-tmp\/windows-installer\/dist/);
  });

  it("uses package.json.version as the only application version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(yml).toContain("${version}");
    expect(yml).not.toMatch(/version:\s*['\"]?\d+\.\d+\.\d+/);
    expect(identity.INSTALLER_ARTIFACT_PATTERN.replace("${version}", pkg.version)).toBe(
      `Vocatrya-Setup-${pkg.version}-x64.exe`,
    );
  });

  it("does not add auto-update or extra installer frameworks", () => {
    const depNames = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };
    expect(depNames["electron-updater"]).toBeUndefined();
    expect(depNames["electron-builder"]).toBeTruthy();
    expect(Object.keys(depNames).some((name) => /squirrel|wix|msix/i.test(name))).toBe(false);
    expect(nsh).toMatch(/Do not remove \$LOCALAPPDATA\\Vocatrya/);
    expect(nsh).toMatch(/do not taskkill node\.exe or electron\.exe globally/i);
  });

  it("exposes installer scripts without changing ordinary Next scripts", () => {
    expect(pkg.scripts.dev).toBe("next dev --turbopack -p 3737");
    expect(pkg.scripts.build).toBe("next build");
    expect(pkg.scripts.start).toBe("next start");
    expect(pkg.scripts["desktop:installer"]).toBe("node desktop/scripts/package.mjs");
    expect(pkg.scripts["desktop:package"]).toContain("package.mjs --dir");
    expect(pkg.scripts["desktop:installer:verify"]).toContain("verify-installer.mjs");
    expect(pkg.main).toBe("desktop/main/main.js");
  });
});

describe("installer artifact scanning", () => {
  it("fails closed on env, database, secrets, and packaging leftovers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-installer-scan-"));
    fs.mkdirSync(path.join(root, ".codex-tmp"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "secret");
    fs.writeFileSync(path.join(root, "secrets.dat"), "secret");
    fs.writeFileSync(path.join(root, "vocatrya.db"), "db");
    fs.writeFileSync(path.join(root, ".dev-server.log"), "log");
    const found = artifacts.scanInstallerForbiddenArtifacts(root);
    expect(found.some((entry) => entry.endsWith(".env"))).toBe(true);
    expect(found.some((entry) => entry.endsWith("secrets.dat"))).toBe(true);
    expect(found.some((entry) => entry.endsWith("vocatrya.db"))).toBe(true);
    expect(found.some((entry) => entry.endsWith(".dev-server.log"))).toBe(true);
    expect(found.some((entry) => entry.toLowerCase().includes(".codex-tmp"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports missing packaged runtime resources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-installer-missing-"));
    const missing = artifacts.findMissingPackagedResources(root, { platform: "win32" });
    expect(missing).toContain("Vocatrya.exe");
    expect(missing.some((entry) => entry.includes("node.exe"))).toBe(true);
    expect(missing.some((entry) => entry.includes("server.js"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("bundled Node integrity helper", () => {
  it("rejects a node.exe whose SHA-256 does not match the pin", () => {
    const filePath = path.join(os.tmpdir(), `vocatrya-node-mismatch-${process.pid}.bin`);
    fs.writeFileSync(filePath, "not-a-node-runtime");
    expect(() => assertSha256Sync(filePath, identity.NODE_EXE_SHA256)).toThrow(/SHA-256 mismatch/);
    expect(sha256FileSync(filePath)).not.toBe(identity.NODE_EXE_SHA256);
    fs.rmSync(filePath, { force: true });
  });
});
