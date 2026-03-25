<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t, locale } = useI18n();
const company = useCompanyStore();

const patients = ref([]);
const loading = ref(false);
const error = ref('');
const editingId = ref(null);
const profilePatient = ref(null);

const form = ref({
  full_name: '',
  phone: '',
  email: '',
  date_of_birth: '',
  blood_group: '',
  gender: '',
  notes: '',
});

const emptyForm = () => ({
  full_name: '',
  phone: '',
  email: '',
  date_of_birth: '',
  blood_group: '',
  gender: '',
  notes: '',
});

function resetForm() {
  editingId.value = null;
  form.value = emptyForm();
}

function formatDob(iso) {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00`);
  const loc = locale.value === 'ar' ? 'ar-SA' : 'en-GB';
  try {
    return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  } catch {
    return iso;
  }
}

function displayVal(v, suffix = '') {
  if (v === null || v === undefined || v === '') return '—';
  return `${v}${suffix}`;
}

const profileAboutRows = computed(() => {
  const p = profilePatient.value;
  if (!p) return [];
  return [
    { label: t('clinical.dateOfBirth'), value: formatDob(p.date_of_birth) },
    { label: t('clinical.bloodGroup'), value: displayVal(p.blood_group) },
    { label: t('clinical.gender'), value: genderLabel(p.gender) },
    { label: t('clinical.email'), value: displayVal(p.email) },
  ];
});

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/patients');
    patients.value = data.patients || [];
    if (profilePatient.value) {
      const id = profilePatient.value.id;
      profilePatient.value = patients.value.find((x) => x.id === id) || null;
    }
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function submit() {
  error.value = '';
  const body = {
    full_name: form.value.full_name.trim(),
    phone: form.value.phone || null,
    email: form.value.email?.trim() || null,
    date_of_birth: form.value.date_of_birth || null,
    blood_group: form.value.blood_group?.trim() || null,
    gender: form.value.gender || null,
    notes: form.value.notes || null,
  };
  try {
    if (editingId.value) {
      await api.put(`/api/patients/${editingId.value}`, body);
    } else {
      await api.post('/api/patients', body);
    }
    resetForm();
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function startEdit(p) {
  editingId.value = p.id;
  profilePatient.value = null;
  form.value = {
    full_name: p.full_name,
    phone: p.phone || '',
    email: p.email || '',
    date_of_birth: p.date_of_birth || '',
    blood_group: p.blood_group || '',
    gender: p.gender || '',
    notes: p.notes || '',
  };
}

function openProfile(p) {
  profilePatient.value = p;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeProfile() {
  profilePatient.value = null;
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/patients/${id}`);
    if (editingId.value === id) resetForm();
    if (profilePatient.value?.id === id) profilePatient.value = null;
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function genderLabel(g) {
  if (g === 'male') return t('clinical.genderMale');
  if (g === 'female') return t('clinical.genderFemale');
  return t('clinical.genderUnset');
}

onMounted(load);
watch(() => company.currentCompanyId, () => {
  resetForm();
  profilePatient.value = null;
  load();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('clinical.patientsTitle') }}</h1>
      <p class="ui-page-desc">{{ t('clinical.patientsSubtitle') }}</p>
    </div>

    <div
      v-if="profilePatient"
      class="ui-card ui-card-pad mb-8 border-2 border-brand-200/50 bg-gradient-to-br from-white to-slate-50/80 shadow-md"
    >
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-lg font-bold text-slate-900">{{ profilePatient.full_name }}</h2>
          <p v-if="profilePatient.phone" class="text-sm text-slate-600">{{ profilePatient.phone }}</p>
        </div>
        <button type="button" class="ui-btn-secondary text-sm" @click="closeProfile">
          {{ t('clinical.closeProfile') }}
        </button>
      </div>

      <div>
        <h3 class="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">
          {{ t('clinical.sectionAbout') }}
        </h3>
        <dl class="space-y-2 text-sm">
          <div v-for="row in profileAboutRows" :key="row.label" class="flex flex-wrap gap-x-2 gap-y-0.5">
            <dt class="min-w-[7rem] font-medium text-slate-600">{{ row.label }}</dt>
            <dd class="text-slate-900">{{ row.value }}</dd>
          </div>
        </dl>
      </div>
      <p class="mt-4 rounded-lg bg-slate-100/80 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200/80">
        {{ t('clinical.vitalsPatientNote') }}
      </p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-2">
        {{ editingId ? t('clinical.updatePatient') : t('clinical.addPatient') }}
      </h2>
      <p class="mb-5 text-sm text-slate-600">{{ t('clinical.vitalsPatientNote') }}</p>

      <form @submit.prevent="submit">
        <div class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <input
            v-model="form.full_name"
            required
            class="ui-input sm:col-span-2"
            :placeholder="t('clinical.fullName')"
          />
          <input v-model="form.phone" class="ui-input" :placeholder="t('clinical.phone')" />
          <input v-model="form.email" type="email" class="ui-input sm:col-span-2" :placeholder="t('clinical.email')" />
          <input v-model="form.date_of_birth" type="date" class="ui-input" />
          <input
            v-model="form.blood_group"
            class="ui-input"
            :placeholder="t('clinical.bloodGroup') + ' (O +ve)'"
          />
          <select v-model="form.gender" class="ui-select">
            <option value="">{{ t('clinical.gender') }}</option>
            <option value="male">{{ t('clinical.genderMale') }}</option>
            <option value="female">{{ t('clinical.genderFemale') }}</option>
          </select>
          <textarea
            v-model="form.notes"
            rows="2"
            class="ui-input sm:col-span-3"
            :placeholder="t('clinical.notes')"
          />
        </div>

        <div class="flex flex-wrap gap-2">
          <button type="submit" class="ui-btn-primary">{{ t('common.save') }}</button>
          <button v-if="editingId" type="button" class="ui-btn-secondary" @click="resetForm">
            {{ t('clinical.newPatient') }}
          </button>
        </div>
      </form>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </div>

    <div class="ui-table-wrap mt-8">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('clinical.fullName') }}</th>
            <th>{{ t('clinical.phone') }}</th>
            <th>{{ t('clinical.email') }}</th>
            <th>{{ t('clinical.dateOfBirth') }}</th>
            <th>{{ t('clinical.bloodGroup') }}</th>
            <th>{{ t('clinical.gender') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in patients" :key="p.id">
            <td class="font-medium text-slate-900">{{ p.full_name }}</td>
            <td class="text-slate-600">{{ p.phone || '—' }}</td>
            <td class="max-w-[10rem] truncate text-slate-600">{{ p.email || '—' }}</td>
            <td class="whitespace-nowrap text-slate-600">{{ formatDob(p.date_of_birth) }}</td>
            <td class="text-slate-600">{{ p.blood_group || '—' }}</td>
            <td class="text-slate-600">{{ genderLabel(p.gender) }}</td>
            <td class="flex flex-wrap gap-2">
              <button type="button" class="ui-btn-secondary !px-2 !py-1.5 text-sm" @click="openProfile(p)">
                {{ t('clinical.viewProfile') }}
              </button>
              <button type="button" class="ui-btn-secondary !px-2 !py-1.5 text-sm" @click="startEdit(p)">
                {{ t('clinical.edit') }}
              </button>
              <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(p.id)">
                {{ t('accounts.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="loading">
            <td colspan="7" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
