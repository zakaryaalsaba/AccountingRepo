<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const error = ref('');
const loading = ref(false);
const accounts = ref([]);
const bankAccounts = ref([]);
const safes = ref([]);
const statementLines = ref([]);
const suggestions = ref([]);
const summary = ref(null);
const reconReport = ref(null);
const selectedBankAccountId = ref('');
const selectedStatementLineId = ref('');

const bankForm = ref({
  name: '', bank_name: '', account_number_masked: '', currency_code: 'SAR',
  gl_account_id: '', iban: '', swift_code: '', branch_name: '', account_owner_name: '',
  opening_balance: 0, opening_date: '', opening_reference: '', is_active: true,
});
const safeForm = ref({
  name: '', code: '', currency_code: 'SAR', gl_account_id: '',
  opening_balance: 0, opening_date: '', opening_reference: '', custodian_name: '', location_text: '', is_active: true,
});
const openingPost = ref({ entry_date: new Date().toISOString().slice(0, 10), offset_account_id: '' });
const settlementFilters = ref({
  from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
  status: 'unreconciled',
});
const writeoff = ref({ writeoff_account_id: '', reason: '' });

const selectedLine = computed(() =>
  statementLines.value.find((x) => String(x.id) === String(selectedStatementLineId.value)) || null
);

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [a, b, s] = await Promise.all([
      api.get('/api/accounts'),
      api.get('/api/bank-accounts'),
      api.get('/api/treasury-safes'),
    ]);
    accounts.value = a.data.accounts || [];
    bankAccounts.value = b.data.bank_accounts || [];
    safes.value = s.data.safes || [];
    if (!selectedBankAccountId.value && bankAccounts.value.length) selectedBankAccountId.value = bankAccounts.value[0].id;
    await runSettlementRefresh();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function createBank() {
  try {
    await api.post('/api/bank-accounts', bankForm.value);
    bankForm.value = {
      name: '', bank_name: '', account_number_masked: '', currency_code: 'SAR',
      gl_account_id: '', iban: '', swift_code: '', branch_name: '', account_owner_name: '',
      opening_balance: 0, opening_date: '', opening_reference: '', is_active: true,
    };
    await load();
  } catch (e) { error.value = e.response?.data?.error || t('common.error'); }
}

async function createSafe() {
  try {
    await api.post('/api/treasury-safes', safeForm.value);
    safeForm.value = {
      name: '', code: '', currency_code: 'SAR', gl_account_id: '',
      opening_balance: 0, opening_date: '', opening_reference: '', custodian_name: '', location_text: '', is_active: true,
    };
    await load();
  } catch (e) { error.value = e.response?.data?.error || t('common.error'); }
}

async function postBankOpening(id) {
  try {
    await api.post(`/api/bank-accounts/${id}/opening-balance/post`, openingPost.value);
    await load();
  } catch (e) { error.value = e.response?.data?.error || t('common.error'); }
}

async function postSafeOpening(id) {
  try {
    await api.post(`/api/treasury-safes/${id}/opening-balance/post`, openingPost.value);
    await load();
  } catch (e) { error.value = e.response?.data?.error || t('common.error'); }
}

async function loadSettlementLines() {
  if (!selectedBankAccountId.value) return;
  const { data } = await api.get('/api/bank-accounts/statements/reconciliation-drilldown', {
    params: {
      bank_account_id: selectedBankAccountId.value,
      from: settlementFilters.value.from,
      to: settlementFilters.value.to,
      status: settlementFilters.value.status,
    },
  });
  statementLines.value = data.lines || [];
  if (!selectedStatementLineId.value && statementLines.value.length) selectedStatementLineId.value = statementLines.value[0].id;
}

async function loadSuggestions() {
  if (!selectedBankAccountId.value || !selectedStatementLineId.value) {
    suggestions.value = [];
    return;
  }
  const { data } = await api.get('/api/bank-accounts/statements/match-suggestions', {
    params: {
      bank_account_id: selectedBankAccountId.value,
      line_id: selectedStatementLineId.value,
    },
  });
  suggestions.value = [...(data.exact_matches || []), ...(data.fuzzy_matches || [])];
}

