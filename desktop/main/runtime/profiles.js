// Phase C RuntimeProfileManager — opaque per-connection runtime profiles.
//
// AIConnection.runtimeProfileRef stores ONLY the opaque ref ("rp_<uuid>").
// The managed directory layout under profilesRoot is an implementation
// detail of this module; absolute paths are never a database contract.
//
// Lifecycle note: login()/logout()/reauth() belong to later phases. This
// module only creates, resolves, and deletes profile directories. Deletion
// is a low-level primitive — it is never auto-bound to AIConnection removal;
// callers (pending-login cancel, confirmed-unreferenced cleanup) decide.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Keep this pattern in sync with src/lib/ai/runtime/contract.ts — both sides
// must agree on the opaque ref format without sharing an import boundary.
const RUNTIME_PROFILE_REF_PATTERN =
  /^rp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRuntimeProfileRef(value) {
  return typeof value === "string" && RUNTIME_PROFILE_REF_PATTERN.test(value);
}

class RuntimeProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeProfileError";
    this.code = code;
  }
}

class RuntimeProfileManager {
  constructor({ profilesRoot, randomUUID = crypto.randomUUID } = {}) {
    if (typeof profilesRoot !== "string" || !path.isAbsolute(profilesRoot)) {
      throw new RuntimeProfileError(
        "INVALID_ROOT",
        "profilesRoot must be an absolute path",
      );
    }
    this.profilesRoot = path.resolve(profilesRoot);
    this.randomUUID = randomUUID;
  }

  // Opaque ref generation. The ref encodes no provider, path, or account
  // information — it is just a namespaced UUID.
  newProfileRef() {
    return `rp_${this.randomUUID()}`;
  }

  // Resolve a ref to its managed directory. The ref grammar forbids every
  // path separator and drive syntax, and the resolved path is re-checked
  // against profilesRoot so traversal or absolute-path injection is dead on
  // arrival.
  resolveProfileDir(runtimeProfileRef) {
    if (!isRuntimeProfileRef(runtimeProfileRef)) {
      throw new RuntimeProfileError(
        "INVALID_REF",
        `Invalid runtime profile ref: ${JSON.stringify(runtimeProfileRef)}`,
      );
    }
    const resolved = path.resolve(this.profilesRoot, runtimeProfileRef);
    const rootWithSep = this.profilesRoot.endsWith(path.sep)
      ? this.profilesRoot
      : this.profilesRoot + path.sep;
    if (!resolved.startsWith(rootWithSep)) {
      throw new RuntimeProfileError(
        "PATH_ESCAPE",
        "Resolved profile path escapes the managed root",
      );
    }
    return resolved;
  }

  profileExists(runtimeProfileRef) {
    const dir = this.resolveProfileDir(runtimeProfileRef);
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }

  // Creates (idempotently) the managed directory for a fresh ref and returns
  // { runtimeProfileRef, profileDir }. profileDir is for process env use only
  // — persist the ref, never the path.
  createProfile() {
    const runtimeProfileRef = this.newProfileRef();
    const profileDir = this.resolveProfileDir(runtimeProfileRef);
    fs.mkdirSync(profileDir, { recursive: true });
    return { runtimeProfileRef, profileDir };
  }

  ensureProfile(runtimeProfileRef) {
    const profileDir = this.resolveProfileDir(runtimeProfileRef);
    fs.mkdirSync(profileDir, { recursive: true });
    return profileDir;
  }

  // Deletes only directories that resolve inside the managed root. Anything
  // else — absolute paths, traversal, foreign refs — is refused.
  deleteProfile(runtimeProfileRef) {
    const profileDir = this.resolveProfileDir(runtimeProfileRef);
    if (!fs.existsSync(profileDir)) return false;
    fs.rmSync(profileDir, { recursive: true, force: true });
    return true;
  }
}

module.exports = {
  RUNTIME_PROFILE_REF_PATTERN,
  RuntimeProfileError,
  RuntimeProfileManager,
  isRuntimeProfileRef,
};
