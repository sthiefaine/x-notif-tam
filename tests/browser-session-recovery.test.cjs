const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const expired = { cookies: [], origins: [] };
const authenticated = () => ({
  cookies: [
    { name: "auth_token", value: "fake-new-x-token", domain: ".x.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: true, secure: true, sameSite: "None" },
    { name: "unrelated", value: "fake-mail-secret", domain: ".mail.invalid", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "None" },
  ],
  origins: [
    { origin: "https://x.com", localStorage: [] },
    { origin: "https://mail.invalid", localStorage: [{ name: "private", value: "fake-mail-secret" }] },
  ],
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const active = () => {};

function helper(getuid = () => process.getuid()) {
  return loadTypeScript("app/api/post_tweets/browserSessionRecovery.ts", {
    globals: { process: { getuid } },
  });
}

async function temporarySession(callback) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "x-recovery-test-")));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, "session.json");
  fs.writeFileSync(filename, JSON.stringify(expired), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "chrome"), "fake executable", { mode: 0o700 });
  try { await callback(filename, directory); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const markers = (directory) => fs.readdirSync(directory).filter((name) => name.startsWith(".x-login-attempt-"));

function recoveryBrowser(filename, recovery, options = {}) {
  let phase = options.pending ? "pending" : options.startHome ? "home" : "expired";
  const calls = { loginNavigations: 0, filled: [], next: 0, login: 0, closed: 0, browserClosed: 0, snapshots: 0 };
  const env = {
    X_BROWSER_SESSION_PATH: filename,
    CHROMIUM_EXECUTABLE_PATH: path.join(path.dirname(filename), "chrome"),
    X_ACCOUNT_HANDLE: "@TestBot",
    USER_EMAIL: "never-use-this@example.invalid",
    USER_PASSWORD: "fake-password-never-log",
    X_BROWSER_AUTO_RELOGIN: "true",
    ...options.env,
  };
  let url = options.initialUrl || (["home", "pending"].includes(phase) ? "https://x.com/home" : "https://x.com/i/jf/onboarding/web?mode=login");
  const timeout = () => Object.assign(new Error("fake timeout"), { name: "TimeoutError" });
  const textCount = (pattern, scoped) => ({ count: async () => {
    const text = phase === "rate" || options.initialRate ? "Nous avons temporairement limité votre connexion" :
      phase === "challenge" || options.initialChallenge ? "Enter your verification code" :
      scoped ? options.dialogText || "" : options.timelineText || "";
    return pattern.test(text) ? 1 : 0;
  } });
  function locator(selector) {
    const result = {
      first: () => result,
      or: () => result,
      count: async () => {
        if (selector.startsWith("iframe")) return options.initialChallenge || phase === "challenge" ? 1 : 0;
        if (selector.includes('input[name="challenge_response"]')) return options.initialChallenge || phase === "challenge" ? 1 : 0;
        if (selector.startsWith("input")) return ["username", "password", "expired"].includes(phase) ? 1 : 0;
        return phase === "home" ? 1 : 0;
      },
      waitFor: async () => {
        if (selector.includes('type="password"') && phase !== "password") throw timeout();
        if (selector.includes("data-testid") && phase !== "home") {
          if (phase === "pending" && options.lateLogin) {
            phase = "expired";
            url = "https://x.com/i/jf/onboarding/web?mode=login";
          }
          throw timeout();
        }
      },
      innerText: async () => `@${options.account || "TestBot"}`,
      getAttribute: async () => `/${options.account || "TestBot"}`,
      fill: async (value) => {
        const kind = selector.includes('type="password"') ? "password" : "username";
        calls.filled.push({ kind, value });
      },
    };
    return result;
  }
  const page = {
    url: () => url,
    goto: async (target) => {
      if (target.includes("mode=login")) {
        calls.loginNavigations++;
        phase = "username";
        url = target;
      }
      return { status: () => options.navigationStatus || 200 };
    },
    locator,
    getByText: (pattern) => textCount(pattern, false),
    getByRole: (role, settings = {}) => {
      if (["dialog", "alert"].includes(role)) {
        const messages = { or: () => messages, getByText: (pattern) => textCount(pattern, true) };
        return messages;
      }
      if (role === "button" && settings.name.test("Next")) {
        assert.equal(settings.name.test(options.nextLabel || "Next"), true);
        assert.equal(settings.name.test("Another Continue action"), false);
        return { click: async () => {
          calls.next++;
          phase = options.afterNext || "password";
          if (phase === "challenge") url = "https://x.com/account/access";
        } };
      }
      if (role === "button" && settings.name.test("Log in")) {
        assert.equal(settings.name.test(options.passwordLabel || "Log in"), true);
        assert.equal(settings.name.test("Another Continue action"), false);
        return { click: async () => {
          calls.login++;
          phase = options.failedLogin ? "expired" : "home";
          url = phase === "home" ? "https://x.com/home" : "https://x.com/i/jf/onboarding/web?mode=login";
        } };
      }
      return locator("profile");
    },
    waitForURL: async (predicate) => { if (!predicate(new URL(url))) throw timeout(); },
  };
  const context = {
    setDefaultTimeout() {},
    newPage: async () => page,
    storageState: async () => {
      calls.snapshots++;
      if (options.snapshotWait) await options.snapshotWait;
      return options.newState || authenticated();
    },
    close: async () => { calls.closed++; },
  };
  const client = loadTypeScript("app/api/post_tweets/browserClient.ts", {
    env,
    globals: options.globals || {},
    mocks: {
      "./browserSessionRecovery": recovery,
      "playwright-core": { chromium: { launch: async () => ({
        newContext: async () => context,
        close: async () => { calls.browserClosed++; },
      }) } },
    },
  });
  return { client, calls };
}

async function initializationResult(fixture) {
  try {
    const publisher = await fixture.client.createBrowserPublisher();
    await publisher.close();
    return { success: true };
  } catch (error) { return fixture.client.normalizeBrowserFailure(error); }
}

test("native wx claims are durable across independent helper instances and are private", async () => {
  await temporarySession(async (filename, directory) => {
    const first = helper();
    const second = helper();
    const a = first.readSessionSnapshot(filename);
    const b = second.readSessionSnapshot(filename);
    first.claimSessionRecovery(a, active);
    assert.throws(() => second.claimSessionRecovery(b, active), (error) => error.code === "SESSION_RECOVERY_USED");
    assert.equal(markers(directory).length, 1);
    const marker = path.join(directory, markers(directory)[0]);
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(marker, "utf8").includes("fake-password"), false);
    assert.match(markers(directory)[0], /[a-f0-9]{64}/);
  });
});

