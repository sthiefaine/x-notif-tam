const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  normalizeHandle, findChromeExecutable, isRestrictedUrl, runLogin, saveSessionFile, scopeSessionToX,
  prepareLoginProfile, launchManualChrome, waitForBrowserExit, waitForProfileUnlock,
  hasProfileLock,
} = require("../scripts/x-browser-login.cjs");

function browserFixture({ href = "/TestBot", challenge = false, url = "https://x.com/home", cookies, origins = [], semanticOnly = false } = {}) {
  const calls = { spawns: [], contexts: [], navigations: [], saved: [], output: [], signals: [], events: [], prompts: 0, closed: 0, snapshots: 0 };
  const profile = { first: () => profile, waitFor: async () => {}, getAttribute: async () => href };
  const legacyProfile = {
    first: () => legacyProfile,
    or: (other) => semanticOnly ? other : profile,
    waitFor: async () => { if (semanticOnly) throw new Error("Missing testid"); },
    getAttribute: async () => href,
  };
  const page = {
    goto: async (target) => calls.navigations.push(target),
    url: () => url,
    locator: (selector) => selector.startsWith("iframe")
      ? { count: async () => challenge ? 1 : 0 }
      : legacyProfile,
    getByRole: (role, { name }) => {
      assert.equal(role, "link");
      assert.equal(name.test("Profile"), true);
      assert.equal(name.test("Profil"), true);
      assert.equal(name.test("A profile in the feed"), false);
      return profile;
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => assert.fail("the dedicated persistent page should be reused"),
    storageState: async () => {
      calls.snapshots++;
      return { cookies: cookies || [{ name: "auth_token", value: "test-only-cookie", domain: ".x.com" }], origins };
    },
    close: async () => calls.closed++,
  };
  const child = new EventEmitter();
  child.kill = (signal) => {
    calls.signals.push(signal);
    queueMicrotask(() => { calls.events.push("exit"); child.emit("exit", null, signal); });
    return true;
  };
  const options = {
    env: { X_ACCOUNT_HANDLE: "@TestBot" },
    chromium: {
      launchPersistentContext: async (...args) => {
        calls.events.push("attach");
        calls.contexts.push(args);
        return context;
      },
    },
    spawn: (...args) => {
      calls.events.push("spawn");
      calls.spawns.push(args);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    prepareProfile: async (root) => path.join(root, ".x-browser/login-profile"),
    waitForUnlock: async () => { calls.events.push("unlock"); },
    prompt: async () => { calls.prompts++; calls.events.push("confirm"); },
    output: (message) => calls.output.push(message),
    saveSession: async (...args) => calls.saved.push(args),
    findExecutable: (env) => env.CHROMIUM_EXECUTABLE_PATH || env.PUPPETEER_EXECUTABLE_PATH || "/test/chrome",
    projectDirectory: "/test-project",
  };
  return { calls, options, child };
}

async function temporaryDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "x-login-test-"));
  try { await callback(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("requires an exact valid account handle before opening Chrome", async () => {
  assert.equal(normalizeHandle(" @TestBot "), "testbot");
  for (const handle of ["", "a/b", "https://x.com/bot", "name with space", "1234567890123456"]) {
    const { options, calls } = browserFixture();
    options.env.X_ACCOUNT_HANDLE = handle;
    await assert.rejects(runLogin(options), /X_ACCOUNT_HANDLE/);
    assert.equal(calls.spawns.length, 0);
    assert.equal(calls.contexts.length, 0);
  }
});

test("launches ordinary Chrome with only the dedicated profile, first-run flag and X URL", async () => {
  const { calls, options } = browserFixture();
  const result = await runLogin(options);
  assert.deepEqual(calls.spawns, [["/test/chrome", [
    "--user-data-dir=/test-project/.x-browser/login-profile", "--no-first-run", "https://x.com/home",
  ], { stdio: "ignore" }]]);
  assert.deepEqual(calls.signals, ["SIGTERM"]);
  assert.deepEqual(calls.contexts, [["/test-project/.x-browser/login-profile", {
    headless: false, executablePath: "/test/chrome", timeout: 30_000,
    ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  }]]);
  assert.deepEqual(calls.events, ["spawn", "confirm", "exit", "unlock", "attach"]);
  assert.deepEqual(calls.navigations, ["https://x.com/home"]);
  assert.equal(calls.saved.length, 1);
  assert.equal(result.filename, "/test-project/.x-browser/session.json");
  assert.equal(calls.closed, 1);
  assert.ok(!calls.output.join(" ").includes("test-only-cookie"));
});

test("verifies the exact semantic Profile link when legacy test IDs are absent", async () => {
  const valid = browserFixture({ semanticOnly: true });
  await runLogin(valid.options);
  assert.equal(valid.calls.saved.length, 1);
  const wrong = browserFixture({ semanticOnly: true, href: "/different_account" });
  await assert.rejects(runLogin(wrong.options), /ne correspond pas/);
  assert.equal(wrong.calls.saved.length, 0);
});

test("does not attach Playwright before confirmation, process exit and profile unlock", async () => {
  const { calls, options } = browserFixture();
  let confirm;
  let unlock;
  options.prompt = () => new Promise((resolve) => { confirm = resolve; });
  options.waitForUnlock = () => new Promise((resolve) => { unlock = resolve; });
  const running = runLogin(options);
  await new Promise(setImmediate);
  assert.equal(calls.contexts.length, 0);
  assert.equal(calls.signals.length, 0);
  confirm();
  await new Promise(setImmediate);
  assert.deepEqual(calls.signals, ["SIGTERM"]);
  assert.ok(calls.events.includes("exit"));
  assert.equal(calls.contexts.length, 0);
  unlock();
  await running;
  assert.equal(calls.contexts.length, 1);
});

test("accepts configured executable and destination, with only a fixed project browser profile", async () => {
  const { options, calls } = browserFixture();
  options.env.CHROMIUM_EXECUTABLE_PATH = "/custom/chrome";
  options.env.X_BROWSER_SESSION_PATH = "/private/x/session.json";
  options.env.X_BROWSER_PROFILE_PATH = "/personal/profile";
  await runLogin(options);
  assert.equal(calls.spawns[0][0], "/custom/chrome");
  assert.equal(calls.contexts[0][0], "/test-project/.x-browser/login-profile");
  assert.equal(calls.saved[0][0], "/private/x/session.json");
});

test("reuses the legacy account handle and executable during migration", async () => {
  const { options, calls } = browserFixture();
  delete options.env.X_ACCOUNT_HANDLE;
  options.env.USER_HANDLE = "@TestBot";
  options.env.PUPPETEER_EXECUTABLE_PATH = "/legacy/chrome";
  await runLogin(options);
  assert.equal(calls.spawns[0][0], "/legacy/chrome");
  assert.equal(calls.prompts, 1);
});

test("detects installed Chrome and falls back from a removed legacy binary", () => {
  assert.equal(findChromeExecutable({ PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium-browser" }, (candidate) => candidate === "/usr/bin/chromium"), "/usr/bin/chromium");
  assert.equal(findChromeExecutable({ CHROMIUM_EXECUTABLE_PATH: "/custom/chrome" }, (candidate) => candidate === "/custom/chrome"), "/custom/chrome");
  assert.equal(findChromeExecutable({}, () => false), undefined);
});

test("missing Chrome, spawn failure and early crash fail cleanly without attaching Playwright", async () => {
  const missing = browserFixture();
  missing.options.findExecutable = () => undefined;
  await assert.rejects(runLogin(missing.options), /introuvable/);
  assert.equal(missing.calls.spawns.length, 0);
  for (const event of ["error", "exit"]) {
    const child = new EventEmitter();
    await assert.rejects(launchManualChrome("/fake/chrome", "/test-profile", {
      spawn: () => {
        queueMicrotask(() => event === "error" ? child.emit("error", new Error("fake")) : child.emit("exit", 1, null));
        return child;
      },
    }), /Impossible|avant son démarrage/);
  }
  const crash = browserFixture();
  let aborted = false;
  crash.options.prompt = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("fake prompt aborted")); });
  });
  const running = runLogin(crash.options);
  await new Promise(setImmediate);
  crash.child.emit("exit", 1, null);
  await assert.rejects(running, /arrêté avec une erreur/);
  assert.equal(crash.calls.contexts.length, 0);
  assert.equal(crash.calls.saved.length, 0);
  assert.equal(aborted, true);
  // The completion listener remains safe even for a late process error.
  crash.child.emit("error", new Error("late fake process error"));
});

