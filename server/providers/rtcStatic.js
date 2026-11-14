import { inflateRaw, crc32 } from 'node:zlib';
import { promisify } from 'node:util';
import { parseCsvRows } from '../../src/library/formats.js';
import { readResponseBytesCapped } from '../../src/sources/httpBody.js';
import { requestWithDeadline } from '../../src/sources/requestDeadline.js';

export const RTC_STATIC_URL =
  'https://developer.rtcsnv.com/transitData/google_transit.zip';
const inflate = promisify(inflateRaw);
const MAX_ZIP = 16 * 1024 * 1024;
const MAX_TABLE = 16 * 1024 * 1024;
const TABLES = {
  'trips.txt': ['trips', 'trip_id'],
  'stops.txt': ['stops', 'stop_id'],
  'routes.txt': ['routes', 'route_id'],
  'feed_info.txt': ['feedInfo', null],
};

/** Read only bounded GTFS join tables; never extract files to disk. */
export async function parseRtcStaticZip(input) {
  const bytes = Buffer.from(input);
  const fail = () => {
    throw new Error('Invalid RTC static ZIP');
  };
  if (bytes.length < 22 || bytes.length > MAX_ZIP) fail();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt32LE(end + 4) !== 0) fail();
  const count = bytes.readUInt16LE(end + 10);
  if (count > 100 || count !== bytes.readUInt16LE(end + 8)) fail();
  let pos = bytes.readUInt32LE(end + 16);
  if (pos + bytes.readUInt32LE(end + 12) !== end) fail();
  const result = {};
  for (let index = 0; index < count; index++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(pos + 8),
      method = bytes.readUInt16LE(pos + 10);
    const checksum = bytes.readUInt32LE(pos + 16),
      size = bytes.readUInt32LE(pos + 20),
      expanded = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28),
      extra = bytes.readUInt16LE(pos + 30),
      comment = bytes.readUInt16LE(pos + 32);
    const local = bytes.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLength + extra + comment;
    if (next > end) fail();
    const name = bytes.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos = next;
    if (!Object.hasOwn(TABLES, name)) continue;
    const [key, id] = TABLES[name];
    if (
      result[key] ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      expanded > MAX_TABLE ||
      local + 30 > end ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      fail();
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    if (start + size > bytes.readUInt32LE(end + 16)) fail();
    const data = bytes.subarray(start, start + size);
    const raw =
      method === 8 ? await inflate(data, { maxOutputLength: MAX_TABLE }) : data;
    if (
      raw.length !== expanded ||
      raw.length > MAX_TABLE ||
      crc32(raw) !== checksum
    )
      fail();
    const [headers, ...rows] = parseCsvRows(raw.toString('utf8'));
    if (
      !headers ||
      new Set(headers).size !== headers.length ||
      (id && !headers.includes(id))
    )
      fail();
    const map = new Map();
    for (const cells of rows) {
      if (cells.length !== headers.length) fail();
      const row = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
      if (id && (!row[id] || map.has(row[id])))
        throw new Error('Missing or duplicate RTC GTFS ID');
      map.set(id ? row[id] : String(map.size), row);
    }
    if (!map.size) fail();
    result[key] = id ? map : map.values().next().value;
  }
  if (pos !== end || Object.values(TABLES).some(([key]) => !result[key]))
    fail();
  return result;
}

/** Daily conditional refresh in memory; failed refreshes back off, never serve stale success. */
export function createRtcStaticSource({
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  let cached,
    etag,
    modified,
    pending,
    failure,
    retryAt = 0,
    expiresAt = 0;
  return {
    async load() {
      if (now() < retryAt && failure) throw failure;
      if (cached && now() < expiresAt) return cached;
      if (!pending)
        pending = requestWithDeadline(
          async (signal) => {
            const headers = {};
            if (etag) headers['If-None-Match'] = etag;
            if (modified) headers['If-Modified-Since'] = modified;
            const response = await fetchImpl(RTC_STATIC_URL, {
              signal,
              headers,
              credentials: 'omit',
              redirect: 'error',
            });
            if (response.status === 304 && cached) {
              cached = {
                ...cached,
                provenance: { ...cached.provenance, validatedAtMs: now() },
              };
            } else {
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`RTC static HTTP ${response.status}`);
              }
              const data = await parseRtcStaticZip(
                await readResponseBytesCapped(response, MAX_ZIP, signal),
              );
              signal.throwIfAborted();
              etag = response.headers.get('etag');
              modified = response.headers.get('last-modified');
              cached = {
                ...data,
                provenance: {
                  sourceUrl: RTC_STATIC_URL,
                  fetchedAtMs: now(),
                  validatedAtMs: now(),
                  lastModified: modified,
                  ...data.feedInfo,
                },
              };
            }
            expiresAt = now() + 86400000;
            failure = null;
            return cached;
          },
          { timeoutMs: 20000 },
        )
          .catch((error) => {
            failure = error;
            retryAt = now() + 60000;
            throw error;
          })
          .finally(() => {
            pending = null;
          });
      return pending;
    },
  };
}
