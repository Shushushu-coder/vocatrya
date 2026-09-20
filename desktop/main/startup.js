// Vocatrya desktop startup sequencing.
//
// Guarantees the database phase runs exactly ONCE per launch and fully
// completes before any backend spawn is attempted. Backend port/readiness
// retries live entirely inside startBackend, so a retry can never trigger a
// second backup or migration.
"use strict";

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

module.exports = { runStartupSequence };
