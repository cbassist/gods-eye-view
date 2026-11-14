<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import UiButton from '../../kit/UiButton.vue';
import { useRtcArrivalsStore } from '../../stores/rtcArrivals.js';
const store = useRtcArrivalsStore();
const { view } = storeToRefs(store);
</script>

<template>
  <Teleport to="body">
    <section
      v-if="view?.open"
      id="rtc-arrivals-panel"
      role="region"
      :aria-label="t('RTC Las Vegas arrivals')"
      @keydown.esc.stop="store.act('close')"
    >
      <header
        ><h2>{{ t('RTC Las Vegas arrivals') }}</h2
        ><UiButton
          :label="t('Close RTC arrivals')"
          @click="store.act('close')"
          >{{ t('Close') }}</UiButton
        ></header
      >
      <p>{{
        t(
          'Stop arrival estimates only. No bus positions. Cancelled trips, skipped stops, NO_DATA and missing arrival times are excluded, not replaced by schedules.',
        )
      }}</p>
      <p>{{
        t(
          'RTC data: personal, noncommercial local use only. Not affiliated with or endorsed by RTC. Estimates may change; confirm with RTC before travel.',
        )
      }}</p>
      <p
        ><a
          href="https://www.rtcsnv.com/ways-to-travel/transit-services/for-developers/"
          target="_blank"
          rel="noopener noreferrer"
          >{{
            t('Regional Transportation Commission of Southern Nevada (RTC)')
          }}</a
        >
        ·
        <a
          href="https://www.rtcsnv.com/terms-of-use/"
          target="_blank"
          rel="noopener noreferrer"
          >{{ t('RTC terms and notices') }}</a
        >
        ·
        <a
          href="https://developer.rtcsnv.com/transitData/google_transit.zip"
          target="_blank"
          rel="noopener noreferrer"
          >{{ t('Static GTFS source') }}</a
        >
        ·
        <a
          href="https://developer.rtcsnv.com/transitData/tripUpdates.pb"
          target="_blank"
          rel="noopener noreferrer"
          >{{ t('Realtime source') }}</a
        ></p
      >
      <label for="rtc-stop-search">{{
        t('Search stop name, stop ID, route or destination')
      }}</label>
      <input
        id="rtc-stop-search"
        type="search"
        :value="view.query"
        @input="store.act('search', $event.target.value)"
      />
      <p role="status"
        >{{ t(view.status) }}
        <span v-if="view.busy">{{ t('Loading…') }}</span></p
      >
      <p
        >{{
          t('Feed timestamp (UTC): {time}', {
            time: view.feedTime || t('Unknown'),
          })
        }}
        ·
        {{
          t('Source age: {seconds} seconds', {
            seconds: view.age ?? t('Unknown'),
          })
        }}</p
      >
      <p>{{
        t('Static version: {version}; validated (UTC): {time}', {
          version: view.staticVersion || t('Unknown'),
          time: view.staticValidated || t('Unknown'),
        })
      }}</p>
      <p>{{
        t(
          'Showing {shown} of {total} matching future arrivals. Search to narrow the board.',
          { shown: view.rows.length, total: view.total },
        )
      }}</p>
      <p>{{
        t(
          'Refreshes every 60 seconds while open and visible. Feed expires after five minutes; passed arrival times disappear automatically. All arrival times below use Las Vegas time.',
        )
      }}</p>
      <ol>
        <li
          v-for="(row, index) in view.rows"
          :key="`${row.entityId}:${row.stopId}:${row.stopSequence}:${index}`"
          class="rtc-arrival-row"
          :data-stop-id="row.stopId"
        >
          <strong>{{ row.stopName }} · {{ row.stopId }}</strong
          ><br />
          <span>{{ row.routeName }} · {{ row.headsign }}</span
          ><br />
          <time :datetime="row.arrivalIso">{{ row.arrivalLabel }}</time>
          <span v-if="row.uncertaintySeconds != null">
            ·
            {{
              t('Uncertainty: {seconds} seconds', {
                seconds: row.uncertaintySeconds,
              })
            }}</span
          >
          <p>{{
            t('Trip update (UTC): {time}', {
              time: row.tripTime || t('Unknown'),
            })
          }}</p>
          <UiButton @click="store.act('focus', row)">{{
            t('View stop on map')
          }}</UiButton>
        </li>
      </ol>
      <p v-if="!view.rows.length && !view.busy">{{
        t(
          'No usable future arrival estimates match this search. This is not a claim that no service operates.',
        )
      }}</p>
    </section>
  </Teleport>
</template>

<style scoped>
#rtc-arrivals-panel {
  position: fixed;
  z-index: 1600;
  top: 70px;
  right: 16px;
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100dvh - 160px);
  overflow: auto;
  box-sizing: border-box;
  padding: 16px;
  color: #e6eef5;
  background: #101c29;
  border: 1px solid #71899b;
  border-radius: 10px;
  font: 13px/1.5 sans-serif;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
h2 {
  font-size: 17px;
}
.ui-button {
  color: #e6eef5;
  background: #20384e;
  border: 1px solid #71899b;
  border-radius: 5px;
  padding: 7px 10px;
  cursor: pointer;
}
.ui-button:focus-visible,
input:focus-visible,
a:focus-visible {
  outline: 2px solid #87d5ff;
  outline-offset: 2px;
}
a {
  color: #87d5ff;
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  color: #fff;
  background: #172c40;
  border: 1px solid #71899b;
}
ol {
  padding-left: 24px;
}
li {
  padding: 10px 0;
  border-bottom: 1px solid #71899b;
}
</style>
