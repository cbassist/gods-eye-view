import {
  CBP_WAIT_URL,
  normalizeBorderWaits,
  createBorderHistory,
} from '../../src/sources/borderWaits.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';
import {
  CALTRANS_BORDER_URL,
  parseCaltransBorderWaits,
  ageCaltransBorderWaits,
} from '../../src/sources/caltransBorderWaits.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { providerUserAgent } from './common/userAgent.js';

/** Fixed CBP/Caltrans endpoints; shared five-minute cache and bounded history. */
export function borderWaitsProxy({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  let southbound = null;
  let southFailed = false;
  let snapshot = null;
  let fetchedAt = null;
  let nextAttempt = 0;
  let pending = null;
  let failed = false;
  const history = createBorderHistory();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 60,
    globalMax: 600,
    now,
  });

  async function refresh() {
    try {
      const signal = AbortSignal.timeout(12_000);
      const response = await fetchImpl(CBP_WAIT_URL, {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': providerUserAgent('border-waits'),
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('cbp_unavailable');
      }
      const payload = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      if (
        !Array.isArray(payload) ||
        !payload.some(
          (p) => p?.port_number === '250401' && p?.port_name === 'San Ysidro',
        )
      )
        throw new Error('invalid_cbp_payload');
      snapshot = payload.filter((p) =>
        ['250401', '250407'].includes(p?.port_number),
      );
      fetchedAt = new Date(now()).toISOString();
      history.observe(normalizeBorderWaits(snapshot, now()), now());
      failed = false;
    } catch {
      failed = true;
    } finally {
      nextAttempt = now() + 5 * 60_000;
    }
  }

  async function refreshSouthbound() {
    try {
      const signal = AbortSignal.timeout(12_000);
      const response = await fetchImpl(CALTRANS_BORDER_URL, {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'text/html',
          'User-Agent': providerUserAgent('border-waits'),
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('caltrans_unavailable');
      }
      const html = await readResponseTextCapped(response, 128 * 1024, signal);
      southbound = {
        ...parseCaltransBorderWaits(html, now()),
        fetchedAt: new Date(now()).toISOString(),
      };
      southFailed = false;
    } catch {
      southFailed = true;
    }
  }

  async function handler(req, res) {
    const json = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    if ((req.url ?? '').split('?')[0] !== '/san-ysidro')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    if (pending || now() >= nextAttempt) {
      pending ??= Promise.all([refresh(), refreshSouthbound()]).finally(() => {
        pending = null;
      });
      await pending;
    }
    const lanes = normalizeBorderWaits(snapshot ?? [], now()).map((lane) => ({
      ...lane,
      forecast: history.forecast(lane, now(), !failed),
    }));
    return json(200, {
      source: 'U.S. Customs and Border Protection',
      sourceUrl: CBP_WAIT_URL,
      fetchedAt,
      checkedAt: new Date(now()).toISOString(),
      sourceStatus: failed
        ? snapshot
          ? 'cached-refresh-failed'
          : 'unavailable'
        : 'available',
      direction: 'northbound',
      southbound: ageCaltransBorderWaits(southbound, now(), southFailed) ?? {
        direction: 'southbound',
        source: 'Caltrans',
        sourceUrl: CALTRANS_BORDER_URL,
        sourceStatus: 'unavailable',
        status: 'unavailable',
        fetchedAt: null,
        publishedAt: null,
        routes: [],
      },
      queueLength: null,
      lanes,
    });
  }
  const install = ({ middlewares }) => {
    middlewares.use('/api/border-waits', handler);
  };
  return {
    name: 'border-waits',
    configureServer: install,
    configurePreviewServer: install,
  };
}
