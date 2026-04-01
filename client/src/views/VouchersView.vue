<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCompanyStore } from '@/stores/company';
import { api } from '@/api/client';

const { t } = useI18n();
const company = useCompanyStore();
const vouchers = ref([]);
const accounts = ref([]);
const invoices = ref([]);
const bills = ref([]);
const vendors = ref([]);
const previewHtml = ref('');
const error = ref('');
const loading = ref(false);
const saving = ref(false);
const family = ref('receipt');
const workflowRequests = ref([]);

const form = ref({
  family: 'receipt',
  status: 'draft',
  entry_date: new Date().toISOString().slice(0, 10),
  amount: '',
  source_account_id: '',
  destination_account_id: '',
  reference: '',
  description: '',
  currency_code: '',
  exchange_rate: '',
  settlement_base_amount: '',
  branch_id: '',
  due_date: '',
  linked_reference: '',
  counterparty_class: 'customer',
  receipt_allocations: [{ invoice_id: '', amount: '' }],
  receipt_customer_balances: [{ customer_name: '', balance_type: 'on_account', amount: '' }],
  bill_allocations: [{ bill_id: '', amount: '' }],
  vendor_prepayments: [{ vendor_id: '', amount: '' }],
  bill_credit_allocations: [{ bill_credit_id: '', amount: '' }],
});

const filteredVouchers = computed(() => vouchers.value.filter((v) => v.family === family.value));

function addLine(key, sample) {
  form.value[key].push({ ...sample });
}

async function load() {
  if (!company.currentCompanyId) return;
  loading.value = true;
  error.value = '';
  try {
    const [v, acc, inv, bl, ven, wr] = await Promise.all([
      api.get('/api/vouchers'),
      api.get('/api/accounts'),
      api.get('/api/invoices').catch(() => ({ data: { invoices: [] } })),
      api.get('/api/bills').catch(() => ({ data: { bills: [] } })),
      api.get('/api/vendors').catch(() => ({ data: { vendors: [] } })),
      api.get('/api/audit/workflow/requests').catch(() => ({ data: { requests: [] } })),
    ]);
    vouchers.value = v.data.vouchers || [];
    accounts.value = acc.data.accounts || [];
    invoices.value = inv.data.invoices || [];
    bills.value = bl.data.bills || [];
    vendors.value = ven.data.vendors || [];
    workflowRequests.value = wr.data.requests || [];
  } catch (e) {
    error.value = e.response?.data?.error || t('vouchersView.loadFailed');
  } finally {
    loading.value = false;
  }
}

function getVoucherRequest(voucherId) {
  return workflowRequests.value.find((r) => String(r.entity_id) === String(voucherId)) || null;
}

function isVoucherLocked(voucher) {
  return getVoucherRequest(voucher.id)?.status === 'approved';
}

async function requestApproval(voucher) {
  try {
    await api.post('/api/audit/workflow/requests', {
      doc_type: 'voucher',
      entity_id: voucher.id,
      amount: Number(voucher.amount || 0),
      note: `Request approval for voucher ${voucher.reference || voucher.id}`,
    });
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('common.error');
  }
}

async function submitVoucher() {
  error.value = '';
  saving.value = true;
  try {
    const payload = {
      ...form.value,
      family: family.value,
      amount: Number(form.value.amount || 0),
      exchange_rate: form.value.exchange_rate ? Number(form.value.exchange_rate) : null,
      settlement_base_amount: form.value.settlement_base_amount ? Number(form.value.settlement_base_amount) : null,
      description: [
        form.value.description,
        form.value.due_date ? `due:${form.value.due_date}` : '',
        form.value.linked_reference ? `link:${form.value.linked_reference}` : '',
        form.value.counterparty_class ? `counterparty:${form.value.counterparty_class}` : '',
      ].filter(Boolean).join(' | '),
      receipt_allocations: form.value.receipt_allocations
        .filter((x) => x.invoice_id && Number(x.amount) > 0)
        .map((x) => ({ ...x, amount: Number(x.amount) })),
      receipt_customer_balances: form.value.receipt_customer_balances
        .filter((x) => x.customer_name && Number(x.amount) > 0)
        .map((x) => ({ ...x, amount: Number(x.amount) })),
      bill_allocations: form.value.bill_allocations
        .filter((x) => x.bill_id && Number(x.amount) > 0)
        .map((x) => ({ ...x, amount: Number(x.amount) })),
      vendor_prepayments: form.value.vendor_prepayments
        .filter((x) => x.vendor_id && Number(x.amount) > 0)
        .map((x) => ({ ...x, amount: Number(x.amount) })),
      bill_credit_allocations: [],
    };
    await api.post('/api/vouchers', payload);
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('vouchersView.createFailed');
  } finally {
    saving.value = false;
  }
}

