const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

const configuredEnv = {
  X_POSTING_MODE: "api",
  CRON_SECRET: "test-cron-secret",
  X_API_KEY: "test-api-key",
  X_API_SECRET: "test-api-secret",
  X_ACCESS_TOKEN: "test-access-token",
  X_ACCESS_SECRET: "test-access-secret",
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const missing = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];
const configuration = (configured, mode = "api") => ({
  mode, configured,
  missingVariables: configured ? [] : missing,
  message: configured ? "API X configurée" : `Identifiants manquants : ${missing.join(", ")}`,
});
const noDatabase = new Proxy({}, {
  get() { throw new Error("Database access was not expected"); },
});

function loadPosting(prisma, postToX, configured = true, mode = "api") {
  return loadTypeScript("app/api/post_tweets/postTweet.ts", {
    mocks: {
      "@/lib/prisma": { prisma },
      "@/lib/transit/publication-ledger": loadTypeScript("lib/transit/publication-ledger.ts"),
      "./publisher": {
        getPublisherConfiguration: () => configuration(configured, mode),
        createTextPublisher: () => ({
          postText: postToX ?? (() => { throw new Error("Unexpected X call"); }),
          close: async () => {},
        }),
      },
    },
    globals: { setTimeout: (callback) => { callback(); return 0; } },
    env: configuredEnv,
  });
}

function loadRoute(prisma, { configured = true, postToTwitter, env = configuredEnv } = {}) {
  const formatting = loadPosting(noDatabase);
  return loadTypeScript("app/api/post_tweets/route.ts", {
    mocks: {
      "next/server": {
        NextResponse: {
          json: (body, options) => new Response(JSON.stringify(body), options),
        },
      },
      "@/lib/prisma": { prisma },
      "./postTweet": {
        ...formatting,
        postToTwitter: postToTwitter ?? (() => { throw new Error("Unexpected publication"); }),
      },
      "./xApiClient": {
        isXApiConfigured: () => configured,
      },
      "./publisher": {
        getPublisherConfiguration: () => configuration(configured),
      },
    },
    env,
  });
}

function request(query = "", authorized = true) {
  return {
    headers: new Headers(authorized ? { authorization: "Bearer test-cron-secret" } : {}),
    nextUrl: new URL(`https://test.invalid/api/post_tweets${query}`),
  };
}

function alert(id, headerText = "Incident") {
  return {
    id,
    headerText,
    descriptionText: "Incident sur le réseau.",
    timeStart: new Date(),
    routeIds: "7-1",
    cause: "TECHNICAL_PROBLEM",
    isProcessing: false,
    isPosted: false,
  };
}

test("publication without X credentials never touches the database", async () => {
  const result = await loadPosting(noDatabase, undefined, false).postToTwitter();
  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 503);
  assert.match(result.messages[0], /X_API_KEY/);
});

test("posting route refuses missing cron security and incorrect authorization", async () => {
  const missingSecret = loadRoute(noDatabase, { env: {} });
  const response = await missingSecret.GET(request());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /CRON_SECRET/);
  const unauthorized = loadRoute(noDatabase);
  assert.equal((await unauthorized.GET(request("", false))).status, 401);
});

test("missing X configuration is reported before any database dependency", async () => {
  const route = loadRoute(noDatabase, {
    configured: false,
    postToTwitter: async () => ({ success: false, httpStatus: 503, messages: ["Missing X configuration"] }),
  });
  const response = await route.GET(request());
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.success, false);
  assert.equal(body.xApiConfigured, false);
  assert.deepEqual(body.missingVariables, missing);
  assert.deepEqual(body.postingResult.messages, ["Missing X configuration"]);
});

