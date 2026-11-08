const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { loadBotAlertRoutes } = require("./helpers/bot-alert-routes.cjs");
const { createHash } = require("node:crypto");

function createCollection({ env, fetch, failDatabase = false, routes } = {}) {
  const writes = [];
  const parentQueries = [];
  let publications = 0;
  const module = loadTypeScript("tasks/fetchAlerts.ts", {
    env,
    mocks: {
      "@/app/api/post_tweets/alertRoutes": routes ?? loadBotAlertRoutes(),
      protobufjs: {
        load: async () => ({
          lookupType: () => ({
            decode: (buffer) => JSON.parse(buffer.toString()),
            toObject: (message) => message,
          }),
        }),
      },
      "@/lib/prisma": {
        ensurePrismaConnection: async () => {
          if (failDatabase) throw new Error("database unavailable");
        },
        prisma: {
          alert: {
            upsert: async (input) => writes.push(input),
            findMany: async (query) => { parentQueries.push(query); return []; },
          },
          $transaction: async (callback) => callback({
            alert: {
              findMany: async () => [],
              updateMany: async () => ({ count: 0 }),
              count: async () => 0,
            },
          }),
        },
      },
      "@/helpers/incident": {
        determineCauseByKeywords: () => "UNKNOWN_CAUSE",
        determineEffectByKeywords: () => "UNKNOWN_EFFECT",
      },
      "@/app/api/post_tweets/postTweet": {
        postToTwitter: async () => { publications++; },
      },
    },
    globals: { fetch },
  });
  return { collect: module.fetchAndProcessAlerts, writes, parentQueries, publications: () => publications };
}

function feedResponse(entity = []) {
  return new Response(JSON.stringify({ header: { gtfsRealtimeVersion: "2.0" }, entity }));
}

test("uses the common TaM source with a timeout and accepts an empty valid feed", async () => {
  let request;
  const collection = createCollection({
    fetch: async (url, options) => { request = { url, options }; return feedResponse(); },
  });
  const result = await collection.collect();
  assert.equal(request.url, "https://gtfsproxy.e-tam.fr/COMMON/Alert.pb");
  assert.equal(request.options.cache, "no-store");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(result.success, true);
  assert.equal(result.status, "success");
  assert.equal(result.successfulFeeds, 1);
  assert.equal(result.processedEntities, 0);
  assert.equal(collection.publications(), 0);
});

test("reports total source failure instead of a successful collection", async () => {
  const collection = createCollection({ fetch: async () => new Response("gone", { status: 404 }) });
  const result = await collection.collect();
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failedFeeds, 1);
  assert.match(result.feeds[0].error, /404/);
  assert.equal(collection.writes.length, 0);
  assert.equal(collection.publications(), 0);
});

test("continues after a failed source and reports the partial result", async () => {
  const visited = [];
  const collection = createCollection({
    env: { ALERT_URL: " https://example.test/broken, https://example.test/valid " },
    fetch: async (url) => {
      visited.push(url);
      if (url.endsWith("broken")) throw new Error("source unavailable");
      return feedResponse([{
        id: "1052678",
        alert: {
          headerText: { translation: [{ text: "Ligne 33" }] },
          descriptionText: { translation: [{ text: "Arrêt non desservi" }] },
          informedEntity: [{ routeId: "33" }],
          activePeriod: [{ start: "1794390000", end: "1794394800" }],
        },
      }]);
    },
  });
  const result = await collection.collect();
  assert.deepEqual(visited, ["https://example.test/broken", "https://example.test/valid"]);
  assert.equal(result.status, "partial");
  assert.equal(result.success, false);
  assert.equal(result.failedFeeds, 1);
  assert.equal(result.successfulFeeds, 1);
  assert.equal(result.processedEntities, 1);
  assert.equal(collection.writes[0].create.routeIds, "33");
  assert.equal(collection.publications(), 0);
});

test("the current line A producer selector is canonicalized without changing identity or publication guards", async () => {
  const header = "    TR/LIGNE A/ ligne a retard sans cause";
  const collection = createCollection({ fetch: async () => feedResponse([{
    id: "1052756", alert: {
      headerText: { translation: [{ text: header }] },
      descriptionText: { translation: [{ text: "Des retards sont annoncés sur la ligne A." }] },
      informedEntity: [{ routeId: "61" }], activePeriod: [{ start: "1794147240", end: "1794151800" }],
    },
  }]) });
  await collection.collect();
  const write = collection.writes[0];
  assert.equal(write.create.routeIds, "A");
  assert.equal(write.update.routeIds, "A");
  assert.equal(write.where.id, `1052756_${createHash("md5").update(header).digest("hex")}`);
  assert.equal(write.where.id, "1052756_975a8deeb52a863da0154514cedc4bf3");
  assert.equal(write.update.headerText, header);
  for (const guard of ["isPosted", "isProcessing", "inProcessSince"]) assert.equal(Object.hasOwn(write.update, guard), false);
  assert.equal(collection.publications(), 0);
});

