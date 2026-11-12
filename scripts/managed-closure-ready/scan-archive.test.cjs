const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { scanArchive } = require('./scan-archive.cjs');

test('detects secrets in compressed data and attachment entries', async () => {
  const secret = 'synthetic-session-token-123456789';
  for (const entry of ['data.json', 'attachments/blob.bin']) {
    const zip = new JSZip();
    zip.file(entry, Buffer.from(secret));
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    assert.equal(bytes.includes(Buffer.from(secret)), false);
    await assert.rejects(scanArchive(bytes, { tokens: [secret] }), /backup entry contains tokens/);
  }
});

test('accepts a clean archive while scanning every file', async () => {
  const zip = new JSZip();
  zip.file('data.json', '{}'); zip.file('attachments/one.txt', 'safe');
  const result = await scanArchive(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), { tokens: ['synthetic-secret-123456'] });
  assert.equal(result.scannedEntries, 2);
});