test("only signals its own live child and stops after a bounded graceful-close wait", async () => {
  const fixture = browserFixture();
  const manual = await launchManualChrome("/fake/chrome", "/dedicated-profile", { spawn: fixture.options.spawn });
  fixture.child.kill = (signal) => { fixture.calls.signals.push(signal); return true; };
  await assert.rejects(waitForBrowserExit(manual, { timeoutMs: 5 }), /pas fermé à temps/);
  assert.deepEqual(fixture.calls.signals, ["SIGTERM"]);
  fixture.child.emit("exit", 0, null);
  await waitForBrowserExit(manual, { timeoutMs: 5 });
  assert.deepEqual(fixture.calls.signals, ["SIGTERM"]);
});

test("an already closed dedicated browser is never signalled again", async () => {
  const { options, calls, child } = browserFixture();
  options.prompt = async () => { child.emit("exit", 0, null); };
  await runLogin(options);
  assert.deepEqual(calls.signals, []);
  assert.equal(calls.contexts.length, 1);
});

test("normal manual exit still waits for the user's terminal confirmation", async () => {
  const { options, calls, child } = browserFixture();
  let confirm;
  options.prompt = () => new Promise((resolve) => { confirm = resolve; });
  const running = runLogin(options);
  await new Promise(setImmediate);
  child.emit("exit", 0, null);
  await new Promise(setImmediate);
  assert.equal(calls.contexts.length, 0);
  assert.equal(calls.saved.length, 0);
  confirm();
  await running;
  assert.deepEqual(calls.signals, []);
  assert.equal(calls.contexts.length, 1);
});

