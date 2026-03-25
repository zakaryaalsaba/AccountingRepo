<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const auth = useAuthStore();

const list = ref([]);
const patients = ref([]);
const doctors = ref([]);
const appointments = ref([]);
const filterPatient = ref('');
const filterDoctor = ref('');
const loading = ref(false);
const error = ref('');

const editingId = ref(null);
const form = ref({
  appointment_id: '',
  doctor_id: '',
  test_name: '',
  instructions: '',
  status: 'ordered',
  test_fee: '',
  results: '',
});
const fieldErrors = ref({});

const selectedAppt = computed(() =>
  appointments.value.find((a) => a.id === form.value.appointment_id)
);

async function loadPatients() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/patients');
    patients.value = data.patients || [];
  } catch {
    patients.value = [];
  }
}

async function loadDoctors() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/doctor-profiles');
    doctors.value = data.doctors || [];
  } catch {
    doctors.value = [];
  }
}

async function loadAppointments() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/appointments');
    appointments.value = data.appointments || [];
  } catch {
    appointments.value = [];
  }
}

async function loadList() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const params = {};
    if (filterPatient.value) params.patient_id = filterPatient.value;
    if (filterDoctor.value) params.doctor_id = filterDoctor.value;
    const { data } = await api.get('/api/lab-orders', { params });
    list.value = data.lab_orders || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    list.value = [];
  } finally {
    loading.value = false;
  }
}

function resultsPreview(row) {
  if (row.results == null) return '—';
  if (typeof row.results === 'object' && row.results.text != null) return row.results.text;
  if (typeof row.results === 'string') return row.results;
  return JSON.stringify(row.results);
}

function statusLabel(s) {
  if (s === 'ordered') return t('clinical.labStatusOrdered');
  if (s === 'completed') return t('clinical.labStatusCompleted');
  if (s === 'canceled') return t('clinical.labStatusCanceled');
  return s || '—';
}

function resetForm() {
  editingId.value = null;
  fieldErrors.value = {};
  form.value = {
    appointment_id: '',
    doctor_id: '',
    test_name: '',
    instructions: '',
    status: 'ordered',
    test_fee: '',
    results: '',
  };
}

function editRow(row) {
  editingId.value = row.id;
  fieldErrors.value = {};
  let resultsStr = '';
  if (row.results != null) {
    resultsStr =
      typeof row.results === 'object' && row.results.text != null
        ? String(row.results.text)
        : typeof row.results === 'string'
          ? row.results
          : JSON.stringify(row.results, null, 2);
  }
  form.value = {
    appointment_id: row.appointment_id,
    doctor_id: row.doctor_id,
    test_name: row.test_name || '',
    instructions: row.instructions || '',
    status: row.status || 'ordered',
    test_fee: row.test_fee != null ? String(row.test_fee) : '',
    results: resultsStr,
  };
}