test("recovery refuses symlinks, hard links, public permissions and wrong ownership", async () => {
  await temporarySession(async (filename, directory) => {
    const recovery = helper();
    const alias = path.join(directory, "alias.json");
    fs.symlinkSync(filename, alias);
    assert.throws(() => recovery.readSessionSnapshot(alias), (error) => error.code === "UNSAFE_SESSION_STORAGE");
    const linked = path.join(directory, "linked.json");
    fs.linkSync(filename, linked);
    assert.throws(() => recovery.readSessionSnapshot(filename), (error) => error.code === "UNSAFE_SESSION_STORAGE");
    fs.unlinkSync(linked);
    fs.chmodSync(filename, 0o644);
    assert.throws(() => recovery.readSessionSnapshot(filename), (error) => error.code === "UNSAFE_SESSION_STORAGE");
    fs.chmodSync(filename, 0o600);
    assert.throws(() => helper(() => process.getuid() + 1).readSessionSnapshot(filename), (error) => error.code === "UNSAFE_SESSION_STORAGE");
    fs.chmodSync(directory, 0o777);
    assert.throws(() => recovery.readSessionSnapshot(filename), (error) => error.code === "UNSAFE_SESSION_STORAGE");
  });
});

test("a session parent symlink or a marker symlink cannot redirect reads or claims", async () => {
  await temporarySession(async (filename, directory) => {
    const recovery = helper();
    const alias = path.join(directory, "linked-parent");
    fs.symlinkSync(directory, alias);
    assert.throws(() => recovery.readSessionSnapshot(path.join(alias, "session.json")), (error) => error.code === "UNSAFE_SESSION_STORAGE");
    const snapshot = recovery.readSessionSnapshot(filename);
    recovery.claimSessionRecovery(snapshot, active);
    const marker = path.join(directory, markers(directory)[0]);
    fs.unlinkSync(marker);
    fs.symlinkSync(filename, marker);
    assert.throws(() => recovery.claimSessionRecovery(snapshot, active), (error) => error.code === "UNSAFE_SESSION_STORAGE");
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), expired);
  });
});

