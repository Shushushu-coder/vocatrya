// Frozen Windows desktop installer identity and Node runtime pin.
// productName / appId must stay stable after first public distribution.
// package.json.version is the only application version source.
"use strict";

const DESKTOP_APP_ID = "com.vocatrya.desktop";
const PRODUCT_NAME = "Vocatrya";
const EXECUTABLE_NAME = "Vocatrya";
const SHORTCUT_NAME = "Vocatrya";
const PUBLISHER = "Vocatrya contributors";
const COPYRIGHT = "Copyright (c) 2026 Vocatrya contributors";
const TARGET_ARCH = "x64";
const INSTALLER_TARGET = "nsis";

// Official Node.js Windows x64 archive (build-time only; app startup never downloads).
// Source: https://nodejs.org/dist/v20.20.2/ plus the v20.20.2 release SHASUMS.
const NODE_VERSION = "v20.20.2";
const NODE_ARCHIVE_NAME = "node-v20.20.2-win-x64.zip";
const NODE_ARCHIVE_URL = "https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip";
const NODE_ARCHIVE_SHA256 = "dc3700fdd57a63eedb8fd7e3c7baaa32e6a740a1b904167ff4204bc68ed8bf77";
const NODE_EXE_SHA256 = "56c1520ee33b801e8bdb92fb321cf2e98529735b6d12bd4a2a6dec0ac0bab937";
const NODE_ARCHIVE_ENTRY = "node-v20.20.2-win-x64/node.exe";
const NODE_LICENSE_ENTRY = "node-v20.20.2-win-x64/LICENSE";

const INSTALLER_ARTIFACT_PATTERN = "Vocatrya-Setup-${version}-x64.exe";

module.exports = {
  COPYRIGHT,
  DESKTOP_APP_ID,
  EXECUTABLE_NAME,
  INSTALLER_ARTIFACT_PATTERN,
  INSTALLER_TARGET,
  NODE_ARCHIVE_ENTRY,
  NODE_ARCHIVE_NAME,
  NODE_ARCHIVE_SHA256,
  NODE_ARCHIVE_URL,
  NODE_EXE_SHA256,
  NODE_LICENSE_ENTRY,
  NODE_VERSION,
  PRODUCT_NAME,
  PUBLISHER,
  SHORTCUT_NAME,
  TARGET_ARCH,
};
