import { msg } from '../i18n/index.js';

const statuses = {
  available: msg('Explicit realtime arrival estimates'),
  stale: msg('RTC feed expired — arrivals hidden'),
  'unknown-age': msg('RTC source age unknown — arrivals hidden'),
  'future-clock': msg('RTC source clock is in the future — arrivals hidden'),
  'static-expired': msg(
    'RTC static coverage expired or unknown — arrivals hidden',
  ),
};
const iso = (seconds) =>
  seconds ? new Date(seconds * 1000).toISOString() : null;
const pacific = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});

/** On-demand stop board owner; close/destroy abort requests and stop polling. */
export function createRtcPanel({
  publish,
  navigate = () => {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let open = false,
    data = null,
    query = '',
    busy = false,
    error = false,
    timer,
    controller,
    generation = 0,
    lastAttempt = -Infinity;
  function present() {
    const expired = data?.expiresAtMs != null && now() >= data.expiresAtMs;
    const rows =
      data?.status === 'available' && !expired
        ? data.arrivals
            .filter(
              (row) =>
                row.arrivalTime * 1000 > now() &&
                `${row.stopId} ${row.stopName} ${row.routeName} ${row.headsign || ''}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
            )
            .sort((a, b) => a.arrivalTime - b.arrivalTime)
        : [];
    publish({
      open,
      busy,
      query,
      error,
      status: error
        ? msg('RTC refresh failed — arrivals unavailable')
        : statuses[expired ? 'stale' : data?.status] ||
          msg('Load RTC arrivals for personal local use'),
      rows: rows.slice(0, 50).map((row) => ({
        ...row,
        arrivalIso: iso(row.arrivalTime),
        arrivalLabel: pacific.format(row.arrivalTime * 1000),
        tripTime: iso(row.tripTimestamp),
      })),
      total: rows.length,
      feedTime: iso(data?.feedTimestamp),
      age: data?.feedTimestamp
        ? Math.floor(now() / 1000 - data.feedTimestamp)
        : null,
      staticVersion: data?.staticProvenance?.feed_version,
      staticValidated: data?.staticProvenance?.validatedAtMs
        ? new Date(data.staticProvenance.validatedAtMs).toISOString()
        : null,
    });
  }
  async function refresh() {
    if (!open || busy || now() - lastAttempt < 60000) return;
    lastAttempt = now();
    busy = true;
    error = false;
    controller = new AbortController();
    const token = generation;
    present();
    try {
      const response = await fetchImpl('/api/rtc-arrivals', {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(45000),
        ]),
        credentials: 'omit',
      });
      if (!response.ok) throw new Error('RTC unavailable');
      const result = await response.json();
      if (!Array.isArray(result.arrivals))
        throw new Error('Invalid RTC response');
      if (token === generation) data = result;
    } catch {
      if (token === generation) {
        data = null;
        error = true;
      }
    } finally {
      if (token === generation) {
        busy = false;
        present();
      }
    }
  }
  function close() {
    open = false;
    generation++;
    controller?.abort();
    busy = false;
    data = null;
    if (timer != null) clearIntervalImpl(timer);
    timer = null;
    lastAttempt = -Infinity;
    present();
  }
  present();
  return {
    async show() {
      if (open) return;
      open = true;
      timer = setIntervalImpl(() => {
        present();
        if (!globalThis.document?.hidden) void refresh();
      }, 1000);
      await refresh();
    },
    refresh,
    search(value) {
      query = String(value).slice(0, 200);
      present();
    },
    focus(row) {
      if (Number.isFinite(row.latitude) && Number.isFinite(row.longitude))
        navigate(row);
    },
    close,
    destroy: close,
  };
}
