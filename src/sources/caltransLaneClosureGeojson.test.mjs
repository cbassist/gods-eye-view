import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCaltransLaneClosures,
  CALTRANS_LCS_URLS,
} from './caltransLaneClosures.js';

// Synthetic official-schema fixtures only; not captured upstream observations.
function fixture(started = true) {
  return normalizeCaltransLaneClosures(
    {
      data: [
        {
          lcs: {
            index: 'fixture-1',
            recordTimestamp: { recordEpoch: '1794672000' },
            location: {
              begin: {
                beginLongitude: '-118.2',
                beginLatitude: '34.1',
                beginRoute: 'I-5',
              },
              end: { endLongitude: '-118.3', endLatitude: '34.2' },
            },
            closure: {
              closureID: 'fixture',
              typeOfWork: 'Maintenance',
              lanesClosed: '2',
              closureTimestamp: {
                closureStartEpoch: '1794672000',
                closureEndEpoch: '1794700800',
              },
              code1097: {
                isCode1097: started,
                code1097Timestamp: { code1097Epoch: '1794672100' },
              },
              code1098: { isCode1098: false },
              code1022: { isCode1022: false },
            },
          },
        },
      ],
    },
    { district: 7, now: 1794800000000 },
  ).records[0];
}
test('planned opt-in retains provenance and offers bounded library presentation fields', async () => {
  const planned = fixture(false);
  const input = snapshot([planned]);
  const before = structuredClone(input);
  const result = await convert(input, { includePlanned: true });
  const properties = result.features[0].properties;
  for (const field of [
    'recordAt',
    'scheduledStartAt',
    'scheduledEndAt',
    'actualStartAt',
    'actualEndAt',
    'cancelledAt',
    'statusFlags',
    'endIndefinite',
    'geometryLimitation',
  ]) {
    assert.deepEqual(properties[field], planned[field]);
  }
  assert.equal(properties.sourceUrl, input.sourceUrl);
  assert.equal(properties.fetchedAt, input.fetchedAt);
  assert.match(properties.attribution, /Caltrans/);
  assert.match(properties.name, /^Planned \(not confirmed active\)/);
  assert.ok(properties.name.length <= 120);
  assert.equal(properties.__gevDetails.length, 2);
  assert.match(properties.__gevDetails[1], /Begin point only/);
  assert.ok(properties.__gevDetails.every((line) => line.length <= 80));
  assert.deepEqual(input, before);
  assert.equal(
    (await convert(input, { includePlanned: 'true' })).features.length,
    0,
  );
  const { presentLibraryProperties } = await import('../library/formats.js');
  const presented = presentLibraryProperties(properties, {
    label: 'name',
    fields: ['closureDetails', 'geometryDetails'],
  });
  assert.match(presented.name, /Planned/);
  assert.match(presented.__gevDetails[1], /Begin point only/);
});

test('rejects invalid begin geometry without falling back to end; counts truncation separately', async () => {
  const active = fixture();
  const invalid = [
    null,
    [],
    new Array(2),
    [0, 0],
    [181, 34],
    [-118, 91],
    [NaN, 34],
    [Infinity, 34],
    ['-118', 34],
    [-118, null],
  ];
  const records = invalid.map((coordinates) => ({
    ...active,
    begin: { coordinates },
  }));
  records.push(active, { ...active, id: 'second' }, fixture(false));
  const result = await convert(snapshot(records), { maxFeatures: 1 });
  assert.equal(result.features.length, 1);
  assert.equal(result.invalidGeometryCount, invalid.length);
  assert.equal(result.filteredCount, 1);
  assert.equal(result.eligibleCount, 2);
  assert.equal(result.truncatedCount, 1);
  assert.equal(result.truncated, true);
  assert.equal(
    (await convert(snapshot([active]), { maxFeatures: 0 })).features.length,
    0,
  );
  for (const maxFeatures of [-1, 1.5, Infinity, NaN, '2']) {
    await assert.rejects(
      convert(snapshot([active]), { maxFeatures }),
      /maxFeatures/,
    );
  }
  const many = Array.from({ length: 1001 }, () => active);
  assert.equal((await convert(snapshot(many))).features.length, 1000);
  assert.equal(
    (await convert(snapshot(many), { maxFeatures: 100000 })).features.length,
    1000,
  );
  await assert.rejects(convert({}), /snapshot/);
  const empty = await convert(snapshot([]));
  assert.equal(empty.features.length, 0);
  assert.equal(empty.truncated, false);
});

const snapshot = (records) => ({
  records,
  sourceUrl: CALTRANS_LCS_URLS[7],
  fetchedAt: 1794800000000,
});
const convert = async (...args) =>
  (
    await import('./caltransLaneClosureGeojson.js')
  ).caltransLaneClosuresToGeojson(...args);

test('default emits only officially active begin points, never inferred schedule activity', async () => {
  const active = fixture();
  const records = [
    fixture(false),
    ...['ended', 'cancelled', 'unknown'].map((status) => ({
      ...active,
      status,
    })),
    active,
  ];
  const result = await convert(snapshot(records));
  assert.equal(result.type, 'FeatureCollection');
  assert.equal(result.features.length, 1);
  assert.deepEqual(result.features[0].geometry, {
    type: 'Point',
    coordinates: [-118.2, 34.1],
  });
  assert.equal(result.features[0].id, active.id);
  assert.equal(result.features[0].properties.status, 'active');
  assert.equal(result.features[0].properties.schedulePhase, 'past');
  assert.equal(result.filteredCount, 4);
});
