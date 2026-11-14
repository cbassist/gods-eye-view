import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtcArrivalService, rtcArrivalsProxy } from './rtcArrivals.js';

test('service uses refreshed static maps, rejects stale clocks and expired static coverage', async () => {
  let now = Date.parse('2026-11-14T20:00:00Z');
  let data = { provenance: { feed_end_date: '20271231' } };
  let stamp = now / 1000;
  let builds = 0;
  const service = createRtcArrivalService({
    now: () => now,
    staticSource: { load: async () => data },
    sourceFactory: ({ staticData }) => {
      builds++;
      assert.equal(staticData, data);
      return {
        load: async () => ({
          feedTimestamp: stamp,
          arrivals: [{ arrivalTime: now / 1000 + 100 }],
        }),
      };
    },
  });
  assert.equal((await service.load()).status, 'available');
  await service.load();
  assert.equal(builds, 1);
  now += 301000;
  assert.deepEqual((await service.load()).arrivals, []);
  stamp = null;
  assert.equal((await service.load()).status, 'unknown-age');
  stamp = now / 1000 + 100;
  assert.equal((await service.load()).status, 'future-clock');
  data = { provenance: { feed_end_date: '20200101' } };
  stamp = now / 1000;
  assert.equal((await service.load()).status, 'static-expired');
  assert.equal(builds, 2);
});
test('local middleware denies non-loopback, unknown paths and non-GET without fetching', async () => {
  let handler,
    calls = 0;
  const plugin = rtcArrivalsProxy({
    service: {
      load: async () => {
        calls++;
        return { arrivals: [] };
      },
    },
  });
  plugin.configureServer({
    middlewares: {
      use(_path, fn) {
        handler = fn;
      },
    },
  });
  for (const [address, method, url, status] of [
    ['10.0.0.1', 'GET', '/', 403],
    ['127.0.0.1', 'POST', '/', 405],
    ['127.0.0.1', 'GET', '/bad', 404],
    ['127.0.0.1', 'GET', '/', 200],
  ]) {
    const res = {
      writeHead(code) {
        this.status = code;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler(
      { socket: { remoteAddress: address }, method, url, headers: {} },
      res,
    );
    assert.equal(res.status, status);
  }
  assert.equal(calls, 1);
});
