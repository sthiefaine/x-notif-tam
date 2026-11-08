const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { runSaveSession } = require("../scripts/x-save-session.cjs");
const { LoginError, prepareLoginProfile } = require("../scripts/x-browser-login.cjs");

async function projectFixture(callback) {
  const projectDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "x-save-session-test-")));
  const profile = path.join(projectDirectory, ".x-browser", "login-profile");
  await fs.mkdir(path.join(profile, "Default"), { recursive: true, mode: 0o700 });
  try { await callback(projectDirectory, profile); }
  finally { await fs.rm(projectDirectory, { recursive: true, force: true }); }
}

function browserFixture(projectDirectory, options = {}) {
  const calls = { launch: [], goto: [], saved: [], output: [], closed: 0, snapshots: 0 };
  const profile = { first: () => profile, waitFor: async () => {}, getAttribute: async () => options.href || "/TestBot" };
  const legacyProfile = {
    or: (other) => options.semanticOnly ? other : profile,
  };
  const page = {
    url: () => options.url || "https://x.com/home",
    goto: async (...args) => {
      calls.goto.push(args);
      if (options.navigationError) throw options.navigationError;
    },
    locator: (selector) => selector.startsWith("iframe")
      ? { count: async () => options.challenge ? 1 : 0 }
      : legacyProfile,
    getByRole: (role, { name }) => {
      assert.equal(role, "link");
      assert.equal(name.test("Profile"), true);
      assert.equal(name.test("Profil"), true);
      assert.equal(name.test("An unrelated profile link"), false);
      return profile;
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => assert.fail("must reuse dedicated persistent page"),
    storageState: async () => {
      calls.snapshots++;
      return options.state || {
        cookies: [
          { name: "auth_token", value: "fake-x-session", domain: ".x.com" },
          { name: "unrelated", value: "fake-unrelated-secret", domain: ".mail.invalid" },
        ],
        origins: [
          { origin: "https://x.com", localStorage: [] },
          { origin: "https://mail.invalid", localStorage: [{ name: "private", value: "fake-unrelated-secret" }] },
        ],
      };
    },
    close: async () => {
      calls.closed++;
      if (options.closeNeverFinishes) return new Promise(() => {});
      if (options.closeError) throw options.closeError;
    },
  };
  return {
    calls,
    options: {
      projectDirectory,
      env: { X_ACCOUNT_HANDLE: "@TestBot", X_BROWSER_PROFILE_PATH: "/personal/profile" },
      findExecutable: () => "/test/chrome",
      chromium: { launchPersistentContext: async (...args) => {
        calls.launch.push(args);
        if (options.launchError) throw options.launchError;
        return context;
      } },
      saveSession: async (...args) => {
        calls.saved.push(args);
        if (options.saveError) throw options.saveError;
      },
      output: (message) => calls.output.push(message),
    },
  };
}

test("saves only X state from the already connected fixed project profile without prompting or login", async () => {
  await projectFixture(async (root, profile) => {
    const { options, calls } = browserFixture(root);
    const result = await runSaveSession(options);
    assert.deepEqual(calls.launch, [[profile, {
      executablePath: "/test/chrome", headless: false, timeout: 30_000,
    }]]);
    assert.deepEqual(calls.goto, [["https://x.com/home", {
      waitUntil: "domcontentloaded", timeout: 30_000,
    }]]);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.saved[0][0], path.join(root, ".x-browser/session.json"));
    assert.deepEqual(calls.saved[0][1].cookies.map((cookie) => cookie.domain), [".x.com"]);
    assert.deepEqual(calls.saved[0][1].origins.map((origin) => origin.origin), ["https://x.com"]);
    assert.equal(calls.closed, 1);
    assert.equal(result.handle, "testbot");
    assert.equal(calls.output.join(" ").includes("fake-x-session"), false);
    assert.equal(JSON.stringify(calls.saved).includes("fake-unrelated-secret"), false);
  });
});

test("saves an existing session using the semantic Profile link without legacy test IDs", async () => {
  await projectFixture(async (root) => {
    const { options, calls } = browserFixture(root, { semanticOnly: true });
    await runSaveSession(options);
    assert.equal(calls.saved.length, 1);
    assert.equal(calls.closed, 1);
  });
});

test("rejects an incomplete profile before creating directories or launching a browser", async () => {
  await projectFixture(async (root, profile) => {
    await fs.rm(profile, { recursive: true });
    const { options, calls } = browserFixture(root);
    await assert.rejects(runSaveSession(options), /introuvable ou incomplet/);
    assert.equal(calls.launch.length, 0);
    await assert.rejects(fs.lstat(profile), { code: "ENOENT" });
  });
});

