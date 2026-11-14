import test from 'node:test';
import assert from 'node:assert/strict';
import * as source from './caltransLaneClosures.js';

test('rejects non-feed payloads and counts malformed rows instead of silently reporting empty success', () => {
  for (const payload of [null, {}, { data: {} }]) {
    assert.throws(
      () => source.normalizeCaltransLaneClosures(payload, { district: 7 }),
      /invalid_caltrans_lcs/,
    );
  }
  const result = source.normalizeCaltransLaneClosures(
    { data: [null, {}, row()] },
    { district: 7 },
  );
  assert.equal(result.inputCount, 3);
  assert.equal(result.rejectedCount, 2);
  assert.equal(result.records.length, 1);
  assert.throws(
    () => source.normalizeCaltransLaneClosures({ data: [{}] }, { district: 7 }),
    /invalid_caltrans_lcs/,
  );
  assert.equal(
    source.normalizeCaltransLaneClosures({ data: [] }, { district: 11 }).records
      .length,
    0,
  );
});

test('acquisition coalesces each district, caps concurrency at two, caches for at least five minutes', async () => {
  let now = 1794800000000;
  const calls = [];
  let active = 0,
    peak = 0;
  const client = source.createCaltransLaneClosureSource({
    now: () => now,
    cacheMs: 1,
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(options.credentials, 'omit');
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Response(JSON.stringify({ data: [row()] }));
    },
  });
  const results = await Promise.all([
    client.load(7),
    client.load('7'),
    client.load(11),
    client.load(11),
  ]);
  assert.equal(calls.length, 2);
  assert.equal(peak, 2);
  assert.equal(results[0].records.length, 1);
  assert.equal(results[0].fetchedAt, now);
  assert.equal(results[0].sourceUrl, source.CALTRANS_LCS_URLS[7]);
  assert.equal(
    results[2].sourceUrl,
    'https://cwwp2.dot.ca.gov/data/d11/lcs/lcsStatusD11.json',
  );
  now += 299999;
  assert.equal((await client.load(7)).fetchedAt, now - 299999);
  assert.equal(calls.length, 2);
  now++;
  await client.load(7);
  assert.equal(calls.length, 3);
  await assert.rejects(client.load(8), /unsupported_caltrans_district/);
});

test('rejects HTTP, invalid JSON and oversized bodies; failures are cooled down, not empty success', async () => {
  for (const makeResponse of [
    () => new Response(JSON.stringify({ data: [row()] }), { status: 503 }),
    () => new Response('<html>no</html>'),
    () =>
      new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-length': String(33 * 1024 * 1024) },
      }),
  ]) {
    let calls = 0;
    const client = source.createCaltransLaneClosureSource({
      fetch: async () => {
        calls++;
        return makeResponse();
      },
    });
    await assert.rejects(client.load(7));
    await assert.rejects(client.load(7));
    assert.equal(calls, 1);
  }
});

test('deadline covers stalled body consumption and caller abort does not cancel shared work', async () => {
  const stalled = source.createCaltransLaneClosureSource({
    timeoutMs: 10,
    fetch: async () => new Response(new ReadableStream({ start() {} })),
  });
  await assert.rejects(stalled.load(7), { name: 'TimeoutError' });
  const client = source.createCaltransLaneClosureSource({
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ data: [row()] }));
    },
  });
  const controller = new AbortController();
  const aborted = client.load(7, { signal: controller.signal });
  const shared = client.load(7);
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal((await shared).records.length, 1);
});

// Synthetic values in the official LCS JSON shape, not a captured live fixture.
function row(flags = {}) {
  return {
    lcs: {
      index: 'C5-0001-2026-11-14-07:00:00',
      recordTimestamp: { recordEpoch: '1794672000' },
      location: {
        travelFlowDirection: 'South',
        begin: {
          beginDistrict: '7',
          beginLatitude: '34.1',
          beginLongitude: '-118.2',
          beginRoute: 'I-5',
        },
        end: { endLatitude: '34.2', endLongitude: '-118.3' },
      },
      closure: {
        closureID: 'C5',
        logNumber: '1',
        lanesClosed: '2, RShoulder',
        closureTimestamp: {
          closureStartEpoch: '1794672000',
          closureEndEpoch: '1794700800',
          isClosureEndIndefinite: 'false',
        },
        code1097: { isCode1097: 'false' },
        code1098: { isCode1098: 'false' },
        code1022: { isCode1022: 'false' },
        ...flags,
      },
    },
  };
}
test('normalizes endpoint context and epoch clocks without claiming road geometry or schedule-as-status', () => {
  const result = parse(row());
  assert.equal(result.id, 'caltrans-lcs:7:C5-0001-2026-11-14-07:00:00');
  assert.equal(result.lanesClosed, '2, RShoulder');
  assert.deepEqual(result.begin.coordinates, [-118.2, 34.1]);
  assert.deepEqual(result.end.coordinates, [-118.3, 34.2]);
  assert.equal(result.begin.route, 'I-5');
  assert.equal(result.geometryKind, 'endpoints-only');
  assert.match(result.geometryLimitation, /not.*road/i);
  assert.equal(result.recordAt, 1794672000000);
  assert.equal(result.scheduledStartAt, 1794672000000);
  assert.equal(result.scheduledEndAt, 1794700800000);
  assert.equal(result.schedulePhase, 'past');
  assert.equal(result.status, 'planned');
  assert.equal(result.actualStartAt, null);
  const indefinite = row({
    closureTimestamp: {
      closureEndEpoch: '32503708740',
      isClosureEndIndefinite: 'true',
    },
  });
  assert.equal(parse(indefinite).scheduledEndAt, null);
  assert.equal(parse(indefinite).endIndefinite, true);
  const bad = row();
  bad.lcs.location.begin.beginLatitude = '';
  bad.lcs.location.end.endLongitude = '181';
  bad.lcs.recordTimestamp.recordEpoch = '9223372036854775807';
  bad.lcs.closure.closureTimestamp.closureStartEpoch = 'bad';
  assert.equal(parse(bad).begin.coordinates, null);
  assert.equal(parse(bad).end.coordinates, null);
  assert.equal(parse(bad).recordAt, null);
  assert.equal(parse(bad).scheduledStartAt, null);
  assert.equal(parse(bad).schedulePhase, 'unknown');
});

const parse = (r) =>
  source.normalizeCaltransLaneClosures(
    { data: [r] },
    { district: 7, now: 1794800000000 },
  ).records[0];

test('official flags distinguish planned, active, ended, cancelled and unknown', () => {
  assert.equal(parse(row()).status, 'planned');
  assert.equal(
    parse(row({ code1097: { isCode1097: 'true' } })).status,
    'active',
  );
  assert.equal(
    parse(
      row({ code1097: { isCode1097: true }, code1098: { isCode1098: 'true' } }),
    ).status,
    'ended',
  );
  assert.equal(
    parse(row({ code1022: { isCode1022: true } })).status,
    'cancelled',
  );
  assert.equal(parse(row({ code1098: {} })).status, 'unknown');
  assert.equal(
    parse(row({ code1097: { isCode1097: 'garbage' } })).status,
    'unknown',
  );
});
