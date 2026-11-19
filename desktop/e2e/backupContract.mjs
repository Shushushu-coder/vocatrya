// Pure helpers for the Codex-native backup contract (check id
// `backup-excludes-binding`). No I/O: the desktop scenario feeds them the
// exported ZIP text entries and the restore-side database rows.
//
// Designed contract (src/lib/backup/coverage.ts INTENTIONALLY_EXCLUDED,
// src/lib/backup/schema.ts, src/lib/backup/import.ts):
//   - export: no NativeConversationBinding group, no native thread id anywhere;
//     ChatConversation rows carry neither `executionPath` nor
//     `nativeInitializationState` (the zod export schema strips them).
//   - restore: executionPath = APP_ORCHESTRATED, nativeInitializationState =
//     NEVER_ATTEMPTED, zero binding rows.

export const CHECK_ID = "backup-excludes-binding";
export const BINDING_GROUP = "NativeConversationBinding";
export const NATIVE_EXECUTION_PATH = "NATIVE_CODEX_V1";
export const RESTORED_EXECUTION_PATH = "APP_ORCHESTRATED";
export const RESTORED_INIT_STATE = "NEVER_ATTEMPTED";
export const FORBIDDEN_CONVERSATION_KEYS = ["executionPath", "nativeInitializationState"];

export const EXPECTATION = [
  "export has no NativeConversationBinding group and no native thread id in any ZIP text entry",
  "exported ChatConversation rows have no executionPath / nativeInitializationState keys",
  "after restore into a fresh data root: executionPath=APP_ORCHESTRATED, nativeInitializationState=NEVER_ATTEMPTED, 0 binding rows",
].join("; ");

const item = (name, ok, detail) => ({ name, ok: Boolean(ok), detail });

/**
 * @param {Record<string,string>} texts ZIP text entries by name; must include "data.json"
 * @param {{ threadId: string, conversationId: string }} seeded
 */
export function checkExportContract(texts, seeded) {
  const checks = [];
  const dataText = texts?.["data.json"];
  if (typeof dataText !== "string") {
    return [item("data-json-present", false, "data.json missing from ZIP")];
  }
  let data;
  try { data = JSON.parse(dataText); }
  catch (error) { return [item("data-json-parses", false, String(error.message))]; }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return [item("data-json-parses", false, "data.json is not an object")];
  }

  checks.push(item("no-binding-group", !Object.hasOwn(data, BINDING_GROUP),
    Object.hasOwn(data, BINDING_GROUP) ? `${BINDING_GROUP} group present` : "group absent"));

  const leaks = Object.entries(texts)
    .filter(([, text]) => typeof text === "string" && (text.includes(seeded.threadId) || text.includes(NATIVE_EXECUTION_PATH)))
    .map(([name]) => name);
  checks.push(item("no-thread-id-or-native-path", leaks.length === 0,
    leaks.length ? `native marker found in: ${leaks.join(", ")}` : "no thread id / NATIVE_CODEX_V1 in any entry"));

  const rows = Array.isArray(data.ChatConversation) ? data.ChatConversation : null;
  checks.push(item("seeded-conversation-exported", rows?.some((row) => row?.id === seeded.conversationId),
    rows ? `${rows.length} ChatConversation row(s)` : "ChatConversation group missing"));

  const offenders = (rows ?? []).flatMap((row) => FORBIDDEN_CONVERSATION_KEYS.filter((key) => row && Object.hasOwn(row, key)).map((key) => `${row.id}:${key}`));
  checks.push(item("conversation-rows-have-no-native-keys", rows !== null && offenders.length === 0,
    offenders.length ? `forbidden keys: ${offenders.join(", ")}` : "no executionPath / nativeInitializationState keys"));
  return checks;
}

/** @param {{ conversations: {executionPath:string, nativeInitializationState:string}[], bindingCount: number }} state */
export function checkRestoreState({ conversations, bindingCount }) {
  const bad = conversations.filter((row) => row.executionPath !== RESTORED_EXECUTION_PATH || row.nativeInitializationState !== RESTORED_INIT_STATE);
  return [
    item("restored-conversation-present", conversations.length > 0, `${conversations.length} restored conversation(s)`),
    item("restored-execution-state-reset", conversations.length > 0 && bad.length === 0,
      bad.length ? `unexpected: ${JSON.stringify(bad)}` : `all ${RESTORED_EXECUTION_PATH}/${RESTORED_INIT_STATE}`),
    item("restored-binding-rows-zero", bindingCount === 0, `${bindingCount} binding row(s)`),
  ];
}

/** Build the check record emitted as evidence JSON. */
export function buildCheckRecord({ exportChecks, restoreChecks, sourceChecks = [], evidence = {} }) {
  const checks = [...sourceChecks, ...exportChecks, ...restoreChecks];
  return {
    id: CHECK_ID,
    status: checks.every((entry) => entry.ok) ? "PASS" : "FAIL",
    expectation: EXPECTATION,
    checks,
    evidence,
  };
}
