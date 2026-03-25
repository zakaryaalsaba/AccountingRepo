<script setup>
import { ref, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const appointments = ref([]);
const patients = ref([]);
const doctors = ref([]);
const loading = ref(false);
const error = ref('');
const vitalsExpandedId = ref(null);

const form = ref({
  patient_id: '',
  assigned_doctor_id: '',
  appointment_date: new Date().toISOString().slice(0, 16),
  status: 'scheduled',
  notes: '',
  blood_pressure: '',
  heart_rate: '',
  spo2: '',
  temperature_c: '',
  respiratory_rate: '',
  weight_kg: '',
});

const vitalsForm = ref({
  blood_pressure: '',
  heart_rate: '',
  spo2: '',
  temperature_c: '',
  respiratory_rate: '',
  weight_kg: '',
});

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function vitalsPayloadFromForm(f) {
  const bp =
    f.blood_pressure != null && String(f.blood_pressure).trim() !== ''
      ? String(f.blood_pressure).trim()
      : null;
  return {
    blood_pressure: bp,
    heart_rate: numOrNull(f.heart_rate),
    spo2: numOrNull(f.spo2),
    temperature_c: numOrNull(f.temperature_c),
    respiratory_rate: numOrNull(f.respiratory_rate),
    weight_kg: numOrNull(f.weight_kg),
  };
}

function vitalsSummary(a) {
  const bits = [];
  if (a.blood_pressure) bits.push(`${a.blood_pressure}`);
  if (a.heart_rate != null) bits.push(`HR ${a.heart_rate}`);
  if (a.spo2 != null) bits.push(`SpO₂ ${a.spo2}%`);
  if (a.temperature_c != null) bits.push(`${a.temperature_c}°C`);
  if (a.respiratory_rate != null) bits.push(`RR ${a.respiratory_rate}`);
  if (a.weight_kg != null) bits.push(`${a.weight_kg} kg`);
  return bits.length ? bits.join(' · ') : '—';
}

function hasVitals(a) {
  return vitalsSummary(a) !== '—';
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
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/appointments');
    appointments.value = data.appointments || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

function resetMainForm() {
  form.value = {
    patient_id: '',
    assigned_doctor_id: '',
    appointment_date: new Date().toISOString().slice(0, 16),
    status: 'scheduled',
    notes: '',
    blood_pressure: '',
    heart_rate: '',
    spo2: '',
    temperature_c: '',
    respiratory_rate: '',
    weight_kg: '',
  };
}

async function add() {
  error.value = '';
  try {
    await api.post('/api/appointments', {
      patient_id: form.value.patient_id,
      assigned_doctor_id: form.value.assigned_doctor_id || undefined,
      appointment_date: new Date(form.value.appointment_date).toISOString(),
      status: form.value.status,
      notes: form.value.notes || undefined,
      ...vitalsPayloadFromForm(form.value),
    });
    resetMainForm();
    await loadAppointments();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function updateStatus(a, status) {
  error.value = '';
  try {
    await api.put(`/api/appointments/${a.id}`, {
      patient_id: a.patient_id,
      assigned_doctor_id: a.assigned_doctor_id ?? null,
      appointment_date: a.appointment_date,
      status,
      notes: a.notes,
      ...vitalsPayloadFromForm({
        blood_pressure: a.blood_pressure,
        heart_rate: a.heart_rate != null ? String(a.heart_rate) : '',
        spo2: a.spo2 != null ? String(a.spo2) : '',
        temperature_c: a.temperature_c != null ? String(a.temperature_c) : '',
        respiratory_rate: a.respiratory_rate != null ? String(a.respiratory_rate) : '',
        weight_kg: a.weight_kg != null ? String(a.weight_kg) : '',
      }),
    });
    await loadAppointments();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function toggleVitalsEditor(a) {
  if (vitalsExpandedId.value === a.id) {
    vitalsExpandedId.value = null;
    return;
  }
  vitalsExpandedId.value = a.id;
  vitalsForm.value = {
    blood_pressure: a.blood_pressure || '',
    heart_rate: a.heart_rate != null ? String(a.heart_rate) : '',
    spo2: a.spo2 != null ? String(a.spo2) : '',
    temperature_c: a.temperature_c != null ? String(a.temperature_c) : '',
    respiratory_rate: a.respiratory_rate != null ? String(a.respiratory_rate) : '',
    weight_kg: a.weight_kg != null ? String(a.weight_kg) : '',
  };
}

async function saveVitalsForVisit(a) {
  error.value = '';
  try {
    await api.put(`/api/appointments/${a.id}`, {
      patient_id: a.patient_id,
      assigned_doctor_id: a.assigned_doctor_id ?? null,
      appointment_date: a.appointment_date,
      status: a.status,
      notes: a.notes,
      ...vitalsPayloadFromForm(vitalsForm.value),
    });
    vitalsExpandedId.value = null;
    await loadAppointments();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/appointments/${id}`);
    if (vitalsExpandedId.value === id) vitalsExpandedId.value = null;
    await loadAppointments();
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
  await loadPatients();
  await loadDoctors();
  await loadAppointments();
});
watch(() => company.currentCompanyId, async () => {
  vitalsExpandedId.value = null;
  await loadPatients();
  await loadDoctors();
  await loadAppointments();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('clinical.appointmentsTitle') }}</h1>
      <p class="ui-page-desc">{{ t('clinical.appointmentsSubtitle') }}</p>
      <p class="mt-2 text-sm text-slate-600">{{ t('clinical.vitalsVisitHint') }}</p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-2">{{ t('clinical.addAppointment') }}</h2>
      <p class="mb-5 text-sm text-slate-600">{{ t('clinical.vitalsPerVisit') }}</p>

      <form @submit.prevent="add">
        <div class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <select v-model="form.patient_id" required class="ui-select sm:col-span-2">
            <option value="">{{ t('clinical.patient') }}</option>
            <option v-for="p in patients" :key="p.id" :value="p.id">{{ p.full_name }}</option>
          </select>
          <select v-model="form.assigned_doctor_id" class="ui-select sm:col-span-2">
            <option value="">{{ t('clinical.assignedDoctor') }} ({{ t('clinical.noDoctorAssigned') }})</option>
            <option v-for="d in doctors" :key="d.user_id" :value="d.user_id">
              {{ d.full_name || d.email }}
            </option>
          </select>
          <input v-model="form.appointment_date" type="datetime-local" required class="ui-input sm:col-span-2" />
          <select v-model="form.status" class="ui-select">
            <option value="scheduled">{{ t('clinical.stScheduled') }}</option>
            <option value="completed">{{ t('clinical.stCompleted') }}</option>
            <option value="cancelled">{{ t('clinical.stCancelled') }}</option>
          </select>
          <input v-model="form.notes" class="ui-input sm:col-span-2" :placeholder="t('clinical.notes')" />
        </div>

        <h3 class="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">
          {{ t('clinical.sectionVitals') }}
        </h3>
        <div class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label class="ui-label !mb-1">{{ t('clinical.bloodPressure') }} ({{ t('clinical.unitMmHg') }})</label>
            <input v-model="form.blood_pressure" class="ui-input" placeholder="100/67" />
          </div>
          <div>
            <label class="ui-label !mb-1">{{ t('clinical.heartRate') }}</label>
            <input v-model="form.heart_rate" type="number" min="0" class="ui-input" placeholder="89" />
          </div>
          <div>
            <label class="ui-label !mb-1">{{ t('clinical.spo2') }} (%)</label>
            <input v-model="form.spo2" type="number" min="0" max="100" class="ui-input" placeholder="98" />
          </div>
          <div>
            <label class="ui-label !mb-1">{{ t('clinical.temperature') }} (°C)</label>
            <input v-model="form.temperature_c" type="number" step="0.1" class="ui-input" placeholder="37.0" />
          </div>
          <div>
            <label class="ui-label !mb-1">{{ t('clinical.respiratoryRate') }}</label>
            <input v-model="form.respiratory_rate" type="number" min="0" class="ui-input" placeholder="24" />
          </div>
          <div>
            <label class="ui-label !mb-1">{{ t('clinical.weight') }} (kg)</label>
            <input v-model="form.weight_kg" type="number" step="0.01" min="0" class="ui-input" placeholder="100" />
          </div>
        </div>

        <button type="submit" class="ui-btn-primary">{{ t('common.save') }}</button>
      </form>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </div>

    <div class="ui-table-wrap mt-8">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('clinical.appointmentDate') }}</th>
            <th>{{ t('clinical.patient') }}</th>
            <th>{{ t('clinical.assignedDoctor') }}</th>
            <th>{{ t('clinical.status') }}</th>
            <th>{{ t('clinical.vitalsSummary') }}</th>
            <th>{{ t('clinical.notes') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="a in appointments" :key="a.id">
            <tr>
              <td class="whitespace-nowrap text-slate-800">{{ fmtLocal(a.appointment_date) }}</td>
              <td class="font-medium text-slate-900">{{ a.patient_name }}</td>
              <td class="text-sm text-slate-700">{{ a.assigned_doctor_name || '—' }}</td>
              <td>
                <select
                  class="ui-select max-w-[11rem] text-sm"
                  :value="a.status"
                  @change="updateStatus(a, $event.target.value)"
                >
                  <option value="scheduled">{{ t('clinical.stScheduled') }}</option>
                  <option value="completed">{{ t('clinical.stCompleted') }}</option>
                  <option value="cancelled">{{ t('clinical.stCancelled') }}</option>
                </select>
              </td>
              <td class="max-w-[14rem] text-xs leading-snug text-slate-700">
                <span :class="hasVitals(a) ? 'font-medium text-slate-900' : ''">{{ vitalsSummary(a) }}</span>
              </td>
              <td class="max-w-xs truncate text-slate-600">{{ a.notes || '—' }}</td>
              <td class="flex flex-wrap gap-2">
                <RouterLink
                  :to="{ name: 'clinical-appointment-detail', params: { id: a.id } }"
                  class="ui-btn-secondary !inline-flex !px-2 !py-1.5 text-sm no-underline"
                >
                  {{ t('clinical.openVisit') }}
                </RouterLink>
                <button type="button" class="ui-btn-secondary !px-2 !py-1.5 text-sm" @click="toggleVitalsEditor(a)">
                  {{ vitalsExpandedId === a.id ? t('common.cancel') : t('clinical.editVisitVitals') }}
                </button>
                <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(a.id)">
                  {{ t('accounts.delete') }}
                </button>
              </td>
            </tr>
            <tr v-if="vitalsExpandedId === a.id" class="bg-slate-50/90">
              <td colspan="7" class="!py-4">
                <div class="mx-auto max-w-3xl px-2">
                  <h4 class="mb-3 text-sm font-bold text-slate-800">{{ t('clinical.vitalsPerVisit') }}</h4>
                  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <label class="ui-label !mb-1">{{ t('clinical.bloodPressure') }}</label>
                      <input v-model="vitalsForm.blood_pressure" class="ui-input" placeholder="100/67" />
                    </div>
                    <div>
                      <label class="ui-label !mb-1">{{ t('clinical.heartRate') }}</label>
                      <input v-model="vitalsForm.heart_rate" type="number" min="0" class="ui-input" />
                    </div>
                    <div>
                      <label class="ui-label !mb-1">{{ t('clinical.spo2') }} (%)</label>
                      <input v-model="vitalsForm.spo2" type="number" min="0" max="100" class="ui-input" />
                    </div>
                    <div>
                      <label class="ui-label !mb-1">{{ t('clinical.temperature') }} (°C)</label>
                      <input v-model="vitalsForm.temperature_c" type="number" step="0.1" class="ui-input" />
                    </div>
                    <div>
                      <label class="ui-label !mb-1">{{ t('clinical.respiratoryRate') }}</label>
                      <input v-model="vitalsForm.respiratory_rate" type="number" min="0" class="ui-input" />
                    </div>
                    <div>
                      <label class="ui-label !mb-1">{{ t('clinical.weight') }} (kg)</label>
                      <input v-model="vitalsForm.weight_kg" type="number" step="0.01" min="0" class="ui-input" />
                    </div>
                  </div>
                  <div class="mt-4 flex flex-wrap gap-2">
                    <button type="button" class="ui-btn-primary text-sm" @click="saveVitalsForVisit(a)">
                      {{ t('common.save') }}
                    </button>
                    <button type="button" class="ui-btn-secondary text-sm" @click="vitalsExpandedId = null">
                      {{ t('common.cancel') }}
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="loading">
            <td colspan="7" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
