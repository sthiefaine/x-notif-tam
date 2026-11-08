const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const env = {
  X_ACCOUNT_HANDLE: "@testbot",
  X_BROWSER_SESSION_PATH: "/test/session.json",
  CHROMIUM_EXECUTABLE_PATH: "/test/chromium",
};
const successBody = { data: { create_tweet: { tweet_results: { result: { rest_id: "1234567890123456789" } } } } };
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const state = {
    url: "https://x.com/home",
    account: "Test Bot\n@testbot",
    profile: "/testbot",
    hasSwitcher: true,
    challenge: false,
    loginInput: false,
    launches: 0,
    contexts: 0,
    pages: 0,
    fills: [],
    clicks: 0,
    contextClosed: 0,
    browserClosed: 0,
    body: successBody,
    status: 200,
    ...options.state,
  };
  const response = {
    url: () => "https://x.com/i/api/graphql/query-id/CreateTweet",
    request: () => ({ method: () => "POST" }),
    status: () => state.status,
    ok: () => state.status >= 200 && state.status < 300,
    headers: () => ({ "retry-after": "60" }),
    json: async () => state.body,
  };
  const page = {
    url: () => state.url,
    goto: async (url, settings) => {
      assert.equal(url, "https://x.com/home");
      assert.equal(settings.waitUntil, "domcontentloaded");
    },
    locator: (selector) => {
      const locator = {
        first: () => locator,
        count: async () => {
          if (selector.startsWith("iframe")) return state.challenge ? 1 : 0;
          if (selector.startsWith("input")) return state.loginInput ? 1 : 0;
          if (selector === '[data-testid="SideNav_AccountSwitcher_Button"]') return state.hasSwitcher ? 1 : 0;
          return 1;
        },
        innerText: async () => state.account,
        getAttribute: async (name) => { assert.equal(name, "href"); return state.profile; },
        waitFor: async () => {},
        fill: async (text) => {
          if (state.fillError) throw state.fillError;
          state.fills.push(text);
        },
        click: async () => {
          state.clicks++;
          if (state.clickError) throw state.clickError;
        },
      };
      return locator;
    },
    waitForResponse: (predicate, settings) => {
      assert.equal(settings.timeout < 60_000, true);
      assert.equal(predicate(response), true);
      assert.equal(predicate({ ...response, url: () => "https://elsewhere.invalid/graphql/id/CreateTweet" }), false);
      assert.equal(predicate({ ...response, url: () => "https://x.com/i/api/graphql/id/DeleteTweet" }), false);
      assert.equal(predicate({ ...response, request: () => ({ method: () => "GET" }) }), false);
      if (state.responseError) return Promise.reject(state.responseError);
      if (state.responseWait) return state.responseWait;
      return Promise.resolve(response);
    },
  };
  const context = {
    setDefaultTimeout: () => {},
    newPage: async () => { state.pages++; return page; },
    close: async () => { state.contextClosed++; },
  };
  const browser = {
    newContext: async (settings) => {
      state.contexts++;
      assert.deepEqual(plain(settings), { storageState: "/test/session.json" });
      if (state.contextError) throw state.contextError;
      return context;
    },
    close: async () => { state.browserClosed++; },
  };
  const files = options.files ?? ["/test/session.json", "/test/chromium"];
  const client = loadTypeScript("app/api/post_tweets/browserClient.ts", {
    env: options.env ?? env,
    mocks: {
      "node:fs": {
        constants: { R_OK: 4, X_OK: 1 },
        statSync: (path) => {
          if (!files.includes(path)) throw new Error("Missing test file");
          return { isFile: () => true };
        },
        accessSync: (path) => { if (!files.includes(path)) throw new Error("Inaccessible test file"); },
      },
      "playwright-core": { chromium: {
        launch: async (settings) => {
          state.launches++;
          assert.equal(settings.headless, true);
          assert.equal(settings.timeout < 60_000, true);
          assert.equal(Object.hasOwn(settings, "args"), false);
          if (state.launchError) throw state.launchError;
          if (state.launchWait) await state.launchWait;
          return browser;
        },
      } },
    },
    globals: options.globals ?? {},
  });
  return { client, state };
}

