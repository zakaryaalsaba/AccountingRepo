<script setup>
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const transactions = ref([]);
const payments = ref([]);
const error = ref('');

async function load() {
  if (!company.currentCompanyId) return;
  error.value = '';
  try {
    const [t, p] = await Promise.all([
      api.get('/api/transactions', { params: { limit: 100 } }),
      api.get('/api/payments'),
    ]);
    transactions.value = t.data.transactions || [];
    payments.value = p.data.payments || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('vouchersView.loadFailed');
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('vouchersView.title') }}</h1>
      <p class="ui-page-desc">{{ t('vouchersView.subtitle') }}</p>
    </div>
    <div class="grid gap-6 lg:grid-cols-2">
      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-4">{{ t('vouchersView.journalVouchers') }}</h2>
        <ul class="max-h-[30rem] space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3">
          <li v-for="tx in transactions" :key="tx.id" class="rounded-lg border border-slate-100 p-3 text-sm">
            <p class="font-semibold">{{ tx.entry_date }} · {{ tx.reference || 'JV' }}</p>
            <p class="text-slate-600">{{ tx.description || '—' }}</p>
          </li>
        </ul>
      </section>
      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-4">{{ t('vouchersView.receiptPaymentVouchers') }}</h2>
        <ul class="max-h-[30rem] space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3">
          <li v-for="p in payments" :key="p.id" class="rounded-lg border border-slate-100 p-3 text-sm">
            <p class="font-semibold">{{ p.payment_date }} · {{ p.method }}</p>
            <p class="tabular-nums text-slate-700">{{ Number(p.amount).toFixed(2) }}</p>
          </li>
        </ul>
      </section>
    </div>
    <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">{{ error }}</p>
  </div>
</template>

