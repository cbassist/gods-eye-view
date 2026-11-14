import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtcPanel } from './rtcArrivals.js';

test('panel loads on demand, searches, expires arrivals locally and closes polling', async () => {
  let now = 1000000,
    tick,
    view,
    requests = 0,
    cleared = 0;
  const owner = createRtcPanel({
    now: () => now,
    publish: (v) => {
      view = v;
    },
    setIntervalImpl: (fn) => {
      tick = fn;
      return 1;
    },
    clearIntervalImpl: () => {
      cleared++;
    },
    fetchImpl: async () => {
      requests++;
      return Response.json({
        status: 'available',
        feedTimestamp: 1000,
        expiresAtMs: 1300000,
        arrivals: [
          {
            arrivalTime: 1010,
            stopId: 'one',
            stopName: 'Main',
            routeName: '101',
          },
          {
            arrivalTime: 1100,
            stopId: 'two',
            stopName: 'Side',
            routeName: '202',
          },
        ],
      });
    },
  });
  assert.equal(requests, 0);
  await owner.show();
  assert.equal(view.rows.length, 2);
  owner.search('side');
  assert.equal(view.rows.length, 1);
  owner.search('');
  now += 11000;
  tick();
  assert.equal(view.rows.length, 1);
  now = 1300001;
  tick();
  assert.equal(view.rows.length, 0);
  owner.close();
  assert.equal(view.open, false);
  assert.equal(cleared, 1);
  owner.destroy();
});
test('failed refresh clears old data, late responses cannot reopen closed panel', async () => {
  let resolve, view;
  const owner = createRtcPanel({
    publish: (v) => {
      view = v;
    },
    fetchImpl: () =>
      new Promise((r) => {
        resolve = r;
      }),
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
  });
  const request = owner.show();
  owner.close();
  resolve(Response.json({ status: 'available', arrivals: [] }));
  await request;
  assert.equal(view.open, false);
  assert.equal(view.rows.length, 0);
  owner.destroy();
});