test("refuses symlinks for Default or its profile parents", async () => {
  for (const relative of [".x-browser/login-profile/Default", ".x-browser/login-profile", ".x-browser"]) {
    await projectFixture(async (root) => {
      const target = path.join(root, "other-dedicated-profile");
      await fs.mkdir(path.join(target, "login-profile/Default"), { recursive: true });
      const source = path.join(root, relative);
      await fs.rm(source, { recursive: true });
      await fs.symlink(target, source);
      const { options, calls } = browserFixture(root);
      await assert.rejects(runSaveSession(options), /sans lien symbolique/);
      assert.equal(calls.launch.length, 0);
    });
  }
});

test("checks the dedicated profile lock and never opens a profile returned outside the project", async () => {
  await projectFixture(async (root, profile) => {
    await fs.symlink("foreign-host-12345", path.join(profile, "SingletonLock"));
    const locked = browserFixture(root);
    await assert.rejects(runSaveSession(locked.options), /verrouillé/);
    assert.equal(locked.calls.launch.length, 0);
    assert.equal(await fs.readlink(path.join(profile, "SingletonLock")), "foreign-host-12345");
    const outside = browserFixture(root);
    outside.options.prepareProfile = async () => "/personal/profile";
    await assert.rejects(runSaveSession(outside.options), /Seul le profil/);
    assert.equal(outside.calls.launch.length, 0);
  });
});

test("expired login, challenge and a different account stop without snapshot or save", async () => {
  for (const restriction of [{ url: "https://x.com/i/flow/login" }, { challenge: true }, { href: "/AnotherBot" }]) {
    await projectFixture(async (root) => {
      const { options, calls } = browserFixture(root, restriction);
      await assert.rejects(runSaveSession(options), LoginError);
      assert.equal(calls.snapshots, 0);
      assert.equal(calls.saved.length, 0);
      assert.equal(calls.closed, 1);
      assert.deepEqual(calls.goto.map(([url]) => url), ["https://x.com/home"]);
    });
  }
});

test("requires an X auth_token after scoping and closes context on navigation and save failures", async () => {
  for (const failure of [
    { state: { cookies: [{ name: "auth_token", value: "fake", domain: ".mail.invalid" }], origins: [] } },
    { navigationError: new Error("fake-navigation-error") },
    { saveError: new Error("fake-save-error") },
  ]) {
    await projectFixture(async (root) => {
      const { options, calls } = browserFixture(root, failure);
      await assert.rejects(runSaveSession(options));
      assert.equal(calls.closed, 1);
      if (!failure.saveError) assert.equal(calls.saved.length, 0);
    });
  }
});

test("uses the shared private session writer and supports legacy handle and configured destination", async () => {
  await projectFixture(async (root) => {
    const { options, calls } = browserFixture(root);
    delete options.env.X_ACCOUNT_HANDLE;
    options.env.USER_HANDLE = "@TestBot";
    options.env.X_BROWSER_SESSION_PATH = path.join(root, ".private/session.json");
    delete options.saveSession;
    const result = await runSaveSession(options);
    assert.equal(result.filename, options.env.X_BROWSER_SESSION_PATH);
    assert.equal((await fs.stat(result.filename)).mode & 0o777, 0o600);
    const saved = JSON.parse(await fs.readFile(result.filename, "utf8"));
    assert.deepEqual(saved.cookies.map((cookie) => cookie.domain), [".x.com"]);
    assert.equal(calls.closed, 1);
  });
});

test("bounded context close handles timeout and filters raw close errors", async () => {
  for (const failure of [{ closeNeverFinishes: true }, { closeError: new Error("fake-secret-request") }]) {
    await projectFixture(async (root) => {
      const { options, calls } = browserFixture(root, failure);
      options.closeTimeoutMs = 5;
      await assert.rejects(runSaveSession(options), (error) => {
        assert.equal(error instanceof LoginError, true);
        assert.equal(error.message.includes("fake-secret-request"), false);
        return true;
      });
      assert.equal(calls.closed, 1);
    });
  }
});

test("still delegates active-lock and symlink validation to prepareLoginProfile", async () => {
  await projectFixture(async (root) => {
    const { options, calls } = browserFixture(root);
    let prepared = 0;
    options.prepareProfile = async (directory) => {
      prepared++;
      assert.equal(directory, root);
      return prepareLoginProfile(directory);
    };
    await runSaveSession(options);
    assert.equal(prepared, 1);
    assert.equal(calls.launch.length, 1);
  });
});
