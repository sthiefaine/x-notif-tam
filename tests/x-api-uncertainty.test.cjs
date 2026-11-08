const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const configured = {
  X_API_KEY: "fake-api-key", X_API_SECRET: "fake-api-secret",
  X_ACCESS_TOKEN: "fake-access-token", X_ACCESS_SECRET: "fake-access-secret",
};
function fixture(publish, { env = configured, constructorError } = {}) {
  const calls = [];
  const client = loadTypeScript("app/api/post_tweets/xApiClient.ts", {
    env,
    mocks: { "twitter-api-v2": { TwitterApi: class {
      constructor() { if (constructorError) throw constructorError; }
      v2 = { tweet: async (text) => { calls.push(text); return publish(text); } };
    } } },
  });
  return { client, calls };
}

test("a transport failure after an accepted API invocation remains uncertain", async () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE"]) {
    const accepted = [];
    const { client, calls } = fixture(async (text) => {
      accepted.push(text);
      throw Object.assign(new Error(`fake transport failure ${code}`), { code });
    });
    const result = await client.postToX("fake post");
    assert.equal(result.success, false);
    assert.equal(result.error.uncertain, true);
    assert.equal(accepted.length, 1);
    assert.equal(calls.length, 1);
  }
});

test("an API response without a usable post identifier cannot be retried automatically", async () => {
  for (const response of [{ data: {} }, { data: { id: "" } }, { data: { id: " " } }, undefined]) {
    const { client } = fixture(async () => response);
    const result = await client.postToX("fake post");
    assert.equal(result.success, false);
    assert.equal(result.error.uncertain, true);
  }
});

test("configuration and client initialization errors before invocation are not ambiguous submissions", async () => {
  for (const options of [{ env: {} }, { constructorError: new Error("fake initialization error") }]) {
    const { client, calls } = fixture(() => assert.fail("must not publish"), options);
    const result = await client.postToX("fake post");
    assert.equal(result.success, false);
    assert.equal(result.error.uncertain, false);
    assert.equal(calls.length, 0);
  }
});

test("explicit HTTP 4xx rejections remain releasable, while server failures remain uncertain", async () => {
  for (const status of [400, 401, 403, 422, 429, 500, 502, 503]) {
    const { client } = fixture(async () => { throw {
      code: status,
      data: { detail: `fake API HTTP ${status}`, errors: [{ code: 123 }] },
    }; });
    const result = await client.postToX("fake post");
    assert.equal(result.success, false);
    assert.equal(result.error.status, status);
    assert.equal(result.error.uncertain, status >= 500);
  }
});

test("confirmed API publications keep their identifier and failure diagnostics still redact secrets", async () => {
  const success = fixture(async () => ({ data: { id: "2119409972559638659" } }));
  const posted = await success.client.postToX("fake post");
  assert.equal(posted.success, true);
  assert.equal(posted.id, "2119409972559638659");
  const failure = fixture(async () => { throw new Error(`fake failure ${configured.X_API_SECRET}`); });
  const failed = await failure.client.postToX("fake post");
  assert.equal(failed.error.uncertain, true);
  assert.equal(JSON.stringify(failed).includes(configured.X_API_SECRET), false);
});
