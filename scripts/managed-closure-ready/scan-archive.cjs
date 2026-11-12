'use strict';
const assert = require('node:assert/strict');
const JSZip = require('jszip');

// ZIP compression hides plaintext probes from scans of the archive bytes.
// Check every decompressed file, including attachments and extra entries.
exports.scanArchive = async function scanArchive(buffer, probes) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  for (const entry of entries) {
    const content = await entry.async('nodebuffer');
    for (const [label, values] of Object.entries(probes)) for (const value of values) {
      const needle = Buffer.isBuffer(value) ? value : Buffer.from(value);
      assert.ok(needle.length >= 8, `${label} probe material too short`);
      assert.equal(content.includes(needle), false, `backup entry contains ${label}`);
    }
  }
  return { zip, scannedEntries: entries.length };
};
