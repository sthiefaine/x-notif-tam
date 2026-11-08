const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isBuiltin } = require("node:module");
const ts = require("typescript");

// Execute only the selected module, with explicit mocks for every dependency
// outside Node's built-ins. Tests cannot accidentally reach Prisma or X.
function loadTypeScript(relativePath, { mocks = {}, globals = {}, env = {} } = {}) {
  const filename = path.resolve(__dirname, "../..", relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const module = { exports: {} };
  const mockedRequire = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (isBuiltin(name)) return require(name);
    throw new Error(`Missing test mock for ${name}`);
  };
  const context = {
    module,
    exports: module.exports,
    require: mockedRequire,
    __dirname: path.dirname(filename),
    __filename: filename,
    process: { env, cwd: () => path.resolve(__dirname, "../..") },
    Buffer,
    Date,
    Error,
    AbortSignal,
    Response,
    URL,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    ...globals,
  };
  vm.runInNewContext(outputText, context, { filename });
  return module.exports;
}

module.exports = { loadTypeScript };
