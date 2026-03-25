<script setup>
import { ref, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const providers = ref([]);
const patients = ref([]);
const patientId = ref('');
const policies = ref([]);
const loading = ref(false);
const error = ref('');

const providerForm = ref({ name: '', contact_info: '' });
const editingProviderId = ref(null);

const assignForm = ref({
  provider_id: '',
  policy_number: '',
  coverage_percentage: '',
  is_primary: false,
});

async function loadProviders() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/insurance-providers');
    providers.value = data.insurance_providers || [];
  } catch {
    providers.value = [];
  }
}

async function loadPatients() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/patients');
    patients.value = data.patients || [];
  } catch {
    patients.value = [];
  }
}

async function loadPolicies() {
  if (!patientId.value || !company.currentCompanyId) {
    policies.value = [];
    return;
  }
  loading.value = true;
  try {
    const { data } = await api.get('/api/patient-insurances', { params: { patient_id: patientId.value } });
    policies.value = data.patient_insurances || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    policies.value = [];
  } finally {
    loading.value = false;
  }
}

async function saveProvider() {
  error.value = '';
  const body = {
    name: providerForm.value.name.trim(),
    contact_info: providerForm.value.contact_info || null,
  };
  try {
    if (editingProviderId.value) {
      await api.put(`/api/insurance-providers/${editingProviderId.value}`, body);
    } else {
      await api.post('/api/insurance-providers', body);
    }
    providerForm.value = { name: '', contact_info: '' };
    editingProviderId.value = null;
    await loadProviders();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function editProvider(pr) {
  editingProviderId.value = pr.id;
  providerForm.value = { name: pr.name, contact_info: pr.contact_info || '' };
}

function cancelProviderEdit() {
  editingProviderId.value = null;
  providerForm.value = { name: '', contact_info: '' };
}

async function deleteProvider(id) {
  if (!confirm('OK?')) return;
  error.value = '';
  try {
    await api.delete(`/api/insurance-providers/${id}`);
    if (editingProviderId.value === id) cancelProviderEdit();
    await loadProviders();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function assignInsurance() {
  if (!patientId.value || !assignForm.value.provider_id) return;
  error.value = '';
  try {
    await api.post('/api/patient-insurances', {
      patient_id: patientId.value,
      provider_id: assignForm.value.provider_id,
      policy_number: assignForm.value.policy_number || undefined,
      coverage_percentage:
        assignForm.value.coverage_percentage === '' ? undefined : Number(assignForm.value.coverage_percentage),
      is_primary: assignForm.value.is_primary,
    });
    assignForm.value = { provider_id: '', policy_number: '', coverage_percentage: '', is_primary: false };
    await loadPolicies();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function removePolicy(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/patient-insurances/${id}`);
    await loadPolicies();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

watch(patientId, loadPolicies);

onMounted(async () => {
  await loadProviders();
  await loadPatients();
});
watch(() => company.currentCompanyId, async () => {
  patientId.value = '';
  policies.value = [];
  cancelProviderEdit();
  await loadProviders();
  await loadPatients();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('clinical.insuranceTitle') }}</h1>
      <p class="ui-page-desc">{{ t('clinical.insuranceSubtitle') }}</p>
    </div>

    <div class="grid gap-8 lg:grid-cols-2">
      <div class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-5">{{ t('clinical.providers') }}</h2>
        <form class="grid gap-3" @submit.prevent="saveProvider">
          <input v-model="providerForm.name" required class="ui-input" :placeholder="t('clinical.providerName')" />
          <textarea
            v-model="providerForm.contact_info"
            rows="2"
            class="ui-input"
            :placeholder="t('clinical.contactInfo')"
          />
          <div class="flex flex-wrap gap-2">
            <button type="submit" class="ui-btn-primary">
              {{ editingProviderId ? t('clinical.updateProvider') : t('clinical.addProvider') }}
            </button>
            <button v-if="editingProviderId" type="button" class="ui-btn-secondary" @click="cancelProviderEdit">
              {{ t('common.cancel') }}
            </button>
          </div>
        </form>

        <div class="ui-table-wrap mt-6">
          <table class="ui-table text-sm">
            <thead>
              <tr>
                <th>{{ t('clinical.providerName') }}</th>
                <th>{{ t('clinical.contactInfo') }}</th>
                <th>{{ t('common.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pr in providers" :key="pr.id">
                <td class="font-medium">{{ pr.name }}</td>
                <td class="max-w-[10rem] truncate text-slate-600">{{ pr.contact_info || '—' }}</td>
                <td class="flex flex-wrap gap-1">
                  <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="editProvider(pr)">
                    {{ t('clinical.editProvider') }}
                  </button>
                  <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="deleteProvider(pr.id)">
                    {{ t('accounts.delete') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-5">{{ t('clinical.patientCoverage') }}</h2>
        <label class="ui-label">{{ t('clinical.patient') }}</label>
        <select v-model="patientId" class="ui-select mt-1 mb-6 max-w-md">
          <option value="">{{ t('clinical.selectPatient') }}</option>
          <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.full_name }}</option>
        </select>

        <template v-if="patientId">
          <h3 class="mb-3 text-sm font-bold text-slate-700">{{ t('clinical.assignInsurance') }}</h3>
          <form class="mb-6 grid gap-3" @submit.prevent="assignInsurance">
            <select v-model="assignForm.provider_id" required class="ui-select">
              <option value="">{{ t('clinical.provider') }}</option>
              <option v-for="pr in providers" :key="pr.id" :value="pr.id">{{ pr.name }}</option>
            </select>
            <input v-model="assignForm.policy_number" class="ui-input" :placeholder="t('clinical.policyNumber')" />
            <input
              v-model="assignForm.coverage_percentage"
              type="number"
              min="0"
              max="100"
              step="0.01"
              class="ui-input"
              :placeholder="t('clinical.coveragePct')"
            />
            <label class="flex items-center gap-2 text-sm text-slate-700">
              <input v-model="assignForm.is_primary" type="checkbox" class="rounded border-slate-300" />
              {{ t('clinical.primary') }}
            </label>
            <button type="submit" class="ui-btn-primary w-fit">{{ t('common.save') }}</button>
          </form>

          <div class="ui-table-wrap">
            <table class="ui-table text-sm">
              <thead>
                <tr>
                  <th>{{ t('clinical.provider') }}</th>
                  <th>{{ t('clinical.policyNumber') }}</th>
                  <th>{{ t('clinical.coveragePct') }}</th>
                  <th>{{ t('clinical.primary') }}</th>
                  <th>{{ t('common.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="pol in policies" :key="pol.id">
                  <td class="font-medium">{{ pol.provider_name }}</td>
                  <td>{{ pol.policy_number || '—' }}</td>
                  <td>{{ pol.coverage_percentage != null ? pol.coverage_percentage + '%' : '—' }}</td>
                  <td>{{ pol.is_primary ? '✓' : '—' }}</td>
                  <td>
                    <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="removePolicy(pol.id)">
                      {{ t('accounts.delete') }}
                    </button>
                  </td>
                </tr>
                <tr v-if="loading">
                  <td colspan="5" class="py-8 text-center text-slate-500">{{ t('common.loading') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>

    <p v-if="error" class="mt-6 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
      {{ error }}
    </p>
  </div>
</template>
