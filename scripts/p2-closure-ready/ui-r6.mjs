import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { argumentsFor, loadManifest, openDb, evidenceDirectory, step, localDependencies } from './package.mjs';

// Called only by the authorized desktop executor with the existing harness instance.
// This module never builds, launches, connects to arbitrary CDP, quits or kills anything.
export async function runR6(instance, { runRoot }) {
  const manifest = loadManifest(runRoot);
  const evidence = evidenceDirectory(manifest.run, 'electron-r6');
  const { expect } = await import('@playwright/test');
  const db = await openDb(manifest);
  const page = instance?.page;
  const origin = instance?.origin;
  const targetId = 'next-action-R6:' + manifest.ids.r6Step;
  const draftText = 'P2 UI draft ' + path.basename(evidence);
  async function observed(name, action) {
    return step(evidence, name, async () => {
      try {
        const observation = await action();
        const screenshot = name + '.png';
        await page.screenshot({ path: path.join(evidence, screenshot), fullPage: true });
        return { ...observation, screenshot, url: page.url() };
      } catch (error) {
        if (page && !page.isClosed()) {
          try { await page.screenshot({ path: path.join(evidence, name + '-failure.png'), fullPage: true }); }
          catch (captureError) { console.error('Screenshot failure: ' + captureError.message); }
        }
        throw error;
      }
    }, 'WINDOWS_ELECTRON');
  }
  async function dashboard(expected) {
    await page.goto(origin + '/dashboard', { waitUntil: 'load' });
    await expect(page.getByTestId('journey-overview')).toBeVisible();
    if (expected) {
      await expect(page.getByTestId('next-actions')).toBeVisible();
      await expect(page.getByTestId(targetId)).toBeVisible();
      await expect(page.locator('[data-testid^="next-action-"]')).toHaveCount(1);
      await expect(page.getByTestId('next-actions-overflow')).toHaveCount(0);
    } else {
      await expect(page.locator('[data-testid^="next-action-"]')).toHaveCount(0);
      await expect(page.getByTestId('next-actions')).toHaveCount(0);
      await expect(page.getByTestId('next-actions-overflow')).toHaveCount(0);
    }
    return await page.locator('[data-testid^="next-action-"]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-testid'), text: node.textContent, href: node.getAttribute('href') })));
  }
  async function detail() {
    return db.applicationInterviewDetail.findUniqueOrThrow({ where: { applicationProcessStepId: manifest.ids.r6Step } });
  }
  async function openFromCandidate() {
    await page.getByTestId(targetId).click();
    await expect(page).toHaveURL(origin + '/dashboard/myjobs/' + manifest.ids.job + '?tab=timeline');
    const row = page.getByTestId('application-process-step').filter({ hasText: manifest.r6Label });
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('data-step-status', 'COMPLETED');
    await expect(row).toHaveAttribute('data-step-source', 'USER');
    await row.getByTestId('interview-reflection-entry').click();
    await expect(page.getByTestId('interview-reflection-dialog')).toBeVisible();
    await expect(page.getByTestId('interview-reflection-overall')).toBeVisible();
    await expect(page.getByTestId('interview-reflection-completed')).toBeEnabled();
  }
  try {
    await observed('01-owned-desktop-and-pristine-target', async () => {
      assert(instance?.child?.pid, 'Existing harness-owned Electron process is required');
      assert.equal(instance.child.exitCode, null);
      assert.equal(instance.child.signalCode, null);
      assert.equal(path.resolve(instance.backendLog), path.join(manifest.dataRoot, 'logs/backend-stdout.log'));
      assert.equal(path.resolve(instance.activePortFile), path.join(manifest.dataRoot, 'electron/DevToolsActivePort'));
      assert(Number.isInteger(instance.offset) && instance.offset >= 0);
      const log = fs.readFileSync(instance.backendLog).subarray(instance.offset).toString('utf8');
      assert(/state=FRESH_READY mode=AB_ENABLED .*scope=full/.test(log), 'Current launch must prove fresh-native/full');
      const url = new URL(origin);
      assert.equal(url.protocol, 'http:');
      assert.equal(url.hostname, '127.0.0.1');
      assert(url.port, 'Dynamic backend port required');
      await expect(page.locator('html[data-desktop="true"]')).toHaveCount(1);
      await expect(page.getByTestId('desktop-titlebar')).toBeVisible();
      assert(await page.evaluate(() => Boolean(window.vocatryaWindow && window.vocatryaDesktop?.quit)), 'Real preload bridge required');
      const response = await page.request.get(origin + '/api/auth/session');
      assert.equal(response.status(), 200);
      const session = await response.json();
      assert.equal(session.user?.id, manifest.ids.primaryUser);
      const before = await detail();
      assert.equal(before.reflectionCompletedAt, null);
      assert.equal(before.reflectionText, null, 'Use a fresh run; this target was already edited');
      return { pid: instance.child.pid, origin, userId: session.user.id, dataRoot: manifest.dataRoot, target: before };
    });
    await observed('02-one-visible-r6-no-overflow', async () => ({ candidates: await dashboard(true) }));
    await observed('03-ui-save-incomplete-draft', async () => {
      await openFromCandidate();
      await page.getByTestId('interview-reflection-overall').fill(draftText);
      await page.getByTestId('interview-reflection-completed').uncheck();
      await page.getByTestId('interview-reflection-save').click();
      await expect(page.getByTestId('interview-reflection-dialog')).toBeHidden();
      await expect.poll(async () => {
        const row = await detail();
        return { text: row.reflectionText, completed: row.reflectionCompletedAt !== null };
      }).toEqual({ text: draftText, completed: false });
      return { persisted: await detail() };
    });
    await observed('04-draft-still-visible-after-refresh', async () => {
      const candidates = await dashboard(true);
      await page.reload({ waitUntil: 'load' });
      await expect(page.getByTestId('journey-overview')).toBeVisible();
      await expect(page.getByTestId(targetId)).toBeVisible();
      await expect(page.locator('[data-testid^="next-action-"]')).toHaveCount(1);
      await expect(page.getByTestId('next-actions-overflow')).toHaveCount(0);
      await openFromCandidate();
      await expect(page.getByTestId('interview-reflection-overall')).toHaveValue(draftText);
      await expect(page.getByTestId('interview-reflection-completed')).not.toBeChecked();
      await expect(page.getByTestId('interview-reflection-draft-badge')).toBeVisible();
      return { candidates, persisted: await detail() };
    });
    await observed('05-ui-explicit-completion', async () => {
      await page.getByTestId('interview-reflection-completed').check();
      await page.getByTestId('interview-reflection-save').click();
      await expect(page.getByTestId('interview-reflection-dialog')).toBeHidden();
      await expect.poll(async () => {
        const row = await detail();
        return { text: row.reflectionText, completed: row.reflectionCompletedAt !== null };
      }).toEqual({ text: draftText, completed: true });
      return { persisted: await detail() };
    });
    await observed('06-completed-leaves-set-and-whole-block', async () => ({ candidates: await dashboard(false), persisted: await detail() }));
    await observed('07-refresh-keeps-block-absent', async () => {
      await page.reload({ waitUntil: 'load' });
      await expect(page.getByTestId('journey-overview')).toBeVisible();
      await expect(page.getByTestId(targetId)).toHaveCount(0);
      await expect(page.locator('[data-testid^="next-action-"]')).toHaveCount(0);
      await expect(page.getByTestId('next-actions')).toHaveCount(0);
      const persisted = await detail();
      assert.equal(persisted.reflectionText, draftText);
      assert(persisted.reflectionCompletedAt);
      return { persisted, nextActionsBlockCount: await page.getByTestId('next-actions').count() };
    });
    return { evidence, host: 'Windows Electron', mode: 'fresh-native/full', lifecycle: 'Caller owns graceful quit and reopen; NOT_RUN by this module' };
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argumentsFor(process.argv.slice(2), ['validate']);
    if (args.help) console.log('Usage: node scripts/p2-closure-ready/ui-r6.mjs validate --run <owned-run>. Execution: import runR6(instance, {runRoot}) into the authorized existing desktop harness. No launch CLI is provided.');
    else {
      localDependencies();
      const manifest = loadManifest(args.run);
      assert(manifest.ids.r6Step && manifest.r6Label && manifest.ids.primaryUser);
      console.log(JSON.stringify({ mode: 'validate', definition: 'R6 draft/save/complete/refresh', manifest: path.join(manifest.run, 'manifest.json'), desktop: 'NOT_RUN', launches: 0 }));
    }
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}