test("a persistent lock prevents Playwright attachment and is not removed", async () => {
  await temporaryDirectory(async (directory) => {
    const profile = await prepareLoginProfile(directory);
    const lock = path.join(profile, "SingletonLock");
    await fs.symlink("fake-host-123", lock);
    await assert.rejects(prepareLoginProfile(directory), /verrouillé/);
    await assert.rejects(waitForProfileUnlock(profile, { timeoutMs: 0 }), /reste verrouillé/);
    assert.equal((await fs.lstat(lock)).isSymbolicLink(), true);
    const { options, calls } = browserFixture();
    options.waitForUnlock = () => waitForProfileUnlock(profile, { timeoutMs: 0 });
    await assert.rejects(runLogin(options), /reste verrouillé/);
    assert.equal(calls.contexts.length, 0);
  });
});

test("accepts a stale same-host Chrome lock only after a signal-0 ESRCH probe, without removing it", async () => {
  await temporaryDirectory(async (directory) => {
    const profile = await prepareLoginProfile(directory);
    const filename = path.join(profile, "SingletonLock");
    const target = "test-machine-12345";
    await fs.symlink(target, filename);
    const probes = [];
    const options = {
      hostname: "test-machine",
      probe: (pid, signal) => {
        probes.push([pid, signal]);
        throw Object.assign(new Error("fake absent owner"), { code: "ESRCH" });
      },
    };
    assert.equal(await hasProfileLock(profile, options), false);
    assert.equal(await prepareLoginProfile(directory, options), profile);
    await waitForProfileUnlock(profile, { timeoutMs: 0, ...options });
    assert.deepEqual(probes, [[12345, 0], [12345, 0], [12345, 0]]);
    assert.equal(await fs.readlink(filename), target);
  });
});

