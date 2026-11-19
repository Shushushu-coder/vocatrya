import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECK_ID, buildCheckRecord, checkExportContract, checkRestoreState } from "./backupContract.mjs";

const seeded = { threadId: "thread-e2e-1", conversationId: "c1" };
const okData = (extra = {}) => JSON.stringify({ ChatConversation: [{ id: "c1", title: "t", messages: "[]", ...extra }] });
const failing = (checks) => checks.filter((entry) => !entry.ok).map((entry) => entry.name);
const good = { executionPath: "APP_ORCHESTRATED", nativeInitializationState: "NEVER_ATTEMPTED" };

test("clean export satisfies the contract", () => {
  const checks = checkExportContract({ "data.json": okData(), "manifest.json": "{}" }, seeded);
  assert.deepEqual(failing(checks), []);
});

test("legacy expectation (executionPath retained) is a contract violation", () => {
  const checks = checkExportContract({ "data.json": okData({ executionPath: "APP_ORCHESTRATED" }) }, seeded);
  assert.deepEqual(failing(checks), ["conversation-rows-have-no-native-keys"]);
});

test("binding group, thread id and native path are detected", () => {
  const data = JSON.stringify({ ChatConversation: [{ id: "c1", note: "NATIVE_CODEX_V1" }], NativeConversationBinding: [{ threadId: "thread-e2e-1" }] });
  const names = failing(checkExportContract({ "data.json": data, "manifest.json": "thread-e2e-1" }, seeded));
  assert.deepEqual(names, ["no-binding-group", "no-thread-id-or-native-path"]);
});

test("missing seeded conversation, missing group, bad JSON and missing data.json fail", () => {
  assert.deepEqual(failing(checkExportContract({ "data.json": JSON.stringify({ ChatConversation: [{ id: "x" }] }) }, seeded)), ["seeded-conversation-exported"]);
  assert.ok(failing(checkExportContract({ "data.json": "{}" }, seeded)).includes("conversation-rows-have-no-native-keys"));
  assert.deepEqual(failing(checkExportContract({ "data.json": "{" }, seeded)), ["data-json-parses"]);
  assert.deepEqual(failing(checkExportContract({}, seeded)), ["data-json-present"]);
  assert.deepEqual(failing(checkExportContract({ "data.json": "[]" }, seeded)), ["data-json-parses"]);
});

test("restore state requires reset execution state and zero bindings", () => {
  assert.deepEqual(failing(checkRestoreState({ conversations: [good], bindingCount: 0 })), []);
  assert.deepEqual(failing(checkRestoreState({ conversations: [{ ...good, executionPath: "NATIVE_CODEX_V1" }], bindingCount: 0 })), ["restored-execution-state-reset"]);
  assert.deepEqual(failing(checkRestoreState({ conversations: [good], bindingCount: 1 })), ["restored-binding-rows-zero"]);
  assert.deepEqual(failing(checkRestoreState({ conversations: [], bindingCount: 0 })), ["restored-conversation-present", "restored-execution-state-reset"]);
});

test("check record aggregates status under the stable id", () => {
  const pass = buildCheckRecord({ exportChecks: checkExportContract({ "data.json": okData() }, seeded), restoreChecks: checkRestoreState({ conversations: [good], bindingCount: 0 }), evidence: { a: 1 } });
  assert.equal(pass.id, CHECK_ID);
  assert.equal(CHECK_ID, "backup-excludes-binding");
  assert.equal(pass.status, "PASS");
  const fail = buildCheckRecord({ exportChecks: [], restoreChecks: checkRestoreState({ conversations: [], bindingCount: 2 }) });
  assert.equal(fail.status, "FAIL");
});
