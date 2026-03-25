<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/api/client';

const { t, locale } = useI18n();
const company = useCompanyStore();
const auth = useAuthStore();

const loading = ref(false);
const metrics = ref(null);

const nf = computed(() =>
  new Intl.NumberFormat(locale.value === 'ar' ? 'ar-SA' : 'en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
);

function fmt(n) {
  return nf.value.format(Number(n) || 0);
}

const netClass = computed(() => {
  const v = metrics.value?.net_profit_month ?? 0;
  if (v > 0) return 'text-emerald-700';
  if (v < 0) return 'text-rose-700';
  return 'text-slate-900';
});

async function load() {
  if (!company.currentCompanyId) {
    metrics.value = null;
    return;
  }
  loading.value = true;
  try {
    const { data } = await api.get('/api/reports/dashboard');
    metrics.value = data;
  } catch {
    metrics.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">
        {{ t('dashboard.welcome') }}{{ auth.user?.full_name ? `، ${auth.user.full_name}` : '' }}
      </h1>
      <p class="ui-page-desc">{{ t('dashboard.summary') }}</p>
    </div>

    <div
      v-if="!company.currentCompanyId"
      class="rounded-2xl border border-amber-200/80 bg-gradient-to-br from-amber-50 to-orange-50/80 p-5 text-amber-950 shadow-sm ring-1 ring-amber-100"
    >
      <p class="text-sm font-medium leading-relaxed">{{ t('company.selectHint') }}</p>
    </div>

    <template v-else>
      <p v-if="metrics?.period" class="text-xs font-medium text-slate-500">
        {{ t('dashboard.kpiSubtitle') }}
        ·
        {{ t('dashboard.period', { from: metrics.period.from, to: metrics.period.to }) }}
      </p>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div class="ui-stat">
          <div class="relative flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">
                {{ t('dashboard.revenueThisMonth') }}
              </p>
              <p class="mt-2 text-2xl font-extrabold tracking-tight text-emerald-800 tabular-nums sm:text-3xl">
                {{ loading ? '—' : fmt(metrics?.revenue_month) }}
              </p>
            </div>
            <span
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200/60"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
              </svg>
            </span>
          </div>
        </div>

        <div class="ui-stat">
          <div class="relative flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">
                {{ t('dashboard.expensesThisMonth') }}
              </p>
              <p class="mt-2 text-2xl font-extrabold tracking-tight text-slate-900 tabular-nums sm:text-3xl">
                {{ loading ? '—' : fmt(metrics?.expenses_month) }}
              </p>
            </div>
            <span
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-900 ring-1 ring-orange-200/60"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" />
              </svg>
            </span>
          </div>
        </div>

        <div class="ui-stat ring-2 ring-brand-200/60">
          <div class="relative flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">
                {{ t('dashboard.netProfit') }}
              </p>
              <p class="mt-2 text-2xl font-extrabold tracking-tight tabular-nums sm:text-3xl" :class="netClass">
                {{ loading ? '—' : fmt(metrics?.net_profit_month) }}
              </p>
            </div>
            <span
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-100 text-brand-800 ring-1 ring-brand-200/60"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
            </span>
          </div>
        </div>

        <div class="ui-stat">
          <div class="relative flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-bold uppercase tracking-wide text-slate-500">
                {{ t('dashboard.unpaidInvoices') }}
              </p>
              <p class="mt-2 text-2xl font-extrabold tracking-tight text-amber-900 tabular-nums sm:text-3xl">
                {{ loading ? '—' : fmt(metrics?.unpaid_invoices_total) }}
              </p>
              <p v-if="!loading && metrics" class="mt-1 text-xs font-medium text-slate-500">
                {{ t('dashboard.unpaidDetail', { count: metrics.unpaid_invoices_count }) }}
              </p>
            </div>
            <span
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-900 ring-1 ring-amber-200/60"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
            </span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
