<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api/client';

const { t, locale } = useI18n();
const company = useCompanyStore();
const auth = useAuthStore();

const appointments = ref([]);
const loading = ref(false);
const error = ref('');

// Month cursor (local time)
const cursor = ref(new Date());
const viewMode = ref('month'); // 'month' | 'week' | 'day'
const cursorYear = computed(() => cursor.value.getFullYear());
const cursorMonth = computed(() => cursor.value.getMonth()); // 0-11

function shiftCursorPrevNext(step) {
  // step: -1 for prev, +1 for next
  if (viewMode.value === 'month') {
    cursor.value = new Date(cursorYear.value, cursorMonth.value + step, 1);
  } else if (viewMode.value === 'week') {
    const d = new Date(cursor.value);
    d.setDate(d.getDate() + step * 7);
    cursor.value = d;
  } else {
    const d = new Date(cursor.value);
    d.setDate(d.getDate() + step);
    cursor.value = d;
  }
}

const headerLabel = computed(() => {
  if (viewMode.value === 'month') {
    return cursor.value.toLocaleDateString(locale, { year: 'numeric', month: 'long' });
  }
  if (viewMode.value === 'week') {
    const start = weekDays.value[0];
    const end = weekDays.value[6];
    return `${start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(
      locale,
      { month: 'short', day: 'numeric' }
    )}`;
  }
  return cursor.value.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
});

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toDatetimeLocalValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`;
}

function fromDatetimeLocalValue(localValue) {
  // JS treats "YYYY-MM-DDTHH:mm" as local time in browsers.
  return new Date(localValue);
}

const weekHeaders = computed(() => {
  if (locale.value === 'ar') {
    return ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  }
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
});

const gridDays = computed(() => {
  const y = cursorYear.value;
  const m = cursorMonth.value;

  const firstOfMonth = new Date(y, m, 1);
  const startDow = firstOfMonth.getDay(); // 0=Sun

  const gridStart = new Date(y, m, 1 - startDow);
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push({ date: d, inMonth: d.getMonth() === m });
  }
  return days;
});

const weekDays = computed(() => {
  const anchor = new Date(cursor.value);
  const start = new Date(anchor);
  start.setDate(anchor.getDate() - anchor.getDay()); // Sunday start
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
});

const dayAppointments = computed(() => {
  const key = toDayKey(new Date(cursor.value));
  return appointmentsByDay.value.get(key) || [];
});

const appointmentsByDay = computed(() => {
  const map = new Map();
  for (const ap of appointments.value) {
    const d = new Date(ap.appointment_date);
    const key = toDayKey(d);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ap);
  }
  // Sort each day by time
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => new Date(a.appointment_date).getTime() - new Date(b.appointment_date).getTime());
    map.set(k, arr);
  }
  return map;
});

// Patients & doctors used by the create/edit modal
const patients = ref([]);
const doctors = ref([]);

const patientSearch = ref('');
const patientPickerOpen = ref(false);
const filteredPatients = computed(() => {
  const q = patientSearch.value.trim().toLowerCase();
  if (!q) return patients.value;
  return patients.value.filter((p) => (p.full_name || '').toLowerCase().includes(q));
});

function statusPillClass(status) {
  if (status === 'scheduled') return 'bg-blue-50 text-blue-700 ring-blue-100';
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
  if (status === 'canceled') return 'bg-rose-50 text-rose-700 ring-rose-100';
  return 'bg-slate-50 text-slate-700 ring-slate-100';
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

async function loadPatients() {
  try {
    const { data } = await api.get('/api/patients');
    patients.value = data.patients || [];
  } catch {
    patients.value = [];
  }
}

async function loadDoctors() {
  try {
    // doctor-profiles endpoint already filters to active role=doctor members.
    const { data } = await api.get('/api/doctor-profiles');
    doctors.value = data.doctors || [];
  } catch {
    doctors.value = [];
  }
}

async function loadAppointmentsForCursor() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    let start;
    let end;
    if (viewMode.value === 'month') {
      start = new Date(cursorYear.value, cursorMonth.value, 1, 0, 0, 0, 0);
      end = new Date(cursorYear.value, cursorMonth.value + 1, 1, 0, 0, 0, 0);
    } else if (viewMode.value === 'week') {
      start = new Date(weekDays.value[0]);
      end = new Date(start);
      end.setDate(start.getDate() + 7);
    } else {
      start = new Date(cursor.value);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(start.getDate() + 1);
    }
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    const { data } = await api.get('/api/appointments/calendar', {
      params: {
        start_date: startIso,
        end_date: endIso,
      },
    });
    appointments.value = data.appointments || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    appointments.value = [];
  } finally {
    loading.value = false;
  }
}

// Modal state (create/edit)
const modalOpen = ref(false);
const modalMode = ref('create'); // 'create' | 'edit'
const editingId = ref(null);

const form = ref({
  patient_id: '',
  assigned_doctor_id: '',
  appointment_date_local: '',
  status: 'scheduled',
  notes: '',
});

function closeModal() {
  modalOpen.value = false;
  editingId.value = null;
  modalMode.value = 'create';
  patientSearch.value = '';
  patientPickerOpen.value = false;
}

function openCreateForDay(dayDate) {
  const d = new Date(dayDate);
  const time = new Date();
  time.setHours(9, 0, 0, 0);

  const role = company.currentCompanyRole;
  const defaultDoctorId = role === 'doctor' ? auth.user?.id || '' : '';

  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), time.getHours(), time.getMinutes(), 0, 0);
  form.value = {
    patient_id: '',
    assigned_doctor_id: defaultDoctorId,
    appointment_date_local: toDatetimeLocalValue(dt),
    status: 'scheduled',
    notes: '',
  };
  patientSearch.value = '';
  patientPickerOpen.value = false;
  modalMode.value = 'create';
  editingId.value = null;
  modalOpen.value = true;
}

function openEdit(ap) {
  modalMode.value = 'edit';
  editingId.value = ap.id;
  const dt = new Date(ap.appointment_date);
  form.value = {
    patient_id: ap.patient_id,
    assigned_doctor_id: ap.doctor_id || '',
    appointment_date_local: toDatetimeLocalValue(dt),
    status: ap.status || 'scheduled',
    notes: ap.notes || '',
  };
  patientSearch.value = ap.patient_name || '';
  patientPickerOpen.value = false;
  modalOpen.value = true;
}

function selectedPatientName() {
  const p = patients.value.find((x) => x.id === form.value.patient_id);
  return p ? p.full_name : '';
}

function selectedDoctorName() {
  const d = doctors.value.find((x) => x.user_id === form.value.assigned_doctor_id);
  return d ? d.full_name || d.email : '';
}

async function saveAppointment() {
  const patientId = form.value.patient_id;
  const doctorId = form.value.assigned_doctor_id;
  const status = form.value.status;
  const localVal = form.value.appointment_date_local;

  if (!patientId) {
    error.value = t('clinical.validationRequired');
    return;
  }
  if (!doctorId) {
    error.value = t('clinical.validationRequired');
    return;
  }
  if (!localVal) {
    error.value = t('clinical.validationRequired');
    return;
  }

  const appointmentDateIso = fromDatetimeLocalValue(localVal).toISOString();

  error.value = '';
  try {
    const body = {
      patient_id: patientId,
      assigned_doctor_id: doctorId,
      appointment_date: appointmentDateIso,
      status,
      notes: form.value.notes || undefined,
    };

    if (modalMode.value === 'create') {
      await api.post('/api/appointments', body);
    } else {
      await api.put(`/api/appointments/${editingId.value}`, body);
    }

    closeModal();
    await loadAppointmentsForCursor();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function deleteAppointment() {
  if (modalMode.value !== 'edit' || !editingId.value) return;
  if (!confirm(t('clinical.confirmDelete'))) return;
  try {
    await api.delete(`/api/appointments/${editingId.value}`);
    closeModal();
    await loadAppointmentsForCursor();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(async () => {
  await Promise.all([loadPatients(), loadDoctors()]);
  await loadAppointmentsForCursor();
});

watch(
  () => company.currentCompanyId,
  async () => {
    await Promise.all([loadPatients(), loadDoctors()]);
    await loadAppointmentsForCursor();
    closeModal();
  }
);

watch(
  [viewMode, () => cursor.value.getTime()],
  async () => {
    await loadAppointmentsForCursor();
  }
);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('clinical.calendarTitle') }}</h1>
      <p class="ui-page-desc">{{ t('clinical.calendarSubtitle') }}</p>
    </div>

    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="ui-btn-secondary !px-3" @click="shiftCursorPrevNext(-1)">
          ←
        </button>
        <div class="min-w-[14rem] text-center text-sm font-semibold text-slate-800">
          {{ headerLabel }}
        </div>
        <button type="button" class="ui-btn-secondary !px-3" @click="shiftCursorPrevNext(1)">
          →
        </button>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="ui-btn-secondary !px-3"
            :class="viewMode === 'month' ? 'ring-2 ring-brand-200' : ''"
            @click="viewMode = 'month'"
          >
            {{ locale === 'ar' ? 'شهر' : 'Month' }}
          </button>
          <button
            type="button"
            class="ui-btn-secondary !px-3"
            :class="viewMode === 'week' ? 'ring-2 ring-brand-200' : ''"
            @click="viewMode = 'week'"
          >
            {{ locale === 'ar' ? 'أسبوع' : 'Week' }}
          </button>
          <button
            type="button"
            class="ui-btn-secondary !px-3"
            :class="viewMode === 'day' ? 'ring-2 ring-brand-200' : ''"
            @click="viewMode = 'day'"
          >
            {{ locale === 'ar' ? 'يوم' : 'Day' }}
          </button>
        </div>
      </div>

      <button type="button" class="ui-btn-primary" @click="openCreateForDay(cursor)">
        {{ t('clinical.addAppointment') }}
      </button>
    </div>

    <p v-if="error" class="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
      {{ error }}
    </p>

    <div v-if="loading" class="py-10 text-center text-slate-500">
      {{ t('common.loading') }}
    </div>

    <div v-else class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <!-- Month view -->
      <div v-if="viewMode === 'month'">
        <div class="grid grid-cols-7 gap-1">
          <div
            v-for="(w, i) in weekHeaders"
            :key="i"
            class="px-2 py-2 text-center text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            {{ w }}
          </div>
        </div>

        <div class="mt-1 grid grid-cols-7 gap-1">
          <div
            v-for="(cell, idx) in gridDays"
            :key="idx"
            class="min-h-[7.5rem] rounded-lg border border-slate-100 bg-slate-50/30 p-2"
            :class="cell.inMonth ? 'hover:bg-white' : 'opacity-60'"
            role="button"
            tabindex="0"
            @click="openCreateForDay(cell.date)"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="text-xs font-semibold text-slate-700">
                {{ cell.date.getDate() }}
              </div>
              <div v-if="appointmentsByDay.get(toDayKey(cell.date))?.length" class="text-xs text-slate-400">
                {{ appointmentsByDay.get(toDayKey(cell.date))?.length }}
              </div>
            </div>

            <div class="mt-2 flex flex-col gap-1">
              <button
                v-for="ap in (appointmentsByDay.get(toDayKey(cell.date)) || []).slice(0, 3)"
                :key="ap.id"
                type="button"
                class="w-full truncate rounded-md px-2 py-1 text-left text-xs ring-1"
                :class="statusPillClass(ap.status)"
                @click.stop="openEdit(ap)"
              >
                <div class="truncate font-medium">
                  {{ ap.patient_name || t('clinical.patient') }}
                </div>
                <div class="truncate text-[11px] opacity-90">
                  {{ ap.doctor_name || t('clinical.doctor') }}
                </div>
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-[11px] opacity-90">{{ formatTime(ap.appointment_date) }}</span>
                </div>
              </button>
              <div
                v-if="(appointmentsByDay.get(toDayKey(cell.date)) || []).length > 3"
                class="text-[11px] text-slate-500"
              >
                +{{ (appointmentsByDay.get(toDayKey(cell.date)) || []).length - 3 }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Week view -->
      <div v-else-if="viewMode === 'week'" class="mt-1">
        <div class="grid grid-cols-7 gap-2">
          <div
            v-for="(d, idx) in weekDays"
            :key="idx"
            class="min-h-[10rem] rounded-lg border border-slate-100 bg-slate-50/30 p-2"
            role="button"
            tabindex="0"
            @click="openCreateForDay(d)"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="text-xs font-semibold text-slate-700">
                {{ d.getDate() }}
              </div>
              <div v-if="appointmentsByDay.get(toDayKey(d))?.length" class="text-xs text-slate-400">
                {{ appointmentsByDay.get(toDayKey(d))?.length }}
              </div>
            </div>
            <div class="mt-2 flex flex-col gap-1">
              <button
                v-for="ap in (appointmentsByDay.get(toDayKey(d)) || [])"
                :key="ap.id"
                type="button"
                class="w-full truncate rounded-md px-2 py-1 text-left text-xs ring-1"
                :class="statusPillClass(ap.status)"
                @click.stop="openEdit(ap)"
              >
                <div class="truncate font-medium">{{ ap.patient_name || t('clinical.patient') }}</div>
                <div class="truncate text-[11px] opacity-90">{{ ap.doctor_name || t('clinical.doctor') }}</div>
                <div class="truncate text-[11px] opacity-90">{{ formatTime(ap.appointment_date) }}</div>
              </button>
              <div
                v-if="(appointmentsByDay.get(toDayKey(d)) || []).length === 0"
                class="mt-3 text-center text-xs text-slate-500"
              >
                {{ t('clinical.noAppointmentsYet') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Day view -->
      <div v-else class="mt-1">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div class="text-sm font-semibold text-slate-800">
            {{ cursor.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) }}
          </div>
        </div>
        <div class="flex flex-col gap-2">
          <div v-if="dayAppointments.length === 0" class="py-10 text-center text-slate-500">
            {{ t('clinical.noAppointmentsYet') }}
          </div>
          <button
            v-for="ap in dayAppointments"
            :key="ap.id"
            type="button"
            class="rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm"
            @click="openEdit(ap)"
          >
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-[14rem]">
                <div class="text-sm font-semibold text-slate-900">
                  {{ ap.patient_name || t('clinical.patient') }}
                </div>
                <div class="mt-1 text-xs text-slate-600">
                  {{ ap.doctor_name || t('clinical.doctor') }}
                </div>
              </div>
              <div class="text-right">
                <div class="text-sm font-medium text-slate-900">{{ formatTime(ap.appointment_date) }}</div>
                <div
                  class="mt-1 inline-flex rounded-full px-2 py-1 text-[11px] ring-1"
                  :class="statusPillClass(ap.status)"
                >
                  {{ ap.status }}
                </div>
              </div>
            </div>
            <div class="mt-2 text-xs text-slate-600 line-clamp-2">
              {{ ap.notes || '—' }}
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- Modal -->
    <div v-if="modalOpen" class="fixed inset-0 z-50">
      <div class="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" @click="closeModal" />
      <div class="relative mx-auto mt-8 w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-lg font-bold text-slate-900">
              {{ modalMode === 'edit' ? t('clinical.editAppointment') : t('clinical.addAppointment') }}
            </h2>
            <p class="mt-1 text-sm text-slate-600">{{ t('clinical.appointmentFormHint') }}</p>
          </div>
          <button type="button" class="ui-btn-secondary !px-3" @click="closeModal">
            {{ t('common.cancel') }}
          </button>
        </div>

        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div class="sm:col-span-2">
            <label class="ui-label">{{ t('clinical.patient') }} *</label>
            <div class="relative">
              <input
                v-model="patientSearch"
                class="ui-input w-full"
                :placeholder="t('clinical.searchPatient')"
                @focus="patientPickerOpen = true"
              />
              <div
                v-if="patientPickerOpen && filteredPatients.length"
                class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
              >
                <button
                  v-for="p in filteredPatients.slice(0, 30)"
                  :key="p.id"
                  type="button"
                  class="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
                  @click="
                    form.patient_id = p.id;
                    patientPickerOpen = false;
                    patientSearch = p.full_name || '';
                  "
                >
                  {{ p.full_name }}
                </button>
              </div>
            </div>
          </div>

          <div>
            <label class="ui-label">{{ t('clinical.doctor') }} *</label>
            <select
              v-model="form.assigned_doctor_id"
              class="ui-select w-full"
              :disabled="company.currentCompanyRole === 'doctor'"
            >
              <option value="">{{ t('clinical.selectDoctor') }}</option>
              <option v-for="d in doctors" :key="d.user_id" :value="d.user_id">
                {{ d.full_name || d.email }}
              </option>
            </select>
          </div>

          <div>
            <label class="ui-label">{{ t('clinical.appointmentDate') }} *</label>
            <input type="datetime-local" v-model="form.appointment_date_local" class="ui-input w-full" />
          </div>

          <div>
            <label class="ui-label">{{ t('clinical.status') }}</label>
            <select v-model="form.status" class="ui-select w-full">
              <option value="scheduled">{{ t('clinical.stScheduled') }}</option>
              <option value="completed">{{ t('clinical.stCompleted') }}</option>
              <option value="canceled">{{ t('clinical.stCancelled') }}</option>
            </select>
          </div>

          <div class="sm:col-span-2">
            <label class="ui-label">{{ t('clinical.notes') }}</label>
            <textarea v-model="form.notes" class="ui-input min-h-[5rem] w-full" rows="4" />
          </div>
        </div>

        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" class="ui-btn-primary" @click="saveAppointment">
            {{ t('common.save') }}
          </button>
          <button
            v-if="modalMode === 'edit'"
            type="button"
            class="ui-btn-danger"
            @click="deleteAppointment"
          >
            {{ t('accounts.delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

