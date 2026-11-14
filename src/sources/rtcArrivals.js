import { PbfReader } from 'pbf';
import { readResponseBytesCapped } from './httpBody.js';
import { requestWithDeadline, waitForSignal } from './requestDeadline.js';

/**
 * Create a reusable, framework-free RTC arrival source with load({signal}).
 * Keep one instance per feed/static dataset; simultaneous consumers coalesce.
 * staticData contains caller-supplied trips/stops/routes Maps or ID-keyed GTFS
 * rows plus optional provenance. Acquisition (including failures) is cached
 * at least 60s. Each load rejoins against current time; no stale-success fallback.
 * Timeout is capped at 20s and includes streamed body consumption.
 * RTC data is for personal noncommercial use with notices preserved; this
 * module does not grant redistribution rights or bundle operator data.
 */
export function createRtcArrivalsSource({
  staticData,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 20000,
  cacheMs = 60000,
} = {}) {
  const deadline = Number.isFinite(timeoutMs)
    ? Math.min(20000, Math.max(1, timeoutMs))
    : 20000;
  const ttl = Number.isFinite(cacheMs) ? Math.max(60000, cacheMs) : 60000;
  let inFlight;
  let cached;
  let failure;
  let expiresAt = -Infinity;
  async function acquire() {
    const result = await requestWithDeadline(
      async (signal) => {
        const response = await fetchImpl(RTC_TRIP_UPDATES_URL, {
          signal,
          credentials: 'omit',
          headers: {
            Accept: 'application/x-protobuf, application/octet-stream',
          },
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw Object.assign(
            new Error(`RTC trip updates HTTP ${response.status}`),
            { status: response.status },
          );
        }
        const bytes = await readResponseBytesCapped(
          response,
          RTC_MAX_BYTES,
          signal,
        );
        return { feed: decodeRtcTripUpdates(bytes), fetchedAtMs: now() };
      },
      { timeoutMs: deadline },
    );
    return result;
  }
  return {
    async load({ signal } = {}) {
      signal?.throwIfAborted();
      if (!inFlight && now() >= expiresAt) {
        inFlight = acquire()
          .then(
            (value) => {
              cached = value;
              failure = null;
            },
            (error) => {
              cached = null;
              failure = error;
            },
          )
          .finally(() => {
            expiresAt = now() + ttl;
            inFlight = null;
          });
      }
      if (inFlight) await waitForSignal(inFlight, signal);
      signal?.throwIfAborted();
      if (failure) throw failure;
      return joinRtcArrivals(cached.feed, staticData, {
        nowMs: now(),
        fetchedAtMs: cached.fetchedAtMs,
      });
    },
  };
}

export const RTC_MAX_BYTES = 8 * 1024 * 1024;

// Schema-specific wire types; unknown fields are skipped within their parent.
const wires = new Map([
  [readHeader, { 1: 2, 2: 0, 3: 0 }],
  [readTrip, { 1: 2, 2: 2, 3: 2, 4: 0, 5: 2 }],
  [readEvent, { 2: 0, 3: 0 }],
  [readStop, { 1: 0, 2: 2, 4: 2, 5: 0 }],
  [readUpdate, { 1: 2, 2: 2, 4: 0 }],
  [readEntity, { 1: 2, 2: 0, 3: 2 }],
  [readFeed, { 1: 2, 2: 2 }],
]);
function fields(pbf, reader, value, end) {
  const parentEnd = pbf.messageEnd;
  pbf.messageEnd = end;
  pbf.readFields(
    (tag, target, input) => {
      const wire = wires.get(reader)[tag];
      if (!tag || (wire !== undefined && input.type !== wire))
        throw new Error('Invalid protobuf wire type');
      reader(tag, target, input);
    },
    value,
    end,
  );
  if (pbf.pos !== end) throw new Error('Invalid protobuf message boundary');
  pbf.messageEnd = parentEnd;
  return value;
}
function message(pbf, reader, value) {
  const length = pbf.readVarint();
  const end = pbf.pos + length;
  if (!Number.isSafeInteger(end) || end > pbf.messageEnd)
    throw new Error('Invalid protobuf message length');
  return fields(pbf, reader, value, end);
}
function text(pbf) {
  const start = pbf.pos;
  const length = pbf.readVarint();
  if (length > 1024) throw new Error('RTC string limit exceeded');
  if (pbf.pos + length > pbf.messageEnd)
    throw new Error('Invalid protobuf string length');
  pbf.pos = start;
  return pbf.readString();
}

export const RTC_TRIP_UPDATES_URL =
  'https://developer.rtcsnv.com/transitData/tripUpdates.pb';

function readHeader(tag, value, pbf) {
  if (tag === 1) value.version = text(pbf);
  if (tag === 2) value.incrementality = pbf.readVarint();
  if (tag === 3) value.timestamp = pbf.readVarint();
}
function readTrip(tag, value, pbf) {
  if (tag === 1) value.tripId = text(pbf);
  if (tag === 2) value.startTime = text(pbf);
  if (tag === 3) value.startDate = text(pbf);
  if (tag === 4) value.relationship = pbf.readVarint();
  if (tag === 5) value.routeId = text(pbf);
}
function readEvent(tag, value, pbf) {
  if (tag === 2) value.time = pbf.readVarint(true);
  if (tag === 3) value.uncertainty = pbf.readVarint(true);
}
function readStop(tag, value, pbf) {
  if (tag === 1) value.sequence = pbf.readVarint();
  if (tag === 2) value.arrival = message(pbf, readEvent, {});
  if (tag === 4) value.stopId = text(pbf);
  if (tag === 5) value.relationship = pbf.readVarint();
}
function readUpdate(tag, value, pbf) {
  if (tag === 1) value.trip = message(pbf, readTrip, {});
  if (tag === 2) {
    if (value.stops.length >= 1000 || ++pbf.stopCount > 100000)
      throw new Error('RTC stop limit exceeded');
    value.stops.push(message(pbf, readStop, {}));
  }
  if (tag === 4) value.timestamp = pbf.readVarint();
}
function readEntity(tag, value, pbf) {
  if (tag === 1) value.id = text(pbf);
  if (tag === 2) value.deleted = pbf.readBoolean();
  if (tag === 3) value.update = message(pbf, readUpdate, { stops: [] });
}
function readFeed(tag, value, pbf) {
  if (tag === 1) value.header = message(pbf, readHeader, {});
  if (tag === 2) {
    if (value.entities.length >= 10000)
      throw new Error('RTC entity limit exceeded');
    value.entities.push(message(pbf, readEntity, {}));
  }
}
/** Decode trip updates only; vehicle position fields are deliberately ignored. */
export function decodeRtcTripUpdates(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > RTC_MAX_BYTES)
    throw new Error('RTC body limit exceeded');
  const pbf = new PbfReader(view);
  pbf.stopCount = 0;
  const feed = fields(
    pbf,
    readFeed,
    { header: {}, entities: [] },
    view.byteLength,
  );
  if (!['1.0', '2.0'].includes(feed.header.version))
    throw new Error('Invalid RTC feed header');
  if ((feed.header.incrementality ?? 0) !== 0)
    throw new Error('RTC differential feeds are unsupported');
  return feed;
}
const timestamp = (value) =>
  Number.isSafeInteger(value) && value > 0 ? value : null;
