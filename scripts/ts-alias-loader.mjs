import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const withoutAlias = specifier.slice(2);
    const abs = path.resolve(SRC, withoutAlias);
    const candidates = [
      abs,
      `${abs}.ts`,
      `${abs}.tsx`,
      path.join(abs, "index.ts"),
    ];
    for (const candidate of candidates) {
      try {
        await import("node:fs/promises").then((fs) => fs.access(candidate));
        const url = pathToFileURL(candidate).href;
        return { url, shortCircuit: true };
      } catch {
        // try next
      }
    }
  }

  if (
    context.parentURL &&
    specifier.startsWith(".") &&
    !path.extname(specifier)
  ) {
    const parent = new URL(context.parentURL);
    const resolved = path.resolve(path.dirname(parent.pathname.replace(/^\/([A-Za-z]:)/, "$1")), specifier);
    for (const ext of [".ts", ".tsx", ".mts", ".js"]) {
      try {
        const candidate = `${resolved}${ext}`;
        await import("node:fs/promises").then((fs) => fs.access(candidate));
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      } catch {
        // try next
      }
    }
  }

  return nextResolve(specifier, context);
}
