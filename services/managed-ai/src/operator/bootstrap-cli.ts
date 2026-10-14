import { HostedStore } from "../store";
import { OperatorStore } from "./store";

/**
 * Trusted operator bootstrap — owner-run over SSH only. This is the sole
 * issuance channel for operator credentials: the secret is printed exactly
 * once, here, and only its SHA-256 digest is persisted. It is never placed in
 * a URL, log, or audit field. There is no HTTP route that creates, lists, or
 * rotates credentials.
 *
 * Usage:
 *   operator-bootstrap create-credential <label>
 *   operator-bootstrap list-credentials
 *   operator-bootstrap revoke-credential <credentialId>
 *   operator-bootstrap runtime-status
 *   operator-bootstrap runtime-disable <reason>
 *   operator-bootstrap runtime-enable [reason]
 *
 * Env: MANAGED_AI_DATABASE_PATH (required).
 */
function fail(message: string): never { process.stderr.write(`${message}\n`); process.exit(2); }

const database = process.env.MANAGED_AI_DATABASE_PATH;
if (!database) fail("MANAGED_AI_DATABASE_PATH required");
const [command, ...args] = process.argv.slice(2);
if (!command) fail("Usage: operator-bootstrap <create-credential|list-credentials|revoke-credential|runtime-status|runtime-disable|runtime-enable> ...");

const store = new HostedStore(database);
try {
  const operator = new OperatorStore(store.internalDb());
  const actor = { credentialId: "cli", label: "bootstrap-cli", tokenHash: "" };
  if (command === "create-credential") {
    const [label] = args;
    if (!label) fail("Usage: operator-bootstrap create-credential <label>");
    const { id, secret } = operator.createCredential(label, actor);
    process.stdout.write(`${JSON.stringify({ id, label, secret })}\n`);
    process.stderr.write("Operator credential issued once — store it in a secret manager; it is not recoverable.\n");
  } else if (command === "list-credentials") {
    process.stdout.write(`${JSON.stringify(operator.listCredentials(), null, 2)}\n`);
  } else if (command === "revoke-credential") {
    const [id] = args;
    if (!id) fail("Usage: operator-bootstrap revoke-credential <credentialId>");
    if (!operator.revokeCredential(id, actor)) fail(`No active credential: ${id}`);
    process.stdout.write(`${JSON.stringify({ id, revoked: true })}\n`);
  } else if (command === "runtime-status") {
    process.stdout.write(`${JSON.stringify(operator.runtimeState())}\n`);
  } else if (command === "runtime-disable" || command === "runtime-enable") {
    const [reason] = args;
    if (command === "runtime-disable" && !reason) fail("Usage: operator-bootstrap runtime-disable <reason>");
    process.stdout.write(`${JSON.stringify(operator.setRuntimeDisabled(command === "runtime-disable", actor, reason ?? null))}\n`);
  } else {
    fail(`Unknown command: ${command}`);
  }
} finally {
  store.close();
}
