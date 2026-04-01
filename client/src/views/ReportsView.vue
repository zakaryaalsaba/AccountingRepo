<script setup>
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useFiscalStore } from '@/stores/fiscal';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const fiscal = useFiscalStore();

const from = ref(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10));
const to = ref(new Date().toISOString().slice(0, 10));
const asOf = ref(new Date().toISOString().slice(0, 10));
const fromB = ref(new Date(new Date().getFullYear() - 1, 0, 1).toISOString().slice(0, 10));
const toB = ref(new Date(new Date().getFullYear() - 1, 11, 31).toISOString().slice(0, 10));
const asOfB = ref(new Date(new Date().getFullYear() - 1, 11, 31).toISOString().slice(0, 10));

const pl = ref(null);
const bs = ref(null);
const cf = ref(null);
const trial = ref(null);
const apAging = ref(null);
const accounts = ref([]);
const ledgerAccountId = ref('');
const ledger = ref(null);
const plCompare = ref(null);
const bsCompare = ref(null);
const error = ref('');
const loading = ref(false);
const reportPresetName = ref('');
const presetStorageKey = 'reports-presets-v1';
const reportPresets = ref([]);
const reportCatalog = ref([]);
const libraryReportKey = ref('projects/profitability');
const libraryLoading = ref(false);
const libraryResult = ref(null);
const libraryRows = ref([]);
const libraryColumns = ref([]);
const libraryFilters = ref({
  from: from.value,
  to: to.value,
  as_of: asOf.value,
  account_type: '',
  level: '',
  branch_id: '',
  project_id: '',
  service_card_id: '',
  account_id: '',
  variant: 'detailed',
});
const rowLimits = ref({
  pl: 80,
  bs: 80,
  cf: 80,
  ap: 80,
  trial: 80,
  ledger: 80,
});
const cardAccountId = ref('');
const cardReport = ref(null);
const cardExpenses = ref([]);
const cardPayments = ref([]);
const cardPayableLinks = ref([]);
const cardLoading = ref(false);
const selectedCardVendor = ref('');

function visibleRows(list, key) {
  if (!Array.isArray(list)) return [];
  const lim = Number(rowLimits.value[key] || 80);
  return list.slice(0, lim);
}

function canLoadMore(list, key) {
  return Array.isArray(list) && list.length > Number(rowLimits.value[key] || 80);
}

function loadMore(key, step = 80) {
  rowLimits.value[key] = Number(rowLimits.value[key] || 80) + step;
}

function loadPresets() {
  try {
    reportPresets.value = JSON.parse(localStorage.getItem(presetStorageKey) || '[]');
  } catch {
    reportPresets.value = [];
  }
}

function savePreset() {
  const name = String(reportPresetName.value || '').trim();
  if (!name) return;
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name,
    filters: {
      from: from.value,
      to: to.value,
      asOf: asOf.value,
      fromB: fromB.value,
      toB: toB.value,
      asOfB: asOfB.value,
      ledgerAccountId: ledgerAccountId.value,
    },
  };
  reportPresets.value = [item, ...reportPresets.value].slice(0, 20);
  localStorage.setItem(presetStorageKey, JSON.stringify(reportPresets.value));
  reportPresetName.value = '';
}

function applyPreset(id) {
  const p = reportPresets.value.find((x) => x.id === id);
  if (!p) return;
  from.value = p.filters.from;
  to.value = p.filters.to;
  asOf.value = p.filters.asOf;
  fromB.value = p.filters.fromB;
  toB.value = p.filters.toB;
  asOfB.value = p.filters.asOfB;
  ledgerAccountId.value = p.filters.ledgerAccountId || ledgerAccountId.value;
}

function flattenRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = Object.values(payload).filter(Array.isArray);
  if (!candidates.length) return [];
  const best = [...candidates].sort((a, b) => b.length - a.length)[0];
  return Array.isArray(best) ? best : [];
}

function computeColumns(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return Object.keys(rows[0]).slice(0, 8);
}

