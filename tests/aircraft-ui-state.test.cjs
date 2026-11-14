const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { visibleAircraftPositions } = loadTypeScript("app/components/transit-aircraft-state.ts");
const now = Date.parse("2026-11-14T19:30:00Z");
const aircraft = (seconds, overrides = {}) => ({ id: "abc123", timestamp: new Date(now - seconds * 1000).toISOString(),
  freshness: "fresh", ageSeconds: 5, ...overrides });

test("a known helicopter stays visible but becomes stale while the next minute poll completes", () => {
  const position = aircraft(5);
  assert.equal(visibleAircraftPositions([position], now)[0].freshness, "fresh");
  const waiting = visibleAircraftPositions([position], now + 60_000)[0];
  assert.ok(waiting, "do not blink off between polls");
  assert.equal(waiting.freshness, "stale");
  assert.equal(waiting.ageSeconds, 65);
  assert.equal(position.freshness, "fresh", "do not mutate the received snapshot");
});

test("positions expire after two minutes even if the server cannot be reached again", () => {
  assert.equal(visibleAircraftPositions([aircraft(120)], now).length, 1);
  assert.equal(visibleAircraftPositions([aircraft(121)], now).length, 0);
  assert.equal(visibleAircraftPositions([aircraft(5)], now + 180_000).length, 0);
});

test("invalid timestamps and excessive clock skew cannot create permanent map markers", () => {
  assert.equal(visibleAircraftPositions([aircraft(0, { timestamp: "invalid" })], now).length, 0);
  assert.equal(visibleAircraftPositions([aircraft(-31)], now).length, 0);
  const smallSkew = visibleAircraftPositions([aircraft(-5)], now)[0];
  assert.equal(smallSkew.ageSeconds, 0);
});

test("the UI cannot promote a position already marked stale by the source", () => {
  assert.equal(visibleAircraftPositions([aircraft(5, { freshness: "stale" })], now)[0].freshness, "stale");
});