test("line A complements match complete route tokens rather than the Amigo substring", async () => {
  const collection = createCollection({ fetch: async () => feedResponse([{
    id: "resolution", alert: {
      headerText: { translation: [{ text: "Reprise ligne A" }] },
      descriptionText: { translation: [{ text: "La circulation reprend sur la ligne A." }] },
      informedEntity: [{ routeId: "61" }], activePeriod: [{ start: "1794147240" }],
    },
  }]) });
  await collection.collect();
  const filters = collection.parentQueries[0].where.AND[0].OR;
  assert.equal(filters[0].routeIds, "A");
  assert.equal(filters.some((filter) => filter.routeIds?.contains === "A"), false);
  assert.equal(filters.some((filter) => filter.routeIds?.contains === ",A,"), true);
  assert.equal(collection.writes[0].create.routeIds, "A");
});

test("missing static data or several route selectors never cause a guessed line assignment", async () => {
  for (const scenario of [
    { selectors: [{ routeId: "61" }], routes: loadBotAlertRoutes({ unavailable: true }), expected: "61" },
    { selectors: [{ routeId: "61" }, { routeId: "62" }], expected: "61,62" },
  ]) {
    const collection = createCollection({ routes: scenario.routes, fetch: async () => feedResponse([{
      id: "safe", alert: { headerText: { translation: [{ text: "Ligne A" }] },
        descriptionText: { translation: [{ text: "Retard sur la ligne A." }] }, informedEntity: scenario.selectors },
    }]) });
    await collection.collect();
    assert.equal(collection.writes[0].create.routeIds, scenario.expected);
  }
});

test("reports malformed feed and timeout failures", async () => {
  const collection = createCollection({
    env: { ALERT_URL: "https://example.test/malformed,https://example.test/timeout" },
    fetch: async (url) => {
      if (url.endsWith("timeout")) throw new Error("download timed out");
      return new Response("invalid protobuf");
    },
  });
  const result = await collection.collect();
  assert.equal(result.status, "failed");
  assert.equal(result.failedFeeds, 2);
  assert.match(result.feeds[1].error, /timed out/);
  assert.equal(collection.publications(), 0);
});

test("propagates connection errors before contacting sources", async () => {
  const collection = createCollection({
    failDatabase: true,
    fetch: async () => assert.fail("sources must not be fetched without a database connection"),
  });
  await assert.rejects(collection.collect(), /database unavailable/);
});

test("collection endpoint supports Coolify POST and surfaces partial or failed feeds", async () => {
  let calls = 0;
  const route = loadTypeScript("app/api/get_alerts/route.ts", {
    env: { CRON_SECRET: "test-only-secret" },
    mocks: {
      "@/tasks/fetchAlerts": { fetchAndProcessAlerts: async () => {
        calls++;
        return { success: false, status: "partial", failedFeeds: 1, successfulFeeds: 1 };
      } },
      "@/lib/connection-manager": {
        connectionManager: { connect: async () => {}, isHealthy: () => true },
      },
    },
  });
  assert.equal(route.GET, route.POST);
  const rejected = await route.POST(new Request("http://localhost/api/get_alerts", { method: "POST" }));
  assert.equal(rejected.status, 401);
  assert.equal(calls, 0);
  const response = await route.POST(new Request("http://localhost/api/get_alerts", {
    method: "POST",
    headers: { authorization: "Bearer test-only-secret" },
  }));
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.equal(result.status, "partial");
  assert.equal(result.failedFeeds, 1);
  assert.equal(result.success, false);
});

test("collection endpoint refuses to run when the cron secret is missing", async () => {
  const route = loadTypeScript("app/api/get_alerts/route.ts", {
    mocks: {
      "@/tasks/fetchAlerts": { fetchAndProcessAlerts: async () => assert.fail("collection must remain disabled") },
      "@/lib/connection-manager": {
        connectionManager: {
          connect: async () => assert.fail("no database access without a configured cron secret"),
          isHealthy: () => false,
        },
      },
    },
  });
  const response = await route.POST(new Request("http://localhost/api/get_alerts", { method: "POST" }));
  assert.equal(response.status, 503);
});
