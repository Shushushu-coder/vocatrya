import { HostedStore } from "./store";
// Trusted operator command. Token output is intentional provisioning output,
// never a request log or a user-accessible identity assertion endpoint.
const userId = process.argv[2];
const database = process.env.MANAGED_AI_DATABASE_PATH;
if (!database || !userId) throw new Error("Usage: provision-session <hosted-account-id>; hosted database path required");
const store = new HostedStore(database);
try { process.stdout.write(store.issueSession(userId, Date.now() + 24 * 60 * 60 * 1000) + "\n"); } finally { store.close(); }
