import { requestWithDeadline, waitForSignal } from './requestDeadline.js';
import { readResponseJsonCapped } from './httpBody.js';

// Endpoints discovered from https://cwwp2.dot.ca.gov/lane-closure.html.
// Public data, no credentials; reuse one source instance across consumers.
export const CALTRANS_LCS_URLS = Object.freeze({
  7: 'https://cwwp2.dot.ca.gov/data/d7/lcs/lcsStatusD07.json',
  11: 'https://cwwp2.dot.ca.gov/data/d11/lcs/lcsStatusD11.json',
});
export const CALTRANS_LCS_CACHE_MS = 300000;

/**
 * Create a portable D7/D11 source; load(district, { signal }) returns a snapshot.
 * Reuse this instance: at most two shared district requests, <=20 s including
 * body consumption, 32 MiB per response, no retries or automatic polling.
 * Successes AND failures are cached for >=5 min. Errors reject (never an empty
 * success or stale fallback). Caller cancellation only cancels its own wait.
 * fetchedAt is retrieval time, not upstream publication or proof of freshness.
 * schedulePhase is evaluated at retrieval; cached snapshots keep that clock.
 * Returned records are shared read-only by convention. No UI/registration here.
 */
export function createCaltransLaneClosureSource({
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheMs = CALTRANS_LCS_CACHE_MS,
  timeoutMs = 20000,
} = {}) {
  const ttl = Number.isFinite(cacheMs)
    ? Math.max(CALTRANS_LCS_CACHE_MS, cacheMs)
    : CALTRANS_LCS_CACHE_MS;
  const deadline = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(20000, timeoutMs))
    : 20000;
  const entries = new Map();
  return {
    async load(district, { signal } = {}) {
      signal?.throwIfAborted();
      const key = text(district);
      const sourceUrl = Object.hasOwn(CALTRANS_LCS_URLS, key)
        ? CALTRANS_LCS_URLS[key]
        : null;
      if (!sourceUrl) throw new Error('unsupported_caltrans_district');
      const old = entries.get(key);
      if (old && (old.pending || now() - old.fetchedAt < ttl))
        return waitForSignal(old.promise, signal);
      const entry = { pending: true, fetchedAt: now() };
      entry.promise = (async () => {
        try {
          const payload = await requestWithDeadline(
            async (requestSignal) => {
              const response = await fetchImpl(sourceUrl, {
                credentials: 'omit',
                signal: requestSignal,
              });
              if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                throw new Error(`caltrans_lcs_http_${response.status}`);
              }
              return readResponseJsonCapped(
                response,
                32 * 1024 * 1024,
                requestSignal,
              );
            },
            { timeoutMs: deadline },
          );
          entry.fetchedAt = now();
          return {
            ...normalizeCaltransLaneClosures(payload, {
              district: Number(key),
              now: entry.fetchedAt,
            }),
            sourceUrl,
            fetchedAt: entry.fetchedAt,
          };
        } finally {
          entry.pending = false;
        }
      })();
      entries.set(key, entry);
      return waitForSignal(entry.promise, signal);
    },
  };
}

// Official schema and status definitions:
// https://cwwp2.dot.ca.gov/documentation/lcs/lcs-field-description.html
const boolean = (value) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
};

const text = (value) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
const number = (value) => {
  const raw = text(value);
  return /^-?\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))
    ? Number(raw)
    : null;
};
function epoch(value) {
  const seconds = number(value);
  return Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    seconds <= 8640000000000
    ? seconds * 1000
    : null;
}
function endpoint(value = {}, prefix) {
  const lat = number(value[`${prefix}Latitude`]);
  const lon = number(value[`${prefix}Longitude`]);
  const valid =
    lat !== null &&
    lon !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0);
  return {
    coordinates: valid ? [lon, lat] : null,
    route: text(value[`${prefix}Route`]),
    county: text(value[`${prefix}County`]),
    name: text(value[`${prefix}LocationName`]),
    description: text(value[`${prefix}FreeFormDescription`]),
    nearbyPlace: text(value[`${prefix}NearbyPlace`]),
    direction: text(value[`${prefix}Direction`]),
  };
}

/**
 * Normalize official LCS records. All *At clocks are epoch milliseconds or null.
 * Source epochs are authoritative; do not parse timezone-less PST/PDT wall times.
 * Status comes only from 1097 (started), 1098 (ended), 1022 (cancelled).
 * Scheduled windows, even old ones, cannot prove activation or completion.
 */
export function normalizeCaltransLaneClosures(
  payload,
  { district, now = Date.now() } = {},
) {
  if (!Array.isArray(payload?.data)) throw new Error('invalid_caltrans_lcs');
  const rows = payload.data.filter(
    (row) =>
      row?.lcs &&
      text(row.lcs.index) &&
      row.lcs.closure &&
      typeof row.lcs.closure === 'object' &&
      row.lcs.location &&
      typeof row.lcs.location === 'object',
  );
  if (payload.data.length && !rows.length)
    throw new Error('invalid_caltrans_lcs');
  return {
    inputCount: payload.data.length,
    rejectedCount: payload.data.length - rows.length,
    records: rows.map(({ lcs }) => {
      const closure = lcs.closure;
      const started = boolean(closure.code1097?.isCode1097);
      const ended = boolean(closure.code1098?.isCode1098);
      const cancelled = boolean(closure.code1022?.isCode1022);
      const status =
        cancelled === true
          ? 'cancelled'
          : ended === true
            ? 'ended'
            : ended === false && cancelled === false && started !== null
              ? started
                ? 'active'
                : 'planned'
              : 'unknown';
      const time = closure.closureTimestamp ?? {};
      const endIndefinite =
        boolean(time.isClosureEndIndefinite) === true ||
        text(time.closureEndEpoch) === '32503708740';
      const scheduledStartAt = epoch(time.closureStartEpoch);
      const scheduledEndAt = endIndefinite ? null : epoch(time.closureEndEpoch);
      const schedulePhase =
        scheduledStartAt === null ||
        (!endIndefinite &&
          (scheduledEndAt === null || scheduledEndAt < scheduledStartAt))
          ? 'unknown'
          : now < scheduledStartAt
            ? 'future'
            : scheduledEndAt !== null && now >= scheduledEndAt
              ? 'past'
              : 'within';
      return {
        id: `caltrans-lcs:${district}:${text(lcs.index)}`,
        sourceIndex: text(lcs.index),
        district: Number(district),
        closureId: text(closure.closureID),
        logNumber: text(closure.logNumber),
        status,
        statusFlags: { started, ended, cancelled },
        schedulePhase,
        scheduledStartAt,
        scheduledEndAt,
        endIndefinite,
        recordAt: epoch(lcs.recordTimestamp?.recordEpoch),
        actualStartAt: epoch(
          closure.code1097?.code1097Timestamp?.code1097Epoch,
        ),
        actualEndAt: epoch(closure.code1098?.code1098Timestamp?.code1098Epoch),
        cancelledAt: epoch(closure.code1022?.code1022Timestamp?.code1022Epoch),
        begin: endpoint(lcs.location?.begin ?? {}, 'begin'),
        end: endpoint(lcs.location?.end ?? {}, 'end'),
        travelFlowDirection: text(lcs.location?.travelFlowDirection),
        facility: text(closure.facility),
        typeOfClosure: text(closure.typeOfClosure),
        typeOfWork: text(closure.typeOfWork),
        lanesClosed: text(closure.lanesClosed),
        geometryKind: 'endpoints-only',
        geometryLimitation:
          'Endpoints are not a road-following segment, lane geometry, or proof of full road closure.',
      };
    }),
  };
}