async function postVoucher(id) {
  try {
    await api.post(`/api/vouchers/${id}/post`);
    await load();
  } catch (e) {
    error.value = e.response?.data?.error || t('vouchersView.postFailed');
  }
}

async function printVoucher(id) {
  try {
    const { data } = await api.get(`/api/vouchers/${id}/print-layout`, { params: { lang: 'ar' } });
    previewHtml.value = data.html || '';
  } catch (e) {
    error.value = e.response?.data?.error || t('vouchersView.printFailed');
  }
}

onMounted(load);
watch(() => company.currentCompanyId, load);
watch(family, (v) => {
  form.value.family = v;
});
</script>

<template>
  <div class="ui-page">
    <div class="ui-page-head">
      <h1 class="ui-page-title">{{ t('vouchersView.title') }}</h1>
      <p class="ui-page-desc">{{ t('vouchersView.subtitle') }}</p>
    </div>

    <section class="ui-card ui-card-pad">
      <div class="mb-4 flex flex-wrap gap-2">
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': family === 'receipt' }" @click="family = 'receipt'">{{ t('vouchersView.families.receipt') }}</button>
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': family === 'payment' }" @click="family = 'payment'">{{ t('vouchersView.families.payment') }}</button>
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': family === 'transfer' }" @click="family = 'transfer'">{{ t('vouchersView.families.transfer') }}</button>
        <button type="button" class="ui-btn-secondary" :class="{ '!bg-brand-600 !text-white': family === 'adjustment' }" @click="family = 'adjustment'">{{ t('vouchersView.families.adjustment') }}</button>
      </div>
      <div class="grid gap-3 md:grid-cols-4">
        <input v-model="form.entry_date" type="date" class="ui-input" />
        <input v-model="form.amount" type="number" min="0" step="0.01" class="ui-input" :placeholder="t('vouchersView.amount')" />
        <input v-model="form.reference" type="text" class="ui-input" :placeholder="t('vouchersView.reference')" />
        <select v-model="form.status" class="ui-select">
          <option value="draft">{{ t('vouchersView.draft') }}</option>
          <option value="posted">{{ t('vouchersView.posted') }}</option>
        </select>
        <select v-model="form.source_account_id" class="ui-select">
          <option value="">{{ t('vouchersView.sourceAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
        <select v-model="form.destination_account_id" class="ui-select">
          <option value="">{{ t('vouchersView.destinationAccount') }}</option>
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.account_code }} - {{ a.name }}</option>
        </select>
        <input v-model="form.currency_code" type="text" class="ui-input" :placeholder="t('vouchersView.currencyCode')" />
        <input v-model="form.exchange_rate" type="number" min="0" step="0.0001" class="ui-input" :placeholder="t('vouchersView.exchangeRate')" />
        <input v-model="form.due_date" type="date" class="ui-input" />
        <input v-model="form.linked_reference" type="text" class="ui-input" :placeholder="t('vouchersView.linkedReference')" />
        <select v-model="form.counterparty_class" class="ui-select">
          <option value="customer">{{ t('vouchersView.counterpartyCustomer') }}</option>
          <option value="vendor">{{ t('vouchersView.counterpartyVendor') }}</option>
          <option value="other">{{ t('vouchersView.counterpartyOther') }}</option>
        </select>
        <input v-model="form.description" type="text" class="ui-input md:col-span-4" :placeholder="t('vouchersView.description')" />
      </div>

      <div v-if="family === 'receipt'" class="mt-4 rounded-xl border border-slate-100 p-3">
        <p class="mb-2 text-sm font-semibold">{{ t('vouchersView.receiptAllocations') }}</p>
        <div v-for="(ln, i) in form.receipt_allocations" :key="`ra-${i}`" class="mb-2 grid gap-2 md:grid-cols-3">
          <select v-model="ln.invoice_id" class="ui-select">
            <option value="">{{ t('vouchersView.invoice') }}</option>
            <option v-for="inv in invoices" :key="inv.id" :value="inv.id">{{ inv.customer_name }} - {{ inv.total_amount }}</option>
          </select>
          <input v-model="ln.amount" type="number" step="0.01" class="ui-input" :placeholder="t('vouchersView.amount')" />
        </div>
        <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="addLine('receipt_allocations', { invoice_id: '', amount: '' })">{{ t('vouchersView.addLine') }}</button>
      </div>

      <div v-if="family === 'payment'" class="mt-4 rounded-xl border border-slate-100 p-3">
        <p class="mb-2 text-sm font-semibold">{{ t('vouchersView.billAllocations') }}</p>
        <div v-for="(ln, i) in form.bill_allocations" :key="`ba-${i}`" class="mb-2 grid gap-2 md:grid-cols-3">
          <select v-model="ln.bill_id" class="ui-select">
            <option value="">{{ t('vouchersView.bill') }}</option>
            <option v-for="b in bills" :key="b.id" :value="b.id">{{ b.bill_number || b.id }} - {{ b.total_amount }}</option>
          </select>
          <input v-model="ln.amount" type="number" step="0.01" class="ui-input" :placeholder="t('vouchersView.amount')" />
        </div>
        <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="addLine('bill_allocations', { bill_id: '', amount: '' })">{{ t('vouchersView.addLine') }}</button>

        <p class="my-2 text-sm font-semibold">{{ t('vouchersView.vendorPrepayments') }}</p>
        <div v-for="(ln, i) in form.vendor_prepayments" :key="`vp-${i}`" class="mb-2 grid gap-2 md:grid-cols-3">
          <select v-model="ln.vendor_id" class="ui-select">
            <option value="">{{ t('vouchersView.vendor') }}</option>
            <option v-for="v in vendors" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
          <input v-model="ln.amount" type="number" step="0.01" class="ui-input" :placeholder="t('vouchersView.amount')" />
        </div>
        <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="addLine('vendor_prepayments', { vendor_id: '', amount: '' })">{{ t('vouchersView.addLine') }}</button>
      </div>

      <div class="mt-4">
        <button type="button" class="ui-btn-primary" :disabled="saving" @click="submitVoucher">{{ t('vouchersView.create') }}</button>
      </div>
    </section>

    <div class="grid gap-6 lg:grid-cols-2">
      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-4">{{ t('vouchersView.listTitle') }}</h2>
        <ul class="max-h-[30rem] space-y-2 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3">
          <li v-for="v in filteredVouchers" :key="v.id" class="rounded-lg border border-slate-100 p-3 text-sm">
            <p class="font-semibold">{{ v.entry_date }} · {{ v.reference || '-' }} · {{ v.family }}</p>
            <p class="text-slate-600">{{ Number(v.amount).toFixed(2) }} · {{ v.status }}</p>
            <p v-if="isVoucherLocked(v)" class="mt-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700 ring-1 ring-amber-100">
              {{ t('approvals.lockedApprovedBanner') }}
            </p>
            <p v-if="getVoucherRequest(v.id)" class="mt-1 text-xs">
              <span class="ui-badge-slate">{{ t('approvals.lockState') }}: {{ getVoucherRequest(v.id)?.status }}</span>
            </p>
            <p v-if="getVoucherRequest(v.id)" class="text-xs text-slate-500">
              {{ t('approvals.requestedAt') }}: {{ String(getVoucherRequest(v.id)?.requested_at || '-').slice(0, 19).replace('T', ' ') }}
            </p>
            <p v-if="getVoucherRequest(v.id)" class="text-xs text-slate-500">
              {{ t('approvals.decidedAt') }}: {{ String(getVoucherRequest(v.id)?.decided_at || '-').slice(0, 19).replace('T', ' ') }}
            </p>
            <div class="mt-2 flex gap-2">
              <button v-if="v.status === 'draft'" type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" :disabled="isVoucherLocked(v)" @click="postVoucher(v.id)">{{ t('vouchersView.postNow') }}</button>
              <button type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" @click="printVoucher(v.id)">{{ t('vouchersView.printPreview') }}</button>
              <button v-if="!getVoucherRequest(v.id)" type="button" class="ui-btn-secondary !px-2 !py-1 text-xs" :disabled="isVoucherLocked(v)" @click="requestApproval(v)">
                {{ t('approvals.requestApproval') }}
              </button>
            </div>
          </li>
          <li v-if="loading" class="text-sm text-slate-500">{{ t('common.loading') }}</li>
        </ul>
      </section>
      <section class="ui-card ui-card-pad">
        <h2 class="ui-card-title mb-4">{{ t('vouchersView.previewTitle') }}</h2>
        <iframe v-if="previewHtml" class="h-[30rem] w-full rounded-xl border border-slate-100 bg-white" :srcdoc="previewHtml"></iframe>
      </section>
    </div>
    <p v-if="error" class="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100">{{ error }}</p>
  </div>
</template>

