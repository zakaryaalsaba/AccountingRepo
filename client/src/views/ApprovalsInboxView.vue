<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const loading = ref(false);
const error = ref('');
const statusFilter = ref('pending');
const requests = ref([]);

const filtered = computed(() => {
  if (!statusFilter.value) return requests.value;
  return requests.value.filter((r) => r.status === statusFilter.value);
});

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/audit/workflow/requests', {
      params: statusFilter.value ? { status: statusFilter.value } : {},
    });
    requests.value = data.requests || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function decide(id, decision) {
  try {
    await api.post(`/api/audit/workflow/requests/${id}/decide`, { decision });
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
watch(statusFilter, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('approvals.title') }}</h1>
      <p class="ui-page-desc">{{ t('approvals.subtitle') }}</p>
    </div>

    <section class="ui-card ui-card-pad">
      <div class="mb-4 flex flex-wrap gap-2">
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': statusFilter === 'pending' }" @click="statusFilter = 'pending'">{{ t('approvals.pending') }}</button>
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': statusFilter === 'approved' }" @click="statusFilter = 'approved'">{{ t('approvals.approved') }}</button>
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': statusFilter === 'rejected' }" @click="statusFilter = 'rejected'">{{ t('approvals.rejected') }}</button>
      </div>

      <ul class="space-y-2">
        <li v-for="r in filtered" :key="r.id" class="rounded-lg border border-slate-200 p-3 text-sm">
          <p class="font-semibold">{{ r.doc_type }} · {{ r.entity_id }}</p>
          <p class="text-slate-600">{{ Number(r.amount || 0).toFixed(2) }} · {{ r.status }}</p>
          <p class="text-xs text-slate-500">{{ r.note || '-' }}</p>
          <div v-if="r.status === 'pending'" class="mt-2 flex gap-2">
            <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="decide(r.id, 'approved')">{{ t('approvals.approve') }}</button>
            <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="decide(r.id, 'rejected')">{{ t('approvals.reject') }}</button>
          </div>
        </li>
      </ul>
      <p v-if="loading" class="mt-3 text-sm text-slate-500">{{ t('common.loading') }}</p>
      <p v-if="error" class="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">{{ error }}</p>
    </section>
  </div>
</template>