async function loadReportCatalog() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/reports/catalog');
    reportCatalog.value = data.reports || [];
  } catch {
    reportCatalog.value = [];
  }
}

async function runLibraryReport() {
  if (!company.currentCompanyId || !libraryReportKey.value) return;
  libraryLoading.value = true;
  error.value = '';
  try {
    const params = {};
    Object.entries(libraryFilters.value).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) params[k] = v;
    });
    const { data } = await api.get(`/api/reports/${libraryReportKey.value}`, { params });
    libraryResult.value = data;
    libraryRows.value = flattenRows(data);
    libraryColumns.value = computeColumns(libraryRows.value);
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    libraryResult.value = null;
    libraryRows.value = [];
    libraryColumns.value = [];
  } finally {
    libraryLoading.value = false;
  }
}

function printLibrary() {
  window.print();
}

function exportLibrary() {
  const rows = libraryRows.value;
  if (!rows.length) return;
  const cols = libraryColumns.value;
  const csv = [cols, ...rows.map((r) => cols.map((c) => (r[c] ?? '')))]
    .map((line) => line.map((x) => `"${String(x).replaceAll('"', '""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `report_${libraryReportKey.value.replaceAll('/', '_')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function runPL() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/reports/profit-loss', {
      params: { from: from.value, to: to.value },
    });
    pl.value = data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    pl.value = null;
  } finally {
    loading.value = false;
  }
}

async function runBS() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/reports/balance-sheet', {
      params: { as_of: asOf.value },
    });
    bs.value = data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    bs.value = null;
  } finally {
    loading.value = false;
  }
}

async function runCF() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/reports/cash-flow', {
      params: { from: from.value, to: to.value },
    });
    cf.value = data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    cf.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadAccounts() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/accounts');
    accounts.value = data.accounts || [];
    if (!ledgerAccountId.value && accounts.value.length) {
      ledgerAccountId.value = accounts.value[0].id;
    }
  } catch {
    accounts.value = [];
  }
}

async function runTrial() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/reports/trial-balance', {
      params: { as_of: asOf.value },
    });
    trial.value = data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    trial.value = null;
  } finally {
    loading.value = false;
  }
}

async function runApAging() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/reports/ap-aging', {
      params: { as_of: asOf.value },
    });
    apAging.value = data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    apAging.value = null;
  } finally {
    loading.value = false;
  }
}

async function runLedger() {
  if (!company.currentCompanyId || !ledgerAccountId.value) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get(`/api/reports/account-ledger/${ledgerAccountId.value}`, {
      params: { from: from.value, to: to.value },
    });
    ledger.value = data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    ledger.value = null;
  } finally {
    loading.value = false;
  }
}

async function runCompare() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [plc, bsc] = await Promise.all([
      api.get('/api/reports/profit-loss-compare', {
        params: { from_a: from.value, to_a: to.value, from_b: fromB.value, to_b: toB.value },
      }),
      api.get('/api/reports/balance-sheet-compare', {
        params: { as_of_a: asOf.value, as_of_b: asOfB.value },
      }),
    ]);
    plCompare.value = plc.data;
    bsCompare.value = bsc.data;
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    plCompare.value = null;
    bsCompare.value = null;
  } finally {
    loading.value = false;
  }
}

