<script setup>
import { ref, onMounted, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const invoices = ref([]);
const loading = ref(false);
const error = ref('');

const hasBalances = computed(() =>
  (invoices.value || []).some((i) => i.total_amount !== undefined && i.total_amount !== null)
);

const form = ref({
  customer_name: '',
  amount: '',
  invoice_date: new Date().toISOString().slice(0, 10),
  status: 'unpaid',
  payer_type: 'customer',
  payer_id: '',
});

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}

function invoiceTotal(inv) {
  return inv.total_amount != null ? Number(inv.total_amount) : Number(inv.amount);
}

function invoicePaid(inv) {
  if (inv.paid_amount != null) return Number(inv.paid_amount);
  return inv.status === 'paid' ? invoiceTotal(inv) : 0;
}

function invoiceBalance(inv) {
  if (inv.balance_remaining != null) return Number(inv.balance_remaining);
  return Math.max(0, invoiceTotal(inv) - invoicePaid(inv));
}

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/api/invoices');
    invoices.value = data.invoices || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  } finally {
    loading.value = false;
  }
}

async function add() {
  error.value = '';
  try {
    const body = {
      customer_name: form.value.customer_name,
      amount: Number(form.value.amount),
      invoice_date: form.value.invoice_date,
      status: form.value.status,
    };
    if (form.value.payer_id !== '' && form.value.payer_id != null) {
      body.payer_id = parseInt(String(form.value.payer_id), 10);
    }
    if (form.value.payer_type) body.payer_type = form.value.payer_type;
    await api.post('/api/invoices', body);
    form.value = {
      customer_name: '',
      amount: '',
      invoice_date: new Date().toISOString().slice(0, 10),
      status: 'unpaid',
      payer_type: 'customer',
      payer_id: '',
    };
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function remove(id) {
  if (!confirm('OK?')) return;
  try {
    await api.delete(`/api/invoices/${id}`);
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function statusLabel(s) {
  const map = {
    draft: 'invoices.draft',
    unpaid: 'invoices.unpaid',
    partially_paid: 'invoices.partiallyPaid',
    paid: 'invoices.paid',
  };
  return t(map[s] || s);
}

function statusBadgeClass(s) {
  if (s === 'paid') return 'ui-badge-emerald';
  if (s === 'partially_paid') return 'ui-badge-sky';
  if (s === 'unpaid') return 'ui-badge-amber';
  return 'ui-badge-slate';
}

function payerLabel(p) {
  const map = {
    customer: 'invoices.payerCustomer',
    patient: 'invoices.payerPatient',
    insurance: 'invoices.payerInsurance',
  };
  return t(map[p] || p);
}

onMounted(load);
watch(() => company.currentCompanyId, load);
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('invoices.title') }}</h1>
      <p class="ui-page-desc">{{ t('invoices.add') }}</p>
      <p v-if="hasBalances" class="mt-2 text-sm text-slate-600">{{ t('invoices.payHint') }}</p>
    </div>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-5">{{ t('invoices.add') }}</h2>
      <form class="grid gap-4 sm:grid-cols-4 lg:grid-cols-6" @submit.prevent="add">
        <input
          v-model="form.customer_name"
          required
          :placeholder="t('invoices.customer')"
          class="ui-input sm:col-span-2"
        />
        <input
          v-model="form.amount"
          type="number"
          step="0.01"
          min="0"
          required
          :placeholder="t('invoices.totalAmount')"
          class="ui-input"
        />
        <input v-model="form.invoice_date" type="date" class="ui-input" />
        <select v-model="form.payer_type" class="ui-select sm:col-span-2">
          <option value="customer">{{ t('invoices.payerCustomer') }}</option>
          <option value="patient">{{ t('invoices.payerPatient') }}</option>
          <option value="insurance">{{ t('invoices.payerInsurance') }}</option>
        </select>
        <input
          v-model="form.payer_id"
          type="number"
          min="0"
          step="1"
          :placeholder="t('invoices.payerIdPlaceholder')"
          class="ui-input sm:col-span-2"
        />
        <select v-model="form.status" class="ui-select sm:col-span-2">
          <option value="draft">{{ t('invoices.draft') }}</option>
          <option value="unpaid">{{ t('invoices.unpaid') }}</option>
          <option value="paid">{{ t('invoices.paid') }}</option>
        </select>
        <button type="submit" class="ui-btn-primary sm:col-span-6 lg:col-span-2">{{ t('common.save') }}</button>
      </form>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </div>

    <div class="ui-table-wrap">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('invoices.customer') }}</th>
            <th v-if="hasBalances">{{ t('invoices.totalAmount') }}</th>
            <th v-if="hasBalances">{{ t('invoices.paidAmount') }}</th>
            <th v-if="hasBalances">{{ t('invoices.balance') }}</th>
            <th v-else>{{ t('invoices.amount') }}</th>
            <th>{{ t('invoices.payer') }}</th>
            <th>{{ t('invoices.status') }}</th>
            <th>{{ t('invoices.date') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in invoices" :key="inv.id">
            <td class="font-medium text-slate-900">{{ inv.customer_name }}</td>
            <template v-if="hasBalances">
              <td class="font-semibold tabular-nums text-slate-800">{{ fmtMoney(invoiceTotal(inv)) }}</td>
              <td class="tabular-nums text-slate-700">{{ fmtMoney(invoicePaid(inv)) }}</td>
              <td class="tabular-nums text-slate-800">{{ fmtMoney(invoiceBalance(inv)) }}</td>
            </template>
            <td v-else class="font-semibold tabular-nums text-slate-800">{{ fmtMoney(inv.amount) }}</td>
            <td class="text-sm text-slate-600">
              <span>{{ payerLabel(inv.payer_type || 'customer') }}</span>
              <span v-if="inv.payer_id != null" class="ms-1 text-slate-400">#{{ inv.payer_id }}</span>
            </td>
            <td>
              <span :class="statusBadgeClass(inv.status)" class="inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold">
                {{ statusLabel(inv.status) }}
              </span>
            </td>
            <td class="text-slate-600">{{ inv.invoice_date }}</td>
            <td>
              <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="remove(inv.id)">
                {{ t('accounts.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="loading">
            <td :colspan="hasBalances ? 8 : 6" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
