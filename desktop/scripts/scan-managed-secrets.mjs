import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const forbidden = ["MANAGED_AI_API_KEY", "SYNTHETIC_MANAGED_GATEWAY_SECRET_M2", "SYNTHETIC_MANAGED_GATEWAY_SECRET_M3",
  "ManagedAiQuotaPeriod", "ManagedAiUsage", "HostedSchemaMigration", "m3-commercial-authority", "setSubscription"];
/** Scans actual built artifacts, including binary resources. Reports paths only. */
export function scanManagedSecrets(root) {
  if (!fs.existsSync(root)) throw new Error(`Missing artifact root: ${root}`);
  const failures = [];
  const visited = new Set();
  function inspect(filename) {
    const relative = path.relative(root, filename).replaceAll("\\", "/") || path.basename(filename);
    const content = fs.readFileSync(filename);
    if (relative.includes("services/managed-ai/") || forbidden.some(marker => content.includes(Buffer.from(marker)))) failures.push(relative);
  }
  function visit(directory) {
    const real = fs.realpathSync(directory);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      const stat = entry.isSymbolicLink() ? fs.statSync(filename) : entry;
      if (stat.isDirectory()) visit(filename);
      else if (stat.isFile()) inspect(filename);
    }
  }
  if (fs.statSync(root).isFile()) inspect(root); else visit(root);
  return failures;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length < 3) throw new Error("Provide built artifact roots");
  for (const root of process.argv.slice(2)) {
    const failures = scanManagedSecrets(root);
    if (failures.length) throw new Error(`Hosted secret/implementation in package: ${failures.join(", ")}`);
    process.stdout.write(`PASS managed secret scan: ${root}\n`);
  }
}