test("browser configuration requires a readable session, verified handle and executable", async () => {
  const { client, state } = fixture({ env: {}, files: [] });
  assert.deepEqual(plain(client.getBrowserConfiguration()), {
    configured: false,
    missingVariables: ["X_BROWSER_SESSION_PATH", "X_ACCOUNT_HANDLE", "CHROMIUM_EXECUTABLE_PATH"],
  });
  const result = await client.postToBrowser("test");
  assert.equal(result.success, false);
  assert.equal(result.error.code, "BROWSER_NOT_CONFIGURED");
  assert.equal(state.launches, 0);
});

test("browser configuration supports legacy handle and an unavailable legacy executable", () => {
  const { client } = fixture({
    env: {
      USER_HANDLE: "testbot",
      X_BROWSER_SESSION_PATH: "/test/session.json",
      PUPPETEER_EXECUTABLE_PATH: "/old/missing/chromium-browser",
    },
    files: ["/test/session.json", "/usr/bin/chromium"],
  });
  assert.equal(client.getBrowserConfiguration().configured, true);
});

test("manual login is required without attempting to fill or submit a login form", async () => {
  for (const url of [
    "https://x.com/i/flow/login",
    "https://x.com/i/jf/onboarding/web?mode=login",
    "https://x.com/login",
  ]) {
    const { client, state } = fixture({ state: { url } });
    const result = await client.postToBrowser("test");
    assert.equal(result.success, false);
    assert.equal(result.error.code, "SESSION_REQUIRED");
    assert.equal(result.error.status, 401);
    assert.equal(state.fills.length, 0);
    assert.equal(state.clicks, 0);
    assert.equal(state.contextClosed, 1);
    assert.equal(state.browserClosed, 1);
    assert.equal(result.error.uncertain, undefined);
  }
});

test("account challenge URL and challenge frame each halt publication", async () => {
  for (const challenge of [{ url: "https://x.com/account/access" }, { challenge: true }]) {
    const { client, state } = fixture({ state: challenge });
    const result = await client.postToBrowser("test");
    assert.equal(result.error.code, "ACCOUNT_CHALLENGE");
    assert.equal(result.error.status, 403);
    assert.equal(state.clicks, 0);
    assert.equal(state.browserClosed, 1);
  }
});

test("a different account cannot publish even if the profile fallback claims the expected handle", async () => {
  const { client, state } = fixture({ state: { account: "Other account\n@testbot_extra" } });
  const result = await client.postToBrowser("test");
  assert.equal(result.error.code, "ACCOUNT_MISMATCH");
  assert.equal(state.clicks, 0);
});

test("the exact profile link can verify identity when the account switcher is absent", async () => {
  const { client, state } = fixture({ state: { hasSwitcher: false } });
  const result = await client.postToBrowser("test");
  assert.equal(result.success, true);
  assert.equal(result.id, "1234567890123456789");
  assert.deepEqual(state.fills, ["test"]);
  assert.equal(state.contextClosed, 1);
  assert.equal(state.browserClosed, 1);
});

test("a clicked button is insufficient without a CreateTweet rest_id", async () => {
  for (const body of [{ data: {} }, { data: { create_tweet: { tweet_results: { result: { rest_id: "not-an-id" } } } } }]) {
    const { client, state } = fixture({ state: { body } });
    const result = await client.postToBrowser("test");
    assert.equal(state.clicks, 1);
    assert.equal(result.success, false);
    assert.equal(result.error.code, "PUBLICATION_UNCONFIRMED");
    assert.equal(result.error.uncertain, true);
    assert.equal(state.contextClosed, 1);
    assert.equal(state.browserClosed, 1);
  }
});

