import fs from "node:fs";
import path from "node:path";
import { resolveExtensionsTab } from "@/app/dashboard/extensions/extensionsTab";

describe("extensions tab resolver", () => {
  it("resolves deep links and falls back to connections", () => {
    expect(resolveExtensionsTab("skills")).toBe("skills");
    expect(resolveExtensionsTab(["companion", "skills"])).toBe("companion");
    expect(resolveExtensionsTab("bogus")).toBe("connections");
    expect(resolveExtensionsTab(undefined)).toBe("connections");
  });

  it("is callable from the server page: not in a \"use client\" module", () => {
    // The server page calling a client-module export crashed the whole page
    // in Electron (1.2.3-rc pre-acceptance); jsdom tests do not catch that.
    const dir = path.join(process.cwd(), "src/app/dashboard/extensions");
    expect(fs.readFileSync(path.join(dir, "extensionsTab.ts"), "utf8")).not.toMatch(/^\s*["']use client["']/);
    expect(fs.readFileSync(path.join(dir, "page.tsx"), "utf8")).toMatch(/import \{ resolveExtensionsTab \} from "\.\/extensionsTab"/);
  });
});
