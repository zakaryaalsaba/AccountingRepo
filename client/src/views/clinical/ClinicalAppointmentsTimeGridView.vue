<script setup>
import { computed, onMounted, ref, watch } from 'vue';
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

// View modes: daily time-grid and optional 7-day week time-grid.
const viewMode = ref('day'); // 'day' | 'week'
const cursorDate = ref(new Date()); // anchor date for current view

// Configurable settings (stored per-company if possible).
const defaultSettings = {
  startTime: '07:00',
  endTime: '19:00',
  slotIntervalMin: 30,
  colorBy: 'doctor', // 'doctor' | 'status'
};

function getSettingsStorageKey() {
  const cId = company.currentCompanyId;
  if (cId) return `alamar.calendarSettings.company.${cId}`;
  const uId = auth.user?.id;
  if (uId) return `alamar.calendarSettings.user.${uId}`;
  return 'alamar.calendarSettings.anon';
}

function parseHHMM(hhmm) {
  const [hStr, mStr] = String(hhmm || '').split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23) return null;
  if (m < 0 || m > 59) return null;
  return h * 60 + m;
}

function minutesToHHMM(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseTimePartOrDefault(hhmm, fallback) {
  const v = parseHHMM(hhmm);
  if (v == null) {
    const fb = parseHHMM(fallback);
    return fb ?? 0;
  }
  return v;
}

const settings = ref({ ...defaultSettings });

function loadSettings() {
  try {
    const raw = localStorage.getItem(getSettingsStorageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    settings.value = { ...defaultSettings, ...parsed };
  } catch {
    // ignore
  }
}

function persistSettings() {
  try {
    localStorage.setItem(getSettingsStorageKey(), JSON.stringify(settings.value));
  } catch {
    // ignore
  }
}

watch(
  () => getSettingsStorageKey(),
  () => {
    loadSettings();
  }
);

watch(
  () => settings.value,
  () => {
    persistSettings();
  },
  { deep: true }
);

// Helpers for rendering keys/labels.
function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDayKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toDatetimeLocalValue(d) {
  // For <input type="datetime-local"> which expects local time without timezone.
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}`;
}

function fromDatetimeLocalValue(localValue) {
  // Browsers treat YYYY-MM-DDTHH:mm as local time.
  return new Date(localValue);
}

function isSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfWeekMonday(d) {
  const x = new Date(d);
  // JS: 0=Sun ... 6=Sat. We want Monday as start -> offset (day+6)%7
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  x.setHours(0, 0, 0, 0);
  return x;
}

const days = computed(() => {
  if (viewMode.value === 'day') return [new Date(cursorDate.value)];
  const start = startOfWeekMonday(cursorDate.value);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
});

const dayHeaders = computed(() => {
  const fmtOptions = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };
  return days.value.map((d) => ({
    d,
    name: d.toLocaleDateString(locale, { weekday: 'long' }),
    short: d.toLocaleDateString(locale, { weekday: 'short' }),
    dateLine: d.toLocaleDateString(locale, fmtOptions),
  }));
});

const timeConfig = computed(() => {
  const startMinutes = parseTimePartOrDefault(settings.value.startTime, defaultSettings.startTime);
  const endMinutes = parseTimePartOrDefault(settings.value.endTime, defaultSettings.endTime);
  const intervalMin = parseInt(settings.value.slotIntervalMin, 10) || defaultSettings.slotIntervalMin;

  // Validate: ensure end > start.
  if (endMinutes <= startMinutes) {
    return {
      startMinutes,
      endMinutes: startMinutes + intervalMin * 4, // fallback to a reasonable window
      intervalMin,
    };
  }

  return { startMinutes, endMinutes, intervalMin };
});

const slotList = computed(() => {
  const { startMinutes, endMinutes, intervalMin } = timeConfig.value;
  const slots = [];
  for (let m = startMinutes; m < endMinutes; m += intervalMin) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const label = new Date(2000, 0, 1, h, mm).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
    slots.push({ minutes: m, label });
  }
  return slots;
});

const rangeForApi = computed(() => {
  const start = new Date(days.value[0]);
  start.setHours(0, 0, 0, 0);

  const end = new Date(days.value[days.value.length - 1]);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);

  return { start, end };
});

async function loadAppointmentsForRange() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const startIso = rangeForApi.value.start.toISOString();
    const endIso = rangeForApi.value.end.toISOString();
    const { data } = await api.get('/api/appointments/calendar', {
      params: { start_date: startIso, end_date: endIso },
    });
    appointments.value = data.appointments || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    appointments.value = [];
  } finally {
    loading.value = false;
  }
}

// Patients & doctors (modal pickers)
const patients = ref([]);
const doctors = ref([]);
const patientSearch = ref('');
const patientPickerOpen = ref(false);

const filteredPatients = computed(() => {
  const q = patientSearch.value.trim().toLowerCase();
  if (!q) return patients.value;
  return patients.value.filter((p) => (p.full_name || '').toLowerCase().includes(q));
});

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
    const { data } = await api.get('/api/doctor-profiles');
    doctors.value = data.doctors || [];
  } catch {
    doctors.value = [];
  }
}

function statusPillClass(status) {
  if (status === 'scheduled') return 'bg-blue-50 text-blue-700 ring-blue-100';
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
  if (status === 'canceled') return 'bg-rose-50 text-rose-700 ring-rose-100';
  return 'bg-slate-50 text-slate-700 ring-slate-100';
}

// Deterministic color palette for doctors.
const doctorPalette = [
  ['bg-indigo-50', 'text-indigo-700', 'ring-indigo-100'],
  ['bg-fuchsia-50', 'text-fuchsia-700', 'ring-fuchsia-100'],
  ['bg-teal-50', 'text-teal-700', 'ring-teal-100'],
  ['bg-amber-50', 'text-amber-700', 'ring-amber-100'],
  ['bg-sky-50', 'text-sky-700', 'ring-sky-100'],
  ['bg-violet-50', 'text-violet-700', 'ring-violet-100'],
  ['bg-emerald-50', 'text-emerald-700', 'ring-emerald-100'],
  ['bg-rose-50', 'text-rose-700', 'ring-rose-100'],
];

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function doctorColorClass(doctorId) {
  if (!doctorId) return 'bg-slate-50 text-slate-700 ring-slate-100';
  const idx = hashString(doctorId) % doctorPalette.length;
  const [bg, text, ring] = doctorPalette[idx];
  return `${bg} ${text} ${ring}`;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Slot mapping (appointments -> visible slot indices)
const appointmentsBySlotKey = computed(() => {
  const map = new Map(); // key -> appointment[]
  const { startMinutes, intervalMin } = timeConfig.value;
  const visibleDayKeys = new Set(days.value.map((d) => toDayKey(d)));

  for (const ap of appointments.value) {
    const apDate = new Date(ap.appointment_date);
    const dayKey = toDayKey(apDate);
    if (!visibleDayKeys.has(dayKey)) continue;

    const mins = apDate.getHours() * 60 + apDate.getMinutes();
    const slotFloat = (mins - startMinutes) / intervalMin;

    // Appointments created via slot-click will always align.
    // For any external/manual timestamps, we map to the nearest slot.
    const slotIndex = Math.round(slotFloat);
    if (slotIndex < 0 || slotIndex >= slotList.value.length) continue;

    const key = `${dayKey}::${slotIndex}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ap);
  }

  // Sort inside each slot.
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => new Date(a.appointment_date).getTime() - new Date(b.appointment_date).getTime());
    map.set(k, arr);
  }

  return map;
});

