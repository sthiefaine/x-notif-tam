const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTypeScript } = require('./helpers/load-typescript.cjs');
const { describeVehicle, nextTripDelays } = loadTypeScript('app/components/transit-vehicle-state.ts', { mocks: { './transit-state': loadTypeScript('app/components/transit-state.ts') } });
const now = Date.parse('2026-11-08T15:00:00Z');
const base = { id: 'v', routeId: '1', lat: 43.6, lon: 3.9, timestamp: new Date(now - 20000).toISOString(), freshness: 'fresh', ageSeconds: 20 };
const stop = { id: 's', name: 'Comédie', lat: 43.6, lon: 3.9, routeIds: ['1'] };
test('stale positions suppress both movement and prolonged-stop claims', () => {
  const value = { ...base, speedMps: 4, prolongedStop: { state: 'prolonged', observedSeconds: 300 } };
  assert.equal(describeVehicle(value, now + 100000, stop, 500).kind, 'stale');
});
test('a target stop and default STOPPED_AT without a sequence do not prove a stop', () => {
  assert.equal(describeVehicle({ ...base, currentStatus: 'STOPPED_AT' }, now, stop).kind, 'unknown');
  assert.equal(describeVehicle({ ...base, currentStatus: 'STOPPED_AT', stopSequence: 3 }, now, stop).kind, 'at_stop');
  assert.equal(describeVehicle({ ...base, currentStatus: 'STOPPED_AT', stopSequence: 3, lat: 43.7 }, now, stop).kind, 'unknown');
});
test('measured speed can show movement or a normal stop, never an invented cause', () => {
  assert.equal(describeVehicle({ ...base, speedMps: 5 }, now, stop).kind, 'moving');
  assert.equal(describeVehicle({ ...base, speedMps: 0 }, now, stop).kind, 'at_stop');
  assert.equal(describeVehicle({ ...base, speedMps: 999 }, now, stop).kind, 'unknown');
  assert.equal(describeVehicle(base, now, stop, 179).kind, 'unknown');
  assert.equal(describeVehicle(base, now, stop, 180).kind, 'delay');
});
test('the next fresh forecast takes precedence over a worse distant forecast', () => {
  const arrival = (minutes, delay, seconds = 10) => ({ id: String(minutes), tripId: 't', stopId: 's', routeId: '1', freshness: 'fresh', timestamp: new Date(now - seconds * 1000).toISOString(), arrivalTime: new Date(now + minutes * 60000).toISOString(), delay });
  assert.equal(nextTripDelays([arrival(15, 900), arrival(2, 0)], now).get('t'), 0);
  assert.equal(nextTripDelays([arrival(2, 900, 100), arrival(5, 180)], now).get('t'), 180);
  assert.equal(nextTripDelays([arrival(35, 900)], now).has('t'), false);
});
