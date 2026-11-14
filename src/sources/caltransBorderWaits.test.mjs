import test from 'node:test';
import assert from 'node:assert/strict';
import * as source from './caltransBorderWaits.js';

import { html } from './caltransBorderWaits.fixture.mjs';
const now = Date.parse('2026-11-14T19:21:00Z');

test('Caltrans flags stale, future, invalid dates and expired expected values', () => {
  const result = source.parseCaltransBorderWaits(html, now + 2 * 60 * 60_000);
  assert.equal(result.status, 'stale');
  assert.equal(result.routes[0].current.status, 'stale');
  assert.equal(
    source.parseCaltransBorderWaits(html, now - 5 * 60_000).status,
    'future',
  );
  assert.equal(
    source.parseCaltransBorderWaits(
      html.replace('11/14/2026', '02/30/2026'),
      now,
    ).status,
    'unavailable',
  );
  assert.equal(
    source.parseCaltransBorderWaits(html, now + 15 * 60_000).routes[0]
      .expected[1].status,
    'expired',
  );
  assert.throws(() =>
    source.parseCaltransBorderWaits(html.replace('San Ysidro', 'Other'), now),
  );
  assert.throws(() => source.parseCaltransBorderWaits('not a table', now));
});

test('Caltrans preserves rowspan routes, categorical waits and unsorted expected targets', () => {
  assert.equal(typeof source.parseCaltransBorderWaits, 'function');
  const result = source.parseCaltransBorderWaits(html, now);
  assert.equal(result.direction, 'southbound');
  assert.equal(result.publishedAt, '2026-11-14T19:20:00.000Z');
  assert.equal(result.timezoneAssumption, 'America/Los_Angeles');
  assert.deepEqual(
    result.routes.map((r) => r.route),
    ['I-5', 'I-805'],
  );
  assert.equal(result.routes[0].current.text, 'No Wait');
  assert.equal(result.routes[0].current.minutes, null);
  assert.equal(result.routes[1].current.minutes, 0);
  assert.equal(
    result.routes[0].expected[0].targetAt,
    '2026-11-14T19:45:00.000Z',
  );
  assert.equal(
    result.routes[0].expected[1].targetAt,
    '2026-11-14T19:30:00.000Z',
  );
  assert.equal(result.routes[1].expected[0].status, 'unavailable');
});