test("X quota and challenge replies stop publication and expose only safe error fields", async () => {
  const quota = fixture({ state: { status: 429 } });
  const quotaResult = await quota.client.postToBrowser("test");
  assert.equal(quotaResult.error.status, 429);
  assert.equal(quotaResult.error.retryAfter, 60);
  assert.equal(quotaResult.error.uncertain, undefined);
  const challenge = fixture({ state: { body: { errors: [{ code: 226, message: "secret-cookie-value" }] } } });
  const challengeResult = await challenge.client.postToBrowser("test");
  assert.equal(challengeResult.error.code, "ACCOUNT_CHALLENGE");
  assert.equal(challengeResult.error.uncertain, undefined);
  assert.equal(JSON.stringify(challengeResult).includes("secret-cookie-value"), false);
});

test("batch publication reuses one browser, context and page and close is idempotent", async () => {
  const { client, state } = fixture();
  const publisher = await client.createBrowserPublisher();
  try {
    assert.equal((await publisher.postText("first")).success, true);
    assert.equal((await publisher.postText("second")).success, true);
    assert.equal(state.launches, 1);
    assert.equal(state.contexts, 1);
    assert.equal(state.pages, 1);
    assert.equal(state.browserClosed, 0);
  } finally {
    await publisher.close();
    await publisher.close();
  }
  assert.equal(state.contextClosed, 1);
  assert.equal(state.browserClosed, 1);
  assert.equal((await publisher.postText("third")).error.code, "BROWSER_CLOSED");
});

test("account identity is checked again before later posts in a batch", async () => {
  const { client, state } = fixture();
  const publisher = await client.createBrowserPublisher();
  state.account = "@otherbot";
  const result = await publisher.postText("test");
  assert.equal(result.error.code, "ACCOUNT_MISMATCH");
  assert.equal(state.clicks, 0);
  assert.equal(state.contextClosed, 1);
  assert.equal(state.browserClosed, 1);
});

test("initialization and publication failures close resources without exposing raw errors", async () => {
  const initialization = fixture({ state: { contextError: new Error("secret-session-cookies") } });
  const result = await initialization.client.postToBrowser("test");
  assert.equal(result.success, false);
  assert.equal(initialization.state.browserClosed, 1);
  assert.equal(JSON.stringify(result).includes("secret-session-cookies"), false);

  const timeout = new Error("secret-request-content");
  timeout.name = "TimeoutError";
  const publication = fixture({ state: { responseError: timeout } });
  const unconfirmed = await publication.client.postToBrowser("test");
  assert.equal(unconfirmed.error.code, "BROWSER_TIMEOUT");
  assert.equal(unconfirmed.error.status, 504);
  assert.equal(unconfirmed.error.uncertain, true);
  assert.equal(publication.state.browserClosed, 1);
  assert.equal(publication.state.contextClosed, 1);
  assert.equal(JSON.stringify(unconfirmed).includes("secret-request-content"), false);

  const beforeClick = fixture({ state: { fillError: timeout } });
  const notSubmitted = await beforeClick.client.postToBrowser("test");
  assert.equal(notSubmitted.error.code, "BROWSER_TIMEOUT");
  assert.equal(notSubmitted.error.uncertain, undefined);
  assert.equal(beforeClick.state.clicks, 0);
});

test("initialization deadline closes a browser that finishes launching after timeout", async () => {
  const timers = new Map();
  let nextTimer = 0;
  let finishLaunch;
  const launchWait = new Promise((resolve) => { finishLaunch = resolve; });
  const { client, state } = fixture({
    state: { launchWait },
    globals: {
      setTimeout: (callback, milliseconds) => {
        const id = ++nextTimer;
        timers.set(id, { callback, milliseconds });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  const resultPromise = client.createBrowserPublisher().catch(client.normalizeBrowserFailure);
  const deadline = [...timers.values()].find((timer) => timer.milliseconds === 20_000);
  assert.ok(deadline);
  deadline.callback();
  const result = await resultPromise;
  assert.equal(result.error.code, "BROWSER_TIMEOUT");
  assert.equal(result.error.uncertain, undefined);
  finishLaunch();
  await new Promise(setImmediate);
  assert.equal(state.browserClosed, 1);
  assert.equal(state.contexts, 0);
  assert.equal(state.clicks, 0);
});