async function loadReconciliationSummary() {
  if (!selectedBankAccountId.value) return;
  const { data } = await api.get('/api/bank-accounts/statements/reconciliation-summary', {
    params: {
      bank_account_id: selectedBankAccountId.value,
      from: settlementFilters.value.from,
      to: settlementFilters.value.to,
    },
  });
  summary.value = data.summary || null;
}

async function loadReconciliationReport() {
  if (!selectedBankAccountId.value) return;
  const { data } = await api.get('/api/bank-accounts/statements/reconciliation-report', {
    params: {
      bank_account_id: selectedBankAccountId.value,
      from: settlementFilters.value.from,
      to: settlementFilters.value.to,
    },
  });
  reconReport.value = data || null;
}

async function runSettlementRefresh() {
  try {
    await Promise.all([loadSettlementLines(), loadReconciliationSummary(), loadReconciliationReport()]);
    await loadSuggestions();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function pairLine(transactionId, force = false) {
  if (!selectedLine.value) return;
  try {
    await api.post('/api/bank-accounts/statements/manual-pair', {
      line_id: selectedLine.value.id,
      transaction_id: transactionId,
      force,
    });
    await runSettlementRefresh();
  } catch (e) {
    const warnings = e.response?.data?.warnings;
    if (Array.isArray(warnings) && warnings.length && !force) return pairLine(transactionId, true);
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function writeoffDifference() {
  if (!selectedLine.value) return;
  try {
    await api.post('/api/bank-accounts/statements/differences/writeoff', {
      line_id: selectedLine.value.id,
      writeoff_account_id: writeoff.value.writeoff_account_id,
      writeoff_date: new Date().toISOString().slice(0, 10),
      reason: writeoff.value.reason || 'reconciliation difference',
    });
    writeoff.value.reason = '';
    await runSettlementRefresh();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function exportSettlementCsv() {
  const header = ['date', 'description', 'reference', 'amount', 'reconciled', 'transaction_reference'];
  const rows = statementLines.value.map((ln) => [
    ln.statement_date || '',
    ln.description || '',
    ln.reference || '',
    Number(ln.amount || 0).toFixed(2),
    ln.is_reconciled ? 'yes' : 'no',
    ln.transaction_reference || '',
  ]);
  const csv = [header, ...rows]
    .map((line) => line.map((x) => `"${String(x).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reconciliation_${selectedBankAccountId.value || 'bank'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function printSettlement() {
  window.print();
}

onMounted(load);
watch(() => company.currentCompanyId, load);
watch(selectedBankAccountId, runSettlementRefresh);
watch(() => settlementFilters.value.from, runSettlementRefresh);
watch(() => settlementFilters.value.to, runSettlementRefresh);
watch(() => settlementFilters.value.status, runSettlementRefresh);
watch(selectedStatementLineId, loadSuggestions);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('bankTreasury.title') }}</h1>
      <p class="ui-page-desc">{{ t('bankTreasury.subtitle') }}</p>
    </div>

    <section class="ui-card ui-card-pad mb-6">
      <h2 class="ui-card-title mb-3">{{ t('bankTreasury.bankMaster') }}</h2>
      <div class="grid gap-3 md:grid-cols-4">
        <input v-model="bankForm.name" class="ui-input" :placeholder="t('bankTreasury.name')" />
        <input v-model="bankForm.bank_name" class="ui-input" :placeholder="t('bankTreasury.bankName')" />
        <input v-model="bankForm.account_number_masked" class="ui-input" :placeholder="t('bankTreasury.accountNumber')" />
        <input v-model="bankForm.currency_code" class="ui-input" :placeholder="t('bankTreasury.currency')" />
        <select v-model="bankForm.gl_account_id" class="ui-select">
          <option value="">{{ t('bankTreasury.glAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
        <input v-model="bankForm.iban" class="ui-input" :placeholder="t('bankTreasury.iban')" />
        <input v-model="bankForm.swift_code" class="ui-input" :placeholder="t('bankTreasury.swiftCode')" />
        <input v-model="bankForm.branch_name" class="ui-input" :placeholder="t('bankTreasury.branchName')" />
        <input v-model="bankForm.account_owner_name" class="ui-input" :placeholder="t('bankTreasury.ownerName')" />
        <input v-model="bankForm.opening_balance" type="number" class="ui-input" :placeholder="t('bankTreasury.openingBalance')" />
        <input v-model="bankForm.opening_date" type="date" class="ui-input" />
        <input v-model="bankForm.opening_reference" class="ui-input" :placeholder="t('bankTreasury.openingReference')" />
      </div>
      <button type="button" class="ui-btn-primary mt-3" @click="createBank">{{ t('bankTreasury.createBank') }}</button>
    </section>

    <section class="ui-card ui-card-pad mb-6">
      <h2 class="ui-card-title mb-3">{{ t('bankTreasury.safeMaster') }}</h2>
      <div class="grid gap-3 md:grid-cols-4">
        <input v-model="safeForm.name" class="ui-input" :placeholder="t('bankTreasury.name')" />
        <input v-model="safeForm.code" class="ui-input" :placeholder="t('bankTreasury.code')" />
        <input v-model="safeForm.currency_code" class="ui-input" :placeholder="t('bankTreasury.currency')" />
        <select v-model="safeForm.gl_account_id" class="ui-select">
          <option value="">{{ t('bankTreasury.glAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
        <input v-model="safeForm.custodian_name" class="ui-input" :placeholder="t('bankTreasury.custodian')" />
        <input v-model="safeForm.location_text" class="ui-input" :placeholder="t('bankTreasury.location')" />
        <input v-model="safeForm.opening_balance" type="number" class="ui-input" :placeholder="t('bankTreasury.openingBalance')" />
        <input v-model="safeForm.opening_date" type="date" class="ui-input" />
        <input v-model="safeForm.opening_reference" class="ui-input md:col-span-2" :placeholder="t('bankTreasury.openingReference')" />
      </div>
      <button type="button" class="ui-btn-primary mt-3" @click="createSafe">{{ t('bankTreasury.createSafe') }}</button>
    </section>

    <section class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-3">{{ t('bankTreasury.openingWizard') }}</h2>
      <div class="grid gap-3 md:grid-cols-3">
        <input v-model="openingPost.entry_date" type="date" class="ui-input" />
        <select v-model="openingPost.offset_account_id" class="ui-select">
          <option value="">{{ t('bankTreasury.offsetAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
      </div>
      <div class="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <p class="mb-2 text-sm font-semibold">{{ t('bankTreasury.bankAccounts') }}</p>
          <ul class="space-y-2">
            <li v-for="b in bankAccounts" :key="b.id" class="flex items-center justify-between rounded-lg border border-slate-100 p-2 text-sm">
              <span>{{ b.name }} - {{ Number(b.opening_balance || 0).toFixed(2) }}</span>
              <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="postBankOpening(b.id)">{{ t('bankTreasury.postOpening') }}</button>
            </li>
          </ul>
        </div>
        <div>
          <p class="mb-2 text-sm font-semibold">{{ t('bankTreasury.safes') }}</p>
          <ul class="space-y-2">
            <li v-for="s in safes" :key="s.id" class="flex items-center justify-between rounded-lg border border-slate-100 p-2 text-sm">
              <span>{{ s.name }} - {{ Number(s.opening_balance || 0).toFixed(2) }}</span>
              <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="postSafeOpening(s.id)">{{ t('bankTreasury.postOpening') }}</button>
            </li>
          </ul>
        </div>
      </div>
      <p v-if="loading" class="mt-3 text-sm text-slate-500">{{ t('common.loading') }}</p>
      <p v-if="error" class="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">{{ error }}</p>
    </section>

    <section class="ui-card ui-card-pad mt-6">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="ui-card-title">{{ t('bankTreasury.settlementTitle') }}</h2>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="printSettlement">{{ t('bankTreasury.printReconciliation') }}</button>
          <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="exportSettlementCsv">{{ t('bankTreasury.exportReconciliation') }}</button>
        </div>
      </div>
      <div class="grid gap-3 md:grid-cols-5">
        <select v-model="selectedBankAccountId" class="ui-select md:col-span-2">
          <option value="">{{ t('bankTreasury.bankAccounts') }}</option>
          <option v-for="b in bankAccounts" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
        <input v-model="settlementFilters.from" type="date" class="ui-input" />
        <input v-model="settlementFilters.to" type="date" class="ui-input" />
        <select v-model="settlementFilters.status" class="ui-select">
          <option value="all">{{ t('bankTreasury.statusAll') }}</option>
          <option value="reconciled">{{ t('bankTreasury.statusReconciled') }}</option>
          <option value="unreconciled">{{ t('bankTreasury.statusUnreconciled') }}</option>
        </select>
      </div>
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <div class="rounded-xl border border-slate-200">
          <div class="border-b border-slate-200 px-3 py-2 text-sm font-semibold">{{ t('bankTreasury.bankStatementPane') }}</div>
          <div class="ui-table-wrap">
            <table class="ui-table">
              <thead>
                <tr>
                  <th>{{ t('reports.date') }}</th>
                  <th>{{ t('transactions.description') }}</th>
                  <th>{{ t('transactions.reference') }}</th>
                  <th>{{ t('bankTreasury.openingBalance') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="ln in statementLines" :key="ln.id" class="cursor-pointer" :class="String(selectedStatementLineId) === String(ln.id) ? 'bg-brand-50' : ''" @click="selectedStatementLineId = ln.id">
                  <td>{{ ln.statement_date?.slice(0, 10) }}</td>
                  <td>{{ ln.description || '-' }}</td>
                  <td>{{ ln.reference || '-' }}</td>
                  <td>{{ Number(ln.amount || 0).toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="rounded-xl border border-slate-200">
          <div class="border-b border-slate-200 px-3 py-2 text-sm font-semibold">{{ t('bankTreasury.bookPane') }}</div>
          <ul class="max-h-64 space-y-2 overflow-auto p-3">
            <li v-for="s in suggestions" :key="s.id" class="rounded-lg border border-slate-200 p-2 text-sm">
              <div class="font-medium">{{ s.reference || '-' }}</div>
              <div class="text-slate-500">{{ s.entry_date?.slice(0, 10) }} - {{ s.description || '-' }}</div>
              <div class="mt-1 flex items-center justify-between">
                <span>{{ Number(s.amount_diff || 0).toFixed(2) }}</span>
                <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="pairLine(s.id)">{{ t('bankTreasury.match') }}</button>
              </div>
            </li>
          </ul>
        </div>
      </div>
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <div class="rounded-xl border border-slate-200 p-3">
          <h3 class="mb-2 text-sm font-semibold">{{ t('bankTreasury.differencePanel') }}</h3>
          <p class="text-sm">{{ t('bankTreasury.statementAmount') }}: {{ Number(selectedLine?.amount || 0).toFixed(2) }}</p>
          <p class="text-sm">{{ t('bankTreasury.suggestedCount') }}: {{ suggestions.length }}</p>
          <div class="mt-3 grid gap-2 md:grid-cols-2">
            <select v-model="writeoff.writeoff_account_id" class="ui-select">
              <option value="">{{ t('bankTreasury.writeoffAccount') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
            </select>
            <input v-model="writeoff.reason" class="ui-input" :placeholder="t('bankTreasury.writeoffReason')" />
          </div>
          <button type="button" class="ui-btn-secondary mt-2 !px-2 !py-1 text-xs" @click="writeoffDifference">{{ t('bankTreasury.postWriteoff') }}</button>
        </div>
        <div class="rounded-xl border border-slate-200 p-3">
          <h3 class="mb-2 text-sm font-semibold">{{ t('bankTreasury.reconciliationSummary') }}</h3>
          <p class="text-sm">{{ t('bankTreasury.totalLines') }}: {{ summary?.total_lines ?? 0 }}</p>
          <p class="text-sm">{{ t('bankTreasury.reconciledLines') }}: {{ summary?.reconciled_lines ?? 0 }}</p>
          <p class="text-sm">{{ t('bankTreasury.unreconciledLines') }}: {{ summary?.unreconciled_lines ?? 0 }}</p>
          <p class="text-sm">{{ t('bankTreasury.unreconciledAmount') }}: {{ Number(summary?.unreconciled_amount || 0).toFixed(2) }}</p>
          <p class="mt-2 text-xs text-slate-500">{{ t('bankTreasury.reconciliationRate') }}: {{ Number(reconReport?.summary?.reconciliation_rate_percent || 0).toFixed(2) }}%</p>
        </div>
      </div>
    </section>
  </div>
</template>
