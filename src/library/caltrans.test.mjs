import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryEntry } from './catalog.js';
import { createLibrarySource } from './source.js';
import { validateLibraryManifest } from './manifest.js';

test('Caltrans manifests restrict fixed acquisition limits to official direct endpoints', () => {
  const entry = libraryEntry('caltrans-lcs-d7');
  for (const override of [
    { url: 'https://example.com/feed' },
    { fetch: 'proxied' },
    { cacheSeconds: 60 },
    { maxBytes: 1024 },
    { maxFeatures: 1001 },
    { query: { foo: 'bar' } },
  ]) {
    assert.equal(
      validateLibraryManifest({
        ...entry,
        source: { ...entry.source, ...override },
      }).ok,
      false,
      JSON.stringify(override),
    );
  }
});

test('generic library parser supports Caltrans probes and preserves capped partial status', async () => {
  const { loadLibraryDataset } = await import('./formats.js');
  const entry = libraryEntry('caltrans-lcs-d7');
  const result = await loadLibraryDataset(
    { ...entry, source: { ...entry.source, maxFeatures: 1 } },
    async () => JSON.stringify({ data: [row(true), row(true), row(false)] }),
  );
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.status, 'active');
  assert.equal(result.truncated, true);
});

// Synthetic official-schema fixture, not live Caltrans data.
const row = (active) => ({
  lcs: {
    index: String(active),
    location: {
      begin: {
        beginLatitude: '34.1',
        beginLongitude: '-118.2',
        beginRoute: 'I-5',
      },
    },
    closure: {
      code1097: { isCode1097: active },
      code1098: { isCode1098: false },
      code1022: { isCode1022: false },
    },
  },
});

test('Caltrans entries load active-only points through shared district source caching', async () => {
  const entries = [7, 11].map((d) => libraryEntry(`caltrans-lcs-d${d}`));
  assert.ok(entries.every(Boolean));
  let now = 1794800000000;
  const calls = [];
  const source = createLibrarySource({
    entries,
    storage: null,
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.credentials, 'omit');
      return new Response(JSON.stringify({ data: [row(true), row(false)] }));
    },
  });
  const results = await Promise.all([
    source.loadDataset(entries[0]),
    source.loadDataset(entries[0]),
    source.loadDataset(entries[1]),
  ]);
  assert.equal(calls.length, 2);
  for (const result of results) {
    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].geometry.type, 'Point');
    assert.equal(result.features[0].properties.status, 'active');
    assert.equal(result.features[0].properties.fetchedAt, now);
    assert.match(
      result.features[0].properties.__gevDetails[1],
      /Begin point only/,
    );
    assert.equal(result.truncated, false);
  }
  now += 299999;
  await source.loadDataset(entries[0]);
  assert.equal(calls.length, 2);
  now++;
  await source.loadDataset(entries[0]);
  assert.equal(calls.length, 3);
});
