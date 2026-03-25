<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const from = ref(new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10));
const to = ref(new Date().toISOString().slice(0, 10));
const asOf = ref(new Date().toISOString().slice(0, 10));

const pl = ref(null);
const bs = ref(null);
const error = ref('');
const loading = ref(false);

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

watch(() => company.currentCompanyId, () => {
  pl.value = null;
  bs.value = null;
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('reports.title') }}</h1>
      <p class="ui-page-desc">{{ t('reports.pl') }} · {{ t('reports.bs') }}</p>
    </div>

    <div class="grid gap-6 lg:grid-cols-2 lg:gap-8">
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
              v-for="(row, i) in pl.lines"
              :key="i"
              class="flex justify-between gap-2 border-b border-slate-50 pb-2 text-slate-600 last:border-0 last:pb-0"
            >
              <span><span class="font-mono text-xs font-bold text-brand-800">{{ row.code }}</span> {{ row.name }}</span>
              <span class="shrink-0 font-semibold tabular-nums text-slate-900">{{ Number(row.net).toFixed(2) }}</span>
            </li>
          </ul>
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
            A − (L + E) =
            {{ bs.assets_liabilities_plus_equity_check?.toFixed?.(4) ?? bs.assets_liabilities_plus_equity_check }}
          </p>
          <ul class="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3 scrollbar-thin">
            <li
              v-for="(row, i) in bs.lines"
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
        </div>
      </section>
    </div>

    <p v-if="error" class="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-100">
      {{ error }}
    </p>
  </div>
</template>
