// Independent Windows Authenticode signature verification for release artifacts.
// Uses PowerShell Get-AuthenticodeSignature and returns structured data.
// This module only inspects signatures; it never creates certificates or signs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SIGNATURE_STATUS = {
  VALID: "VALID",
  NOT_SIGNED: "NOT_SIGNED",
  INVALID: "INVALID",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
};

// Absolute path of the inbox Windows PowerShell Security module. Resolved via
// SystemRoot (never via PSModulePath) so unrelated runtimes that ship a
// same-named module earlier on PSModulePath cannot shadow Authenticode.
export const SYSTEM_SECURITY_MODULE = "system32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1";

function compactName(value) {
  return String(value || "").replace(/[^a-z]/gi, "").toUpperCase();
}

// Normalize a PowerShell Authenticode status (status name string, or a report
// object with statusName/statusValue fields) into VALID | NOT_SIGNED |
// INVALID | UNKNOWN_ERROR. NotSigned is never mapped to generic success.
export function normalizeSignatureStatus(raw) {
  let name = null;
  let value = null;
  if (raw && typeof raw === "object") {
    if (typeof raw.normalizedStatus === "string" && raw.normalizedStatus) {
      return normalizeSignatureStatus(raw.normalizedStatus);
    }
    name = raw.statusName ?? raw.Status ?? raw.status ?? null;
    value = raw.statusValue ?? raw.StatusValue ?? null;
  } else {
    name = raw;
  }
  const compact = compactName(name);
  if (compact === "VALID") return SIGNATURE_STATUS.VALID;
  if (compact === "NOTSIGNED") return SIGNATURE_STATUS.NOT_SIGNED;
  if (compact === "HASHMISMATCH" || compact === "NOTTRUSTED" || compact === "INVALID") {
    return SIGNATURE_STATUS.INVALID;
  }
  // statusValue 2 was observed for NotSigned; only trust it when the name is absent.
  if (!compact && Number(value) === 2) return SIGNATURE_STATUS.NOT_SIGNED;
  return SIGNATURE_STATUS.UNKNOWN_ERROR;
}

function escapePsSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function buildSignatureScript(absolutePath) {
  return [
    "$ErrorActionPreference = 'Stop';",
    "Import-Module (Join-Path $env:SystemRoot '" + SYSTEM_SECURITY_MODULE + "') -ErrorAction Stop;",
    "$s = Get-AuthenticodeSignature -LiteralPath '" + escapePsSingleQuoted(absolutePath) + "';",
    "[pscustomobject]@{",
    "  statusValue = [int]$s.Status;",
    "  statusName = $s.Status.ToString();",
    "  statusMessage = $s.StatusMessage;",
    "  signerSubject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null };",
    "  signerThumbprint = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null };",
    "  timestampSubject = if ($s.TimeStamperCertificate) { $s.TimeStamperCertificate.Subject } else { $null };",
    "} | ConvertTo-Json -Compress -Depth 3",
  ].join(" ");
}

// Query Windows Authenticode state for a real artifact file. Throws when the
// artifact is absent or when Windows signature tooling is unavailable.
export function queryAuthenticodeSignature(artifactPath) {
  const absolute = path.resolve(artifactPath);
  if (!fs.existsSync(absolute)) {
    const error = new Error("Signature verification artifact missing: " + absolute);
    error.code = "ARTIFACT_MISSING";
    throw error;
  }
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", buildSignatureScript(absolute)],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    const detail = result.stderr || (result.error && result.error.message) || "exit " + result.status;
    const error = new Error("Get-AuthenticodeSignature failed: " + detail);
    error.code = "WINDOWS_SIGNATURE_TOOLING_BLOCKER";
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout).trim());
  } catch (parseError) {
    const error = new Error("Signature tool output was not JSON: " + parseError.message);
    error.code = "SIGNATURE_PARSE_ERROR";
    throw error;
  }
  const normalized = normalizeSignatureStatus(parsed);
  return {
    artifactPath: absolute,
    rawStatusValue: parsed.statusValue ?? null,
    rawStatusName: parsed.statusName ?? null,
    statusMessage: parsed.statusMessage ?? null,
    normalizedStatus: normalized,
    signed: normalized === SIGNATURE_STATUS.VALID || normalized === SIGNATURE_STATUS.INVALID,
    signerSubject: parsed.signerSubject ?? null,
    signerThumbprint: parsed.signerThumbprint ?? null,
    timestampSubject: parsed.timestampSubject ?? null,
  };
}

export function defaultSignatureReportPath(root = repoRoot) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  return path.join(root, ".codex-tmp", "windows-release", version, "signature-report.json");
}

export function defaultInstallerArtifactPath(root = repoRoot) {
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  return path.join(root, ".codex-tmp", "windows-installer", "dist", "Vocatrya-Setup-" + version + "-x64.exe");
}

function parseCliArgs(argv) {
  const args = { artifact: null, out: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--artifact") args.artifact = argv[i + 1];
    if (argv[i] === "--out") args.out = argv[i + 1];
    if (argv[i] === "--json") args.json = true;
  }
  return args;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const args = parseCliArgs(process.argv.slice(2));
  const report = queryAuthenticodeSignature(args.artifact || defaultInstallerArtifactPath());
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report, null, 2));
}
