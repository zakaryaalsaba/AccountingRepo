<script setup>
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const accounts = ref([]);
const accountId = ref('');
const from = ref(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10));
const to = ref(new Date().toISOString().slice(0, 10));
const ledger = ref(null);
const error = ref('');

async function loadAccounts() {
  if (!company.currentCompanyId) return;
  const r = await api.get('/api/accounts');
  accounts.value = r.data.accounts || [];
  if (!accountId.value && accounts.value.length) accountId.value = accounts.value[0].id;
}

async function run() {
  if (!accountId.value) return;
  error.value = '';
  try {
    const r = await api.get(`/api/reports/account-ledger/${accountId.value}`, { params: { from: from.value, to: to.value } });
    ledger.value = r.data;
  } catch (e) {
    error.value = e.response?.data?.error || t('analysisView.loadFailed');
  }
}

onMounted(async () => {
  await loadAccounts();
  await run();
});
watch(() => company.currentCompanyId, async () => {
  ledger.value = null;
  await loadAccounts();
  await run();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('analysisView.title') }}</h1>
      <p class="ui-page-desc">{{ t('analysisView.subtitle') }}</p>
    </div>
    <section class="ui-card ui-card-pad">
      <div class="mb-4 grid gap-3 md:grid-cols-4">
        <select v-model="accountId" class="ui-select">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.code }} — {{ a.name }}</option>
        </select>
        <input v-model="from" type="date" class="ui-input" />
        <input v-model="to" type="date" class="ui-input" />
        <button class="ui-btn-primary" @click="run">{{ t('analysisView.run') }}</button>
      </div>
      <div v-if="ledger" class="space-y-3 text-sm">
        <p>{{ t('analysisView.opening') }}: <b>{{ Number(ledger.opening_balance).toFixed(2) }}</b> · {{ t('analysisView.closing') }}: <b>{{ Number(ledger.closing_balance).toFixed(2) }}</b></p>
        <ul class="max-h-[30rem] space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3">
          <li v-for="(e, i) in ledger.entries" :key="`${e.transaction_id}-${i}`" class="flex justify-between border-b border-slate-50 pb-2 text-slate-700 last:border-0">
            <span>{{ e.entry_date }} — {{ e.description || '—' }}</span>
            <span class="tabular-nums">{{ Number(e.running_balance).toFixed(2) }}</span>
          </li>
        </ul>
      </div>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">{{ error }}</p>
    </section>
  </div>
</template>

