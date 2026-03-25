<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const transactions = ref([]);
const accounts = ref([]);
const loading = ref(false);
const error = ref('');

const entry = ref({
  entry_date: new Date().toISOString().slice(0, 10),
  description: '',
  reference: '',
  lines: [
    { account_id: '', debit: '', credit: '' },
    { account_id: '', debit: '', credit: '' },
  ],
});

const totalDebit = computed(() =>
  entry.value.lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0)
);
const totalCredit = computed(() =>
  entry.value.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0)
);
const balanced = computed(() => Math.abs(totalDebit.value - totalCredit.value) < 0.005);

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [tx, acc] = await Promise.all([
      api.get('/api/transactions'),
      api.get('/api/accounts'),
    ]);
    transactions.value = tx.data.transactions || [];
    accounts.value = acc.data.accounts || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

function addLine() {
  entry.value.lines.push({ account_id: '', debit: '', credit: '' });
}

async function submit() {
  if (!balanced.value) {
    error.value = t('transactions.balanced');
    return;
  }
  error.value = '';
  const lines = entry.value.lines
    .map((l) => ({
      account_id: l.account_id,
      debit: parseFloat(l.debit) || 0,
      credit: parseFloat(l.credit) || 0,
    }))
    .filter((l) => l.account_id && (l.debit > 0 || l.credit > 0));
  try {
    await api.post('/api/transactions', {
      entry_date: entry.value.entry_date,
      description: entry.value.description,
      reference: entry.value.reference,
      lines,
    });
    entry.value = {
      entry_date: new Date().toISOString().slice(0, 10),
      description: '',
      reference: '',
      lines: [
        { account_id: '', debit: '', credit: '' },
        { account_id: '', debit: '', credit: '' },
      ],
    };
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/transactions/${id}`);
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('transactions.title') }}</h1>
      <p class="ui-page-desc">{{ t('transactions.new') }}</p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-5">{{ t('transactions.new') }}</h2>
      <div class="mb-6 grid gap-4 sm:grid-cols-3">
        <div>
          <label class="ui-label">{{ t('transactions.date') }}</label>
          <input v-model="entry.entry_date" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('transactions.description') }}</label>
          <input v-model="entry.description" type="text" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('transactions.reference') }}</label>
          <input v-model="entry.reference" type="text" class="ui-input" />
        </div>
      </div>

      <div class="overflow-x-auto rounded-xl border border-slate-100 bg-slate-50/50 p-2">
        <table class="w-full min-w-[640px] text-sm">
          <thead>
            <tr class="text-xs font-bold uppercase tracking-wide text-slate-500">
              <th class="px-2 py-2 text-start">{{ t('transactions.account') }}</th>
              <th class="px-2 py-2 text-start">{{ t('transactions.debit') }}</th>
              <th class="px-2 py-2 text-start">{{ t('transactions.credit') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(line, idx) in entry.lines" :key="idx">
              <td class="px-2 py-1.5">
                <select v-model="line.account_id" class="ui-select !bg-white">
                  <option value="">{{ t('company.none') }}</option>
                  <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.code }} — {{ a.name }}</option>
                </select>
              </td>
              <td class="px-2 py-1.5">
                <input v-model="line.debit" type="number" step="0.01" min="0" class="ui-input !bg-white" />
              </td>
              <td class="px-2 py-1.5">
                <input v-model="line.credit" type="number" step="0.01" min="0" class="ui-input !bg-white" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" class="ui-btn-secondary text-sm" @click="addLine">+ {{ t('transactions.addLine') }}</button>
        <span class="text-sm font-medium tabular-nums text-slate-600">
          {{ t('transactions.debit') }}: {{ totalDebit.toFixed(2) }} · {{ t('transactions.credit') }}:
          {{ totalCredit.toFixed(2) }}
        </span>
        <span v-if="balanced && totalDebit > 0" class="ui-badge-emerald text-[11px]">✓</span>
        <span v-if="!balanced" class="ui-badge-amber max-w-full text-[11px] leading-snug">{{ t('transactions.balanced') }}</span>
      </div>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
      <button type="button" class="ui-btn-primary mt-5" :disabled="!balanced" @click="submit">
        {{ t('transactions.submit') }}
      </button>
    </div>

    <div class="ui-table-wrap">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('transactions.date') }}</th>
            <th>{{ t('transactions.description') }}</th>
            <th>{{ t('transactions.lines') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tx in transactions" :key="tx.id" class="align-top">
            <td class="whitespace-nowrap font-medium text-slate-900">{{ tx.entry_date }}</td>
            <td class="text-slate-600">{{ tx.description || '—' }}</td>
            <td>
              <ul class="space-y-1.5">
                <li v-for="ln in tx.lines" :key="ln.id" class="text-xs text-slate-600">
                  <span class="font-mono font-semibold text-brand-800">{{ ln.account_code }}</span>
                  <span class="ms-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                    {{ ln.debit > 0 ? `D ${ln.debit}` : `C ${ln.credit}` }}
                  </span>
                </li>
              </ul>
            </td>
            <td>
              <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(tx.id)">
                {{ t('accounts.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="loading">
            <td colspan="4" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
