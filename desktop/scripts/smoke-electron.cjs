const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    try {
      const screenshotDirectory = path.resolve(__dirname, "..", "..", ".codex-tmp", "windows-desktop-shell-poc", "screenshots");
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      const image = await window.capturePage();
      fs.writeFileSync(path.join(screenshotDirectory, "signin.png"), image.toPNG());
    } catch (error) {
      console.error(`Desktop smoke screenshot failed: ${error.message}`);
    }
  });
});

require("../main/main.js");

const duration = Number(process.env.DESKTOP_SMOKE_DURATION_MS || 12_000);
setTimeout(() => app.quit(), duration).unref();