async function save() {
  fieldErrors.value = {};
  if (!form.value.appointment_id) fieldErrors.value.appointment_id = t('clinical.validationRequired');
  if (!form.value.doctor_id) fieldErrors.value.doctor_id = t('clinical.validationRequired');
  if (!form.value.test_name?.trim()) fieldErrors.value.test_name = t('clinical.validationRequired');
  if (Object.keys(fieldErrors.value).length) return;

  const ap = selectedAppt.value;
  if (!ap) {
    fieldErrors.value.appointment_id = t('clinical.validationRequired');
    return;
  }

  error.value = '';
  const body = {
    appointment_id: form.value.appointment_id,
    patient_id: ap.patient_id,
    doctor_id: form.value.doctor_id,
    test_name: form.value.test_name.trim(),
    instructions: form.value.instructions || undefined,
    status: form.value.status,
    test_fee: form.value.test_fee === '' ? undefined : Number(form.value.test_fee),
    results: form.value.results?.trim() ? form.value.results.trim() : undefined,
  };
  try {
    if (editingId.value) {
      await api.put(`/api/lab-orders/${editingId.value}`, body);
    } else {
      await api.post('/api/lab-orders', body);
    }
    resetForm();
    await loadList();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm(t('clinical.confirmDelete'))) return;
  error.value = '';
  try {
    await api.delete(`/api/lab-orders/${id}`);
    if (editingId.value === id) resetForm();
    await loadList();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function fmtLocal(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

onMounted(async () => {
  await Promise.all([loadPatients(), loadDoctors(), loadAppointments()]);
  await loadList();
});
watch(
  () => company.currentCompanyId,
  async () => {
    await Promise.all([loadPatients(), loadDoctors(), loadAppointments()]);
    await loadList();
    resetForm();
  }
);
watch([filterPatient, filterDoctor], () => {
  loadList();
});

// When selecting a visit for a new lab order, prefill doctor_id from that visit
// (so the doctor dropdown only needs to pick an active role=doctor member).
watch(
  () => form.value.appointment_id,
  () => {
    if (editingId.value) return;
    const ap = selectedAppt.value;
    form.value.doctor_id = ap?.assigned_doctor_id || '';
  }
);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('clinical.labOrdersTitle') }}</h1>
      <p class="ui-page-desc">{{ t('clinical.labOrdersSubtitle') }}</p>
    </div>

    <p v-if="error" class="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
      {{ error }}
    </p>

    <div class="mb-6 flex flex-wrap gap-4">
      <label class="flex flex-col gap-1">
        <span class="ui-label !mb-0">{{ t('clinical.filterByPatient') }}</span>
        <select v-model="filterPatient" class="ui-select min-w-[12rem]">
          <option value="">{{ t('clinical.allPatients') }}</option>
          <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.full_name }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="ui-label !mb-0">{{ t('clinical.filterByDoctor') }}</span>
        <select v-model="filterDoctor" class="ui-select min-w-[12rem]">
          <option value="">{{ t('clinical.allDoctors') }}</option>
          <option v-for="d in doctors" :key="d.user_id" :value="d.user_id">
            {{ d.full_name || d.email }}
          </option>
        </select>
      </label>
    </div>

    <div class="ui-card ui-card-pad mb-8">
      <h2 class="ui-card-title mb-4">{{ editingId ? t('clinical.editLabOrder') : t('clinical.addLabOrder') }}</h2>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="sm:col-span-2">
          <label class="ui-label">{{ t('clinical.appointment') }} *</label>
          <select v-model="form.appointment_id" class="ui-select w-full max-w-xl" :disabled="Boolean(editingId)">
            <option value="">{{ t('clinical.selectAppointment') }}</option>
            <option v-for="a in appointments" :key="a.id" :value="a.id">
              {{ fmtLocal(a.appointment_date) }} — {{ a.patient_name }}
            </option>
          </select>
          <p v-if="fieldErrors.appointment_id" class="mt-1 text-xs text-rose-600">{{ fieldErrors.appointment_id }}</p>
        </div>
        <div>
          <label class="ui-label">{{ t('clinical.doctor') }} *</label>
          <select v-model="form.doctor_id" class="ui-select w-full">
            <option value="">{{ t('clinical.selectDoctor') }}</option>
            <option v-for="d in doctors" :key="d.user_id" :value="d.user_id">
              {{ d.full_name || d.email }}
            </option>
          </select>
          <p v-if="fieldErrors.doctor_id" class="mt-1 text-xs text-rose-600">{{ fieldErrors.doctor_id }}</p>
        </div>
        <div>
          <label class="ui-label">{{ t('clinical.testName') }} *</label>
          <input v-model="form.test_name" class="ui-input w-full" />
          <p v-if="fieldErrors.test_name" class="mt-1 text-xs text-rose-600">{{ fieldErrors.test_name }}</p>
        </div>
        <div>
          <label class="ui-label">{{ t('clinical.status') }}</label>
          <select v-model="form.status" class="ui-select w-full">
            <option value="ordered">{{ t('clinical.labStatusOrdered') }}</option>
            <option value="completed">{{ t('clinical.labStatusCompleted') }}</option>
            <option value="canceled">{{ t('clinical.labStatusCanceled') }}</option>
          </select>
        </div>
        <div>
          <label class="ui-label">{{ t('clinical.testFee') }}</label>
          <input v-model="form.test_fee" type="number" min="0" step="0.01" class="ui-input w-full" />
        </div>
        <div class="sm:col-span-2">
          <label class="ui-label">{{ t('clinical.instructions') }}</label>
          <textarea v-model="form.instructions" class="ui-input min-h-[3rem] w-full" />
        </div>
        <div class="sm:col-span-2">
          <label class="ui-label">{{ t('clinical.results') }}</label>
          <textarea v-model="form.results" class="ui-input min-h-[5rem] w-full" :placeholder="t('clinical.resultsPlaceholder')" />
        </div>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" class="ui-btn-primary" @click="save">{{ t('common.save') }}</button>
        <button v-if="editingId" type="button" class="ui-btn-secondary" @click="resetForm">{{ t('common.cancel') }}</button>
      </div>
    </div>

    <div class="ui-table-wrap">
      <table class="ui-table text-sm">
        <thead>
          <tr>
            <th>{{ t('clinical.visit') }}</th>
            <th>{{ t('clinical.patient') }}</th>
            <th>{{ t('clinical.testName') }}</th>
            <th>{{ t('clinical.status') }}</th>
            <th>{{ t('clinical.doctor') }}</th>
            <th>{{ t('clinical.results') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in list" :key="row.id">
            <td>
              <RouterLink
                v-if="row.appointment_id"
                :to="{ name: 'clinical-appointment-detail', params: { id: row.appointment_id } }"
                class="text-brand-600 hover:underline"
              >
                {{ t('clinical.openVisit') }}
              </RouterLink>
              <span v-else>—</span>
            </td>
            <td>{{ row.patient_name }}</td>
            <td class="font-medium">{{ row.test_name }}</td>
            <td>{{ statusLabel(row.status) }}</td>
            <td>{{ row.doctor_name }}</td>
            <td class="max-w-[14rem] truncate text-slate-600">{{ resultsPreview(row) }}</td>
            <td class="flex flex-wrap gap-2">
              <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="editRow(row)">
                {{ t('clinical.edit') }}
              </button>
              <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="remove(row.id)">
                {{ t('accounts.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="loading">
            <td colspan="7" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
          <tr v-else-if="!list.length">
            <td colspan="7" class="py-12 text-center text-slate-500">{{ t('clinical.noLabOrdersYet') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
