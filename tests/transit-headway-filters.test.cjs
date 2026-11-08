const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const filters = loadTypeScript("app/components/transit-headway-filters.ts", { globals: { URLSearchParams } });
const plain = (value) => JSON.parse(JSON.stringify(value));

test("initial selection includes all seven weekdays and 28 inclusive Paris calendar dates", () => {
  assert.deepEqual(plain(filters.defaultHeadwaySelection("2026-11-08")), {
    from: "2026-10-12", to: "2026-11-08", weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: "include", schoolHolidays: "include",
  });
  assert.equal(filters.parisToday(new Date("2026-03-29T22:30:00Z")), "2026-03-30");
});

test("period presets retain civil dates over DST, Monday weeks and current months", () => {
  assert.deepEqual(plain(filters.presetDates("7", "2026-03-30")), { from: "2026-03-24", to: "2026-03-30" });
  assert.deepEqual(plain(filters.presetDates("week", "2026-11-08")), { from: "2026-11-02", to: "2026-11-08" });
  assert.deepEqual(plain(filters.presetDates("week", "2026-11-09")), { from: "2026-11-09", to: "2026-11-09" });
  assert.deepEqual(plain(filters.presetDates("month", "2026-11-08")), { from: "2026-11-01", to: "2026-11-08" });
});

test("the query sends every applied calendar filter and a canonical ISO weekday list", () => {
  const query = new URLSearchParams(filters.headwayQuery({ from: "2026-10-12", to: "2026-11-08", weekdays: [5, 1, 3], holidays: "exclude", schoolHolidays: "only" }));
  assert.equal(query.get("weekdays"), "1,3,5"); assert.equal(query.get("holidays"), "exclude"); assert.equal(query.get("schoolHolidays"), "only");
  assert.equal(query.get("from"), "2026-10-12"); assert.equal(query.get("to"), "2026-11-08");
  assert.equal(new URLSearchParams(filters.headwayQuery({ ...filters.defaultHeadwaySelection("2026-11-08"), weekdays: [] })).get("weekdays"), "");
});

test("advanced options reject future, reversed, invalid or overlong ranges without mutating applied selection", () => {
  const initial = filters.defaultHeadwaySelection("2026-11-08"), draft = { ...initial, weekdays: [...initial.weekdays] };
  draft.holidays = "only"; draft.weekdays.pop();
  assert.equal(initial.holidays, "include"); assert.equal(initial.weekdays.length, 7);
  for (const dates of [{ from: "2026-02-30", to: "2026-11-08" }, { from: "2026-11-08", to: "2026-11-09" },
    { from: "2026-11-08", to: "2026-11-01" }, { from: "2025-01-01", to: "2026-11-08" }]) {
    assert.equal(typeof filters.selectionError({ ...initial, ...dates }, "2026-11-08"), "string");
  }
  assert.equal(filters.selectionError({ ...initial, from: "2025-11-08" }, "2026-11-08"), null);
  assert.equal(typeof filters.selectionError({ ...initial, weekdays: [] }, "2026-11-08"), "string");
});

test("planned and observed defaults use independent seven-future and 28-past Paris periods", () => {
  const periods = filters.headwaySourcePeriods("2026-11-08");
  assert.deepEqual(plain(periods), { planned: { from: "2026-11-08", to: "2026-11-14" }, observed: { from: "2026-10-12", to: "2026-11-08" } });
  const changed = { ...periods, planned: { from: "2026-11-09", to: "2026-11-15" } };
  assert.deepEqual(plain(changed.observed), { from: "2026-10-12", to: "2026-11-08" });
  assert.deepEqual(plain(filters.defaultHeadwaySelection("2026-11-08", "future", "7").weekdays), [1, 2, 3, 4, 5, 6, 7]);
});

test("future presets cross DST and month ends as civil dates, while observed dates reject future", () => {
  assert.deepEqual(plain(filters.presetDates("7", "2026-10-24", "future")), { from: "2026-10-24", to: "2026-10-30" });
  assert.deepEqual(plain(filters.presetDates("week", "2026-11-09", "future")), { from: "2026-11-09", to: "2026-11-15" });
  assert.deepEqual(plain(filters.presetDates("month", "2028-02-20", "future")), { from: "2028-02-20", to: "2028-02-29" });
  const future = filters.defaultHeadwaySelection("2026-11-08", "future", "7");
  assert.equal(filters.selectionError(future, "2026-11-08", true), null);
  assert.equal(typeof filters.selectionError(future, "2026-11-08", false), "string");
  assert.equal(typeof filters.selectionError({ ...future, from: "2027-11-10", to: "2027-11-11" }, "2026-11-08", true), "string");
});
