import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLibraryDataset } from './formats.js';
import { DATASET_FORMATS } from './manifest.js';
import { createLibrarySource } from './source.js';
import { LIBRARY_ENTRIES } from './catalog.js';

test('NWPS catalog loads through browser-direct source with a bounded request', async () => {
  const entries = LIBRARY_ENTRIES.filter((row) => row.source.format === 'nwps');
  assert.deepEqual(entries.map((row) => row.id).sort(), [
    'noaa-nwps-tijc1',
    'noaa-nwps-tjac1',
  ]);
  const source = createLibrarySource({
    entries,
    fetchImpl: async (url, options) => {
      assert.ok(entries.some((row) => row.source.url === url));
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.credentials, 'omit');
      return new Response(JSON.stringify(gauge()));
    },
  });
  for (const row of entries) {
    assert.equal(row.family, 'environment');
    assert.equal((await source.loadDataset(row)).features.length, 1);
  }
});

test('NWPS is an explicitly supported library format', () => {
  assert.ok(DATASET_FORMATS.includes('nwps'));
});

test('NWPS preserves missing values, zero, negatives and independent forecast time', async () => {
  for (const missing of [null, undefined, '', -999, -9999]) {
    const payload = gauge();
    payload.status.observed.secondary = missing;
    payload.status.observed.primary = 0;
    payload.status.forecast = {
      primary: -0.5,
      primaryUnit: 'ft',
      secondary: 0,
      secondaryUnit: 'cfs',
      validTime: '2026-11-15T00:00:00Z',
    };
    const p = (await load(payload)).features[0].properties;
    assert.equal(p.observed.flow, null);
    assert.equal(p.observed.flowCfs, null);
    assert.equal(p.observed.stage, 0);
    assert.equal(p.forecast.stage, -0.5);
    assert.equal(p.forecast.flowCfs, 0);
    assert.equal(p.forecast.validTime, '2026-11-15T00:00:00Z');
    assert.match(p.Observed, /flow unavailable/);
  }
});

test('NWPS tolerates null statuses and rejects malformed/non-geographic bodies', async () => {
  const payload = gauge();
  payload.status.observed = null;
  payload.status.forecast = null;
  const p = (await load(payload)).features[0].properties;
  assert.equal(p.observed.validTime, null);
  assert.equal(p.observed.stage, null);
  assert.equal((await load({ ...gauge(), latitude: null })).features.length, 0);
  await assert.rejects(load({ observed: { data: [] } }), /not an NWPS gauge/);
});

// Synthetic API-shaped records, not bundled upstream data.
const gauge = () => ({
  lid: 'TIJC1',
  name: 'Tijuana River at International Border',
  latitude: 32.54,
  longitude: -117.03,
  status: {
    observed: {
      primary: 40.23,
      primaryUnit: 'ft',
      secondary: 0.178,
      secondaryUnit: 'kcfs',
      validTime: '2026-11-14T20:00:00Z',
    },
    forecast: {
      primary: -999,
      primaryUnit: '',
      secondary: -999,
      secondaryUnit: '',
      validTime: '0001-01-01T00:00:00Z',
    },
  },
  dataAttribution: [{ text: 'IBWC - International Boundary Water Commission' }],
});
const entry = {
  source: {
    format: 'nwps',
    url: 'https://api.water.noaa.gov/nwps/v1/gauges/tijc1',
    maxBytes: 1048576,
    maxFeatures: 1,
  },
  display: { label: 'name', fields: ['Observed', 'ObservedUTC'] },
};
async function load(payload) {
  return loadLibraryDataset(entry, async () => JSON.stringify(payload));
}
test('NWPS latest river observation becomes a timestamped gauge, not a forecast', async () => {
  const result = await load(gauge());
  assert.equal(result.features.length, 1);
  const { geometry, properties: p } = result.features[0];
  assert.deepEqual(geometry.coordinates, [-117.03, 32.54]);
  assert.equal(p.observed.stage, 40.23);
  assert.equal(p.observed.stageUnit, 'ft');
  assert.equal(p.observed.flow, 0.178);
  assert.equal(p.observed.flowUnit, 'kcfs');
  assert.equal(p.observed.flowCfs, 178);
  assert.equal(p.observed.validTime, '2026-11-14T20:00:00Z');
  assert.equal(p.forecast.validTime, null);
  assert.equal(p.forecast.stage, null);
  assert.match(p.attribution, /IBWC/);
  assert.match(
    p.__gevDetails.join(' '),
    /40.23 ft.*0.178 kcfs.*2026-11-14T20:00:00Z/,
  );
});