async function runCardReports() {
  if (!company.currentCompanyId || !cardAccountId.value) return;
  cardLoading.value = true;
  error.value = '';
  try {
    const [cardRes, expensesRes, paymentsRes, apRes] = await Promise.all([
      api.get('/api/reports/account-card', {
        params: {
          account_id: cardAccountId.value,
          from: from.value,
          to: to.value,
          variant: 'detailed',
          limit: 400,
          offset: 0,
        },
      }),
      api.get('/api/expenses'),
      api.get('/api/payments'),
      api.get('/api/reports/ap-aging', { params: { as_of: asOf.value } }),
    ]);

    cardReport.value = cardRes.data || null;
    const expenses = (expensesRes.data?.expenses || []).filter((x) => String(x.payment_method || '').toLowerCase() === 'card');
    const payments = (paymentsRes.data?.payments || []).filter((x) => String(x.method || '').toLowerCase() === 'card');
    cardExpenses.value = expenses;
    cardPayments.value = payments.map((p) => {
      const unallocated = Number(p.unallocated_amount ?? p.unallocated ?? 0);
      return {
        ...p,
        settlement_status: unallocated > 0 ? 'unsettled' : 'settled',
      };
    });

    const apLines = apRes.data?.lines || [];
    cardPayableLinks.value = expenses
      .map((e) => ({
        expense_id: e.id,
        vendor_name: e.vendor_name || '-',
        expense_amount: Number(e.amount || 0),
        expense_date: e.expense_date,
        matched_payables: apLines.filter((ap) =>
          String(ap.vendor_name || '').toLowerCase() === String(e.vendor_name || '').toLowerCase()
        ),
      }))
      .filter((x) => x.matched_payables.length > 0);
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
    cardReport.value = null;
    cardExpenses.value = [];
    cardPayments.value = [];
    cardPayableLinks.value = [];
  } finally {
    cardLoading.value = false;
  }
}

watch(() => company.currentCompanyId, () => {
  pl.value = null;
  bs.value = null;
  cf.value = null;
  trial.value = null;
  apAging.value = null;
  ledger.value = null;
  plCompare.value = null;
  bsCompare.value = null;
  loadAccounts();
});

watch(
  () => fiscal.currentFiscalYear,
  (fy) => {
    if (!fy) return;
    from.value = String(fy.start_date).slice(0, 10);
    to.value = String(fy.end_date).slice(0, 10);
    asOf.value = String(fy.end_date).slice(0, 10);
  }
);

