<script setup>
import { storeToRefs } from 'pinia';
import { nextTick, watch } from 'vue';
import { t, msg } from '../../../i18n/index.js';
import { useBorderWaitsStore } from '../../stores/borderWaits.js';
import UiButton from '../../kit/UiButton.vue';
import UiPanel from '../../kit/UiPanel.vue';
const store = useBorderWaitsStore();
const { view } = storeToRefs(store);
watch(() => view.value?.open, async (open, wasOpen) => {
  await nextTick();
  if (open) document.querySelector('#san-ysidro-panel button')?.focus();
  else if (wasOpen) document.getElementById('san-ysidro-waits-open')?.focus();
});
const labels = { reported: msg('Reported'), stale: msg('Stale'), unavailable: msg('Unavailable'), closed: msg('Closed'), future: msg('Future timestamp'), expired: msg('Expired') };
</script>

<template>
  <Teleport to="body">
    <section v-if="view?.open" class="border-waits" aria-labelledby="border-waits-title" @keydown.esc.stop="store.act('close')">
      <UiPanel id="san-ysidro-panel" :title="t('San Ysidro / Tijuana')">
        <template #title><h2 id="border-waits-title">{{ t('San Ysidro / Tijuana') }}</h2></template>
        <template #actions><UiButton :label="t('Close border waits')" @click="store.act('close')">×</UiButton></template>
        <p>{{ t('Northbound into the U.S. · CBP reported waits') }}</p>
        <div class="border-actions"><UiButton @click="store.act('navigate')">{{ t('Show crossing on map') }}</UiButton><UiButton :disabled="view.busy" @click="store.act('refresh')">{{ view.busy ? t('Checking…') : t('Refresh waits') }}</UiButton></div>
        <p v-if="view.failed || view.data?.sourceStatus === 'cached-refresh-failed'" role="status">{{ t('Refresh failed. Previous reports may be out of date; forecasts unavailable.') }}</p>
        <p v-if="!view.data || view.data.sourceStatus === 'unavailable'" role="status">{{ view.busy ? t('Checking CBP…') : t('CBP waits unavailable') }}</p>
        <p v-if="view.data?.fetchedAt" class="border-meta">{{ t('Feed retrieved (UTC)') }}: {{ view.data.fetchedAt }}</p>
        <article v-for="lane in view.data?.lanes" :key="lane.id" class="border-lane" :data-state="lane.status">
          <h3>{{ t(lane.label) }}</h3>
          <strong>{{ t(labels[lane.status] || labels.unavailable) }}<template v-if="lane.minutes !== null"> · {{ t('{minutes} min last reported', { minutes: lane.minutes }) }}</template></strong>
          <div>{{ t('Lanes open (reported)') }}: {{ lane.lanesOpen ?? t('Unavailable') }}</div>
          <div>{{ t('Lane report (UTC)') }}: {{ lane.reportedAt ?? t('Unknown') }}</div>
          <div class="border-meta">{{ lane.reportText }} · {{ t('Source status') }}: {{ lane.operationalStatus }}</div>
          <div v-if="lane.freshness !== 'fresh'">{{ lane.freshness === 'stale' ? t('Report older than 90 minutes') : t('Report time unverified') }}</div>
          <div v-if="lane.forecast?.status === 'experimental'" class="border-forecast">{{ t('Unvalidated experimental baseline: {minutes} min in 30 minutes', { minutes: lane.forecast.minutes }) }} · {{ t('Persistence method: last reported wait held constant') }} · {{ t('Target (UTC)') }}: {{ lane.forecast.targetAt }}</div>
          <div v-else class="border-meta">{{ t('30-minute forecast unavailable') }} · {{ t('{count}/6 distinct reports', { count: lane.forecast?.observations ?? 0 }) }}</div>
        </article>
        <p>{{ t('Forecast warmup requires six distinct valid reports spanning at least two hours, with the latest no older than 30 minutes. Repeated polls do not count. History resets when the server restarts; accuracy has not been validated.') }}</p>
        <p>{{ t('Queue length unavailable: no calibrated queue-distance source. Lane eligibility and pedestrian operating hours must be checked with CBP; the main pedestrian record is not asserted to be a separate PedEast measurement.') }}</p>
        <p><a href="https://bwt.cbp.gov" target="_blank" rel="noopener noreferrer">{{ t('U.S. Customs and Border Protection · official reports and hours') }}</a></p>
        <section class="border-southbound" aria-labelledby="border-southbound-title">
          <h3 id="border-southbound-title">{{ t('Southbound into Mexico · Caltrans published waits') }}</h3>
          <p>{{ t('Pacific time assumed; source does not specify a timezone. Expected waits are published by Caltrans, not a GEV prediction.') }}</p>
          <p v-if="!view.data?.southbound || view.data.southbound.sourceStatus !== 'available'" role="status">{{ t('Caltrans unavailable or refresh failed; previous values are not current guidance.') }}</p>
          <template v-if="view.data?.southbound">
            <p class="border-meta">{{ view.data.southbound.publicationText }} · {{ t('Source publication (UTC, assumed)') }}: {{ view.data.southbound.publishedAt ?? t('Unknown') }}</p>
            <p class="border-meta">{{ t('Feed retrieved (UTC)') }}: {{ view.data.southbound.fetchedAt ?? t('Unknown') }}</p>
            <article v-for="route in view.data.southbound.routes" :key="route.route" class="border-lane">
              <h4 translate="no">San Ysidro · {{ route.route }}</h4>
              <div v-for="(value, index) in [route.current, ...route.expected]" :key="index" :data-state="value.status">
                {{ index === 0 ? t('Current') : t('Expected') }} · {{ value.targetText }} · {{ t(labels[value.status] || labels.unavailable) }}:
                <strong>{{ value.text === 'No Wait' ? t('No Wait') : value.minutes !== null ? t('{minutes} min last reported', { minutes: value.minutes }) : t('Unavailable') }}</strong>
                <div class="border-meta">{{ t('Target (UTC)') }}: {{ value.targetAt ?? t('Unknown') }}</div>
              </div>
            </article>
          </template>
          <p><a href="https://quickmap.dot.ca.gov/borderwait.html" target="_blank" rel="noopener noreferrer">{{ t('Caltrans · official southbound waits') }}</a></p>
        </section>
        <h3>{{ t('Caltrans · southbound approach context') }}</h3>
        <p>{{ t('These stills do not measure the northbound queue or wait. Capture time is not supplied by the proxy; check the image overlay. Retrieval time is not capture time.') }}</p>
        <UiButton @click="store.act('loadCameras')">{{ t('Load / refresh Caltrans stills (60-second minimum)') }}</UiButton>
        <figure v-for="camera in view.cameras" :key="camera.id">
          <a :href="camera.url" target="_blank" rel="noopener noreferrer">{{ camera.name }}</a>
          <img v-if="camera.image" :src="camera.image" :alt="camera.name" />
          <figcaption>{{ camera.retrievedAt ? t('Still retrieved (UTC): {time}', { time: camera.retrievedAt }) : t('Still not loaded or unavailable; open official image') }}</figcaption>
        </figure>
        <h3>{{ t('External camera providers') }}</h3>
        <p><a href="https://vi-ads.com/bordertrafficcams/" target="_blank" rel="noopener noreferrer" translate="no">Visual Impact</a> · {{ t('Video decoded on 2026-11-14, then failed; continuous playback unreliable.') }}</p>
        <p><a href="https://webcamsdemexico.com/webcam/tijuana/" target="_blank" rel="noopener noreferrer" translate="no">NewCity · Webcams de México</a> · {{ t('Video playback verified on 2026-11-14; upstream Ready Lane coverage unverified.') }}</p>
        <p><a href="https://bordertraffic.com/California-Baja/San-Ysidro-Tijuana.aspx" target="_blank" rel="noopener noreferrer" translate="no">BorderTraffic</a> · <a href="https://www.bordercam.cam" target="_blank" rel="noopener noreferrer" translate="no">BorderCam</a></p>
        <p>{{ t('External services may require a subscription. Dated playback observations do not guarantee current playback or full coverage. No third-party video is embedded. Public traffic aggregates only; no individual tracking.') }}</p>
      </UiPanel>
    </section>
  </Teleport>
