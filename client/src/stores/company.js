import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api } from '@/api/client';

const COMPANY_KEY = 'current_company_id';

export const useCompanyStore = defineStore('company', () => {
  const companies = ref([]);
  const currentCompanyId = ref(
    typeof localStorage !== 'undefined' ? localStorage.getItem(COMPANY_KEY) : null
  );
  const loading = ref(false);

  const currentCompany = computed(() =>
    companies.value.find((c) => c.id === currentCompanyId.value) || null
  );
  const currentCompanyRole = computed(() => currentCompany.value?.user_role || null);

  function canAccessModule(moduleName) {
    const role = currentCompanyRole.value;
    if (!role) return false;
    if (role === 'owner' || role === 'admin') return true;
    if (role === 'accountant') return moduleName === 'accounting' || moduleName === 'documents';
    if (role === 'viewer') return moduleName === 'accounting' || moduleName === 'documents';
    if (role === 'doctor' || role === 'receptionist') return moduleName === 'clinical';
    return false;
  }

  function setCurrentCompany(id) {
    currentCompanyId.value = id;
    if (id) localStorage.setItem(COMPANY_KEY, id);
    else localStorage.removeItem(COMPANY_KEY);
  }

  async function loadCompanies() {
    loading.value = true;
    try {
      const { data } = await api.get('/api/companies');
      companies.value = data.companies || [];
      if (currentCompanyId.value && !companies.value.some((c) => c.id === currentCompanyId.value)) {
        setCurrentCompany(null);
      }
      if (!currentCompanyId.value && companies.value.length > 0) {
        setCurrentCompany(companies.value[0].id);
      }
    } finally {
      loading.value = false;
    }
  }

  async function createCompany(name, industry) {
    const { data } = await api.post('/api/companies', { name, industry });
    const created = data.company;
    // Prefer full list so rows always match GET / (is_owner, user_role, etc.).
    await loadCompanies();
    if (created?.id) setCurrentCompany(created.id);
    return companies.value.find((c) => c.id === created?.id) || created;
  }

  return {
    companies,
    currentCompanyId,
    currentCompany,
    currentCompanyRole,
    loading,
    canAccessModule,
    setCurrentCompany,
    loadCompanies,
    createCompany,
  };
});
