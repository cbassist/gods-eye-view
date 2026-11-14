import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { parseRtcStaticZip, createRtcStaticSource } from './rtcStatic.js';

function zip(files) {
  const parts = [],
    directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text),
      data = deflateRawSync(raw),
      n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    directory.push(central, n);
    offset += local.length + n.length + data.length;
  }
  const dir = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
const files = {
  'trips.txt': 'route_id,trip_id,trip_headsign\nr,t,Downtown\n',
  'routes.txt': 'route_id,route_short_name\nr,101\n',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\ns,"Main, North",36,-115\n',
  'feed_info.txt':
    'feed_version,feed_start_date,feed_end_date\nv1,20260101,20271231\n',
};
test('bounded GTFS archive preserves original columns and rejects broken archives', async () => {
  const result = await parseRtcStaticZip(zip(files));
  assert.equal(result.stops.get('s').stop_name, 'Main, North');
  assert.equal(result.trips.get('t').route_id, 'r');
  assert.equal(result.feedInfo.feed_version, 'v1');
  await assert.rejects(parseRtcStaticZip(Buffer.from('not zip')));
  await assert.rejects(
    parseRtcStaticZip(zip({ 'trips.txt': files['trips.txt'] })),
  );
  await assert.rejects(
    parseRtcStaticZip(
      zip({ ...files, 'stops.txt': 'stop_id,stop_name\ns,A\ns,B' }),
    ),
    /duplicate/i,
  );
});
test('static refresh coalesces, revalidates daily and never serves expired cache on failure', async () => {
  let now = 0,
    calls = 0;
  const source = createRtcStaticSource({
    now: () => now,
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1)
        return new Response(zip(files), { headers: { etag: 'v1' } });
      assert.equal(options.headers['If-None-Match'], 'v1');
      if (calls === 2) return new Response(null, { status: 304 });
      return new Response(null, { status: 503 });
    },
  });
  const [a, b] = await Promise.all([source.load(), source.load()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  now = 86400001;
  assert.equal((await source.load()).provenance.validatedAtMs, now);
  assert.equal(calls, 2);
  now += 86400001;
  await assert.rejects(source.load(), /503/);
  await assert.rejects(source.load(), /503/);
  assert.equal(calls, 3);
});
