#!/usr/bin/env node
/** San Ysidro API integration gate, no socket, credentials or running app needed.
 * node scripts/qa-san-ysidro.mjs
 * Runs the actual Vite middleware stack with a synthetic public-schema fixture,
 * then a real CBP fetch (honest unavailable is accepted, never invented waits).
 * Does not modify or stop the app on 4173. Synthetic reports stay in this process.
 */
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { createServer } from 'vite';
import { borderWaitsProxy } from '../server/providers/borderWaits.js';
import { apiNotFoundPlugin } from '../server/standalone/api-not-found.js';

async function exercise(options) {
  const server = await createServer({
    configFile: false,
    envFile: false,
    publicDir: false,
    cacheDir: 'node_modules/.vite-border-api-qa',
    plugins: [borderWaitsProxy(options), apiNotFoundPlugin()],
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const req = Object.assign(
      new Readable({
        read() {
          this.push(null);
        },
      }),
      {
        url: '/api/border-waits/san-ysidro',
        method: 'GET',
        headers: { host: 'localhost:4175' },
        socket: { remoteAddress: '127.0.0.1' },
      },
    );
    const chunks = [];
    const headers = new Map();
    const res = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    res.setHeader = (name, value) => {
      headers.set(name.toLowerCase(), value);
    };
    res.getHeader = (name) => headers.get(name.toLowerCase());
    res.writeHead = (status, values) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(values)) res.setHeader(k, v);
    };
    await new Promise((resolve, reject) => {
      res.on('finish', resolve);
      res.on('error', reject);
      server.middlewares(req, res, reject);
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('content-type'), 'application/json');
    const payload = JSON.parse(Buffer.concat(chunks));
    assert.equal(payload.lanes.length, 7);
    assert.equal(payload.queueLength, null);
    assert.ok(payload.lanes.every((lane) => lane.forecast.minutes === null));
    return payload;
  } finally {
    await server.close();
  }
}

const now = Date.parse('2026-11-14T18:05:00Z');
const fixture = await exercise({
  now: () => now,
  fetchImpl: async () =>
    new Response(
      JSON.stringify([
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
              lanes_open: '1',
            },
          },
        },
      ]),
    ),
});
assert.equal(fixture.lanes[0].minutes, 0);
assert.equal(fixture.lanes[0].status, 'reported');
console.log(
  'PASS: Vite API fixture preserves zero and all seven separate lane rows; forecast warmup unavailable.',
);
const real = await exercise();
console.log(
  JSON.stringify(
    {
      realUpstream: real.sourceStatus,
      fetchedAt: real.fetchedAt,
      lanes: real.lanes.map(({ id, status, reportedAt }) => ({
        id,
        status,
        reportedAt,
      })),
    },
    null,
    2,
  ),
);
console.log(
  'PASS: actual API exercised; real upstream availability shown above.',
);
