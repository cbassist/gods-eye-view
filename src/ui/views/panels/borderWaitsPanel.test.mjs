import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import BorderWaitsPanel from './BorderWaitsPanel.vue';
import { parseCaltransBorderWaits } from '../../../sources/caltransBorderWaits.js';
import { html } from '../../../sources/caltransBorderWaits.fixture.mjs';
test('native panel separates Caltrans published waits from CBP with source clocks and warnings', async t => {
  const pinia = createPinia();
  const store = useBorderWaitsStore(pinia);
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(BorderWaitsPanel).use(pinia); app.mount(host);
  t.after(() => { app.unmount(); host.remove(); });
  store.publish({ open: true, data: { lanes: [], southbound: parseCaltransBorderWaits(html, Date.parse('2026-11-14T19:21:00Z')) }, cameras: [] });
  await nextTick();
  const panel = document.querySelector('.border-waits');
  assert.match(panel.textContent, /Southbound into Mexico/);
  assert.match(panel.textContent, /I-805/);
  assert.match(panel.textContent, /No Wait/);
  assert.match(panel.textContent, /11:45 AM/);
  assert.match(panel.textContent, /Last updated 11\/14\/2026 11:20am/);
  assert.match(panel.textContent, /Pacific time assumed/);
  assert.doesNotMatch(panel.textContent, /Southbound wait unavailable/);
  for (const [time, label] of [
    ['2026-11-14T19:10:00Z', 'Future timestamp'],
    ['2026-11-14T19:35:00Z', 'Expired'],
    ['2026-11-14T22:00:00Z', 'Stale'],
  ]) {
    store.publish({ open: true, data: { lanes: [], southbound: parseCaltransBorderWaits(html, Date.parse(time)) }, cameras: [] });
    await nextTick();
    assert.ok(panel.querySelector('.border-southbound').textContent.includes(label));
  }
  store.publish({ open: true, data: { lanes: [], southbound: { sourceStatus: 'unavailable', routes: [] } }, cameras: [] });
  await nextTick();
  assert.match(panel.querySelector('.border-southbound').textContent, /Caltrans unavailable or refresh failed/);
});
import CommandDockView from '../CommandDockView.vue';
import { useBorderWaitsStore } from '../../stores/borderWaits.js';

test('the native LOCATION entry invokes its connected border-panel owner', async t => {
  const pinia = createPinia();
  const store = useBorderWaitsStore(pinia);
  let calls = 0;
  store.connect({ show() { calls++; } });
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(CommandDockView).use(pinia);
  app.mount(host);
  t.after(() => { app.unmount(); host.remove(); });
  const entry = host.querySelector('#san-ysidro-waits-open');
  assert.ok(entry);
  assert.equal(entry.closest('.location-city-row') !== null, true);
  assert.equal(entry.closest('#location-pills') === null, true, 'regional action is not a city selection');
  entry.click(); await nextTick();
  assert.equal(calls, 1);
});

test('public camera links distinguish dated verified playback from decode failure without embeds', async t => {
  const pinia = createPinia();
  const store = useBorderWaitsStore(pinia);
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(BorderWaitsPanel).use(pinia);
  app.mount(host);
  t.after(() => { app.unmount(); host.remove(); });
  store.publish({ open: true, data: { lanes: [] }, cameras: [] });
  await nextTick();
  const panel = document.querySelector('.border-waits');
  for (const [url, label, disclaimer] of [
    ['https://vi-ads.com/bordertrafficcams/', 'Visual Impact', 'Video decoded on 2026-11-14, then failed; continuous playback unreliable.'],
    ['https://webcamsdemexico.com/webcam/tijuana/', 'NewCity · Webcams de México', 'Video playback verified on 2026-11-14; upstream Ready Lane coverage unverified.'],
  ]) {
    const link = panel.querySelector(`a[href="${url}"]`);
    assert.ok(link, `missing public source link: ${label}`);
    assert.equal(link.textContent, label);
    assert.equal(link.target, '_blank');
    assert.deepEqual(link.rel.split(/\s+/).sort(), ['noopener', 'noreferrer']);
    assert.ok(link.parentElement.textContent.includes(disclaimer));
  }
  assert.ok(panel.textContent.includes('External services may require a subscription. Dated playback observations do not guarantee current playback or full coverage. No third-party video is embedded. Public traffic aggregates only; no individual tracking.'));
  assert.doesNotMatch(panel.textContent, /no decoded frames observed|Coverage and playback are not verified here/);
  assert.equal(panel.querySelectorAll('iframe, video, embed, object, source, img').length, 0);
  assert.doesNotMatch(panel.innerHTML, /NaPmg3IcLu4|live\.jpg|vi-ads\.com[^" ]*\.(?:jpg|m3u8|mp4)/);
});

test('native panel shows zero, closure, timestamps, warmup and external-only video links', async t => {
  const pinia = createPinia();
  const store = useBorderWaitsStore(pinia);
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(BorderWaitsPanel).use(pinia); app.mount(host);
  t.after(() => { app.unmount(); host.remove(); });
  let closed = false; store.connect({ close() { closed = true; } });
  store.publish({ open: true, data: { sourceStatus: 'available', lanes: [
    { id: 'a', label: 'Vehicles · Standard', status: 'reported', minutes: 0, lanesOpen: 2, reportedAt: '2026-11-14T18:00:00Z', freshness: 'fresh', forecast: { observations: 1 } },
    { id: 'b', label: 'PedWest · Standard', status: 'closed', minutes: null, lanesOpen: null, reportedAt: null, freshness: 'unknown' },
  ] }, cameras: [] });
  await nextTick();
  const panel = document.querySelector('.border-waits');
  assert.match(panel.textContent, /0 min last reported/);
  assert.match(panel.textContent, /Closed/); assert.match(panel.textContent, /2026-11-14T18:00:00Z/);
  assert.match(panel.textContent, /30-minute forecast unavailable/); assert.match(panel.textContent, /Queue length unavailable/);
  assert.equal(panel.querySelectorAll('iframe, video').length, 0);
  assert.equal(panel.querySelectorAll('a[href="https://bordertraffic.com/California-Baja/San-Ysidro-Tijuana.aspx"]').length, 1);
  panel.querySelector('[aria-label="Close border waits"]').click(); assert.equal(closed, true);
});
