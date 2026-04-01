<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { listDocuments } from '@/api/documentsApi';
import { documentsApiErrorMessage } from '@/utils/documentsErrors';

const { t, locale } = useI18n();
const router = useRouter();
const company = useCompanyStore();

const loading = ref(false);
const error = ref('');
const items = ref([]);

const canManage = computed(() => {
  const r = company.currentCompanyRole;
  return r === 'owner' || r === 'admin' || r === 'accountant';
});

const df = computed(() =>
  new Intl.DateTimeFormat(locale.value === 'ar' ? 'ar-SA' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
);

function fmtDate(v) {
  if (!v) return t('documents.valueNone');
  try {
    return df.value.format(new Date(v));
  } catch {
    return String(v);
  }
}

function statusLabel(s) {
  if (s === 'DRAFT') return t('documents.statusDraft');
  if (s === 'SENT') return t('documents.statusSent');
  if (s === 'SIGNED') return t('documents.statusSigned');
  return s || t('documents.valueNone');
}

function statusClass(s) {
  if (s === 'DRAFT') return 'bg-amber-100 text-amber-900';
  if (s === 'SENT') return 'bg-sky-100 text-sky-900';
  if (s === 'SIGNED') return 'bg-emerald-100 text-emerald-900';
  return 'bg-slate-100 text-slate-700';
}

async function load() {
  if (!company.currentCompanyId) {
    items.value = [];
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    items.value = await listDocuments({ limit: 200 });
  } catch (e) {
    error.value = documentsApiErrorMessage(e, t);
    items.value = [];
  } finally {
    loading.value = false;
  }
}

function goDetail(id) {
  router.push({ name: 'document-detail', params: { id } });
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">{{ t('documents.dashboardTitle') }}</h1>
        <p class="mt-1 text-sm text-slate-600">{{ t('documents.dashboardSubtitle') }}</p>
      </div>
      <RouterLink
        v-if="canManage"
        to="/documents/upload"
        class="ui-btn-primary shrink-0"
      >
        {{ t('documents.goUpload') }}
      </RouterLink>
    </div>

    <p v-if="!company.currentCompanyId" class="ui-badge-amber inline-block text-sm">
      {{ t('documents.selectCompanyFirst') }}
    </p>

    <p
      v-else-if="error"
      role="alert"
      aria-live="polite"
      class="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
    >
      {{ error }}
    </p>

    <div v-else-if="loading" class="ui-card ui-card-pad text-center text-slate-500">
      {{ t('documents.loading') }}
    </div>

    <div v-else-if="!items.length" class="ui-card ui-card-pad text-center text-slate-600">
      {{ t('documents.dashboardEmpty') }}
      <RouterLink
        v-if="canManage"
        to="/documents/upload"
        class="mt-3 inline-block font-medium text-brand-600 hover:text-brand-700"
      >
        {{ t('documents.goUpload') }}
      </RouterLink>
    </div>

    <div v-else class="overflow-x-auto rounded-xl border border-slate-200/80 bg-white shadow-sm">
      <table class="min-w-full divide-y divide-slate-200 text-start">
        <caption class="sr-only">
          {{ t('documents.tableCaption') }}
        </caption>
        <thead class="bg-slate-50">
          <tr>
            <th class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
              {{ t('documents.colTitle') }}
            </th>
            <th class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
              {{ t('documents.colStatus') }}
            </th>
            <th class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
              {{ t('documents.colOwner') }}
            </th>
            <th class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
              {{ t('documents.colCreated') }}
            </th>
            <th class="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
              {{ t('documents.colActions') }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="row in items" :key="row.id" class="hover:bg-slate-50/80">
            <td class="max-w-[14rem] truncate px-4 py-3 text-sm font-medium text-slate-900">
              {{ row.title }}
            </td>
            <td class="px-4 py-3">
              <span class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold" :class="statusClass(row.status)">
                {{ statusLabel(row.status) }}
              </span>
            </td>
            <td class="px-4 py-3 text-sm text-slate-600" dir="ltr">
              {{ row.owner_email || t('documents.valueNone') }}
            </td>
            <td class="whitespace-nowrap px-4 py-3 text-sm text-slate-600">
              {{ fmtDate(row.created_at) }}
            </td>
            <td class="px-4 py-3">
              <div class="flex flex-wrap gap-2">
                <button type="button" class="ui-btn-secondary px-3 py-1.5 text-xs" @click="goDetail(row.id)">
                  {{ t('documents.actionView') }}
                </button>
                <RouterLink
                  v-if="canManage && row.status === 'DRAFT'"
                  :to="{ name: 'document-detail', params: { id: row.id } }"
                  class="ui-btn-primary px-3 py-1.5 text-xs no-underline"
                >
                  {{ t('documents.actionSend') }}
                </RouterLink>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
