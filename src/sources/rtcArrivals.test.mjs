import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import * as rtc from './rtcArrivals.js';

// Entirely synthetic GTFS-RT wire fixtures; no operator payloads are bundled.
const NOW = 1800000000000;
const staticData = {
  trips: new Map([
    ['trip', { route_id: 'route', trip_headsign: 'Synthetic destination' }],
  ]),
  stops: new Map([
    [
      'stop',
      { stop_name: 'Synthetic stop', stop_lat: '36.1', stop_lon: '-115.1' },
    ],
  ]),
  routes: new Map([
    ['route', { route_short_name: 'S', route_long_name: 'Synthetic route' }],
  ]),
  provenance: {
    url: 'https://example.invalid/static.zip',
    version: 'synthetic',
  },
};
function fixture({
  tripRelationship,
  stopRelationship,
  deleted,
  arrival = NOW / 1000 + 120,
  stopId = 'stop',
  tripId = 'trip',
  incrementality = 0,
  entities = 1,
  stops = 1,
  delayOnly = false,
} = {}) {
  const p = new PbfWriter();
  p.writeMessage(1, (_, h) => {
    h.writeStringField(1, '2.0');
    h.writeVarintField(2, incrementality);
    h.writeVarintField(3, NOW / 1000 - 30);
  });
  for (let i = 0; i < entities; i++)
    p.writeMessage(2, (_, e) => {
      e.writeStringField(1, `entity-${i}`);
      if (deleted) e.writeBooleanField(2, true);
      e.writeMessage(3, (_, u) => {
        u.writeMessage(1, (_, t) => {
          t.writeStringField(1, tripId);
          t.writeStringField(3, '20270115');
          t.writeStringField(5, 'route');
          if (tripRelationship !== undefined)
            t.writeVarintField(4, tripRelationship);
        });
        u.writeVarintField(4, NOW / 1000 - 40);
        for (let j = 0; j < stops; j++)
          u.writeMessage(2, (_, s) => {
            s.writeVarintField(1, j + 1);
            if (stopId !== null) s.writeStringField(4, stopId);
            if (stopRelationship !== undefined)
              s.writeVarintField(5, stopRelationship);
            s.writeMessage(2, (_, a) => {
              if (delayOnly) a.writeVarintField(1, 60);
              else a.writeVarintField(2, arrival);
              a.writeVarintField(3, 0);
            });
          });
      });
    });
  return p.finish();
}
const join = (options = {}, data = staticData) =>
  rtc.joinRtcArrivals(rtc.decodeRtcTripUpdates(fixture(options)), data, {
    nowMs: NOW,
    fetchedAtMs: NOW - 1000,
  });

test('filters unsupported relationships, absent joins and non-future explicit times', () => {
  for (const options of [
    { deleted: true },
    { tripRelationship: 3 },
    { tripRelationship: 7 },
    { tripRelationship: 99 },
    { stopRelationship: 1 },
    { stopRelationship: 2 },
    { stopRelationship: 99 },
    { arrival: NOW / 1000 },
    { arrival: 0 },
    { delayOnly: true },
    { tripId: 'unknown' },
    { stopId: 'unknown' },
    { stopId: null },
  ])
    assert.equal(join(options).arrivals.length, 0, JSON.stringify(options));
  assert.equal(join({}, { ...staticData, routes: {} }).arrivals.length, 0);
  assert.equal(
    join({}, { ...staticData, trips: { trip: { route_id: 'different' } } })
      .arrivals.length,
    0,
  );
});

test('rejects missing, blank, nonfinite, out-of-range and null-island coordinates', () => {
  for (const [lat, lon] of [
    [null, -115],
    ['', -115],
    [' ', -115],
    [undefined, -115],
    [false, -115],
    [Infinity, -115],
    [91, -115],
    [36, -181],
    [0, 0],
    [36, 'oops'],
  ]) {
    const data = {
      ...staticData,
      stops: { stop: { stop_lat: lat, stop_lon: lon } },
    };
    assert.equal(join({}, data).arrivals.length, 0, `${lat},${lon}`);
  }
});

test('rejects differential, malformed and over-budget protobuf without partial results', () => {
  assert.throws(
    () => rtc.decodeRtcTripUpdates(fixture({ incrementality: 1 })),
    /differential/i,
  );
  assert.throws(
    () => rtc.decodeRtcTripUpdates(new Uint8Array([10, 100, 8])),
    /protobuf/i,
  );
  assert.throws(
    () => rtc.decodeRtcTripUpdates(new Uint8Array([8, 1])),
    /protobuf/i,
  );
  assert.throws(() => rtc.decodeRtcTripUpdates(new Uint8Array()), /header/i);
  assert.throws(
    () => rtc.decodeRtcTripUpdates(new Uint8Array(8 * 1024 * 1024 + 1)),
    /limit/i,
  );
  assert.throws(
    () => rtc.decodeRtcTripUpdates(fixture({ tripId: 'a'.repeat(1025) })),
    /limit/i,
  );
  assert.throws(
    () => rtc.decodeRtcTripUpdates(fixture({ entities: 10001 })),
    /limit/i,
  );
  assert.throws(
    () => rtc.decodeRtcTripUpdates(fixture({ stops: 1001 })),
    /limit/i,
  );
  assert.throws(
    () => rtc.decodeRtcTripUpdates(fixture({ entities: 101, stops: 1000 })),
    /limit/i,
  );
});