test("dryRun only reads and uses the publication date window and batch limit", async () => {
  const queries = [];
  const prisma = {
    alert: {
      count: async (query) => { queries.push(query); return 1; },
      findMany: async (query) => { queries.push(query); return [alert("a")]; },
      updateMany: () => { throw new Error("dryRun attempted a write"); },
    },
    $transaction: () => { throw new Error("dryRun started a write transaction"); },
  };
  const route = loadRoute(prisma, { configured: false });
  const response = await route.GET(request("?dryRun=true"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.xApiConfigured, false);
  assert.equal(body.formattedTweets.length, 1);
  assert.equal(body.postingResult, null);
  assert.equal(queries.length, 2);
  const window = loadPosting(noDatabase).getPublicationWindow();
  for (const query of queries) {
    assert.equal(query.where.timeStart.gte.getTime(), window.gte.getTime());
    assert.equal(query.where.timeStart.lte.getTime(), window.lte.getTime());
    assert.equal(query.where.isProcessing, false);
  }
  assert.equal(queries[1].take, 20);
});

test("route propagates publication failures and retry delay", async () => {
  const route = loadRoute({
    $transaction: async (callback) => callback({
      alert: { updateMany: async () => ({ count: 0 }), count: async () => 1 },
    }),
  }, {
    postToTwitter: async () => ({
      success: false, httpStatus: 429, processed: 0, failed: 1,
      errors: [{ status: 429, detail: "Quota exceeded", retryAfter: 120 }],
    }),
  });
  const response = await route.GET(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "120");
  assert.equal((await response.json()).success, false);
});

function claimingDatabase(rows) {
  let locked = false;
  const queries = [];
  const updateMany = async ({ where, data }) => {
    let count = 0;
    for (const row of rows) {
      if (!where.id.in.includes(row.id)) continue;
      if (where.isPosted !== undefined && row.isPosted !== where.isPosted) continue;
      Object.assign(row, data);
      count++;
    }
    return { count };
  };
  return {
    queries,
    isLocked: () => locked,
    alert: { updateMany },
    $transaction: async (callback) => {
      let ownsLock = false;
      try {
        return await callback({
          $queryRaw: async (query) => {
            assert.match(query.join(""), /pg_try_advisory_xact_lock/);
            if (locked) return [{ locked: false }];
            locked = true;
            ownsLock = true;
            return [{ locked: true }];
          },
          alert: {
            findMany: async (query) => {
              queries.push(query);
              assert.equal(locked, true);
              return rows.filter((row) => !row.isProcessing && !row.isPosted).map((row) => ({ ...row }));
            },
            updateMany,
          },
        });
      } finally {
        if (ownsLock) locked = false;
      }
    },
  };
}

test("concurrent workers claim once and release the transaction before contacting X", async () => {
  const prisma = claimingDatabase([alert("a")]);
  let publications = 0;
  const posting = loadPosting(prisma, async () => {
    assert.equal(prisma.isLocked(), false);
    publications++;
    return { success: true, id: "tweet-1", message: "OK" };
  });
  const results = await Promise.all([posting.postToTwitter(), posting.postToTwitter()]);
  assert.equal(publications, 1);
  assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 1);
  const window = posting.getPublicationWindow();
  assert.equal(prisma.queries[0].where.timeStart.gte.getTime(), window.gte.getTime());
  assert.equal(prisma.queries[0].where.timeStart.lte.getTime(), window.lte.getTime());
});

test("an unconfirmed browser submission is held for manual review while the rest of the batch is released", async () => {
  const rows = [alert("a", "Premier incident"), alert("b", "Autre incident")];
  const prisma = claimingDatabase(rows);
  let attempts = 0;
  const posting = loadPosting(prisma, async () => {
    attempts++;
    return {
      success: false, message: "Confirmation non reçue",
      error: { status: 504, code: "BROWSER_TIMEOUT", detail: "Confirmation non reçue", uncertain: true },
    };
  }, true, "browser");
  const result = await posting.postToTwitter();
  assert.equal(attempts, 1);
  assert.equal(result.success, false);
  assert.equal(rows[0].isPosted, false);
  assert.equal(rows[0].isProcessing, true);
  assert.equal(rows[0].inProcessSince, null);
  assert.equal(rows[1].isProcessing, false);
  assert.equal(result.errors[0].uncertain, true);
});

test("a confirmed post stays held when recording its success in the database fails", async () => {
  const rows = [alert("a", "Premier incident"), alert("b", "Autre incident")];
  const prisma = claimingDatabase(rows);
  const update = prisma.alert.updateMany;
  prisma.alert.updateMany = async (query) => {
    if (query.data.isPosted) throw new Error("Database write unavailable");
    return update(query);
  };
  let attempts = 0;
  const result = await loadPosting(prisma, async () => {
    attempts++;
    assert.equal(rows[0].inProcessSince, null);
    return { success: true, message: "OK", id: "123456" };
  }, true, "browser").postToTwitter();
  assert.equal(attempts, 1);
  assert.equal(result.success, false);
  assert.equal(rows[0].isProcessing, true);
  assert.equal(rows[0].inProcessSince, null);
  assert.equal(rows[1].isProcessing, false);
  assert.equal(result.errors[0].uncertain, true);
});

