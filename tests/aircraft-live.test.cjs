const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const baseTime = Date.parse("2026-11-08T16:00:00Z");
function module(options = {}) {
  return loadTypeScript("lib/aircraft/live.ts", { globals: { AbortController, fetch: options.fetcher || (() => assert.fail("unexpected real network")), ...options.globals } });
}
function helicopter(overrides = {}) {
  return { hex: "a1b2c3", category: "A7", t: "EC45", flight: "TEST123 ", type: "adsb_icao",
    lat: 43.6108, lon: 3.8767, seen_pos: 5, seen: 0, alt_baro: 1200, alt_geom: 1250, gs: 80, track: 90,
    ...overrides };
}
const body = (aircraft = [helicopter()], now = baseTime) => ({ now, ac: aircraft, total: aircraft.length });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("only explicitly typed rotorcraft with an airborne position inside Montpellier are returned", () => {
  const api = module();
  const result = api.normalizeAircraft(body([
    helicopter(), helicopter({ hex: "aaaaaa", category: "A3", t: "EC45" }),
    helicopter({ hex: "bbbbbb", category: undefined, flight: "HELICOPTER" }),
    helicopter({ hex: "cccccc", lat: 44.2 }), helicopter({ hex: "dddddd", alt_baro: "ground", alt_geom: 1800 }),
    helicopter({ hex: "eeeeee", alt_baro: 0 }), helicopter({ hex: "ffffff", alt_baro: undefined }),
    helicopter({ hex: "123456", on_ground: true }), helicopter({ hex: "654321", lat: NaN }),
  ]), baseTime);
  assert.equal(result.aircraft.length, 1);
  const item = result.aircraft[0];
  assert.equal(item.id, "a1b2c3");
  assert.equal(item.kind, "helicopter");
  assert.equal(item.inAir, true);
  assert.equal(item.category, "A7");
  assert.equal(item.altitudeBarometricFeet, 1200);
  assert.equal(item.altitudeBarometricMetres, 366);
  assert.equal(Object.hasOwn(item, "heightAboveGroundMetres"), false);
  assert.equal(item.speedKmh, 148);
});

test("position age comes from source time and seen_pos, never the recent message age or receipt time", () => {
  const api = module();
  const result = api.normalizeAircraft(body([
    helicopter({ seen_pos: 40 }),
    helicopter({ hex: "aaaaaa", seen_pos: undefined, seen: 0 }),
    helicopter({ hex: "bbbbbb", seen_pos: null, seen: 0 }),
    helicopter({ hex: "cccccc", seen_pos: 120 }),
  ], baseTime - 30_000), baseTime);
  assert.equal(result.aircraft.length, 1);
  assert.equal(result.aircraft[0].ageSeconds, 70);
  assert.equal(result.aircraft[0].freshness, "stale");
  assert.equal(result.aircraft[0].timestamp, new Date(baseTime - 70_000).toISOString());
});

test("seconds and millisecond envelopes are accepted while future or undated envelopes are rejected", () => {
  const api = module();
  const seconds = api.normalizeAircraft(body([helicopter()], baseTime / 1000), baseTime);
  assert.equal(seconds.sourceTimestamp, baseTime);
  for (const payload of [{ ac: [] }, { now: baseTime + 31_000, ac: [] }, { now: baseTime, error: "not a feed" }]) {
    assert.throws(() => api.normalizeAircraft(payload, baseTime), /Invalid aircraft/);
  }
});

test("duplicate transponders keep their newest actual position and MLAT is identified as estimated source", () => {
  const api = module();
  const result = api.normalizeAircraft(body([
    helicopter({ seen_pos: 50 }), helicopter({ seen_pos: 2, type: "mlat", lat: 43.62 }),
  ]), baseTime);
  assert.equal(result.aircraft.length, 1);
  assert.equal(result.aircraft[0].ageSeconds, 2);
  assert.equal(result.aircraft[0].positionSource, "mlat");
  assert.equal(result.aircraft[0].lat, 43.62);
});

test("one shared cache request serves concurrent users and cannot fetch more often than once per minute", async () => {
  let now = baseTime, requests = 0;
  const api = module();
  const cache = new api.AircraftCache({ now: () => now, fetcher: async (url, options) => {
    requests++;
    assert.equal(url, "https://api.adsb.lol/v2/point/43.6108/3.8767/11");
    assert.equal(options.cache, "no-store");
    assert.equal(Object.hasOwn(options.headers, "Authorization"), false);
    return new Response(JSON.stringify(body([helicopter()], now)));
  } });
  const results = await Promise.all(Array.from({ length: 30 }, () => cache.getSnapshot()));
  assert.equal(requests, 1);
  assert.equal(results.every((snapshot) => snapshot.meta.coverage === "incomplete"), true);
  now += 30_000;
  await cache.getSnapshot();
  assert.equal(requests, 1);
  now += 30_000;
  await Promise.all([cache.getSnapshot(), cache.getSnapshot()]);
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.equal(cache.snapshot().meta.lastSuccessAt, new Date(now).toISOString());
});