</template>

<style scoped>
.border-waits { position: fixed; z-index: 155; top: 72px; right: 20px; width: min(430px, calc(100vw - 32px)); max-height: calc(100dvh - 160px); overflow: auto; padding: 14px; background: rgba(8, 18, 25, .97); color: #e2f5f5; border: 1px solid #669b9b; border-radius: 8px; font: 12px/1.5 sans-serif; box-shadow: 0 8px 30px #0008; }
h2 { font-size: 17px; margin: 0; } h3 { font-size: 13px; margin: 4px 0; }
a { color: #8ee5ed; } .border-lane { border-top: 1px solid #456; padding: 9px 0; }
.border-meta { color: #aebec7; font-size: 11px; overflow-wrap: anywhere; }
.border-actions { display: flex; gap: 10px; flex-wrap: wrap; }
button { padding: 6px 9px; background: #20363d; color: #e2f5f5; border: 1px solid #669b9b; border-radius: 4px; cursor: pointer; }
figure { margin: 12px 0; } img { width: 100%; display: block; margin-top: 5px; }
.border-forecast, [data-state='stale'] strong { color: #f7cd82; }
:global(body.cockpit-mode) .border-waits, :global(body.ui-clean-view) .border-waits, :global(body.recording-mode) .border-waits { display: none; }
@media (max-width: 600px) { .border-waits { top: 60px; right: 8px; max-height: calc(100dvh - 170px); } }
</style>
