<script setup>
import { ref, watch, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const patients = ref([]);
const patientId = ref('');
const records = ref([]);
const loading = ref(false);
const error = ref('');

const form = ref({
  diagnosis: '',
  treatment: '',
  notes: '',
});

async function loadPatients() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/patients');
    patients.value = data.patients || [];
  } catch {
    patients.value = [];
  }
}

async function loadRecords() {
  if (!patientId.value || !company.currentCompanyId) {
    records.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/medical-records', { params: { patient_id: patientId.value } });
    records.value = data.medical_records || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    records.value = [];
  } finally {
    loading.value = false;
  }
}

async function addRecord() {
  if (!patientId.value) return;
  error.value = '';
  try {
    await api.post('/api/medical-records', {
      patient_id: patientId.value,
      diagnosis: form.value.diagnosis || null,
      treatment: form.value.treatment || null,
      notes: form.value.notes || null,
    });
    form.value = { diagnosis: '', treatment: '', notes: '' };
    await loadRecords();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/medical-records/${id}`);
    await loadRecords();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

watch(patientId, loadRecords);
onMounted(async () => {
  await loadPatients();
});
watch(() => company.currentCompanyId, async () => {
  patientId.value = '';
  records.value = [];
  await loadPatients();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('clinical.recordsTitle') }}</h1>
      <p class="ui-page-desc">{{ t('clinical.recordsSubtitle') }}</p>
    </div>

    <div class="ui-card ui-card-pad mb-8">
      <label class="ui-label">{{ t('clinical.selectPatient') }}</label>
      <select v-model="patientId" class="ui-select mt-1 max-w-md">
        <option value="">{{ t('clinical.selectPatient') }}</option>
        <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.full_name }}</option>
      </select>
    </div>

    <template v-if="patientId">
      <div class="ui-card ui-card-pad mb-8">
        <h2 class="ui-card-title mb-5">{{ t('clinical.addRecord') }}</h2>
        <form class="grid gap-4" @submit.prevent="addRecord">
          <input v-model="form.diagnosis" class="ui-input" :placeholder="t('clinical.diagnosis')" />
          <input v-model="form.treatment" class="ui-input" :placeholder="t('clinical.treatment')" />
          <textarea v-model="form.notes" rows="2" class="ui-input" :placeholder="t('clinical.notes')" />
          <button type="submit" class="ui-btn-primary w-fit">{{ t('common.save') }}</button>
        </form>
        <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
          {{ error }}
        </p>
      </div>

      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>{{ t('clinical.recordDate') }}</th>
              <th>{{ t('clinical.diagnosis') }}</th>
              <th>{{ t('clinical.treatment') }}</th>
              <th>{{ t('clinical.notes') }}</th>
              <th>{{ t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in records" :key="r.id">
              <td class="whitespace-nowrap text-slate-600">{{ fmtDate(r.created_at) }}</td>
              <td class="text-slate-800">{{ r.diagnosis || '—' }}</td>
              <td class="text-slate-800">{{ r.treatment || '—' }}</td>
              <td class="max-w-xs text-slate-600">{{ r.notes || '—' }}</td>
              <td>
                <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(r.id)">
                  {{ t('accounts.delete') }}
                </button>
              </td>
            </tr>
            <tr v-if="loading">
              <td colspan="5" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
            </tr>
            <tr v-if="!loading && !records.length">
              <td colspan="5" class="py-8 text-center text-slate-500">{{ t('clinical.noRecordsYet') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
