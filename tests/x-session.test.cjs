const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const SECRET = "test-only-transfer-secret";
const MAX_BODY_BYTES = 128 * 1024;
const cookie = (overrides = {}) => ({
  name: "auth_token", value: "fake-x-session-only", domain: ".x.com", path: "/",
  expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true,
  sameSite: "None", ...overrides,
});
const session = () => ({
  cookies: [cookie(), cookie({ name: "ct0", domain: "api.x.com", value: "fake-x-setting" })],
  origins: [{ origin: "https://x.com", localStorage: [{ name: "setting", value: "fake-x-value" }] }],
});

function loadRoute(env = {}, browser = {}) {
  const calls = { created: 0, closed: 0, normalized: 0 };
  const route = loadTypeScript("app/api/x-session/route.ts", {
    env: { CRON_SECRET: SECRET, X_ACCOUNT_HANDLE: "@TestBot", ...env },
    mocks: {
      "@/app/api/post_tweets/browserClient": {
        createBrowserPublisher: async () => {
          calls.created++;
          if (browser.fail) throw new Error("fake-private-browser-error");
          return {
            postText: async () => assert.fail("session endpoints must never publish"),
            close: async () => { calls.closed++; if (browser.closeFails) throw new Error("fake-close-error"); },
          };
        },
        normalizeBrowserFailure: () => {
          calls.normalized++;
          return { success: false, error: {
            status: 401, code: "SESSION_REQUIRED", detail: "La session X doit être renouvelée manuellement.",
          } };
        },
      },
    },
  });
  return { route, calls };
}

function request(body, { method = "POST", headers = {}, ...options } = {}) {
  return new Request("https://example.test/api/x-session", {
    method,
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body: typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body) } : {}),
    ...options,
  });
}

async function withDirectory(callback) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "x-session-test-"));
  const directory = await fs.realpath(temporary);
  try { await callback(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("GET and POST require a configured cron secret and the exact bearer", async () => {
  for (const method of ["GET", "POST"]) {
    const missing = loadRoute({ CRON_SECRET: "" });
    assert.equal((await missing.route[method](request(session(), { method }))).status, 503);
    assert.equal(missing.calls.created, 0);
    const configured = loadRoute();
    for (const authorization of ["", "Bearer incorrect", `Bearer ${SECRET}suffix`]) {
      assert.equal((await configured.route[method](request(session(), { method, headers: { authorization } }))).status, 401);
    }
    assert.equal(configured.calls.created, 0);
  }
});

test("POST needs an admin-configured destination and JSON content type", async () => {
  const missing = loadRoute();
  assert.equal((await missing.route.POST(request(session()))).status, 503);
  const configured = loadRoute({ X_BROWSER_SESSION_PATH: "/unused/session.json" });
  const response = await configured.route.POST(request(session(), { headers: { "content-type": "text/plain" } }));
  assert.equal(response.status, 415);
  assert.equal(configured.calls.created, 0);
});

test("POST writes only the configured path atomically with private permissions and no secret response", async () => {
  await withDirectory(async (directory) => {
    const filename = path.join(directory, ".x-browser/session.json");
    const { route, calls } = loadRoute({ X_BROWSER_SESSION_PATH: filename });
    const state = session();
    state.path = path.join(directory, "untrusted-destination.json");
    const response = await route.POST(request(state));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { success: true, cookieCount: 2 });
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), { cookies: state.cookies, origins: state.origins });
    await assert.rejects(fs.stat(state.path), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(path.dirname(filename)), ["session.json"]);
    assert.equal(calls.created, 0);
    await fs.chmod(filename, 0o644);
    assert.equal((await route.POST(request(session()))).status, 200);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  });
});

test("POST refuses unrelated cookies, origins, lookalikes and malformed cookie attributes", async () => {
  const invalid = [
    { ...session(), cookies: [cookie({ domain: ".google.com" })] },
    { ...session(), cookies: [cookie({ domain: "x.com.example.test" })] },
    { ...session(), cookies: [cookie({ domain: "notx.com" })] },
    { ...session(), cookies: [cookie({ sameSite: ["Lax"] })] },
    { ...session(), cookies: [cookie({ secure: "true" })] },
    { ...session(), cookies: [cookie({ path: "relative" })] },
    { ...session(), cookies: [cookie({ partitionKey: "https://mail.google.com" })] },
    ...["https://mail.google.com", "https://example.test", "http://x.com", "https://x.com.example.test", "https://x.com/path"].map((origin) => ({
      ...session(), origins: [{ origin, localStorage: [] }],
    })),
  ];
  const { route, calls } = loadRoute({ X_BROWSER_SESSION_PATH: "/unused/session.json" });
  for (const state of invalid) {
    const response = await route.POST(request(state));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_SESSION");
  }
  assert.equal(calls.created, 0);
});

