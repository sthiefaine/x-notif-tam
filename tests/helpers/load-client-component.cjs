const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

// Server-render client components without a browser, database, or network.
function loadClientComponent(relativePath) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } });
    vm.runInNewContext(outputText, { module, exports: module.exports, Date, Map, Set, Intl, require(name) {
      if (name === "react" || name === "react/jsx-runtime" || name === "next/link") return require(name);
      if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name.startsWith(".") || name.startsWith("@/")) {
        const base = name.startsWith("@/") ? path.resolve(__dirname, "../..", name.slice(2)) : path.resolve(path.dirname(filename), name);
        const target = [base + ".tsx", base + ".ts"].find((candidate) => fs.existsSync(candidate));
        if (target) return load(target);
      }
      throw new Error(`Unexpected client dependency ${name}`);
    } }, { filename });
    return module.exports;
  }
  return load(path.resolve(__dirname, "../..", relativePath));
}
module.exports = { loadClientComponent };
