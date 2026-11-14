import { createRtcArrivalsSource } from '../../src/sources/rtcArrivals.js';
import { createRtcStaticSource } from './rtcStatic.js';

/** Local-use arrival service: no vehicle inference, no stale-success fallback. */
export function createRtcArrivalService({
  now = Date.now,
  staticSource = createRtcStaticSource(),
  sourceFactory = createRtcArrivalsSource,
} = {}) {
  let staticData, source;
  return {
    async load() {
      const latest = await staticSource.load();
      if (latest !== staticData) {
        staticData = latest;
        source = sourceFactory({ staticData, now });
      }
      const snapshot = await source.load();
      const age = snapshot.feedTimestamp
        ? now() / 1000 - snapshot.feedTimestamp
        : null;
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(now())
        .replaceAll('-', '');
      const end = staticData.provenance?.feed_end_date;
      const start = staticData.provenance?.feed_start_date;
      const status =
        !end || !/^\d{8}$/.test(end) || end < today || (start && start > today)
          ? 'static-expired'
          : age === null
            ? 'unknown-age'
            : age < -60
              ? 'future-clock'
              : age > 300
                ? 'stale'
                : 'available';
      return {
        ...snapshot,
        staticProvenance: staticData.provenance,
        status,
        snapshotAgeSeconds: age,
        expiresAtMs: snapshot.feedTimestamp
          ? (snapshot.feedTimestamp + 300) * 1000
          : null,
        arrivals: status === 'available' ? snapshot.arrivals : [],
      };
    },
  };
}

/** Development/preview endpoint restricted to local sockets for personal use. */
export function rtcArrivalsProxy({ service = createRtcArrivalService() } = {}) {
  function install(server) {
    server.middlewares.use('/api/rtc-arrivals', async (req, res) => {
      const reply = (status, data) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
      };
      if (
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
          req.socket?.remoteAddress,
        )
      )
        return reply(403, {
          error: 'RTC arrivals are for personal local use only',
        });
      if (req.headers?.['sec-fetch-site'] === 'cross-site')
        return reply(403, { error: 'Same-site requests only' });
      if (req.method !== 'GET') return reply(405, { error: 'GET required' });
      if (!['', '/'].includes(req.url))
        return reply(404, { error: 'Unknown RTC path' });
      try {
        reply(200, await service.load());
      } catch {
        reply(503, {
          error: 'RTC arrivals unavailable; static or realtime refresh failed',
        });
      }
    });
  }
  return {
    name: 'rtc-arrivals-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