const nowInfo = computed(() => {
  const now = new Date();
  const { startMinutes, intervalMin } = timeConfig.value;
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const index = Math.round((nowMins - startMinutes) / intervalMin);
  const within = index >= 0 && index < slotList.value.length;
  const todayKey = toDayKey(now);
  return { now, index, within, todayKey };
});

// Modal state
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

const role = computed(() => company.currentCompanyRole);

function closeModal() {
  modalOpen.value = false;
  modalMode.value = 'create';
  editingId.value = null;
  patientSearch.value = '';
  patientPickerOpen.value = false;
}

function openCreateForSlot(dayDate, slot) {
  const d = new Date(dayDate);
  const h = Math.floor(slot.minutes / 60);
  const m = slot.minutes % 60;

  const roleNow = role.value;
  const defaultDoctorId = roleNow === 'doctor' ? auth.user?.id || '' : '';

  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  form.value = {
    patient_id: '',
    assigned_doctor_id: defaultDoctorId,
    appointment_date_local: toDatetimeLocalValue(dt),
    status: 'scheduled',
    notes: '',
  };
  modalMode.value = 'create';
  editingId.value = null;
  patientSearch.value = '';
  patientPickerOpen.value = false;
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

async function saveAppointment() {
  const patientId = form.value.patient_id;
  const doctorId = form.value.assigned_doctor_id;
  const localVal = form.value.appointment_date_local;
  const status = form.value.status;

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

  error.value = '';
  try {
    const appointmentDateIso = fromDatetimeLocalValue(localVal).toISOString();
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
    await loadAppointmentsForRange();
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
    await loadAppointmentsForRange();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

// Initial + reactive loading
onMounted(async () => {
  loadSettings();
  await Promise.all([loadPatients(), loadDoctors()]);
  await loadAppointmentsForRange();
});

watch(
  () => company.currentCompanyId,
  async () => {
    await Promise.all([loadPatients(), loadDoctors()]);
    await loadAppointmentsForRange();
    closeModal();
  }
);

watch(
  () => [viewMode.value, cursorDate.value.getTime()],
  async () => {
    await loadAppointmentsForRange();
    closeModal();
  }
);

watch(
  () => viewMode.value,
  () => {
    // Reset cursor to today when switching view.
    cursorDate.value = new Date();
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
        <button type="button" class="ui-btn-secondary !px-3" @click="cursorDate = new Date(cursorDate.getTime() - (24 * 60 * 60 * 1000) * (viewMode === 'day' ? 1 : 7))">
          ←
        </button>
        <div class="text-center text-sm font-semibold text-slate-800">
          {{
            viewMode === 'day'
              ? cursorDate.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
              : (() => {
                  const start = startOfWeekMonday(cursorDate);
                  const end = new Date(start);
                  end.setDate(start.getDate() + 6);
                  return `${start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(locale, {
                    month: 'short',
                    day: 'numeric',
                  })}`;
                })()
          }}
        </div>
        <button type="button" class="ui-btn-secondary !px-3" @click="cursorDate = new Date(cursorDate.getTime() + (24 * 60 * 60 * 1000) * (viewMode === 'day' ? 1 : 7))">
          →
        </button>

        <div class="flex items-center gap-2">
          <button
            type="button"
            class="ui-btn-secondary !px-3"
            :class="viewMode === 'day' ? 'ring-2 ring-brand-200' : ''"
            @click="viewMode = 'day'"
          >
            {{ locale === 'ar' ? 'يوم' : 'Day' }}
          </button>
          <button
            type="button"
            class="ui-btn-secondary !px-3"
            :class="viewMode === 'week' ? 'ring-2 ring-brand-200' : ''"
            @click="viewMode = 'week'"
          >
            {{ locale === 'ar' ? 'أسبوع' : 'Week' }}
          </button>
        </div>
      </div>

      <button type="button" class="ui-btn-primary" @click="openCreateForSlot(days[0], slotList[0] || { minutes: parseTimePartOrDefault(settings.startTime, defaultSettings.startTime) })">
        {{ t('clinical.addAppointment') }}
      </button>
    </div>

    <!-- Settings -->
    <div class="mb-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label class="ui-label">{{ t('clinical.calendarStartTime') }}</label>
          <input type="time" v-model="settings.startTime" class="ui-input w-36" />
        </div>
        <div>
          <label class="ui-label">{{ t('clinical.calendarEndTime') }}</label>
          <input type="time" v-model="settings.endTime" class="ui-input w-36" />
        </div>
        <div>
          <label class="ui-label">{{ t('clinical.calendarSlotInterval') }}</label>
          <select v-model="settings.slotIntervalMin" class="ui-select w-28">
            <option :value="15">15</option>
            <option :value="30">30</option>
            <option :value="60">60</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <label class="ui-label mb-0">{{ t('clinical.calendarColorBy') }}</label>
          <select v-model="settings.colorBy" class="ui-select w-40">
            <option value="doctor">{{ locale === 'ar' ? 'حسب الطبيب' : 'By doctor' }}</option>
            <option value="status">{{ locale === 'ar' ? 'حسب الحالة' : 'By status' }}</option>
          </select>
        </div>
      </div>
    </div>

    <p v-if="error" class="mb-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
      {{ error }}
    </p>

    <div v-if="loading" class="py-10 text-center text-slate-500">
      {{ t('common.loading') }}
    </div>

    <div v-else class="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <!-- Days header -->
      <div class="overflow-x-auto">
        <div class="min-w-[520px]">
          <div class="flex">
            <div class="w-20 shrink-0"></div>
            <div
              v-for="(h, i) in dayHeaders"
              :key="toDayKey(h.d) + i"
              class="flex-1 min-w-[210px] border border-slate-100 bg-slate-50/40 p-2 text-center"
              :class="isSameDay(h.d, nowInfo.now) ? 'ring-2 ring-brand-200' : ''"
            >
              <div class="text-xs font-bold text-slate-600">
                {{ h.name }}
              </div>
              <div class="mt-1 text-[11px] text-slate-500">
                {{ h.d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }) }}
              </div>
            </div>
          </div>

          <!-- Time grid -->
          <div v-for="(slot, slotIndex) in slotList" :key="slotIndex" class="flex border-t border-slate-100">
            <div
              class="w-20 shrink-0 select-none px-2 py-2 text-right text-xs font-medium text-slate-600"
              :class="nowInfo.within && slotIndex === nowInfo.index ? 'bg-amber-50' : ''"
            >
              {{ slot.label }}
              <div v-if="nowInfo.within && slotIndex === nowInfo.index" class="mt-1 text-[10px] text-amber-700">
                {{ locale === 'ar' ? 'الآن' : 'Now' }}
              </div>
            </div>

            <div
              v-for="(d, dayIdx) in days"
              :key="toDayKey(d) + '::' + dayIdx + '::' + slotIndex"
              class="relative flex-1 min-w-[210px] h-14 border-l border-slate-100"
              :class="nowInfo.within && isSameDay(d, nowInfo.now) && slotIndex === nowInfo.index ? 'bg-amber-50/50' : 'bg-white'"
            >
              <!-- Appointments in this exact slot -->
              <div v-if="(appointmentsBySlotKey.get(`${toDayKey(d)}::${slotIndex}`) || []).length">
                <div class="flex flex-col gap-1 overflow-hidden p-1">
                  <button
                    v-for="ap in (appointmentsBySlotKey.get(`${toDayKey(d)}::${slotIndex}`) || []).slice(0, 3)"
                    :key="ap.id"
                    type="button"
                    class="w-full rounded-md px-2 py-1 text-left text-[11px] ring-1 overflow-hidden"
                    :class="settings.colorBy === 'doctor' ? doctorColorClass(ap.doctor_id) : statusPillClass(ap.status)"
                    :title="`${ap.patient_name} - ${ap.doctor_name} (${ap.status})`"
                    @click.stop="openEdit(ap)"
                  >
                    <div class="truncate font-semibold">{{ ap.patient_name || t('clinical.patient') }}</div>
                    <div class="truncate opacity-90">{{ ap.doctor_name || t('clinical.doctor') }}</div>
                  </button>
                  <div
                    v-if="(appointmentsBySlotKey.get(`${toDayKey(d)}::${slotIndex}`) || []).length > 3"
                    class="mt-0.5 text-[10px] text-slate-500"
                  >
                    +{{ (appointmentsBySlotKey.get(`${toDayKey(d)}::${slotIndex}`) || []).length - 3 }}
                  </div>
                </div>
              </div>

              <!-- Empty slot -> create -->
              <button
                v-else
                type="button"
                class="absolute inset-0 block w-full h-full"
                @click.stop="openCreateForSlot(d, slot)"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-if="days.length && slotList.length === 0" class="py-10 text-center text-slate-500">
        {{ locale === 'ar' ? 'يرجى ضبط إعدادات الوقت' : 'Please adjust time settings' }}
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