test("successful replacement is scoped to X, atomic/private, and changed files are never overwritten", async () => {
  await temporarySession(async (filename) => {
    const recovery = helper();
    const snapshot = recovery.readSessionSnapshot(filename);
    recovery.claimSessionRecovery(snapshot, active);
    recovery.saveRecoveredSession(snapshot, authenticated(), active);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    const state = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.deepEqual(state.cookies.map((cookie) => cookie.domain), [".x.com"]);
    assert.deepEqual(state.origins.map((origin) => origin.origin), ["https://x.com"]);
    assert.equal(JSON.stringify(state).includes("fake-mail-secret"), false);
    assert.throws(() => recovery.saveRecoveredSession(snapshot, authenticated(), active), (error) => error.code === "SESSION_CHANGED");
  });
});

test("deadline checks prevent a late disk commit and clean up the temporary file", async () => {
  await temporarySession(async (filename, directory) => {
    const recovery = helper();
    const snapshot = recovery.readSessionSnapshot(filename);
    let checks = 0;
    assert.throws(() => recovery.saveRecoveredSession(snapshot, authenticated(), () => {
      if (++checks === 3) throw new Error("fake expired deadline");
    }), /expired deadline/);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), expired);
    assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
  });
});

test("expired session recovery needs opt-in and a password and does not consume a claim otherwise", async () => {
  for (const env of [{ X_BROWSER_AUTO_RELOGIN: "" }, { X_BROWSER_AUTO_RELOGIN: "false" }, { USER_PASSWORD: "" }]) {
    await temporarySession(async (filename, directory) => {
      const fixture = recoveryBrowser(filename, helper(), { env });
      const result = await initializationResult(fixture);
      assert.equal(result.error.code, "SESSION_REQUIRED");
      assert.equal(markers(directory).length, 0);
      assert.equal(fixture.calls.loginNavigations, 0);
      assert.equal(fixture.calls.filled.length, 0);
    });
  }
});

test("a successful single recovery uses username instead of email and saves only authenticated X state", async () => {
  await temporarySession(async (filename, directory) => {
    const fixture = recoveryBrowser(filename, helper());
    const result = await initializationResult(fixture);
    assert.equal(result.success, true);
    assert.deepEqual(fixture.calls.filled, [
      { kind: "username", value: "TestBot" }, { kind: "password", value: "fake-password-never-log" },
    ]);
    assert.equal(fixture.calls.next, 1);
    assert.equal(fixture.calls.login, 1);
    assert.equal(markers(directory).length, 1);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.equal(saved.cookies.length, 1);
    assert.equal(JSON.stringify(saved).includes("fake-mail-secret"), false);
    assert.equal(fixture.calls.closed, 1);
    assert.equal(fixture.calls.browserClosed, 1);
  });
});

test("recovery accepts the exact English and French continuation labels at their verified stages", async () => {
  for (const labels of [
    { nextLabel: "Continue", passwordLabel: "Continue" },
    { nextLabel: "Continuer", passwordLabel: "Continuer" },
    { nextLabel: "Suivant", passwordLabel: "Se connecter" },
  ]) {
    await temporarySession(async (filename) => {
      const fixture = recoveryBrowser(filename, helper(), labels);
      assert.equal((await initializationResult(fixture)).success, true);
      assert.equal(fixture.calls.next, 1);
      assert.equal(fixture.calls.login, 1);
    });
  }
});