test('source coalesces reads, caches for at least 60 seconds, and recomputes age/future filtering', async () => {
  let time = NOW;
  let calls = 0;
  const source = rtc.createRtcArrivalsSource({
    staticData,
    now: () => time,
    cacheMs: 1,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, rtc.RTC_TRIP_UPDATES_URL);
      assert.equal(options.credentials, 'omit');
      assert.ok(options.signal);
      return new Response(fixture({ arrival: NOW / 1000 + 10 }));
    },
  });
  const results = await Promise.all([source.load(), source.load()]);
  assert.equal(calls, 1);
  assert.equal(results[0].arrivals.length, 1);
  results[0].arrivals.length = 0;
  assert.equal(results[1].arrivals.length, 1);
  time += 59000;
  const cached = await source.load();
  assert.equal(calls, 1);
  assert.equal(cached.arrivals.length, 0);
  assert.equal(cached.snapshotAgeSeconds, 89);
  assert.equal(cached.fetchedAtMs, NOW);
  time += 1000;
  await source.load();
  assert.equal(calls, 2);
});

test('source bounds body consumption and errors without retry storms or stale-success fallback', async () => {
  let calls = 0;
  let time = NOW;
  const source = rtc.createRtcArrivalsSource({
    staticData,
    now: () => time,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response(fixture());
      return new Response('oversize', {
        headers: { 'content-length': String(rtc.RTC_MAX_BYTES + 1) },
      });
    },
  });
  await source.load();
  time += 60000;
  await assert.rejects(source.load(), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(source.load(), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(calls, 2);
});

test('deadline covers stalled fetch and body even if transport ignores abort', async () => {
  for (const fetchImpl of [
    () => new Promise(() => {}),
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        }),
      ),
  ]) {
    const source = rtc.createRtcArrivalsSource({
      staticData,
      fetchImpl,
      timeoutMs: 10,
    });
    await assert.rejects(source.load(), { name: 'TimeoutError' });
  }
});

test('consumer cancellation does not cancel another coalesced consumer', async () => {
  let finish;
  let calls = 0;
  const source = rtc.createRtcArrivalsSource({
    staticData,
    now: () => NOW,
    fetchImpl: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const controller = new AbortController();
  const first = source.load({ signal: controller.signal });
  const second = source.load();
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  finish(new Response(fixture()));
  assert.equal((await second).arrivals.length, 1);
  assert.equal(calls, 1);
  await assert.rejects(source.load({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('timeout overrides cannot exceed 20 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = rtc.createRtcArrivalsSource({
    staticData,
    timeoutMs: 60000,
    fetchImpl: () => new Promise(() => {}),
  });
  const pending = assert.rejects(source.load(), { name: 'TimeoutError' });
  t.mock.timers.tick(20000);
  await pending;
});

test('streamed bodies without Content-Length are capped', async () => {
  let cancelled = false;
  const source = rtc.createRtcArrivalsSource({
    staticData,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(rtc.RTC_MAX_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(source.load(), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, true);
});

test('HTTP failures retain status, cool down, then recover', async () => {
  let time = NOW;
  let calls = 0;
  const source = rtc.createRtcArrivalsSource({
    staticData,
    now: () => time,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response('Unavailable', { status: 503 })
        : new Response(fixture());
    },
  });
  await assert.rejects(source.load(), { status: 503 });
  await assert.rejects(source.load(), { status: 503 });
  assert.equal(calls, 1);
  time += 60000;
  assert.equal((await source.load()).arrivals.length, 1);
  assert.equal(calls, 2);
});

test('rejects conflicting route joins and accepts unscheduled explicit arrivals', () => {
  assert.equal(
    join(
      {},
      {
        ...staticData,
        trips: { trip: { route_id: 'other' } },
        routes: { other: {} },
      },
    ).arrivals.length,
    0,
  );
  assert.equal(
    join({ tripRelationship: 2, stopRelationship: 3 }).arrivals.length,
    1,
  );
});

test('unknown fields skip safely; departures and delay-only events never become arrivals', () => {
  const p = new PbfWriter();
  p.writeMessage(1, (_, h) => {
    h.writeStringField(1, '2.0');
  });
  p.writeMessage(2, (_, e) => {
    e.writeStringField(1, 'synthetic');
    e.writeMessage(3, (_, u) => {
      u.writeMessage(1, (_, t) => {
        t.writeStringField(1, 'trip');
      });
      u.writeMessage(2, (_, s) => {
        s.writeStringField(4, 'stop');
        s.writeMessage(3, (_, d) => {
          d.writeVarintField(2, NOW / 1000 + 10);
        });
      });
    });
    e.writeStringField(1000, 'unknown extension');
  });
  const result = rtc.joinRtcArrivals(
    rtc.decodeRtcTripUpdates(p.finish()),
    staticData,
    { nowMs: NOW },
  );
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.snapshotAgeSeconds, null);
  assert.equal(result.feedTimestamp, null);
});

test('joins explicit future arrivals to static stops, not vehicle positions', () => {
  const result = join();
  assert.equal(result.arrivals.length, 1);
  const a = result.arrivals[0];
  assert.equal(a.arrivalTime, NOW / 1000 + 120);
  assert.equal(a.stopId, 'stop');
  assert.equal(a.routeName, 'S');
  assert.equal(a.headsign, 'Synthetic destination');
  assert.deepEqual([a.longitude, a.latitude], [-115.1, 36.1]);
  assert.equal(a.tripTimestamp, NOW / 1000 - 40);
  assert.equal(a.uncertaintySeconds, 0);
  assert.equal(result.snapshotAgeSeconds, 30);
  assert.equal(result.fetchedAtMs, NOW - 1000);
  assert.equal(
    result.sourceUrl,
    'https://developer.rtcsnv.com/transitData/tripUpdates.pb',
  );
  assert.deepEqual(result.staticProvenance, staticData.provenance);
  assert.equal('vehicles' in result, false);
});
