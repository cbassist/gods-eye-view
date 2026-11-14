import { msg } from '../i18n/marker.js';

/** Re-age cached reports; expired expectations never masquerade as predictions. */
export function ageCaltransBorderWaits(data, now, failed = false) {
  if (!data) return null;
  const published = Date.parse(data.publishedAt);
  const status = !Number.isFinite(published)
    ? 'unavailable'
    : published > now
      ? 'future'
      : now - published > BORDER_STALE_MS
        ? 'stale'
        : 'reported';
  return {
    ...data,
    status,
    sourceStatus: failed ? 'cached-refresh-failed' : data.sourceStatus,
    routes: data.routes.map((route) => {
      const age = (value) => {
        const target = Date.parse(value.targetAt);
        const valid = value.text === 'No Wait' || value.minutes !== null;
        const invalidTime =
          !Number.isFinite(target) ||
          Math.abs(target - published) > 12 * 60 * 60_000;
        return {
          ...value,
          status:
            !valid || invalidTime
              ? 'unavailable'
              : status !== 'reported'
                ? status
                : value.kind === 'current' && target > now
                  ? 'future'
                  : now - target > BORDER_STALE_MS
                    ? 'stale'
                    : value.kind === 'expected' && target <= now
                      ? 'expired'
                      : failed || data.sourceStatus !== 'available'
                        ? 'unavailable'
                        : 'reported',
        };
      };
      return {
        ...route,
        current: age(route.current),
        expected: route.expected.map(age),
      };
    }),
  };
}

export const CBP_WAIT_URL = 'https://bwt.cbp.gov/api/waittimes';
export const BORDER_STALE_MS = 90 * 60_000;
const HOUR = 60 * 60_000;
const laneSpecs = [
  [
    '250401',
    'passenger_vehicle_lanes',
    'standard_lanes',
    msg('Vehicles · Standard'),
  ],
  ['250401', 'passenger_vehicle_lanes', 'ready_lanes', msg('Vehicles · Ready')],
  [
    '250401',
    'passenger_vehicle_lanes',
    'NEXUS_SENTRI_lanes',
    msg('Vehicles · SENTRI'),
  ],
  [
    '250401',
    'pedestrian_lanes',
    'standard_lanes',
    msg('San Ysidro pedestrians · Standard'),
  ],
  [
    '250401',
    'pedestrian_lanes',
    'ready_lanes',
    msg('San Ysidro pedestrians · Ready'),
  ],
  ['250407', 'pedestrian_lanes', 'standard_lanes', msg('PedWest · Standard')],
  ['250407', 'pedestrian_lanes', 'ready_lanes', msg('PedWest · Ready')],
];

function count(value) {
  return (typeof value === 'number' || typeof value === 'string') &&
    /^\d+$/.test(String(value).trim()) &&
    Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
}

/** CBP's lane clock plus port date, never the retrieval/feed-generation clock.
 * Unknown zones, invalid dates, DST mismatches and future reports fail closed.
 * No previous-day rollover is guessed when CBP supplies only a time of day.
 */
export function cbpReportTime(date, clock, now = Date.now()) {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date ?? '');
  const normalized = String(clock ?? '')
    .replace(/At Noon/i, 'At 12:00 pm')
    .replace(/At Midnight/i, 'At 12:00 am');
  const c = /^At (\d{1,2}):(\d{2}) (am|pm) (PST|PDT)$/i.exec(normalized);
  if (!d || !c || +c[1] < 1 || +c[1] > 12 || +c[2] > 59) return null;
  const hour = (+c[1] % 12) + (c[3].toLowerCase() === 'pm' ? 12 : 0);
  const local = Date.UTC(+d[3], +d[1] - 1, +d[2], hour, +c[2]);
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== +d[3] ||
    check.getUTCMonth() !== +d[1] - 1 ||
    check.getUTCDate() !== +d[2]
  )
    return null;
  const ms = local + (c[4].toUpperCase() === 'PST' ? 8 : 7) * HOUR;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value]),
  );
  if (
    +parts.hour !== hour ||
    +parts.day !== +d[2] ||
    +parts.month !== +d[1] ||
    ms > now
  )
    return null;
  return new Date(ms).toISOString();
}

/** Normalize only San Ysidro and PedWest. CBX is a different crossing. */
export function normalizeBorderWaits(payload, now = Date.now()) {
  if (!Array.isArray(payload)) throw new Error('invalid_cbp_payload');
  return laneSpecs.map(([portId, group, laneId, label]) => {
    const port = payload.find(
      (p) => p?.port_number === portId && p?.port_name === 'San Ysidro',
    );
    const raw = port?.[group]?.[laneId];
    const operationalStatus = String(raw?.operational_status ?? 'Unavailable');
    const reportedAt = cbpReportTime(port?.date, raw?.update_time, now);
    const freshness = !reportedAt
      ? 'unknown'
      : now - Date.parse(reportedAt) > BORDER_STALE_MS
        ? 'stale'
        : 'fresh';
    const closed =
      /closed/i.test(operationalStatus) ||
      /closed/i.test(port?.port_status ?? '');
    const minutes = count(raw?.delay_minutes);
    const usable =
      /^(no delay|delay)$/i.test(operationalStatus) && minutes !== null;
    return {
      id: `${portId}:${group}:${laneId}`,
      portId,
      label,
      status: closed
        ? 'closed'
        : !usable || !reportedAt
          ? 'unavailable'
          : freshness === 'stale'
            ? 'stale'
            : 'reported',
      freshness,
      minutes: closed || !usable ? null : minutes,
      lanesOpen: count(raw?.lanes_open),
      reportedAt,
      reportText: [port?.date, raw?.update_time].filter(Boolean).join(' · '),
      operationalStatus,
      portStatus: port?.port_status ?? null,
      hours: port?.hours ?? null,
    };
  });
}

/** Bounded, process-local aggregate history; repeated polls never create samples. */
export function createBorderHistory() {
  const history = new Map();
  return {
    observe(lanes, now) {
      for (const lane of lanes) {
        if (lane.status !== 'reported') {
          history.delete(lane.id);
          continue;
        }
        const time = Date.parse(lane.reportedAt);
        let points = (history.get(lane.id) ?? []).filter(
          (p) => now - p.time <= 6 * HOUR,
        );
        const latest = points.at(-1);
        if (latest && time < latest.time) continue;
        if (latest && time - latest.time > BORDER_STALE_MS) points = [];
        const existing = points.find((p) => p.time === time);
        if (existing) existing.minutes = lane.minutes;
        else points.push({ time, minutes: lane.minutes });
        history.set(lane.id, points.slice(-36));
      }
    },
    forecast(lane, now, sourceAvailable = true) {
      const points = (history.get(lane.id) ?? []).filter(
        (p) => now - p.time <= 6 * HOUR,
      );
      const latest = points.at(-1);
      const available =
        sourceAvailable &&
        lane.status === 'reported' &&
        points.length >= 6 &&
        latest.time - points[0].time >= 2 * HOUR &&
        now >= latest.time &&
        now - latest.time <= 30 * 60_000 &&
        latest.time === Date.parse(lane.reportedAt);
      return {
        status: available ? 'experimental' : 'unavailable',
        minutes: available ? latest.minutes : null,
        observations: points.length,
        requiredObservations: 6,
        horizonMinutes: 30,
        method: 'persistence',
        validated: false,
        targetAt: available ? new Date(now + 30 * 60_000).toISOString() : null,
      };
    },
  };
}