test("an isolated client polling every minute receives refreshed positions rather than an expired cached aircraft", async () => {
  let now = baseTime, requests = 0;
  const api = module();
  const cache = new api.AircraftCache({ now: () => now, fetcher: async () => {
    requests++;
    return new Response(JSON.stringify(body([helicopter({ seen_pos: 5 })], now)));
  } });
  for (let poll = 0; poll < 4; poll++) {
    const snapshot = await cache.getSnapshot();
    assert.equal(requests, poll + 1);
    assert.equal(snapshot.meta.status, "ready");
    assert.equal(snapshot.counts.freshHelicopters, 1);
    assert.equal(snapshot.aircraft[0].freshness, "fresh");
    assert.equal(snapshot.aircraft[0].ageSeconds, 5);
    assert.equal(snapshot.aircraft[0].timestamp, new Date(now - 5_000).toISOString());
    now += 60_000;
  }
});

test("successful empty results remain explicitly incomplete rather than proving there are no helicopters", async () => {
  const api = module();
  const cache = new api.AircraftCache({ now: () => baseTime, fetcher: async () => new Response(JSON.stringify(body([]))) });
  const snapshot = await cache.getSnapshot();
  assert.equal(snapshot.meta.status, "ready");
  assert.equal(snapshot.meta.coverage, "incomplete");
  assert.match(snapshot.meta.coverageMessage, /ne prouve pas/);
  assert.equal(snapshot.aircraft.length, 0);
  assert.equal(snapshot.meta.source.licence.name, "ODbL 1.0");
});

test("Retry-After and access refusal backoff prevent repeated upstream requests", async () => {
  for (const [status, retryAfter, expectedSeconds] of [[429, "600", 600], [403, undefined, 1800], [503, undefined, 60]]) {
    let now = baseTime, requests = 0;
    const api = module();
    const cache = new api.AircraftCache({ now: () => now, fetcher: async () => {
      requests++;
      return new Response(null, { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
    } });
    const failed = await cache.getSnapshot();
    assert.equal(failed.meta.status, "unavailable");
    assert.equal(Date.parse(failed.meta.nextUpdateAt), baseTime + expectedSeconds * 1000);
    now += (expectedSeconds - 1) * 1000;
    await cache.getSnapshot();
    assert.equal(requests, 1);
  }
});

test("upstream failure preserves dated data only until its true position age expires", async () => {
  let now = baseTime, fail = false;
  const api = module();
  const cache = new api.AircraftCache({ now: () => now, fetcher: async () => fail
    ? new Response(null, { status: 503 }) : new Response(JSON.stringify(body([helicopter()]))) });
  await cache.getSnapshot();
  fail = true;
  now += 70_000;
  await cache.getSnapshot();
  await new Promise(setImmediate);
  let snapshot = cache.snapshot();
  assert.equal(snapshot.meta.status, "stale");
  assert.equal(snapshot.aircraft[0].freshness, "stale");
  assert.equal(snapshot.aircraft[0].ageSeconds, 75);
  now += 51_000;
  snapshot = cache.snapshot();
  assert.equal(snapshot.aircraft.length, 0);
  assert.equal(snapshot.meta.lastSuccessAt, new Date(baseTime).toISOString());
});

test("a hard timeout does not allow a late upstream result to resurrect the cache", async () => {
  const timers = new Map();
  let nextTimer = 0, finish;
  const api = module();
  const cache = new api.AircraftCache({ now: () => baseTime,
    fetcher: () => new Promise((resolve) => { finish = resolve; }),
    schedule: (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    cancel: (id) => timers.delete(id),
  });
  const pending = cache.getSnapshot();
  assert.equal(timers.size, 1);
  [...timers.values()][0].callback();
  const failed = await pending;
  assert.equal(failed.meta.status, "unavailable");
  assert.match(failed.meta.error, /Délai/);
  finish(new Response(JSON.stringify(body([helicopter()]))));
  await new Promise(setImmediate);
  assert.equal(cache.snapshot().aircraft.length, 0);
  assert.equal(cache.snapshot().meta.lastSuccessAt, null);
  assert.equal(timers.size, 0);
});

test("oversized and malformed responses fail closed without fabricating a successful empty feed", async () => {
  const api = module();
  for (const response of [new Response("{}"), new Response("bad json"), new Response("too large", { headers: { "Content-Length": String(512 * 1024 + 1) } })]) {
    const cache = new api.AircraftCache({ now: () => baseTime, fetcher: async () => response });
    const snapshot = await cache.getSnapshot();
    assert.equal(snapshot.meta.status, "unavailable");
    assert.equal(snapshot.meta.lastSuccessAt, null);
    assert.equal(snapshot.aircraft.length, 0);
  }
});

test("aircraft API exposes cache metadata, attribution and conditional 304 without any database dependency", async () => {
  const api = module();
  const cache = new api.AircraftCache({ now: () => baseTime, fetcher: async () => new Response(JSON.stringify(body([]))) });
  const snapshot = await cache.getSnapshot();
  const route = loadTypeScript("app/api/live/aircraft/route.ts", { mocks: {
    "next/server": { NextResponse: { json: (value, options) => new Response(JSON.stringify(value), options) } },
    "@/lib/aircraft/live": { getAircraftSnapshot: async () => snapshot, aircraftSnapshotEtag: api.aircraftSnapshotEtag },
  } });
  const response = await route.GET({ headers: new Headers() });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.meta.zone, { lat: 43.6108, lon: 3.8767, radiusKm: 20 });
  assert.match(result.meta.source.attribution, /adsb.lol/);
  const unchanged = await route.GET({ headers: new Headers({ "If-None-Match": response.headers.get("etag") }) });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  assert.deepEqual(plain(snapshot.aircraft), []);
});
