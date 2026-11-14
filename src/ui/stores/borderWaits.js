import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import { createOwners } from './owners.js';

/** San Ysidro panel state and actions supplied by its application owner. */
export const useBorderWaitsStore = defineStore('gev-border-waits', () => {
  const view = shallowRef(null);
  const owners = createOwners();
  return {
    view,
    publish: (next) => {
      view.value = next;
    },
    ...owners,
  };
});
