// Vocatrya desktop startup sequencing.
//
// Guarantees the database phase runs exactly ONCE per launch and fully
// completes before any backend spawn is attempted. Backend port/readiness
// retries live entirely inside startBackend, so a retry can never trigger a
// second backup or migration.
"use strict";

function startupPageUrl(logo) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Vocatrya</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: light-dark(#fff, #09090b); }
  header { position: fixed; inset: 0 0 auto; height: 36px; -webkit-app-region: drag; }
  img { width: 96px; height: 96px; object-fit: contain; }
</style></head><body><header></header><img src="${logo}" alt="Vocatrya"></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function runStartupSequence({ prepareDatabase, startBackend, createWindow, onFailure }) {
  if (typeof prepareDatabase !== "function") throw new Error("prepareDatabase is required");
  if (typeof startBackend !== "function") throw new Error("startBackend is required");
  if (typeof createWindow !== "function") throw new Error("createWindow is required");
  try {
    const database = await prepareDatabase();
    const backend = await startBackend();
    await createWindow({ database, backend });
    return { database, backend };
  } catch (error) {
    if (typeof onFailure === "function") {
      await onFailure(error);
    }
    throw error;
  }
}

module.exports = { runStartupSequence, startupPageUrl };
