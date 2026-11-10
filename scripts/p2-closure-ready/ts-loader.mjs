import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const ts = createRequire(import.meta.url)("typescript");

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && /\.(?:ts|tsx|mts)$/.test(url) && !url.includes("/node_modules/")) {
    const source = await readFile(new URL(url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, verbatimModuleSyntax: false }, fileName: new URL(url).pathname });
    return { format: "module", source: compiled.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..", "src");

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
        if (!(await import("node:fs/promises").then((fs) => fs.stat(candidate))).isFile()) continue;
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
    !/\.(?:ts|tsx|mts|js|mjs|cjs|json|node)$/.test(specifier)
  ) {
    const parent = new URL(context.parentURL);
    const resolved = path.resolve(path.dirname(parent.pathname.replace(/^\/([A-Za-z]:)/, "$1")), specifier);
    for (const ext of [".ts", ".tsx", ".mts", ".js"]) {
      try {
        const candidate = `${resolved}${ext}`;
        if (!(await import("node:fs/promises").then((fs) => fs.stat(candidate))).isFile()) continue;
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      } catch {
        // try next
      }
    }
  }

  return nextResolve(specifier, context);
}
