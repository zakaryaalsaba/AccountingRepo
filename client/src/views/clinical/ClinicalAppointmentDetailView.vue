<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api/client';

const { t } = useI18n();
const route = useRoute();
const company = useCompanyStore();
const auth = useAuthStore();

const loading = ref(true);
const error = ref('');
const appointment = ref(null);
const patient = ref(null);
const prescriptions = ref([]);
const labOrders = ref([]);
const doctors = ref([]);

const visitNotes = ref('');
const visitDoctorId = ref('');
const visitSaving = ref(false);

const rxForm = ref({
  medication_name: '',
  dosage: '',
  instructions: '',
  service_fee: '',
  doctor_id: '',
});
const rxEditingId = ref(null);
const rxFieldErrors = ref({});

const labForm = ref({
  test_name: '',
  instructions: '',
  status: 'ordered',
  test_fee: '',
  results: '',
  doctor_id: '',
});
const labEditingId = ref(null);
const labFieldErrors = ref({});

const appointmentId = computed(() => route.params.id);

function defaultDoctorId() {
  const a = appointment.value;
  // For dropdown-driven doctor selection we only default to an already-assigned doctor.
  // This avoids pre-filling non-doctors (e.g. owner/receptionist) after doctor dropdown filtering.
  if (!a) return '';
  return a.assigned_doctor_id || '';
}

function vitalsPayload(a) {
  if (!a) return {};
  return {
    blood_pressure: a.blood_pressure || null,
    heart_rate: a.heart_rate != null ? a.heart_rate : null,
    spo2: a.spo2 != null ? a.spo2 : null,
    temperature_c: a.temperature_c != null ? a.temperature_c : null,
    respiratory_rate: a.respiratory_rate != null ? a.respiratory_rate : null,
    weight_kg: a.weight_kg != null ? a.weight_kg : null,
  };
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

async function loadDetail() {
  if (!company.currentCompanyId || !appointmentId.value) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get(`/api/appointments/${appointmentId.value}`);
    appointment.value = data.appointment;
    patient.value = data.patient;
    prescriptions.value = data.prescriptions || [];
    labOrders.value = data.lab_orders || [];
    visitNotes.value = data.appointment?.notes || '';
    visitDoctorId.value = data.appointment?.assigned_doctor_id || '';
    rxForm.value.doctor_id = defaultDoctorId();
    labForm.value.doctor_id = defaultDoctorId();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    appointment.value = null;
  } finally {
    loading.value = false;
  }
}

async function saveVisitNotes() {
  const a = appointment.value;
  if (!a) return;
  visitSaving.value = true;
  error.value = '';
  try {
    await api.put(`/api/appointments/${a.id}`, {
      patient_id: a.patient_id,
      appointment_date: a.appointment_date,
      status: a.status,
      notes: visitNotes.value || null,
      assigned_doctor_id: visitDoctorId.value || null,
      ...vitalsPayload(a),
    });
    await loadDetail();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    visitSaving.value = false;
  }
}

function resetRxForm() {
  rxEditingId.value = null;
  rxFieldErrors.value = {};
  rxForm.value = {
    medication_name: '',
    dosage: '',
    instructions: '',
    service_fee: '',
    doctor_id: defaultDoctorId(),
  };
}

function editRx(row) {
  rxEditingId.value = row.id;
  rxFieldErrors.value = {};
  rxForm.value = {
    medication_name: row.medication_name || '',
    dosage: row.dosage || '',
    instructions: row.instructions || '',
    service_fee: row.service_fee != null ? String(row.service_fee) : '',
    doctor_id: row.doctor_id,
  };
}

