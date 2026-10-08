import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { scanManagedSecrets } from "../scripts/scan-managed-secrets.mjs";
import { copyFiltered } from "../scripts/assemble.mjs";
describe("Built artifact hosted secret gate", () => {
  it("rejects secret markers in client JS and binary resources and hosted implementation paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m2-artifacts-"));
    try {
      fs.writeFileSync(path.join(root, "safe.js"), "public modelKey catalog DTO"); expect(scanManagedSecrets(root)).toEqual([]);
      fs.writeFileSync(path.join(root, "client.js"), "MANAGED_AI_API_KEY");
      fs.writeFileSync(path.join(root, "resource.bin"), Buffer.concat([Buffer.from([0, 1]), Buffer.from("SYNTHETIC_MANAGED_GATEWAY_SECRET_M2")]));
      fs.mkdirSync(path.join(root, "services", "managed-ai"), { recursive: true }); fs.writeFileSync(path.join(root, "services", "managed-ai", "gateway.js"), "hosted implementation");
      expect(scanManagedSecrets(root).sort()).toEqual(["client.js", "resource.bin", "services/managed-ai/gateway.js"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["SYNTHETIC_MANAGED_GATEWAY_SECRET_M3", "ManagedAiQuotaPeriod", "ManagedAiUsage", "setSubscription", "HostedSchemaMigration"])("detects M3 marker or hosted authority %s in binary artifacts", marker => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m3-artifacts-"));
    try {
      fs.writeFileSync(path.join(root, "shared.js"), "ManagedInvocation ManagedTextResult executionState modelKey public DTO");
      expect(scanManagedSecrets(root)).toEqual([]);
      fs.writeFileSync(path.join(root, "artifact.bin"), Buffer.concat([Buffer.from([0, 255]), Buffer.from(marker), Buffer.from([0])]));
      expect(scanManagedSecrets(root)).toEqual(["artifact.bin"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("assembly filters temporary files inside standalone directory links before packaging", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m3-layout-"));
    try {
      const source = path.join(root, "standalone"), dependency = path.join(root, "dependency"), output = path.join(root, "output");
      fs.mkdirSync(source); fs.mkdirSync(dependency);
      fs.writeFileSync(path.join(dependency, "index.js"), "runtime module");
      fs.writeFileSync(path.join(dependency, "index_vite_proxy.tmp.mjs"), "test transform temporary file");
      fs.symlinkSync(dependency, path.join(source, "js-yaml"), process.platform === "win32" ? "junction" : "dir");
      copyFiltered(source, output);
      expect(fs.lstatSync(path.join(output, "js-yaml")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(output, "js-yaml", "index.js"), "utf8")).toBe("runtime module");
      expect(fs.existsSync(path.join(output, "js-yaml", "index_vite_proxy.tmp.mjs"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("the shipped scanner inspects directory links and a raw app.asar file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m3-linked-artifacts-"));
    try {
      const source = path.join(root, "standalone"), dependency = path.join(root, "dependency");
      fs.mkdirSync(source); fs.mkdirSync(dependency);
      fs.writeFileSync(path.join(dependency, "module.js"), "SYNTHETIC_MANAGED_GATEWAY_SECRET_M3");
      fs.symlinkSync(dependency, path.join(source, "module"), process.platform === "win32" ? "junction" : "dir");
      expect(scanManagedSecrets(source)).toEqual(["module/module.js"]);
      const archive = path.join(root, "app.asar");
      fs.writeFileSync(archive, Buffer.concat([Buffer.from([0, 255]), Buffer.from("SYNTHETIC_MANAGED_GATEWAY_SECRET_M3")]));
      expect(scanManagedSecrets(archive)).toEqual(["app.asar"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
