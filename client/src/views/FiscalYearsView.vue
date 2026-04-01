<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useFiscalStore } from '@/stores/fiscal';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const fiscal = useFiscalStore();

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const editingId = ref('');

const form = ref({
  year_code: new Date().getFullYear(),
  name_ar: '',
  name_en: '',
  start_date: `${new Date().getFullYear()}-01-01`,
  end_date: `${new Date().getFullYear()}-12-31`,
  is_active: false,
  is_closed: false,
});

const isEditing = computed(() => Boolean(editingId.value));

function resetForm() {
  const y = new Date().getFullYear();
  editingId.value = '';
  form.value = {
    year_code: y,
    name_ar: '',
    name_en: '',
    start_date: `${y}-01-01`,
    end_date: `${y}-12-31`,
    is_active: false,
    is_closed: false,
  };
}

function fillForm(fy) {
  editingId.value = fy.id;
  form.value = {
    year_code: Number(fy.year_code || new Date().getFullYear()),
    name_ar: fy.name_ar || '',
    name_en: fy.name_en || '',
    start_date: String(fy.start_date || '').slice(0, 10),
    end_date: String(fy.end_date || '').slice(0, 10),
    is_active: Boolean(fy.is_active),
    is_closed: Boolean(fy.is_closed),
  };
}

async function loadFiscalYears() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    await fiscal.loadFiscalYears(company.currentCompanyId);
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function saveFiscalYear() {
  if (!company.currentCompanyId) return;
  saving.value = true;
  error.value = '';
  try {
    if (isEditing.value) {
      await api.patch(`/api/fiscal-years/${editingId.value}`, form.value);
    } else {
      await api.post('/api/fiscal-years', form.value);
    }
    resetForm();
    await loadFiscalYears();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    saving.value = false;
  }
}

async function quickAction(fy, action) {
  error.value = '';
  try {
    if (action === 'setActive') {
      await api.patch(`/api/fiscal-years/${fy.id}`, { is_active: true, is_closed: false });
    } else if (action === 'close') {
      await api.patch(`/api/fiscal-years/${fy.id}`, { is_closed: true, is_active: false });
    } else if (action === 'reopen') {
      await api.patch(`/api/fiscal-years/${fy.id}`, { is_closed: false });
    }
    await loadFiscalYears();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(loadFiscalYears);
watch(() => company.currentCompanyId, async () => {
  resetForm();
  await loadFiscalYears();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('fiscalYearsView.title') }}</h1>
      <p class="ui-page-desc">{{ t('fiscalYearsView.subtitle') }}</p>
    </div>

    <section class="ui-card ui-card-pad mb-6">
      <h2 class="ui-card-title mb-4">
        {{ isEditing ? t('fiscalYearsView.editFiscalYear') : t('fiscalYearsView.newFiscalYear') }}
      </h2>
      <div class="grid gap-4 md:grid-cols-3">
        <div>
          <label class="ui-label">{{ t('fiscalYearsView.yearCode') }}</label>
          <input v-model.number="form.year_code" type="number" min="2000" max="3000" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('fiscalYearsView.nameAr') }}</label>
          <input v-model.trim="form.name_ar" type="text" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('fiscalYearsView.nameEn') }}</label>
          <input v-model.trim="form.name_en" type="text" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('fiscalYearsView.startDate') }}</label>
          <input v-model="form.start_date" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('fiscalYearsView.endDate') }}</label>
          <input v-model="form.end_date" type="date" class="ui-input" />
        </div>
        <div class="flex items-end gap-6 pb-2">
          <label class="inline-flex items-center gap-2 text-sm text-slate-700">
            <input v-model="form.is_active" type="checkbox" />
            {{ t('fiscalYearsView.isActive') }}
          </label>
          <label class="inline-flex items-center gap-2 text-sm text-slate-700">
            <input v-model="form.is_closed" type="checkbox" />
            {{ t('fiscalYearsView.isClosed') }}
          </label>
        </div>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" class="ui-btn-primary" :disabled="saving" @click="saveFiscalYear">
          {{ isEditing ? t('fiscalYearsView.update') : t('fiscalYearsView.save') }}
        </button>
        <button v-if="isEditing" type="button" class="ui-btn-secondary" @click="resetForm">
          {{ t('fiscalYearsView.cancelEdit') }}
        </button>
      </div>
    </section>

    <section class="ui-card ui-card-pad">
      <div class="ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th>{{ t('fiscalYearsView.yearCode') }}</th>
              <th>{{ t('fiscalYearsView.nameAr') }}</th>
              <th>{{ t('fiscalYearsView.nameEn') }}</th>
              <th>{{ t('fiscalYearsView.startDate') }}</th>
              <th>{{ t('fiscalYearsView.endDate') }}</th>
              <th>{{ t('fiscalYearsView.isActive') }}</th>
              <th>{{ t('fiscalYearsView.isClosed') }}</th>
              <th>{{ t('fiscalYearsView.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="fy in fiscal.fiscalYears" :key="fy.id">
              <td>{{ fy.year_code }}</td>
              <td>{{ fy.name_ar || '—' }}</td>
              <td>{{ fy.name_en || '—' }}</td>
              <td>{{ String(fy.start_date).slice(0, 10) }}</td>
              <td>{{ String(fy.end_date).slice(0, 10) }}</td>
              <td>
                <span class="ui-badge" :class="fy.is_active ? 'ui-badge-emerald' : 'ui-badge-slate'">
                  {{ fy.is_active ? t('fiscalYearsView.statusActive') : t('fiscalYearsView.statusInactive') }}
                </span>
              </td>
              <td>
                <span class="ui-badge" :class="fy.is_closed ? 'ui-badge-amber' : 'ui-badge-emerald'">
                  {{ fy.is_closed ? t('fiscalYearsView.statusClosed') : t('fiscalYearsView.statusOpen') }}
                </span>
              </td>
              <td>
                <div class="flex flex-wrap gap-1">
                  <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="fillForm(fy)">
                    {{ t('fiscalYearsView.edit') }}
                  </button>
                  <button
                    v-if="!fy.is_active || fy.is_closed"
                    type="button"
                    class="ui-btn-secondary !px-2 !py-1 text-xs"
                    @click="quickAction(fy, 'setActive')"
                  >
                    {{ t('fiscalYearsView.setActive') }}
                  </button>
                  <button
                    v-if="!fy.is_closed"
                    type="button"
                    class="ui-btn-danger !px-2 !py-1 text-xs"
                    @click="quickAction(fy, 'close')"
                  >
                    {{ t('fiscalYearsView.close') }}
                  </button>
                  <button
                    v-else
                    type="button"
                    class="ui-btn-secondary !px-2 !py-1 text-xs"
                    @click="quickAction(fy, 'reopen')"
                  >
                    {{ t('fiscalYearsView.reopen') }}
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="loading">
              <td colspan="8" class="py-10 text-center text-slate-500">{{ t('common.loading') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </section>
  </div>
</template>