async function saveRx() {
  rxFieldErrors.value = {};
  if (!rxForm.value.medication_name?.trim()) {
    rxFieldErrors.value.medication_name = t('clinical.validationRequired');
    return;
  }
  if (!rxForm.value.doctor_id) {
    rxFieldErrors.value.doctor_id = t('clinical.validationRequired');
    return;
  }
  const a = appointment.value;
  if (!a) return;
  error.value = '';
  const body = {
    appointment_id: a.id,
    patient_id: a.patient_id,
    doctor_id: rxForm.value.doctor_id,
    medication_name: rxForm.value.medication_name.trim(),
    dosage: rxForm.value.dosage || undefined,
    instructions: rxForm.value.instructions || undefined,
    service_fee: rxForm.value.service_fee === '' ? undefined : Number(rxForm.value.service_fee),
  };
  try {
    if (rxEditingId.value) {
      await api.put(`/api/prescriptions/${rxEditingId.value}`, body);
    } else {
      await api.post('/api/prescriptions', body);
    }
    resetRxForm();
    await loadDetail();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function deleteRx(id) {
  if (!confirm(t('clinical.confirmDelete'))) return;
  error.value = '';
  try {
    await api.delete(`/api/prescriptions/${id}`);
    if (rxEditingId.value === id) resetRxForm();
    await loadDetail();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function resetLabForm() {
  labEditingId.value = null;
  labFieldErrors.value = {};
  labForm.value = {
    test_name: '',
    instructions: '',
    status: 'ordered',
    test_fee: '',
    results: '',
    doctor_id: defaultDoctorId(),
  };
}

function editLab(row) {
  labEditingId.value = row.id;
  labFieldErrors.value = {};
  let resultsStr = '';
  if (row.results != null) {
    resultsStr =
      typeof row.results === 'object' && row.results.text != null
        ? String(row.results.text)
        : typeof row.results === 'string'
          ? row.results
          : JSON.stringify(row.results, null, 2);
  }
  labForm.value = {
    test_name: row.test_name || '',
    instructions: row.instructions || '',
    status: row.status || 'ordered',
    test_fee: row.test_fee != null ? String(row.test_fee) : '',
    results: resultsStr,
    doctor_id: row.doctor_id,
  };
}

async function saveLab() {
  labFieldErrors.value = {};
  if (!labForm.value.test_name?.trim()) {
    labFieldErrors.value.test_name = t('clinical.validationRequired');
    return;
  }
  if (!labForm.value.doctor_id) {
    labFieldErrors.value.doctor_id = t('clinical.validationRequired');
    return;
  }
  const a = appointment.value;
  if (!a) return;
  error.value = '';
  const body = {
    appointment_id: a.id,
    patient_id: a.patient_id,
    doctor_id: labForm.value.doctor_id,
    test_name: labForm.value.test_name.trim(),
    instructions: labForm.value.instructions || undefined,
    status: labForm.value.status,
    test_fee: labForm.value.test_fee === '' ? undefined : Number(labForm.value.test_fee),
    results: labForm.value.results?.trim() ? labForm.value.results.trim() : undefined,
  };
  try {
    if (labEditingId.value) {
      await api.put(`/api/lab-orders/${labEditingId.value}`, body);
    } else {
      await api.post('/api/lab-orders', body);
    }
    resetLabForm();
    await loadDetail();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function deleteLab(id) {
  if (!confirm(t('clinical.confirmDelete'))) return;
  error.value = '';
  try {
    await api.delete(`/api/lab-orders/${id}`);
    if (labEditingId.value === id) resetLabForm();
    await loadDetail();
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

function fmtDob(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return d;
  }
}

function statusLabel(s) {
  if (s === 'ordered') return t('clinical.labStatusOrdered');
  if (s === 'completed') return t('clinical.labStatusCompleted');
  if (s === 'canceled') return t('clinical.labStatusCanceled');
  return s || '—';
}

onMounted(async () => {
  await loadDoctors();
  await loadDetail();
});
watch(
  () => [company.currentCompanyId, appointmentId.value],
  async () => {
    await loadDoctors();
    await loadDetail();
  }
);
watch(
  () => appointment.value?.id,
  () => {
    if (!rxEditingId.value) rxForm.value.doctor_id = defaultDoctorId();
    if (!labEditingId.value) labForm.value.doctor_id = defaultDoctorId();
  }
);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <RouterLink
        to="/clinical/appointments"
        class="mb-3 inline-block text-sm font-medium text-brand-600 hover:text-brand-800"
      >
        ← {{ t('clinical.backToAppointments') }}
      </RouterLink>
      <h1 class="ui-page-title">{{ t('clinical.appointmentDetailTitle') }}</h1>
      <p class="ui-page-desc">{{ t('clinical.appointmentDetailSubtitle') }}</p>
    </div>

    <p v-if="error" class="mb-6 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
      {{ error }}
    </p>

    <div v-if="loading" class="py-16 text-center text-slate-500">{{ t('common.loading') }}</div>

    <template v-else-if="appointment && patient">
      <div class="grid gap-6 lg:grid-cols-2">
        <div class="ui-card ui-card-pad">
          <h2 class="ui-card-title mb-4">{{ t('clinical.sectionPatient') }}</h2>
          <dl class="space-y-2 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('clinical.fullName') }}</dt>
              <dd class="font-medium text-slate-900">{{ patient.full_name }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('clinical.phone') }}</dt>
              <dd>{{ patient.phone || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('clinical.email') }}</dt>
              <dd class="truncate">{{ patient.email || '—' }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('clinical.dateOfBirth') }}</dt>
              <dd>{{ fmtDob(patient.date_of_birth) }}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-slate-500">{{ t('clinical.bloodGroup') }}</dt>
              <dd>{{ patient.blood_group || '—' }}</dd>
            </div>
          </dl>
        </div>

        <div class="ui-card ui-card-pad">
          <h2 class="ui-card-title mb-4">{{ t('clinical.sectionVisit') }}</h2>
          <p class="mb-3 text-sm text-slate-600">
            {{ fmtLocal(appointment.appointment_date) }} · {{ appointment.patient_name }}
          </p>
          <p class="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            {{ t('clinical.assignedDoctor') }}
          </p>
          <select v-model="visitDoctorId" class="ui-select mb-4 w-full max-w-md">
            <option value="">{{ t('clinical.noDoctorAssigned') }}</option>
            <option v-for="d in doctors" :key="d.user_id" :value="d.user_id">
              {{ d.full_name || d.email }}
            </option>
          </select>
          <label class="ui-label">{{ t('clinical.notes') }}</label>
          <textarea v-model="visitNotes" class="ui-input mb-4 min-h-[6rem] w-full" rows="4" />
          <button type="button" class="ui-btn-primary" :disabled="visitSaving" @click="saveVisitNotes">
            {{ visitSaving ? t('common.loading') : t('common.save') }}
          </button>
        </div>
      </div>

      <div class="ui-card ui-card-pad mt-8">
        <h2 class="ui-card-title mb-4">{{ t('clinical.sectionPrescriptions') }}</h2>
        <div class="ui-table-wrap mb-6">
          <table class="ui-table text-sm">
            <thead>
              <tr>
                <th>{{ t('clinical.medicationName') }}</th>
                <th>{{ t('clinical.dosage') }}</th>
                <th>{{ t('clinical.doctor') }}</th>
                <th>{{ t('clinical.serviceFee') }}</th>
                <th>{{ t('common.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="pr in prescriptions" :key="pr.id">
                <td class="font-medium">{{ pr.medication_name }}</td>
                <td>{{ pr.dosage || '—' }}</td>
                <td>{{ pr.doctor_name }}</td>
                <td>{{ pr.service_fee != null ? pr.service_fee : '—' }}</td>
                <td class="flex flex-wrap gap-2">
                  <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="editRx(pr)">
                    {{ t('clinical.edit') }}
                  </button>
                  <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="deleteRx(pr.id)">
                    {{ t('accounts.delete') }}
                  </button>
                </td>
              </tr>
              <tr v-if="!prescriptions.length">
                <td colspan="5" class="py-6 text-center text-slate-500">{{ t('clinical.noPrescriptionsYet') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3 class="mb-3 text-sm font-bold text-slate-800">
          {{ rxEditingId ? t('clinical.editPrescription') : t('clinical.addPrescription') }}
        </h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="ui-label">{{ t('clinical.doctor') }}</label>
            <select v-model="rxForm.doctor_id" required class="ui-select w-full">
              <option value="">{{ t('clinical.selectDoctor') }}</option>
              <option v-for="d in doctors" :key="d.user_id" :value="d.user_id">
                {{ d.full_name || d.email }}
              </option>
            </select>
            <p v-if="rxFieldErrors.doctor_id" class="mt-1 text-xs text-rose-600">{{ rxFieldErrors.doctor_id }}</p>
          </div>
          <div>
            <label class="ui-label">{{ t('clinical.medicationName') }} *</label>
            <input v-model="rxForm.medication_name" class="ui-input w-full" required />
            <p v-if="rxFieldErrors.medication_name" class="mt-1 text-xs text-rose-600">
              {{ rxFieldErrors.medication_name }}
            </p>
          </div>
          <div>
            <label class="ui-label">{{ t('clinical.dosage') }}</label>
            <input v-model="rxForm.dosage" class="ui-input w-full" />
          </div>
          <div>
            <label class="ui-label">{{ t('clinical.serviceFee') }}</label>
            <input v-model="rxForm.service_fee" type="number" min="0" step="0.01" class="ui-input w-full" />
          </div>
          <div class="sm:col-span-2">
            <label class="ui-label">{{ t('clinical.instructions') }}</label>
            <textarea v-model="rxForm.instructions" class="ui-input min-h-[4rem] w-full" />
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="ui-btn-primary" @click="saveRx">{{ t('common.save') }}</button>
          <button v-if="rxEditingId" type="button" class="ui-btn-secondary" @click="resetRxForm">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>

      <div class="ui-card ui-card-pad mt-8">
        <h2 class="ui-card-title mb-4">{{ t('clinical.sectionLabOrders') }}</h2>
        <div class="ui-table-wrap mb-6">
          <table class="ui-table text-sm">
            <thead>
              <tr>
                <th>{{ t('clinical.testName') }}</th>
                <th>{{ t('clinical.status') }}</th>
                <th>{{ t('clinical.doctor') }}</th>
                <th>{{ t('clinical.testFee') }}</th>
                <th>{{ t('clinical.results') }}</th>
                <th>{{ t('common.actions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="lo in labOrders" :key="lo.id">
                <td class="font-medium">{{ lo.test_name }}</td>
                <td>{{ statusLabel(lo.status) }}</td>
                <td>{{ lo.doctor_name }}</td>
                <td>{{ lo.test_fee != null ? lo.test_fee : '—' }}</td>
                <td class="max-w-[12rem] truncate text-slate-600">
                  {{
                    lo.results == null
                      ? '—'
                      : typeof lo.results === 'object' && lo.results.text != null
                        ? lo.results.text
                        : JSON.stringify(lo.results)
                  }}
                </td>
                <td class="flex flex-wrap gap-2">
                  <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="editLab(lo)">
                    {{ t('clinical.edit') }}
                  </button>
                  <button type="button" class="ui-btn-danger !px-2 !py-1 text-xs" @click="deleteLab(lo.id)">
                    {{ t('accounts.delete') }}
                  </button>
                </td>
              </tr>
              <tr v-if="!labOrders.length">
                <td colspan="6" class="py-6 text-center text-slate-500">{{ t('clinical.noLabOrdersYet') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <h3 class="mb-3 text-sm font-bold text-slate-800">
          {{ labEditingId ? t('clinical.editLabOrder') : t('clinical.addLabOrder') }}
        </h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="ui-label">{{ t('clinical.doctor') }}</label>
            <select v-model="labForm.doctor_id" class="ui-select w-full">
              <option value="">{{ t('clinical.selectDoctor') }}</option>
              <option v-for="d in doctors" :key="d.user_id" :value="d.user_id">
                {{ d.full_name || d.email }}
              </option>
            </select>
            <p v-if="labFieldErrors.doctor_id" class="mt-1 text-xs text-rose-600">{{ labFieldErrors.doctor_id }}</p>
          </div>
          <div>
            <label class="ui-label">{{ t('clinical.testName') }} *</label>
            <input v-model="labForm.test_name" class="ui-input w-full" />
            <p v-if="labFieldErrors.test_name" class="mt-1 text-xs text-rose-600">{{ labFieldErrors.test_name }}</p>
          </div>
          <div>
            <label class="ui-label">{{ t('clinical.status') }}</label>
            <select v-model="labForm.status" class="ui-select w-full">
              <option value="ordered">{{ t('clinical.labStatusOrdered') }}</option>
              <option value="completed">{{ t('clinical.labStatusCompleted') }}</option>
              <option value="canceled">{{ t('clinical.labStatusCanceled') }}</option>
            </select>
          </div>
          <div>
            <label class="ui-label">{{ t('clinical.testFee') }}</label>
            <input v-model="labForm.test_fee" type="number" min="0" step="0.01" class="ui-input w-full" />
          </div>
          <div class="sm:col-span-2">
            <label class="ui-label">{{ t('clinical.instructions') }}</label>
            <textarea v-model="labForm.instructions" class="ui-input min-h-[3rem] w-full" />
          </div>
          <div class="sm:col-span-2">
            <label class="ui-label">{{ t('clinical.results') }}</label>
            <textarea v-model="labForm.results" class="ui-input min-h-[5rem] w-full" :placeholder="t('clinical.resultsPlaceholder')" />
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="ui-btn-primary" @click="saveLab">{{ t('common.save') }}</button>
          <button v-if="labEditingId" type="button" class="ui-btn-secondary" @click="resetLabForm">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>
    </template>

    <p v-else class="text-slate-500">{{ t('clinical.appointmentNotFound') }}</p>
  </div>
</template>
