<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();

const payments = ref([]);
const invoices = ref([]);
const loading = ref(false);
const error = ref('');
const schemaError = ref('');

const form = ref({
  amount: '',
  payment_date: new Date().toISOString().slice(0, 16),
  method: 'cash',
  reference: '',
  notes: '',
});

const selectedPaymentId = ref(null);
const applyRows = ref([]);
const applyError = ref('');
const applySaving = ref(false);

const selectedPayment = computed(() => payments.value.find((p) => p.id === selectedPaymentId.value) || null);

const openInvoices = computed(() =>
  (invoices.value || []).filter((inv) => inv.status !== 'draft' && Number(inv.balance_remaining) > 0)
);

function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}

async function loadPayments() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  schemaError.value = '';
  try {
    const { data } = await api.get('/api/payments');
    payments.value = data.payments || [];
  } catch (e) {
    if (e.response?.status === 503) {
      schemaError.value = e.response?.data?.hint || e.response?.data?.error || t('payments.schemaMissing');
    } else {
      error.value = e.response?.data?.error || t('common.error');
    }
  } finally {
    loading.value = false;
  }
}

async function loadInvoices() {
  if (!company.currentCompanyId) return;
  try {
    const { data } = await api.get('/api/invoices');
    invoices.value = data.invoices || [];
  } catch {
    invoices.value = [];
  }
}

