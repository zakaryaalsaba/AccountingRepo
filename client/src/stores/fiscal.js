import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '@/api/client';

const KEY_PREFIX = 'current_fiscal_year_id:';

function storageKey(companyId) {
  return `${KEY_PREFIX}${companyId || 'none'}`;
}

export const useFiscalStore = defineStore('fiscal', () => {
  const fiscalYears = ref([]);
  const currentFiscalYearId = ref(null);
  const loading = ref(false);

  const currentFiscalYear = computed(
    () => fiscalYears.value.find((fy) => fy.id === currentFiscalYearId.value) || null
  );

  function hydrateSelection(companyId) {
    if (!companyId) {
      currentFiscalYearId.value = null;
      return;
    }
    currentFiscalYearId.value = localStorage.getItem(storageKey(companyId));
  }

  function setCurrentFiscalYear(companyId, fiscalYearId) {
    if (!companyId) return;
    currentFiscalYearId.value = fiscalYearId || null;
    const k = storageKey(companyId);
    if (fiscalYearId) localStorage.setItem(k, fiscalYearId);
    else localStorage.removeItem(k);
  }

  async function loadFiscalYears(companyId) {
    if (!companyId) {
      fiscalYears.value = [];
      currentFiscalYearId.value = null;
      return;
    }
    loading.value = true;
    try {
      hydrateSelection(companyId);
      const { data } = await api.get('/api/fiscal-years');
      fiscalYears.value = data.fiscal_years || [];
      const selectedExists = currentFiscalYearId.value
        && fiscalYears.value.some((fy) => fy.id === currentFiscalYearId.value);
      if (!selectedExists) {
        const active = fiscalYears.value.find((fy) => fy.is_active && !fy.is_closed);
        setCurrentFiscalYear(companyId, active?.id || fiscalYears.value[0]?.id || null);
      }
    } finally {
      loading.value = false;
    }
  }

  return {
    fiscalYears,
    currentFiscalYearId,
    currentFiscalYear,
    loading,
    loadFiscalYears,
    setCurrentFiscalYear,
  };
});
