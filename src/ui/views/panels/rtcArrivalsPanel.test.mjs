import '../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import RtcArrivalsPanel from './RtcArrivalsPanel.vue';
import CommandDockView from '../CommandDockView.vue';
import { useRtcArrivalsStore } from '../../stores/rtcArrivals.js';

test('RTC board and LOCATION entry render timestamped estimates, notices and actions', async (t) => {
  const pinia = createPinia(),
    store = useRtcArrivalsStore(pinia);
  const host = document.body.appendChild(document.createElement('div'));
  let opened = 0,
    closed = 0;
  store.connect({
    show() {
      opened++;
    },
    close() {
      closed++;
    },
  });
  const app = createApp(CommandDockView).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  host.querySelector('#rtc-arrivals-open').click();
  assert.equal(opened, 1);
  store.publish({
    open: true,
    status: 'Explicit realtime arrival estimates',
    total: 1,
    feedTime: '2026-11-14T20:00:00Z',
    age: 20,
    rows: [
      {
        stopId: 's',
        stopName: 'Main',
        routeName: '101',
        arrivalIso: '2026-11-14T20:02:00Z',
        arrivalLabel: 'Nov 14, 12:02:00 PM PST',
      },
    ],
  });
  await nextTick();
  const panel = document.querySelector('#rtc-arrivals-panel');
  assert.ok(panel);
  assert.match(panel.textContent, /Main/);
  assert.match(panel.textContent, /PST/);
  assert.match(panel.textContent, /No bus positions/);
  assert.match(panel.textContent, /personal, noncommercial/);
  assert.equal(
    panel.querySelector('time').getAttribute('datetime'),
    '2026-11-14T20:02:00Z',
  );
  assert.ok(
    panel.querySelector('a[href="https://www.rtcsnv.com/terms-of-use/"]'),
  );
  panel.querySelector('[aria-label="Close RTC arrivals"]').click();
  assert.equal(closed, 1);
});
