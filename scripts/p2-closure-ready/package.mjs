import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
export const ENV = { VOCATRYA_AB_RUNTIME_ENABLED: 'true', VOCATRYA_AB_ROLLOUT_SCOPE: 'full' };
const require = createRequire(import.meta.url);
register(pathToFileURL(path.join(ROOT, 'scripts/p2-closure-ready/ts-loader.mjs')).href, import.meta.url);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function inside(parent, target) {
  const rel = path.relative(parent, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function noLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current)) assert(!fs.lstatSync(current).isSymbolicLink(), 'Symlink/junction refused: ' + current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function safeRun(input) {
  assert(typeof input === 'string' && input.length > 0, '--run is required');
  const run = path.resolve(ROOT, input);
  assert(inside(path.join(ROOT, '.tmp/p2-closure-ready/runs'), run), 'Run must be below this Worktree .tmp/p2-closure-ready/runs');
  noLinks(run);
  return run;
}
export function localDependencies() {
  const modules = path.join(ROOT, 'node_modules');
  assert(fs.existsSync(modules), 'Install private dependencies in this Worktree first');
  noLinks(modules);
  for (const name of ['@prisma/client', 'prisma', 'bcryptjs', 'unpdf', '@playwright/test']) {
    const resolved = fs.realpathSync(require.resolve(name === 'prisma' ? 'prisma/package.json' : name));
    assert(inside(modules, resolved), 'Dependency must resolve inside private node_modules: ' + name);
  }
  const generated = path.join(modules, '.prisma/client');
  assert(fs.existsSync(generated), 'Generate this Worktree Prisma client first');
  noLinks(generated);
  return modules;
}
export function argumentsFor(argv, allowedModes) {
  const mode = argv[0];
  if (mode === '--help') return { help: true };
  assert(allowedModes.includes(mode), 'Expected mode: ' + allowedModes.join('|'));
  assert(argv.length === 3 && argv[1] === '--run', 'Usage: <mode> --run <new-or-owned-run-directory>');
  return { mode, run: safeRun(argv[2]) };
}
export function loadManifest(input) {
  const run = safeRun(input);
  const owner = JSON.parse(fs.readFileSync(path.join(run, 'owner.json'), 'utf8'));
  assert.equal(owner.task, 'p2-closure-ready');
  assert.equal(path.resolve(owner.worktree), ROOT);
  assert.equal(path.resolve(owner.run), run);
  const manifest = JSON.parse(fs.readFileSync(path.join(run, 'manifest.json'), 'utf8'));
  assert.equal(manifest.ownerToken, owner.token);
  assert.equal(manifest.baseline, BASELINE);
  assert.equal(manifest.run, run);
  assert.equal(manifest.dataRoot, path.join(run, 'data-root'));
  assert.equal(manifest.db, path.join(manifest.dataRoot, 'data/vocatrya.db'));
  assert.equal(manifest.uploadsRoot, path.join(manifest.dataRoot, 'files'));
  noLinks(manifest.db);
  assert(fs.statSync(manifest.db).isFile(), 'Owned database missing');
  return manifest;
}
export async function openDb(manifest) {
  localDependencies();
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({ datasourceUrl: 'file:' + manifest.db.replaceAll('\\', '/') });
}
export function evidenceDirectory(run, phase) {
  const directory = path.join(run, 'checks', phase + '-' + randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
export async function step(directory, name, action, scope = 'NON_DESKTOP') {
  const startedAt = new Date().toISOString();
  try {
    const observed = await action();
    json(path.join(directory, name + '.json'), { name, scope, status: 'PASS', startedAt, finishedAt: new Date().toISOString(), observed });
    console.log(scope + ' PASS ' + name);
    return observed;
  } catch (error) {
    json(path.join(directory, name + '.json'), { name, scope, status: 'FAIL', startedAt, finishedAt: new Date().toISOString(), error: String(error?.stack ?? error) });
    throw error;
  }
}
function cleanEnvironment(db) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, DATABASE_URL: 'file:' + db.replaceAll('\\', '/'), PRISMA_HIDE_UPDATE_MESSAGE: '1', CHECKPOINT_DISABLE: '1', NEXT_TELEMETRY_DISABLED: '1' };
}
function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
}
function pdfFixture(label) {
  assert(/^[A-Za-z0-9 -]+$/.test(label));
  const stream = 'BT /F1 12 Tf 72 720 Td (' + label + ') Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + 'endstream'
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xref = Buffer.byteLength(document);
  document += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) document += String(offset).padStart(10, '0') + ' 00000 n \n';
  document += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(document, 'ascii');
}

