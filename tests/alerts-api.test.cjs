const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

// Evaluate the small subset of Prisma filters used by these fixture queries.
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return value.every((filter) => matches(row, filter));
    if (key === "OR") return value.some((filter) => matches(row, filter));
    if (value === null || typeof value !== "object") return row[key] === value;
    return Object.entries(value).every(([operator, target]) => {
      const actual = row[key];
      if (operator === "contains") return actual?.includes(target) ?? false;
      if (operator === "startsWith") return actual?.startsWith(target) ?? false;
      if (operator === "endsWith") return actual?.endsWith(target) ?? false;
      if (operator === "gte") return actual != null && actual >= target;
      if (operator === "lte") return actual != null && actual <= target;
      throw new Error(`Unsupported fixture operator: ${operator}`);
    });
  });
}

function createApi(rows, { routes = [], geometries = [] } = {}) {
  const api = loadTypeScript("app/api/alerts/route.ts", {
    mocks: {
      "next/server": { NextResponse: { json: Response.json } },
      "@/lib/prisma": { prisma: {
        alert: {
          count: async ({ where }) => rows.filter((row) => matches(row, where)).length,
          findMany: async ({ where }) => rows.filter((row) => matches(row, where)),
        },
        route: { findMany: async ({ where }) => routes.filter((row) => where.id.in.includes(row.id)) },
        lineGeometry: {
          findMany: async ({ where }) => geometries.filter((row) => where.routeId.in.includes(row.routeId)),
        },
      } },
    },
  });
  return async (query) => {
    const response = await api.GET({ nextUrl: new URL(`https://example.test/api/alerts?${query}`) });
    assert.equal(response.status, 200);
    return response.json();
  };
}

test("line filters cover current, legacy and multi-line alerts without matching line 33 as line 3", async () => {
  const get = createApi([
    { id: "other", routeIds: "33" },
    { id: "current", routeIds: "3" },
    { id: "legacy", routeIds: "7-3" },
    { id: "multiple", routeIds: "7-1,7-3,7-11" },
  ]);
  const current = await get("route=3");
  assert.deepEqual(current.data.map((row) => row.id), ["current", "legacy", "multiple"]);
  assert.equal(current.pagination.totalItems, 3);
  const legacy = await get("route=7-3");
  assert.deepEqual(legacy.data.map((row) => row.id), ["current", "legacy", "multiple"]);
});

test("combining a route and active filter preserves open-ended and timed alert conditions", async () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  const get = createApi([
    { id: "open", routeIds: "33", timeStart: past, timeEnd: null },
    { id: "active", routeIds: "7-33", timeStart: past, timeEnd: future },
    { id: "ended", routeIds: "33", timeStart: past, timeEnd: past },
    { id: "upcoming", routeIds: "33", timeStart: future, timeEnd: null },
    { id: "other", routeIds: "3", timeStart: past, timeEnd: null },
  ]);
  const result = await get("route=33&active=true");
  assert.deepEqual(result.data.map((row) => row.id), ["open", "active"]);
});

test("a current feed route can use legacy line metadata without creating an undefined ID", async () => {
  const get = createApi([{ id: "current", routeIds: "33" }], {
    routes: [{ id: "7-33", shortName: "33", longName: "Ligne 33", type: 3 }],
    geometries: [{ routeId: "8-33", lineType: "bus" }],
  });
  const result = await get("route=33");
  const detail = result.data[0].routeDetails[0];
  assert.equal(detail.routeId, "33");
  assert.equal(detail.routeNumber, "33");
  assert.equal(detail.shortName, "33");
  assert.equal(detail.lineType, "bus");
});
