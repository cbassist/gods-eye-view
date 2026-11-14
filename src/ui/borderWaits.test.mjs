import test from 'node:test';
import assert from 'node:assert/strict';
import { createBorderPanel, ageBorderSnapshot } from './borderWaits.js';
import { parseCaltransBorderWaits } from '../sources/caltransBorderWaits.js';
import { html } from '../sources/caltransBorderWaits.fixture.mjs';
test('browser re-ages and invalidates southbound expectations independently', () => {
  const now = Date.parse('2026-11-14T19:21:00Z');
  const data = { lanes: [], southbound: parseCaltransBorderWaits(html, now) };
  assert.equal(
    ageBorderSnapshot(data, now + 15 * 60_000).southbound.routes[0].expected[1]
      .status,
    'expired',
  );
  assert.equal(
    ageBorderSnapshot(data, now, true).southbound.routes[0].expected[0].status,
    'unavailable',
  );
});

test('browser ages reports and suppresses forecasts after network failure', () => {
  const data = {
    lanes: [
      {
        status: 'reported',
        freshness: 'fresh',
        reportedAt: '2026-11-14T18:00:00Z',
        forecast: {
          status: 'experimental',
          minutes: 10,
          targetAt: '2026-11-14T18:30:00Z',
        },
      },
    ],
  };
  assert.equal(
    ageBorderSnapshot(data, Date.parse('2026-11-14T20:00:00Z')).lanes[0].status,
    'stale',
  );
  assert.equal(
    ageBorderSnapshot(data, Date.parse('2026-11-14T18:01:00Z'), true).lanes[0]
      .forecast.minutes,
    null,
  );
});
test('closing cancels requests and late results cannot reopen or update panel', async () => {
  let state,
    resolve,
    navigations = 0;
  const panel = createBorderPanel({
    publish: (s) => {
      state = s;
    },
    navigate: () => {
      navigations++;
    },
    fetchImpl: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  panel.show();
  assert.equal(state.busy, true);
  assert.equal(navigations, 1);
  panel.close();
  resolve(new Response(JSON.stringify({ lanes: Array(7).fill({}) })));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.open, false);
  assert.equal(state.data, null);
  panel.destroy();
});

test('Caltrans stills require registered provenance, reject proxy fallbacks and throttle refresh', async () => {
  let state,
    time = 1000,
    frameCalls = 0,
    kind = 'streetview';
  const panel = createBorderPanel({
    publish: (value) => {
      state = value;
    },
    navigate() {},
    now: () => time,
    fetchImpl: async (url) => {
      if (url === '/api/cctv/sources')
        return new Response(
          JSON.stringify({
            sources: [{ id: 'ca-d11-c214', sourceKind: 'caltrans-open-data' }],
          }),
        );
      if (url.startsWith('/api/cctv/frame/')) {
        frameCalls++;
        assert.equal(url, '/api/cctv/frame/ca-d11-c214?upstreamOnly=1');
        return new Response('fixture-image', {
          headers: { 'X-CCTV-Source': kind, 'Content-Type': 'image/jpeg' },
        });
      }
      return new Response('{}', { status: 503 });
    },
  });
  try {
    panel.show();
    await panel.loadCameras();
    assert.equal(
      state.cameras.every((c) => c.image === null),
      true,
    );
    await panel.loadCameras();
    assert.equal(frameCalls, 1);
    time += 60_000;
    kind = 'upstream-image';
    await panel.loadCameras();
    assert.match(state.cameras[0].image, /^blob:/);
    assert.equal(state.cameras[1].image, null);
    assert.equal(state.cameras[0].retrievedAt, new Date(time).toISOString());
  } finally {
    panel.destroy();
  }
  assert.equal(
    state.cameras.every((c) => c.image === null),
    true,
  );
});
