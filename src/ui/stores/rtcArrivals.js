import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import { createOwners } from './owners.js';

/** RTC stop board state and connected application actions. */
export const useRtcArrivalsStore = defineStore('gev-rtc-arrivals', () => {
  const view = shallowRef(null);
  return {
    view,
    publish: (next) => {
      view.value = next;
    },
    ...createOwners(),
  };
});