test("keeps live, inaccessible and unknown lock owners active", async () => {
  await temporaryDirectory(async (directory) => {
    const profile = await prepareLoginProfile(directory);
    const filename = path.join(profile, "SingletonLock");
    await fs.symlink("test-machine-12345", filename);
    let probes = 0;
    for (const code of [undefined, "EPERM", "EACCES", "EINVAL"]) {
      const options = {
        hostname: "test-machine",
        probe: (pid, signal) => {
          probes++;
          assert.equal(pid, 12345);
          assert.equal(signal, 0);
          if (code) throw Object.assign(new Error("fake owner status"), { code });
          return true;
        },
      };
      assert.equal(await hasProfileLock(profile, options), true);
      await assert.rejects(prepareLoginProfile(directory, options), /verrouillé/);
    }
    assert.equal(probes, 8);
    assert.equal(await fs.readlink(filename), "test-machine-12345");
  });
});

test("never probes foreign-host, malformed or non-symlink Chrome locks", async () => {
  await temporaryDirectory(async (directory) => {
    const profile = await prepareLoginProfile(directory);
    const filename = path.join(profile, "SingletonLock");
    const options = { hostname: "test-machine", probe: () => assert.fail("untrusted lock owner must not be probed") };
    for (const target of ["other-machine-12345", "missing-pid", "test-machine-0", "test-machine--5", "test-machine-9999999999999999999999"]) {
      await fs.symlink(target, filename);
      assert.equal(await hasProfileLock(profile, options), true);
      assert.equal(await fs.readlink(filename), target);
      await fs.unlink(filename);
    }
    await fs.writeFile(filename, "test-only lock metadata");
    assert.equal(await hasProfileLock(profile, options), true);
    assert.equal(await fs.readFile(filename, "utf8"), "test-only lock metadata");
  });
});

test("the dedicated profile and its parent are private real directories, never symlinks", async () => {
  await temporaryDirectory(async (directory) => {
    const profile = await prepareLoginProfile(directory);
    assert.equal(profile, path.join(await fs.realpath(directory), ".x-browser/login-profile"));
    assert.equal((await fs.stat(profile)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.dirname(profile))).mode & 0o777, 0o700);
    await fs.rm(profile, { recursive: true });
    await fs.mkdir(path.join(directory, "personal"));
    await fs.symlink(path.join(directory, "personal"), profile);
    await assert.rejects(prepareLoginProfile(directory), /sans lien symbolique/);
    await fs.rm(path.dirname(profile), { recursive: true });
    await fs.symlink(path.join(directory, "personal"), path.dirname(profile));
    await assert.rejects(prepareLoginProfile(directory), /sans lien symbolique/);
  });
});

test("never saves a session for the wrong account or a spoofed profile URL", async () => {
  for (const href of ["/SomeoneElse", "https://evil.example/TestBot", "/TestBot/extra"]) {
    const { options, calls } = browserFixture({ href });
    await assert.rejects(runLogin(options), /ne correspond pas/);
    assert.equal(calls.saved.length, 0);
    assert.equal(calls.snapshots, 0);
    assert.equal(calls.closed, 1);
  }
});

test("stops on login, onboarding or verification screens without saving", async () => {
  for (const url of ["https://x.com/i/flow/login", "https://x.com/i/jf/onboarding/web?mode=login", "https://x.com/account/access", "https://x.com/account/suspended"]) {
    assert.equal(isRestrictedUrl(url), true);
    const { options, calls } = browserFixture({ url });
    await assert.rejects(runLogin(options), /en attente/);
    assert.equal(calls.saved.length, 0);
    assert.equal(calls.closed, 1);
  }
  const { options, calls } = browserFixture({ challenge: true });
  await assert.rejects(runLogin(options), /vérification/);
  assert.equal(calls.saved.length, 0);
});