test("cleanup failures cannot release a group with an unconfirmed submission", async () => {
  const rows = [alert("a", "Premier incident"), alert("b", "Autre incident")];
  const prisma = claimingDatabase(rows);
  const update = prisma.alert.updateMany;
  let cleanupFailed = false;
  prisma.alert.updateMany = async (query) => {
    if (query.data.isProcessing === false && query.where.id.in.includes("b") && !cleanupFailed) {
      cleanupFailed = true;
      throw new Error("Cleanup failed once");
    }
    return update(query);
  };
  const result = await loadPosting(prisma, async () => ({
    success: false, message: "No confirmation",
    error: { status: 504, code: "BROWSER_TIMEOUT", detail: "No confirmation", uncertain: true },
  }), true, "browser").postToTwitter();
  assert.equal(result.success, false);
  assert.equal(cleanupFailed, true);
  assert.equal(rows[0].isProcessing, true);
  assert.equal(rows[0].inProcessSince, null);
  assert.equal(rows[1].isProcessing, false);
});

test("a preparation failure prevents any browser submission", async () => {
  const rows = [alert("a")];
  const prisma = claimingDatabase(rows);
  const update = prisma.alert.updateMany;
  prisma.alert.updateMany = async (query) => {
    if (query.data.inProcessSince === null && query.data.isProcessing === undefined) {
      throw new Error("Preparation failed");
    }
    return update(query);
  };
  let attempts = 0;
  const result = await loadPosting(prisma, async () => {
    attempts++;
    return { success: true, message: "OK", id: "123456" };
  }, true, "browser").postToTwitter();
  assert.equal(result.success, false);
  assert.equal(attempts, 0);
  assert.equal(rows[0].isProcessing, false);
});

test("account-wide X refusal stops the batch and releases pending alerts", async () => {
  const rows = [alert("a", "Premier incident"), alert("b", "Autre incident")];
  const prisma = claimingDatabase(rows);
  let publications = 0;
  const posting = loadPosting(prisma, async () => {
    publications++;
    return { success: false, message: "Quota exceeded", error: { status: 429, detail: "Quota exceeded" } };
  });
  const result = await posting.postToTwitter();
  assert.equal(result.success, false);
  assert.equal(result.httpStatus, 429);
  assert.equal(publications, 1);
  assert.equal(rows.every((row) => row.isProcessing === false && row.isPosted === false), true);
});

test("X errors preserve useful details while discarding secrets and request internals", () => {
  const client = loadTypeScript("app/api/post_tweets/xApiClient.ts", {
    mocks: { "twitter-api-v2": { TwitterApi: class {} } },
    env: configuredEnv,
  });
  const result = client.getXApiError({
    code: 403,
    data: {
      detail: `Denied ${configuredEnv.X_API_SECRET} Bearer unknown-token oauth_token="unknown-oauth-token"`,
      errors: [{ code: 220 }],
    },
    request: { authorization: "secret-request-authorization" },
  });
  assert.equal(result.status, 403);
  assert.equal(result.code, 220);
  const serialized = JSON.stringify(result);
  for (const secret of [configuredEnv.X_API_SECRET, "unknown-token", "unknown-oauth-token", "secret-request-authorization"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(Object.keys(plain(result)), ["status", "code", "detail"]);
});

test("X client refuses malformed success responses and exposes structured quota errors", async () => {
  const error = {
    code: 429,
    data: { title: "Too Many Requests" },
    rateLimit: { reset: Math.ceil(Date.now() / 1000) + 60 },
  };
  let fail = false;
  const client = loadTypeScript("app/api/post_tweets/xApiClient.ts", {
    mocks: {
      "twitter-api-v2": { TwitterApi: class {
        v2 = { tweet: async () => { if (fail) throw error; return { data: {} }; } };
      } },
    },
    env: configuredEnv,
  });
  const malformed = await client.postToX("test");
  assert.equal(malformed.success, false);
  fail = true;
  const quota = await client.postToX("test");
  assert.equal(quota.success, false);
  assert.equal(quota.error.status, 429);
  assert.equal(quota.error.retryAfter >= 59 && quota.error.retryAfter <= 61, true);
});