test("POST requires a nonempty, nonexpired X auth_token but accepts a session cookie", async () => {
  const { route } = loadRoute({ X_BROWSER_SESSION_PATH: "/unused/session.json" });
  for (const overrides of [{ value: " " }, { expires: Math.floor(Date.now() / 1000) - 1 }, { name: "other_cookie" }, { expires: 0 }]) {
    assert.equal((await route.POST(request({ cookies: [cookie(overrides)], origins: [] }))).status, 400);
  }
  await withDirectory(async (directory) => {
    const ready = loadRoute({ X_BROWSER_SESSION_PATH: path.join(directory, "session.json") });
    assert.equal((await ready.route.POST(request({ cookies: [cookie({ expires: -1 })], origins: [] }))).status, 200);
  });
});

test("POST rejects malformed JSON without reflecting body values", async () => {
  const { route } = loadRoute({ X_BROWSER_SESSION_PATH: "/unused/session.json" });
  const response = await route.POST(request('{"fake-private-cookie":'));
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes("fake-private-cookie"));
});

test("POST rejects an oversized content length before reading the body", async () => {
  const { route } = loadRoute({ X_BROWSER_SESSION_PATH: "/unused/session.json" });
  const response = await route.POST({
    headers: new Headers({ authorization: `Bearer ${SECRET}`, "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) }),
    body: { getReader: () => assert.fail("an oversized body must not be read") },
  });
  assert.equal(response.status, 413);
});

test("POST bounds and cancels a streamed body even without content length", async () => {
  const { route } = loadRoute({ X_BROWSER_SESSION_PATH: "/unused/session.json" });
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(70 * 1024)); },
    cancel() { cancelled = true; },
  });
  const response = await route.POST(request(stream, { duplex: "half" }));
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
});

test("POST refuses symlink directories and files without changing their targets", async () => {
  await withDirectory(async (directory) => {
    const destination = path.join(directory, "outside.json");
    await fs.writeFile(destination, "test-only sentinel");
    const symlink = path.join(directory, "session.json");
    await fs.symlink(destination, symlink);
    const fileRoute = loadRoute({ X_BROWSER_SESSION_PATH: symlink });
    const response = await fileRoute.route.POST(request(session()));
    assert.equal(response.status, 503);
    assert.equal(await fs.readFile(destination, "utf8"), "test-only sentinel");
    assert.ok(!(await response.text()).includes(directory));
    const targetDirectory = path.join(directory, "real-directory");
    await fs.mkdir(targetDirectory);
    const alias = path.join(directory, "alias");
    await fs.symlink(targetDirectory, alias);
    const directoryRoute = loadRoute({ X_BROWSER_SESSION_PATH: path.join(alias, "session.json") });
    assert.equal((await directoryRoute.route.POST(request(session()))).status, 503);
    assert.deepEqual(await fs.readdir(targetDirectory), []);
  });
});

test("GET verifies the expected account and closes without publishing or returning session data", async () => {
  const { route, calls } = loadRoute();
  const response = await route.GET(request(undefined, { method: "GET" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, ready: true, handle: "TestBot" });
  assert.equal(calls.created, 1);
  assert.equal(calls.closed, 1);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("GET returns only normalized browser failure fields", async () => {
  const { route, calls } = loadRoute({}, { fail: true });
  const response = await route.GET(request(undefined, { method: "GET" }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    success: false, ready: false, status: 401, code: "SESSION_REQUIRED",
    detail: "La session X doit être renouvelée manuellement.",
  });
  assert.equal(calls.normalized, 1);
});

test("GET refuses an unconfigured account and tolerates cleanup failures safely", async () => {
  const missing = loadRoute({ X_ACCOUNT_HANDLE: "" });
  assert.equal((await missing.route.GET(request(undefined, { method: "GET" }))).status, 503);
  assert.equal(missing.calls.created, 0);
  const ready = loadRoute({}, { closeFails: true });
  assert.equal((await ready.route.GET(request(undefined, { method: "GET" }))).status, 200);
  assert.equal(ready.calls.closed, 1);
});
