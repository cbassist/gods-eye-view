import {
  BORDER_STALE_MS,
  ageCaltransBorderWaits,
} from '../sources/borderWaits.js';

export const BORDER_CAMERAS = [
  {
    id: 'ca-d11-c214',
    name: 'C214 · SB I-5 at Via De San Ysidro',
    url: 'https://cwwp2.dot.ca.gov/data/d11/cctv/image/c214sb5viadesanysidro/c214sb5viadesanysidro.jpg',
  },
  {
    id: 'ca-d11-c105',
    name: 'C105 · SB I-5 at Dairy Mart Rd',
    url: 'https://cwwp2.dot.ca.gov/data/d11/cctv/image/c105i5dairymartroad/c105i5dairymartroad.jpg',
  },
];

/** Present current age even between polls; failed refreshes suppress forecasts. */
export function ageBorderSnapshot(data, now, failed = false) {
  if (!data) return null;
  return {
    ...data,
    southbound: ageCaltransBorderWaits(data.southbound, now, failed),
    sourceStatus: failed ? 'cached-refresh-failed' : data.sourceStatus,
    lanes: data.lanes.map((lane) => {
      const time = Date.parse(lane.reportedAt);
      const stale = Number.isFinite(time) && now - time > BORDER_STALE_MS;
      const forecastExpired =
        !lane.forecast?.targetAt || now >= Date.parse(lane.forecast.targetAt);
      return {
        ...lane,
        freshness: stale ? 'stale' : lane.freshness,
        status: stale && lane.status === 'reported' ? 'stale' : lane.status,
        forecast:
          failed || stale || forecastExpired
            ? { ...lane.forecast, status: 'unavailable', minutes: null }
            : lane.forecast,
      };
    }),
  };
}

/** Demand-driven public aggregates and existing registered Caltrans stills. */
export function createBorderPanel({
  publish,
  navigate,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
}) {
  let open = false,
    busy = false,
    failed = false,
    data = null,
    timer = null,
    request = null,
    generation = 0;
  let cameras = BORDER_CAMERAS.map((camera) => ({
    ...camera,
    image: null,
    retrievedAt: null,
  }));
  let cameraRequest = null,
    cameraNextAt = 0;
  const present = () =>
    publish({
      open,
      busy,
      failed,
      data: ageBorderSnapshot(data, now(), failed),
      cameras,
    });
  async function refresh() {
    if (!open || busy) return;
    const current = generation;
    busy = true;
    request = new AbortController();
    present();
    try {
      const response = await fetchImpl('/api/border-waits/san-ysidro', {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw new Error('unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload?.lanes) || payload.lanes.length !== 7)
        throw new Error('invalid');
      if (current !== generation) return;
      data = payload;
      failed = false;
    } catch {
      if (current === generation) failed = true;
    } finally {
      if (current === generation) {
        busy = false;
        request = null;
        present();
      }
    }
  }
  function clearImages() {
    for (const camera of cameras)
      if (camera.image) URL.revokeObjectURL(camera.image);
    cameras = BORDER_CAMERAS.map((camera) => ({
      ...camera,
      image: null,
      retrievedAt: null,
    }));
  }
  async function loadCameras() {
    if (!open || cameraRequest || now() < cameraNextAt) return;
    cameraNextAt = now() + 60_000;
    const current = generation;
    const controller = (cameraRequest = new AbortController());
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
    ]);
    clearImages();
    present();
    try {
      const response = await fetchImpl('/api/cctv/sources', { signal });
      if (!response.ok) throw new Error('unavailable');
      const catalog = await response.json();
      if (current !== generation || signal.aborted) return;
      await Promise.allSettled(
        cameras.map(async (camera) => {
          if (
            !catalog.sources?.some(
              (source) =>
                source.id === camera.id &&
                source.sourceKind === 'caltrans-open-data',
            )
          )
            return;
          const frame = await fetchImpl(
            `/api/cctv/frame/${camera.id}?upstreamOnly=1`,
            {
              signal,
            },
          );
          // Existing proxy can fall back to historical Street View or synthetic art.
          if (
            !frame.ok ||
            frame.headers.get('X-CCTV-Source') !== 'upstream-image'
          ) {
            await frame.body?.cancel();
            return;
          }
          const blob = await frame.blob();
          if (current !== generation || signal.aborted) return;
          camera.image = URL.createObjectURL(blob);
          camera.retrievedAt = new Date(now()).toISOString();
        }),
      );
    } catch {
      /* The official links remain available; no substitute imagery. */
    } finally {
      if (current === generation) {
        cameraRequest = null;
        present();
      }
    }
  }
  function close() {
    open = false;
    generation++;
    request?.abort();
    cameraRequest?.abort();
    request = cameraRequest = null;
    busy = false;
    clearInterval(timer);
    timer = null;
    clearImages();
    present();
  }
  function show() {
    if (open) return;
    open = true;
    navigate();
    present();
    void refresh();
    // Re-age reports and retry through the server's shared five-minute cache.
    timer = setInterval(() => {
      present();
      void refresh();
    }, 60_000);
  }
  present();
  return { show, close, refresh, loadCameras, navigate, destroy: close };
}
