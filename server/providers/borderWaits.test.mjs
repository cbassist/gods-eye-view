import test from 'node:test';
import assert from 'node:assert/strict';
import { borderWaitsProxy } from './borderWaits.js';
import { html } from '../../src/sources/caltransBorderWaits.fixture.mjs';
import { CALTRANS_BORDER_URL } from '../../src/sources/caltransBorderWaits.js';

const NOW = Date.parse('2026-11-14T18:05:00Z');
const fixture = [
  {
    port_number: '250401',
    port_name: 'San Ysidro',
    date: '11/14/2026',
    port_status: 'Open',
    passenger_vehicle_lanes: {
      standard_lanes: {
        update_time: 'At 10:00 am PST',
        operational_status: 'no delay',
        delay_minutes: '0',
        lanes_open: '2',
      },
    },
  },
];
function install(options, hook = 'configureServer') {
  let handler;
  borderWaitsProxy(options)[hook]({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/border-waits');
        handler = fn;
      },
    },
  });
  return async (url = '/san-ysidro', method = 'GET', headers = {}) => {
    const res = {
      headers: {},
      writeHead(status, h) {
        this.status = status;
        this.headers = h;
      },
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        this.status ??= this.statusCode;
        this.body = JSON.parse(body);
      },
    };
    await handler(
      { url, method, headers, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return res;
  };
}
test('dev and preview share bounded fixed-endpoint cache and re-age reports', async () => {
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let calls = 0,
      now = NOW;
    const request = install(
      {
        now: () => now,
        fetchImpl: async (url, options) => {
          if (url === CALTRANS_BORDER_URL) return new Response(html);
          calls++;
          assert.equal(url, 'https://bwt.cbp.gov/api/waittimes');
          assert.equal(options.redirect, 'error');
          return new Response(JSON.stringify(fixture));
        },
      },
      hook,
    );
    const results = await Promise.all([request(), request()]);
    assert.equal(calls, 1);
    assert.equal(results[0].body.lanes[0].minutes, 0);
    assert.equal(results[0].body.lanes[0].forecast.observations, 1);
    await request();
    assert.equal(calls, 1);
    now += 2 * 60 * 60_000;
    assert.equal((await request()).body.lanes[0].status, 'stale');
  }
});
test('failure and malformed responses return honest unavailable or cached states, with cooldown', async () => {
  let now = NOW,
    calls = 0;
  const request = install({
    now: () => now,
    fetchImpl: async (url) => {
      if (url === CALTRANS_BORDER_URL) return new Response(html);
      if (calls++ === 0) return new Response(JSON.stringify(fixture));
      throw new Error('offline');
    },
  });
  const first = await request();
  now += 5 * 60_000;
  const failed = await request();
  assert.equal(failed.body.sourceStatus, 'cached-refresh-failed');
  assert.equal(failed.body.fetchedAt, first.body.fetchedAt);
  assert.equal(failed.body.lanes[0].forecast.minutes, null);
  await request();
  assert.equal(calls, 2);
  for (const body of ['{}', '[]', 'not json']) {
    const result = await install({
      now: () => NOW,
      fetchImpl: async () => new Response(body),
    })();
    assert.equal(result.body.sourceStatus, 'unavailable');
    assert.equal(
      result.body.lanes.every(
        (l) => l.status === 'unavailable' && l.minutes === null,
      ),
      true,
    );
  }
});
test('Caltrans is independently cached and failure cannot suppress CBP or reuse expectations', async () => {
  let now = Date.parse('2026-11-14T19:21:00Z');
  let calls = 0;
  const request = install({
    now: () => now,
    fetchImpl: async (url, options) => {
      if (url !== CALTRANS_BORDER_URL)
        return new Response(JSON.stringify(fixture));
      calls++;
      assert.equal(options.redirect, 'error');
      if (calls > 1) throw new Error('offline');
      return new Response(html);
    },
  });
  const first = await request('/san-ysidro?url=https://example.com');
  assert.equal(first.body.southbound.routes[0].current.text, 'No Wait');
  await request();
  assert.equal(calls, 1);
  now += 5 * 60_000;
  const second = await request();
  assert.equal(second.body.sourceStatus, 'available');
  assert.equal(second.body.southbound.sourceStatus, 'cached-refresh-failed');
  assert.equal(
    second.body.southbound.routes[0].expected[0].status,
    'unavailable',
  );
  assert.equal(calls, 2);
});

test('concurrent requests wait for both sources even when CBP finishes first', async () => {
  let release;
  const request = install({
    now: () => NOW,
    fetchImpl: async (url) => {
      if (url !== CALTRANS_BORDER_URL)
        return new Response(JSON.stringify(fixture));
      return new Promise((resolve) => {
        release = () => resolve(new Response(html));
      });
    },
  });
  const first = request();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let finished = false;
  const second = request().then((result) => {
    finished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, false);
  release();
  assert.equal((await first).body.southbound.routes.length, 2);
  assert.equal((await second).body.southbound.routes.length, 2);
});

test('Caltrans malformed, oversized and HTTP failures stay unavailable without losing CBP', async () => {
  for (const response of [
    new Response('not html'),
    new Response('x'.repeat(128 * 1024 + 1)),
    new Response('offline', { status: 503 }),
  ]) {
    const request = install({
      now: () => NOW,
      fetchImpl: async (url) =>
        url === CALTRANS_BORDER_URL
          ? response
          : new Response(JSON.stringify(fixture)),
    });
    const result = await request();
    assert.equal(result.body.sourceStatus, 'available');
    assert.equal(result.body.southbound.sourceStatus, 'unavailable');
    assert.deepEqual(result.body.southbound.routes, []);
  }
});

test('method, route and cross-origin guards never fetch', async () => {
  let calls = 0;
  const request = install({
    now: () => NOW,
    fetchImpl: async () => {
      calls++;
      throw new Error();
    },
  });
  assert.equal((await request('/san-ysidro', 'POST')).status, 405);
  assert.equal((await request('/other')).status, 404);
  assert.equal(
    (
      await request('/san-ysidro', 'GET', {
        host: 'localhost:4175',
        origin: 'https://other.example',
        'sec-fetch-site': 'cross-site',
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
});