test("a failed login is not saved and independent later factories cannot retry that session", async () => {
  await temporarySession(async (filename, directory) => {
    const first = recoveryBrowser(filename, helper(), { failedLogin: true });
    const failure = await initializationResult(first);
    assert.equal(failure.success, false);
    assert.equal(first.calls.login, 1);
    assert.equal(first.calls.snapshots, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), expired);
    const second = recoveryBrowser(filename, helper());
    const blocked = await initializationResult(second);
    assert.equal(blocked.error.code, "SESSION_RECOVERY_USED");
    assert.equal(second.calls.loginNavigations, 0);
    assert.equal(second.calls.filled.length, 0);
    assert.equal(markers(directory).length, 1);
  });
});

test("a late proven login redirect can recover, while an ambiguous navigation timeout cannot", async () => {
  for (const lateLogin of [true, false]) {
    await temporarySession(async (filename, directory) => {
      const fixture = recoveryBrowser(filename, helper(), { pending: true, lateLogin });
      const result = await initializationResult(fixture);
      assert.equal(result.success, lateLogin);
      assert.equal(fixture.calls.loginNavigations, lateLogin ? 1 : 0);
      assert.equal(markers(directory).length, lateLogin ? 1 : 0);
      if (!lateLogin) assert.equal(result.error.code, "BROWSER_TIMEOUT");
    });
  }
});

test("challenge, rate limit, wrong account and ambiguous state never initiate recovery", async () => {
  for (const options of [
    { initialChallenge: true }, { initialRate: true }, { navigationStatus: 429 },
    { startHome: true, account: "DifferentBot" },
    { startHome: true, dialogText: "Enter your verification code" },
  ]) {
    await temporarySession(async (filename, directory) => {
      const fixture = recoveryBrowser(filename, helper(), options);
      const result = await initializationResult(fixture);
      assert.equal(result.success, false);
      assert.equal(fixture.calls.loginNavigations, 0);
      assert.equal(fixture.calls.login, 0);
      assert.equal(markers(directory).length, 0);
    });
  }
});

test("a challenge or connection limit after Next stops before password and remains consumed", async () => {
  for (const afterNext of ["challenge", "rate"]) {
    await temporarySession(async (filename, directory) => {
      const fixture = recoveryBrowser(filename, helper(), { afterNext });
      const result = await initializationResult(fixture);
      assert.equal(result.success, false);
      assert.equal(fixture.calls.next, 1);
      assert.equal(fixture.calls.login, 0);
      assert.deepEqual(fixture.calls.filled.map((entry) => entry.kind), ["username"]);
      assert.equal(markers(directory).length, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), expired);
    });
  }
});

test("wrong account or expired/missing authentication after login is never saved", async () => {
  for (const options of [
    { account: "DifferentBot" }, { newState: expired },
    { newState: { ...authenticated(), cookies: authenticated().cookies.map((cookie) => ({ ...cookie, expires: 1 })) } },
  ]) {
    await temporarySession(async (filename) => {
      const fixture = recoveryBrowser(filename, helper(), options);
      const result = await initializationResult(fixture);
      assert.equal(result.success, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), expired);
      assert.equal(JSON.stringify(result).includes("fake-password-never-log"), false);
    });
  }
});

test("a snapshot completing after the global deadline cannot write the recovered session", async () => {
  await temporarySession(async (filename, directory) => {
    const timers = new Map();
    let nextTimer = 0;
    let finishSnapshot;
    const snapshotWait = new Promise((resolve) => { finishSnapshot = resolve; });
    const fixture = recoveryBrowser(filename, helper(), {
      snapshotWait,
      globals: {
        setTimeout: (callback, milliseconds) => {
          const id = ++nextTimer;
          timers.set(id, { callback, milliseconds });
          return id;
        },
        clearTimeout: (id) => timers.delete(id),
      },
    });
    const resultPromise = initializationResult(fixture);
    await new Promise(setImmediate);
    assert.equal(fixture.calls.snapshots, 1);
    const deadline = [...timers.values()].find((timer) => timer.milliseconds > 45_000);
    assert.ok(deadline);
    deadline.callback();
    const result = await resultPromise;
    assert.equal(result.error.code, "BROWSER_TIMEOUT");
    finishSnapshot();
    await new Promise(setImmediate);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), expired);
    assert.equal(markers(directory).length, 1);
    assert.equal(fixture.calls.closed, 1);
  });
});
