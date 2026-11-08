const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadClientComponent } = require("./helpers/load-client-component.cjs");
const { default: Marker, vehicleBearing } = loadClientComponent("app/components/transit-vehicle-marker.tsx");
const render = (props) => renderToStaticMarkup(React.createElement(Marker, { color: "#005caa", ...props }));

test("zero is a real north bearing; missing or invalid bearings never invent a direction", () => {
  for (const value of [undefined, null, NaN, -1, 361, Infinity]) {
    assert.equal(vehicleBearing(value), null);
    assert.ok(!render({ bearing: value }).includes("<path"));
  }
  for (const value of [0, 90, 180, 270]) assert.ok(render({ bearing: value }).includes(`rotate(${value} 12 12)`));
  assert.equal(vehicleBearing(360), 0);
});

test("a stopped vehicle has a dot; stale positions retain no attention halo", () => {
  assert.ok(!render({ bearing: 90, stationary: true }).includes("<path"));
  assert.ok(render({ attentionColor: "#9867bb" }).includes("#9867bb"));
  const old = render({ fresh: false, attentionColor: "#9867bb" });
  assert.ok(!old.includes("#9867bb"));
  assert.ok(!old.includes('fill="#005caa"'));
});