test("preserves the dedicated profile when X requires another login", async () => {
  await temporaryDirectory(async (directory) => {
    const profile = await prepareLoginProfile(directory);
    const sentinel = path.join(profile, "test-profile-sentinel");
    await fs.writeFile(sentinel, "test-only-profile-data");
    const { options, calls } = browserFixture({ url: "https://x.com/i/jf/onboarding/web?mode=login" });
    options.projectDirectory = directory;
    options.prepareProfile = prepareLoginProfile;
    options.waitForUnlock = waitForProfileUnlock;
    await assert.rejects(runLogin(options), /en attente/);
    assert.equal(await fs.readFile(sentinel, "utf8"), "test-only-profile-data");
    assert.equal(calls.snapshots, 0);
    assert.equal(calls.saved.length, 0);
    assert.equal(calls.closed, 1);
  });
});

test("does not save an incomplete session", async () => {
  const { options, calls } = browserFixture({ cookies: [] });
  await assert.rejects(runLogin(options), /incomplète/);
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.closed, 1);
});

test("exports only X cookies and HTTPS X origins, excluding email and unrelated sites", async () => {
  const cookies = [
    { name: "auth_token", value: "fake-x-session", domain: ".x.com" },
    { name: "x_pref", value: "fake-x-preference", domain: "api.x.com" },
    { name: "mail_session", value: "fake-email-session", domain: ".google.com" },
    { name: "gmail_session", value: "fake-gmail-session", domain: "mail.google.com" },
    { name: "other_session", value: "fake-other-session", domain: "example.test" },
    { name: "lookalike", value: "fake-lookalike", domain: "x.com.example.test" },
    { name: "prefix", value: "fake-prefix", domain: "notx.com" },
  ];
  const origins = [
    { origin: "https://x.com", localStorage: [{ name: "x-setting", value: "fake-x-value" }] },
    { origin: "https://api.x.com", localStorage: [] },
    { origin: "https://mail.google.com", localStorage: [{ name: "mail-setting", value: "fake-mail-value" }] },
    { origin: "https://example.test", localStorage: [] },
    { origin: "http://x.com", localStorage: [] },
    { origin: "https://x.com.example.test", localStorage: [] },
    { origin: "not a URL", localStorage: [] },
  ];
  const filtered = scopeSessionToX({ cookies, origins });
  assert.deepEqual(filtered.cookies.map((cookie) => cookie.name), ["auth_token", "x_pref"]);
  assert.deepEqual(filtered.origins.map((entry) => entry.origin), ["https://x.com", "https://api.x.com"]);
  const { options, calls } = browserFixture({ cookies, origins });
  await runLogin(options);
  assert.deepEqual(calls.saved[0][1], filtered);
  assert.equal(cookies.length, 7);
  assert.equal(origins.length, 7);
});

test("an auth_token from an email provider cannot authenticate the filtered X session", async () => {
  const { options, calls } = browserFixture({
    cookies: [{ name: "auth_token", value: "fake-email-token", domain: "mail.google.com" }],
    origins: [{ origin: "https://mail.google.com", localStorage: [] }],
  });
  await assert.rejects(runLogin(options), /incomplète/);
  assert.equal(calls.saved.length, 0);
  assert.equal(calls.closed, 1);
});

test("writes a private session file and preserves mode 0600 on replacement", async () => {
  await temporaryDirectory(async (directory) => {
    const filename = path.join(directory, ".x-browser/session.json");
    const state = { cookies: [{ name: "auth_token", value: "fake-session" }], origins: [] };
    await saveSessionFile(filename, state);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(filename))).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), state);
    await fs.chmod(filename, 0o644);
    await saveSessionFile(filename, state);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(path.dirname(filename)), ["session.json"]);
  });
});