async function createPayment() {
  error.value = '';
  try {
    await api.post('/api/payments', {
      amount: Number(form.value.amount),
      payment_date: new Date(form.value.payment_date).toISOString(),
      method: form.value.method,
      reference: form.value.reference || undefined,
      notes: form.value.notes || undefined,
    });
    form.value = {
      amount: '',
      payment_date: new Date().toISOString().slice(0, 16),
      method: 'cash',
      reference: '',
      notes: '',
    };
    await loadPayments();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

function openApply(payment) {
  selectedPaymentId.value = payment.id;
  applyRows.value = [];
  applyError.value = '';
}

function addApplyRow() {
  applyRows.value.push({ invoice_id: '', amount_applied: '' });
}

function removeApplyRow(i) {
  applyRows.value.splice(i, 1);
}

async function submitApply() {
  if (!selectedPayment.value) return;
  applyError.value = '';
  const allocations = applyRows.value
    .filter((r) => r.invoice_id && r.amount_applied !== '' && Number(r.amount_applied) > 0)
    .map((r) => ({
      invoice_id: r.invoice_id,
      amount_applied: Number(r.amount_applied),
    }));
  if (!allocations.length) {
    applyError.value = t('payments.applyNeedLine');
    return;
  }
  applySaving.value = true;
  try {
    await api.post(`/api/payments/${selectedPayment.value.id}/apply`, { allocations });
    applyRows.value = [];
    selectedPaymentId.value = null;
    await loadPayments();
    await loadInvoices();
  } catch (e) {
    applyError.value = e.response?.data?.error || t('common.error');
  } finally {
    applySaving.value = false;
  }
}

function methodLabel(m) {
  const key = `payments.methods.${m}`;
  const translated = t(key);
  return translated === key ? m : translated;
}

onMounted(() => {
  loadPayments();
  loadInvoices();
});
watch(() => company.currentCompanyId, () => {
  loadPayments();
  loadInvoices();
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('payments.title') }}</h1>
      <p class="ui-page-desc">{{ t('payments.subtitle') }}</p>
    </div>

    <p
      v-if="schemaError"
      class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      {{ schemaError }}
    </p>

    <div class="ui-card ui-card-pad">
      <h2 class="ui-card-title mb-5">{{ t('payments.record') }}</h2>
      <form class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" @submit.prevent="createPayment">
        <input
          v-model="form.amount"
          type="number"
          step="0.01"
          min="0.01"
          required
          :placeholder="t('payments.amount')"
          class="ui-input"
        />
        <input v-model="form.payment_date" type="datetime-local" required class="ui-input" />
        <select v-model="form.method" class="ui-select">
          <option value="cash">{{ t('payments.methods.cash') }}</option>
          <option value="card">{{ t('payments.methods.card') }}</option>
          <option value="bank_transfer">{{ t('payments.methods.bank_transfer') }}</option>
          <option value="insurance">{{ t('payments.methods.insurance') }}</option>
        </select>
        <input v-model="form.reference" :placeholder="t('payments.reference')" class="ui-input sm:col-span-2" />
        <input v-model="form.notes" :placeholder="t('payments.notes')" class="ui-input sm:col-span-3" />
        <button type="submit" class="ui-btn-primary sm:col-span-3">{{ t('common.save') }}</button>
      </form>
      <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ error }}
      </p>
    </div>

    <div class="ui-table-wrap mt-8">
      <table class="ui-table">
        <thead>
          <tr>
            <th>{{ t('payments.date') }}</th>
            <th>{{ t('payments.amount') }}</th>
            <th>{{ t('payments.method') }}</th>
            <th>{{ t('payments.reference') }}</th>
            <th>{{ t('payments.allocated') }}</th>
            <th>{{ t('payments.unallocated') }}</th>
            <th>{{ t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in payments" :key="p.id">
            <td class="text-slate-600">{{ new Date(p.payment_date).toLocaleString() }}</td>
            <td class="font-semibold tabular-nums">{{ fmtMoney(p.amount) }}</td>
            <td>{{ methodLabel(p.method) }}</td>
            <td class="text-slate-600">{{ p.reference || '—' }}</td>
            <td class="tabular-nums">{{ fmtMoney(p.allocated_amount) }}</td>
            <td class="tabular-nums text-slate-700">{{ fmtMoney(p.unallocated_amount) }}</td>
            <td>
              <button
                type="button"
                class="ui-btn-secondary !px-2 !py-1.5 text-sm"
                :disabled="Number(p.unallocated_amount) <= 0"
                @click="openApply(p)"
              >
                {{ t('payments.apply') }}
              </button>
            </td>
          </tr>
          <tr v-if="loading">
            <td colspan="7" class="py-12 text-center text-slate-500">{{ t('common.loading') }}</td>
          </tr>
          <tr v-if="!loading && !payments.length && !schemaError">
            <td colspan="7" class="py-12 text-center text-slate-500">{{ t('payments.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="selectedPayment"
      class="ui-card ui-card-pad mt-8 border-2 border-brand-200/60 bg-white shadow-lg shadow-brand-900/5"
    >
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="ui-card-title">{{ t('payments.allocateTitle') }}</h2>
          <p class="mt-1 text-sm text-slate-600">
            {{ t('payments.allocateHint', { remaining: fmtMoney(selectedPayment.unallocated_amount) }) }}
          </p>
        </div>
        <button type="button" class="ui-btn-secondary text-sm" @click="selectedPaymentId = null">
          {{ t('common.cancel') }}
        </button>
      </div>

      <p class="mb-3 text-sm text-slate-600">{{ t('payments.openInvoices') }}</p>
      <ul class="mb-4 max-h-40 overflow-y-auto rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-100">
        <li v-for="inv in openInvoices" :key="inv.id" class="flex justify-between gap-2 border-b border-slate-100 py-1.5 last:border-0">
          <span class="font-medium text-slate-800">{{ inv.customer_name }}</span>
          <span class="tabular-nums text-slate-600">
            {{ t('payments.balance') }}: {{ fmtMoney(inv.balance_remaining) }}
          </span>
        </li>
        <li v-if="!openInvoices.length" class="py-2 text-slate-500">{{ t('payments.noOpenInvoices') }}</li>
      </ul>

      <div class="space-y-3">
        <div v-for="(row, i) in applyRows" :key="i" class="flex flex-wrap items-end gap-2">
          <select v-model="row.invoice_id" class="ui-select min-w-[12rem] flex-1">
            <option value="">{{ t('payments.pickInvoice') }}</option>
            <option v-for="inv in openInvoices" :key="inv.id" :value="inv.id">
              {{ inv.customer_name }} — {{ fmtMoney(inv.balance_remaining) }} {{ t('payments.due') }}
            </option>
          </select>
          <input
            v-model="row.amount_applied"
            type="number"
            step="0.01"
            min="0.01"
            :placeholder="t('payments.applyAmount')"
            class="ui-input w-36"
          />
          <button type="button" class="ui-btn-danger !px-2 !py-1.5 text-sm" @click="removeApplyRow(i)">
            {{ t('accounts.delete') }}
          </button>
        </div>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button type="button" class="ui-btn-secondary text-sm" @click="addApplyRow">{{ t('payments.addLine') }}</button>
        <button
          type="button"
          class="ui-btn-primary text-sm"
          :disabled="applySaving"
          @click="submitApply"
        >
          {{ t('payments.submitApply') }}
        </button>
      </div>
      <p v-if="applyError" class="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">
        {{ applyError }}
      </p>
    </div>
  </div>
</template>
