const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

function createProvider(env = {}, { browserConfigured = true } = {}) {
  const calls = { opened: 0, closed: 0, browserPosts: 0, apiPosts: 0 };
  const provider = loadTypeScript("app/api/post_tweets/publisher.ts", {
    env,
    mocks: {
      "./browserClient": {
        getBrowserConfiguration: () => ({
          configured: browserConfigured,
          missingVariables: browserConfigured ? [] : ["X_BROWSER_SESSION_PATH"],
        }),
        createBrowserPublisher: async () => {
          calls.opened++;
          return {
            postText: async () => {
              calls.browserPosts++;
              return { success: true, message: "OK", id: "browser-post" };
            },
            close: async () => { calls.closed++; },
          };
        },
        normalizeBrowserFailure: () => ({
          success: false, message: "Session nécessaire",
          error: { code: "SESSION_REQUIRED", detail: "Session nécessaire", status: 401 },
        }),
      },
      "./xApiClient": {
        getMissingXApiVariables: () => [],
        postToX: async () => {
          calls.apiPosts++;
          return { success: true, message: "OK", id: "api-post" };
        },
      },
    },
  });
  return { provider, calls };
}

test("unselected or invalid modes cannot silently call the paid API", async () => {
  for (const mode of [undefined, "disabled", "typo"]) {
    const { provider, calls } = createProvider({ X_POSTING_MODE: mode });
    const publisher = provider.createTextPublisher();
    const result = await publisher.postText("Une alerte");
    await publisher.close();
    assert.equal(result.success, false);
    assert.equal(calls.opened, 0);
    assert.equal(calls.apiPosts, 0);
  }
});

test("browser mode reuses one browser for a batch and never invokes the API", async () => {
  const { provider, calls } = createProvider({ X_POSTING_MODE: "browser" });
  const publisher = provider.createTextPublisher();
  assert.equal(calls.opened, 0);
  assert.equal((await publisher.postText("Première alerte")).success, true);
  assert.equal((await publisher.postText("Deuxième alerte")).success, true);
  await publisher.close();
  assert.deepEqual(calls, { opened: 1, closed: 1, browserPosts: 2, apiPosts: 0 });
});

test("a missing browser session does not fall back to API credentials", async () => {
  const { provider, calls } = createProvider({ X_POSTING_MODE: "browser" }, { browserConfigured: false });
  const configuration = provider.getPublisherConfiguration();
  assert.equal(configuration.configured, false);
  assert.equal(configuration.missingVariables[0], "X_BROWSER_SESSION_PATH");
  assert.equal((await provider.createTextPublisher().postText("Alerte")).success, false);
  assert.equal(calls.apiPosts, 0);
  assert.equal(calls.opened, 0);
});

test("API calls require selecting API mode explicitly", async () => {
  const { provider, calls } = createProvider({ X_POSTING_MODE: "api" });
  const publisher = provider.createTextPublisher();
  assert.equal((await publisher.postText("Alerte")).id, "api-post");
  await publisher.close();
  assert.equal(calls.apiPosts, 1);
  assert.equal(calls.opened, 0);
});