export async function prepare(runInput) {
  const run = safeRun(runInput);
  localDependencies();
  assert.equal(git('rev-parse', 'HEAD'), BASELINE, 'Unexpected source baseline');
  assert(!fs.existsSync(run), 'Refusing to reuse any existing run directory');
  fs.mkdirSync(path.dirname(run), { recursive: true });
  fs.mkdirSync(run);
  const owner = { task: 'p2-closure-ready', token: randomUUID(), worktree: ROOT, run, createdAt: new Date().toISOString() };
  json(path.join(run, 'owner.json'), owner);
  const directory = evidenceDirectory(run, 'prepare');
  const dataRoot = path.join(run, 'data-root');
  const db = path.join(dataRoot, 'data/vocatrya.db');
  const uploadsRoot = path.join(dataRoot, 'files');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.mkdirSync(uploadsRoot, { recursive: true });
  fs.writeFileSync(db, '', { flag: 'wx' });
  const schemaRoot = path.join(run, 'schema');
  fs.mkdirSync(schemaRoot);
  json(path.join(schemaRoot, 'package.json'), { private: true, name: 'p2-isolated-schema' });
  await step(directory, '01-migrations', async () => {
    const files = git('ls-files', '--', 'prisma/schema.prisma', 'prisma/migrations').split(/\r?\n/).filter(Boolean);
    assert(files.includes('prisma/schema.prisma'));
    assert(files.some(file => file.endsWith('/migration.sql')));
    const sourceFiles = [];
    for (const file of files) {
      assert(file === 'prisma/schema.prisma' || /^prisma\/migrations\/(?:[^/]+\/migration\.sql|migration_lock\.toml)$/.test(file), 'Unexpected migration source: ' + file);
      const bytes = fs.readFileSync(path.join(ROOT, file));
      const target = path.join(schemaRoot, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
      sourceFiles.push({ file, sha256: hash(bytes) });
    }
    json(path.join(run, 'schema-sources.json'), sourceFiles);
    const output = execFileSync(process.execPath, [path.join(ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', path.join(schemaRoot, 'prisma/schema.prisma')], { cwd: schemaRoot, env: cleanEnvironment(db), encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    fs.writeFileSync(path.join(directory, 'migrate.stdout.txt'), output, { flag: 'wx' });
    return { database: db, sourceCount: files.length, stdout: 'migrate.stdout.txt' };
  });
  const manifest = {
    schemaVersion: 1, task: owner.task, ownerToken: owner.token, baseline: BASELINE,
    sourceDirtyFiles: git('diff', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean),
    run, dataRoot, db, uploadsRoot, accountTimeZone: 'America/Los_Angeles',
    observedPreparationHostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    desktopHostTimeZone: 'Asia/Shanghai',
    clock: '2026-11-10T12:00:00.000Z',
    boundary: { before: '2026-11-10T07:59:00.000Z', after: '2026-11-10T08:01:00.000Z', accountBeforeDay: '2026-11-09', accountAfterDay: '2026-11-10', shanghaiBeforeDay: '2026-11-10' },
    credentials: { primaryEmail: 'p2-primary@example.test', foreignEmail: 'p2-foreign@example.test', syntheticPassword: 'P2-Isolated-Only-2026!' },
    ids: {}, versions: [], artifacts: [],
    desktopAssertions: { r6DraftThenComplete: 'NOT_RUN', archiveRestore: 'NOT_RUN', connectionsMutations: 'NOT_RUN', historyNoDrift: 'NOT_RUN', artifactUiDownload: 'NOT_RUN', analyticsDrilldown: 'NOT_RUN', dashboardZeroAiAndBusinessWrites: 'NOT_RUN', quitReopen: 'NOT_RUN' }
  };
  const prisma = await openDb(manifest);
  try {
    await step(directory, '02-fresh-activation', async () => {
      const { activateFreshAbNative } = await import(pathToFileURL(path.join(ROOT, 'src/lib/career/freshActivation.ts')).href);
      const result = await activateFreshAbNative(prisma);
      assert.equal(result.status, 'FRESH_READY');
      assert(result.verifiedAt);
      return result;
    });
    await step(directory, '03-synthetic-fixtures', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      const password = await bcrypt.hash(manifest.credentials.syntheticPassword, 10);
      await prisma.$transaction(async tx => {
        for (const [value, label] of [['draft', 'Draft'], ['interview', 'Interview']]) {
          await tx.jobStatus.upsert({ where: { value }, create: { value, label }, update: {} });
        }
        const primary = await tx.user.create({ data: { name: 'P2 primary synthetic', email: manifest.credentials.primaryEmail, password } });
        const foreign = await tx.user.create({ data: { name: 'P2 foreign synthetic', email: manifest.credentials.foreignEmail, password } });
        Object.assign(manifest.ids, { primaryUser: primary.id, foreignUser: foreign.id });
        await tx.userSettings.create({ data: { userId: primary.id, settings: JSON.stringify({ settings: { general: { timeZone: manifest.accountTimeZone } } }) } });
        await tx.userSettings.create({ data: { userId: foreign.id, settings: JSON.stringify({ settings: { general: { timeZone: 'Pacific/Auckland' } } }) } });
        const company = await tx.company.create({ data: { label: 'P2 Synthetic Company', value: 'p2-synthetic', createdBy: primary.id } });
        await tx.jobTitle.create({ data: { createdBy: primary.id, label: 'P2 dual application role', value: 'p2-dual-application' } });
        await tx.location.create({ data: { createdBy: primary.id, label: 'P2 Shanghai', value: 'p2-shanghai' } });
        await tx.jobSource.create({ data: { createdBy: primary.id, label: 'P2 synthetic source', value: 'p2-synthetic-source' } });
        const job = await tx.jobOpportunity.create({ data: { userId: primary.id, companyId: company.id, title: 'P2 dual application role', locationText: 'P2 Shanghai', sourceLabel: 'P2 synthetic source', employmentType: 'FT', workplaceType: 'REMOTE', status: 'ACTIVE', createdVia: 'USER' } });
        manifest.ids.job = job.id;
        const jds = [];
        for (let number = 1; number <= 3; number++) {
          const rawContent = 'P2 synthetic JD revision ' + number + ': TypeScript, local-first applications';
          jds.push(await tx.jobDescriptionVersion.create({ data: { jobOpportunityId: job.id, versionNumber: number, rawContent, contentHash: hash(rawContent), capturedAt: new Date('2026-11-01T00:00:00Z'), createdVia: 'USER' } }));
        }
        manifest.ids.jds = jds.map(row => row.id);
        await tx.jobOpportunity.update({ where: { id: job.id }, data: { currentJdVersionId: jds[2].id } });
        const variant = await tx.resumeVariant.create({ data: { userId: primary.id, name: 'P2 primary resume family', targetJobOpportunityId: job.id } });
        manifest.ids.variant = variant.id;
        let parentVersionId = null;
        for (let number = 1; number <= 3; number++) {
          const headerSnapshot = JSON.stringify({ fullName: 'P2 Applicant Revision ' + number, headline: 'Synthetic TypeScript applicant', email: primary.email, links: [] });
          const version = await tx.resumeVariantVersion.create({ data: { resumeVariantId: variant.id, versionNumber: number, parentVersionId, status: number < 3 ? 'FROZEN' : 'DRAFT', frozenAt: number < 3 ? new Date('2026-11-02T00:00:00Z') : null, headerSnapshot, targetJdVersionId: jds[number - 1].id, locale: 'en' } });
          manifest.versions.push({ id: version.id, number, family: variant.id, headerSnapshot, targetJdVersionId: jds[number - 1].id });
          parentVersionId = version.id;
        }
        await tx.resumeVariant.update({ where: { id: variant.id }, data: { currentVersionId: parentVersionId } });
        const alternate = await tx.resumeVariant.create({ data: { userId: primary.id, name: 'P2 alternate plan family' } });
        manifest.ids.alternateVariant = alternate.id;
        let alternateParent = null;
        for (let number = 1; number <= 2; number++) {
          const version = await tx.resumeVariantVersion.create({ data: { resumeVariantId: alternate.id, versionNumber: number, parentVersionId: alternateParent, status: 'DRAFT', headerSnapshot: JSON.stringify({ fullName: 'P2 Alternate ' + number, links: [] }) } });
          alternateParent = version.id;
        }
        await tx.resumeVariant.update({ where: { id: alternate.id }, data: { currentVersionId: alternateParent } });
        async function artifact(versionId, label, ownerUserId) {
          const id = randomUUID();
          const bytes = pdfFixture(label);
          const fileName = label.replaceAll(' ', '-') + '.pdf';
          const storageKey = 'resume-artifacts/' + id + '/' + fileName;
          const target = path.join(uploadsRoot, ...storageKey.split('/'));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, bytes, { flag: 'wx' });
          const row = await tx.resumeArtifact.create({ data: { id, resumeVariantVersionId: versionId, kind: 'EXPORT', format: 'PDF', storageKey, fileName, sha256: hash(bytes), byteSize: bytes.length } });
          manifest.artifacts.push({ id, ownerUserId, versionId, storageKey, fileName, sha256: row.sha256, byteSize: row.byteSize, text: label });
          return row;
        }
        const firstArtifact = await artifact(manifest.versions[0].id, 'P2 submission version 1', primary.id);
        const secondArtifact = await artifact(manifest.versions[1].id, 'P2 submission version 2', primary.id);
        const attempts = [];
        for (let index = 0; index < 2; index++) {
          attempts.push(await tx.applicationAttempt.create({ data: { userId: primary.id, jobOpportunityId: job.id, channelLabel: 'P2 synthetic channel ' + (index + 1), submittedAt: new Date(index === 0 ? manifest.boundary.before : manifest.boundary.after), currentStageCategory: 'INTERVIEW', outcome: 'ACTIVE', submittedResumeVersionId: manifest.versions[index].id, submittedResumeArtifactId: index === 0 ? firstArtifact.id : secondArtifact.id, submittedAgainstJdVersionId: jds[index].id, createdVia: 'USER' } }));
        }
        manifest.ids.attempts = attempts.map(row => row.id);
        const targetStep = await tx.applicationProcessStep.create({ data: { applicationAttemptId: attempts[0].id, category: 'INTERVIEW', label: 'P2-R6-target', status: 'COMPLETED', source: 'USER', sortOrder: 1, completedAt: new Date('2026-11-09T20:00:00Z'), completedAtPrecision: 'fullInstant' } });
        await tx.applicationInterviewDetail.create({ data: { applicationProcessStepId: targetStep.id, roundLabel: 'P2-R6-target' } });
        manifest.ids.r6Step = targetStep.id;
        manifest.r6Label = targetStep.label;
        const doneStep = await tx.applicationProcessStep.create({ data: { applicationAttemptId: attempts[1].id, category: 'INTERVIEW', label: 'P2 already reflected round', status: 'COMPLETED', source: 'USER', sortOrder: 1, completedAt: new Date('2026-11-09T21:00:00Z'), completedAtPrecision: 'fullInstant' } });
        await tx.applicationInterviewDetail.create({ data: { applicationProcessStepId: doneStep.id, reflectionText: 'Synthetic completed baseline reflection', reflectionCompletedAt: new Date('2026-11-09T22:00:00Z') } });
        manifest.ids.completedStep = doneStep.id;
        const archived = await tx.jobOpportunity.create({ data: { userId: primary.id, companyId: company.id, title: 'P2 archived reference role', status: 'ACTIVE', archivedAt: new Date('2026-11-01T00:00:00Z'), createdVia: 'USER' } });
        const archivedAttempt = await tx.applicationAttempt.create({ data: { userId: primary.id, jobOpportunityId: archived.id, channelLabel: 'P2 archived channel', submittedAt: new Date('2026-10-01T12:00:00Z'), currentStageCategory: 'INTERVIEW', outcome: 'ACTIVE' } });
        const archivedStep = await tx.applicationProcessStep.create({ data: { applicationAttemptId: archivedAttempt.id, category: 'INTERVIEW', label: 'P2 archived awaiting round', status: 'COMPLETED', source: 'USER', sortOrder: 1, completedAt: new Date('2026-10-02T12:00:00Z'), completedAtPrecision: 'fullInstant' } });
        Object.assign(manifest.ids, { archivedJob: archived.id, archivedAttempt: archivedAttempt.id, archivedStep: archivedStep.id });
        const task = await tx.task.create({ data: { userId: primary.id, title: 'P2 timezone boundary follow-up', status: 'in-progress', dueOn: '2026-11-10', duePrecision: 'dateOnly' } });
        manifest.ids.task = task.id;
        const foreignCompany = await tx.company.create({ data: { label: 'P2 Foreign Company', value: 'p2-foreign', createdBy: foreign.id } });
        const foreignJob = await tx.jobOpportunity.create({ data: { userId: foreign.id, companyId: foreignCompany.id, title: 'P2 permission sentinel role', status: 'ACTIVE' } });
        const foreignVariant = await tx.resumeVariant.create({ data: { userId: foreign.id, name: 'P2 foreign resume' } });
        const foreignVersion = await tx.resumeVariantVersion.create({ data: { resumeVariantId: foreignVariant.id, versionNumber: 1, status: 'FROZEN', frozenAt: new Date('2026-11-01T00:00:00Z'), headerSnapshot: JSON.stringify({ fullName: 'P2 foreign applicant', links: [] }) } });
        await tx.resumeVariant.update({ where: { id: foreignVariant.id }, data: { currentVersionId: foreignVersion.id } });
        const foreignArtifact = await artifact(foreignVersion.id, 'P2 foreign submission', foreign.id);
        const foreignAttempt = await tx.applicationAttempt.create({ data: { userId: foreign.id, jobOpportunityId: foreignJob.id, channelLabel: 'P2 foreign channel', submittedAt: new Date(manifest.boundary.before), currentStageCategory: 'INTERVIEW', submittedResumeVersionId: foreignVersion.id, submittedResumeArtifactId: foreignArtifact.id } });
        const foreignStep = await tx.applicationProcessStep.create({ data: { applicationAttemptId: foreignAttempt.id, category: 'INTERVIEW', label: 'P2 foreign awaiting round', status: 'COMPLETED', source: 'USER', sortOrder: 1, completedAt: new Date('2026-11-09T22:00:00Z'), completedAtPrecision: 'fullInstant' } });
        Object.assign(manifest.ids, { foreignJob: foreignJob.id, foreignVersion: foreignVersion.id, foreignArtifact: foreignArtifact.id, foreignStep: foreignStep.id });
        const connection = await tx.aIConnection.create({ data: { userId: primary.id, provider: 'DEEPSEEK', backendKind: 'LOCAL_BYOK', authType: 'API_KEY', displayName: 'P2 stored-state-only synthetic binding', status: 'CONNECTED', credentialRef: randomUUID() } });
        await tx.aIBusinessAssignment.create({ data: { userId: primary.id, purpose: 'CAREER_DIALOGUE', connectionId: connection.id, model: 'deepseek-chat' } });
        manifest.ids.syntheticConnection = connection.id;
      }, { maxWait: 10000, timeout: 60000 });
      return { ids: manifest.ids, versionCount: manifest.versions.length, artifactCount: manifest.artifacts.length, syntheticAiBinding: 'Stored-state fixture only; no ApiKey row, no usable credentials, never send' };
    });
    json(path.join(run, 'manifest.json'), manifest);
    console.log('PREPARED ' + path.join(run, 'manifest.json'));
  } finally {
    await prisma.$disconnect();
  }
  return manifest;
}

function day(instant, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}
export async function validate(runInput) {
  const m = loadManifest(runInput);
  const directory = evidenceDirectory(m.run, 'validate');
  const db = await openDb(m);
  try {
    await step(directory, '01-identity-runtime', async () => {
      const user = await db.user.findUniqueOrThrow({ where: { id: m.ids.primaryUser } });
      assert.equal(user.email, m.credentials.primaryEmail);
      const marker = await db.abMigrationState.findUniqueOrThrow({ where: { scopeKey: 'instance' } });
      assert.equal(marker.status, 'FRESH_READY');
      assert.equal(marker.migrationKey, 'vocatrya-ab-fresh-native-v1');
      assert(marker.verifiedAt);
      const { resolveCareerRuntimeMode } = await import(pathToFileURL(path.join(ROOT, 'src/lib/career/runtimeMode.ts')).href);
      const runtime = await resolveCareerRuntimeMode(db, { env: ENV });
      assert.equal(runtime.mode, 'AB_ENABLED');
      assert.equal(runtime.origin, 'fresh');
      assert.equal(runtime.rolloutScope, 'full');
      return { userId: user.id, runtime };
    });
    await step(directory, '02-double-submission-snapshots', async () => {
      const attempts = await db.applicationAttempt.findMany({ where: { jobOpportunityId: m.ids.job }, orderBy: { submittedAt: 'asc' }, include: { submittedResumeVersion: true, submittedResumeArtifact: true } });
      assert.deepEqual(attempts.map(row => row.id), m.ids.attempts);
      assert.equal(new Set(attempts.map(row => row.submittedResumeVersionId)).size, 2);
      assert.equal(new Set(attempts.map(row => row.submittedResumeArtifactId)).size, 2);
      for (let index = 0; index < attempts.length; index++) {
        const row = attempts[index];
        assert.equal(row.userId, m.ids.primaryUser);
        assert.equal(row.submittedResumeVersion.headerSnapshot, m.versions[index].headerSnapshot);
        assert.equal(row.submittedResumeArtifact.resumeVariantVersionId, row.submittedResumeVersionId);
        assert.equal(row.submittedAgainstJdVersionId, m.ids.jds[index]);
      }
      const family = await db.resumeVariant.findUniqueOrThrow({ where: { id: m.ids.variant }, include: { versions: true } });
      assert.equal(family.versions.length, 3);
      assert.equal(family.currentVersionId, m.versions[2].id);
      assert.equal(await db.resumeVariantVersion.count({ where: { resumeVariantId: m.ids.alternateVariant } }), 2);
      return { attempts: attempts.map(row => ({ id: row.id, version: row.submittedResumeVersionId, artifact: row.submittedResumeArtifactId, jd: row.submittedAgainstJdVersionId })), currentVersion: family.currentVersionId, scope: 'Seed invariants only; post-edit UI history stability NOT_RUN' };
    });
    await step(directory, '03-valid-pdf-bytes', async () => {
      const { extractText } = await import('unpdf');
      const observed = [];
      for (const artifact of m.artifacts) {
        assert(/^resume-artifacts\/[a-zA-Z0-9_-]+\/[^/\\]+$/.test(artifact.storageKey));
        const file = path.resolve(m.uploadsRoot, ...artifact.storageKey.split('/'));
        assert(inside(m.uploadsRoot, file));
        noLinks(file);
        const bytes = fs.readFileSync(file);
        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
        assert.equal(hash(bytes), artifact.sha256);
        assert.equal(bytes.length, artifact.byteSize);
        const parsed = await extractText(new Uint8Array(bytes), { mergePages: true });
        assert.equal(parsed.totalPages, 1);
        assert(String(parsed.text).includes(artifact.text), 'PDF parser did not observe expected text');
        observed.push({ id: artifact.id, bytes: bytes.length, sha256: hash(bytes), pages: parsed.totalPages, text: parsed.text });
      }
      return observed;
    });
    await step(directory, '04-account-day-boundary', async () => {
      const row = await db.userSettings.findUniqueOrThrow({ where: { userId: m.ids.primaryUser } });
      assert.equal(JSON.parse(row.settings).settings?.general?.timeZone, m.accountTimeZone);
      assert.notEqual(m.accountTimeZone, m.observedPreparationHostTimeZone);
      assert.equal(day(m.boundary.before, m.accountTimeZone), m.boundary.accountBeforeDay);
      assert.equal(day(m.boundary.after, m.accountTimeZone), m.boundary.accountAfterDay);
      assert.equal(day(m.boundary.before, m.desktopHostTimeZone), m.boundary.shanghaiBeforeDay);
      return m.boundary;
    });
    await step(directory, '05-read-models-and-no-writes', async () => {
      const tables = ['user', 'userSettings', 'company', 'jobOpportunity', 'jobDescriptionVersion', 'applicationAttempt', 'applicationProcessStep', 'applicationInterviewDetail', 'applicationInterviewReflectionItem', 'resumeVariant', 'resumeVariantVersion', 'resumeArtifact', 'task', 'reminder', 'aIConnection', 'aIBusinessAssignment', 'agentToolExecution', 'chatConversation', 'interviewSession'];
      async function signature() {
        const observed = {};
        for (const table of tables) observed[table] = await db[table].findMany({ orderBy: { id: 'asc' } });
        return hash(JSON.stringify(observed));
      }
      const before = await signature();
      const { listNextActionCandidates } = await import(pathToFileURL(path.join(ROOT, 'src/lib/career/nextActionsReadModel.ts')).href);
      const { listAwaitingReflectionInterviews } = await import(pathToFileURL(path.join(ROOT, 'src/lib/career/upcomingReadModel.ts')).href);
      const { loadCareerInsights } = await import(pathToFileURL(path.join(ROOT, 'src/lib/career/careerInsightsReadModel.ts')).href);
      const awaiting = await listAwaitingReflectionInterviews(db, m.ids.primaryUser);
      assert.equal(awaiting.totalCount, 1);
      assert.deepEqual(awaiting.items.map(item => item.stepId), [m.ids.r6Step]);
      const detail = await db.applicationInterviewDetail.findUniqueOrThrow({ where: { applicationProcessStepId: m.ids.r6Step } });
      assert.equal(detail.reflectionCompletedAt, null);
      assert.equal(detail.reflectionText, null, 'Validate expects pristine seed; use a new run after UI');
      const candidates = await listNextActionCandidates(db, m.ids.primaryUser, { jobsFamily: 'ab', resumeFamily: 'ab', jobMutationsEnabled: true, reflectionWriteEnabled: true, aiConfigStatus: 'RESOLVED', timeZone: m.accountTimeZone, now: new Date(m.clock) });
      assert.deepEqual(candidates.map(item => item.id), ['R6:' + m.ids.r6Step]);
      const insights = await loadCareerInsights(db, m.ids.primaryUser, { timeZone: m.accountTimeZone, now: new Date(m.clock), env: ENV });
      assert.equal(insights.family, 'ab');
      assert.equal(insights.board.total, 1);
      assert.equal(insights.board.appliedPositions, 1);
      assert.equal(insights.board.appliedAttempts, 2);
      assert.equal(insights.board.interview.scope, 'rounds');
      assert.equal(insights.board.interview.completedRounds, 2);
      assert.equal(insights.board.interview.scheduledRounds, 0);
      assert.equal(insights.awaitingReflectionInterviews, 1);
      assert.equal(insights.firstAppliedByDay.find(item => item.date === m.boundary.accountBeforeDay)?.count, 1);
      assert.equal(insights.firstAppliedByDay.reduce((sum, item) => sum + item.count, 0), 2, 'Primary main + archived historical first submissions only');
      const after = await signature();
      assert.equal(after, before, 'Observed tables changed during direct reads');
      return { candidates, insights, observedTables: tables, before, after, limitations: 'Injected stored AI status tests rule input only. No UI/network zero-AI assertion; Reminder tick not running here.' };
    });
    await step(directory, '06-artifact-service-permissions', async () => {
      const { ResumeArtifactService } = await import(pathToFileURL(path.join(ROOT, 'src/lib/career/resumeArtifactService.ts')).href);
      const service = new ResumeArtifactService(db, m.ids.primaryUser, ENV, m.uploadsRoot);
      const owned = m.artifacts.filter(row => row.ownerUserId === m.ids.primaryUser);
      const observed = [];
      for (const artifact of owned) {
        const result = await service.openForDownload(artifact.id);
        assert.equal(hash(result.bytes), artifact.sha256);
        observed.push({ id: artifact.id, sha256: hash(result.bytes) });
      }
      await assert.rejects(() => service.openForDownload(m.ids.foreignArtifact), error => error.code === 'ARTIFACT_NOT_FOUND');
      const foreign = new ResumeArtifactService(db, m.ids.foreignUser, ENV, m.uploadsRoot);
      await assert.rejects(() => foreign.openForDownload(owned[0].id), error => error.code === 'ARTIFACT_NOT_FOUND');
      return { ownedReads: observed, reciprocalForeignRead: 'ARTIFACT_NOT_FOUND', scope: 'Real service and fixture bytes; HTTP and UI download NOT_RUN' };
    });
    json(path.join(directory, 'desktop-status.json'), { scope: 'WINDOWS_ELECTRON', status: 'NOT_RUN', assertions: m.desktopAssertions });
    console.log('VALIDATED ' + directory);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsFor(process.argv.slice(2), ['prepare', 'validate']);
    if (args.help) console.log('Usage: node --experimental-strip-types --experimental-transform-types scripts/p2-closure-ready/package.mjs <prepare|validate> --run .tmp/p2-closure-ready/runs/<new-name>');
    else if (args.mode === 'prepare') await prepare(args.run);
    else await validate(args.run);
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
