import { HostedStore } from "./store";
// Trusted operator command. Token output is intentional provisioning output,
// never a request log or a user-accessible identity assertion endpoint.
// Optional second argument: TTL in seconds (60s minimum, 7 days maximum —
// same bounds the operator console applies). Default: 24 hours.
const userId = process.argv[2];
const ttlSeconds = process.argv[3];
const database = process.env.MANAGED_AI_DATABASE_PATH;
if (!database || !userId) throw new Error("Usage: provision-session <hosted-account-id> [ttl-seconds]; hosted database path required");
let ttlMs = 24 * 60 * 60 * 1000;
if (ttlSeconds !== undefined) {
  const parsed = Number(ttlSeconds);
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 7 * 24 * 60 * 60) {
    throw new Error("ttl-seconds must be an integer between 60 and 604800 (7 days)");
  }
  ttlMs = parsed * 1000;
}
const store = new HostedStore(database);
try { process.stdout.write(store.issueSession(userId, Date.now() + ttlMs) + "\n"); } finally { store.close(); }