function coordinate(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()))
    return NaN;
  return Number(value);
}
const lookup = (map, id) =>
  map instanceof Map
    ? map.get(id)
    : Object.hasOwn(map ?? {}, id)
      ? map[id]
      : undefined;

/**
 * Join explicit arrival times to caller-owned GTFS rows (Map or ID-keyed object).
 * Static trips/stops/routes use original GTFS CSV column names. Times in the
 * feed and arrival records are Unix seconds; nowMs/fetchedAtMs are milliseconds.
 * This does not interpolate delays, departures, schedules or vehicle positions.
 */
export function joinRtcArrivals(
  feed,
  staticData,
  { nowMs = Date.now(), fetchedAtMs = nowMs } = {},
) {
  const arrivals = [];
  for (const entity of feed.entities) {
    const update = entity.update;
    const trip = update?.trip;
    const row = lookup(staticData.trips, trip?.tripId);
    // Only static scheduled and frequency-based unscheduled trips are supported.
    if (
      !row ||
      entity.deleted ||
      !entity.id ||
      ![0, 2].includes(trip.relationship ?? 0)
    )
      continue;
    if (trip.routeId && trip.routeId !== row.route_id) continue;
    const route = lookup(staticData.routes, row.route_id);
    for (const stopUpdate of update.stops) {
      const stop = lookup(staticData.stops, stopUpdate.stopId);
      const arrivalTime = timestamp(stopUpdate.arrival?.time);
      if (
        !stop ||
        !route ||
        ![0, 3].includes(stopUpdate.relationship ?? 0) ||
        !arrivalTime ||
        arrivalTime <= nowMs / 1000
      )
        continue;
      const latitude = coordinate(stop.stop_lat);
      const longitude = coordinate(stop.stop_lon);
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180 ||
        (latitude === 0 && longitude === 0)
      )
        continue;
      arrivals.push({
        entityId: entity.id,
        tripId: trip.tripId,
        startDate: trip.startDate ?? null,
        startTime: trip.startTime ?? null,
        routeId: row.route_id,
        routeName:
          route.route_short_name || route.route_long_name || row.route_id,
        headsign: row.trip_headsign ?? null,
        stopId: stopUpdate.stopId,
        stopName: stop.stop_name ?? stopUpdate.stopId,
        stopSequence: stopUpdate.sequence ?? null,
        latitude,
        longitude,
        arrivalTime,
        uncertaintySeconds: stopUpdate.arrival.uncertainty ?? null,
        tripTimestamp: timestamp(update.timestamp),
      });
    }
  }
  return {
    sourceUrl: RTC_TRIP_UPDATES_URL,
    attribution: 'Regional Transportation Commission of Southern Nevada (RTC)',
    staticProvenance: staticData.provenance ?? null,
    feedTimestamp: timestamp(feed.header.timestamp),
    snapshotAgeSeconds: timestamp(feed.header.timestamp)
      ? Math.max(0, nowMs / 1000 - feed.header.timestamp)
      : null,
    fetchedAtMs,
    arrivals,
  };
}
