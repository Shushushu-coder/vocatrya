import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { scanManagedSecrets } from "../scripts/scan-managed-secrets.mjs";
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
});
