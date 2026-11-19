import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { startDesktop, connectDesktop, stopDesktop } from "./harness.mjs";
import { register } from "./scenario.mjs";
import {
  CHECK_ID,
  NATIVE_EXECUTION_PATH,
  buildCheckRecord,
  checkExportContract,
  checkRestoreState,
} from "./backupContract.mjs";

const require = createRequire(import.meta.url);

function openDb(dataRoot) {
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient({ datasourceUrl: `file:${path.join(dataRoot, "data", "vocatrya.db").replaceAll("\\", "/")}` });
}

async function signUpAndRead(instance, dataRoot, identity) {
  await register(instance.page, instance.origin, identity);
  const prisma = openDb(dataRoot);
  return { prisma, user: await prisma.user.findUniqueOrThrow({ where: { email: identity.email } }) };
}

/**
 * Acceptance scenario for check `backup-excludes-binding`
 * (AGENT-NATIVE-CODEX-V1). Fully synthetic: the native conversation and its
 * binding are seeded straight into the isolated database, no Codex runtime or
 * real account is involved. Export and import go through the app's real
 * /api/backup/* route handlers with the signed-in session cookie.
 */
export async function runBackupExcludesBinding({ appRoot, dataRoot, runRoot, direct, state, electronExe }) {
  const logDirectory = path.join(runRoot, "logs");
  const evidenceDir = path.join(runRoot, "evidence", CHECK_ID);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const launchOptions = { appRoot, electronExe, logDirectory, direct };
  const sourceIdentity = { name: "备份契约源", email: `backup-src-${randomUUID()}@example.test`, password: `Backup-${randomUUID()}!` };
  const restoreIdentity = { name: "备份契约恢复", email: `backup-dst-${randomUUID()}@example.test`, password: `Backup-${randomUUID()}!` };
  const seeded = { conversationId: randomUUID(), threadId: `thread-e2e-${randomUUID()}`, title: `${CHECK_ID} fixture ${randomUUID()}` };
  const restoreRoot = path.join(runRoot, "data-root-restore");

  // 1. Source root: sign up, seed a native conversation + binding, export.
  state.instance = startDesktop({ ...launchOptions, dataRoot, launchNumber: 1 });
  await connectDesktop(state.instance);
  const source = await signUpAndRead(state.instance, dataRoot, sourceIdentity);
  let sourceChecks;
  let exportEntries;
  try {
    await source.prisma.chatConversation.create({
      data: {
        id: seeded.conversationId,
        userId: source.user.id,
        title: seeded.title,
        messages: "[]",
        context: '{"version":1,"items":[],"permissionMode":"ask"}',
        resolvedModel: "gpt-6.1-sol",
        executionPath: NATIVE_EXECUTION_PATH,
        nativeInitializationState: "READY",
      },
    });
    await source.prisma.nativeConversationBinding.create({
      data: {
        conversationId: seeded.conversationId,
        userId: source.user.id,
        connectionId: randomUUID(),
        model: "gpt-6.1-sol",
        runtimeVersion: "0.169.0",
        runtimeProfileRef: "rp_e2e_synthetic",
        configHash: "e2e-config",
        threadId: seeded.threadId,
        promptHash: "e2e-prompt",
      },
    });
    console.log("PASS seeded synthetic native conversation and binding in the isolated source database");

    const response = await state.instance.page.request.get(`${state.instance.origin}/api/backup/export`);
    if (response.status() !== 200) throw new Error(`Backup export returned HTTP ${response.status()}`);
    const zipBytes = await response.body();
    fs.writeFileSync(path.join(evidenceDir, "backup.zip"), zipBytes);
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(zipBytes);
    exportEntries = {};
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir || !/\.(json|txt|md)$/i.test(name)) continue;
      exportEntries[name] = await zip.file(name).async("string");
    }
    fs.writeFileSync(path.join(evidenceDir, "data.json"), exportEntries["data.json"] ?? "");
    console.log(`PASS real export route produced a ZIP (${zipBytes.length} bytes, entries: ${Object.keys(zip.files).length})`);

    // The export must not mutate the source: the binding is still there.
    const stillBound = await source.prisma.nativeConversationBinding.count({ where: { conversationId: seeded.conversationId } });
    const sourceRow = await source.prisma.chatConversation.findUniqueOrThrow({ where: { id: seeded.conversationId } });
    sourceChecks = [{
      name: "source-unchanged-after-export",
      ok: stillBound === 1 && sourceRow.executionPath === NATIVE_EXECUTION_PATH,
      detail: `bindings=${stillBound} executionPath=${sourceRow.executionPath}`,
    }];
  } finally {
    await source.prisma.$disconnect();
  }
  await stopDesktop(state.instance, { requireGraceful: true });
  state.instance = null;

  const exportChecks = checkExportContract(exportEntries, seeded);

  // 2. Fresh isolated root: sign up a different account, restore, inspect.
  state.instance = startDesktop({ ...launchOptions, dataRoot: restoreRoot, launchNumber: 2 });
  await connectDesktop(state.instance);
  const target = await signUpAndRead(state.instance, restoreRoot, restoreIdentity);
  let restoreChecks;
  let restored;
  try {
    const response = await state.instance.page.request.post(`${state.instance.origin}/api/backup/import`, {
      multipart: {
        file: { name: "backup.zip", mimeType: "application/zip", buffer: fs.readFileSync(path.join(evidenceDir, "backup.zip")) },
        confirmWipe: "true",
      },
    });
    const payload = await response.json().catch(() => null);
    if (response.status() !== 200) throw new Error(`Backup import returned HTTP ${response.status()}: ${JSON.stringify(payload).slice(0, 300)}`);
    console.log("PASS real import route restored the backup into the fresh data root");
    const conversations = await target.prisma.chatConversation.findMany({
      where: { userId: target.user.id },
      select: { id: true, title: true, executionPath: true, nativeInitializationState: true },
    });
    const bindingCount = await target.prisma.nativeConversationBinding.count();
    restored = { conversations, bindingCount, importResult: payload };
    restoreChecks = checkRestoreState({ conversations, bindingCount });
    restoreChecks.push({
      name: "restored-seeded-title-present",
      ok: conversations.some((row) => row.title === seeded.title),
      detail: `titles=${conversations.map((row) => row.title).join("|")}`,
    });
  } finally {
    await target.prisma.$disconnect();
  }
  await stopDesktop(state.instance, { requireGraceful: true });
  state.instance = null;

  const record = buildCheckRecord({
    sourceChecks,
    exportChecks,
    restoreChecks,
    evidence: {
      sourceDataRoot: dataRoot,
      restoreDataRoot: restoreRoot,
      seeded,
      zipEntries: Object.keys(exportEntries),
      zipPath: path.join(evidenceDir, "backup.zip"),
      dataJsonPath: path.join(evidenceDir, "data.json"),
      restored,
    },
  });
  fs.writeFileSync(path.join(evidenceDir, "check.json"), JSON.stringify(record, null, 2));
  for (const entry of record.checks) console.log(`${entry.ok ? "PASS" : "FAIL"} ${CHECK_ID}/${entry.name}: ${entry.detail}`);
  console.log(`CHECK ${CHECK_ID} ${record.status} evidence=${path.join(evidenceDir, "check.json")}`);
  if (record.status !== "PASS") throw new Error(`${CHECK_ID} failed; see ${path.join(evidenceDir, "check.json")}`);
}
