import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBorderWaits,
  cbpReportTime,
  createBorderHistory,
} from './borderWaits.js';

export const NOW = Date.parse('2026-11-14T18:05:00Z');
/** Synthetic edge-case fixture using the public CBP schema; never live history. */
export function portFixture(overrides = {}) {
  return {
    port_number: '250401',
    port_name: 'San Ysidro',
    date: '11/14/2026',
    time: '10:05:00',
    port_status: 'Open',
    passenger_vehicle_lanes: {
      standard_lanes: {
        update_time: 'At 10:00 am PST',
        operational_status: 'no delay',
        delay_minutes: '0',
        lanes_open: '0',
        ...overrides,
      },
    },
  };
}

test('explicit zero survives; absent, blank, boolean and N/A never become zero', () => {
  const lane = normalizeBorderWaits([portFixture()], NOW)[0];
  assert.equal(lane.minutes, 0);
  assert.equal(lane.lanesOpen, 0);
  assert.equal(lane.status, 'reported');
  for (const delay_minutes of [null, undefined, '', ' ', false, 'N/A', '-1']) {
    const result = normalizeBorderWaits(
      [portFixture({ delay_minutes })],
      NOW,
    )[0];
    assert.equal(result.minutes, null);
    assert.equal(result.status, 'unavailable');
  }
});
test('lane time controls stale, missing and closed states independently of feed time', () => {
  const stale = normalizeBorderWaits(
    [portFixture({ update_time: 'At 8:00 am PST' })],
    NOW,
  )[0];
  assert.equal(stale.status, 'stale');
  const missing = normalizeBorderWaits(
    [portFixture({ update_time: '' })],
    NOW,
  )[0];
  assert.equal(missing.reportedAt, null);
  assert.equal(missing.status, 'unavailable');
  const closed = normalizeBorderWaits(
    [
      portFixture({
        operational_status: 'Lanes Closed',
        update_time: '',
        delay_minutes: '5',
      }),
    ],
    NOW,
  )[0];
  assert.equal(closed.status, 'closed');
  assert.equal(closed.minutes, null);
  assert.equal(closed.freshness, 'unknown');
  const port = portFixture();
  port.port_status = 'Closed';
  assert.equal(normalizeBorderWaits([port], NOW)[0].status, 'closed');
});
test('strict Pacific date/time conversion rejects bad dates, future clocks and incorrect DST', () => {
  assert.equal(
    cbpReportTime('11/14/2026', 'At 10:00 am PST', NOW),
    '2026-11-14T18:00:00.000Z',
  );
  for (const [date, clock] of [
    ['02/30/2026', 'At 10:00 am PST'],
    ['11/14/2026', 'At 11:00 am PST'],
    ['11/14/2026', 'At 10:00 am PDT'],
    ['11/14/2026', 'At 10:00 am'],
    ['11/14/2026', 'At 13:00 pm PST'],
  ])
    assert.equal(cbpReportTime(date, clock, NOW), null);
  assert.equal(
    cbpReportTime('07/14/2026', 'At Noon PDT', NOW),
    '2026-07-14T19:00:00.000Z',
  );
  assert.equal(
    cbpReportTime('11/14/2026', 'At Midnight PST', NOW),
    '2026-11-14T08:00:00.000Z',
  );
});
test('all seven lanes remain separate and CBX is excluded', () => {
  const main = portFixture();
  main.pedestrian_lanes = {
    standard_lanes: {
      ...main.passenger_vehicle_lanes.standard_lanes,
      delay_minutes: '45',
    },
  };
  const west = {
    ...main,
    port_number: '250407',
    pedestrian_lanes: {
      standard_lanes: {
        ...main.pedestrian_lanes.standard_lanes,
        delay_minutes: '20',
      },
    },
  };
  const lanes = normalizeBorderWaits(
    [main, west, { ...main, port_number: '250409' }],
    NOW,
  );
  assert.equal(lanes.length, 7);
  assert.equal(new Set(lanes.map((l) => l.id)).size, 7);
  assert.equal(lanes[3].minutes, 45);
  assert.equal(lanes[5].minutes, 20);
  assert.equal(lanes[1].status, 'unavailable');
});
test('forecast warmup deduplicates report times, requires span, expires and resets on closure', () => {
  const history = createBorderHistory();
  const lane = normalizeBorderWaits([portFixture()], NOW)[0];
  for (let i = 0; i < 10; i++) history.observe([lane], NOW);
  assert.equal(history.forecast(lane, NOW).observations, 1);
  assert.equal(history.forecast(lane, NOW).minutes, null);
  const start = NOW - 3 * 60 * 60_000;
  const warm = createBorderHistory();
  let sample;
  for (let i = 0; i < 6; i++) {
    const time = start + i * 30 * 60_000;
    sample = { ...lane, reportedAt: new Date(time).toISOString(), minutes: i };
    warm.observe([sample], time);
  }
  const end = Date.parse(sample.reportedAt);
  assert.equal(warm.forecast(sample, end).status, 'experimental');
  assert.equal(warm.forecast(sample, end).minutes, 5);
  assert.equal(warm.forecast(sample, end).validated, false);
  assert.equal(warm.forecast(sample, end, false).minutes, null);
  assert.equal(warm.forecast(sample, end + 31 * 60_000).status, 'unavailable');
  warm.observe([{ ...sample, status: 'closed' }], end);
  assert.equal(warm.forecast(sample, end).observations, 0);
  const dense = createBorderHistory();
  for (let i = 0; i < 6; i++) {
    sample = { ...lane, reportedAt: new Date(NOW + i * 60_000).toISOString() };
    dense.observe([sample], NOW + i * 60_000);
  }
  assert.equal(dense.forecast(sample, NOW + 5 * 60_000).minutes, null);
});
