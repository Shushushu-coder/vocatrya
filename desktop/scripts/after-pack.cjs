"use strict";

const fs = require("node:fs");
const path = require("node:path");

const AUTO_UPDATE_FILES = ["app-update.yml", "dev-app-update.yml", "latest.yml"];

exports.default = async function afterPack(context) {
  const resourcesDir = path.join(context.appOutDir, "resources");
  for (const name of AUTO_UPDATE_FILES) {
    const filePath = path.join(resourcesDir, name);
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  }
};