onMounted(loadAccounts);
onMounted(loadPresets);
onMounted(loadReportCatalog);
watch(accounts, () => {
  if (!cardAccountId.value && accounts.value.length) {
    const candidate = accounts.value.find((a) => /card|بطاقة/i.test(`${a.name || ''} ${a.code || ''}`));
    cardAccountId.value = candidate?.id || accounts.value[0].id;
  }
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('reports.title') }}</h1>
      <p class="ui-page-desc">{{ t('reports.pl') }} · {{ t('reports.bs') }}</p>
    </div>

    <div class="grid gap-6 lg:grid-cols-2 lg:gap-8">
      <section class="ui-card ui-card-pad relative overflow-hidden lg:col-span-2">
        <h2 class="ui-card-title mb-4">{{ t('reports.savedPresets') }}</h2>
        <div class="flex flex-wrap items-end gap-3">
          <input v-model="reportPresetName" type="text" class="ui-input w-[18rem] max-w-full" :placeholder="t('reports.presetName')" />
          <button type="button" class="ui-btn-secondary" @click="savePreset">{{ t('reports.saveCurrentFilters') }}</button>
          <select class="ui-select w-[18rem] max-w-full" @change="applyPreset($event.target.value)">
            <option value="">{{ t('reports.applyPreset') }}</option>
            <option v-for="p in reportPresets" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
      </section>
      <section class="ui-card ui-card-pad relative overflow-hidden">
        <div class="pointer-events-none absolute -end-8 -top-8 h-28 w-28 rounded-full bg-brand-400/15 blur-2xl" />
        <h2 class="ui-card-title mb-5">{{ t('reports.pl') }}</h2>
        <div class="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label class="ui-label">{{ t('reports.from') }}</label>
            <input v-model="from" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <div>
            <label class="ui-label">{{ t('reports.to') }}</label>
            <input v-model="to" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <button type="button" class="ui-btn-primary" :disabled="loading" @click="runPL">
            {{ t('reports.run') }}
          </button>
        </div>
        <div v-if="pl" class="space-y-4 text-sm">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.revenue') }}</p>
              <p class="mt-1 text-xl font-bold tabular-nums text-slate-900">
                {{ pl.revenue_total?.toFixed?.(2) ?? pl.revenue_total }}
              </p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.expense') }}</p>
              <p class="mt-1 text-xl font-bold tabular-nums text-slate-900">
                {{ pl.expense_total?.toFixed?.(2) ?? pl.expense_total }}
              </p>
            </div>
            <div class="rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 p-4 text-white shadow-lg shadow-brand-900/20 sm:col-span-1">
              <p class="text-xs font-bold uppercase tracking-wide text-brand-100">{{ t('reports.net') }}</p>
              <p class="mt-1 text-xl font-extrabold tabular-nums">
                {{ pl.net_income?.toFixed?.(2) ?? pl.net_income }}
              </p>
            </div>
          </div>
          <ul class="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 scrollbar-thin">
            <li
              v-for="(row, i) in visibleRows(pl.lines, 'pl')"
              :key="i"
              class="flex justify-between gap-2 border-b border-slate-50 pb-2 text-slate-600 last:border-0 last:pb-0"
            >
              <span><span class="font-mono text-xs font-bold text-brand-800">{{ row.code }}</span> {{ row.name }}</span>
              <span class="shrink-0 font-semibold tabular-nums text-slate-900">{{ Number(row.net).toFixed(2) }}</span>
            </li>
          </ul>
          <button v-if="canLoadMore(pl.lines, 'pl')" type="button" class="ui-btn-secondary mt-2 text-xs" @click="loadMore('pl')">
            {{ t('reports.loadMore') }}
          </button>
        </div>
      </section>

      <section class="ui-card ui-card-pad relative overflow-hidden">
        <div class="pointer-events-none absolute -end-8 -top-8 h-28 w-28 rounded-full bg-cyan-400/15 blur-2xl" />
        <h2 class="ui-card-title mb-5">{{ t('reports.bs') }}</h2>
        <div class="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label class="ui-label">{{ t('reports.asOf') }}</label>
            <input v-model="asOf" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <button type="button" class="ui-btn-primary" :disabled="loading" @click="runBS">
            {{ t('reports.run') }}
          </button>
        </div>
        <div v-if="bs" class="space-y-4 text-sm">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.assets') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ bs.assets?.toFixed?.(2) ?? bs.assets }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.liabilities') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ bs.liabilities?.toFixed?.(2) ?? bs.liabilities }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.equity') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ bs.equity?.toFixed?.(2) ?? bs.equity }}</p>
            </div>
          </div>
          <p class="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-600">
            {{ t('reports.balanceCheck') }}
            {{ bs.assets_liabilities_plus_equity_check?.toFixed?.(4) ?? bs.assets_liabilities_plus_equity_check }}
          </p>
          <ul class="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 scrollbar-thin">
            <li
              v-for="(row, i) in visibleRows(bs.lines, 'bs')"
              :key="i"
              class="flex justify-between gap-2 border-b border-slate-50 pb-2 text-slate-600 last:border-0 last:pb-0"
            >
              <span>
                <span class="ui-badge-slate me-2 text-[10px]">{{ row.account_type }}</span>
                <span class="font-mono text-xs font-bold text-brand-800">{{ row.code }}</span>
                {{ row.name }}
              </span>
              <span class="shrink-0 font-semibold tabular-nums">{{ Number(row.balance).toFixed(2) }}</span>
            </li>
          </ul>
          <button v-if="canLoadMore(bs.lines, 'bs')" type="button" class="ui-btn-secondary mt-2 text-xs" @click="loadMore('bs')">
            {{ t('reports.loadMore') }}
          </button>
        </div>
      </section>

      <section class="ui-card ui-card-pad relative overflow-hidden">
        <h2 class="ui-card-title mb-5">{{ t('reports.cashFlow') }}</h2>
        <div class="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label class="ui-label">{{ t('reports.from') }}</label>
            <input v-model="from" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <div>
            <label class="ui-label">{{ t('reports.to') }}</label>
            <input v-model="to" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <button type="button" class="ui-btn-primary" :disabled="loading" @click="runCF">
            {{ t('reports.run') }}
          </button>
        </div>
        <div v-if="cf" class="space-y-4 text-sm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.operating') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(cf.operating_cash_flow).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.investing') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(cf.investing_cash_flow).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.financing') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(cf.financing_cash_flow).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 p-4 text-white shadow-lg shadow-brand-900/20">
              <p class="text-xs font-bold uppercase tracking-wide text-brand-100">{{ t('reports.netCashFlow') }}</p>
              <p class="mt-1 text-xl font-extrabold tabular-nums">{{ Number(cf.net_cash_flow).toFixed(2) }}</p>
            </div>
          </div>
          <ul class="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 scrollbar-thin">
            <li
              v-for="row in visibleRows(cf.lines, 'cf')"
              :key="row.transaction_id"
              class="flex justify-between gap-2 border-b border-slate-50 pb-2 text-slate-600 last:border-0 last:pb-0"
            >
              <span>{{ row.entry_date }} — {{ row.description || '—' }} ({{ t(`reports.${row.section}`) }})</span>
              <span class="shrink-0 tabular-nums">{{ Number(row.cash_change).toFixed(2) }}</span>
            </li>
          </ul>
          <button v-if="canLoadMore(cf.lines, 'cf')" type="button" class="ui-btn-secondary mt-2 text-xs" @click="loadMore('cf')">
            {{ t('reports.loadMore') }}
          </button>
        </div>
      </section>

      <section class="ui-card ui-card-pad relative overflow-hidden">
        <h2 class="ui-card-title mb-5">{{ t('reports.apAging') }}</h2>
        <div class="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label class="ui-label">{{ t('reports.asOf') }}</label>
            <input v-model="asOf" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <button type="button" class="ui-btn-primary" :disabled="loading" @click="runApAging">
            {{ t('reports.run') }}
          </button>
        </div>
        <div v-if="apAging" class="space-y-4 text-sm">
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.bucket0to30') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(apAging.buckets.current).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.bucket31to60') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(apAging.buckets['31_60']).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.bucket61to90') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(apAging.buckets['61_90']).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.bucket90Plus') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(apAging.buckets['90_plus']).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 p-4 text-white shadow-lg shadow-brand-900/20">
              <p class="text-xs font-bold uppercase tracking-wide text-brand-100">{{ t('reports.totalPayables') }}</p>
              <p class="mt-1 text-xl font-extrabold tabular-nums">{{ Number(apAging.buckets.total).toFixed(2) }}</p>
            </div>
          </div>
          <ul class="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 scrollbar-thin">
            <li
              v-for="row in visibleRows(apAging.lines, 'ap')"
              :key="row.bill_id"
              class="flex justify-between gap-2 border-b border-slate-50 pb-2 text-slate-600 last:border-0 last:pb-0"
            >
              <span>{{ row.vendor_name }} — {{ row.bill_number || row.bill_id }}</span>
              <span class="shrink-0 tabular-nums">{{ Number(row.outstanding).toFixed(2) }}</span>
            </li>
          </ul>
          <button v-if="canLoadMore(apAging.lines, 'ap')" type="button" class="ui-btn-secondary mt-2 text-xs" @click="loadMore('ap')">
            {{ t('reports.loadMore') }}
          </button>
        </div>
      </section>
    </div>

    <div class="grid gap-6 lg:grid-cols-2 lg:gap-8">
      <section class="ui-card ui-card-pad relative overflow-hidden">
        <h2 class="ui-card-title mb-5">{{ t('reports.trialBalance') }}</h2>
        <div class="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label class="ui-label">{{ t('reports.asOf') }}</label>
            <input v-model="asOf" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <button type="button" class="ui-btn-primary" :disabled="loading" @click="runTrial">
            {{ t('reports.run') }}
          </button>
        </div>
        <div v-if="trial" class="space-y-4 text-sm">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.debit') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(trial.totals.debit_total).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.credit') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(trial.totals.credit_total).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.difference') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(trial.totals.difference).toFixed(2) }}</p>
            </div>
          </div>
          <ul class="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 scrollbar-thin">
            <li
              v-for="row in visibleRows(trial.lines, 'trial')"
              :key="row.id"
              class="flex justify-between gap-2 border-b border-slate-50 pb-2 text-slate-600 last:border-0 last:pb-0"
            >
              <span><span class="font-mono text-xs font-bold text-brand-800">{{ row.code }}</span> {{ row.name }}</span>
              <span class="shrink-0 tabular-nums">{{ Number(row.debit_total).toFixed(2) }} / {{ Number(row.credit_total).toFixed(2) }}</span>
            </li>
          </ul>
          <button v-if="canLoadMore(trial.lines, 'trial')" type="button" class="ui-btn-secondary mt-2 text-xs" @click="loadMore('trial')">
            {{ t('reports.loadMore') }}
          </button>
        </div>
      </section>

      <section class="ui-card ui-card-pad relative overflow-hidden">
        <h2 class="ui-card-title mb-5">{{ t('reports.accountLedger') }}</h2>
        <div class="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label class="ui-label">{{ t('reports.account') }}</label>
            <select v-model="ledgerAccountId" class="ui-select w-[18rem] max-w-full">
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.code }} — {{ a.name }}</option>
            </select>
          </div>
          <div>
            <label class="ui-label">{{ t('reports.from') }}</label>
            <input v-model="from" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <div>
            <label class="ui-label">{{ t('reports.to') }}</label>
            <input v-model="to" type="date" class="ui-input w-auto min-w-[10rem]" />
          </div>
          <button type="button" class="ui-btn-primary" :disabled="loading" @click="runLedger">
            {{ t('reports.run') }}
          </button>
        </div>
        <div v-if="ledger" class="space-y-4 text-sm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.openingBalance') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(ledger.opening_balance).toFixed(2) }}</p>
            </div>
            <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.closingBalance') }}</p>
              <p class="mt-1 text-lg font-bold tabular-nums">{{ Number(ledger.closing_balance).toFixed(2) }}</p>
            </div>
          </div>
          <ul class="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 scrollbar-thin">
            <li
              v-for="(row, i) in visibleRows(ledger.entries, 'ledger')"
              :key="`${row.transaction_id}-${i}`"
              class="flex justify-between gap-2 border-b border-slate-50 pb-2 text-slate-600 last:border-0 last:pb-0"
            >
              <span>{{ row.entry_date }} — {{ row.description || '—' }}</span>
              <span class="shrink-0 tabular-nums">{{ Number(row.running_balance).toFixed(2) }}</span>
            </li>
          </ul>
          <button v-if="canLoadMore(ledger.entries, 'ledger')" type="button" class="ui-btn-secondary mt-2 text-xs" @click="loadMore('ledger')">
            {{ t('reports.loadMore') }}
          </button>
        </div>
      </section>
    </div>

    <section class="ui-card ui-card-pad relative overflow-hidden">
      <h2 class="ui-card-title mb-5">{{ t('reports.compare') }}</h2>
      <div class="mb-6 grid gap-3 lg:grid-cols-3">
        <div>
          <label class="ui-label">{{ t('reports.periodA') }} {{ t('reports.from') }}</label>
          <input v-model="from" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('reports.periodA') }} {{ t('reports.to') }}</label>
          <input v-model="to" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('reports.periodB') }} {{ t('reports.from') }}</label>
          <input v-model="fromB" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('reports.periodB') }} {{ t('reports.to') }}</label>
          <input v-model="toB" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('reports.periodA') }} {{ t('reports.asOf') }}</label>
          <input v-model="asOf" type="date" class="ui-input" />
        </div>
        <div>
          <label class="ui-label">{{ t('reports.periodB') }} {{ t('reports.asOf') }}</label>
          <input v-model="asOfB" type="date" class="ui-input" />
        </div>
      </div>
      <button type="button" class="ui-btn-primary mb-5" :disabled="loading" @click="runCompare">
        {{ t('reports.run') }}
      </button>
      <div v-if="plCompare && bsCompare" class="grid gap-4 lg:grid-cols-2">
        <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100 text-sm">
          <p class="font-semibold mb-2">{{ t('reports.pl') }}</p>
          <p>{{ t('reports.delta') }} {{ t('reports.revenue') }}: {{ Number(plCompare.delta.revenue_total).toFixed(2) }}</p>
          <p>{{ t('reports.delta') }} {{ t('reports.expense') }}: {{ Number(plCompare.delta.expense_total).toFixed(2) }}</p>
          <p class="font-semibold">{{ t('reports.delta') }} {{ t('reports.net') }}: {{ Number(plCompare.delta.net_income).toFixed(2) }}</p>
        </div>
        <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100 text-sm">
          <p class="font-semibold mb-2">{{ t('reports.bs') }}</p>
          <p>{{ t('reports.delta') }} {{ t('reports.assets') }}: {{ Number(bsCompare.delta.assets).toFixed(2) }}</p>
          <p>{{ t('reports.delta') }} {{ t('reports.liabilities') }}: {{ Number(bsCompare.delta.liabilities).toFixed(2) }}</p>
          <p class="font-semibold">{{ t('reports.delta') }} {{ t('reports.equity') }}: {{ Number(bsCompare.delta.equity).toFixed(2) }}</p>
        </div>
      </div>
    </section>

    <section class="ui-card ui-card-pad relative overflow-hidden mt-6">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 class="ui-card-title">{{ t('reports.libraryTitle') }}</h2>
        <div class="flex gap-2">
          <button type="button" class="ui-btn-secondary text-xs" @click="printLibrary">{{ t('reports.print') }}</button>
          <button type="button" class="ui-btn-secondary text-xs" @click="exportLibrary">{{ t('reports.export') }}</button>
        </div>
      </div>
      <div class="grid gap-3 lg:grid-cols-4">
        <select v-model="libraryReportKey" class="ui-select lg:col-span-2">
          <option v-for="r in reportCatalog" :key="r.slug" :value="r.slug">{{ r.name }}</option>
        </select>
        <input v-model="libraryFilters.from" type="date" class="ui-input" />
        <input v-model="libraryFilters.to" type="date" class="ui-input" />
        <input v-model="libraryFilters.as_of" type="date" class="ui-input" />
        <select v-model="libraryFilters.account_type" class="ui-select">
          <option value="">{{ t('reports.accountType') }}</option>
          <option value="ASSET">ASSET</option>
          <option value="LIABILITY">LIABILITY</option>
          <option value="EQUITY">EQUITY</option>
          <option value="REVENUE">REVENUE</option>
          <option value="EXPENSE">EXPENSE</option>
        </select>
        <input v-model="libraryFilters.level" type="number" min="1" max="6" class="ui-input" :placeholder="t('reports.level')" />
        <input v-model="libraryFilters.branch_id" class="ui-input" :placeholder="t('reports.branchId')" />
        <input v-model="libraryFilters.project_id" class="ui-input" :placeholder="t('reports.projectId')" />
        <input v-model="libraryFilters.service_card_id" class="ui-input" :placeholder="t('reports.serviceCardId')" />
        <select v-model="libraryFilters.account_id" class="ui-select">
          <option value="">{{ t('reports.account') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.code }} — {{ a.name }}</option>
        </select>
        <select v-model="libraryFilters.variant" class="ui-select">
          <option value="detailed">detailed</option>
          <option value="summary">summary</option>
          <option value="grouped">grouped</option>
        </select>
      </div>
      <button type="button" class="ui-btn-primary mt-3" :disabled="libraryLoading" @click="runLibraryReport">{{ t('reports.run') }}</button>

      <div v-if="libraryRows.length" class="mt-4 ui-table-wrap">
        <table class="ui-table">
          <thead>
            <tr>
              <th v-for="c in libraryColumns" :key="c">{{ c }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, idx) in visibleRows(libraryRows, 'pl')" :key="idx">
              <td v-for="c in libraryColumns" :key="`${idx}-${c}`">{{ r[c] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="libraryResult" class="mt-3 text-sm text-slate-600">{{ t('reports.noRows') }}</p>
    </section>

    <section class="ui-card ui-card-pad relative overflow-hidden mt-6">
      <h2 class="ui-card-title mb-4">{{ t('reports.cardTitle') }}</h2>
      <div class="grid gap-3 lg:grid-cols-5">
        <select v-model="cardAccountId" class="ui-select lg:col-span-2">
          <option value="">{{ t('reports.account') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.code }} — {{ a.name }}</option>
        </select>
        <input v-model="from" type="date" class="ui-input" />
        <input v-model="to" type="date" class="ui-input" />
        <input v-model="asOf" type="date" class="ui-input" />
      </div>
      <button type="button" class="ui-btn-primary mt-3" :disabled="cardLoading" @click="runCardReports">{{ t('reports.run') }}</button>

      <div v-if="cardReport" class="mt-4 grid gap-4 lg:grid-cols-3 text-sm">
        <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.cardEntries') }}</p>
          <p class="mt-1 text-lg font-bold tabular-nums">{{ cardReport.pagination?.total_count || cardReport.rows?.length || 0 }}</p>
        </div>
        <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.cardExpenses') }}</p>
          <p class="mt-1 text-lg font-bold tabular-nums">{{ cardExpenses.length }}</p>
        </div>
        <div class="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-100">
          <p class="text-xs font-bold uppercase tracking-wide text-slate-500">{{ t('reports.cardUnsettledPayments') }}</p>
          <p class="mt-1 text-lg font-bold tabular-nums">{{ cardPayments.filter((x) => x.settlement_status === 'unsettled').length }}</p>
        </div>
      </div>

      <div v-if="cardPayments.length" class="mt-4">
        <h3 class="mb-2 text-sm font-semibold">{{ t('reports.cardSettlementStatus') }}</h3>
        <div class="ui-table-wrap">
          <table class="ui-table">
            <thead>
              <tr>
                <th>{{ t('reports.date') }}</th>
                <th>{{ t('reports.amount') }}</th>
                <th>{{ t('reports.reference') }}</th>
                <th>{{ t('reports.status') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in cardPayments" :key="p.id">
                <td>{{ String(p.payment_date || p.date || '').slice(0, 10) }}</td>
                <td>{{ Number(p.amount || 0).toFixed(2) }}</td>
                <td>{{ p.reference || '-' }}</td>
                <td>
                  <span class="ui-badge-slate">{{ p.settlement_status === 'settled' ? t('reports.settled') : t('reports.unsettled') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="cardPayableLinks.length" class="mt-4">
        <div class="mb-2 flex items-center gap-2">
          <h3 class="text-sm font-semibold">{{ t('reports.cardPayableDrilldown') }}</h3>
          <select v-model="selectedCardVendor" class="ui-select w-64">
            <option value="">{{ t('reports.allVendors') }}</option>
            <option v-for="r in cardPayableLinks" :key="r.expense_id" :value="r.vendor_name">{{ r.vendor_name }}</option>
          </select>
        </div>
        <div class="ui-table-wrap">
          <table class="ui-table">
            <thead>
              <tr>
                <th>{{ t('expenses.vendor') }}</th>
                <th>{{ t('reports.amount') }}</th>
                <th>{{ t('reports.date') }}</th>
                <th>{{ t('reports.payableOpenItems') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in cardPayableLinks.filter((x) => !selectedCardVendor || x.vendor_name === selectedCardVendor)"
                :key="r.expense_id"
              >
                <td>{{ r.vendor_name }}</td>
                <td>{{ Number(r.expense_amount || 0).toFixed(2) }}</td>
                <td>{{ String(r.expense_date || '').slice(0, 10) }}</td>
                <td>{{ r.matched_payables.length }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <p v-if="error" class="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-100">
      {{ error }}
    </p>
  </div>
</template>
